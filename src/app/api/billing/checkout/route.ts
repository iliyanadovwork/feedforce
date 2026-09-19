import { NextResponse } from 'next/server';
import { requireUser, unauthorized, hasActiveSubscription } from '@/lib/serverAuth';
import { createCheckout } from '@/lib/lemonsqueezy';
import { createStripeCheckout } from '@/lib/stripe';
import { getBillingProvider } from '@/lib/appSettings';
import { reportError } from '@/lib/reportError';

export const runtime = 'nodejs';

// Creates a checkout for the signed-in user and returns its URL. WHICH provider hosts it comes from
// the runtime billing_provider setting (default Stripe; toggled at /admin) — existing subscribers are
// unaffected by the toggle, since their provider's webhook keeps syncing them until they churn.
// Once payment completes, the provider fires its webhook (/api/billing/stripe-webhook or
// /api/billing/webhook) which records the subscription.
// Body (Lemon Squeezy only): { variantId?: string } — falls back to LEMONSQUEEZY_VARIANT_ID.
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  // Double-charge guard: an already-subscribed user must not spin up a SECOND subscription (stale
  // client plan, a re-click, a bookmarked checkout link). Runs before either provider branch, so it
  // covers both. Fails OPEN (hasActiveSubscription returns false on a read error) — a DB blip must
  // never block a legitimate new customer from paying; a rare duplicate is the lesser evil.
  if (await hasActiveSubscription(req, user)) {
    return NextResponse.json(
      { error: 'You already have an active subscription — manage it from your account.', code: 'already_subscribed' },
      { status: 409 },
    );
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
  const provider = await getBillingProvider();

  try {
    if (provider === 'stripe') {
      const url = await createStripeCheckout({
        userId: user.id,
        email: user.email ?? undefined,
        successUrl: `${siteUrl}/?checkout=success`,
        cancelUrl: `${siteUrl}/`,
      });
      return NextResponse.json({ url });
    }

    let variantId: string | undefined;
    try {
      const body = await req.json().catch(() => ({}));
      variantId = body?.variantId;
    } catch { /* no body */ }
    variantId = variantId || process.env.LEMONSQUEEZY_VARIANT_ID;
    if (!variantId) {
      return NextResponse.json({ error: 'No plan configured. Set LEMONSQUEEZY_VARIANT_ID.' }, { status: 400 });
    }

    const url = await createCheckout({
      variantId,
      userId: user.id,
      email: user.email ?? undefined,
      redirectUrl: `${siteUrl}/?checkout=success`,
    });
    return NextResponse.json({ url });
  } catch (e) {
    reportError('billing/checkout', e);
    return NextResponse.json({ error: 'Checkout failed' }, { status: 500 });
  }
}
