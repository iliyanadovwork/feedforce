import type { SupabaseClient } from '@supabase/supabase-js';
import {
  retrieveCheckoutSession, checkoutSessionForSubscription,
  invoiceSubscriptionId, invoiceUserId,
  type StripeCheckoutSession, type StripeInvoice,
} from './stripe';

// Affiliate attribution + commissions, driven by the Stripe webhook.
//   - checkout.session.completed  → recordReferralFromCheckout(): the promo code the customer used
//     identifies the affiliate; write one affiliate_referrals row per referred subscription.
//   - invoice.payment_succeeded   → recordCommissionFromInvoice(): every payment on a referred
//     subscription writes one affiliate_commissions row for the affiliate's cut (default 10% of
//     what was actually paid). Recurring — fires for the first and every renewal invoice. If the
//     referral doesn't exist yet (Stripe events are unordered — the invoice can beat the checkout
//     event), it self-heals by attributing from the invoice's own discount.
//   - charge.refunded / charge.dispute.created → reverseCommissionForInvoice(): a reversed payment
//     is no longer owed, so the commission row is marked reversed.
// EVERY query checks its error and THROWS on failure so the webhook route returns 500 and Stripe
// retries — a swallowed error would 200 and lose the money silently. All DB access is service-role.

/** Commission owed on a payment: `pct`% of the gross paid, in cents. Rounded to the nearest cent,
 *  clamped at ≥0. Pure — the unit-tested core of the money math. */
export function computeCommissionCents(grossCents: number, pct: number): number {
  if (!Number.isFinite(grossCents) || grossCents <= 0) return 0;
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.max(0, Math.round((grossCents * pct) / 100));
}

/** The promotion-code id applied to a Checkout Session, or null. Reads the webhook payload's
 *  `discounts` first; only if that field is entirely absent does it retrieve the session (an API
 *  version hedge), so the happy path costs no extra API call. */
async function sessionPromoCodeId(session: StripeCheckoutSession): Promise<string | null> {
  let discounts = session.discounts;
  if (discounts === undefined) {
    try { discounts = (await retrieveCheckoutSession(session.id)).discounts; }
    catch { return null; }
  }
  return discounts?.find(d => d.promotion_code)?.promotion_code ?? null;
}

interface ReferralRow { id: string; affiliate_id: string; affiliates?: unknown }

/** commission_pct off a referral's embedded affiliate, tolerant of PostgREST returning the embed as
 *  an object or a single-element array. */
function referralPct(referral: ReferralRow): number {
  const embed = referral.affiliates;
  const aff = Array.isArray(embed) ? embed[0] : embed;
  return (aff as { commission_pct?: number } | null)?.commission_pct ?? 0;
}

/** Active affiliate (id + their own account) for a Stripe promotion_code id, or null. The userId is
 *  used to block self-referrals. Throws on DB error. */
async function affiliateForPromo(db: SupabaseClient, promoId: string): Promise<{ id: string; userId: string | null } | null> {
  const { data, error } = await db
    .from('affiliates')
    .select('id,user_id')
    .eq('stripe_promo_code_id', promoId)
    .eq('active', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { id: data.id as string, userId: (data.user_id as string | null) ?? null };
}

/** Idempotent referral upsert (unique stripe_subscription_id). Throws on DB error. */
async function upsertReferral(db: SupabaseClient, affiliateId: string, userId: string, subscriptionId: string): Promise<void> {
  const { error } = await db
    .from('affiliate_referrals')
    .upsert(
      { affiliate_id: affiliateId, user_id: userId, stripe_subscription_id: subscriptionId },
      { onConflict: 'stripe_subscription_id', ignoreDuplicates: true },
    );
  if (error) throw error;
}

/** The referral row (+ embedded rate) for a subscription, or null. Throws on DB error. */
async function referralForSubscription(db: SupabaseClient, subscriptionId: string): Promise<ReferralRow | null> {
  const { data, error } = await db
    .from('affiliate_referrals')
    .select('id, affiliate_id, affiliates!inner(commission_pct)')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();
  if (error) throw error;
  return (data as ReferralRow | null) ?? null;
}

/** Attribute a completed subscription checkout to an affiliate (if the customer used their code). */
export async function recordReferralFromCheckout(db: SupabaseClient, session: StripeCheckoutSession): Promise<void> {
  if (session.mode && session.mode !== 'subscription') return; // only subscription checkouts
  const subscriptionId = session.subscription;
  const userId = session.metadata?.user_id ?? session.client_reference_id ?? null;
  if (!subscriptionId || !userId) return;

  const promoId = await sessionPromoCodeId(session);
  if (!promoId) return; // no code → not an affiliate sale

  const affiliate = await affiliateForPromo(db, promoId);
  if (!affiliate) return; // a non-affiliate promo code (e.g. the WELCOME50 launch offer)
  if (affiliate.userId && affiliate.userId === userId) return; // self-referral — no commission on your own sub

  await upsertReferral(db, affiliate.id, userId, subscriptionId);
}

/** Record the affiliate's commission for one paid invoice on a referred subscription. Self-heals the
 *  attribution if the checkout referral hasn't landed yet. Idempotent (unique stripe_invoice_id). */
export async function recordCommissionFromInvoice(db: SupabaseClient, invoice: StripeInvoice): Promise<void> {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId || !invoice.id) return;

  let referral = await referralForSubscription(db, subscriptionId);
  if (!referral) {
    // Ordering race: the invoice event beat checkout.session.completed. Attribute from the invoice's
    // OWN discount (the once-off 50%-off coupon rides the first invoice) so the first payment isn't lost.
    referral = await attributeFromInvoice(db, invoice, subscriptionId);
    if (!referral) return; // genuinely not an affiliate-referred subscription
  }

  const grossCents = invoice.amount_paid ?? 0;
  const commissionCents = computeCommissionCents(grossCents, referralPct(referral));
  const { error } = await db
    .from('affiliate_commissions')
    .upsert(
      {
        referral_id: referral.id,
        affiliate_id: referral.affiliate_id,
        stripe_invoice_id: invoice.id,
        gross_amount_cents: grossCents,
        commission_cents: commissionCents,
        currency: invoice.currency ?? 'usd',
      },
      { onConflict: 'stripe_invoice_id', ignoreDuplicates: true },
    );
  if (error) throw error;
}

/** Build the referral when the invoice event beats checkout.session.completed. Retrieves the checkout
 *  session for the subscription and attributes from ITS discounts (the reliable, inline promotion_code
 *  — the invoice's own discounts are bare IDs). Stripe API errors propagate → the webhook 500s and
 *  Stripe retries. Returns the (re-read) referral row, or null when it's genuinely not an affiliate
 *  sale. Throws on DB error. */
async function attributeFromInvoice(db: SupabaseClient, invoice: StripeInvoice, subscriptionId: string): Promise<ReferralRow | null> {
  const session = await checkoutSessionForSubscription(subscriptionId);
  if (!session) return null;

  const promoId = await sessionPromoCodeId(session);
  if (!promoId) return null;
  const affiliate = await affiliateForPromo(db, promoId);
  if (!affiliate) return null;

  const userId = session.metadata?.user_id ?? session.client_reference_id ?? invoiceUserId(invoice);
  if (!userId) return null;
  if (affiliate.userId && affiliate.userId === userId) return null; // self-referral

  await upsertReferral(db, affiliate.id, userId, subscriptionId);
  return referralForSubscription(db, subscriptionId); // re-read for the id + rate
}

/** Mark the commission for a refunded / disputed invoice as reversed (no longer owed). Idempotent —
 *  only the first reversal stamps it. No-op if the invoice earned no commission. Throws on DB error. */
export async function reverseCommissionForInvoice(db: SupabaseClient, invoiceId: string | null | undefined, reason: string): Promise<void> {
  if (!invoiceId) return;
  const { error } = await db
    .from('affiliate_commissions')
    .update({ reversed_at: new Date().toISOString(), reversal_reason: reason })
    .eq('stripe_invoice_id', invoiceId)
    .is('reversed_at', null);
  if (error) throw error;
}

/** Un-reverse a commission that was reversed by a DISPUTE the merchant later WON (funds returned →
 *  owed again). Only touches dispute reversals, never refunds. Throws on DB error. */
export async function reinstateDisputedCommission(db: SupabaseClient, invoiceId: string | null | undefined): Promise<void> {
  if (!invoiceId) return;
  const { error } = await db
    .from('affiliate_commissions')
    .update({ reversed_at: null, reversal_reason: null })
    .eq('stripe_invoice_id', invoiceId)
    .eq('reversal_reason', 'dispute');
  if (error) throw error;
}

// ── Admin management (called by /api/admin/affiliates and /api/admin/affiliate-applications) ──────

export const DISCOUNT_DURATION_MONTHS_OPTIONS = [1, 3, 6, 12] as const;

/** Parse a discount-duration-months value from an admin request body: one of 1|3|6|12, or `null` for
 *  "forever". Returns `undefined` if the raw value isn't one of those (the caller should 400). */
export function parseDiscountDurationMonths(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  const n = Number(raw);
  return (DISCOUNT_DURATION_MONTHS_OPTIONS as readonly number[]).includes(n) ? n : undefined;
}

export interface NewAffiliate {
  name: string;
  email: string;
  code: string;
  commissionPct: number;
  discountPct: number;
  discountDurationMonths: number | null;
  userId: string | null;
  stripePromoCodeId: string;
  stripeCouponId: string;
}

/** Insert an affiliate row (Stripe promo code already minted). Throws on DB error (unique-code
 *  violation surfaces as a 23505 the route maps to "code already in use"). */
export async function createAffiliateRow(db: SupabaseClient, a: NewAffiliate): Promise<{ id: string }> {
  const { data, error } = await db
    .from('affiliates')
    .insert({
      name: a.name,
      email: a.email,
      code: a.code,
      commission_pct: a.commissionPct,
      discount_pct: a.discountPct,
      discount_duration_months: a.discountDurationMonths,
      user_id: a.userId,
      stripe_promo_code_id: a.stripePromoCodeId,
      stripe_coupon_id: a.stripeCouponId,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

export interface AffiliateWithStats {
  id: string;
  name: string;
  email: string;
  code: string;
  commissionPct: number;
  discountPct: number;
  discountDurationMonths: number | null;
  active: boolean;
  userId: string | null;
  createdAt: string;
  referrals: number;      // referred subscriptions
  earnedCents: number;    // lifetime, excluding reversed
  unpaidCents: number;    // owed now (not paid, not reversed)
  clawbackCents: number;  // reversed AFTER being paid out (refund on money already sent)
}

/** All affiliates with their referral count, lifetime earnings, and unpaid balance. Totals come from
 *  admin_affiliate_stats() (aggregated in SQL, so no client row cap can undercount). Throws on error. */
export async function listAffiliatesWithStats(db: SupabaseClient): Promise<AffiliateWithStats[]> {
  const [{ data: affiliates, error }, { data: stats, error: sErr }] = await Promise.all([
    db.from('affiliates').select('id,name,email,code,commission_pct,discount_pct,discount_duration_months,active,user_id,created_at').order('created_at', { ascending: false }),
    db.rpc('admin_affiliate_stats'),
  ]);
  if (error) throw error;
  if (sErr) throw sErr;

  const byId = new Map<string, { referrals: number; earned_cents: number; unpaid_cents: number; clawback_cents: number }>();
  for (const s of (stats ?? []) as Array<{ affiliate_id: string; referrals: number; earned_cents: number; unpaid_cents: number; clawback_cents: number }>) {
    byId.set(s.affiliate_id, s);
  }

  return ((affiliates ?? []) as Array<Record<string, unknown>>).map(r => {
    const id = r.id as string;
    const s = byId.get(id);
    return {
      id,
      name: r.name as string,
      email: r.email as string,
      code: r.code as string,
      commissionPct: r.commission_pct as number,
      discountPct: r.discount_pct as number,
      discountDurationMonths: (r.discount_duration_months as number | null) ?? null,
      active: r.active as boolean,
      userId: (r.user_id as string | null) ?? null,
      createdAt: r.created_at as string,
      referrals: Number(s?.referrals ?? 0),
      earnedCents: Number(s?.earned_cents ?? 0),
      unpaidCents: Number(s?.unpaid_cents ?? 0),
      clawbackCents: Number(s?.clawback_cents ?? 0),
    };
  });
}

/** Mark an affiliate's unpaid, non-reversed commissions as paid now. `before` bounds it to
 *  commissions that existed when the operator loaded the list, so a commission that accrues between
 *  view and click isn't silently marked paid without being sent. Returns the amount/count actually
 *  stamped (from the update's own returned rows, so it's race-safe). Throws on error. */
export async function markAffiliatePaid(db: SupabaseClient, affiliateId: string, before?: string | null): Promise<{ paidCents: number; count: number }> {
  let q = db
    .from('affiliate_commissions')
    .update({ paid_out_at: new Date().toISOString() })
    .eq('affiliate_id', affiliateId)
    .is('paid_out_at', null)
    .is('reversed_at', null);
  if (before) q = q.lte('created_at', before);
  const { data, error } = await q.select('commission_cents');
  if (error) throw error;
  const paid = (data ?? []) as Array<{ commission_cents: number }>;
  return { paidCents: paid.reduce((s, c) => s + (c.commission_cents ?? 0), 0), count: paid.length };
}

/** Activate/deactivate an affiliate row. Throws on DB error. (The Stripe promo code is toggled
 *  separately by the route via setAffiliatePromoActive.) */
export async function setAffiliateActive(db: SupabaseClient, affiliateId: string, active: boolean): Promise<void> {
  const { error } = await db.from('affiliates').update({ active }).eq('id', affiliateId);
  if (error) throw error;
}
