import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

// Creator Rewards enrollment (Pro-only opt-in — see supabase/creator_rewards.sql).
//   GET    → { enrolled, paypalEmail } — is the caller in the program, and where do we pay them.
//   POST   { paypalEmail } → join (or update the payout email). Upsert keyed on user_id.
//   DELETE → leave. Only the enrollment row goes — rewards_posts history stays, so rejoining
//            restores standing (sticker reels keep accruing views either way).
// All reads fail-soft to "not enrolled": the rewards tables may not be migrated yet, and the
// editor's useRewardsEnrollment hook treats any error as not-enrolled anyway.

// Same basic shape check the affiliate routes use — PayPal does the real validation at payout time.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function gate(req: Request) {
  const user = await requireUser(req);
  if (!user) return { user: null, res: unauthorized() };
  const subGate = await requireSubscriber(req, user); // Pro-only program (FREE_TIER_PLAN.md)
  if (subGate) return { user: null, res: subGate };
  if (!(await rateLimit('rewards:enroll:' + user.id, 30))) return { user: null, res: tooManyRequests() };
  return { user, res: null };
}

export async function GET(req: Request) {
  const { user, res } = await gate(req);
  if (!user) return res;
  try {
    const { data, error } = await supabaseAdmin()
      .from('rewards_enrollments')
      .select('paypal_email')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) return NextResponse.json({ enrolled: false, paypalEmail: null });
    return NextResponse.json({ enrolled: !!data, paypalEmail: data?.paypal_email ?? null });
  } catch {
    return NextResponse.json({ enrolled: false, paypalEmail: null });
  }
}

export async function POST(req: Request) {
  const { user, res } = await gate(req);
  if (!user) return res;

  const body = (await req.json().catch(() => ({}))) as { paypalEmail?: unknown };
  const paypalEmail = typeof body.paypalEmail === 'string' ? body.paypalEmail.trim() : '';
  if (!EMAIL_RE.test(paypalEmail)) {
    return NextResponse.json({ error: 'A valid PayPal email is required.' }, { status: 400 });
  }

  const { error } = await supabaseAdmin()
    .from('rewards_enrollments')
    .upsert(
      { user_id: user.id, paypal_email: paypalEmail, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
  if (error) return NextResponse.json({ error: 'Could not save your enrollment — please try again.' }, { status: 500 });
  return NextResponse.json({ enrolled: true, paypalEmail });
}

export async function DELETE(req: Request) {
  // Deliberately NO requireSubscriber here: a lapsed subscriber must still be able to leave the
  // program and remove their PayPal email — leaving is never Pro-gated.
  const user = await requireUser(req);
  if (!user) return unauthorized();
  if (!(await rateLimit('rewards:enroll:' + user.id, 30))) return tooManyRequests();

  const { error } = await supabaseAdmin().from('rewards_enrollments').delete().eq('user_id', user.id);
  if (error) return NextResponse.json({ error: 'Could not leave the program — please try again.' }, { status: 500 });
  return NextResponse.json({ enrolled: false, paypalEmail: null });
}
