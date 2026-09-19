import { NextResponse } from 'next/server';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { listPaidStripeInvoices } from '@/lib/stripe';
import { bucketRevenueByMonth } from '@/lib/rewardsMath';

export const runtime = 'nodejs';

// Admin actual-revenue summary (see /admin → Overview → Actual revenue).
//   GET → { monthly: [{month, revenueCents}], thisMonthCents, totalCents }
// Distinct from the MRR figures elsewhere on the page (a run-rate estimate from currently-active
// subscription prices) — this sums what Stripe says was actually paid, queried live on every request
// (no local ledger to keep in sync). Scoped to STRIPE_PRICE_ID (the FeedForce plan) so a Stripe
// account with other products/manual invoices doesn't inflate the numbers. NOTE: doesn't net out
// refunds issued after the invoice was paid (Stripe invoices stay "paid" even once refunded) — see
// listPaidStripeInvoices. Gated by ADMIN_EMAILS.


export async function GET(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) return NextResponse.json({ error: 'STRIPE_PRICE_ID is not set' }, { status: 500 });
  try {
    const invoices = await listPaidStripeInvoices(priceId);
    // Month bucketing shared with the rewards pool (lib/rewardsMath) so the two can't drift.
    const monthly = [...bucketRevenueByMonth(invoices).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, revenueCents]) => ({ month: `${month}-01`, revenueCents }));

    const thisMonthKey = new Date().toISOString().slice(0, 7);
    const thisMonthCents = monthly.find(m => m.month.slice(0, 7) === thisMonthKey)?.revenueCents ?? 0;
    const totalCents = monthly.reduce((s, m) => s + m.revenueCents, 0);

    return NextResponse.json({ monthly, thisMonthCents, totalCents });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to load revenue' }, { status: 500 });
  }
}
