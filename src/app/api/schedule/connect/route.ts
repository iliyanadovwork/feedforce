import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';
import { getConnectUrl, listAccounts, MAX_SOCIAL_ACCOUNTS, ZernioError, friendlyZernioMessage } from '@/lib/zernio';
import { getOrCreateZernioProfile } from '@/lib/zernioProfile';
import { reportError } from '@/lib/reportError';

// Platforms we let users connect today (kept narrow on purpose).
const ALLOWED = new Set(['instagram']);

// GET /api/schedule/connect?platform=instagram — starts a headless OAuth flow under the user's own
// Zernio profile and returns the platform authUrl. The browser redirects there; after the user
// authorizes, the platform redirects back to `redirect_url` (the app) with selection params, which the
// /connect/pages + /connect/select-page routes finish. The user never touches the Zernio dashboard.
export async function GET(req: Request) {
  if (!AUTOMATIONS_ENABLED) return NextResponse.json({ error: 'Scheduling is disabled' }, { status: 404 });

  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('schedule:connect:' + user.id, 20))) return tooManyRequests();

  const platform = new URL(req.url).searchParams.get('platform') ?? 'instagram';
  if (!ALLOWED.has(platform)) return NextResponse.json({ error: `Unsupported platform: ${platform}` }, { status: 400 });

  try {
    const profileId = await getOrCreateZernioProfile(user);

    // Cap the number of connected accounts: past the limit the user must disconnect one first. The Post
    // UI already disables the "+", but guard here too so the OAuth flow can't be started directly.
    const existing = await listAccounts(profileId);
    if (existing.length >= MAX_SOCIAL_ACCOUNTS) {
      return NextResponse.json(
        { error: `You can connect up to ${MAX_SOCIAL_ACCOUNTS} accounts. Disconnect one to add another.` },
        { status: 409 },
      );
    }

    // Land back in the app root; Zernio appends its own OAuth params (platform, step, tempToken,
    // connect_token, …), which page.tsx detects to open the Post screen and SchedulePanel uses to
    // finish the page-selection step. Bare origin so we don't collide with those appended params.
    const origin = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
    const redirectUrl = `${origin}/`;

    const { authUrl } = await getConnectUrl(platform, profileId, redirectUrl);
    return NextResponse.json({ authUrl });
  } catch (err) {
    if (err instanceof ZernioError) return NextResponse.json({ error: friendlyZernioMessage(err.status) }, { status: err.status });
    reportError('schedule/connect', err);
    return NextResponse.json({ error: 'Failed to start connection' }, { status: 500 });
  }
}
