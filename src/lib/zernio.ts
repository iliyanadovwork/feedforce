// Server-only Zernio client (https://docs.zernio.com). Wraps the social-scheduling REST API so our
// /api/schedule/* routes can list a user's connected accounts and schedule/publish posts.
//
// SECURITY: ZERNIO_API_KEY is a single account-wide secret. It must never reach the browser — every
// call goes through our auth-gated server routes (lib/serverAuth.ts). Do NOT prefix it NEXT_PUBLIC.

const BASE_URL = 'https://zernio.com/api/v1';

// Max social accounts a single app user may connect. Enforced server-side on connect and mirrored in
// the Post UI (SchedulePanel's MAX_ACCOUNTS) so the "+" disables at the cap.
export const MAX_SOCIAL_ACCOUNTS = 2;

/** Thrown on a non-2xx Zernio response; `status` lets routes pass the upstream code through. */
export class ZernioError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ZernioError';
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.ZERNIO_API_KEY ?? '';
  if (!key) throw new ZernioError('ZERNIO_API_KEY not set', 500);
  return key;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────────────────────────
// Zernio rate-limits per account (~60/min — roughly 1 req/sec). Pages like Analytics fan out many calls
// at once, so every request goes through a tiny queue that spaces request STARTS by MIN_GAP_MS, and on a
// 429 we wait the server-advised delay (Retry-After) and retry — IDEMPOTENT verbs only (see zernioFetch).
// This keeps bursts under the limit.
const MIN_GAP_MS = 320;
const MAX_RETRIES = 5;
let nextSlot = 0;
function reserveSlot(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + MIN_GAP_MS;
  const wait = start - now;
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}

async function zernioFetch<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  await reserveSlot(); // queue: don't burst past Zernio's per-account rate limit
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      // External API — never cache account lists or post writes.
      cache: 'no-store',
    });
  } catch (err) {
    throw new ZernioError(`Zernio request failed: ${(err as Error).message}`, 502);
  }

  // Rate-limited → wait the advised delay (default 1s) and retry — but ONLY for idempotent verbs
  // (GET/HEAD reads; PUT/DELETE act on an id, so a replay is a no-op). NEVER retry POST: a 429 can
  // arrive AFTER Zernio enqueued the write, and re-sending POST /posts would double-post to a live
  // Instagram account. A 429 on POST falls through to the error path for the caller to surface.
  const method = (init.method ?? 'GET').toUpperCase();
  const idempotent = method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE';
  if (res.status === 429 && idempotent && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get('retry-after')) || 1;
    await new Promise((r) => setTimeout(r, retryAfter * 1000 + 150));
    return zernioFetch<T>(path, init, attempt + 1);
  }

  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const msg = (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string')
      ? body.error
      : `Zernio ${res.status}`;
    throw new ZernioError(msg, res.status);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// A calm, user-facing message for a failed Zernio call — never leak raw API errors (e.g. "Rate limit
// exceeded", "Zernio 429") to the UI. The real error is still logged server-side for debugging.
export function friendlyZernioMessage(status: number): string {
  if (status === 429) return 'We’re fetching a lot right now — give it a moment and try again.';
  if (status === 401) return 'Your session expired — please sign in again.';
  if (status === 402 || status === 403) return 'This isn’t available for your account.';
  if (status === 404) return 'Not found.';
  if (status >= 500) return 'The service is temporarily unavailable — please try again shortly.';
  return 'Something went wrong — please try again.';
}

// ── Types (subset of the Zernio schema we use) ───────────────────────────────────────────────────
export type Platform = 'instagram' | 'tiktok' | 'youtube' | 'twitter' | 'linkedin' | 'facebook' | string;

export interface ZernioAccount {
  _id: string;          // accountId used in the post's platforms[].accountId
  platform: Platform;
  // The Zernio "profile" (workspace) this account belongs to. The live API returns this POPULATED as an
  // object ({ _id, name, slug }), not a plain id string (confirmed against prod 2026-07-19). Compare via
  // accountProfileId(), never === on this field directly: a raw string comparison is always false against
  // the object shape, which made the create-path ownership guards 404 EVERY publish ("Account not found")
  // from the guard's 2026-07-18 deploy until this fix.
  profileId: string | { _id: string; name?: string; slug?: string };
  username: string;
  displayName: string;
  profilePicture?: string | null;   // platform avatar URL (null if the platform doesn't provide one)
  isActive: boolean;
}

/** The profile id an account belongs to, tolerant of both API shapes (plain id string or populated object).
 *  Malformed shapes (null profileId when the referenced profile was deleted, object without _id) collapse to
 *  '' which never equals a real caller profile id, so the ownership guards FAIL CLOSED on them. */
export function accountProfileId(a: ZernioAccount): string {
  const p = a.profileId as ZernioAccount['profileId'] | null | undefined;
  if (typeof p === 'string') return p;
  return (p && typeof p === 'object' ? p._id : undefined) ?? '';
}

/** Instagram post type → Zernio platformSpecificData.contentType (feed has no contentType). */
export type IgContentType = 'feed' | 'reels' | 'story';

export interface MediaItem {
  type: 'image' | 'video' | 'gif' | 'document';
  url: string;          // publicly accessible HTTPS URL (our post-images / post-videos buckets)
  filename?: string;
  mimeType?: string;
}

export interface CreatePostInput {
  content: string;
  profileId: string;
  accountId: string;
  mediaItems: MediaItem[];
  contentType?: IgContentType;     // Instagram; omit/feed for a normal feed post
  scheduledFor?: string;           // ISO 8601; omit when publishNow is true
  timezone?: string;               // IANA, e.g. 'America/New_York'
  publishNow?: boolean;
  isDraft?: boolean;
  hashtags?: string[];
  collaborators?: string[];        // Instagram, up to 3 Business/Creator usernames
  shareToFeed?: boolean;           // Instagram Reels only (defaults true upstream)
  firstComment?: string;
  requestId?: string;              // UUID sent as x-request-id (idempotency, see createInstagramPost)
}

export interface ZernioPost {
  _id: string;
  content?: string;
  status: 'draft' | 'scheduled' | 'published' | 'failed';
  scheduledFor?: string;
  publishedAt?: string;
  mediaItems?: MediaItem[];
  platforms: Array<{ platform: Platform; accountId: string; status: 'pending' | 'published' | 'failed'; publishedUrl?: string }>;
}

export interface ListPostsResult {
  posts: ZernioPost[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

// ── API ──────────────────────────────────────────────────────────────────────────────────────────

/** List every connected social account (optionally scoped to one Zernio profile). */
export async function listAccounts(profileId?: string): Promise<ZernioAccount[]> {
  const q = profileId ? `?profileId=${encodeURIComponent(profileId)}` : '';
  const { accounts } = await zernioFetch<{ accounts: ZernioAccount[] }>(`/accounts${q}`);
  return accounts ?? [];
}

/** Edit an existing post (e.g. its caption/content or scheduled time). Works on scheduled/draft posts. */
export async function updatePost(id: string, fields: { content?: string; scheduledFor?: string; timezone?: string }): Promise<ZernioPost> {
  const { post } = await zernioFetch<{ post: ZernioPost }>(`/posts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
  return post;
}

/** Cancel/delete a scheduled or draft post. */
export async function deletePost(id: string): Promise<void> {
  await zernioFetch(`/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Disconnect and remove a connected social account from its Zernio profile. */
export async function disconnectAccount(accountId: string): Promise<void> {
  await zernioFetch(`/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
}

/** Generic GET against a Zernio analytics endpoint (e.g. /analytics/instagram/account-insights). */
export async function getAnalytics<T = unknown>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  return zernioFetch<T>(`${path}${qs ? `?${qs}` : ''}`);
}

/** List posts (scheduled/published/draft) for rendering on the calendar. `status` and `accountId`
 *  are server-side filters (Zernio GET /posts supports both), so callers can count or page a single
 *  account's backlog without pulling every post. */
export async function listPosts(params: {
  page?: number;
  limit?: number;
  profileId?: string;
  status?: 'draft' | 'scheduled' | 'published' | 'failed';
  accountId?: string;
} = {}): Promise<ListPostsResult> {
  const qs = new URLSearchParams();
  qs.set('page', String(params.page ?? 1));
  qs.set('limit', String(params.limit ?? 100));
  if (params.profileId) qs.set('profileId', params.profileId);
  if (params.status) qs.set('status', params.status);
  if (params.accountId) qs.set('accountId', params.accountId);
  return zernioFetch<ListPostsResult>(`/posts?${qs.toString()}`);
}

// App-level backlog cap, defined in lib/scheduleCadence (pure, client-safe, so the Schedule All UI
// imports it without bundling this server-only module) and re-exported here for the schedule routes.
export { MAX_SCHEDULED_PER_ACCOUNT } from './scheduleCadence';

/** How many posts are currently SCHEDULED for one account. One cheap call: Zernio's status+accountId
 *  filters plus `limit: 1` mean we only read `pagination.total`, never the posts themselves. */
export async function countScheduledPosts(profileId: string, accountId: string): Promise<number> {
  const { pagination } = await listPosts({ profileId, accountId, status: 'scheduled', limit: 1 });
  // A response without pagination metadata can't answer the question; treat it as an upstream fault
  // rather than guessing 0 (a wrong 0 would let a caller blow past the backlog cap).
  if (!pagination || typeof pagination.total !== 'number') {
    throw new ZernioError('Zernio posts response missing pagination', 502);
  }
  return pagination.total;
}

// ── Per-user profiles & headless OAuth connect ─────────────────────────────────────────────────────

export interface ZernioProfile { _id: string; name: string; isDefault?: boolean }

/** List all Zernio profiles on this account. */
export async function listProfiles(): Promise<ZernioProfile[]> {
  const { profiles } = await zernioFetch<{ profiles: ZernioProfile[] }>('/profiles');
  return profiles ?? [];
}

/** Create a new Zernio profile (one per app user). */
export async function createProfile(name: string): Promise<ZernioProfile> {
  const { profile } = await zernioFetch<{ profile: ZernioProfile }>('/profiles', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return profile;
}

/**
 * Start a headless OAuth connect flow. Returns the platform authUrl to redirect the user to. After
 * they authorize, the platform redirects back to `redirectUrl` with selection params (tempToken,
 * connect_token, step, …) which the client hands back to the page-selection endpoints below.
 */
export async function getConnectUrl(platform: string, profileId: string, redirectUrl: string): Promise<{ authUrl: string; state?: string }> {
  const qs = new URLSearchParams({ profileId, redirect_url: redirectUrl, headless: 'true' });
  return zernioFetch<{ authUrl: string; state?: string }>(`/connect/${encodeURIComponent(platform)}?${qs.toString()}`);
}

export interface FacebookPage { id: string; name: string; username?: string; category?: string }

/**
 * List the Facebook Pages a user can manage after OAuth (Instagram Business accounts are linked to a
 * Page, so this is also the Instagram selection step). `connectToken` is the single-use token from the
 * redirect, forwarded as X-Connect-Token.
 */
export async function listFacebookPages(profileId: string, tempToken: string, connectToken?: string): Promise<FacebookPage[]> {
  const qs = new URLSearchParams({ profileId, tempToken });
  const { pages } = await zernioFetch<{ pages: FacebookPage[] }>(`/connect/facebook/select-page?${qs.toString()}`, {
    headers: connectToken ? { 'X-Connect-Token': connectToken } : undefined,
  });
  return pages ?? [];
}

/** Complete the headless flow by saving the user's selected Page (→ connects its Instagram account). */
export async function selectFacebookPage(input: {
  profileId: string;
  pageId: string;
  tempToken: string;
  userProfile: unknown;
  connectToken?: string;
}): Promise<{ account?: { accountId: string; username?: string; displayName?: string } }> {
  return zernioFetch('/connect/facebook/select-page', {
    method: 'POST',
    headers: input.connectToken ? { 'X-Connect-Token': input.connectToken } : undefined,
    body: JSON.stringify({
      profileId: input.profileId,
      pageId: input.pageId,
      tempToken: input.tempToken,
      userProfile: input.userProfile,
    }),
  });
}

/** Schedule (or immediately publish) an Instagram post. Pass a stable `requestId` (UUID) when the
 *  same logical post could ever be re-sent (bulk items, lost-response replays): Zernio's x-request-id
 *  idempotency window (~5 minutes) then returns the ORIGINAL post instead of creating a duplicate. */
export async function createInstagramPost(input: CreatePostInput): Promise<ZernioPost> {
  const { contentType, collaborators, shareToFeed, firstComment } = input;

  // platformSpecificData only carries the keys that are set, so feed posts stay clean.
  const platformSpecificData: Record<string, unknown> = {};
  if (contentType && contentType !== 'feed') platformSpecificData.contentType = contentType;
  if (collaborators?.length) platformSpecificData.collaborators = collaborators;
  if (shareToFeed != null) platformSpecificData.shareToFeed = shareToFeed;
  if (firstComment) platformSpecificData.firstComment = firstComment;

  const body = {
    content: input.content,
    profileId: input.profileId,
    mediaItems: input.mediaItems,
    hashtags: input.hashtags,
    scheduledFor: input.publishNow ? undefined : input.scheduledFor,
    timezone: input.timezone,
    publishNow: input.publishNow ?? false,
    isDraft: input.isDraft ?? false,
    platforms: [
      {
        platform: 'instagram' as const,
        accountId: input.accountId,
        ...(Object.keys(platformSpecificData).length ? { platformSpecificData } : {}),
      },
    ],
  };

  // POST /v1/posts wraps the created post: 201 is { message, post } (PostCreateResponse in the spec)
  // and a same-x-request-id retry is 200 with { existingPost } (the original, nothing new created).
  // Unwrap both, mirroring updatePost; fall back to the flat body so an unwrapped response (API
  // drift) can't strand callers without an _id, which the routes need for the render ledger.
  const created = await zernioFetch<{ post?: ZernioPost; existingPost?: ZernioPost }>('/posts', {
    method: 'POST',
    headers: input.requestId ? { 'x-request-id': input.requestId } : undefined,
    body: JSON.stringify(body),
  });
  return created.post ?? created.existingPost ?? (created as unknown as ZernioPost);
}
