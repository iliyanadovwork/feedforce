import { timingSafeEqual } from 'node:crypto';

// Shared CRON_SECRET gate for the cron routes (/api/cron/*). Accepts the secret as an
// `Authorization: Bearer …` header (what Vercel Cron sends when CRON_SECRET is set) OR as a
// `?secret=` query param — the param is kept ONLY for compatibility with schedulers already
// configured to pass it in the URL; new callers should use the header (URLs leak into logs).
// Both comparisons are constant-time (same pattern as verifyRenderToken in lib/renderToken.ts)
// so the secret can't be recovered byte-by-byte from response timing.

function safeEqual(expected: string, got: string): boolean {
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(got);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  if (safeEqual(`Bearer ${secret}`, header)) return true;
  const param = new URL(req.url).searchParams.get('secret') ?? '';
  return param !== '' && safeEqual(secret, param);
}
