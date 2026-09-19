import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { verifyStripeWebhookSignature } from './stripe';

// Hand-rolled webhook verification (no Stripe SDK) — a regression either lets forged webhooks write
// subscription rows (grant access without paying) or rejects real ones (paid users stay locked out).

const SECRET = 'whsec_test_secret';

function sign(body: string, timestamp: number, secret = SECRET): string {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

describe('verifyStripeWebhookSignature', () => {
  beforeEach(() => { process.env.STRIPE_WEBHOOK_SECRET = SECRET; });
  afterEach(() => { delete process.env.STRIPE_WEBHOOK_SECRET; });

  const body = '{"type":"customer.subscription.updated"}';
  const now = () => Math.floor(Date.now() / 1000);

  it('accepts a correctly signed, fresh payload', () => {
    expect(verifyStripeWebhookSignature(body, sign(body, now()))).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifyStripeWebhookSignature(body, sign(body, now(), 'whsec_wrong'))).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifyStripeWebhookSignature(body.replace('updated', 'created'), sign(body, now()))).toBe(false);
  });

  it('rejects a stale timestamp (replay protection, 5 min tolerance)', () => {
    expect(verifyStripeWebhookSignature(body, sign(body, now() - 600))).toBe(false);
  });

  it('accepts when any v1 signature matches (Stripe sends several during secret rolls)', () => {
    const t = now();
    const good = sign(body, t).split(',')[1]; // "v1=<hex>"
    expect(verifyStripeWebhookSignature(body, `t=${t},v1=${'0'.repeat(64)},${good}`)).toBe(true);
  });

  it('rejects missing header or unset secret', () => {
    expect(verifyStripeWebhookSignature(body, null)).toBe(false);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(verifyStripeWebhookSignature(body, sign(body, now()))).toBe(false);
  });
});
