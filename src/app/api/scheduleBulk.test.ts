import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CreatePostInput, MediaItem, ZernioAccount, ZernioPost } from '@/lib/zernio';

// Contract lock for POST /api/schedule/posts/bulk (Schedule All). Pins: the gate order (flag, auth,
// subscription) runs before any Zernio call; every 400 validation (item count 1..10, future
// scheduledFor, caption cap, OUR post-videos bucket only, UUID-shaped requestId); the account
// ownership guard (a foreign accountId 404s before anything is counted or created); the
// all-or-nothing backlog cap (409 with `remaining`, ZERO posts placed); per-item isolation (one
// upstream failure never sinks the rest of the chunk, and failed items are NEVER retried); the
// exact createInstagramPost payload (reels, publishNow false, requestId passthrough); the render
// ledger per success; and the ~1100ms pacing gap BETWEEN calls (tested with fake timers, no real
// sleeping).

const zern = vi.hoisted(() => ({
  createInstagramPost: vi.fn<(input: CreatePostInput) => Promise<ZernioPost>>(),
  countScheduledPosts: vi.fn<(profileId: string, accountId: string) => Promise<number>>(),
  listAccounts: vi.fn<(profileId?: string) => Promise<ZernioAccount[]>>(),
}));

// Controllable auth state: default = signed-in subscriber; individual tests flip these.
const auth = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  subGate: null as Response | null,
  getOrCreateZernioProfile: vi.fn(async () => 'zprofile-1'),
}));

// Mutable so the flag-off test can flip it (imports compile to live property reads of this object).
const flags = vi.hoisted(() => ({ AUTOMATIONS_ENABLED: true, EXPAND_IMAGE_ENABLED: false }));

const ledger = vi.hoisted(() => ({
  ledgerRenders: vi.fn<(userId: string, postId: string, mediaItems: MediaItem[], expiresAtMs: number) => Promise<void>>(async () => {}),
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
// Keep ZernioError / friendlyZernioMessage / MAX_SCHEDULED_PER_ACCOUNT REAL (the route
// instanceof-checks ZernioError); mock only the network-backed calls.
vi.mock('@/lib/zernio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/zernio')>();
  return { ...actual, createInstagramPost: zern.createInstagramPost, countScheduledPosts: zern.countScheduledPosts, listAccounts: zern.listAccounts };
});
vi.mock('@/lib/zernioProfile', () => ({ getOrCreateZernioProfile: auth.getOrCreateZernioProfile }));
vi.mock('@/lib/featureFlags', () => flags);
vi.mock('@/lib/scheduleLedger', () => ledger);

import { POST } from '@/app/api/schedule/posts/bulk/route';
import { ZernioError, friendlyZernioMessage, MAX_SCHEDULED_PER_ACCOUNT } from '@/lib/zernio';

const BASE = 'https://unit-test.supabase.co';
const VIDEO_PREFIX = `${BASE}/storage/v1/object/public/post-videos/`;
const FUTURE = '2999-01-01T10:00:00.000Z';
const GAP_MS = 1100; // must match PACING_GAP_MS in the route

function item(n: number, over: Partial<{ mediaUrl: string; caption: string; scheduledFor: string; requestId: string }> = {}) {
  return { mediaUrl: `${VIDEO_PREFIX}u1/_renders/reel-${n}.mp4`, caption: `caption ${n}`, scheduledFor: FUTURE, ...over };
}
function account(id: string): ZernioAccount {
  // Object-shaped profileId, matching the live API (populated {_id, name}); see schedulePostOwnership.test.ts.
  return { _id: id, platform: 'instagram', profileId: { _id: 'zprofile-1', name: 'owner@test.dev' }, username: 'owner', displayName: 'Owner', isActive: true };
}
function bulkReq(body: unknown): Request {
  return new Request('http://t/api/schedule/posts/bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
function okPost(id: string): ZernioPost {
  return { _id: id, status: 'scheduled', platforms: [] };
}
function expectNoZernioCalls() {
  expect(zern.listAccounts).not.toHaveBeenCalled();
  expect(zern.countScheduledPosts).not.toHaveBeenCalled();
  expect(zern.createInstagramPost).not.toHaveBeenCalled();
}

// The route sleeps BETWEEN createInstagramPost calls; tests fake only setTimeout (Date and
// microtasks stay real) and advance the clock instead of really sleeping.
async function drain(p: Promise<Response>): Promise<Response> {
  let settled = false;
  const tracked = p.then((r) => { settled = true; return r; });
  for (let i = 0; i < 40 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(GAP_MS);
  }
  return tracked;
}
async function flushMicrotasks() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

beforeEach(() => {
  zern.createInstagramPost.mockReset().mockResolvedValue(okPost('post-x'));
  zern.countScheduledPosts.mockReset().mockResolvedValue(0);
  zern.listAccounts.mockReset().mockResolvedValue([account('acct-1')]);
  ledger.ledgerRenders.mockClear();
  auth.getOrCreateZernioProfile.mockClear();
  auth.user = { id: 'u1', email: 'owner@example.com' };
  auth.subGate = null;
  flags.AUTOMATIONS_ENABLED = true;
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gates run before any zernio call', () => {
  it('feature flag off → 404', async () => {
    flags.AUTOMATIONS_ENABLED = false;
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items: [item(1)] }));
    expect(res.status).toBe(404);
    expectNoZernioCalls();
  });

  it('unauthenticated → 401 and zernio is never touched', async () => {
    auth.user = null;
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items: [item(1)] }));
    expect(res.status).toBe(401);
    expect(auth.getOrCreateZernioProfile).not.toHaveBeenCalled();
    expectNoZernioCalls();
  });

  it('non-subscriber → the gate response is returned verbatim', async () => {
    auth.subGate = new Response(JSON.stringify({ error: 'sub' }), { status: 402 });
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items: [item(1)] }));
    expect(res.status).toBe(402);
    expect(auth.getOrCreateZernioProfile).not.toHaveBeenCalled();
    expectNoZernioCalls();
  });
});

describe('validation → 400 with zero zernio calls', () => {
  it('more than 10 items', async () => {
    const items = Array.from({ length: 11 }, (_, i) => item(i));
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items }));
    expect(res.status).toBe(400);
    expectNoZernioCalls();
  });

  it('empty items array', async () => {
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items: [] }));
    expect(res.status).toBe(400);
    expectNoZernioCalls();
  });

  it('a scheduledFor in the past', async () => {
    const items = [item(1), item(2, { scheduledFor: '2000-01-01T00:00:00.000Z' })];
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items }));
    expect(res.status).toBe(400);
    expectNoZernioCalls();
  });

  it('a caption over 2200 characters', async () => {
    const items = [item(1, { caption: 'x'.repeat(2201) })];
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items }));
    expect(res.status).toBe(400);
    expectNoZernioCalls();
  });

  it('a mediaUrl outside OUR post-videos bucket (foreign host)', async () => {
    const items = [item(1, { mediaUrl: 'https://evil.example.com/reel.mp4' })];
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items }));
    expect(res.status).toBe(400);
    expectNoZernioCalls();
  });

  it('a mediaUrl on our host but a different bucket is still rejected', async () => {
    const items = [item(1, { mediaUrl: `${BASE}/storage/v1/object/public/post-images/u1/_renders/pic.png` })];
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items }));
    expect(res.status).toBe(400);
    expectNoZernioCalls();
  });

  it('a malformed requestId (not a UUID) is rejected', async () => {
    const items = [item(1, { requestId: 'not-a-uuid' })];
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items }));
    expect(res.status).toBe(400);
    expectNoZernioCalls();
  });
});

describe('account ownership', () => {
  it("an accountId outside the caller's profile → 404, and nothing is counted or created", async () => {
    const res = await POST(bulkReq({ accountId: 'acct-foreign', timezone: 'UTC', items: [item(1)] }));
    expect(res.status).toBe(404);
    expect(zern.listAccounts).toHaveBeenCalledExactlyOnceWith('zprofile-1');
    expect(zern.countScheduledPosts).not.toHaveBeenCalled();
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
    expect(ledger.ledgerRenders).not.toHaveBeenCalled();
  });
});

describe('per-account backlog cap', () => {
  it('existing + batch over the cap → 409 with remaining, and NOTHING is scheduled', async () => {
    zern.countScheduledPosts.mockResolvedValue(45);
    const items = Array.from({ length: 6 }, (_, i) => item(i));
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.remaining).toBe(5);
    expect(typeof body.error).toBe('string');
    expect(zern.countScheduledPosts).toHaveBeenCalledExactlyOnceWith('zprofile-1', 'acct-1');
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
    expect(ledger.ledgerRenders).not.toHaveBeenCalled();
  });

  it('a batch that exactly fills the cap is allowed', async () => {
    zern.countScheduledPosts.mockResolvedValue(MAX_SCHEDULED_PER_ACCOUNT - 1);
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items: [item(1)] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ remaining: 0 });
    expect(zern.createInstagramPost).toHaveBeenCalledTimes(1);
  });
});

describe('execution', () => {
  it('happy path: N items → N paced create calls with exact payloads, a ledger entry per success, and remaining after the batch', async () => {
    zern.countScheduledPosts.mockResolvedValue(10);
    let n = 0;
    zern.createInstagramPost.mockImplementation(async () => okPost(`post-${++n}`));
    const t2 = '2999-01-02T10:00:00.000Z';
    const t3 = '2999-01-03T10:00:00.000Z';
    const items = [item(1), item(2, { scheduledFor: t2 }), item(3, { scheduledFor: t3 })];

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const res = await drain(POST(bulkReq({ accountId: 'acct-1', timezone: 'Europe/Sofia', items })));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { ok: true, postId: 'post-1' },
        { ok: true, postId: 'post-2' },
        { ok: true, postId: 'post-3' },
      ],
      remaining: MAX_SCHEDULED_PER_ACCOUNT - 10 - 3,
    });

    expect(zern.createInstagramPost).toHaveBeenCalledTimes(3);
    expect(zern.createInstagramPost).toHaveBeenNthCalledWith(1, {
      content: 'caption 1',
      profileId: 'zprofile-1',
      accountId: 'acct-1',
      mediaItems: [{ type: 'video', url: `${VIDEO_PREFIX}u1/_renders/reel-1.mp4` }],
      contentType: 'reels',
      publishNow: false,
      scheduledFor: FUTURE,
      timezone: 'Europe/Sofia',
    });
    expect(zern.createInstagramPost).toHaveBeenNthCalledWith(3, expect.objectContaining({
      content: 'caption 3', scheduledFor: t3, contentType: 'reels', publishNow: false,
    }));

    // One ledger entry per accepted post, expiring at publish time + 6h (mirrors the single route).
    expect(ledger.ledgerRenders).toHaveBeenCalledTimes(3);
    expect(ledger.ledgerRenders).toHaveBeenNthCalledWith(1,
      'u1', 'post-1', [{ type: 'video', url: `${VIDEO_PREFIX}u1/_renders/reel-1.mp4` }],
      Date.parse(FUTURE) + 6 * 3600_000);
    expect(ledger.ledgerRenders).toHaveBeenNthCalledWith(2,
      'u1', 'post-2', [{ type: 'video', url: `${VIDEO_PREFIX}u1/_renders/reel-2.mp4` }],
      Date.parse(t2) + 6 * 3600_000);
  });

  it('a ZernioError mid-batch fails only that item with the friendly message; the rest still schedule (no retry)', async () => {
    zern.countScheduledPosts.mockResolvedValue(0);
    let n = 0;
    zern.createInstagramPost.mockImplementation(async () => {
      n++;
      if (n === 2) throw new ZernioError('Rate limit exceeded', 429);
      return okPost(`post-${n}`);
    });
    const items = [item(1), item(2), item(3)];

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const res = await drain(POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items })));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { ok: true, postId: 'post-1' },
        { ok: false, error: friendlyZernioMessage(429) },
        { ok: true, postId: 'post-3' },
      ],
      remaining: MAX_SCHEDULED_PER_ACCOUNT - 2,
    });
    expect(zern.createInstagramPost).toHaveBeenCalledTimes(3); // exactly one attempt per item
    expect(ledger.ledgerRenders).toHaveBeenCalledTimes(2);     // only the successes
  });

  it('a per-item requestId rides through to createInstagramPost (x-request-id idempotency)', async () => {
    const rid = '123e4567-e89b-42d3-a456-426614174000';
    const res = await POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items: [item(1, { requestId: rid })] }));
    expect(res.status).toBe(200);
    expect(zern.createInstagramPost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: rid }));
  });

  it('paces ~1100ms BETWEEN calls: the next create fires only after the gap elapses, and never after the last', async () => {
    zern.countScheduledPosts.mockResolvedValue(0);
    const items = [item(1), item(2), item(3)];

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const p = POST(bulkReq({ accountId: 'acct-1', timezone: 'UTC', items }));

    // First call goes out with no delay.
    await flushMicrotasks();
    expect(zern.createInstagramPost).toHaveBeenCalledTimes(1);

    // 1000ms in: still inside the gap.
    await vi.advanceTimersByTimeAsync(GAP_MS - 100);
    await flushMicrotasks();
    expect(zern.createInstagramPost).toHaveBeenCalledTimes(1);

    // Gap elapses → second call.
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();
    expect(zern.createInstagramPost).toHaveBeenCalledTimes(2);

    // Second gap → third call, then the response resolves with no trailing sleep.
    await vi.advanceTimersByTimeAsync(GAP_MS);
    await flushMicrotasks();
    expect(zern.createInstagramPost).toHaveBeenCalledTimes(3);

    const res = await p;
    expect(res.status).toBe(200);
  });
});
