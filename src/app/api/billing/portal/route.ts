import { NextResponse } from 'next/server';
import { requireUser, unauthorized } from '@/lib/serverAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createStripePortalSession } from '@/lib/stripe';
import { getCustomerPortalUrl } from '@/lib/lemonsqueezy';
import { reportError } from '@/lib/reportError';

export const runtime = 'nodejs';

// Returns a "manage subscription" URL for the signed-in user, whichever provider it lives on. Both
// providers' portal links are short-lived, so they're minted at click time rather than read from the
// mirrored row (where they'd be stale). Picks the most recent PORTAL-CAPABLE row (a Stripe row with a
// customer, or an LS row with a subscription id) — NOT simply the newest row, so a comp/redeem row
// (which has no provider portal) can't lock a real paying customer out of managing their card.
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const { data, error } = await supabaseAdmin()
    .from('subscriptions')
    .select('provider,ls_subscription_id,stripe_customer_id,customer_portal_url,created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  if (error) {
    return NextResponse.json({ error: 'Could not load your subscription — try again.' }, { status: 500 });
  }
  const rows = data ?? [];
  const target = rows.find(r =>
    (r.provider === 'stripe' && r.stripe_customer_id) ||
    (r.provider !== 'stripe' && (r.ls_subscription_id || r.customer_portal_url)),
  );
  if (!target) {
    return NextResponse.json({ error: 'No manageable subscription found' }, { status: 404 });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;

  try {
    if (target.provider === 'stripe') {
      const url = await createStripePortalSession(target.stripe_customer_id as string, `${siteUrl}/`);
      return NextResponse.json({ url });
    }

    const fresh = target.ls_subscription_id ? await getCustomerPortalUrl(target.ls_subscription_id as string) : null;
    // Stale stored URL as a last resort — better than nothing if the LS API hiccups.
    const url = fresh ?? (target.customer_portal_url as string | null);
    if (!url) return NextResponse.json({ error: 'No portal available' }, { status: 400 });
    return NextResponse.json({ url });
  } catch (e) {
    reportError('billing/portal', e);
    return NextResponse.json({ error: 'Portal unavailable' }, { status: 500 });
  }
}
