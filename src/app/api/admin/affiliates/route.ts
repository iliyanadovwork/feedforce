import { NextResponse } from 'next/server';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAffiliatePromoCode, setAffiliatePromoActive } from '@/lib/stripe';
import { createAffiliateRow, listAffiliatesWithStats, parseDiscountDurationMonths } from '@/lib/affiliates';

export const runtime = 'nodejs';

// Admin affiliate management (see /admin → Affiliates).
//   GET  → { affiliates: [...] }  each with referral count, lifetime earnings, unpaid balance
//   POST { name, email, code, commissionPct, discountPct, discountDurationMonths } → create an
//         affiliate: invite/link their account, mint their Stripe promo code (their vanity code,
//         discountPct% off for discountDurationMonths months, or forever if null), insert the row.
// Gated by ADMIN_EMAILS.


export async function GET(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();
  try {
    const affiliates = await listAffiliatesWithStats(supabaseAdmin());
    // asOf bounds a later payout to what's shown here, so a commission accruing after this load
    // isn't marked paid without being sent.
    return NextResponse.json({ affiliates, asOf: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to load affiliates' }, { status: 500 });
  }
}

// Invite the affiliate's account (free login for their dashboard) or reuse an existing one; returns
// the user id, or null if we couldn't invite/find them (the affiliate still works — code attribution
// doesn't need the account — they just can't see a dashboard until linked).
async function findOrInviteUser(db: ReturnType<typeof supabaseAdmin>, email: string): Promise<string | null> {
  const invite = await db.auth.admin.inviteUserByEmail(email);
  if (!invite.error && invite.data?.user) return invite.data.user.id;
  // Already registered (or invite failed) — find the existing account by email (no getByEmail API).
  // Linear scan of the first ~2000 users; a targeted auth.users lookup would scale better later.
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) { console.warn('findOrInviteUser: listUsers failed', error.message); return null; }
    const found = data?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found.id;
    if ((data?.users?.length ?? 0) < 200) break;
  }
  return null;
}

export async function POST(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();

  const body = (await req.json().catch(() => ({}))) as { name?: string; email?: string; code?: string; commissionPct?: unknown; discountPct?: unknown; discountDurationMonths?: unknown };
  const name = (body.name ?? '').trim();
  const email = (body.email ?? '').trim().toLowerCase();
  const code = (body.code ?? '').trim().toUpperCase();
  const pctRaw = body.commissionPct;
  const commissionPct = Math.round(Number(pctRaw));
  const discountPctRaw = body.discountPct;
  const discountPct = Math.round(Number(discountPctRaw));
  const discountDurationMonths = parseDiscountDurationMonths(body.discountDurationMonths);

  if (!name) return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  if (!/^[A-Z0-9]{3,20}$/.test(code)) return NextResponse.json({ error: 'Code must be 3–20 letters/numbers, no spaces.' }, { status: 400 });
  if (pctRaw === undefined || pctRaw === null || pctRaw === '' || !Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct > 100) {
    return NextResponse.json({ error: 'Commission % must be a number between 0 and 100.' }, { status: 400 });
  }
  if (discountPctRaw === undefined || discountPctRaw === null || discountPctRaw === '' || !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
    return NextResponse.json({ error: 'Discount % must be a number between 0 and 100.' }, { status: 400 });
  }
  if (discountDurationMonths === undefined) {
    return NextResponse.json({ error: 'Discount duration must be 1, 3, 6, or 12 months, or forever.' }, { status: 400 });
  }

  const db = supabaseAdmin();

  // Pre-check the code is free locally (the unique index is the backstop) so we don't mint an orphan
  // Stripe code on the common duplicate case.
  const { data: existing } = await db.from('affiliates').select('id').ilike('code', code).maybeSingle();
  if (existing) return NextResponse.json({ error: 'That code is already in use.' }, { status: 409 });

  // One affiliate per email (backstopped by the affiliates_user_id_uniq index once linked). Keeps a
  // person's dashboard a single row.
  const { data: existingEmail } = await db.from('affiliates').select('id').eq('email', email).maybeSingle();
  if (existingEmail) return NextResponse.json({ error: 'That email is already an affiliate.' }, { status: 409 });

  try {
    // Mint the Stripe code FIRST — a code collision 409s here, before any account is invited.
    let promo: { promoCodeId: string; couponId: string };
    try {
      promo = await createAffiliatePromoCode(code, discountPct, discountDurationMonths);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (/already exist/i.test(msg)) return NextResponse.json({ error: 'That code is already in use at the payment provider.' }, { status: 409 });
      throw e; // a real Stripe error (outage, bad key) → 500 with the actual message below
    }

    // Insert the row (user_id linked after). If it fails, deactivate the just-minted promo so the
    // code isn't left live-but-untracked AND is free to retry (Stripe uniqueness is per active code).
    let id: string;
    try {
      ({ id } = await createAffiliateRow(db, {
        name, email, code, commissionPct, discountPct, discountDurationMonths, userId: null,
        stripePromoCodeId: promo.promoCodeId, stripeCouponId: promo.couponId,
      }));
    } catch (e) {
      try { await setAffiliatePromoActive(promo.promoCodeId, false); } catch { /* best effort */ }
      throw e;
    }

    // Invite/link the account LAST and best-effort — the affiliate & their code already work; a
    // failed invite just means no dashboard until linked, not a failed creation.
    const userId = await findOrInviteUser(db, email);
    if (userId) {
      // Best-effort link (unique index rejects if that account is already an affiliate); a failed
      // link just leaves the row unlinked — the code still works, only the dashboard is unavailable.
      const { error: linkErr } = await db.from('affiliates').update({ user_id: userId }).eq('id', id);
      if (linkErr) console.warn('affiliate user_id link failed:', linkErr.message);
    }

    return NextResponse.json({ id, code, invited: !!userId });
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'That code is already in use.' }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to create affiliate' }, { status: 500 });
  }
}
