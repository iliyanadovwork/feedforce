import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getAnalytics } from '@/lib/zernio';
import { cronAuthorized as authorized } from '@/lib/cronAuth';
import { indexAnalyticsViews, decidePostAction, buildSyncPatch, type AnalyticsPost } from '@/lib/rewardsViews';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Daily rewards view sync (see supabase/creator_rewards.sql). Loads EVERY sticker reel — including
// removed ones — and:
//   1. writes this month's baseline FIRST for ALL of them (insert-once — the pre-sync views_total,
//      so the month's gain is measured from the first sync of the month; re-runs never rewrite it).
//      Removed posts keep getting baselines too (their frozen views_total): the month-views RPC
//      zeroes any closed month whose next baseline is missing, so an unbroken baseline chain is what
//      keeps a removed post's already-earned views payable;
//   2. for each live post, pulls its lifetime view count from Zernio's per-post analytics and bumps
//      views_total to max(old, fetched) — never shrink, Zernio blips must not erase views;
//   3. stamps removed_at on tracked posts an account's FULLY-paged, non-empty listing no longer
//      returns (deleted upstream). An errored account is skipped whole, a listing without pagination
//      info counts as partial, and a fully-paged but EMPTY listing is not trusted either (a
//      soft-disconnected account returning 200s must not mass-remove history) — removal is
//      irreversible, so outages never get to look like deletions.
// Accounts are processed stalest-first and the loop stops cleanly near the function deadline, so a
// large backlog just spreads across days without ever dying mid-account.

const PAGE_LIMIT = 25;
const MAX_PAGES = 40; // hard cap per account — beyond this the listing counts as NOT fully paged
const TIME_BUDGET_MS = 250_000; // stop starting new accounts past this (300s function ceiling)
const DB_CHUNK = 1000; // PostgREST caps a single select at 1000 rows — page reads/writes in this size
const HEAL_WINDOW_MS = 14 * 24 * 3600_000; // re-page a removed post for self-heal only this long after removal
// Zernio /analytics caps its date range at 1 year (a wider fromDate 400s). Pass fromDate near that
// edge so the listing covers ~a full year rather than the shorter default — reels older than this
// drop out of the account listing (an inherent limit of listing-based tracking; per-post lookup would
// be needed to track beyond a year).
const ANALYTICS_WINDOW_MS = 360 * 24 * 3600_000;

interface TrackedPost {
  id: string;
  zernio_post_id: string;
  zernio_account_id: string;
  views_total: number;
  views_synced_at: string | null;
  removed_at: string | null;
}

export async function POST(req: Request) { return handle(req); }
export async function GET(req: Request) { return handle(req); }

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const started = Date.now();
  const db = supabaseAdmin();

  // ALL sticker posts, removed included (they still need monthly baselines). Paged — PostgREST
  // silently truncates an unranged select at 1000 rows, which would silently drop tracked posts.
  const posts: TrackedPost[] = [];
  for (let from = 0; ; from += DB_CHUNK) {
    const { data, error } = await db
      .from('rewards_posts')
      .select('id, zernio_post_id, zernio_account_id, views_total, views_synced_at, removed_at')
      .eq('sticker_enabled', true)
      .order('id', { ascending: true })
      .range(from, from + DB_CHUNK - 1);
    // Table missing (not migrated yet) — nothing to do.
    if (error) return NextResponse.json({ synced: 0 });
    posts.push(...((data ?? []) as TrackedPost[]));
    if (!data || data.length < DB_CHUNK) break;
  }
  if (posts.length === 0) return NextResponse.json({ synced: 0 });

  const month = `${new Date().toISOString().slice(0, 7)}-01`; // first day of current UTC month
  const fromDate = new Date(started - ANALYTICS_WINDOW_MS).toISOString().slice(0, 10); // widen the analytics window toward the 1-year cap

  // Baselines FIRST and for EVERY tracked post, independent of any analytics fetch (insert-once):
  // the month's starting point is the PRE-sync views_total, and it must be locked in before any
  // update below can move the live counter. A failed chunk marks its posts so their views_total is
  // NOT advanced this run — never advance views past an unwritten baseline.
  const baselineFailed = new Set<string>();
  for (let i = 0; i < posts.length; i += DB_CHUNK) {
    const chunk = posts.slice(i, i + DB_CHUNK);
    const { error } = await db.from('rewards_post_baselines').upsert(
      chunk.map((p) => ({ rewards_post_id: p.id, month, baseline_views: p.views_total })),
      { onConflict: 'rewards_post_id,month', ignoreDuplicates: true },
    );
    if (error) for (const p of chunk) baselineFailed.add(p.id);
  }

  // Group by account, stalest-first (min views_synced_at, never-synced first) so a run that hits
  // the time budget always spends it on the accounts most behind. REMOVED posts are included too:
  // a post wrongly stamped removed_at (e.g. by the pre-fix ID-mismatch bug) self-heals when it
  // reappears in its account's listing (see decidePostAction). Genuinely-deleted posts simply stay
  // absent and stay removed.
  const byAccount = new Map<string, TrackedPost[]>();
  for (const p of posts) {
    // Removed posts are re-paged only within the self-heal window so a wrongly-removed one can recover;
    // a removal older than the window is treated as settled-dead and drops out of the scan (its
    // baseline was already written above, so earned views stay payable). Bounds the work as the ledger
    // grows so long-dead posts don't get re-fetched (and stalest-first prioritized) forever.
    // Age-out applies ONLY to once-measured removals (a genuine deletion). A never-synced removed post
    // is a false-removal signature (e.g. the ID-mismatch bug) and must NEVER expire out of the scan —
    // so it always keeps its chance to self-heal, no matter how late the first fixed run lands.
    if (p.removed_at && p.views_synced_at && started - new Date(p.removed_at).getTime() > HEAL_WINDOW_MS) continue;
    const group = byAccount.get(p.zernio_account_id);
    if (group) group.push(p); else byAccount.set(p.zernio_account_id, [p]);
  }
  const oldestSync = (group: TrackedPost[]): string =>
    group.reduce((min, p) => {
      const at = p.views_synced_at ?? ''; // '' sorts before any ISO date → never-synced first
      return at < min ? at : min;
    }, group[0].views_synced_at ?? '');
  const accounts = [...byAccount.entries()].sort((a, b) => oldestSync(a[1]).localeCompare(oldestSync(b[1])));

  let processed = 0;
  let synced = 0;
  let removed = 0;
  let healed = 0;
  let skipped = 0;

  for (const [accountId, tracked] of accounts) {
    if (Date.now() - started > TIME_BUDGET_MS) { skipped += accounts.length - processed - skipped; break; }

    // Page the account's per-post analytics (same endpoint/params as /api/schedule/analytics/posts).
    // fetchedViews = ids with a numeric view count; present = ids merely SEEN in the listing (a
    // freshly published reel is present before its views are computed) — the two are kept apart so an
    // unmeasured-but-live post is never mistaken for a deletion.
    const fetchedViews = new Map<string, number>();
    const present = new Set<string>();
    let pagedFully = false;
    try {
      let pages = 1;
      let sawPagination = true;
      for (let page = 1; page <= pages && page <= MAX_PAGES; page++) {
        // Stable DATE sort (not engagement): the cron needs the COMPLETE set, and an engagement sort
        // reorders between page fetches, so a post can slip across a page boundary and be missed
        // (transient false-absence). Publish date is immutable, so paging stays consistent.
        const res = await getAnalytics<{ posts?: AnalyticsPost[]; pagination?: { pages?: number } }>('/analytics', {
          accountId, sortBy: 'date', order: 'desc', page: String(page), limit: String(PAGE_LIMIT), fromDate,
        });
        indexAnalyticsViews(res.posts ?? [], fetchedViews, present);
        if (typeof res.pagination?.pages === 'number') {
          pages = res.pagination.pages;
        } else {
          // No pagination info — the listing can't be proven complete, so it must not drive removals.
          sawPagination = false;
          break;
        }
      }
      pagedFully = sawPagination && pages <= MAX_PAGES;
    } catch {
      // Zernio outage / revoked account — skip the WHOLE account: no view updates and crucially no
      // removed_at stamps (an outage must not read as "post deleted"). Baselines already happened.
      skipped++;
      continue;
    }

    // A fully-paged but EMPTY listing while the account still has tracked posts smells like a soft
    // disconnect (200 + no data), not a mass delete — so it must not drive removals.
    const allowRemoval = pagedFully && present.size > 0;

    const now = new Date().toISOString();
    const goneIds: string[] = [];
    const healIds: string[] = [];
    for (const p of tracked) {
      const fetched = fetchedViews.get(p.zernio_post_id);
      const action = decidePostAction(p, {
        measured: fetched !== undefined,
        present: present.has(p.zernio_post_id),
        allowRemoval,
      });
      if (action === 'sync') {
        if (baselineFailed.has(p.id)) continue; // never advance views past an unwritten baseline
        const { error } = await db.from('rewards_posts').update(buildSyncPatch(p, fetched as number, now)).eq('id', p.id);
        if (!error) synced++;
      } else if (action === 'heal') {
        healIds.push(p.id);
      } else if (action === 'remove') {
        goneIds.push(p.id);
      }
    }
    if (healIds.length > 0) {
      const { error } = await db.from('rewards_posts').update({ removed_at: null }).in('id', healIds);
      if (!error) healed += healIds.length;
    }
    if (goneIds.length > 0) {
      const { error } = await db.from('rewards_posts').update({ removed_at: now }).in('id', goneIds);
      if (!error) removed += goneIds.length;
    }
    processed++;
  }

  return NextResponse.json({ accounts: processed, synced, removed, healed, skipped });
}
