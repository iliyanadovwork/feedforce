import { supabaseAdmin } from './supabaseAdmin';
import { listPaidStripeInvoices } from './stripe';
import {
  monthlyRevenueCents,
  rankStandings,
  distributePool,
  POOL_REVENUE_SHARE,
  type PayoutStanding,
} from './rewardsMath';

// Server-only: monthly rewards pool + leaderboard standings. The pool is POOL_REVENUE_SHARE of the
// month's Stripe revenue (queried live — there is deliberately no local revenue ledger, see the
// drop_revenue_events migration). Lemon Squeezy revenue is NOT included (no aggregation helper
// exists) — surfaced as a note in the admin UI.

const POOL_CACHE_KEY = 'rewards_pool_cache';
const POOL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface MonthPool {
  monthKey: string; // 'YYYY-MM'
  revenueCents: number;
  poolCents: number;
  computedAt: string; // ISO
  cached: boolean;
}

/** First day of the month for the rewards RPCs/tables. */
export function monthKeyToDate(monthKey: string): string {
  return `${monthKey}-01`;
}

export function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * The month's pool. Cached in app_settings for POOL_CACHE_TTL_MS because computing it pages every
 * paid Stripe invoice — fine for a 6-hourly refresh, not for every Rewards-page load. Pass
 * `fresh: true` (month-end finalization) to bypass and rewrite the cache. STRIPE_PRICE_ID unset →
 * zero pool (fail-soft: the UI shows $0 estimates rather than erroring).
 */
export async function getMonthPool(monthKey: string, opts?: { fresh?: boolean }): Promise<MonthPool> {
  const db = supabaseAdmin();
  if (!opts?.fresh) {
    try {
      const { data } = await db.from('app_settings').select('value').eq('key', POOL_CACHE_KEY).maybeSingle();
      const v = data?.value as { month?: string; revenueCents?: number; computedAt?: string } | null;
      if (
        v &&
        v.month === monthKey &&
        typeof v.revenueCents === 'number' &&
        v.computedAt &&
        Date.now() - Date.parse(v.computedAt) < POOL_CACHE_TTL_MS
      ) {
        return {
          monthKey,
          revenueCents: v.revenueCents,
          poolCents: Math.floor(v.revenueCents * POOL_REVENUE_SHARE),
          computedAt: v.computedAt,
          cached: true,
        };
      }
    } catch {
      // cache read failure → fall through to a live compute
    }
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  const revenueCents = priceId ? monthlyRevenueCents(await listPaidStripeInvoices(priceId), monthKey) : 0;
  const computedAt = new Date().toISOString();
  try {
    await db
      .from('app_settings')
      .upsert(
        { key: POOL_CACHE_KEY, value: { month: monthKey, revenueCents, computedAt }, updated_at: computedAt },
        { onConflict: 'key' },
      );
  } catch {
    // best-effort cache write
  }
  return { monthKey, revenueCents, poolCents: Math.floor(revenueCents * POOL_REVENUE_SHARE), computedAt, cached: false };
}

export interface MonthStanding extends PayoutStanding {
  paypalEmail: string;
}

/**
 * The month's leaderboard with payout amounts: qualified views per user (per-reel 10k rule, via the
 * rewards_month_views RPC) → enrolled users only → currently-subscribed only → ranked → pool split.
 * Subscription is checked at computation time (matches the automations-cron precedent): lapsing
 * mid-month hides you from standings, re-subscribing before finalization restores you.
 */
export async function computeMonthStandings(monthKey: string, poolCents: number): Promise<MonthStanding[]> {
  const db = supabaseAdmin();

  // Both reads are paged: PostgREST silently caps a single response at 1000 rows, which would
  // silently drop creators from the payout. `.range()` works on the set-returning RPC too; both are
  // ordered by user_id so the pages are stable.
  const DB_CHUNK = 1000;
  const loadViewRows = async (): Promise<{ user_id: string; views: number }[]> => {
    const rows: { user_id: string; views: number }[] = [];
    for (let from = 0; ; from += DB_CHUNK) {
      const { data, error } = await db
        .rpc('rewards_month_views', { p_month: monthKeyToDate(monthKey) })
        .order('user_id', { ascending: true })
        .range(from, from + DB_CHUNK - 1);
      if (error) throw new Error(`rewards_month_views failed: ${error.message}`);
      rows.push(...((data ?? []) as { user_id: string; views: number }[]));
      if (!data || data.length < DB_CHUNK) break;
    }
    return rows;
  };
  const loadEnrollRows = async (): Promise<{ user_id: string; paypal_email: string }[]> => {
    const rows: { user_id: string; paypal_email: string }[] = [];
    for (let from = 0; ; from += DB_CHUNK) {
      const { data, error } = await db
        .from('rewards_enrollments')
        .select('user_id, paypal_email')
        .order('user_id', { ascending: true })
        .range(from, from + DB_CHUNK - 1);
      if (error) throw new Error(`rewards_enrollments read failed: ${error.message}`);
      rows.push(...((data ?? []) as { user_id: string; paypal_email: string }[]));
      if (!data || data.length < DB_CHUNK) break;
    }
    return rows;
  };
  const [viewRows, enrollRows] = await Promise.all([loadViewRows(), loadEnrollRows()]);

  const paypalByUser = new Map(enrollRows.map((r) => [r.user_id, r.paypal_email]));
  const enrolled = viewRows.filter((r) => paypalByUser.has(r.user_id));

  // Per-user subscription check via service-role RPC, cached per call (cron/automations idiom).
  const subCache = new Map<string, boolean>();
  const isSubscribed = async (uid: string): Promise<boolean> => {
    const hit = subCache.get(uid);
    if (hit !== undefined) return hit;
    const { data, error } = await db.rpc('has_active_subscription', { p_user: uid });
    const ok = !error && data === true;
    subCache.set(uid, ok);
    return ok;
  };

  const eligible: { userId: string; views: number }[] = [];
  for (const row of enrolled) {
    if (await isSubscribed(row.user_id)) eligible.push({ userId: row.user_id, views: Number(row.views) });
  }

  return distributePool(poolCents, rankStandings(eligible)).map((s) => ({
    ...s,
    paypalEmail: paypalByUser.get(s.userId) ?? '',
  }));
}
