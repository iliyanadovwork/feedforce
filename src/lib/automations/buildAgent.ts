import type { Graph } from './types';
import type { RunResult } from './engine';
import { instantiate } from './descriptors';

// The agentic "build my data pipeline" loop. From a natural-language goal it: discovers a data source
// (web-search grounded, keyless-preferred), builds + RUNS the HTTP node against real data, repairs the
// config until data comes back, decides whether a Code transform is needed and authors+tests it, then
// wires the result into the Apply Template node's `data` input. Success = real, structured data reaches
// that input. It never asks for a URL or a template — the ONE thing it can pause for is an API key.
//
// Deterministic vs model: the model discovers the source, authors/repairs config + code, and decides if a
// transform is needed; everything else (assembling/wiring the graph, RUNNING nodes to ground each step,
// the non-empty/structured check, the caps) is code here. LLM + node execution are injected so the loop
// is unit-testable without a live API.

export interface AgentStep { kind: 'info' | 'ok' | 'warn' | 'error'; message: string }

export type BuildOutcome =
  | { status: 'need_key'; graph: Graph; httpNodeId: string; message: string; steps: AgentStep[] }
  | { status: 'done'; graph: Graph; summary: string; steps: AgentStep[] }
  | { status: 'failed'; graph: Graph; message: string; steps: AgentStep[] };

/** A discovered/repaired HTTP source config. */
export interface SourcePlan {
  url: string;
  method?: string;          // GET only auto-runs; a write method is built but not fired
  authKind?: 'none' | 'apiKey';
  needsKey?: boolean;       // the model believes a key is required
  note?: string;            // one-line rationale, surfaced as a progress step
}

export interface CodePlan {
  needsCode: boolean;
  code?: string;            // an `export default function run(ctx){…}` transform
  note?: string;
}

export interface AgentLLM {
  /** Web-search-grounded free text — used to discover an API for the goal. */
  discover(goal: string, priorAttempts: string[]): Promise<string>;
  /** Structured HTTP-source plan from the discovery notes (+ repair context). */
  planSource(goal: string, discovery: string, failure?: string): Promise<SourcePlan>;
  /** Decide whether a transform is needed, and author it, grounded in a real data sample. */
  planCode(goal: string, sample: unknown, failure?: string): Promise<CodePlan>;
}

export interface AgentDeps {
  llm: AgentLLM;
  /** Run the graph up to targetId and return the engine result (throws NodeRunError on a node failure). */
  runUpTo: (graph: Graph, targetId: string) => Promise<RunResult>;
  onStep?: (s: AgentStep) => void;
  maxRepairs?: number;      // per phase (default 3)
}

export interface AgentInput {
  goal: string;
  resume?: { graph: Graph; httpNodeId: string };
  credentialId?: string;
}

const HTTP_ID = 'source';
const CODE_ID = 'transform';
const TEMPLATE_ID = 'template';

/** Is this a real, structured payload we can map into a template (object or non-empty array — not a bare
 *  string, which is what the HTTP node emits when the response wasn't JSON)? */
export function looksStructured(d: unknown): boolean {
  if (Array.isArray(d)) return d.length > 0;
  return d != null && typeof d === 'object' && Object.keys(d as object).length > 0;
}

/** Fresh trigger → http → template skeleton (template left unconfigured — the user picks it + maps). */
function baseGraph(): Graph {
  const trigger = instantiate('trigger', 'trigger', 0, 0);
  const http = instantiate('http', HTTP_ID, 260, 0);
  const template = instantiate('template', TEMPLATE_ID, 780, 0);
  return {
    nodes: [trigger, http, template],
    edges: [
      { id: 'e_trig', from: { node: 'trigger', port: 'out' }, to: { node: HTTP_ID, port: 'in' } },
      { id: 'e_data', from: { node: HTTP_ID, port: 'out' }, to: { node: TEMPLATE_ID, port: 'data' } },
    ],
  } as Graph;
}

function setHttpConfig(graph: Graph, plan: SourcePlan, credentialId?: string): void {
  const http = graph.nodes.find(n => n.id === HTTP_ID);
  if (!http) return;
  http.config = {
    ...http.config,
    method: (plan.method ?? 'GET').toUpperCase(),
    url: plan.url,
    authentication: plan.authKind === 'apiKey' || credentialId ? 'apiKey' : 'none',
    ...(credentialId ? { credentialId } : {}),
  };
}

/** Insert a Code node between the HTTP source and the template (source → code → template). */
function insertCodeNode(graph: Graph, code: string): void {
  const codeNode = instantiate('code', CODE_ID, 520, 140);
  codeNode.config = { ...codeNode.config, code };
  graph.nodes.push(codeNode);
  graph.edges = graph.edges.filter(e => !(e.from.node === HTTP_ID && e.to.node === TEMPLATE_ID));
  graph.edges.push({ id: 'e_xf_in', from: { node: HTTP_ID, port: 'out' }, to: { node: CODE_ID, port: 'in' } });
  graph.edges.push({ id: 'e_xf_out', from: { node: CODE_ID, port: 'out' }, to: { node: TEMPLATE_ID, port: 'data' } });
}

/** Extract a node's first output item json from an engine result. */
function nodeOut(res: RunResult, nodeId: string): Record<string, unknown> | undefined {
  return res.outputs[nodeId]?.out?.[0]?.json as Record<string, unknown> | undefined;
}

/** True when a run error (or an HTTP status) indicates the source needs authentication. */
function isAuthError(status: number | undefined, message: string): boolean {
  if (status === 401 || status === 403) return true;
  return /\b401\b|\b403\b|unauthor|forbidden|api[\s-]?key|auth/i.test(message);
}

export async function runBuildAgent(input: AgentInput, deps: AgentDeps): Promise<BuildOutcome> {
  const steps: AgentStep[] = [];
  const maxRepairs = deps.maxRepairs ?? 3;
  const step = (kind: AgentStep['kind'], message: string) => {
    const s = { kind, message };
    steps.push(s);
    deps.onStep?.(s);
  };

  // ── Resume vs fresh build ────────────────────────────────────────────────
  let graph: Graph;
  if (input.resume) {
    graph = input.resume.graph;
    const http = graph.nodes.find(n => n.id === input.resume!.httpNodeId);
    if (http) http.config = { ...http.config, authentication: 'apiKey', ...(input.credentialId ? { credentialId: input.credentialId } : {}) };
    step('info', 'Got the key — retrying the source…');
  } else {
    step('info', 'Searching the web for a data source…');
    const discovery = await deps.llm.discover(input.goal, []);
    const plan = await deps.llm.planSource(input.goal, discovery);
    step('info', plan.note ? `Trying ${plan.url} — ${plan.note}` : `Trying ${plan.url}`);
    graph = baseGraph();
    setHttpConfig(graph, plan);
    // The model already suspects a key is required and none is attached → pause up front.
    if (plan.needsKey && plan.authKind === 'apiKey') {
      step('warn', 'This source needs an API key.');
      return { status: 'need_key', graph, httpNodeId: HTTP_ID, steps,
        message: `The API I found (${plan.url}) needs an API key. Paste your key and I’ll continue.` };
    }
  }

  // ── Phase 1: get real, structured data out of the HTTP node ──────────────
  const tried: string[] = [];
  let sample: unknown; // the structured payload from the successful run — phase 2 grounds on it
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const http = graph.nodes.find(n => n.id === HTTP_ID);
    const url = String(http?.config?.url ?? '');
    tried.push(url);
    let out: Record<string, unknown> | undefined;
    let failure = '';
    try {
      const res = await deps.runUpTo(graph, HTTP_ID);
      out = nodeOut(res, HTTP_ID);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }

    const status = out?.status as number | undefined;
    const ok = out?.ok === true;
    const data = out?.data;

    if (!failure && ok && looksStructured(data)) {
      sample = data;
      step('ok', 'Got structured data from the source ✓');
      break;
    }
    // Needs a key → pause (unless we're already resuming with one attached).
    if (isAuthError(status, failure) && !graph.nodes.find(n => n.id === HTTP_ID)?.config?.credentialId) {
      step('warn', 'The source rejected the request — it needs an API key.');
      return { status: 'need_key', graph, httpNodeId: HTTP_ID, steps,
        message: `The API (${url}) needs an API key. Paste your key and I’ll continue.` };
    }
    if (attempt === maxRepairs) {
      step('error', 'Could not get usable data from a source after several tries.');
      return { status: 'failed', graph, steps,
        message: 'I couldn’t find an API that returns usable data for this. Try describing the data source more specifically, or connect an HTTP node yourself.' };
    }
    // Repair: re-discover + re-plan with the failure context, then update the HTTP node.
    const why = failure || (status ? `HTTP ${status}` : looksStructured(data) ? 'ok' : 'response was not usable JSON');
    step('info', `That didn’t return usable data (${why}) — trying another source…`);
    const discovery = await deps.llm.discover(input.goal, tried);
    const plan = await deps.llm.planSource(input.goal, discovery, `Previous URL(s) ${tried.join(', ')} failed: ${why}. Pick a DIFFERENT working endpoint, prefer no-auth.`);
    setHttpConfig(graph, plan, graph.nodes.find(n => n.id === HTTP_ID)?.config?.credentialId as string | undefined);
  }

  // ── Phase 2: decide + build a Code transform if the shape needs it ───────
  // Grounds on the sample captured in phase 1 — no extra live call to the source here: a re-run was an
  // UNGUARDED second hit on an external API that could flake and crash the whole build after success.
  let dataNodeId = HTTP_ID;
  const codePlan = await deps.llm.planCode(input.goal, sample);
  if (codePlan.needsCode && codePlan.code) {
    step('info', codePlan.note ? `Shaping the data — ${codePlan.note}` : 'Adding a transform to shape the data…');
    insertCodeNode(graph, codePlan.code);
    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      let out: unknown;
      let failure = '';
      try {
        const res = await deps.runUpTo(graph, CODE_ID);
        out = nodeOut(res, CODE_ID);
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
      if (!failure && (looksStructured(out) || (Array.isArray(out) && out.length > 0))) {
        step('ok', 'Transform is producing clean data ✓');
        dataNodeId = CODE_ID;
        break;
      }
      if (attempt === maxRepairs) {
        // The transform never settled — fall back to the raw source (still real data at the template).
        step('warn', 'Couldn’t get the transform right — leaving the raw source data on the template.');
        graph.edges = graph.edges.filter(e => e.to.node !== CODE_ID && e.from.node !== CODE_ID);
        graph.nodes = graph.nodes.filter(n => n.id !== CODE_ID);
        graph.edges.push({ id: 'e_data', from: { node: HTTP_ID, port: 'out' }, to: { node: TEMPLATE_ID, port: 'data' } });
        dataNodeId = HTTP_ID;
        break;
      }
      const why = failure || 'the transform returned nothing usable';
      step('info', `Fixing the transform (${why})…`);
      const repaired = await deps.llm.planCode(input.goal, sample, `The code failed: ${why}. Fix it. It must return an object or a non-empty array.`);
      const codeNode = graph.nodes.find(n => n.id === CODE_ID);
      if (codeNode && repaired.code) codeNode.config = { ...codeNode.config, code: repaired.code };
    }
  }

  step('ok', 'Data is flowing into Apply Template. Pick a template and map the fields to finish.');
  return { status: 'done', graph, steps,
    summary: dataNodeId === CODE_ID
      ? 'Built a timer → HTTP source → transform → Apply Template. Real data is reaching the template — pick a template and map the fields.'
      : 'Built a timer → HTTP source → Apply Template. Real data is reaching the template — pick a template and map the fields.' };
}
