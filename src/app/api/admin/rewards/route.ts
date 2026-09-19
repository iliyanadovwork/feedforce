import { NextResponse } from 'next/server';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getMonthPool, computeMonthStandings, currentMonthKey, monthKeyToDate } from '@/lib/rewardsPool';
import { planFinalizeWrites } from '@/lib/rewardsMath';

export const runtime = 'nodejs';

// Admin Creator Rewards view (see /admin → Rewards).
//   GET ?month=YYYY-MM → the month's pool, full leaderboard (with emails/PayPal), enrollments,
//        tracked sticker posts, and any finalized payout rows. This is the ONLY surface that shows
//        the whole leaderboard — the user route returns each caller their own numbers only.
//   POST {action:'finalize', month}  → lock the month into rewards_payouts (idempotent upsert;
//        refused until the month is fully over, so a mid-month pool can't be snapshotted as final).
//   POST {action:'mark_paid', payoutId} → stamp paid_at after the manual PayPal transfer.
// Gated by ADMIN_EMAILS. Table reads fail soft to empties (migration may not be applied yet).

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// user_id → email, same paged listUsers scan as /api/admin/users (no getByEmail API). Best-effort:
// an auth-admin hiccup renders ids instead of emails rather than failing the whole panel.
async function loadEmailMap(db: ReturnType<typeof supabaseAdmin>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    for (let page = 1; page <= 10; page++) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
      if (error) break;
      for (const u of data?.users ?? []) if (u.email) map.set(u.id, u.email);
      if ((data?.users?.length ?? 0) < 200) break;
      if (page === 10) console.warn('admin/rewards: >2000 users, email map truncated');
    }
  } catch { /* best-effort */ }
  return map;
}

export async function GET(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();

  const month = new URL(req.url).searchParams.get('month') ?? currentMonthKey();
  if (!MONTH_RE.test(month)) return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });

  const db = supabaseAdmin();
  // The pool is a live Stripe computation — a Stripe outage must not take down the whole panel, so
  // it fails soft to null + poolError while the table-backed lists still render. Standings are then
  // computed with a $0 pool (views/ranks stay right, amounts read as $0 until the pool is back).
  const [poolResult, emails] = await Promise.all([
    getMonthPool(month).then(
      (pool) => ({ pool, poolError: null as string | null }),
      (e: unknown) => ({ pool: null, poolError: e instanceof Error ? e.message : 'Pool computation failed' }),
    ),
    loadEmailMap(db),
  ]);
  const { pool, poolError } = poolResult;

  const standings = await computeMonthStandings(month, pool?.poolCents ?? 0).catch(() => []);

  const [{ data: enrollRows }, { data: postRows }, { data: payoutRows }] = await Promise.all([
    db.from('rewards_enrollments').select('user_id, paypal_email, created_at').order('created_at', { ascending: false }),
    db.from('rewards_posts')
      .select('user_id, zernio_post_id, sticker_enabled, views_total, views_synced_at, removed_at, created_at')
      .eq('sticker_enabled', true)
      .order('views_total', { ascending: false })
      .limit(500),
    db.from('rewards_payouts').select('*').eq('month', monthKeyToDate(month)).order('amount_cents', { ascending: false }),
  ]);

  return NextResponse.json({
    month,
    pool: pool
      ? { revenueCents: pool.revenueCents, poolCents: pool.poolCents, computedAt: pool.computedAt, cached: pool.cached }
      : null,
    ...(poolError ? { poolError } : {}),
    standings: standings.map((s) => ({
      userId: s.userId,
      email: emails.get(s.userId) ?? null,
      views: s.views,
      rank: s.rank,
      tier: s.tier,
      amountCents: s.amountCents,
      paypalEmail: s.paypalEmail,
    })),
    enrollments: (enrollRows ?? []).map((r) => ({
      userId: r.user_id,
      email: emails.get(r.user_id) ?? null,
      paypalEmail: r.paypal_email,
      createdAt: r.created_at,
    })),
    posts: (postRows ?? []).map((r) => ({
      userId: r.user_id,
      email: emails.get(r.user_id) ?? null,
      zernioPostId: r.zernio_post_id,
      stickerEnabled: r.sticker_enabled,
      viewsTotal: r.views_total,
      viewsSyncedAt: r.views_synced_at,
      removedAt: r.removed_at,
      createdAt: r.created_at,
    })),
    payouts: payoutRows ?? [],
  });
}

export async function POST(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();

  const body = (await req.json().catch(() => ({}))) as { action?: string; month?: string; payoutId?: string };
  const db = supabaseAdmin();

  if (body.action === 'mark_paid') {
    const payoutId = (body.payoutId ?? '').trim();
    if (!UUID_RE.test(payoutId)) return NextResponse.json({ error: 'payoutId must be a payout row UUID' }, { status: 400 });
    const { data, error } = await db
      .from('rewards_payouts')
      .update({ paid_at: new Date().toISOString() })
      .eq('id', payoutId)
      .select()
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'Payout not found' }, { status: 404 });
    return NextResponse.json({ payout: data });
  }

  if (body.action === 'finalize') {
    const month = body.month ?? '';
    if (!MONTH_RE.test(month)) return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });
    // Only fully-closed months: finalizing needs the NEXT month's first cron baselines to exist
    // (they close the month's view windows), so wait until at least one day into the next month.
    const [y, m] = month.split('-').map(Number);
    if (Date.now() < Date.UTC(y, m, 2)) {
      return NextResponse.json({ error: 'That month is not over yet — finalize from the 2nd of the following month.' }, { status: 400 });
    }

    try {
      // Guard BEFORE writing anything: the month-views RPC closes a month with the NEXT month's
      // baselines, so if the cron hasn't run since the month ended, every post would silently
      // compute 0 and the finalization would lock in an empty month. Only refuse when there is at
      // least one sticker post the month could actually cover.
      const nextMonthStart = new Date(Date.UTC(y, m, 1)); // first day of the FOLLOWING month (m is 1-based)
      const nextMonth = nextMonthStart.toISOString().slice(0, 10);
      const { data: coveredPosts } = await db
        .from('rewards_posts')
        .select('id')
        .eq('sticker_enabled', true)
        .lt('created_at', nextMonthStart.toISOString())
        .limit(1);
      if ((coveredPosts?.length ?? 0) > 0) {
        const { data: monthEndBaselines } = await db
          .from('rewards_post_baselines')
          .select('rewards_post_id')
          .eq('month', nextMonth)
          .limit(1);
        if ((monthEndBaselines?.length ?? 0) === 0) {
          return NextResponse.json(
            { error: "View sync hasn't recorded the month-end baselines yet — run /api/cron/rewards-views first." },
            { status: 409 },
          );
        }
      }

      const pool = await getMonthPool(month, { fresh: true });
      // A $0 pool is almost always an infrastructure symptom (STRIPE_PRICE_ID unset, a failed Stripe
      // read, an empty cache write) rather than a genuinely revenue-free month — and finalizing on it
      // is purely destructive: every share computes to zero, so nothing is written and the stale-row
      // sweep below would delete every unpaid obligation already on the ledger. Refuse instead.
      if (pool.poolCents <= 0) {
        return NextResponse.json(
          { error: `The ${month} pool computed to $0.00 — check Stripe revenue and STRIPE_PRICE_ID before finalizing. Nothing was changed.` },
          { status: 400 },
        );
      }
      const standings = await computeMonthStandings(month, pool.poolCents);
      const monthDate = monthKeyToDate(month);
      const warnings: string[] = [];

      // Re-finalization safety: rows already PAID are immutable (money left the building — never
      // overwrite; surface drift as a warning instead), and stale UNPAID rows for users no longer
      // in the fresh standings are deleted so a prior finalization can't inflate the ledger past
      // the pool.
      const { data: existing, error: existingError } = await db
        .from('rewards_payouts')
        .select('id, user_id, amount_cents, paid_at')
        .eq('month', monthDate);
      if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
      const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
      const freshByUser = new Map(standings.map((s) => [s.userId, s]));
      const paidUsers = new Set<string>();
      for (const row of existing ?? []) {
        if (!row.paid_at) continue;
        paidUsers.add(row.user_id);
        const fresh = freshByUser.get(row.user_id);
        if (!fresh) {
          warnings.push(`User ${row.user_id} has an already-PAID payout of ${usd(row.amount_cents)} but is not in the fresh standings — row left untouched.`);
        } else if (fresh.amountCents !== row.amount_cents) {
          warnings.push(`User ${row.user_id}: fresh amount ${usd(fresh.amountCents)} differs from the already-PAID ${usd(row.amount_cents)} — paid row left untouched.`);
        }
      }
      // Paid rows are immutable, so the remaining creators share only what is LEFT of the pool, and
      // zero-cent shares are never written. See planFinalizeWrites for why (it keeps paid + written
      // <= pool by construction, and it is unit-tested — this route is not).
      const { toWrite, paidCents, remainingCents } = planFinalizeWrites(pool.poolCents, standings, existing ?? []);
      if (paidCents > 0) {
        warnings.push(`${usd(paidCents)} of the ${usd(pool.poolCents)} pool is already paid; ${usd(remainingCents)} shared among the remaining creators.`);
      }

      // Stale unpaid rows: drop anything no longer payable — a user gone from the standings, or one
      // whose recomputed share is now zero (otherwise a previously-written amount would linger).
      const payable = new Set(toWrite.map((s) => s.userId));
      const staleUnpaidIds = (existing ?? [])
        .filter((r) => !r.paid_at && !payable.has(r.user_id))
        .map((r) => r.id);
      if (staleUnpaidIds.length > 0) {
        const { error: deleteError } = await db.from('rewards_payouts').delete().in('id', staleUnpaidIds);
        if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });
      }

      if (toWrite.length === 0) return NextResponse.json({ pool, payouts: [], warnings });

      const { data, error } = await db
        .from('rewards_payouts')
        .upsert(
          toWrite.map((s) => ({
            month: monthDate,
            user_id: s.userId,
            views: s.views,
            tier: s.tier,
            pool_cents: pool.poolCents,
            amount_cents: s.amountCents,
            paypal_email: s.paypalEmail, // snapshot — later enrollment edits don't move a closed month
          })),
          { onConflict: 'month,user_id' },
        )
        .select();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ pool, payouts: data ?? [], warnings });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Finalize failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
