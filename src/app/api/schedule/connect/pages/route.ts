import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';
import { listFacebookPages, ZernioError, friendlyZernioMessage } from '@/lib/zernio';
import { getOrCreateZernioProfile } from '@/lib/zernioProfile';
import { reportError } from '@/lib/reportError';

// GET /api/schedule/connect/pages?tempToken=…&connectToken=… — after the user authorizes on Instagram,
// the headless redirect hands back a tempToken (+ single-use connect_token). This lists the Pages /
// Instagram accounts they can connect, so the app can show an in-app picker (no Zernio UI).
export async function GET(req: Request) {
  if (!AUTOMATIONS_ENABLED) return NextResponse.json({ error: 'Scheduling is disabled' }, { status: 404 });

  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('schedule:connect-pages:' + user.id, 30))) return tooManyRequests();

  const sp = new URL(req.url).searchParams;
  const tempToken = sp.get('tempToken') ?? '';
  const connectToken = sp.get('connectToken') ?? undefined;
  if (!tempToken) return NextResponse.json({ error: 'tempToken is required' }, { status: 400 });

  try {
    const profileId = await getOrCreateZernioProfile(user); // re-derive, never trust client
    const pages = await listFacebookPages(profileId, tempToken, connectToken);
    return NextResponse.json({ pages });
  } catch (err) {
    if (err instanceof ZernioError) return NextResponse.json({ error: friendlyZernioMessage(err.status) }, { status: err.status });
    reportError('schedule/connect/pages', err);
    return NextResponse.json({ error: 'Failed to list pages' }, { status: 500 });
  }
}
