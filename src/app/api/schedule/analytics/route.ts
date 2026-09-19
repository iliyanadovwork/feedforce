import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';
import { getAnalytics, listAccounts, ZernioError, friendlyZernioMessage } from '@/lib/zernio';
import { getOrCreateZernioProfile } from '@/lib/zernioProfile';
import { reportError } from '@/lib/reportError';

// GET /api/schedule/analytics?accountId=…&days=30 — aggregates several Zernio Instagram analytics
// endpoints for the dashboard. Each sub-call is resilient: a failure (e.g. no analytics add-on, or
// <100 followers for demographics) yields null for that block rather than failing the whole request.
export async function GET(req: Request) {
  if (!AUTOMATIONS_ENABLED) return NextResponse.json({ error: 'Scheduling is disabled' }, { status: 404 });

  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('schedule:analytics:' + user.id, 30))) return tooManyRequests();

  const sp = new URL(req.url).searchParams;
  const accountId = sp.get('accountId') ?? '';
  if (!accountId) return NextResponse.json({ error: 'accountId is required' }, { status: 400 });
  const days = Math.min(90, Math.max(7, Number(sp.get('days')) || 30));

  try {
    // Ownership: the account must belong to this user's Zernio profile.
    const profileId = await getOrCreateZernioProfile(user);
    const accounts = await listAccounts(profileId);
    if (!accounts.some((a) => a._id === accountId)) {
      return NextResponse.json({ error: 'Account not found' }, { status: 403 });
    }

    const until = new Date();
    const since = new Date(until.getTime() - days * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const sinceS = fmt(since), untilS = fmt(until);

    const safe = async <T,>(p: Promise<T>): Promise<T | null> => { try { return await p; } catch { return null; } };

    const [insights, reach, followers, demographics, bestTime, frequency, decay, dailyMetrics, summary] = await Promise.all([
      safe(getAnalytics('/analytics/instagram/account-insights', { accountId, metricType: 'total_value', since: sinceS, until: untilS })),
      safe(getAnalytics('/analytics/instagram/account-insights', { accountId, metrics: 'reach', metricType: 'time_series', since: sinceS, until: untilS })),
      // time_series gives BOTH the current total (follower_count.total) and the daily values for the chart.
      safe(getAnalytics('/analytics/instagram/follower-history', { accountId, metricType: 'time_series', since: sinceS, until: untilS })),
      safe(getAnalytics('/analytics/instagram/demographics', { accountId, metric: 'follower_demographics', breakdown: 'age,gender,country,city' })),
      safe(getAnalytics('/analytics/best-time', { accountId, platform: 'instagram' })),
      safe(getAnalytics('/analytics/posting-frequency', { accountId, platform: 'instagram' })),
      safe(getAnalytics('/analytics/content-decay', { accountId, platform: 'instagram' })),
      // platformBreakdown → period totals (reach, postCount, views, engagement components → engagement rate).
      safe(getAnalytics('/analytics/daily-metrics', { accountId, since: sinceS, until: untilS })),
      // overview (posts count) + the single best post (highest engagement).
      safe(getAnalytics('/analytics', { accountId, sortBy: 'engagement', order: 'desc', limit: '1' })),
    ]);

    return NextResponse.json({ insights, reach, followers, demographics, bestTime, frequency, decay, dailyMetrics, summary, range: { since: sinceS, until: untilS, days } });
  } catch (err) {
    if (err instanceof ZernioError) return NextResponse.json({ error: friendlyZernioMessage(err.status) }, { status: err.status });
    reportError('schedule/analytics', err);
    return NextResponse.json({ error: 'Failed to load analytics' }, { status: 500 });
  }
}
