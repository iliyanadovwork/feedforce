import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { REWARDS_MIN_REEL_VIEWS } from '@/lib/rewardsMath';
import { getMonthPool, computeMonthStandings, currentMonthKey } from '@/lib/rewardsPool';

export const runtime = 'nodejs';

// One-shot payload for the Rewards page: the caller's OWN standing this month. PRIVACY: the
// response carries only the caller's numbers plus their rank and how many creators are ranked —
// never the pool/revenue figures and never anyone else's identity or views (the full leaderboard
// is admin-only). Every piece fails soft: the rewards tables may not be migrated yet, and a pool
// hiccup must degrade to an "empty program" payload, not a 500.

interface RewardsSummary {
  enrolled: boolean;
  paypalEmail: string | null;
  month: string; // 'YYYY-MM'
  monthViews: number;
  minReelViews: number;
  rank: number | null; // null = not on the leaderboard (no qualified views yet)
  rankedCount: number;
  tier: 'top' | 'rest' | null;
  estimatedCents: number | null;
  postCount: number; // sticker-enabled reels
  qualifiedPosts: number; // …of which have crossed the per-reel view threshold
}

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only program (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('rewards:summary:' + user.id, 30))) return tooManyRequests();

  const db = supabaseAdmin();
  const month = currentMonthKey();
  const summary: RewardsSummary = {
    enrolled: false,
    paypalEmail: null,
    month,
    monthViews: 0,
    minReelViews: REWARDS_MIN_REEL_VIEWS,
    rank: null,
    rankedCount: 0,
    tier: null,
    estimatedCents: null,
    postCount: 0,
    qualifiedPosts: 0,
  };

  // Enrollment + sticker-post counts (removed posts still count — their accrued views stay in the
  // money computation, so the progress numbers must match what the RPC pays on).
  try {
    const [{ data: enrollment }, { data: posts }] = await Promise.all([
      db.from('rewards_enrollments').select('paypal_email').eq('user_id', user.id).maybeSingle(),
      db.from('rewards_posts').select('views_total').eq('user_id', user.id).eq('sticker_enabled', true),
    ]);
    summary.enrolled = !!enrollment;
    summary.paypalEmail = enrollment?.paypal_email ?? null;
    summary.postCount = posts?.length ?? 0;
    summary.qualifiedPosts = (posts ?? []).filter((p) => Number(p.views_total) >= REWARDS_MIN_REEL_VIEWS).length;
  } catch {
    // tables not migrated yet / read hiccup — the empty defaults above stand
  }

  // Leaderboard position + estimate. Only the caller's own row leaves this route.
  try {
    const pool = await getMonthPool(month);
    const standings = await computeMonthStandings(month, pool.poolCents);
    summary.rankedCount = standings.length;
    const mine = standings.find((s) => s.userId === user.id);
    if (mine) {
      summary.monthViews = mine.views;
      summary.rank = mine.rank;
      summary.tier = mine.tier;
      summary.estimatedCents = mine.amountCents;
    }
  } catch {
    // RPC missing / Stripe hiccup — rank stays null, estimate stays null
  }

  return NextResponse.json(summary);
}
