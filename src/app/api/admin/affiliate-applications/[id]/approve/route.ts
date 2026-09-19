import { NextResponse } from 'next/server';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAffiliatePromoCode, setAffiliatePromoActive } from '@/lib/stripe';
import { createAffiliateRow, parseDiscountDurationMonths } from '@/lib/affiliates';

export const runtime = 'nodejs';

// POST /api/admin/affiliate-applications/{id}/approve — configure the deal terms and accept a
// pending application: mints the Stripe promo code, inserts the affiliates row (already linked to
// the applicant's account — no invite step needed, unlike the direct-add flow), marks the
// application approved. Gated by ADMIN_EMAILS.


// Application id from the path …/affiliate-applications/{id}/approve.
function targetId(req: Request): string {
  const parts = new URL(req.url).pathname.split('/');
  return decodeURIComponent(parts[parts.length - 2] ?? '');
}

export async function POST(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return forbidden();

  const id = targetId(req);
  if (!id) return NextResponse.json({ error: 'Missing application id' }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { code?: string; commissionPct?: unknown; discountPct?: unknown; discountDurationMonths?: unknown };
  const code = (body.code ?? '').trim().toUpperCase();
  const commissionPct = Math.round(Number(body.commissionPct));
  const discountPct = Math.round(Number(body.discountPct));
  const discountDurationMonths = parseDiscountDurationMonths(body.discountDurationMonths);

  if (!/^[A-Z0-9]{3,20}$/.test(code)) return NextResponse.json({ error: 'Code must be 3–20 letters/numbers, no spaces.' }, { status: 400 });
  if (!Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct > 100) {
    return NextResponse.json({ error: 'Commission % must be a number between 0 and 100.' }, { status: 400 });
  }
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
    return NextResponse.json({ error: 'Discount % must be a number between 0 and 100.' }, { status: 400 });
  }
  if (discountDurationMonths === undefined) {
    return NextResponse.json({ error: 'Discount duration must be 1, 3, 6, or 12 months, or forever.' }, { status: 400 });
  }

  const db = supabaseAdmin();

  const { data: application, error: appErr } = await db
    .from('affiliate_applications')
    .select('id,status,user_id,name,email')
    .eq('id', id)
    .maybeSingle();
  if (appErr) return NextResponse.json({ error: appErr.message }, { status: 500 });
  if (!application) return NextResponse.json({ error: 'Application not found.' }, { status: 404 });
  if (application.status !== 'pending') return NextResponse.json({ error: 'This application was already reviewed.' }, { status: 409 });

  const { data: existing } = await db.from('affiliates').select('id').ilike('code', code).maybeSingle();
  if (existing) return NextResponse.json({ error: 'That code is already in use.' }, { status: 409 });

  try {
    let promo: { promoCodeId: string; couponId: string };
    try {
      promo = await createAffiliatePromoCode(code, discountPct, discountDurationMonths);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (/already exist/i.test(msg)) return NextResponse.json({ error: 'That code is already in use at the payment provider.' }, { status: 409 });
      throw e;
    }

    let affiliateId: string;
    try {
      ({ id: affiliateId } = await createAffiliateRow(db, {
        name: application.name as string,
        email: application.email as string,
        code, commissionPct, discountPct, discountDurationMonths,
        userId: application.user_id as string,
        stripePromoCodeId: promo.promoCodeId, stripeCouponId: promo.couponId,
      }));
    } catch (e) {
      try { await setAffiliatePromoActive(promo.promoCodeId, false); } catch { /* best effort */ }
      throw e;
    }

    const { error: updateErr } = await db
      .from('affiliate_applications')
      .update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: admin.id })
      .eq('id', id);
    if (updateErr) console.warn('affiliate_applications approve status update failed:', updateErr.message);

    return NextResponse.json({ id: affiliateId, code });
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'That code is already in use.' }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to approve application' }, { status: 500 });
  }
}
