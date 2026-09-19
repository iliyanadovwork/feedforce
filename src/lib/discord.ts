import { retrieveCustomer, retrieveInvoice, invoiceSubscriptionId, type StripeSubscription, type StripeInvoice } from './stripe';
import { reportError } from './reportError';

// Discord notifications via an incoming webhook. BEST-EFFORT everywhere: a missing URL or a failed post
// never throws — the callers run inside the Stripe billing webhook, and a Discord hiccup must not fail a
// Stripe event (which would make Stripe retry and double-notify). Configure DISCORD_WEBHOOK_URL to a
// channel webhook: Discord → Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.

const BRAND = 'Digital Estate';

const COLOR = {
  signup: 0x8b5cf6,     // violet
  customer: 0x22c55e,   // green
  trial: 0x3b82f6,      // blue
  failed: 0xef4444,     // red
  cancelScheduled: 0xf59e0b, // amber
  canceled: 0x6b7280,   // grey
} as const;

interface DiscordField { name: string; value: string; inline?: boolean }

/** Low-level: post one embed to the configured Discord webhook. No-op when unconfigured; never throws. */
export async function sendDiscordNotification(opts: { title: string; color: number; fields: DiscordField[] }): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return; // feature off until a webhook URL is set
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: opts.title,
          color: opts.color,
          fields: opts.fields.filter(f => f.value).map(f => ({ name: f.name, value: f.value, inline: f.inline ?? false })),
          timestamp: new Date().toISOString(),
        }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) reportError('discord webhook post', new Error(`HTTP ${res.status}`));
  } catch (e) {
    reportError('discord webhook post', e);
  }
}

// ── formatting ────────────────────────────────────────────────────────────────

/** Cents → a localized currency string, e.g. 4900,'usd' → "$49" (no ".00" for whole amounts). */
export function formatMoney(cents: number | null | undefined, currency: string | null | undefined): string {
  const amount = (cents ?? 0) / 100;
  const cur = (currency || 'usd').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${cur}`;
  }
}

/** Unix seconds → "25 June 2026". */
export function formatDate(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(unixSeconds * 1000));
}

const STATUS_LABEL: Record<string, string> = {
  active: 'Active', trialing: 'Trialing', past_due: 'Past due', canceled: 'Cancelled',
  unpaid: 'Unpaid', incomplete: 'Incomplete', incomplete_expired: 'Expired', paused: 'Paused',
};
const statusLabel = (s: string | undefined): string => STATUS_LABEL[s ?? ''] ?? (s ?? 'Unknown');

const planName = (sub: StripeSubscription): string =>
  sub.items?.data?.[0]?.price?.nickname || 'Pro';

/** Fetch the customer's name + email; blanks if the lookup fails (notification still sends). */
async function customerInfo(customerId: string | null | undefined): Promise<{ name: string; email: string }> {
  if (!customerId) return { name: '', email: '' };
  try {
    const c = await retrieveCustomer(customerId);
    return { name: c.name || '', email: c.email || '' };
  } catch {
    return { name: '', email: '' };
  }
}

/** A new account was created (any user, before/without any payment). Fired once per user from the
 *  first authenticated session — see /api/notify/signup. */
export async function notifySignup(opts: { email: string; name?: string; userId: string }): Promise<void> {
  await sendDiscordNotification({
    title: `👤 New ${BRAND} Sign-up`,
    color: COLOR.signup,
    fields: [
      { name: 'Name', value: opts.name || '—', inline: true },
      { name: 'Email', value: opts.email, inline: true },
      { name: 'Date', value: formatDate(Math.floor(Date.now() / 1000)) },
      { name: 'User ID', value: opts.userId },
    ],
  });
}

// ── billing notifiers (each best-effort; called from the Stripe webhook) ────────

/** A new subscription was created — routes to the paid-customer or free-trial notification. */
export async function notifyNewSubscription(sub: StripeSubscription): Promise<void> {
  try {
    const { name, email } = await customerInfo(sub.customer);
    const plan = planName(sub);
    const price = sub.items?.data?.[0]?.price;
    const isTrial = sub.status === 'trialing';

    if (isTrial) {
      const days = sub.trial_start && sub.trial_end
        ? Math.max(1, Math.round((sub.trial_end - sub.trial_start) / 86400))
        : null;
      await sendDiscordNotification({
        title: `🧪 New Free Trial Started`,
        color: COLOR.trial,
        fields: [
          { name: 'Name', value: name, inline: true },
          { name: 'Email', value: email, inline: true },
          { name: 'Plan', value: `${BRAND} — ${plan}` },
          { name: 'Trial', value: days ? `${days} Days` : 'Yes', inline: true },
          { name: 'Trial Ends', value: formatDate(sub.trial_end), inline: true },
          { name: 'Subscription Status', value: 'Trialing', inline: true },
          { name: 'Amount Paid Today', value: formatMoney(0, sub.currency || price?.currency), inline: true },
          { name: 'Stripe Customer ID', value: sub.customer || '' },
          { name: 'Subscription ID', value: sub.id },
        ],
      });
      return;
    }

    // Paid: prefer the actual charged amount from the latest invoice (reflects discounts); fall back to
    // the plan's list price.
    let amount = price?.unit_amount ?? 0;
    let currency = sub.currency || price?.currency;
    let paymentStatus = 'Paid';
    if (sub.latest_invoice) {
      try {
        const inv = await retrieveInvoice(sub.latest_invoice);
        amount = inv.amount_paid ?? amount;
        currency = inv.currency || currency;
        paymentStatus = inv.status === 'paid' ? 'Paid' : statusLabel(inv.status);
      } catch { /* fall back to list price */ }
    }

    await sendDiscordNotification({
      title: `🚀 New ${BRAND} Customer`,
      color: COLOR.customer,
      fields: [
        { name: 'Name', value: name, inline: true },
        { name: 'Email', value: email, inline: true },
        { name: 'Plan', value: `${BRAND} — ${plan}` },
        { name: 'Amount Paid', value: formatMoney(amount, currency), inline: true },
        { name: 'Payment Status', value: paymentStatus, inline: true },
        { name: 'Subscription Status', value: statusLabel(sub.status), inline: true },
        { name: 'Trial', value: 'No', inline: true },
        { name: 'Date', value: formatDate(Math.floor(Date.now() / 1000)) },
        { name: 'Stripe Customer ID', value: sub.customer || '' },
        { name: 'Subscription ID', value: sub.id },
      ],
    });
  } catch (e) {
    reportError('discord notifyNewSubscription', e);
  }
}

/** A subscription was cancelled — `scheduled` = the customer set it to cancel at period end (still has
 *  access until then); otherwise it has actually ended. */
export async function notifyCancellation(sub: StripeSubscription, scheduled: boolean): Promise<void> {
  try {
    const { name, email } = await customerInfo(sub.customer);
    const endsAt = sub.cancel_at ?? sub.current_period_end ?? sub.ended_at ?? null;
    await sendDiscordNotification({
      title: scheduled ? `⚠️ Cancellation Scheduled` : `❌ Subscription Cancelled`,
      color: scheduled ? COLOR.cancelScheduled : COLOR.canceled,
      fields: [
        { name: 'Name', value: name, inline: true },
        { name: 'Email', value: email, inline: true },
        { name: 'Plan', value: `${BRAND} — ${planName(sub)}` },
        { name: 'Subscription Status', value: scheduled ? `${statusLabel(sub.status)} (cancels at period end)` : 'Cancelled', inline: true },
        { name: scheduled ? 'Access Until' : 'Ended', value: formatDate(endsAt), inline: true },
        { name: 'Date', value: formatDate(Math.floor(Date.now() / 1000)) },
        { name: 'Stripe Customer ID', value: sub.customer || '' },
        { name: 'Subscription ID', value: sub.id },
      ],
    });
  } catch (e) {
    reportError('discord notifyCancellation', e);
  }
}

/** A recurring/first payment failed (invoice.payment_failed). */
export async function notifyPaymentFailed(invoice: StripeInvoice): Promise<void> {
  try {
    const { name, email } = await customerInfo(invoice.customer);
    const subId = invoiceSubscriptionId(invoice);
    await sendDiscordNotification({
      title: `💳 Payment Failed`,
      color: COLOR.failed,
      fields: [
        { name: 'Name', value: name, inline: true },
        { name: 'Email', value: email, inline: true },
        { name: 'Amount Due', value: formatMoney(invoice.amount_due, invoice.currency), inline: true },
        { name: 'Payment Status', value: 'Failed', inline: true },
        { name: 'Date', value: formatDate(Math.floor(Date.now() / 1000)) },
        { name: 'Stripe Customer ID', value: invoice.customer || '' },
        { name: 'Subscription ID', value: subId || '' },
        ...(invoice.hosted_invoice_url ? [{ name: 'Invoice', value: invoice.hosted_invoice_url }] : []),
      ],
    });
  } catch (e) {
    reportError('discord notifyPaymentFailed', e);
  }
}
