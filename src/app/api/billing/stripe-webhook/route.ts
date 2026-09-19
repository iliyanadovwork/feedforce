import { NextResponse } from 'next/server';
import {
  verifyStripeWebhookSignature, retrieveCharge, retrieveSubscription,
  type StripeWebhookEvent, type StripeSubscription, type StripeCheckoutSession, type StripeInvoice,
  type StripeCharge, type StripeDispute,
} from '@/lib/stripe';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { reportError } from '@/lib/reportError';
import { notifyNewSubscription, notifyCancellation, notifyPaymentFailed } from '@/lib/discord';
import { recordReferralFromCheckout, recordCommissionFromInvoice, reverseCommissionForInvoice, reinstateDisputedCommission } from '@/lib/affiliates';

export const runtime = 'nodejs';

// Stripe subscription webhook — the Stripe twin of /api/billing/webhook (Lemon Squeezy). Configure an
// endpoint at https://<your-domain>/api/billing/stripe-webhook and put its signing secret in
// STRIPE_WEBHOOK_SECRET. The endpoint MUST be subscribed to these events or features silently no-op:
//   customer.subscription.*    — subscription lifecycle (access) + Discord new-customer/trial/cancel alerts
//   checkout.session.completed — affiliate referral attribution
//   invoice.payment_succeeded  — affiliate commissions (recurring)
//   invoice.payment_failed     — Discord payment-failed alert (optional; only needed for that notification)
//   charge.refunded, charge.dispute.created, charge.dispute.closed — affiliate commission reversal/reinstate
// Both webhooks stay live regardless of which provider new checkouts use, so existing Stripe
// subscribers keep renewing after a switch to Lemon Squeezy (and vice versa) until they churn.
//
// NOTE (verify before shipping affiliates): the invoice/session/charge field shapes read here vary by
// Stripe API version — the 2025-03-31 "Basil" release moved invoice.subscription under
// invoice.parent.subscription_details. The affiliate helpers read both locations, but confirm the
// account's API version (Dashboard → Developers) and smoke-test with a real event (Stripe CLI).

// Stripe statuses → the app's vocabulary (useSubscription's grantsAccess reads these).
// incomplete = first payment still failing (no access yet); paused = trial ended without a card.
const STATUS_MAP: Record<string, string> = {
  trialing: 'on_trial',
  active: 'active',
  past_due: 'past_due',
  canceled: 'cancelled',
  unpaid: 'unpaid',
  incomplete: 'unpaid',
  incomplete_expired: 'expired',
  paused: 'paused',
};

const toIso = (unixSeconds: number | null | undefined): string | null =>
  unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyStripeWebhookSignature(raw, req.headers.get('stripe-signature'))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let event: StripeWebhookEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const type = event.type ?? '';
  const db = supabaseAdmin();

  // Affiliate attribution (feat/affiliate-system):
  //   checkout.session.completed → the promo code used identifies the affiliate → write the referral.
  //   invoice.payment_succeeded  → every payment on a referred sub → write the 10% commission row.
  //   charge.refunded / charge.dispute.created → reverse the commission for that invoice.
  // Idempotent; the affiliate helpers THROW on any DB error so this returns 500 and Stripe retries
  // (a swallowed error would 200 and lose money owed to a third party silently).
  try {
    if (type === 'checkout.session.completed') {
      await recordReferralFromCheckout(db, event.data?.object as StripeCheckoutSession);
      return NextResponse.json({ ok: true });
    }
    if (type === 'invoice.payment_succeeded') {
      await recordCommissionFromInvoice(db, event.data?.object as StripeInvoice);
      return NextResponse.json({ ok: true });
    }
    if (type === 'charge.refunded') {
      const charge = event.data?.object as StripeCharge;
      // Only a FULL refund voids the commission; a partial refund shouldn't zero the whole thing.
      if (charge.refunded === true) await reverseCommissionForInvoice(db, charge.invoice, 'refund');
      return NextResponse.json({ ok: true });
    }
    if (type === 'charge.dispute.created') {
      const dispute = event.data?.object as StripeDispute;
      // The dispute carries the charge id, not the invoice — retrieve the charge to map it back.
      const invoiceId = dispute.charge ? (await retrieveCharge(dispute.charge)).invoice : null;
      await reverseCommissionForInvoice(db, invoiceId, 'dispute');
      return NextResponse.json({ ok: true });
    }
    if (type === 'charge.dispute.closed') {
      const dispute = event.data?.object as StripeDispute;
      // A WON dispute returns the funds to us, so the commission is owed again — un-reverse it.
      if (dispute.status === 'won' && dispute.charge) {
        await reinstateDisputedCommission(db, (await retrieveCharge(dispute.charge)).invoice);
      }
      return NextResponse.json({ ok: true });
    }
  } catch (e) {
    reportError('stripe-webhook affiliate handler', e, { type });
    return NextResponse.json({ error: 'Affiliate handler failed' }, { status: 500 });
  }

  // Payment failure → Discord alert (best-effort; its own event type, not part of the affiliate path).
  if (type === 'invoice.payment_failed') {
    await notifyPaymentFailed(event.data?.object as StripeInvoice);
    return NextResponse.json({ ok: true });
  }

  // Every lifecycle change (created on checkout, renewals, cancellations, payment failures, the final
  // deletion at period end) arrives as customer.subscription.* carrying the full subscription object.
  if (!type.startsWith('customer.subscription.')) {
    return NextResponse.json({ ok: true, ignored: type });
  }

  const eventSub = event.data?.object as StripeSubscription | undefined;
  if (!eventSub?.id) {
    return NextResponse.json({ error: 'Malformed payload' }, { status: 400 });
  }

  // ORDERING GUARD — Stripe does not guarantee event order, and the upsert below is last-write-wins.
  // Without this, a retried/late `customer.subscription.updated` (status active) arriving after
  // `customer.subscription.deleted` would flip the row back to active with no ends_at — and since the
  // subscription is gone at Stripe, no later event would ever correct it (permanent free access).
  // So the DB row is always written from the subscription's CURRENT state, fetched fresh; the event
  // only tells us WHICH subscription changed (and drives the transition-based Discord alerts below).
  let sub: StripeSubscription;
  try {
    sub = await retrieveSubscription(eventSub.id);
  } catch (e) {
    // Best-effort guard: when the Stripe API itself is unreachable, fall back to the event snapshot
    // (the pre-guard behaviour) instead of 500ing — retries are FINITE, and a dropped
    // subscription.deleted (kept access) or subscription.created (paying customer locked out) is
    // strictly worse than the rare out-of-order-AND-API-down coincidence the guard would miss.
    reportError('stripe-webhook subscription retrieve failed — writing event snapshot', e, { id: eventSub.id, type });
    sub = eventSub;
  }

  const item = sub.items?.data?.[0];
  const periodEnd = sub.current_period_end ?? item?.current_period_end ?? null;
  const status = STATUS_MAP[sub.status ?? ''] ?? sub.status ?? 'unknown';
  const gone = status === 'cancelled' || status === 'expired';

  const record: Record<string, unknown> = {
    provider: 'stripe',
    stripe_subscription_id: sub.id,
    stripe_customer_id: sub.customer ?? null,
    stripe_price_id: item?.price?.id ?? null,
    status,
    plan_name: item?.price?.nickname || 'Pro',
    // While active: next renewal. While scheduled to cancel or already ended: when access stops
    // (grantsAccess honours ends_at on cancelled rows, matching the Lemon Squeezy flow).
    renews_at: gone || sub.cancel_at_period_end ? null : toIso(periodEnd),
    ends_at: gone
      ? toIso(sub.ended_at) ?? toIso(periodEnd)
      : sub.cancel_at_period_end ? toIso(sub.cancel_at) ?? toIso(periodEnd) : null,
    trial_ends_at: toIso(sub.trial_end),
    updated_at: new Date().toISOString(),
  };
  // user_id rides on subscription.metadata (set at checkout); keep the existing value if ever absent.
  if (sub.metadata?.user_id) record.user_id = sub.metadata.user_id;

  const { error } = await db.from('subscriptions').upsert(record, { onConflict: 'stripe_subscription_id' });
  if (error) {
    // 23502 = NOT NULL violation on user_id: a subscription created OUTSIDE our checkout (Stripe
    // Dashboard / a Payment Link) carries no metadata.user_id and can't be attributed. 200-ignore it
    // so Stripe stops retrying, instead of a permanent 500 loop + log spam.
    if (error.code === '23502') {
      console.warn('stripe webhook: unattributable subscription (no user_id), ignoring:', sub.id);
      return NextResponse.json({ ok: true, ignored: 'no_user_id' });
    }
    // 500 so Stripe retries; surface the cause in logs.
    reportError('stripe-webhook subscriptions upsert', error);
    return NextResponse.json({ error: 'DB upsert failed' }, { status: 500 });
  }

  // Discord notifications — best-effort (never fail the webhook), and only on the meaningful transitions,
  // NOT on every renewal / card update. New paid customer & new trial fire on `created`; a checkout that
  // needed 3-D Secure lands as `incomplete` then flips to `active` on `updated`, so cover that too.
  // Transitions are judged from the EVENT's snapshot (eventSub + previous_attributes) — that's what
  // describes the moment being notified about; the fresh state above is only for the DB row.
  const prev = event.data?.previous_attributes as { cancel_at_period_end?: boolean; status?: string } | undefined;
  if (type === 'customer.subscription.created' && (eventSub.status === 'active' || eventSub.status === 'trialing')) {
    await notifyNewSubscription(eventSub);
  } else if (type === 'customer.subscription.updated' && eventSub.status === 'active' && prev?.status === 'incomplete') {
    await notifyNewSubscription(eventSub); // first payment cleared after SCA — the real "new customer" moment
  } else if (type === 'customer.subscription.updated'
      && eventSub.cancel_at_period_end === true && !!prev && 'cancel_at_period_end' in prev && prev.cancel_at_period_end !== true) {
    await notifyCancellation(eventSub, true); // customer just set it to cancel at period end
  } else if (type === 'customer.subscription.deleted') {
    await notifyCancellation(eventSub, false); // subscription actually ended
  }

  return NextResponse.json({ ok: true });
}
