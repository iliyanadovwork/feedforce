import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';
import { createInstagramPost, countScheduledPosts, listAccounts, accountProfileId, MAX_SCHEDULED_PER_ACCOUNT, ZernioError, type MediaItem, friendlyZernioMessage } from '@/lib/zernio';
import { getOrCreateZernioProfile } from '@/lib/zernioProfile';
import { ledgerRenders } from '@/lib/scheduleLedger';
import { recordRewardsPost } from '@/lib/rewardsPosts';

// POST /api/schedule/posts/bulk — Schedule All: place a chunk of up to 10 reels on one Instagram
// account in a single request. The client renders each reel to MP4, uploads it to OUR post-videos
// bucket, then submits chunks here; we pace the Zernio createPost calls so a full chunk stays far
// under the free-tier rate limit, and enforce the per-account scheduled-backlog cap up front.

// Worst case per chunk: 1 count call + 10 creates spaced ~1.1s apart plus network latency, well
// inside 60s. Same route-segment maxDuration idiom as /api/schedule/caption.
export const maxDuration = 60;

const MAX_ITEMS = 10;      // per bulk call; the client submits a 50-reel run as up to 5 chunks
const MAX_CAPTION = 2200;  // Instagram caption limit
// Gap BETWEEN createInstagramPost calls (none after the last). Zernio's free tier (0-2 connected
// accounts) allows 60 req/min on a sliding window (docs.zernio.com/guides/rate-limits); zernioFetch
// already spaces request starts by 320ms, and this on top keeps a whole chunk under ~1 req/sec so
// concurrent calendar reads can't tip a batch over the limit. POSTs are never retried (see zernioFetch).
const PACING_GAP_MS = 1100;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Shape check for the optional per-item idempotency key (Zernio's x-request-id is `format: uuid`).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BulkItem {
  mediaUrl?: string;
  caption?: string;
  scheduledFor?: string;
  // Optional idempotency key the client mints ONCE per reel at render time. A resend of the same
  // item within Zernio's ~5 minute x-request-id window then maps onto the ORIGINAL post (200 with
  // the existing post, which createInstagramPost unwraps) instead of double-posting.
  requestId?: string;
  // FeedForce rewards sticker flag: present when the editor sent a decision for an enrolled
  // rewards-program member; records the placed post for view attribution.
  stickerEnabled?: boolean;
}

interface BulkBody {
  accountId?: string;
  timezone?: string;
  items?: BulkItem[];
}

export async function POST(req: Request) {
  if (!AUTOMATIONS_ENABLED) return NextResponse.json({ error: 'Scheduling is disabled' }, { status: 404 });

  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  // Tighter than reads: each call can place up to 10 posts on a live account.
  if (!(await rateLimit('schedule:bulk:' + user.id, 10))) return tooManyRequests();

  let body: BulkBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { accountId, timezone, items } = body;

  if (!accountId) {
    return NextResponse.json({ error: 'accountId is required' }, { status: 400 });
  }
  if (typeof timezone !== 'string' || !timezone) {
    return NextResponse.json({ error: 'timezone is required' }, { status: 400 });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'items must contain at least one post' }, { status: 400 });
  }
  if (items.length > MAX_ITEMS) {
    return NextResponse.json({ error: `At most ${MAX_ITEMS} posts per request` }, { status: 400 });
  }

  // Stricter than the single route on purpose: Schedule All only ever posts reels the client just
  // rendered into OUR post-videos bucket, so any other URL is a client bug (or someone probing).
  const videoPrefix = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''}/storage/v1/object/public/post-videos/`;
  const now = Date.now();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') {
      return NextResponse.json({ error: `Item ${i + 1} is not a valid post` }, { status: 400 });
    }
    if (typeof item.mediaUrl !== 'string' || !item.mediaUrl.startsWith(videoPrefix)) {
      return NextResponse.json({ error: `Item ${i + 1}: mediaUrl must be a rendered video from your library` }, { status: 400 });
    }
    if (typeof item.caption !== 'string' || item.caption.length > MAX_CAPTION) {
      return NextResponse.json({ error: `Item ${i + 1}: caption must be at most ${MAX_CAPTION} characters` }, { status: 400 });
    }
    const when = Date.parse(item.scheduledFor ?? '');
    if (Number.isNaN(when) || when <= now) {
      return NextResponse.json({ error: `Item ${i + 1}: scheduledFor must be a valid future time` }, { status: 400 });
    }
    if (item.requestId !== undefined && (typeof item.requestId !== 'string' || !UUID_RE.test(item.requestId))) {
      return NextResponse.json({ error: `Item ${i + 1}: requestId must be a UUID` }, { status: 400 });
    }
    if (item.stickerEnabled !== undefined && typeof item.stickerEnabled !== 'boolean') {
      return NextResponse.json({ error: `Item ${i + 1}: stickerEnabled must be a boolean` }, { status: 400 });
    }
  }

  try {
    const profileId = await getOrCreateZernioProfile(user);

    // Ownership guard (mirrors userOwnsPost in /api/schedule/post/[id]): every user's accounts live
    // under ONE account-wide Zernio key, separated only by profileId, and createPost takes the
    // accountId at face value (Zernio's 403 ownership check is keyed to the API key owner, which is
    // us for every app user). listAccounts IS scoped to the profile server-side, so an account in
    // this user's list is authoritatively theirs. 404 (not 403) so we don't confirm the existence
    // of another user's account.
    // profileId arrives POPULATED as an object from the live API; accountProfileId() normalizes it
    // (a direct === string comparison 404'd every publish; incident 2026-07-19).
    const accounts = await listAccounts(profileId);
    if (!accounts.some(a => a._id === accountId && accountProfileId(a) === profileId)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Backlog cap, checked ONCE per request: either the whole chunk fits under the per-account
    // scheduled limit or nothing is placed (a partial chunk would leave the client's run in a state
    // it can't reason about). `remaining` lets the UI say exactly how many slots are left.
    const existing = await countScheduledPosts(profileId, accountId);
    if (existing + items.length > MAX_SCHEDULED_PER_ACCOUNT) {
      const remaining = Math.max(0, MAX_SCHEDULED_PER_ACCOUNT - existing);
      return NextResponse.json({
        error: `This account has ${existing} scheduled posts and can take ${remaining} more (limit ${MAX_SCHEDULED_PER_ACCOUNT}). Reduce the batch or wait for posts to publish.`,
        remaining,
      }, { status: 409 });
    }

    // Sequential, paced, per-item isolated: one bad item (caption rejected upstream, media fetch
    // failed, ...) must not sink the rest of the chunk, and a POST is NEVER retried, a duplicate
    // would double-post to a live Instagram account.
    const results: Array<{ ok: boolean; postId?: string; error?: string }> = [];
    let scheduled = 0;
    for (let i = 0; i < items.length; i++) {
      if (i > 0) await sleep(PACING_GAP_MS);
      const item = items[i];
      const mediaItems: MediaItem[] = [{ type: 'video', url: item.mediaUrl! }];
      try {
        // requestId (when the client sent one) rides as Zernio's x-request-id: a resend of this
        // item inside the ~5 minute idempotency window returns the ORIGINAL post (200 with
        // existingPost, unwrapped by createInstagramPost) instead of double-posting.
        const post = await createInstagramPost({
          content: item.caption ?? '',
          profileId,
          accountId,
          mediaItems,
          contentType: 'reels',
          publishNow: false,
          scheduledFor: item.scheduledFor,
          timezone,
          ...(item.requestId ? { requestId: item.requestId } : {}),
        });
        scheduled++;
        // Zernio accepted the post → ledger its baked render for cleanup (publish time + 6h buffer,
        // mirroring the single route).
        if (post?._id) {
          await ledgerRenders(user.id, post._id, mediaItems, Date.parse(item.scheduledFor!) + 6 * 3600_000);
          // Rewards program: record the placed reel for view attribution (best-effort, never fails
          // the item). Bulk is always reels — contentType is hard-coded 'reels' above.
          if (typeof item.stickerEnabled === 'boolean') {
            await recordRewardsPost(user.id, post._id, accountId, item.stickerEnabled);
          }
          results.push({ ok: true, postId: post._id });
        } else {
          results.push({ ok: true });
        }
      } catch (err) {
        if (err instanceof ZernioError) {
          results.push({ ok: false, error: friendlyZernioMessage(err.status) });
        } else {
          console.error('[schedule/posts/bulk] item failed:', err);
          results.push({ ok: false, error: 'Failed to schedule post' });
        }
      }
    }

    return NextResponse.json({ results, remaining: Math.max(0, MAX_SCHEDULED_PER_ACCOUNT - existing - scheduled) });
  } catch (err) {
    if (err instanceof ZernioError) return NextResponse.json({ error: friendlyZernioMessage(err.status) }, { status: err.status });
    console.error('[schedule/posts/bulk]', err);
    return NextResponse.json({ error: 'Failed to schedule posts' }, { status: 500 });
  }
}
