import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';
import { listPosts, ZernioError, friendlyZernioMessage } from '@/lib/zernio';
import { getOrCreateZernioProfile } from '@/lib/zernioProfile';
import { reportError } from '@/lib/reportError';

// Optional ?status= filter values (Zernio's post statuses). Anything else is ignored, not an error,
// so stale client links can't break the calendar.
const STATUSES = ['draft', 'scheduled', 'published', 'failed'] as const;
type PostStatus = (typeof STATUSES)[number];

// GET /api/schedule/posts — the user's scheduled/published posts (scoped to their profile) for the
// calendar. Optional query params: status, accountId, limit (1..100) pass straight through to Zernio
// so Schedule All can inspect one account's backlog; the response shape is unchanged.
export async function GET(req: Request) {
  if (!AUTOMATIONS_ENABLED) return NextResponse.json({ error: 'Scheduling is disabled' }, { status: 404 });

  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('schedule:posts:' + user.id, 60))) return tooManyRequests();

  const params = new URL(req.url).searchParams;
  const statusParam = params.get('status');
  const status = (STATUSES as readonly string[]).includes(statusParam ?? '') ? (statusParam as PostStatus) : undefined;
  const accountId = params.get('accountId') ?? undefined;
  const limitParam = Number(params.get('limit'));
  // Zernio caps limit at 100; keep the historical default of 100 when absent or out of range.
  const limit = Number.isInteger(limitParam) && limitParam >= 1 && limitParam <= 100 ? limitParam : 100;

  try {
    const profileId = await getOrCreateZernioProfile(user);
    const result = await listPosts({ limit, profileId, status, accountId });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ZernioError) return NextResponse.json({ error: friendlyZernioMessage(err.status) }, { status: err.status });
    reportError('schedule/posts', err);
    return NextResponse.json({ error: 'Failed to load posts' }, { status: 500 });
  }
}
