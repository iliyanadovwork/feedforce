import { createHmac, timingSafeEqual } from 'node:crypto';

// Short-lived HMAC tokens that let the headless render page fetch a post's slides WITHOUT a user
// session (the cron's browser has none). Signed with RENDER_TOKEN_SECRET; server-side only. A token
// grants read access to ONE post's render data until `expMs` — nothing else.

function secret(): string {
  // RENDER_TOKEN_SECRET splits the render-token key off the cron auth key (a leaked render token
  // must never double as cron access). The CRON_SECRET fallback keeps existing deploys working
  // until the new env var is set.
  const s = process.env.RENDER_TOKEN_SECRET || process.env.CRON_SECRET || '';
  if (!s) throw new Error('RENDER_TOKEN_SECRET (or CRON_SECRET) is not set');
  return s;
}

export function signRenderToken(postId: string, expMs: number): string {
  return createHmac('sha256', secret()).update(`render:${postId}:${expMs}`).digest('hex');
}

export function verifyRenderToken(postId: string, expMs: number, token: string): boolean {
  if (!postId || !token || !Number.isFinite(expMs) || Date.now() > expMs) return false;
  try {
    const expect = Buffer.from(signRenderToken(postId, expMs));
    const got = Buffer.from(token);
    return expect.length === got.length && timingSafeEqual(expect, got);
  } catch {
    return false;
  }
}
