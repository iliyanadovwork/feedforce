import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';
import { selectFacebookPage, ZernioError, friendlyZernioMessage } from '@/lib/zernio';
import { getOrCreateZernioProfile } from '@/lib/zernioProfile';
import { reportError } from '@/lib/reportError';

interface Body {
  pageId?: string;
  tempToken?: string;
  connectToken?: string;
  userProfile?: unknown;
}

// POST /api/schedule/connect/select-page — finishes the headless flow: saves the user's chosen Page,
// which connects its Instagram account under the user's own Zernio profile.
export async function POST(req: Request) {
  if (!AUTOMATIONS_ENABLED) return NextResponse.json({ error: 'Scheduling is disabled' }, { status: 404 });

  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('schedule:connect-select:' + user.id, 20))) return tooManyRequests();

  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { pageId, tempToken, connectToken, userProfile } = body;
  if (!pageId || !tempToken) return NextResponse.json({ error: 'pageId and tempToken are required' }, { status: 400 });

  try {
    const profileId = await getOrCreateZernioProfile(user); // re-derive, never trust client
    const result = await selectFacebookPage({ profileId, pageId, tempToken, userProfile, connectToken });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ZernioError) return NextResponse.json({ error: friendlyZernioMessage(err.status) }, { status: err.status });
    reportError('schedule/connect/select-page', err);
    return NextResponse.json({ error: 'Failed to connect account' }, { status: 500 });
  }
}
