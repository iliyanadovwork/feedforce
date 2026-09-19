import { NextResponse } from 'next/server';
import { getLaunchOffer, LAUNCH_OFFER_PERCENT_OFF } from '@/lib/stripe';
import { getBillingProvider } from '@/lib/appSettings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public read of the launch offer so the paywall can advertise the code. Only reports active when
// new checkouts actually go through Stripe (the code is useless on Lemon Squeezy) AND the admin has
// switched the offer on. Best-effort: any Stripe/config error just reads as "no offer".
export async function GET() {
  try {
    if ((await getBillingProvider()) !== 'stripe') return NextResponse.json({ active: false });
    const offer = await getLaunchOffer();
    if (!offer.active) return NextResponse.json({ active: false });
    return NextResponse.json({ active: true, code: offer.code, percentOff: LAUNCH_OFFER_PERCENT_OFF });
  } catch {
    return NextResponse.json({ active: false });
  }
}
