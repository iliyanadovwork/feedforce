import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ZernioPost, ListPostsResult } from '@/lib/zernio';

// Regression lock for the userOwnsPost IDOR guard in /api/schedule/post/[id] (PUT + DELETE).
// Every user's posts live under ONE account-wide Zernio key, and Zernio's PUT/DELETE /posts/{id}
// take no profileId — so without the ownership scan any subscriber could edit or cancel any other
// user's scheduled post by id. That exact bug shipped once; these tests call the REAL route handlers
// and pin: 404 (not 403) for foreign posts with zero zernio writes, the paginated ownership scan
// (page-break boundary), the MAX_PAGES cap, and that auth/subscription gates run before any zernio call.

const zern = vi.hoisted(() => ({
  listPosts: vi.fn<(p: { page?: number; limit?: number; profileId?: string }) => Promise<ListPostsResult>>(),
  updatePost: vi.fn<(id: string, fields: Record<string, string>) => Promise<ZernioPost>>(),
  deletePost: vi.fn<(id: string) => Promise<void>>(),
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
  return { ...actual, listPosts: zern.listPosts, updatePost: zern.updatePost, deletePost: zern.deletePost };
});
vi.mock('@/lib/zernioProfile', () => ({ getOrCreateZernioProfile: auth.getOrCreateZernioProfile }));
// The scheduling flag is an env-driven launch gate; pin it ON so the tests are independent of shell env.
vi.mock('@/lib/featureFlags', () => ({ AUTOMATIONS_ENABLED: true, EXPAND_IMAGE_ENABLED: false }));
// purgeRenders / extendRenderExpiry are best-effort side channels — give them an inert chainable
// client so they resolve cleanly (no warn noise) without hitting a real DB.
vi.mock('@/lib/supabaseAdmin', () => {
  interface Chain extends PromiseLike<{ data: unknown[]; error: null }> {
    select: (...a: unknown[]) => Chain;
    update: (...a: unknown[]) => Chain;
    delete: (...a: unknown[]) => Chain;
    eq: (...a: unknown[]) => Chain;
    in: (...a: unknown[]) => Chain;
  }
  const chain = (): Chain => {
    const b: Chain = {
      select: () => b, update: () => b, delete: () => b, eq: () => b, in: () => b,
      then: (onOk, onErr) => Promise.resolve({ data: [] as unknown[], error: null }).then(onOk, onErr),
    };
    return b;
  };
  return {
    supabaseAdmin: () => ({
      from: () => chain(),
      storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
    }),
  };
});

import { PUT, DELETE } from '@/app/api/schedule/post/[id]/route';

const LIMIT = 100;      // page size hardcoded in userOwnsPost
const MAX_PAGES = 10;   // hostile-id probe cap hardcoded in userOwnsPost

function post(id: string): ZernioPost {
  return { _id: id, status: 'scheduled', platforms: [] };
}
function pageOf(ids: string[], page: number, pages: number): ListPostsResult {
  return { posts: ids.map(post), pagination: { page, limit: LIMIT, total: pages * LIMIT, pages } };
}
function putReq(id: string, body: unknown = { content: 'edited' }): Request {
  return new Request(`http://t/api/schedule/post/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
function delReq(id: string): Request {
  return new Request(`http://t/api/schedule/post/${id}`, { method: 'DELETE' });
}
function expectNoZernioWrites() {
  expect(zern.updatePost).not.toHaveBeenCalled();
  expect(zern.deletePost).not.toHaveBeenCalled();
}

beforeEach(() => {
  zern.listPosts.mockReset();
  zern.updatePost.mockReset();
  zern.deletePost.mockReset();
  auth.getOrCreateZernioProfile.mockClear();
  auth.user = { id: 'u1', email: 'owner@example.com' };
  auth.subGate = null;
});

describe('IDOR guard — a post NOT in the caller profile', () => {
  beforeEach(() => {
    // The victim's post never appears in the attacker's (profile-scoped) list.
    zern.listPosts.mockResolvedValue(pageOf(['mine-a', 'mine-b'], 1, 1));
  });

  it('PUT → 404 (non-disclosure, not 403) and updatePost is never called', async () => {
    const res = await PUT(putReq('victims-post'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Post not found' });
    expectNoZernioWrites();
    // The scan really ran against the caller's own profile.
    expect(zern.listPosts).toHaveBeenCalledWith({ profileId: 'zprofile-1', page: 1, limit: LIMIT });
  });

  it('DELETE → 404 (non-disclosure, not 403) and deletePost is never called', async () => {
    const res = await DELETE(delReq('victims-post'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Post not found' });
    expectNoZernioWrites();
    expect(zern.listPosts).toHaveBeenCalledWith({ profileId: 'zprofile-1', page: 1, limit: LIMIT });
  });
});

describe('owned post — the verb proceeds with the right args', () => {
  it('PUT forwards only the sanitized string fields to updatePost and returns the post', async () => {
    zern.listPosts.mockResolvedValue(pageOf(['other', 'post-1'], 1, 1));
    const updated = { ...post('post-1'), content: 'edited' };
    zern.updatePost.mockResolvedValue(updated);
    const res = await PUT(putReq('post-1', {
      content: 'edited',
      scheduledFor: '2999-01-01T00:00:00.000Z',
      timezone: 'Europe/Sofia',
      injected: 'nope',        // unknown key → dropped
      extraNumber: 42,         // non-string → dropped
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ post: updated });
    expect(zern.updatePost).toHaveBeenCalledExactlyOnceWith('post-1', {
      content: 'edited', scheduledFor: '2999-01-01T00:00:00.000Z', timezone: 'Europe/Sofia',
    });
    expect(zern.deletePost).not.toHaveBeenCalled();
  });

  it('DELETE calls deletePost with the id and returns ok', async () => {
    zern.listPosts.mockResolvedValue(pageOf(['post-1'], 1, 1));
    zern.deletePost.mockResolvedValue(undefined);
    const res = await DELETE(delReq('post-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(zern.deletePost).toHaveBeenCalledExactlyOnceWith('post-1');
    expect(zern.updatePost).not.toHaveBeenCalled();
  });
});

describe('ownership scan pagination', () => {
  it('finds a post on page 2 when page 1 holds exactly LIMIT posts (page-break boundary)', async () => {
    const page1 = pageOf(Array.from({ length: LIMIT }, (_, i) => `filler-${i}`), 1, 2);
    const page2 = pageOf(['post-on-page-2'], 2, 2);
    zern.listPosts.mockImplementation(async ({ page }) => (page === 1 ? page1 : page2));
    zern.deletePost.mockResolvedValue(undefined);

    const res = await DELETE(delReq('post-on-page-2'));
    expect(res.status).toBe(200);
    expect(zern.listPosts).toHaveBeenCalledTimes(2);
    expect(zern.listPosts).toHaveBeenNthCalledWith(1, { profileId: 'zprofile-1', page: 1, limit: LIMIT });
    expect(zern.listPosts).toHaveBeenNthCalledWith(2, { profileId: 'zprofile-1', page: 2, limit: LIMIT });
    expect(zern.deletePost).toHaveBeenCalledExactlyOnceWith('post-on-page-2');
  });

  it('stops after the reported page count — a missing post costs pagination.pages calls, not MAX_PAGES', async () => {
    zern.listPosts.mockImplementation(async ({ page }) => pageOf([`p${page}`], page ?? 1, 3));
    const res = await PUT(putReq('never-listed'));
    expect(res.status).toBe(404);
    expect(zern.listPosts).toHaveBeenCalledTimes(3);
    expectNoZernioWrites();
  });

  it('a response without pagination metadata is treated as the only page (no infinite retry)', async () => {
    zern.listPosts.mockResolvedValue({ posts: [post('mine')], pagination: undefined } as unknown as ListPostsResult);
    const res = await PUT(putReq('foreign'));
    expect(res.status).toBe(404);
    expect(zern.listPosts).toHaveBeenCalledTimes(1);
    expectNoZernioWrites();
  });

  it('MAX_PAGES cap: a hostile id probe stops at 10 pages and resolves not-owned (404), for PUT and DELETE', async () => {
    // Upstream claims 1000 pages, target never appears → the scan must bail at MAX_PAGES, not loop on.
    zern.listPosts.mockImplementation(async ({ page }) =>
      pageOf(Array.from({ length: LIMIT }, (_, i) => `p${page}-${i}`), page ?? 1, 1000));

    const putRes = await PUT(putReq('probe-id'));
    expect(putRes.status).toBe(404);
    expect(zern.listPosts).toHaveBeenCalledTimes(MAX_PAGES);

    zern.listPosts.mockClear();
    const delRes = await DELETE(delReq('probe-id'));
    expect(delRes.status).toBe(404);
    expect(zern.listPosts).toHaveBeenCalledTimes(MAX_PAGES);
    expectNoZernioWrites();
  });
});

describe('auth gates run before any zernio call', () => {
  it('unauthenticated → 401 and zernio is never touched (PUT + DELETE)', async () => {
    auth.user = null;
    zern.listPosts.mockResolvedValue(pageOf(['post-1'], 1, 1));
    expect((await PUT(putReq('post-1'))).status).toBe(401);
    expect((await DELETE(delReq('post-1'))).status).toBe(401);
    expect(zern.listPosts).not.toHaveBeenCalled();
    expect(auth.getOrCreateZernioProfile).not.toHaveBeenCalled();
    expectNoZernioWrites();
  });

  it('non-subscriber → the gate response is returned verbatim and zernio is never touched (PUT + DELETE)', async () => {
    zern.listPosts.mockResolvedValue(pageOf(['post-1'], 1, 1));
    auth.subGate = new Response(JSON.stringify({ error: 'sub' }), { status: 402 });
    expect((await PUT(putReq('post-1'))).status).toBe(402);
    auth.subGate = new Response(JSON.stringify({ error: 'sub' }), { status: 402 });
    expect((await DELETE(delReq('post-1'))).status).toBe(402);
    expect(zern.listPosts).not.toHaveBeenCalled();
    expect(auth.getOrCreateZernioProfile).not.toHaveBeenCalled();
    expectNoZernioWrites();
  });
});
