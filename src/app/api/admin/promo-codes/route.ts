import { NextResponse } from 'next/server';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { createFreeMonthPromoCodes, listFreeMonthPromoCodes } from '@/lib/stripe';

export const runtime = 'nodejs';

// Admin Stripe promo-code management (see /admin): GET lists the single-use first-month-free
// promotion codes with redemption state; POST generates a batch. Codes are entered on the Stripe
// checkout page — the subscriber pays $0 for month one, then bills normally. Gated by ADMIN_EMAILS.


export async function GET(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();
  try {
    const codes = await listFreeMonthPromoCodes(100);
    return NextResponse.json({ codes });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Stripe list failed' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();
  const body = (await req.json().catch(() => ({}))) as { count?: number };
  const count = Math.min(20, Math.max(1, Math.round(Number(body.count) || 1)));
  try {
    const codes = await createFreeMonthPromoCodes(count);
    return NextResponse.json({ codes });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Stripe create failed' }, { status: 500 });
  }
}
