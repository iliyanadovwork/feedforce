import { NextResponse } from 'next/server';
import { requireUser, unauthorized, rowGrantsAccess } from '@/lib/serverAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { reportError } from '@/lib/reportError';

export const runtime = 'nodejs';

// Redeem a free-month code (see production/supabase/redeem_codes.sql) for the signed-in user. The
// claim is atomic — UPDATE ... WHERE redeemed_by IS NULL — so a code can never be redeemed twice, and
// access is granted by inserting a provider='redeem' subscriptions row whose ends_at does the
// expiring (no webhook exists to flip it later). Body: { code: string }.
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  // Codes are guessable-by-brute-force without a limiter.
  if (!(await rateLimit('billing:redeem:' + user.id, 5))) return tooManyRequests();

  const { code } = (await req.json().catch(() => ({}))) as { code?: string };
  const normalized = (code ?? '').trim().toUpperCase();
  if (!normalized) return NextResponse.json({ error: 'Enter a code.' }, { status: 400 });

  const db = supabaseAdmin();

  // No stacking: someone with live access (paid or comp) can't burn a code early. ANY live row
  // counts — a user can hold several rows (e.g. a lapsed Lemon Squeezy one plus a live Stripe
  // one), and checking only the newest let codes stack on top of paid access.
  const { data: existing, error: existingError } = await db
    .from('subscriptions')
    .select('status,ends_at')
    .eq('user_id', user.id);
  // Fail CLOSED: if we can't read existing subs, don't let a code stack on top of unseen paid access.
  if (existingError) {
    reportError('redeem: subscriptions read failed', existingError.message);
    return NextResponse.json({ error: 'Could not verify your account — try again.' }, { status: 503 });
  }
  // THE access predicate (serverAuth.rowGrantsAccess) — not a local re-derivation that could drift.
  const live = ((existing ?? []) as Array<{ status: string; ends_at: string | null }>).some(rowGrantsAccess);
  if (live) return NextResponse.json({ error: 'You already have an active subscription.' }, { status: 400 });

  // Atomic claim: only the first request to hit an unredeemed row gets it back.
  const { data: claimed, error: claimError } = await db
    .from('redeem_codes')
    .update({ redeemed_by: user.id, redeemed_at: new Date().toISOString() })
    .eq('code', normalized)
    .is('redeemed_by', null)
    .select('code,months');
  if (claimError) {
    reportError('redeem claim failed', claimError.message);
    return NextResponse.json({ error: 'Could not redeem the code — try again.' }, { status: 500 });
  }
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ error: 'That code is invalid or has already been used.' }, { status: 400 });
  }

  const months = Math.max(1, Number(claimed[0].months) || 1);
  const ends = new Date();
  ends.setMonth(ends.getMonth() + months);

  const { error: insertError } = await db.from('subscriptions').insert({
    user_id: user.id,
    provider: 'redeem',
    status: 'active',
    plan_name: months === 1 ? 'Free month (code)' : `Free ${months} months (code)`,
    ends_at: ends.toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (insertError) {
    // Un-claim so the user can retry rather than losing the code to a transient DB error.
    await db.from('redeem_codes').update({ redeemed_by: null, redeemed_at: null }).eq('code', normalized).eq('redeemed_by', user.id);
    reportError('redeem subscription insert failed', insertError.message);
    return NextResponse.json({ error: 'Could not redeem the code — try again.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, endsAt: ends.toISOString() });
}
