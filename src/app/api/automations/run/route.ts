import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import type { Browser } from 'puppeteer-core';
import { runGraph, runGraphUpTo, NodeRunError, graphLimitError, type Graph } from '@/lib/automations';
import { GeminiError } from '@/lib/gemini';
import { serverNodeRegistry } from '@/lib/automations/serverNodes';
import { buildRunServices } from '@/lib/automations/serverContext';
import { runLogNodes } from '@/lib/automations/runLog';
import { publishFlowPosts, launchRenderBrowser, type PublishResult } from '@/lib/automations/serverPublish';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
// A run executes a whole graph — each AI node is budgeted 60s and HTTP nodes 15s — so it must be allowed
// to run well past the platform's default function timeout, or a legit multi-node flow gets a 504 mid-run.
export const maxDuration = 300;

// Run a whole flow graph now (synchronous, fail-fast). Returns per-node outputs, or the failing node.
// Records a row in automation_runs for the UI run log (best-effort; never blocks the run result).
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;

  // targetId → PARTIAL run (the node modal's "execute step"): only the target and its transitive
  // upstreams execute (engine runGraphUpTo), grounding the modal's input/output columns in real data.
  // runToken → publish dedup; tz → the browser's IANA zone, the scheduledFor fallback for Post-node
  // configs saved before tz-capture existed (server-side parsing must match the old client-side parse).
  const { graph, automationId, targetId, runToken, tz } = (await req.json().catch(() => ({}))) as {
    graph?: Graph; automationId?: string; targetId?: string; runToken?: string; tz?: string;
  };
  if (!graph || !Array.isArray(graph.nodes)) {
    return NextResponse.json({ error: 'Missing graph' }, { status: 400 });
  }
  const partial = typeof targetId === 'string' && targetId.length > 0;
  if (partial && !graph.nodes.some(n => n.id === targetId)) {
    return NextResponse.json({ error: 'Unknown target node' }, { status: 400 });
  }

  // Bound how much work one request can trigger: a large graph (or many AI nodes) is many model calls.
  const limitErr = graphLimitError(graph);
  if (limitErr) return NextResponse.json({ error: limitErr }, { status: 400 });

  // Rate-limit by cost: an AI-bearing flow spends shared Gemini quota → throttle tightly; a pure non-AI
  // flow only does HTTP/DB work → looser cap so iterating on it isn't painful.
  const hasAi = graph.nodes.some(n => n.type === 'ai');
  if (!(await rateLimit('automations:run:' + user.id, hasAi ? 2 : 10))) return tooManyRequests();

  const startedAt = new Date().toISOString();
  try {
    const base = { userId: user.id, services: buildRunServices(user.id) };
    const { outputs, order } = partial
      ? await runGraphUpTo(graph, serverNodeRegistry, targetId!, base)
      : await runGraph(graph, serverNodeRegistry, base);

    // Publish step — SERVER-side, the same headless path cron uses (serverPublish), so a manual run
    // completes even if the user closes the tab mid-run. Only pays the browser launch when a Post node
    // is actually configured. Publish errors don't fail the run — the graph itself succeeded.
    // NEVER publishes on a partial run: "execute step" is a debugging action, not a posting one.
    let publish: PublishResult | undefined;
    const hasConfiguredPost = !partial && graph.nodes.some(n => n.type === 'post' && typeof n.config?.accountId === 'string' && n.config.accountId);
    if (hasConfiguredPost) {
      // DEDUP — this route can run for minutes (headless rendering); a response lost in transit shows
      // "Run failed" on a canvas whose post WAS published, and the natural retry would double-post to a
      // live Instagram account. The client sends a fresh runToken per click; a token we've already seen
      // (recorded in automation_runs BEFORE publishing, below) means this is a retry of a request whose
      // publish already started — refuse to publish again.
      const token = typeof runToken === 'string' && runToken.length >= 8 ? runToken.slice(0, 64) : null;
      const nodeSamples = runLogNodes(outputs, order);
      if (token) {
        const { data: dupe } = await supabaseAdmin().from('automation_runs')
          .select('id').eq('user_id', user.id).contains('log', { runToken: token })
          .gte('started_at', new Date(Date.now() - 3600_000).toISOString()).limit(1).maybeSingle();
        if (dupe) {
          return NextResponse.json({
            ok: true, outputs, order,
            publish: { published: 0, errors: ['This run was already submitted — publishing was skipped to avoid a duplicate post. Check your account/schedule before running again.'], statusByNode: {} },
          });
        }
      }
      // Claim the token BEFORE publishing (one row, updated with the outcome after) — a response lost
      // in transit still leaves the claim behind, so the user's retry hits the dedup above instead of
      // double-posting.
      const claimId = await recordRun(user.id, automationId, 'running', { startedAt, order, nodes: nodeSamples, ...(token ? { runToken: token } : {}) });
      const origin = process.env.RENDER_ORIGIN || new URL(req.url).origin;
      let browser: Browser | null = null;
      try {
        publish = await publishFlowPosts(
          { id: automationId ?? 'manual', user_id: user.id, graph },
          outputs, origin, async () => (browser ??= await launchRenderBrowser()),
          { fallbackTz: typeof tz === 'string' && tz.trim() ? tz.trim() : undefined },
        );
      } catch (err) {
        publish = { published: 0, errors: [err instanceof Error ? err.message : 'publish failed'], statusByNode: {} };
      } finally {
        await (browser as Browser | null)?.close().catch(() => { /* function teardown reclaims it */ });
      }
      await updateRun(claimId, publish.errors.length ? 'ok_publish_errors' : 'ok',
        { startedAt, order, nodes: nodeSamples, ...(token ? { runToken: token } : {}), publish });
      return NextResponse.json({ ok: true, outputs, order, publish });
    } else {
      // No publish step ran — publishFlowPosts owns the cleanup when it runs, so sweep here: the
      // template node's generated posts are throwaway ephemeral snapshots and must not pile up in the
      // Carousels grid, one per test run. Best-effort (the section-mount sweep is the backstop).
      const generated = graph.nodes.filter(n => n.type === 'template').flatMap(n =>
        ((outputs[n.id]?.out ?? []) as Array<{ json?: { postId?: unknown } }>)
          .map(it => it?.json?.postId).filter((x): x is string => typeof x === 'string'));
      if (generated.length) await supabaseAdmin().from('template_editor_posts').delete().in('id', generated).then(() => {}, () => {});
    }

    // Persist per-node output SAMPLES (clipped), not just port names — the canvas hydrates its run
    // state from this row after a refresh, and the AI copilot grounds on it. Partial runs are NOT
    // recorded: the cron scheduler derives "due" from the latest automation_runs row, and a debugging
    // "execute step" must not push a real scheduled run back.
    if (!partial) {
      await recordRun(user.id, automationId, 'ok', { startedAt, order, nodes: runLogNodes(outputs, order), ...(publish ? { publish } : {}) });
    }
    return NextResponse.json({ ok: true, outputs, order, ...(publish ? { publish } : {}) });
  } catch (e) {
    const nodeId = e instanceof NodeRunError ? e.nodeId : undefined;
    // Outputs of the nodes that completed before the failure — so the UI greens them and reds the failer.
    const outputs = e instanceof NodeRunError ? e.outputs : undefined;
    const message = e instanceof Error ? e.message : 'Run failed';
    // Surface a real rate-limit/quota 429 (thrown in the AI node, wrapped in NodeRunError) as 429, so
    // clients can back off instead of treating it as a malformed-request 400.
    const cause = e instanceof NodeRunError ? e.cause : e;
    const status = cause instanceof GeminiError ? cause.status : 400;
    const nodeSamples = outputs ? runLogNodes(outputs, graph.nodes.map(n => n.id).filter(id => outputs[id])) : undefined;
    // Partial ("execute step") runs aren't recorded — see the success path.
    if (!partial) {
      await recordRun(user.id, automationId, 'error', { startedAt, error: message, nodeId, ...(nodeSamples ? { nodes: nodeSamples } : {}) });
    }
    return NextResponse.json({ error: message, nodeId, outputs }, { status });
  }
}

async function recordRun(userId: string, automationId: string | undefined, status: 'running' | 'ok' | 'error', log: unknown): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin().from('automation_runs').insert({
      user_id: userId,
      automation_id: automationId ?? null,
      status,
      log,
      ...(status === 'running' ? {} : { finished_at: new Date().toISOString() }),
    }).select('id').single();
    return (data as { id?: string } | null)?.id ?? null;
  } catch { return null; /* run-log write is best-effort */ }
}

/** Finalise a claim row recorded before publishing (recordRun status 'running'). Best-effort. */
async function updateRun(id: string | null, status: string, log: unknown) {
  if (!id) return;
  try {
    await supabaseAdmin().from('automation_runs').update({ status, log, finished_at: new Date().toISOString() }).eq('id', id);
  } catch { /* best-effort */ }
}
