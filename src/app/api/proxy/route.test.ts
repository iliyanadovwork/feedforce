import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// SSRF wiring tests for the media proxy. The REAL isAllowedHost + isSafePublicUrl run — only DNS is
// mocked (deterministic, offline) and global fetch is scripted so we can stage redirect chains. The
// IP/host classification LIBRARY is covered in src/lib/http.test.ts; this file pins the ROUTE wiring a
// past real SSRF exploited: redirects that used to bypass validation because the upstream fetch
// auto-followed Location. The core invariant asserted throughout: which URLs fetch() was ACTUALLY
// called with — an internal/disallowed target must never appear there.

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
import { lookup } from 'node:dns/promises';

const gates = vi.hoisted(() => ({ rateLimit: vi.fn<(key: string, limit: number) => Promise<boolean>>(async () => true) }));
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: gates.rateLimit,
  tooManyRequests: () => new Response(JSON.stringify({ error: 'rate' }), { status: 429 }),
}));
vi.mock('@/lib/reportError', () => ({ reportError: vi.fn() }));

import { GET } from './route';

const mockLookup = vi.mocked(lookup);
const PUBLIC_IP = '93.184.216.34';
// Default DNS: every hostname resolves public. Individual tests override per-host to stage rebinding.
const dnsAllPublic = () =>
  mockLookup.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }] as never);

const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', fetchMock);

const redirect302 = (to: string) => new Response(null, { status: 302, headers: { location: to } });
const upstream200 = () =>
  new Response('video-bytes', { status: 200, headers: { 'Content-Type': 'video/mp4' } });

function req(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/proxy?url=' + encodeURIComponent(url), { headers });
}
const fetchedUrls = () => fetchMock.mock.calls.map(c => String(c[0]));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => { throw new Error('unexpected fetch in test'); });
  mockLookup.mockReset();
  dnsAllPublic();
  gates.rateLimit.mockClear();
  gates.rateLimit.mockResolvedValue(true);
});

describe('proxy — first-hop validation', () => {
  it.each([
    'https://evil-tiktokcdn.com/v.mp4',        // dash suffix: endsWith('tiktokcdn.com') but NOT '.tiktokcdn.com'
    'https://tikwm.com.evil.com/v.mp4',        // allowlisted name as a SUBDOMAIN of an attacker domain
    'https://tikwm.com@evil.com/v.mp4',        // userinfo trick — WHATWG hostname is evil.com
    'http://169.254.169.254/latest/meta-data/',// cloud metadata IP directly
    'http://localhost:3000/api/cron',          // internal service directly
    'https://example.com/v.mp4',               // plain non-allowlisted host
  ])('rejects %s with 403 and never fetches it', async (url) => {
    const res = await GET(req(url));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'URL not allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs the DNS SSRF guard on the FIRST hop too: allowlisted name resolving private is refused', async () => {
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never);
    const res = await GET(req('https://tikwm.com/v.mp4'));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400s when url param is missing', async () => {
    const res = await GET(new NextRequest('http://localhost/api/proxy'));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('control: an allowlisted public host IS fetched and proxied through', async () => {
    fetchMock.mockResolvedValueOnce(upstream200());
    const res = await GET(req('https://tikwm.com/v.mp4'));
    expect(res.status).toBe(200);
    expect(fetchedUrls()).toEqual(['https://tikwm.com/v.mp4']);
    // TikTok referer spoof + manual redirects are part of the request the route actually sends.
    const init = fetchMock.mock.calls[0][1]!;
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>)['Referer']).toBe('https://www.tiktok.com/');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="tiktok-download"');
    expect(await res.text()).toBe('video-bytes');
  });

  it('control: a dot-subdomain of an allowlisted host is allowed (so the dash-suffix rejection has teeth)', async () => {
    fetchMock.mockResolvedValueOnce(upstream200());
    const res = await GET(req('https://sub.tiktokcdn.com/v.mp4'));
    expect(res.status).toBe(200);
    expect(fetchedUrls()).toEqual(['https://sub.tiktokcdn.com/v.mp4']);
  });
});

describe('proxy — per-hop redirect revalidation (the exploited SSRF)', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://localhost:3000/api/internal',
    'http://127.0.0.1:8080/admin',
    'http://10.0.0.5/secret',
  ])('allowed host 302 -> %s: refused, internal target NEVER fetched', async (internal) => {
    fetchMock.mockResolvedValueOnce(redirect302(internal));
    const res = await GET(req('https://tikwm.com/v.mp4'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Redirect target not allowed' });
    // The security invariant: only the first (allowed) hop was fetched; the internal URL never was.
    expect(fetchedUrls()).toEqual(['https://tikwm.com/v.mp4']);
    expect(fetchedUrls()).not.toContain(internal);
  });

  it('redirect to an allowed-SUFFIX host that DNS-resolves private is refused (rebinding on a hop)', async () => {
    // Passes the allowlist (endsWith .tiktokcdn.com) — only the per-hop isSafePublicUrl call catches it.
    mockLookup.mockImplementation(async (host: unknown) =>
      [{ address: host === 'evil.tiktokcdn.com' ? '10.0.0.1' : PUBLIC_IP, family: 4 }] as never);
    fetchMock.mockResolvedValueOnce(redirect302('https://evil.tiktokcdn.com/x'));
    const res = await GET(req('https://tikwm.com/v.mp4'));
    expect(res.status).toBe(403);
    expect(fetchedUrls()).toEqual(['https://tikwm.com/v.mp4']);
  });

  it('redirect to a PUBLIC but non-allowlisted host is refused (allowlist re-checked per hop)', async () => {
    fetchMock.mockResolvedValueOnce(redirect302('https://example.com/v.mp4'));
    const res = await GET(req('https://tikwm.com/v.mp4'));
    expect(res.status).toBe(403);
    expect(fetchedUrls()).toEqual(['https://tikwm.com/v.mp4']);
  });

  it('follows a legitimate RELATIVE redirect, resolved against the current URL, with manual redirects on every hop', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect302('/hd/v.mp4'))
      .mockResolvedValueOnce(upstream200());
    const res = await GET(req('https://tikwm.com/v.mp4'));
    expect(res.status).toBe(200);
    expect(fetchedUrls()).toEqual(['https://tikwm.com/v.mp4', 'https://tikwm.com/hd/v.mp4']);
    expect(fetchMock.mock.calls.every(c => c[1]?.redirect === 'manual')).toBe(true);
  });

  it('follows a legitimate cross-host redirect between two allowlisted public hosts', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect302('https://d.rapidcdn.app/file.mp4'))
      .mockResolvedValueOnce(upstream200());
    const res = await GET(req('https://tikwm.com/v.mp4'));
    expect(res.status).toBe(200);
    expect(fetchedUrls()).toEqual(['https://tikwm.com/v.mp4', 'https://d.rapidcdn.app/file.mp4']);
  });
});

describe('proxy — redirect depth cap', () => {
  it('an endless redirect chain terminates with an error after 5 hops, not a loop', async () => {
    fetchMock.mockImplementation(async () => redirect302('https://tikwm.com/loop'));
    const res = await GET(req('https://tikwm.com/v.mp4'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Failed to fetch file' });
    // 1 initial fetch + at most 5 revalidated hops — the cap is the only thing stopping this chain.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('a redirect status with no Location header stops the chain with an error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));
    const res = await GET(req('https://tikwm.com/v.mp4'));
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('proxy — gate (no auth by design: <video> cannot send headers; IP rate limit instead)', () => {
  it('keys the limit on the first x-forwarded-for hop', async () => {
    fetchMock.mockResolvedValueOnce(upstream200());
    await GET(req('https://tikwm.com/v.mp4', { 'x-forwarded-for': '203.0.113.9, 198.51.100.4' }));
    expect(gates.rateLimit).toHaveBeenCalledWith('proxy:203.0.113.9', 60);
  });

  it("falls back to 'unknown' with no forwarding header", async () => {
    fetchMock.mockResolvedValueOnce(upstream200());
    await GET(req('https://tikwm.com/v.mp4'));
    expect(gates.rateLimit).toHaveBeenCalledWith('proxy:unknown', 60);
  });

  it('429 short-circuits before any validation or upstream fetch', async () => {
    gates.rateLimit.mockResolvedValueOnce(false);
    const res = await GET(req('https://tikwm.com/v.mp4'));
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('serves an allowlisted request WITHOUT any Authorization header (endpoint is deliberately unauthenticated)', async () => {
    fetchMock.mockResolvedValueOnce(upstream200());
    const res = await GET(req('https://tikwm.com/v.mp4'));
    expect(res.status).toBe(200);
  });
});
