import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';
import { createInstagramPost, countScheduledPosts, listAccounts, accountProfileId, MAX_SCHEDULED_PER_ACCOUNT, ZernioError, type IgContentType, type MediaItem, friendlyZernioMessage } from '@/lib/zernio';
import { getOrCreateZernioProfile } from '@/lib/zernioProfile';
import { ledgerRenders } from '@/lib/scheduleLedger';
import { recordRewardsPost } from '@/lib/rewardsPosts';

// Instagram has no text-only posts, so at least one media item is always required.
const MAX_CAROUSEL = 10; // Zernio/Instagram carousel cap.

interface PostBody {
  accountId?: string;
  content?: string;
  mediaItems?: MediaItem[];
  contentType?: IgContentType;
  publishNow?: boolean;
  scheduledFor?: string;
  timezone?: string;
  hashtags?: string[];
  collaborators?: string[];
  shareToFeed?: boolean;
  firstComment?: string;
  // FeedForce rewards sticker flag (reels only): present when the editor's reels workspace sent a
  // decision for an enrolled rewards-program member; records the published post for view attribution.
  stickerEnabled?: boolean;
}

function isHttpsUrl(u: unknown): u is string {
  return typeof u === 'string' && /^https:\/\//i.test(u);
}

// POST /api/schedule/post — schedule or immediately publish an Instagram post via Zernio.
export async function POST(req: Request) {
  if (!AUTOMATIONS_ENABLED) return NextResponse.json({ error: 'Scheduling is disabled' }, { status: 404 });

  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  // Tighter than reads — each call can publish to a live account.
  if (!(await rateLimit('schedule:post:' + user.id, 10))) return tooManyRequests();

  let body: PostBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { accountId, mediaItems, publishNow, scheduledFor, contentType } = body;

  if (!accountId) {
    return NextResponse.json({ error: 'accountId is required' }, { status: 400 });
  }
  if (!Array.isArray(mediaItems) || mediaItems.length === 0) {
    return NextResponse.json({ error: 'Instagram posts need at least one image or video' }, { status: 400 });
  }
  if (mediaItems.length > MAX_CAROUSEL) {
    return NextResponse.json({ error: `Instagram allows at most ${MAX_CAROUSEL} carousel items` }, { status: 400 });
  }
  for (const m of mediaItems) {
    if (!isHttpsUrl(m?.url)) {
      return NextResponse.json({ error: 'Each media item needs a public https:// URL' }, { status: 400 });
    }
  }
  // Stories and Reels are single-media formats on Instagram.
  if ((contentType === 'story' || contentType === 'reels') && mediaItems.length > 1) {
    return NextResponse.json({ error: `Instagram ${contentType} accepts a single media item` }, { status: 400 });
  }
  if (!publishNow) {
    const when = Date.parse(scheduledFor ?? '');
    if (Number.isNaN(when)) {
      return NextResponse.json({ error: 'A valid scheduledFor time is required unless publishNow is true' }, { status: 400 });
    }
    if (when <= Date.now()) {
      return NextResponse.json({ error: 'scheduledFor must be in the future' }, { status: 400 });
    }
  }

  try {
    const profileId = await getOrCreateZernioProfile(user);
    // Ownership guard (mirrors userOwnsPost in ./[id]): every user's accounts live under ONE
    // account-wide Zernio key, separated only by profileId, and createPost takes the accountId at
    // face value (Zernio's 403 ownership check is keyed to the API key owner, which is us for every
    // app user). listAccounts IS scoped to the profile server-side, so an account in this user's
    // list is authoritatively theirs. Applies to publish-now too (ownership is orthogonal to the
    // backlog cap). 404 (not 403) so we don't confirm the existence of another user's account.
    // profileId arrives POPULATED as an object from the live API; accountProfileId() normalizes it
    // (a direct === string comparison 404'd every publish; incident 2026-07-19).
    const accounts = await listAccounts(profileId);
    if (!accounts.some(a => a._id === accountId && accountProfileId(a) === profileId)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    // Backlog cap: scheduling adds to the account's queue, so it counts against the per-account
    // limit; publish-now never sits in the queue and bypasses the check entirely.
    if (!publishNow) {
      const existing = await countScheduledPosts(profileId, accountId);
      if (existing >= MAX_SCHEDULED_PER_ACCOUNT) {
        return NextResponse.json({
          error: `This account already has ${MAX_SCHEDULED_PER_ACCOUNT} scheduled posts (the maximum). Wait for some to publish, or cancel a few, then try again.`,
          remaining: 0,
        }, { status: 409 });
      }
    }
    const post = await createInstagramPost({
      content: body.content ?? '',
      profileId,
      accountId,
      mediaItems,
      contentType,
      publishNow,
      scheduledFor,
      timezone: body.timezone,
      hashtags: body.hashtags,
      collaborators: body.collaborators,
      shareToFeed: body.shareToFeed,
      firstComment: body.firstComment,
    });
    // Zernio accepted the post → ledger its baked renders for cleanup (see lib/scheduleLedger).
    if (post?._id) {
      const expires = publishNow ? Date.now() + 30 * 60_000 : Date.parse(scheduledFor!) + 6 * 3600_000;
      await ledgerRenders(user.id, post._id, mediaItems, expires);
      // Rewards program: record the placed reel for view attribution (best-effort, never fails the
      // request). Reels only — the sticker is a reel-render feature.
      if (typeof body.stickerEnabled === 'boolean' && contentType === 'reels') {
        await recordRewardsPost(user.id, post._id, accountId, body.stickerEnabled);
      }
    }
    return NextResponse.json({ post });
  } catch (err) {
    if (err instanceof ZernioError) return NextResponse.json({ error: friendlyZernioMessage(err.status) }, { status: err.status });
    console.error('[schedule/post]', err);
    return NextResponse.json({ error: 'Failed to schedule post' }, { status: 500 });
  }
}
