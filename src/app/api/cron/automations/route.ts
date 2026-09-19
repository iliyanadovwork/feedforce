import { NextResponse } from 'next/server';
import type { Browser } from 'puppeteer-core';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runGraph, graphLimitError, type Graph } from '@/lib/automations';
import { serverNodeRegistry } from '@/lib/automations/serverNodes';
import { buildRunServices } from '@/lib/automations/serverContext';
import { publishFlowPosts, launchRenderBrowser } from '@/lib/automations/serverPublish';
import { runLogNodes } from '@/lib/automations/runLog';
import { lastFire, parseCron, CRON_LOOKBACK_MS } from '@/lib/automations/cron';
import { cronAuthorized as authorized } from '@/lib/cronAuth';

export const runtime = 'nodejs';
export const maxDuration = 300; // headless rendering is slow; Vercel clamps to the plan's ceiling

// Scheduled runner (§8.3). Called by Vercel Cron (or any scheduler) on an interval; gated by CRON_SECRET.
// Runs each ENABLED flow whose timer trigger is due (interval elapsed since its last run). Flows with a
// configured Post node then publish server-side: a shared headless Chromium screenshots the generated
// post via /render/post/[id] and the PNGs go to Zernio (see lib/automations/serverPublish.ts).
// No pausing — durable waits are the final phase. Best-effort + fail-soft: one flow's error never
// blocks the others.

const INTERVAL_MS: Record<string, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  cron: 24 * 60 * 60 * 1000, // fallback when the expression doesn't parse — a broken cron still runs daily
};

export async function POST(req: Request) { return handle(req); }
export async function GET(req: Request) { return handle(req); }

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = supabaseAdmin();

  // Hard cap: one runner invocation processes at most 200 enabled flows (oldest-updated first would
  // need a column; id order is stable). Keeps a single pathological account from starving the batch.
  const { data: flows } = await db.from('automations').select('id,user_id,graph').eq('enabled', true).limit(200);
  const results: Array<{ id: string; ran: boolean; status?: string; error?: string; published?: number }> = [];

  // One headless browser shared across the whole batch (launch is the expensive part), started lazily
  // so runs without Post nodes never pay for it. RENDER_ORIGIN overrides the self-URL when the
  // deployment sits behind a different public host.
  const origin = process.env.RENDER_ORIGIN || new URL(req.url).origin;
  let browser: Browser | null = null;
  const getBrowser = async () => (browser ??= await launchRenderBrowser());

  // Automations are Pro-only (FREE_TIER_PLAN.md): the interactive routes gate on subscription, and
  // the scheduler must match — a lapsed subscriber's enabled flows would otherwise keep running
  // (and publishing to their accounts) forever, with no UI left to disable them. Checked once per
  // owner per batch via the security-definer SQL predicate. On a check ERROR the flow is skipped,
  // not run: it retries next tick, and skipping never publishes on a stale entitlement.
  const subscriberCache = new Map<string, boolean>();
  const ownerIsSubscriber = async (uid: string): Promise<boolean> => {
    const cached = subscriberCache.get(uid);
    if (cached !== undefined) return cached;
    const { data, error } = await db.rpc('has_active_subscription', { p_user: uid });
    const ok = !error && data === true;
    subscriberCache.set(uid, ok);
    return ok;
  };

  // Batch the "latest run per flow" lookup instead of one query per flow (N+1). Only a run within the
  // LONGEST configured interval can make a flow "not due", so bound the scan to that window; anything
  // older than that means the flow is due regardless. First row per automation_id (desc) is its latest.
  const dueFlows = (flows ?? []) as Array<{ id: string; user_id: string; graph: Graph }>;
  const lastRunByFlow = new Map<string, string>();
  if (dueFlows.length > 0) {
    // Window must cover the rarest schedule we honour: fixed intervals top out at weekly, but a custom
    // cron can be ~monthly — anything older than the cron lookback means the flow is due regardless.
    const maxInterval = Math.max(...Object.values(INTERVAL_MS), CRON_LOOKBACK_MS);
    const { data: recentRuns } = await db.from('automation_runs')
      .select('automation_id, started_at')
      .in('automation_id', dueFlows.map(f => f.id))
      .gte('started_at', new Date(Date.now() - maxInterval).toISOString())
      .order('started_at', { ascending: false });
    for (const r of (recentRuns ?? []) as Array<{ automation_id: string; started_at: string }>) {
      if (!lastRunByFlow.has(r.automation_id)) lastRunByFlow.set(r.automation_id, r.started_at);
    }
  }

  for (const flow of dueFlows) {
    if (!(await ownerIsSubscriber(flow.user_id))) {
      results.push({ id: flow.id, ran: false, status: 'skipped_no_subscription' });
      continue;
    }
    const trigger = flow.graph?.nodes?.find(n => n.type === 'trigger');
    const cfg = (trigger?.config ?? {}) as { mode?: string; interval?: string; cron?: string; tz?: string };
    if (cfg.mode !== 'timer') { results.push({ id: flow.id, ran: false }); continue; }
    const lastAt = lastRunByFlow.get(flow.id);

    if (cfg.interval === 'cron' && typeof cfg.cron === 'string' && parseCron(cfg.cron)) {
      // Real cron semantics: due only when the expression has fired since the last run. A VALID
      // expression with no fire inside the lookback (e.g. a yearly cron mid-year) is simply not due —
      // it must never fall into an interval fallback that would run (and publish!) daily.
      const fire = lastFire(cfg.cron, new Date(), typeof cfg.tz === 'string' && cfg.tz.trim() ? cfg.tz.trim() : 'UTC');
      if (!fire || (lastAt && new Date(lastAt).getTime() >= fire.getTime())) { results.push({ id: flow.id, ran: false }); continue; }
      // due — fall through to run below
    } else {
      // Fixed intervals — and UNPARSEABLE cron expressions, which keep the old daily behaviour so a
      // typo'd cron doesn't go silent forever.
      const intervalMs = INTERVAL_MS[cfg.interval ?? 'daily'] ?? INTERVAL_MS.daily;
      // Due if nothing has run yet (within the window), or the interval has elapsed since the last run.
      if (lastAt && Date.now() - new Date(lastAt).getTime() < intervalMs) { results.push({ id: flow.id, ran: false }); continue; }
    }

    // Skip oversized stored flows cleanly instead of burning the user's quota and failing mid-run.
    const limitErr = graphLimitError(flow.graph);
    if (limitErr) { results.push({ id: flow.id, ran: false, status: 'error', error: limitErr }); continue; }

    const startedAt = new Date().toISOString();
    try {
      // Per-flow deadline: a hung node (slow API, stuck LLM) must not stall the whole batch. The
      // timed-out run can't be aborted mid-flight, but we stop waiting and move on; the trailing
      // .catch keeps a late rejection from surfacing as an unhandled one.
      const run = runGraph(flow.graph, serverNodeRegistry, { userId: flow.user_id, services: buildRunServices(flow.user_id) });
      run.catch(() => { /* a rejection after the timeout below is already reported — don't let it go unhandled */ });
      const { order, outputs } = await Promise.race([
        run,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Flow timed out (120s)')), 120_000)),
      ]);
      // Publish step: render the generated post(s) headlessly and send them to Zernio per each Post
      // node's config. Publish errors don't fail the run — the graph itself succeeded.
      const publish = await publishFlowPosts(flow, outputs, origin, getBrowser)
        .catch((e: unknown) => ({ published: 0, errors: [e instanceof Error ? e.message : 'publish failed'], statusByNode: {} }));
      const status = publish.errors.length ? 'ok_publish_errors' : 'ok';
      await db.from('automation_runs').insert({ user_id: flow.user_id, automation_id: flow.id, status: 'ok', log: { startedAt, order, trigger: 'cron', publish, nodes: runLogNodes(outputs, order) }, finished_at: new Date().toISOString() });
      results.push({ id: flow.id, ran: true, status, published: publish.published, error: publish.errors.join('; ') || undefined });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Run failed';
      await db.from('automation_runs').insert({ user_id: flow.user_id, automation_id: flow.id, status: 'error', log: { startedAt, error, trigger: 'cron' }, finished_at: new Date().toISOString() });
      results.push({ id: flow.id, ran: true, status: 'error', error });
    }
  }

  // (cast: TS can't see the closure assignment above, so it narrows `browser` to its initial null)
  await (browser as Browser | null)?.close().catch(() => { /* function teardown reclaims it regardless */ });
  return NextResponse.json({ ok: true, ran: results.filter(r => r.ran).length, results });
}
