import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// SSRF/auth wiring tests for the download route. The REAL hostOf/hostMatches classification and the
// REAL isSafePublicUrl run — only DNS is mocked (offline-deterministic) and global fetch is scripted.
// The invariant pinned throughout: a user-supplied URL is NEVER fetched directly unless it is a
// vm./vt.tiktok.com short link that passed the SSRF guard — everything else is either rejected or only
// ever forwarded as DATA (a form field) to the hardcoded upstream APIs.

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
import { lookup } from 'node:dns/promises';

type FakeUser = { id: string; email: string };
const auth = vi.hoisted(() => ({
  requireUser: vi.fn(async (): Promise<FakeUser | null> => ({ id: 'u1', email: 't@example.com' })),
}));
vi.mock('@/lib/serverAuth', () => ({
  requireUser: auth.requireUser,
  unauthorized: () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}));
const gates = vi.hoisted(() => ({ rateLimit: vi.fn<(key: string, limit: number) => Promise<boolean>>(async () => true) }));
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: gates.rateLimit,
  tooManyRequests: () => new Response(JSON.stringify({ error: 'rate' }), { status: 429 }),
}));
vi.mock('@/lib/reportError', () => ({ reportError: vi.fn() }));
const ig = vi.hoisted(() => ({ igdl: vi.fn<(url: string) => Promise<unknown>>(async () => ({ result: [] })) }));
vi.mock('btch-downloader', () => ({ igdl: ig.igdl }));

import { POST } from './route';

const mockLookup = vi.mocked(lookup);
const PUBLIC_IP = '93.184.216.34';

const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', fetchMock);

const tikwmOk = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function post(url: unknown): NextRequest {
  return new NextRequest('http://localhost/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}
const fetchedUrls = () => fetchMock.mock.calls.map(c => String(c[0]));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => { throw new Error('unexpected fetch in test'); });
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }] as never);
  auth.requireUser.mockClear();
  auth.requireUser.mockResolvedValue({ id: 'u1', email: 't@example.com' });
  gates.rateLimit.mockClear();
  gates.rateLimit.mockResolvedValue(true);
  ig.igdl.mockClear();
});

describe('download — auth gate', () => {
  it('rejects unauthenticated callers with 401 before touching anything else', async () => {
    auth.requireUser.mockResolvedValueOnce(null);
    const res = await POST(post('https://www.tiktok.com/@u/video/1'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(auth.requireUser).toHaveBeenCalledTimes(1);
    // Nothing downstream runs for anonymous callers: no rate-limit spend, no fetch, no downloader.
    expect(gates.rateLimit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ig.igdl).not.toHaveBeenCalled();
  });

  it('rate-limits per authenticated user id and 429s before any fetch', async () => {
    gates.rateLimit.mockResolvedValueOnce(false);
    const res = await POST(post('https://www.tiktok.com/@u/video/1'));
    expect(res.status).toBe(429);
    expect(gates.rateLimit).toHaveBeenCalledWith('download:u1', 60);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('download — body validation', () => {
  it('400s when url is missing', async () => {
    const res = await POST(new NextRequest('http://localhost/api/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'url is required' });
  });

  it('400s when url exceeds the 2000-char cap', async () => {
    const res = await POST(post('https://www.tiktok.com/' + 'a'.repeat(2000)));
    expect(res.status).toBe(400);
  });
});

describe('download — hostOf/hostMatches anti-masquerade (classified by parsed hostname, not substring)', () => {
  it.each([
    'https://tiktok.com.evil.com/@u/video/1',   // allowlisted name as subdomain of attacker domain
    'https://tiktok.com@evil.com/@u/video/1',   // userinfo trick — WHATWG hostname is evil.com
    'https://vm.tiktok.com@evil.com/abc',       // userinfo trick on the short-link host
    'https://eviltiktok.com/@u/video/1',        // suffix without the dot
    'https://evil.com/?u=https://tiktok.com/@u/video/1', // allowlisted name only in the query
    'https://evil.com/tiktok.com/@u/video/1',   // allowlisted name only in the path
    'https://169.254.169.254/?x=tiktok.com',    // internal IP with a decoy query
    'https://instagram.com.evil.com/reel/abc',
    'https://instagram.com@evil.com/reel/abc',
    'https://x.com.evil.com/u/status/123',
    'https://x.com@evil.com/u/status/123',
    'https://twitter.com.evil.com/u/status/123',
  ])('%s is rejected as unsupported and NEVER fetched', async (url) => {
    const res = await POST(post(url));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/Unsupported URL/);
    // The security invariant: the masquerading URL reaches no fetch and no downloader library.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ig.igdl).not.toHaveBeenCalled();
  });
});

describe('download — TikTok path (user URL travels as DATA to tikwm, never fetched directly)', () => {
  it('control: a real tiktok.com URL goes ONLY to the hardcoded tikwm API, form-encoded', async () => {
    fetchMock.mockResolvedValueOnce(tikwmOk({ play: 'https://cdn.tikwm.com/v.mp4' }));
    const res = await POST(post('https://www.tiktok.com/@user/video/123'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ play: 'https://cdn.tikwm.com/v.mp4' });
    expect(fetchedUrls()).toEqual(['https://www.tikwm.com/api/']);
    const body = new URLSearchParams(String(fetchMock.mock.calls[0][1]!.body));
    expect(body.get('url')).toBe('https://www.tiktok.com/@user/video/123');
    expect(body.get('hd')).toBe('1');
  });

  it('maps a tikwm error payload to a 400, not a data passthrough', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: -1, msg: 'Video not found' }), { status: 200 }));
    const res = await POST(post('https://www.tiktok.com/@user/video/123'));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/private, deleted, or invalid/);
  });

  it('vm.tiktok.com short link resolving to a PRIVATE address is not fetched (SSRF guard in resolveShortUrl)', async () => {
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never);
    fetchMock.mockResolvedValueOnce(tikwmOk({ play: 'x' }));
    const res = await POST(post('https://vm.tiktok.com/ZM123/'));
    expect(res.status).toBe(200);
    // The rebinding short link never gets a direct fetch; it is forwarded UNRESOLVED as form data only.
    expect(fetchedUrls()).toEqual(['https://www.tikwm.com/api/']);
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]!.body)).get('url')).toBe('https://vm.tiktok.com/ZM123/');
    expect(mockLookup).toHaveBeenCalledWith('vm.tiktok.com', { all: true });
  });

  it('vm.tiktok.com resolving PUBLIC is fetched with redirect:manual and its Location forwarded as data', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://www.tiktok.com/@u/video/9' } }))
      .mockResolvedValueOnce(tikwmOk({ play: 'x' }));
    const res = await POST(post('https://vm.tiktok.com/ZM123/'));
    expect(res.status).toBe(200);
    expect(fetchedUrls()).toEqual(['https://vm.tiktok.com/ZM123/', 'https://www.tikwm.com/api/']);
    // Manual redirects: the resolver must never auto-follow the short link to an arbitrary target.
    expect(fetchMock.mock.calls[0][1]!.redirect).toBe('manual');
    expect(new URLSearchParams(String(fetchMock.mock.calls[1][1]!.body)).get('url')).toBe('https://www.tiktok.com/@u/video/9');
  });
});

describe('download — Instagram path', () => {
  it('control: a real instagram.com URL goes to igdl (library), with no direct fetch of the URL', async () => {
    ig.igdl.mockResolvedValueOnce({ result: [{ url: 'https://cdn.example/r.mp4', thumbnail: 'https://cdn.example/t.jpg' }] });
    const res = await POST(post('https://www.instagram.com/reel/ABC123/'));
    expect(res.status).toBe(200);
    const json = await res.json() as { play: string; cover: string };
    expect(json.play).toBe('https://cdn.example/r.mp4');
    expect(json.cover).toBe('https://cdn.example/t.jpg');
    expect(ig.igdl).toHaveBeenCalledWith('https://www.instagram.com/reel/ABC123/');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('download — everything else', () => {
  it('an unrelated host is unsupported', async () => {
    const res = await POST(post('https://youtube.com/watch?v=1'));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
