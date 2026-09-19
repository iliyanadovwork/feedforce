import crypto from 'crypto';

// Server-only Stripe helpers. Like lib/lemonsqueezy.ts we talk to the REST API with plain fetch
// (form-encoded) so no SDK dependency is needed. Docs: https://docs.stripe.com/api
// Required env (see .env.example):
//   STRIPE_SECRET_KEY     — sk_live_/sk_test_ (or a restricted rk_ key with Checkout/Customers/
//                           Subscriptions/Billing Portal permissions)
//   STRIPE_PRICE_ID       — the recurring Price (price_...) of the subscription plan
//   STRIPE_WEBHOOK_SECRET — whsec_... from the webhook endpoint pointing at /api/billing/stripe-webhook

const API = 'https://api.stripe.com/v1';

function apiKey(): string {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new Error('STRIPE_SECRET_KEY is not set');
  return k;
}

/** POST a form-encoded body to the Stripe API and return the parsed JSON. Throws on non-2xx. */
async function stripePost<T>(path: string, params: Record<string, string>, opts?: { idempotencyKey?: string }): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Stripe replays the original response for ~24h on a reused key + identical params — the
      // standard guard against double-submits creating duplicate objects.
      ...(opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let message = detail;
    try { message = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? detail; } catch { /* raw */ }
    throw new Error(`Stripe ${path} failed (${res.status}): ${message}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Create a hosted Checkout Session for the subscription plan, tagged with our userId in metadata on
 * BOTH the session and the resulting subscription — the webhook maps every later lifecycle event back
 * to the Supabase user from subscription.metadata. Returns the URL to redirect the browser to.
 */
export async function createStripeCheckout(opts: {
  userId: string;
  email?: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const price = process.env.STRIPE_PRICE_ID;
  if (!price) throw new Error('STRIPE_PRICE_ID is not set');

  const params: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.userId,
    'metadata[user_id]': opts.userId,
    'subscription_data[metadata][user_id]': opts.userId,
    // Shows the "Add promotion code" field on the Stripe checkout page, so comp codes
    // (e.g. FREEMONTH — 100% off the first month) work without any app-side plumbing.
    allow_promotion_codes: 'true',
  };
  if (opts.email) params.customer_email = opts.email;

  // Idempotency: two rapid "Upgrade" clicks (or a retry after a slow response) must not mint two
  // independently-completable sessions — both stay payable for 24h and the webhook-backed no-stacking
  // guard can't see either until the first payment lands. Key = user + exact params + a 10-minute
  // bucket: the bucket keeps the key from pinning a COMPLETED/EXPIRED session's stored response for a
  // whole day (Stripe replays the original response for 24h per key) — a legitimate re-purchase later
  // the same day gets a fresh session, while click-bursts inside the window still dedupe.
  const bucket = Math.floor(Date.now() / 600_000);
  const idempotencyKey = `checkout:${opts.userId}:${bucket}:${crypto.createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16)}`;
  const session = await stripePost<{ url?: string }>('/checkout/sessions', params, { idempotencyKey });
  if (!session.url) throw new Error('Stripe checkout response missing url');
  return session.url;
}

/** Retrieve a subscription's CURRENT state. Deleted subscriptions stay retrievable (status
 *  'canceled'), which is what makes this the webhook ordering guard. */
export async function retrieveSubscription(id: string): Promise<StripeSubscription> {
  return stripeGet<StripeSubscription>(`/subscriptions/${id}`);
}

/** Create a Billing Portal session (manage/cancel/update card) for a customer. URLs are short-lived. */
export async function createStripePortalSession(customerId: string, returnUrl: string): Promise<string> {
  const session = await stripePost<{ url?: string }>('/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
  });
  if (!session.url) throw new Error('Stripe portal response missing url');
  return session.url;
}

/** GET a Stripe API path with query params and return the parsed JSON. Throws on non-2xx. */
async function stripeGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${path}${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let message = detail;
    try { message = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? detail; } catch { /* raw */ }
    throw new Error(`Stripe ${path} failed (${res.status}): ${message}`);
  }
  return res.json() as Promise<T>;
}

// ── First-month-free promo codes (admin-generated, single-use) ───────────────────────────────────
// One deterministic coupon (100% off, applies once) backs every code; each promotion code is capped
// at max_redemptions=1 so it dies after one checkout. Codes are entered on the Stripe checkout page
// (createStripeCheckout sets allow_promotion_codes).

const FREE_MONTH_COUPON_ID = 'first-month-free';

/** Find-or-create the shared "first month free" coupon (idempotent via a fixed coupon id). */
async function ensureFreeMonthCoupon(): Promise<string> {
  try {
    await stripeGet(`/coupons/${FREE_MONTH_COUPON_ID}`);
    return FREE_MONTH_COUPON_ID;
  } catch {
    await stripePost('/coupons', {
      id: FREE_MONTH_COUPON_ID,
      percent_off: '100',
      duration: 'once',
      name: 'First month free',
    });
    return FREE_MONTH_COUPON_ID;
  }
}

// Unambiguous alphabet (no 0/O, 1/I/L) — matches the redeem-code generator; typed by hand.
const PROMO_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function promoCode(): string {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += PROMO_ALPHABET[bytes[i] % PROMO_ALPHABET.length];
    if (i === 3) s += '-';
  }
  return `FREE-${s}`;
}

export interface StripePromoCode {
  code: string;
  active: boolean;
  created: number;         // unix seconds
  timesRedeemed: number;
  maxRedemptions: number | null;
}

/** Create `count` single-use first-month-free promotion codes; returns the code strings. */
export async function createFreeMonthPromoCodes(count: number): Promise<string[]> {
  const coupon = await ensureFreeMonthCoupon();
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = await stripePost<{ code: string }>('/promotion_codes', {
      coupon,
      code: promoCode(),
      max_redemptions: '1',
    });
    codes.push(p.code);
  }
  return codes;
}

/** List the first-month-free promotion codes (newest first, up to `limit`). */
export async function listFreeMonthPromoCodes(limit = 100): Promise<StripePromoCode[]> {
  let couponId: string;
  try { couponId = await ensureFreeMonthCoupon(); } catch { return []; }
  const res = await stripeGet<{ data?: Array<{ code: string; active: boolean; created: number; times_redeemed: number; max_redemptions: number | null }> }>(
    '/promotion_codes',
    { coupon: couponId, limit: String(Math.min(100, limit)) },
  );
  return (res.data ?? []).map(p => ({
    code: p.code,
    active: p.active,
    created: p.created,
    timesRedeemed: p.times_redeemed,
    maxRedemptions: p.max_redemptions,
  }));
}

// ── Launch offer (50% off the first month, one shareable code) ───────────────────────────────────
// Unlike the single-use codes above, this is ONE well-known promotion code with unlimited
// redemptions — share it anywhere and every new subscriber can enter it at Stripe checkout.
// The admin toggles it on/off at /admin; deactivating stops new redemptions instantly while
// customers who already redeemed keep their discount.

const LAUNCH_OFFER_COUPON_ID = 'first-month-50-off';
export const LAUNCH_OFFER_CODE = 'WELCOME50';
export const LAUNCH_OFFER_PERCENT_OFF = 50;

export interface LaunchOffer {
  code: string;
  active: boolean;
  timesRedeemed: number;
}

/** Find-or-create the shared "50% off first month" coupon (idempotent via a fixed coupon id). */
async function ensureLaunchOfferCoupon(): Promise<string> {
  try {
    await stripeGet(`/coupons/${LAUNCH_OFFER_COUPON_ID}`);
    return LAUNCH_OFFER_COUPON_ID;
  } catch {
    await stripePost('/coupons', {
      id: LAUNCH_OFFER_COUPON_ID,
      percent_off: String(LAUNCH_OFFER_PERCENT_OFF),
      duration: 'once',
      name: 'First month 50% off',
    });
    return LAUNCH_OFFER_COUPON_ID;
  }
}

interface StripePromotionCode { id: string; active: boolean; times_redeemed: number }

/** The WELCOME50 promotion code object, or null if it was never created. Code lookup is exact. */
async function findLaunchOfferPromo(): Promise<StripePromotionCode | null> {
  const res = await stripeGet<{ data?: StripePromotionCode[] }>('/promotion_codes', {
    code: LAUNCH_OFFER_CODE,
    limit: '1',
  });
  return res.data?.[0] ?? null;
}

/** Current state of the launch offer. "Never created" reads as inactive with zero redemptions. */
export async function getLaunchOffer(): Promise<LaunchOffer> {
  const promo = await findLaunchOfferPromo();
  return {
    code: LAUNCH_OFFER_CODE,
    active: promo?.active ?? false,
    timesRedeemed: promo?.times_redeemed ?? 0,
  };
}

/** Activate/deactivate the launch offer, lazily creating the coupon + promotion code on first use. */
export async function setLaunchOfferActive(active: boolean): Promise<LaunchOffer> {
  const existing = await findLaunchOfferPromo();
  if (!existing) {
    if (!active) return { code: LAUNCH_OFFER_CODE, active: false, timesRedeemed: 0 };
    const coupon = await ensureLaunchOfferCoupon();
    const promo = await stripePost<StripePromotionCode>('/promotion_codes', {
      coupon,
      code: LAUNCH_OFFER_CODE,
      // No max_redemptions — the code works for everyone until it's deactivated.
    });
    return { code: LAUNCH_OFFER_CODE, active: promo.active, timesRedeemed: promo.times_redeemed ?? 0 };
  }
  const promo = await stripePost<StripePromotionCode>(`/promotion_codes/${existing.id}`, {
    active: String(active),
  });
  return { code: LAUNCH_OFFER_CODE, active: promo.active, timesRedeemed: promo.times_redeemed ?? 0 };
}

// ── Affiliate promo codes ────────────────────────────────────────────────────────────────────────
// Each affiliate gets their own vanity promotion code (e.g. PRESSI50) with UNLIMITED redemptions,
// backed by a discount coupon for their (rate, duration) deal — one coupon object per distinct deal,
// reused by every affiliate on that deal — kept separate from the WELCOME50 launch offer so the two
// lifecycles don't affect each other.

const affiliateCouponId = (pct: number, months: number | null) =>
  `affiliate-${pct}-off-${months === null ? 'forever' : `${months}m`}`;

/** Stripe coupon duration params for a discount lasting `months` months, or forever if null.
 *  `months === 1` maps to Stripe's 'once' (functionally identical to 'repeating' for 1 month, and
 *  the more idiomatic choice) — everything else is 'repeating' with duration_in_months. */
function stripeDurationParams(months: number | null): Record<string, string> {
  if (months === null) return { duration: 'forever' };
  if (months === 1) return { duration: 'once' };
  return { duration: 'repeating', duration_in_months: String(months) };
}

/** Find-or-create the affiliate coupon for this (rate, duration) deal (idempotent via a
 *  deal-derived id). */
async function ensureAffiliateCoupon(pct: number, months: number | null): Promise<string> {
  const id = affiliateCouponId(pct, months);
  try {
    await stripeGet(`/coupons/${id}`);
    return id;
  } catch {
    await stripePost('/coupons', {
      id,
      percent_off: String(pct),
      ...stripeDurationParams(months),
      name: `Affiliate — ${pct}% off (${months === null ? 'forever' : `${months}mo`})`,
    });
    return id;
  }
}

/** Create an affiliate's promotion code (their vanity code, unlimited redemptions) against the
 *  coupon for their deal. Returns the Stripe ids to store on the affiliate row. Throws if the code is
 *  already taken in Stripe (surfaced to the admin as "code in use"). */
export async function createAffiliatePromoCode(code: string, discountPct: number, discountDurationMonths: number | null): Promise<{ promoCodeId: string; couponId: string }> {
  const couponId = await ensureAffiliateCoupon(discountPct, discountDurationMonths);
  const promo = await stripePost<{ id: string }>('/promotion_codes', { coupon: couponId, code });
  return { promoCodeId: promo.id, couponId };
}

/** Activate/deactivate an affiliate's promotion code (deactivating stops NEW redemptions at checkout;
 *  existing referred subscriptions keep earning). Best-effort — throws on Stripe error. */
export async function setAffiliatePromoActive(promoCodeId: string, active: boolean): Promise<void> {
  await stripePost(`/promotion_codes/${promoCodeId}`, { active: String(active) });
}

/**
 * Verify the Stripe-Signature header against the raw request body. Stripe signs `${t}.${body}` with
 * HMAC-SHA256; the header is `t=<unix>,v1=<hex>[,v1=...]`. A 5-minute tolerance blocks replays.
 * https://docs.stripe.com/webhooks#verify-manually
 */
export function verifyStripeWebhookSignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return false;

  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't') timestamp = v ?? '';
    if (k === 'v1' && v) signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  return signatures.some(sig => {
    const b = Buffer.from(sig, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

// Minimal shape of the subscription object inside the webhook events we consume.
export interface StripeSubscription {
  id: string;
  customer?: string;
  status?: string; // trialing | active | past_due | canceled | unpaid | incomplete | incomplete_expired | paused
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;    // unix seconds
  canceled_at?: number | null;
  ended_at?: number | null;
  trial_end?: number | null;
  current_period_end?: number | null; // top-level on older API versions...
  currency?: string | null;
  latest_invoice?: string | null;     // id of the most recent invoice (the actual amount charged)
  trial_start?: number | null;        // unix seconds — with trial_end, lets us show the trial length
  items?: { data?: Array<{ current_period_end?: number | null; price?: { id?: string; nickname?: string | null; unit_amount?: number | null; currency?: string | null } }> };
  metadata?: { user_id?: string };
}

// Minimal shape of the Checkout Session object (checkout.session.completed). `discounts` lists the
// applied discounts as {coupon, promotion_code} ID pairs — the promotion_code id is how we map a sale
// back to an affiliate (affiliates.stripe_promo_code_id).
export interface StripeCheckoutSession {
  id: string;
  mode?: string;                 // 'subscription' | 'payment' | 'setup'
  subscription?: string | null;
  customer?: string | null;
  client_reference_id?: string | null;
  metadata?: { user_id?: string };
  discounts?: Array<{ coupon?: string | null; promotion_code?: string | null }>;
}

// Minimal shape of the Invoice object (invoice.payment_succeeded). amount_paid is in the smallest
// currency unit (cents). The subscription link and the subscription's metadata moved under `parent`
// in the 2025-03-31 (Basil) API version — read both the new and legacy locations (invoiceSubscriptionId /
// invoiceUserId below). We deliberately do NOT parse the invoice's own discounts: on webhook payloads
// they arrive as bare Discount IDs (di_…), not the {promotion_code} the affiliate lookup needs — so
// self-heal retrieves the checkout session for the subscription instead (checkoutSessionForSubscription).
export interface StripeInvoice {
  id: string;
  amount_paid?: number | null;   // cents
  amount_due?: number | null;    // cents — the amount owed (used for payment-failed notifications)
  currency?: string | null;
  status?: string;               // draft | open | paid | uncollectible | void
  customer?: string | null;      // customer id (on invoice.payment_failed the event object is the invoice)
  hosted_invoice_url?: string | null;
  billing_reason?: string;       // subscription_create | subscription_cycle | …
  subscription?: string | null;  // legacy (pre-Basil) location
  parent?: {
    subscription_details?: { subscription?: string | null; metadata?: { user_id?: string } | null };
  };
  created?: number;                              // unix seconds, invoice creation
  status_transitions?: { paid_at?: number | null }; // unix seconds, when it was actually paid
  // Line items — used to scope revenue queries to STRIPE_PRICE_ID (the FeedForce plan), so a Stripe
  // account with other products/manual invoices doesn't inflate the revenue numbers. `price.id` is
  // the pre-Basil location; `pricing.price_details.price` is where Basil moved it.
  lines?: { data?: Array<{ price?: { id?: string } | null; pricing?: { price_details?: { price?: string } | null } | null }> };
}

/** Does this invoice contain a line item for `priceId`? Checks both the pre-Basil `price.id` and the
 *  Basil `pricing.price_details.price` locations. */
export function invoiceHasPrice(inv: StripeInvoice, priceId: string): boolean {
  return (inv.lines?.data ?? []).some(line => line.price?.id === priceId || line.pricing?.price_details?.price === priceId);
}

// Minimal shape of the Charge object (charge.refunded) and the Dispute (charge.dispute.*), used to
// reverse commissions when a payment is refunded or charged back. `invoice` links back to the ledger.
export interface StripeCharge {
  id: string;
  invoice?: string | null;
  refunded?: boolean;
  amount_refunded?: number | null;
}
export interface StripeDispute {
  id: string;
  charge?: string | null;
  status?: string;               // warning_needs_response | won | lost | …
}

export interface StripeWebhookEvent {
  type?: string;
  // shape depends on event.type — cast per handler. previous_attributes carries the pre-change values on
  // *.updated events, so we can detect a transition (e.g. cancel_at_period_end flipping false → true).
  data?: { object?: unknown; previous_attributes?: Record<string, unknown> };
}

// Minimal shape of the Customer object — subscription/invoice events carry only the customer id, so the
// notifier retrieves the customer to get the name + email.
export interface StripeCustomer {
  id: string;
  email?: string | null;
  name?: string | null;
}

/** Retrieve a Customer (name + email for notifications). */
export async function retrieveCustomer(id: string): Promise<StripeCustomer> {
  return stripeGet<StripeCustomer>(`/customers/${id}`);
}

/** Retrieve an Invoice (the exact amount charged on a new subscription, after any discount). */
export async function retrieveInvoice(id: string): Promise<StripeInvoice> {
  return stripeGet<StripeInvoice>(`/invoices/${id}`);
}

/** The subscription id on an invoice, across API versions (Basil moved it under `parent`). */
export function invoiceSubscriptionId(inv: StripeInvoice): string | null {
  return inv.parent?.subscription_details?.subscription ?? inv.subscription ?? null;
}

/** The user_id metadata on an invoice's subscription, across API versions. Present on Basil webhook
 *  payloads; a null just means we fall back to the checkout session for the user id. */
export function invoiceUserId(inv: StripeInvoice): string | null {
  return inv.parent?.subscription_details?.metadata?.user_id ?? null;
}

/** Every paid invoice, oldest first — the admin revenue dashboard's live source of truth (no local
 *  ledger; queried straight from Stripe on each request). Paginates via `starting_after`, capped at
 *  50 pages (5,000 invoices) as a runaway-request backstop. Does NOT net out later refunds (a paid
 *  invoice stays "paid" in Stripe even after its charge is refunded) — the admin card notes this.
 *  When `priceId` is given, invoices with no matching line item are dropped — the Stripe LIST
 *  invoices endpoint has no server-side price filter, so this happens client-side after fetching. */
export async function listPaidStripeInvoices(priceId?: string): Promise<StripeInvoice[]> {
  const invoices: StripeInvoice[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 50; page++) {
    const params: Record<string, string> = { limit: '100', status: 'paid' };
    if (startingAfter) params.starting_after = startingAfter;
    const res = await stripeGet<{ data: StripeInvoice[]; has_more: boolean }>('/invoices', params);
    invoices.push(...(priceId ? res.data.filter(inv => invoiceHasPrice(inv, priceId)) : res.data));
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return invoices.reverse(); // Stripe lists newest-first; callers want chronological order
}

/** Retrieve a Checkout Session (fallback for reading `discounts` when the webhook payload omits it). */
export async function retrieveCheckoutSession(id: string): Promise<StripeCheckoutSession> {
  return stripeGet<StripeCheckoutSession>(`/checkout/sessions/${id}`);
}

/** The most recent Checkout Session for a subscription. Used to self-heal affiliate attribution when
 *  the first invoice event beats checkout.session.completed — the session's discounts carry the
 *  promotion_code inline (the same reliable source as the primary path), unlike the invoice's. */
export async function checkoutSessionForSubscription(subscriptionId: string): Promise<StripeCheckoutSession | null> {
  const res = await stripeGet<{ data?: StripeCheckoutSession[] }>('/checkout/sessions', { subscription: subscriptionId, limit: '1' });
  return res.data?.[0] ?? null;
}

/** Retrieve a Charge — used to map a dispute back to its invoice for commission reversal. */
export async function retrieveCharge(id: string): Promise<StripeCharge> {
  return stripeGet<StripeCharge>(`/charges/${id}`);
}
