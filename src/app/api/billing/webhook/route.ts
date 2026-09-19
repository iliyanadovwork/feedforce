import { NextResponse } from 'next/server';
import { verifyWebhookSignature, getSubscription, type LsWebhookPayload } from '@/lib/lemonsqueezy';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { reportError } from '@/lib/reportError';

export const runtime = 'nodejs';

// Lemon Squeezy subscription webhook. Configure it in Lemon Squeezy → Settings → Webhooks with the URL
// https://<your-domain>/api/billing/webhook, the same signing secret as LEMONSQUEEZY_WEBHOOK_SECRET,
// and the `subscription_*` events. We verify the signature, then upsert the local mirror row.
export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get('x-signature');
  if (!verifyWebhookSignature(raw, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: LsWebhookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const eventName = payload.meta?.event_name ?? '';
  // Only the lifecycle events carry a `subscription` object in `data`. We deliberately ignore
  // subscription_payment_* / subscription_plan_changed (those carry an invoice, not a subscription)
  // and every non-subscription event, so we never write a junk row.
  const HANDLED = new Set([
    'subscription_created',
    'subscription_updated',
    'subscription_cancelled',
    'subscription_resumed',
    'subscription_expired',
    'subscription_paused',
    'subscription_unpaused',
  ]);
  if (!HANDLED.has(eventName)) {
    return NextResponse.json({ ok: true, ignored: eventName });
  }

  const userId = payload.meta?.custom_data?.user_id;
  const lsSubscriptionId = payload.data?.id;

  if (!lsSubscriptionId || !payload.data?.attributes) {
    return NextResponse.json({ error: 'Malformed payload' }, { status: 400 });
  }

  // ORDERING GUARD — Lemon Squeezy doesn't guarantee delivery order and the upsert below is
  // last-write-wins: a retried/late `subscription_updated` (status active) landing after
  // `subscription_expired` would resurrect the row forever. Write from the subscription's CURRENT
  // state, fetched fresh; the event only tells us WHICH subscription changed. (custom_data.user_id
  // still comes from the event meta — the API's subscription object doesn't carry it.)
  let attrs: NonNullable<NonNullable<LsWebhookPayload['data']>['attributes']>;
  try {
    const fresh = await getSubscription(String(lsSubscriptionId));
    attrs = fresh.attributes!;
  } catch (e) {
    // Best-effort guard: LS retries are FINITE — an API outage or rotated API key must not turn
    // lifecycle events into permanently dropped writes (churned user keeps access / paying customer
    // never gets it). Fall back to the signed event snapshot (pre-guard behaviour) and report.
    reportError('lemonsqueezy-webhook subscription fetch failed — writing event snapshot', e, { id: lsSubscriptionId, eventName });
    attrs = payload.data.attributes;
  }

  const record: Record<string, unknown> = {
    ls_subscription_id: String(lsSubscriptionId),
    ls_customer_id: attrs.customer_id != null ? String(attrs.customer_id) : null,
    ls_order_id: attrs.order_id != null ? String(attrs.order_id) : null,
    ls_product_id: attrs.product_id != null ? String(attrs.product_id) : null,
    ls_variant_id: attrs.variant_id != null ? String(attrs.variant_id) : null,
    status: attrs.status ?? 'unknown',
    plan_name: attrs.variant_name || attrs.product_name || null,
    card_brand: attrs.card_brand ?? null,
    card_last_four: attrs.card_last_four ?? null,
    renews_at: attrs.renews_at ?? null,
    ends_at: attrs.ends_at ?? null,
    trial_ends_at: attrs.trial_ends_at ?? null,
    customer_portal_url: attrs.urls?.customer_portal ?? null,
    update_payment_url: attrs.urls?.update_payment_method ?? null,
    updated_at: new Date().toISOString(),
  };
  // user_id only ships in custom_data; keep the existing value on updates that omit it.
  if (userId) record.user_id = userId;

  const db = supabaseAdmin();
  const { error } = await db.from('subscriptions').upsert(record, { onConflict: 'ls_subscription_id' });
  if (error) {
    // 23502 = NOT NULL on user_id: a subscription with no custom_data.user_id can't be attributed.
    // 200-ignore it so Lemon Squeezy stops retrying, instead of a permanent 500 loop.
    if (error.code === '23502') {
      console.warn('LS webhook: unattributable subscription (no user_id), ignoring:', lsSubscriptionId);
      return NextResponse.json({ ok: true, ignored: 'no_user_id' });
    }
    // 500 so Lemon Squeezy retries; surface the cause in logs.
    reportError('lemonsqueezy-webhook subscriptions upsert', error);
    return NextResponse.json({ error: 'DB upsert failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
