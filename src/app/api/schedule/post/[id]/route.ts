import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';
import { updatePost, deletePost, listPosts, ZernioError, friendlyZernioMessage } from '@/lib/zernio';
import { getOrCreateZernioProfile } from '@/lib/zernioProfile';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// Cancelling a scheduled post → its baked render(s) are now dead weight; delete them from storage + the
// ledger. Best-effort: never let a storage hiccup fail the cancel. Service role (the files are the user's
// own, but we scope by user_id + post_id for safety).
async function purgeRenders(userId: string, postId: string) {
  try {
    const db = supabaseAdmin();
    const { data: rows } = await db
      .from('scheduled_render_media')
      .select('id,bucket,path')
      .eq('user_id', userId)
      .eq('post_id', postId);
    if (!rows || rows.length === 0) return;
    const byBucket = new Map<string, string[]>();
    for (const r of rows as { id: string; bucket: string; path: string }[]) {
      const arr = byBucket.get(r.bucket) ?? [];
      arr.push(r.path);
      byBucket.set(r.bucket, arr);
    }
    for (const [bucket, paths] of byBucket) await db.storage.from(bucket).remove(paths);
    await db.from('scheduled_render_media').delete().in('id', (rows as { id: string }[]).map(r => r.id));
  } catch (e) {
    console.warn('[schedule/post DELETE] purgeRenders failed:', e instanceof Error ? e.message : e);
  }
}

// Rescheduling moves the publish time, so the media-cleanup ledger must move with it — its rows still
// expire at the OLD scheduledFor + 6h, and the hourly cron would delete the baked render(s) BEFORE
// Instagram fetches them. Expiry mirrors serverPublish: new publish time + 6h buffer. Best-effort:
// never let a ledger hiccup fail the reschedule (worst case the cron deletes early, as before this fix).
async function extendRenderExpiry(userId: string, postId: string, scheduledForMs: number) {
  try {
    const db = supabaseAdmin();
    const { error } = await db
      .from('scheduled_render_media')
      .update({ expires_at: new Date(scheduledForMs + 6 * 3600_000).toISOString() })
      .eq('user_id', userId)
      .eq('post_id', postId);
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[schedule/post PUT] extendRenderExpiry failed:', e instanceof Error ? e.message : e);
  }
}

// Post id from the path (avoids Next's version-specific params typing).
function postId(req: Request): string {
  return decodeURIComponent(new URL(req.url).pathname.split('/').pop() ?? '');
}

// Ownership guard. Every user's posts live under one account-wide Zernio key, separated only by
// profileId, and Zernio's PUT/DELETE /posts/{id} take NO profileId — so without this check any
// subscriber could edit or cancel any other user's post just by its id. listPosts IS scoped to the
// profile server-side, so a post appearing in this user's profile list is authoritatively theirs.
// Editable posts (scheduled/recent) sit on the first pages; the page cap bounds a hostile id probe.
async function userOwnsPost(profileId: string, id: string): Promise<boolean> {
  const LIMIT = 100;
  const MAX_PAGES = 10;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { posts, pagination } = await listPosts({ profileId, page, limit: LIMIT });
    if (posts.some(p => p._id === id)) return true;
    if (page >= (pagination?.pages ?? page)) break;
  }
  return false;
}

interface Body { content?: string; scheduledFor?: string; timezone?: string }

// PUT /api/schedule/post/{id} — edit a scheduled post (caption / time).
export async function PUT(req: Request) {
  if (!AUTOMATIONS_ENABLED) return NextResponse.json({ error: 'Scheduling is disabled' }, { status: 404 });
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('schedule:post-update:' + user.id, 20))) return tooManyRequests();

  const id = postId(req);
  if (!id) return NextResponse.json({ error: 'Missing post id' }, { status: 400 });

  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const fields: Body = {};
  if (typeof body.content === 'string') fields.content = body.content;
  if (typeof body.scheduledFor === 'string') fields.scheduledFor = body.scheduledFor;
  if (typeof body.timezone === 'string') fields.timezone = body.timezone;

  try {
    const profileId = await getOrCreateZernioProfile(user);
    // 404 (not 403) so we don't confirm the existence of another user's post.
    if (!(await userOwnsPost(profileId, id))) return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    const post = await updatePost(id, fields);
    // New publish time → keep the render files alive until then (ledger rows are keyed by post_id = id).
    const when = fields.scheduledFor ? Date.parse(fields.scheduledFor) : NaN;
    if (Number.isFinite(when) && when > Date.now()) await extendRenderExpiry(user.id, id, when);
    return NextResponse.json({ post });
  } catch (err) {
    if (err instanceof ZernioError) return NextResponse.json({ error: friendlyZernioMessage(err.status) }, { status: err.status });
    console.error('[schedule/post PUT]', err);
    return NextResponse.json({ error: 'Failed to update post' }, { status: 500 });
  }
}

// DELETE /api/schedule/post/{id} — cancel a scheduled post.
export async function DELETE(req: Request) {
  if (!AUTOMATIONS_ENABLED) return NextResponse.json({ error: 'Scheduling is disabled' }, { status: 404 });
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('schedule:post-delete:' + user.id, 20))) return tooManyRequests();

  const id = postId(req);
  if (!id) return NextResponse.json({ error: 'Missing post id' }, { status: 400 });

  try {
    const profileId = await getOrCreateZernioProfile(user);
    // 404 (not 403) so we don't confirm the existence of another user's post.
    if (!(await userOwnsPost(profileId, id))) return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    await deletePost(id);
    await purgeRenders(user.id, id);   // drop the now-orphaned baked render(s) from storage
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ZernioError) return NextResponse.json({ error: friendlyZernioMessage(err.status) }, { status: err.status });
    console.error('[schedule/post DELETE]', err);
    return NextResponse.json({ error: 'Failed to cancel post' }, { status: 500 });
  }
}
