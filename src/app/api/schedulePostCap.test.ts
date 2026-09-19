import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CreatePostInput, ZernioAccount, ZernioPost } from '@/lib/zernio';

// Locks the per-account scheduled-backlog cap on POST /api/schedule/post: scheduling at the cap →
// 409 { error, remaining: 0 } with NO Zernio create call, publish-now bypasses the check entirely
// (it never enters the backlog), under-cap behavior is unchanged (create + render ledger with the
// scheduled-time + 6h expiry), and a foreign accountId 404s before anything is counted or created
// (account ownership guard). Also unit-tests two REAL zernio functions at the fetch layer:
// countScheduledPosts must ask Zernio for status=scheduled + accountId with limit=1 and read
// pagination.total, treating a missing pagination block as an upstream fault (ZernioError 502),
// never as zero; createInstagramPost must unwrap the documented { message, post } create envelope
// (and the idempotent-retry { existingPost }) and send x-request-id only when a requestId is given.

const zern = vi.hoisted(() => ({
  createInstagramPost: vi.fn<(input: CreatePostInput) => Promise<ZernioPost>>(),
  countScheduledPosts: vi.fn<(profileId: string, accountId: string) => Promise<number>>(),
  listAccounts: vi.fn<(profileId?: string) => Promise<ZernioAccount[]>>(),
}));

// Controllable auth state: default = signed-in subscriber.
const auth = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  subGate: null as Response | null,
  getOrCreateZernioProfile: vi.fn(async () => 'zprofile-1'),
}));

const ledger = vi.hoisted(() => ({ ledgerRenders: vi.fn(async () => {}) }));

// The REAL countScheduledPosts / createInstagramPost, captured from the unmocked module so the
// fetch-layer unit tests below exercise the actual query/body building while route tests see the
// mocked exports.
const real = vi.hoisted(() => ({} as {
  countScheduledPosts: (profileId: string, accountId: string) => Promise<number>;
  createInstagramPost: (input: CreatePostInput) => Promise<ZernioPost>;
}));

vi.mock('@/lib/serverAuth', () => ({
  requireUser: vi.fn(async () => auth.user),
  unauthorized: () => new Response(JSON.stringify({ error: 'unauth' }), { status: 401 }),
  requireSubscriber: vi.fn(async () => auth.subGate),
}));
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(async () => true),
  tooManyRequests: () => new Response(JSON.stringify({ error: 'rate' }), { status: 429 }),
}));
// Keep ZernioError / friendlyZernioMessage / MAX_SCHEDULED_PER_ACCOUNT REAL; mock only the
// network-backed calls the route makes.
vi.mock('@/lib/zernio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/zernio')>();
  real.countScheduledPosts = actual.countScheduledPosts;
  real.createInstagramPost = actual.createInstagramPost;
  return { ...actual, createInstagramPost: zern.createInstagramPost, countScheduledPosts: zern.countScheduledPosts, listAccounts: zern.listAccounts };
});
vi.mock('@/lib/zernioProfile', () => ({ getOrCreateZernioProfile: auth.getOrCreateZernioProfile }));
// The scheduling flag is an env-driven launch gate; pin it ON so the tests are independent of shell env.
vi.mock('@/lib/featureFlags', () => ({ AUTOMATIONS_ENABLED: true, EXPAND_IMAGE_ENABLED: false }));
vi.mock('@/lib/scheduleLedger', () => ledger);

import { POST } from '@/app/api/schedule/post/route';
import { MAX_SCHEDULED_PER_ACCOUNT, ZernioError } from '@/lib/zernio';

const FUTURE = '2999-01-01T10:00:00.000Z';
const MEDIA = [{ type: 'video', url: 'https://cdn.example.com/v.mp4' }];

function postReq(over: Record<string, unknown> = {}): Request {
  return new Request('http://t/api/schedule/post', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: 'acct-1', content: 'hi', mediaItems: MEDIA, contentType: 'reels',
      scheduledFor: FUTURE, timezone: 'UTC', ...over,
    }),
  });
}

beforeEach(() => {
  zern.createInstagramPost.mockReset().mockResolvedValue({ _id: 'p1', status: 'scheduled', platforms: [] });
  zern.countScheduledPosts.mockReset().mockResolvedValue(0);
  zern.listAccounts.mockReset().mockResolvedValue([
    { _id: 'acct-1', platform: 'instagram', profileId: 'zprofile-1', username: 'owner', displayName: 'Owner', isActive: true },
  ]);
  ledger.ledgerRenders.mockClear();
  auth.getOrCreateZernioProfile.mockClear();
  auth.user = { id: 'u1', email: 'owner@example.com' };
  auth.subGate = null;
});

describe('scheduled-backlog cap on the single route', () => {
  it('at the cap + scheduled → 409 { error, remaining: 0 } and createInstagramPost is never called', async () => {
    zern.countScheduledPosts.mockResolvedValue(MAX_SCHEDULED_PER_ACCOUNT);
    const res = await POST(postReq());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.remaining).toBe(0);
    expect(typeof body.error).toBe('string');
    expect(zern.countScheduledPosts).toHaveBeenCalledExactlyOnceWith('zprofile-1', 'acct-1');
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
    expect(ledger.ledgerRenders).not.toHaveBeenCalled();
  });

  it('at the cap + publishNow → allowed, and the count is never even fetched', async () => {
    zern.countScheduledPosts.mockResolvedValue(MAX_SCHEDULED_PER_ACCOUNT);
    const res = await POST(postReq({ publishNow: true, scheduledFor: undefined }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ post: { _id: 'p1', status: 'scheduled', platforms: [] } });
    expect(zern.countScheduledPosts).not.toHaveBeenCalled();
    expect(zern.createInstagramPost).toHaveBeenCalledTimes(1);
  });

  it('under the cap → unchanged behavior: create + ledger with the scheduled-time + 6h expiry', async () => {
    zern.countScheduledPosts.mockResolvedValue(MAX_SCHEDULED_PER_ACCOUNT - 1);
    const res = await POST(postReq());
    expect(res.status).toBe(200);
    expect(zern.createInstagramPost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      accountId: 'acct-1', profileId: 'zprofile-1', contentType: 'reels', scheduledFor: FUTURE,
    }));
    expect(ledger.ledgerRenders).toHaveBeenCalledExactlyOnceWith('u1', 'p1', MEDIA, Date.parse(FUTURE) + 6 * 3600_000);
  });

  it('a failing count surfaces the friendly Zernio error and blocks the create', async () => {
    zern.countScheduledPosts.mockRejectedValue(new ZernioError('Zernio posts response missing pagination', 502));
    const res = await POST(postReq());
    expect(res.status).toBe(502);
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });

  it("an accountId outside the caller's profile → 404, and nothing is counted or created", async () => {
    const res = await POST(postReq({ accountId: 'acct-foreign' }));
    expect(res.status).toBe(404);
    expect(zern.listAccounts).toHaveBeenCalledExactlyOnceWith('zprofile-1');
    expect(zern.countScheduledPosts).not.toHaveBeenCalled();
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
    expect(ledger.ledgerRenders).not.toHaveBeenCalled();
  });

  it('the ownership guard applies to publish-now as well (only the CAP check is bypassed)', async () => {
    const res = await POST(postReq({ accountId: 'acct-foreign', publishNow: true, scheduledFor: undefined }));
    expect(res.status).toBe(404);
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });
});

describe('countScheduledPosts (real implementation, fetch layer)', () => {
  function fetchOk(body: unknown) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  beforeEach(() => {
    process.env.ZERNIO_API_KEY = 'test-key';
  });

  it('asks for status=scheduled + accountId with limit=1 and returns pagination.total', async () => {
    const spy = fetchOk({ posts: [], pagination: { page: 1, limit: 1, total: 37, pages: 37 } });
    try {
      await expect(real.countScheduledPosts('prof-9', 'acct-9')).resolves.toBe(37);
      const url = new URL(String(spy.mock.calls[0][0]));
      expect(url.pathname).toBe('/api/v1/posts');
      expect(url.searchParams.get('status')).toBe('scheduled');
      expect(url.searchParams.get('accountId')).toBe('acct-9');
      expect(url.searchParams.get('profileId')).toBe('prof-9');
      expect(url.searchParams.get('limit')).toBe('1');
    } finally {
      spy.mockRestore();
    }
  });

  it('a response missing pagination throws ZernioError 502 instead of pretending the backlog is empty', async () => {
    const spy = fetchOk({ posts: [] });
    try {
      await expect(real.countScheduledPosts('prof-9', 'acct-9')).rejects.toMatchObject({ name: 'ZernioError', status: 502 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('createInstagramPost (real implementation, fetch layer)', () => {
  // Pins the WIRE contract of POST /v1/posts (the route tests above mock createInstagramPost, so
  // only these see the envelope): 201 wraps the created post as { message, post } and an
  // x-request-id retry is 200 { existingPost } (the ORIGINAL, nothing new created). Both must
  // unwrap to a post with _id, which the schedule routes need for the render ledger; missing that
  // unwrap silently orphans every scheduled MP4 into the hourly cleanup cron's path.
  // mockImplementation (not mockResolvedValue): a Response body is single-use, and one test
  // fetches twice.
  function fetchOk(body: unknown, status = 201) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  }

  const RID = '123e4567-e89b-42d3-a456-426614174000';
  const INPUT: CreatePostInput = {
    content: 'hi', profileId: 'prof-9', accountId: 'acct-9',
    mediaItems: [{ type: 'video', url: 'https://cdn.example.com/v.mp4' }],
    contentType: 'reels', scheduledFor: FUTURE, timezone: 'UTC',
  };

  beforeEach(() => {
    process.env.ZERNIO_API_KEY = 'test-key';
  });

  it('unwraps the documented 201 { message, post } envelope to the post itself', async () => {
    const spy = fetchOk({ message: 'Post scheduled successfully', post: { _id: 'zp-1', status: 'scheduled', platforms: [] } });
    try {
      await expect(real.createInstagramPost(INPUT)).resolves.toMatchObject({ _id: 'zp-1', status: 'scheduled' });
    } finally {
      spy.mockRestore();
    }
  });

  it('an idempotent retry (200 { existingPost }) resolves to the ORIGINAL post, so callers treat it as success', async () => {
    const spy = fetchOk({ message: 'Duplicate request', existingPost: { _id: 'zp-orig', status: 'scheduled', platforms: [] } }, 200);
    try {
      await expect(real.createInstagramPost({ ...INPUT, requestId: RID })).resolves.toMatchObject({ _id: 'zp-orig' });
    } finally {
      spy.mockRestore();
    }
  });

  it('sends the x-request-id header ONLY when a requestId is passed', async () => {
    const spy = fetchOk({ message: 'ok', post: { _id: 'zp-2', status: 'scheduled', platforms: [] } });
    try {
      await real.createInstagramPost(INPUT);
      await real.createInstagramPost({ ...INPUT, requestId: RID });
      const headerOf = (call: number) => new Headers((spy.mock.calls[call][1] as RequestInit).headers).get('x-request-id');
      expect(headerOf(0)).toBeNull();
      expect(headerOf(1)).toBe(RID);
    } finally {
      spy.mockRestore();
    }
  });

  it('a flat (unwrapped) body still resolves to the post, guarding against spec/API drift', async () => {
    const spy = fetchOk({ _id: 'zp-flat', status: 'scheduled', platforms: [] });
    try {
      await expect(real.createInstagramPost(INPUT)).resolves.toMatchObject({ _id: 'zp-flat' });
    } finally {
      spy.mockRestore();
    }
  });
});
