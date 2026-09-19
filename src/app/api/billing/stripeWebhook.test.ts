import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import type { StripeSubscription } from '@/lib/stripe';

// The REAL Stripe webhook route handler, called with genuinely HMAC-signed Requests. Signature
// verification is the real implementation (only STRIPE_WEBHOOK_SECRET env is set); the Stripe REST
// fetchers, the supabase admin client, Discord and the affiliate helpers are mocked. These tests pin
// the MONEY INVARIANTS declared in CLAUDE.md:
//   - a DB error during handling must 500 (Stripe retries); a swallowed error 200s and silently
//     loses money — several tests here fail if anyone adds a catch-all that returns 200,
//   - the single deliberate carve-out: upsert error 23502 (unattributable subscription, no user_id)
//     → 200-ignore so Stripe stops retrying,
//   - a bad signature must do NOTHING (no DB write, no Stripe fetch, no affiliate call),
//   - STATUS_MAP + renews_at/ends_at derivation writes the exact row grantsAccess reads,
//   - the ordering guard: the row is written from the subscription's CURRENT state
//     (retrieveSubscription), so a late stale "active" event cannot resurrect a deleted sub,
//   - duplicate delivery is an idempotent upsert keyed on stripe_subscription_id.

const h = vi.hoisted(() => ({
  upsert: vi.fn(),
  from: vi.fn(),
  retrieveSubscription: vi.fn(),
  retrieveCharge: vi.fn(),
  reportError: vi.fn(),
  notifyNewSubscription: vi.fn(),
  notifyCancellation: vi.fn(),
  notifyPaymentFailed: vi.fn(),
  recordReferralFromCheckout: vi.fn(),
  recordCommissionFromInvoice: vi.fn(),
  reverseCommissionForInvoice: vi.fn(),
  reinstateDisputedCommission: vi.fn(),
}));

// Keep the REAL verifyStripeWebhookSignature (that's part of the behavior under test) and the real
// types; replace only the network fetchers the ordering guard / dispute mapping use.
vi.mock('@/lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stripe')>()),
  retrieveSubscription: h.retrieveSubscription,
  retrieveCharge: h.retrieveCharge,
}));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: () => ({ from: h.from }) }));
vi.mock('@/lib/reportError', () => ({ reportError: h.reportError }));
vi.mock('@/lib/discord', () => ({
  notifyNewSubscription: h.notifyNewSubscription,
  notifyCancellation: h.notifyCancellation,
  notifyPaymentFailed: h.notifyPaymentFailed,
}));
vi.mock('@/lib/affiliates', () => ({
  recordReferralFromCheckout: h.recordReferralFromCheckout,
  recordCommissionFromInvoice: h.recordCommissionFromInvoice,
  reverseCommissionForInvoice: h.reverseCommissionForInvoice,
  reinstateDisputedCommission: h.reinstateDisputedCommission,
}));

import { POST } from '@/app/api/billing/stripe-webhook/route';

const SECRET = 'whsec_test_secret';
const URL_ = 'http://t/api/billing/stripe-webhook';

function sign(body: string, ts = Math.floor(Date.now() / 1000), secret = SECRET): string {
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
  return `t=${ts},v1=${sig}`;
}
const signedRaw = (body: string, header: string | null = sign(body)): Request =>
  new Request(URL_, { method: 'POST', headers: header === null ? {} : { 'stripe-signature': header }, body });
const signed = (event: unknown): Request => signedRaw(JSON.stringify(event));

const PERIOD_END = 1_760_000_000; // arbitrary fixed unix seconds
const iso = (unix: number) => new Date(unix * 1000).toISOString();

function subFixture(over: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: 'sub_123',
    customer: 'cus_123',
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: PERIOD_END,
    items: { data: [{ price: { id: 'price_123', nickname: 'Pro Monthly' } }] },
    metadata: { user_id: 'user-uuid-1' },
    ...over,
  };
}

/** Deliver a signed customer.subscription.* event. `fresh` is what retrieveSubscription (the
 *  ordering guard) reports as the subscription's CURRENT state — defaults to the event snapshot. */
async function deliverSub(
  type: string,
  eventSub: StripeSubscription,
  opts: { fresh?: StripeSubscription | 'api-down'; prev?: Record<string, unknown> } = {},
): Promise<Response> {
  if (opts.fresh === 'api-down') h.retrieveSubscription.mockRejectedValueOnce(new Error('stripe api down'));
  else h.retrieveSubscription.mockResolvedValueOnce(opts.fresh ?? eventSub);
  return POST(signed({ id: 'evt_1', type, data: { object: eventSub, ...(opts.prev ? { previous_attributes: opts.prev } : {}) } }));
}

function lastUpsert(): { record: Record<string, unknown>; options: { onConflict?: string } } {
  const call = h.upsert.mock.calls.at(-1);
  if (!call) throw new Error('no subscriptions upsert was recorded');
  return { record: call[0] as Record<string, unknown>, options: call[1] as { onConflict?: string } };
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.from.mockReturnValue({ upsert: h.upsert });
  h.upsert.mockResolvedValue({ error: null });
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});
afterEach(() => { delete process.env.STRIPE_WEBHOOK_SECRET; });

describe('signature & payload validation', () => {
  const event = { id: 'evt_1', type: 'customer.subscription.updated', data: { object: subFixture() } };

  it('rejects a forged signature with 401 and performs NO work (no DB write, no Stripe fetch, no affiliate call)', async () => {
    const body = JSON.stringify(event);
    const res = await POST(signedRaw(body, sign(body, undefined, 'whsec_wrong')));
    expect(res.status).toBe(401);
    expect(h.from).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.retrieveSubscription).not.toHaveBeenCalled();
    expect(h.recordReferralFromCheckout).not.toHaveBeenCalled();
    expect(h.recordCommissionFromInvoice).not.toHaveBeenCalled();
  });

  it('rejects a missing signature header with 401 and no DB writes', async () => {
    const res = await POST(signedRaw(JSON.stringify(event), null));
    expect(res.status).toBe(401);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('rejects a validly signed but non-JSON body with 400', async () => {
    const res = await POST(signedRaw('this is not json'));
    expect(res.status).toBe(400);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('rejects a subscription event whose object has no id with 400, writing nothing', async () => {
    const res = await POST(signed({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: {} } }));
    expect(res.status).toBe(400);
    expect(h.retrieveSubscription).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('200-ignores an unhandled event type without touching the subscriptions table', async () => {
    const res = await POST(signed({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: 'payment_intent.succeeded' });
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe('subscription lifecycle → subscriptions row (STATUS_MAP / renews_at / ends_at)', () => {
  it('active: writes the full row, upserted on stripe_subscription_id', async () => {
    const res = await deliverSub('customer.subscription.updated', subFixture());
    expect(res.status).toBe(200);
    const { record, options } = lastUpsert();
    expect(options).toEqual({ onConflict: 'stripe_subscription_id' });
    expect(record).toMatchObject({
      provider: 'stripe',
      stripe_subscription_id: 'sub_123',
      stripe_customer_id: 'cus_123',
      stripe_price_id: 'price_123',
      status: 'active',
      plan_name: 'Pro Monthly',
      renews_at: iso(PERIOD_END),
      ends_at: null,
      trial_ends_at: null,
      user_id: 'user-uuid-1',
    });
    expect(typeof record.updated_at).toBe('string');
  });

  it('trialing: maps to on_trial with trial_ends_at; missing price nickname falls back to plan "Pro"', async () => {
    const trialEnd = PERIOD_END - 86_400;
    await deliverSub('customer.subscription.updated', subFixture({
      status: 'trialing',
      trial_end: trialEnd,
      items: { data: [{ price: { id: 'price_123', nickname: null } }] },
    }));
    expect(lastUpsert().record).toMatchObject({
      status: 'on_trial',
      trial_ends_at: iso(trialEnd),
      plan_name: 'Pro',
      renews_at: iso(PERIOD_END),
      ends_at: null,
    });
  });

  it('past_due keeps renews_at, reading the item-level current_period_end (Basil API location)', async () => {
    await deliverSub('customer.subscription.updated', subFixture({
      status: 'past_due',
      current_period_end: null, // Basil moved it onto the item
      items: { data: [{ current_period_end: PERIOD_END, price: { id: 'price_123', nickname: 'Pro Monthly' } }] },
    }));
    expect(lastUpsert().record).toMatchObject({ status: 'past_due', renews_at: iso(PERIOD_END), ends_at: null });
  });

  it('scheduled cancel (cancel_at_period_end): still active but renews_at null, ends_at = cancel_at', async () => {
    const cancelAt = PERIOD_END + 1000;
    await deliverSub('customer.subscription.updated',
      subFixture({ cancel_at_period_end: true, cancel_at: cancelAt }),
      { prev: { cancel_at_period_end: false } });
    expect(lastUpsert().record).toMatchObject({ status: 'active', renews_at: null, ends_at: iso(cancelAt) });
  });

  it('deleted: cancelled with ends_at = ended_at and no renews_at', async () => {
    const endedAt = PERIOD_END - 500;
    await deliverSub('customer.subscription.deleted', subFixture({ status: 'canceled', ended_at: endedAt }));
    expect(lastUpsert().record).toMatchObject({ status: 'cancelled', renews_at: null, ends_at: iso(endedAt) });
  });

  it('canceled without ended_at: ends_at falls back to the period end', async () => {
    await deliverSub('customer.subscription.deleted', subFixture({ status: 'canceled', ended_at: null }));
    expect(lastUpsert().record).toMatchObject({ status: 'cancelled', renews_at: null, ends_at: iso(PERIOD_END) });
  });

  it('missing metadata.user_id: the record omits the user_id key entirely (upsert must not clobber it to null)', async () => {
    await deliverSub('customer.subscription.updated', subFixture({ metadata: {} }));
    expect(lastUpsert().record).not.toHaveProperty('user_id');
  });
});

describe('ordering guard — the row reflects the subscription\'s CURRENT state, not the event snapshot', () => {
  it('a late stale "active" event cannot resurrect a deleted subscription', async () => {
    const staleActive = subFixture(); // the retried/late event still says active
    const currentlyCanceled = subFixture({ status: 'canceled', ended_at: PERIOD_END - 100 });
    const res = await deliverSub('customer.subscription.updated', staleActive, { fresh: currentlyCanceled });
    expect(res.status).toBe(200);
    expect(h.retrieveSubscription).toHaveBeenCalledWith('sub_123');
    expect(lastUpsert().record).toMatchObject({ status: 'cancelled', renews_at: null, ends_at: iso(PERIOD_END - 100) });
    // and the stale snapshot must not fire a "new customer" style notification either
    expect(h.notifyNewSubscription).not.toHaveBeenCalled();
  });

  it('when the Stripe API is down, falls back to the event snapshot (200, row still written, error reported)', async () => {
    const res = await deliverSub('customer.subscription.deleted', subFixture({ status: 'canceled', ended_at: PERIOD_END }), { fresh: 'api-down' });
    expect(res.status).toBe(200);
    expect(lastUpsert().record).toMatchObject({ status: 'cancelled', ends_at: iso(PERIOD_END) });
    expect(h.reportError).toHaveBeenCalledWith(expect.stringContaining('retrieve failed'), expect.anything(), expect.anything());
  });
});

describe('DB failure handling — the money invariant', () => {
  it('a subscriptions upsert error → 500 (Stripe retries) and the error is reported, not swallowed', async () => {
    h.upsert.mockResolvedValueOnce({ error: { code: '08006', message: 'connection failure' } });
    const res = await deliverSub('customer.subscription.created', subFixture());
    expect(res.status).toBe(500);
    expect(h.reportError).toHaveBeenCalledWith('stripe-webhook subscriptions upsert', expect.objectContaining({ code: '08006' }));
    // the failed write must short-circuit the notification block too
    expect(h.notifyNewSubscription).not.toHaveBeenCalled();
  });

  it('the ONE carve-out: upsert error 23502 (unattributable sub, no user_id) → 200-ignore so Stripe stops retrying', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.upsert.mockResolvedValueOnce({ error: { code: '23502', message: 'null value in column "user_id"' } });
      const res = await deliverSub('customer.subscription.created', subFixture({ metadata: {} }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, ignored: 'no_user_id' });
    } finally { warn.mockRestore(); }
  });

  it('a throwing commission recorder (invoice.payment_succeeded) → 500, never a swallowed 200', async () => {
    h.recordCommissionFromInvoice.mockRejectedValueOnce(new Error('insert failed'));
    const res = await POST(signed({ id: 'evt_1', type: 'invoice.payment_succeeded', data: { object: { id: 'in_1', amount_paid: 1900 } } }));
    expect(res.status).toBe(500);
    expect(h.reportError).toHaveBeenCalled();
  });

  it('a throwing referral recorder (checkout.session.completed) → 500', async () => {
    h.recordReferralFromCheckout.mockRejectedValueOnce(new Error('insert failed'));
    const res = await POST(signed({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } }));
    expect(res.status).toBe(500);
  });
});

describe('affiliate event routing', () => {
  it('checkout.session.completed → recordReferralFromCheckout(db, session); no subscriptions write', async () => {
    const session = { id: 'cs_1', mode: 'subscription', subscription: 'sub_123', client_reference_id: 'user-uuid-1' };
    const res = await POST(signed({ id: 'evt_1', type: 'checkout.session.completed', data: { object: session } }));
    expect(res.status).toBe(200);
    expect(h.recordReferralFromCheckout).toHaveBeenCalledWith(expect.objectContaining({ from: h.from }), session);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('invoice.payment_succeeded → recordCommissionFromInvoice(db, invoice)', async () => {
    const invoice = { id: 'in_1', amount_paid: 1900, currency: 'usd', subscription: 'sub_123' };
    const res = await POST(signed({ id: 'evt_1', type: 'invoice.payment_succeeded', data: { object: invoice } }));
    expect(res.status).toBe(200);
    expect(h.recordCommissionFromInvoice).toHaveBeenCalledWith(expect.anything(), invoice);
  });

  it('charge.refunded: a FULL refund reverses the commission for that invoice', async () => {
    const res = await POST(signed({ id: 'evt_1', type: 'charge.refunded', data: { object: { id: 'ch_1', invoice: 'in_1', refunded: true, amount_refunded: 1900 } } }));
    expect(res.status).toBe(200);
    expect(h.reverseCommissionForInvoice).toHaveBeenCalledWith(expect.anything(), 'in_1', 'refund');
  });

  it('charge.refunded: a PARTIAL refund does NOT reverse (refunded=false), still 200', async () => {
    const res = await POST(signed({ id: 'evt_1', type: 'charge.refunded', data: { object: { id: 'ch_1', invoice: 'in_1', refunded: false, amount_refunded: 500 } } }));
    expect(res.status).toBe(200);
    expect(h.reverseCommissionForInvoice).not.toHaveBeenCalled();
  });

  it('charge.dispute.created → maps the charge to its invoice via retrieveCharge, then reverses', async () => {
    h.retrieveCharge.mockResolvedValueOnce({ id: 'ch_1', invoice: 'in_1' });
    const res = await POST(signed({ id: 'evt_1', type: 'charge.dispute.created', data: { object: { id: 'dp_1', charge: 'ch_1', status: 'needs_response' } } }));
    expect(res.status).toBe(200);
    expect(h.retrieveCharge).toHaveBeenCalledWith('ch_1');
    expect(h.reverseCommissionForInvoice).toHaveBeenCalledWith(expect.anything(), 'in_1', 'dispute');
  });

  it('charge.dispute.closed: WON reinstates the commission; LOST does not', async () => {
    h.retrieveCharge.mockResolvedValue({ id: 'ch_1', invoice: 'in_1' });
    await POST(signed({ id: 'evt_1', type: 'charge.dispute.closed', data: { object: { id: 'dp_1', charge: 'ch_1', status: 'won' } } }));
    expect(h.reinstateDisputedCommission).toHaveBeenCalledWith(expect.anything(), 'in_1');
    h.reinstateDisputedCommission.mockClear();
    await POST(signed({ id: 'evt_2', type: 'charge.dispute.closed', data: { object: { id: 'dp_2', charge: 'ch_1', status: 'lost' } } }));
    expect(h.reinstateDisputedCommission).not.toHaveBeenCalled();
  });
});

describe('idempotency — duplicate delivery', () => {
  it('the same subscription event delivered twice performs two IDENTICAL upserts keyed on stripe_subscription_id (no duplicate rows, no drift)', async () => {
    const sub = subFixture();
    h.retrieveSubscription.mockResolvedValue(sub);
    const event = { id: 'evt_dup', type: 'customer.subscription.updated', data: { object: sub } };
    const r1 = await POST(signed(event));
    const r2 = await POST(signed(event));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(h.upsert).toHaveBeenCalledTimes(2);
    const strip = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'updated_at'));
    const [[rec1, opts1], [rec2, opts2]] = h.upsert.mock.calls as Array<[Record<string, unknown>, { onConflict?: string }]>;
    expect(opts1).toEqual({ onConflict: 'stripe_subscription_id' });
    expect(opts2).toEqual({ onConflict: 'stripe_subscription_id' });
    expect(strip(rec2)).toEqual(strip(rec1)); // second delivery converges on the same row → no double-grant
  });
});

describe('discord notifications (transition-based, judged from the EVENT snapshot)', () => {
  it('created + active → new-subscription alert', async () => {
    const sub = subFixture();
    await deliverSub('customer.subscription.created', sub);
    expect(h.notifyNewSubscription).toHaveBeenCalledWith(sub);
    expect(h.notifyCancellation).not.toHaveBeenCalled();
  });

  it('updated incomplete → active (3-D Secure cleared) → new-subscription alert', async () => {
    await deliverSub('customer.subscription.updated', subFixture(), { prev: { status: 'incomplete' } });
    expect(h.notifyNewSubscription).toHaveBeenCalledTimes(1);
  });

  it('a plain renewal update fires NO notification', async () => {
    await deliverSub('customer.subscription.updated', subFixture(), { prev: { current_period_end: PERIOD_END - 2_592_000 } });
    expect(h.notifyNewSubscription).not.toHaveBeenCalled();
    expect(h.notifyCancellation).not.toHaveBeenCalled();
  });

  it('cancel_at_period_end flipping false → true → scheduled-cancellation alert', async () => {
    const sub = subFixture({ cancel_at_period_end: true, cancel_at: PERIOD_END });
    await deliverSub('customer.subscription.updated', sub, { prev: { cancel_at_period_end: false } });
    expect(h.notifyCancellation).toHaveBeenCalledWith(sub, true);
  });

  it('deleted → final-cancellation alert', async () => {
    const sub = subFixture({ status: 'canceled', ended_at: PERIOD_END });
    await deliverSub('customer.subscription.deleted', sub);
    expect(h.notifyCancellation).toHaveBeenCalledWith(sub, false);
  });

  it('invoice.payment_failed → payment-failed alert only, no subscriptions write', async () => {
    const invoice = { id: 'in_9', amount_due: 1900, currency: 'usd', customer: 'cus_123' };
    const res = await POST(signed({ id: 'evt_1', type: 'invoice.payment_failed', data: { object: invoice } }));
    expect(res.status).toBe(200);
    expect(h.notifyPaymentFailed).toHaveBeenCalledWith(invoice);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});
