import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ZernioAccount, ZernioPost } from '@/lib/zernio';

// Regression lock for the accountId ownership guard in POST /api/schedule/post (create path).
// Every user's accounts live under ONE account-wide Zernio key, separated only by profileId, and
// Zernio's POST /posts takes the platforms[].accountId at face value (no accountId-belongs-to-profile
// validation in the spec) — so without this guard any subscriber could schedule or publish posts to
// ANOTHER user's Instagram account just by passing its accountId. Sibling of the userOwnsPost guard
// in ./[id] (which locked the edit/cancel path); this locks create. Pins the OWASP two-user pattern:
// a foreign account 404s (not 403 — never confirm a foreign account exists) with ZERO create calls,
// an owned account posts, and the guard runs for BOTH scheduled and publish-now.

const zern = vi.hoisted(() => ({
  listAccounts: vi.fn<(profileId?: string) => Promise<ZernioAccount[]>>(),
  createInstagramPost: vi.fn<(input: Record<string, unknown>) => Promise<ZernioPost>>(),
  // The create route now enforces the per-account scheduled-backlog cap (non-publish-now), so it calls
  // countScheduledPosts. Mock it under the limit so the ownership path still reaches the create call.
  countScheduledPosts: vi.fn<(profileId: string, accountId: string) => Promise<number>>(),
}));

// Controllable auth state: default = signed-in subscriber; individual tests flip these.
const auth = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  subGate: null as Response | null,
  getOrCreateZernioProfile: vi.fn(async () => 'zprofile-1'),
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
// Keep ZernioError / friendlyZernioMessage REAL (the route instanceof-checks ZernioError);
// mock only the network-backed calls.
vi.mock('@/lib/zernio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/zernio')>();
  return { ...actual, listAccounts: zern.listAccounts, createInstagramPost: zern.createInstagramPost, countScheduledPosts: zern.countScheduledPosts };
});
vi.mock('@/lib/zernioProfile', () => ({ getOrCreateZernioProfile: auth.getOrCreateZernioProfile }));
// The scheduling flag is an env-driven launch gate; pin it ON so the tests are independent of shell env.
vi.mock('@/lib/featureFlags', () => ({ AUTOMATIONS_ENABLED: true, EXPAND_IMAGE_ENABLED: false }));
// ledgerRenders is a best-effort side channel — give it an inert chainable client so the success
// path resolves cleanly (no warn noise) without hitting a real DB.
vi.mock('@/lib/supabaseAdmin', () => {
  interface Chain extends PromiseLike<{ data: unknown[]; error: null }> {
    select: (...a: unknown[]) => Chain;
    insert: (...a: unknown[]) => Chain;
    delete: (...a: unknown[]) => Chain;
    eq: (...a: unknown[]) => Chain;
    like: (...a: unknown[]) => Chain;
    in: (...a: unknown[]) => Chain;
  }
  const chain = (): Chain => {
    const b: Chain = {
      select: () => b, insert: () => b, delete: () => b, eq: () => b, like: () => b, in: () => b,
      then: (onOk, onErr) => Promise.resolve({ data: [] as unknown[], error: null }).then(onOk, onErr),
    };
    return b;
  };
  return { supabaseAdmin: () => ({ from: () => chain() }) };
});

import { POST } from '@/app/api/schedule/post/route';
import { ZernioError } from '@/lib/zernio';

const MY_ACCOUNT = 'aaaaaaaaaaaaaaaaaaaaaaaa';       // connected to the caller's profile
const FOREIGN_ACCOUNT = 'bbbbbbbbbbbbbbbbbbbbbbbb';  // another user's account (NOT in the list)

function account(id: string): ZernioAccount {
  // profileId is OBJECT-shaped: the live API returns it populated ({_id, name, slug}), and mocking it as a
  // plain string is exactly how the 2026-07-19 all-publishes-404 outage slipped past CI. String-shape
  // tolerance is pinned by its own test below.
  return { _id: id, platform: 'instagram', profileId: { _id: 'zprofile-1', name: 'me@test.dev' }, username: 'me', displayName: 'Me', isActive: true };
}

function requestOf(over: Record<string, unknown> = {}): Request {
  return new Request('http://test/api/schedule/post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: MY_ACCOUNT,
      content: 'hello',
      mediaItems: [{ type: 'video', url: 'https://example.supabase.co/storage/v1/object/public/post-videos/u1/_renders/r.mp4' }],
      contentType: 'reels',
      publishNow: false,
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
      timezone: 'Europe/Sofia',
      ...over,
    }),
  });
}

beforeEach(() => {
  zern.listAccounts.mockReset();
  zern.createInstagramPost.mockReset();
  zern.countScheduledPosts.mockReset();
  auth.user = { id: 'u1', email: 'u1@test.dev' };
  auth.subGate = null;
  zern.listAccounts.mockResolvedValue([account(MY_ACCOUNT)]);
  zern.createInstagramPost.mockResolvedValue({ _id: 'post-1', status: 'scheduled', platforms: [] });
  zern.countScheduledPosts.mockResolvedValue(0);   // under the cap → create proceeds
});

describe('POST /api/schedule/post — accountId ownership guard', () => {
  it('foreign accountId → 404 "Account not found" (non-disclosure) and createInstagramPost is NEVER called', async () => {
    const res = await POST(requestOf({ accountId: FOREIGN_ACCOUNT }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Account not found' });
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });

  it('foreign accountId with publishNow → 404 too (ownership applies to immediate publishing, not just scheduling)', async () => {
    const res = await POST(requestOf({ accountId: FOREIGN_ACCOUNT, publishNow: true, scheduledFor: undefined }));
    expect(res.status).toBe(404);
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });

  it('owned accountId → the ownership list is consulted for the CALLER\'s profile and the post is created', async () => {
    const res = await POST(requestOf());
    expect(res.status).toBe(200);
    expect((await res.json()).post._id).toBe('post-1');
    expect(zern.listAccounts).toHaveBeenCalledExactlyOnceWith('zprofile-1');
    expect(zern.createInstagramPost).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ accountId: MY_ACCOUNT, profileId: 'zprofile-1' }),
    );
  });

  it('legacy string-shaped profileId is ALSO accepted (both API shapes tolerated)', async () => {
    zern.listAccounts.mockResolvedValue([
      { _id: MY_ACCOUNT, platform: 'instagram', profileId: 'zprofile-1', username: 'me', displayName: 'Me', isActive: true },
    ]);
    const res = await POST(requestOf());
    expect(res.status).toBe(200);
    expect(zern.createInstagramPost).toHaveBeenCalledTimes(1);
  });

  it('object profileId with a DIFFERENT _id → still 404 (the normalization must not weaken the pin)', async () => {
    zern.listAccounts.mockResolvedValue([
      { _id: MY_ACCOUNT, platform: 'instagram', profileId: { _id: 'zprofile-OTHER', name: 'x' }, username: 'me', displayName: 'Me', isActive: true },
    ]);
    const res = await POST(requestOf());
    expect(res.status).toBe(404);
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });

  it('malformed profileId shapes (null / object without _id) → fail CLOSED with 404, never crash', async () => {
    // Mongoose-populate reality: a deleted referenced profile serializes as null. An _id-less object is
    // defensive paranoia. Both must collapse to a non-match, never a pass and never a 500.
    for (const bad of [null, {}] as unknown[]) {
      zern.createInstagramPost.mockClear();
      zern.listAccounts.mockResolvedValue([
        { _id: MY_ACCOUNT, platform: 'instagram', profileId: bad, username: 'me', displayName: 'Me', isActive: true } as unknown as ZernioAccount,
      ]);
      const res = await POST(requestOf());
      expect(res.status).toBe(404);
      expect(zern.createInstagramPost).not.toHaveBeenCalled();
    }
  });

  it('empty account list (nothing connected) → 404, no create call', async () => {
    zern.listAccounts.mockResolvedValue([]);
    const res = await POST(requestOf());
    expect(res.status).toBe(404);
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });

  it('listAccounts failure → fail CLOSED: surfaces the Zernio status, post is NOT created', async () => {
    zern.listAccounts.mockRejectedValue(new ZernioError('upstream down', 503));
    const res = await POST(requestOf());
    expect(res.status).toBe(503);
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });

  it('unauthenticated → 401 before any Zernio call', async () => {
    auth.user = null;
    const res = await POST(requestOf());
    expect(res.status).toBe(401);
    expect(zern.listAccounts).not.toHaveBeenCalled();
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });

  it('non-subscriber → gate response before any Zernio call', async () => {
    auth.subGate = new Response(JSON.stringify({ error: 'pro only' }), { status: 402 });
    const res = await POST(requestOf());
    expect(res.status).toBe(402);
    expect(zern.listAccounts).not.toHaveBeenCalled();
    expect(zern.createInstagramPost).not.toHaveBeenCalled();
  });
});
