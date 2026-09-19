// Pure math for the Creator Rewards Program — no I/O, safe to import from client or server.
//
// Program rules (see supabase/creator_rewards.sql for the storage side):
// - A reel enters the money calculation only once its LIFETIME views reach REWARDS_MIN_REEL_VIEWS.
//   The month it crosses the threshold, all its views to date count; later months contribute only
//   that month's gain. Sub-threshold reels contribute nothing.
// - Monthly pool = POOL_REVENUE_SHARE of that month's revenue, split FLAT PROPORTIONAL: each
//   creator's share of the pool equals their share of the month's qualified views. No tiers.

export const REWARDS_MIN_REEL_VIEWS = 10_000;
export const POOL_REVENUE_SHARE = 0.5;

/**
 * Views a single reel contributes to a given month. `startViews` = lifetime views at the start of
 * the month (baseline), `endViews` = lifetime views at the end of the month (next month's baseline,
 * or the live total for the current month). Mirrors the SQL in rewards_month_views() — keep in sync.
 */
export function postMonthContribution({ startViews, endViews }: { startViews: number; endViews: number }): number {
  if (endViews < REWARDS_MIN_REEL_VIEWS) return 0;
  if (startViews < REWARDS_MIN_REEL_VIEWS) return endViews; // crossing month: everything to date counts
  return Math.max(0, endViews - startViews);
}

export interface StandingEntry {
  userId: string;
  views: number; // qualified views for the month (per-reel rule already applied)
}

/** Leaderboard order: drop zero-view users, most views first, userId tie-break for determinism. */
export function rankStandings(entries: StandingEntry[]): StandingEntry[] {
  return entries
    .filter((e) => e.views > 0)
    .sort((a, b) => b.views - a.views || (a.userId < b.userId ? -1 : 1));
}

export interface PayoutStanding extends StandingEntry {
  rank: number; // 1-based leaderboard position
  tier: 'top' | 'rest';
  amountCents: number;
}

/**
 * Split `poolCents` across an already-ranked leaderboard, FLAT PROPORTIONAL:
 *
 *     amount = pool × (your qualified views ÷ all qualified views)
 *
 * Per-user amounts are floored so the sum never exceeds the pool (rounding dust stays undistributed —
 * we under-pay by at most a cent per user, never over-pay).
 *
 * Deliberately NOT tiered. The previous "top 20% share 80% of the pool" split was discontinuous: at
 * exactly 5 ranked creators with IDENTICAL views it paid 80%/5%/5%/5%/5% (a 16x gap decided by the
 * userId tie-break in rankStandings), a creator's pay could fall ~80% purely because someone else
 * joined, and the floor(n*0.2) tier-size step let a rank-2 creator buy into the top tier with one
 * marginal view. Proportional already rewards the biggest creator most — 3x the views is 3x the
 * money — with none of that: equal views always earn equal pay, and rank is display-only.
 */
export function distributePool(poolCents: number, ranked: StandingEntry[]): PayoutStanding[] {
  if (ranked.length === 0) return [];
  // Sanitise both inputs before any arithmetic — this writes rewards_payouts.amount_cents, so a bad
  // input must never become a payout. A NaN/Infinity pool would otherwise propagate into every amount
  // (and JSON.stringify turns NaN into null, hitting a not-null violation at finalize), and a single
  // negative views value would make the shares sum to MORE than the pool (over-payment) while paying
  // its own holder a negative amount. rankStandings already drops views <= 0; this is belt-and-braces
  // for any other caller.
  const pool = Number.isFinite(poolCents) ? Math.max(0, Math.floor(poolCents)) : 0;
  const viewsOf = (e: StandingEntry) => (Number.isFinite(e.views) && e.views > 0 ? e.views : 0);
  const totalViews = ranked.reduce((s, e) => s + viewsOf(e), 0);
  return ranked.map((e, i) => ({
    ...e,
    rank: i + 1,
    // Vestigial under the flat model: rewards_payouts.tier is NOT NULL check (tier in ('top','rest')),
    // so a value must be written. One undifferentiated group → always 'top'.
    tier: 'top',
    amountCents: totalViews > 0 ? Math.floor((pool * viewsOf(e)) / totalViews) : 0,
  }));
}

/** A payout row already on the ledger, as finalize reads it back. */
export interface ExistingPayout {
  user_id: string;
  amount_cents: number | null;
  paid_at: string | null;
}

/**
 * What a (re-)finalize should write to rewards_payouts, given the month's pool, the fresh standings
 * and whatever is already on the ledger.
 *
 * Rows that are already PAID are immutable (the money left the building), so the creators who remain
 * share only what is LEFT of the pool. Paying them their full-pool share on a second run would spend
 * the already-paid money twice: a sole creator paid $20 of a $20 pool, a second creator then
 * qualifies, and the re-finalize hands them a fresh share ON TOP — total obligations $20+ against a
 * $20 pool. Redistributing the remainder keeps paid + written <= pool by construction, because
 * distributePool never over-pays what it is given.
 *
 * Each write is ALSO capped at that creator's share of the full pool on the current board, because
 * the remainder alone is not a safe basis: if the board drifts between two finalizes (a reel is
 * deleted, the hourly view sync self-heals, a creator's subscription lapses), the survivors would
 * split a remainder far larger than they are owed. Worked case: pool $10, board b=990k/a=10k writes
 * b=$9.90/a=$0.10; the admin pays a; b's reel is then removed so the board is 10k/10k; without the
 * cap the re-finalize hands b the whole $9.90 remainder when their entitlement is $5.00 — nearly 2x,
 * decided by which row the admin happened to mark paid first. Anything the cap leaves over simply
 * stays undistributed, the same policy this file already applies to rounding dust.
 *
 * Zero-cent shares are dropped: a share that floors to 0 would otherwise become a ledger line reading
 * "pay $0.00" against a live PayPal address. Those creators stay in the standings/leaderboard; they
 * just aren't recorded as a payable obligation.
 */
export function planFinalizeWrites<T extends StandingEntry>(
  poolCents: number,
  standings: T[],
  existing: ExistingPayout[],
): { toWrite: (T & { amountCents: number })[]; paidCents: number; remainingCents: number } {
  const paidRows = existing.filter((r) => !!r.paid_at);
  const paidUsers = new Set(paidRows.map((r) => r.user_id));
  const paidCents = paidRows.reduce((s, r) => s + Math.max(0, r.amount_cents ?? 0), 0);
  const pool = Number.isFinite(poolCents) ? Math.max(0, Math.floor(poolCents)) : 0;
  const remainingCents = Math.max(0, pool - paidCents);
  const unpaid = standings.filter((s) => !paidUsers.has(s.userId));
  const share = new Map(
    distributePool(remainingCents, unpaid.map((s) => ({ userId: s.userId, views: s.views })))
      .map((r) => [r.userId, r.amountCents]),
  );
  // Ceiling: nobody is written more than their share of the FULL pool on the current board.
  const cap = new Map(
    distributePool(pool, standings.map((s) => ({ userId: s.userId, views: s.views })))
      .map((r) => [r.userId, r.amountCents]),
  );
  const toWrite = unpaid
    .map((s) => ({ ...s, amountCents: Math.min(share.get(s.userId) ?? 0, cap.get(s.userId) ?? 0) }))
    .filter((s) => s.amountCents > 0);
  return { toWrite, paidCents, remainingCents };
}

/** The invoice fields month-bucketing needs (subset of StripeInvoice in lib/stripe.ts). */
export interface RevenueInvoiceLite {
  amount_paid?: number | null; // cents
  created?: number | null; // unix seconds
  status_transitions?: { paid_at?: number | null } | null;
}

/**
 * Bucket paid invoices into per-month revenue, keyed 'YYYY-MM' (UTC, by paid_at falling back to
 * created). Shared by the admin revenue report and the rewards pool so the two can't drift.
 * Sums the WHOLE invoice's amount_paid — fine for FeedForce's single-price checkout (one line item
 * per invoice); refunds issued after payment are not netted out (Stripe invoices stay "paid").
 */
export function bucketRevenueByMonth(invoices: RevenueInvoiceLite[]): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const inv of invoices) {
    const unixSeconds = inv.status_transitions?.paid_at ?? inv.created;
    if (!unixSeconds) continue;
    const month = new Date(unixSeconds * 1000).toISOString().slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + (inv.amount_paid ?? 0));
  }
  return byMonth;
}

/** Revenue (cents) collected in one 'YYYY-MM' month. */
export function monthlyRevenueCents(invoices: RevenueInvoiceLite[], monthKey: string): number {
  return bucketRevenueByMonth(invoices).get(monthKey) ?? 0;
}
