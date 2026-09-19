import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';
import { listAccounts, disconnectAccount, ZernioError, friendlyZernioMessage } from '@/lib/zernio';
import { getOrCreateZernioProfile } from '@/lib/zernioProfile';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { reportError } from '@/lib/reportError';

// GET /api/schedule/accounts — the signed-in user's connected social accounts (scoped to their own
// Zernio profile), so the Post panel shows only their accounts. Auth + rate-limit before hitting it.
export async function GET(req: Request) {
  if (!AUTOMATIONS_ENABLED) return NextResponse.json({ error: 'Scheduling is disabled' }, { status: 404 });

  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('schedule:accounts:' + user.id, 30))) return tooManyRequests();

  try {
    const profileId = await getOrCreateZernioProfile(user);
    const accounts = await listAccounts(profileId);
    // Surface Instagram first (the feature we ship today) but return everything Zernio knows about.
    accounts.sort((a, b) => Number(b.platform === 'instagram') - Number(a.platform === 'instagram'));
    return NextResponse.json({ accounts });
  } catch (err) {
    if (err instanceof ZernioError) return NextResponse.json({ error: friendlyZernioMessage(err.status) }, { status: err.status });
    reportError('schedule/accounts', err);
    return NextResponse.json({ error: 'Failed to load accounts' }, { status: 500 });
  }
}

// DELETE /api/schedule/accounts?accountId=… — disconnect one of the user's connected accounts. Removes
// it from Zernio; if it was their last account we also drop the social_profiles mapping so a fresh
// connect starts clean (the row is re-created lazily on next connect by getOrCreateZernioProfile).
export async function DELETE(req: Request) {
  if (!AUTOMATIONS_ENABLED) return NextResponse.json({ error: 'Scheduling is disabled' }, { status: 404 });

  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('schedule:accounts:delete:' + user.id, 10))) return tooManyRequests();

  const accountId = new URL(req.url).searchParams.get('accountId');
  if (!accountId) return NextResponse.json({ error: 'accountId is required' }, { status: 400 });

  try {
    const profileId = await getOrCreateZernioProfile(user);
    // Authorize: the account must live under THIS user's Zernio profile, so a user can't disconnect
    // someone else's account by guessing an id.
    const accounts = await listAccounts(profileId);
    if (!accounts.some((a) => a._id === accountId)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    await disconnectAccount(accountId);

    // Last account gone → remove the user→profile mapping from Supabase too.
    if (accounts.filter((a) => a._id !== accountId).length === 0) {
      const { error } = await supabaseAdmin().from('social_profiles').delete().eq('user_id', user.id);
      if (error) reportError('schedule/accounts social_profiles cleanup failed', error.message);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ZernioError) return NextResponse.json({ error: friendlyZernioMessage(err.status) }, { status: err.status });
    reportError('schedule/accounts DELETE', err);
    return NextResponse.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }
}
