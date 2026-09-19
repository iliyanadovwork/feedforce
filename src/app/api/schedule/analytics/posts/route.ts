import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';
import { getAnalytics, listAccounts, ZernioError, friendlyZernioMessage } from '@/lib/zernio';
import { getOrCreateZernioProfile } from '@/lib/zernioProfile';
import { reportError } from '@/lib/reportError';

// GET /api/schedule/analytics/posts?accountId=…&page=1&limit=10 — a paginated page of the account's
// posts sorted by engagement (for the "Top performing posts" table). Separate from the dashboard route
// so paging doesn't re-fetch all the other analytics.
export async function GET(req: Request) {
  if (!AUTOMATIONS_ENABLED) return NextResponse.json({ error: 'Scheduling is disabled' }, { status: 404 });

  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('schedule:analytics-posts:' + user.id, 60))) return tooManyRequests();

  const sp = new URL(req.url).searchParams;
  const accountId = sp.get('accountId') ?? '';
  if (!accountId) return NextResponse.json({ error: 'accountId is required' }, { status: 400 });
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const limit = Math.min(25, Math.max(1, Number(sp.get('limit')) || 10));

  try {
    const profileId = await getOrCreateZernioProfile(user);
    const accounts = await listAccounts(profileId);
    if (!accounts.some((a) => a._id === accountId)) return NextResponse.json({ error: 'Account not found' }, { status: 403 });

    const res = await getAnalytics<{ posts?: unknown[]; pagination?: unknown }>('/analytics', {
      accountId, sortBy: 'engagement', order: 'desc', page: String(page), limit: String(limit),
    });
    return NextResponse.json({ posts: res.posts ?? [], pagination: res.pagination ?? null });
  } catch (err) {
    if (err instanceof ZernioError) return NextResponse.json({ error: friendlyZernioMessage(err.status) }, { status: err.status });
    reportError('schedule/analytics/posts', err);
    return NextResponse.json({ error: 'Failed to load posts' }, { status: 500 });
  }
}
