import { NextResponse } from 'next/server';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { getLaunchOffer, setLaunchOfferActive } from '@/lib/stripe';

export const runtime = 'nodejs';

// Admin control for the site-wide launch offer (WELCOME50 — 50% off the first month, unlimited
// redemptions, entered at Stripe checkout). GET reports the current state; POST { active } flips it,
// creating the Stripe coupon + promotion code on first activation. Gated by ADMIN_EMAILS.


export async function GET(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();
  try {
    const offer = await getLaunchOffer();
    return NextResponse.json({ offer });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Stripe lookup failed' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();
  const body = (await req.json().catch(() => ({}))) as { active?: boolean };
  if (typeof body.active !== 'boolean') {
    return NextResponse.json({ error: 'Body must be { active: boolean }' }, { status: 400 });
  }
  try {
    const offer = await setLaunchOfferActive(body.active);
    return NextResponse.json({ offer });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Stripe update failed' }, { status: 500 });
  }
}
