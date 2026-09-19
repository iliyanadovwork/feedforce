import { NextResponse } from 'next/server';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { getBillingProvider, setBillingProvider } from '@/lib/appSettings';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

// Admin billing controls (see /admin): which provider new checkouts use, plus a per-provider
// subscriber breakdown so the operator can watch Stripe users churn off after switching to
// Lemon Squeezy. Gated by ADMIN_EMAILS (lib/adminAuth.ts).


export async function GET(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();

  const provider = await getBillingProvider();

  // Small table — aggregate in JS rather than SQL. NOT one row per subscriber: redeeming a code
  // inserts a new row and provider switches leave the old provider's row behind, so count each
  // user once by their LATEST row (the same rule as /api/admin/users and useSubscription) or the
  // counts and MRR double-count anyone with history.
  const { data, error } = await supabaseAdmin()
    .from('subscriptions')
    .select('user_id,provider,status,ends_at,created_at')
    .order('created_at', { ascending: true });
  const counts: Record<string, Record<string, number>> = { stripe: {}, lemonsqueezy: {}, redeem: {} };
  // MRR = subscribers who will actually bill again (status active, no scheduled end), priced at the
  // plan rate. Both providers sell the same $59.99 plan; comp (redeem) rows are never revenue.
  const planPriceUsd = Number(process.env.PLAN_PRICE_USD) || 59.99;
  const mrr: Record<string, number> = { stripe: 0, lemonsqueezy: 0 };
  if (!error) {
    // Rows are oldest→newest, so later writes win.
    const latestByUser = new Map<string, NonNullable<typeof data>[number]>();
    for (const row of data ?? []) latestByUser.set(row.user_id as string, row);
    for (const row of latestByUser.values()) {
      const p = (row.provider as string) || 'lemonsqueezy';
      const s = (row.status as string) || 'unknown';
      counts[p] = counts[p] ?? {};
      counts[p][s] = (counts[p][s] ?? 0) + 1;
      if ((p === 'stripe' || p === 'lemonsqueezy') && s === 'active' && !row.ends_at) {
        mrr[p] += planPriceUsd;
      }
    }
  }

  return NextResponse.json({ provider, counts, mrr, planPriceUsd });
}

export async function POST(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();

  const body = (await req.json().catch(() => ({}))) as { provider?: string };
  if (body.provider !== 'stripe' && body.provider !== 'lemonsqueezy') {
    return NextResponse.json({ error: 'provider must be "stripe" or "lemonsqueezy"' }, { status: 400 });
  }

  try {
    await setBillingProvider(body.provider);
    return NextResponse.json({ ok: true, provider: body.provider });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Save failed' }, { status: 500 });
  }
}
