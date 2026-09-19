import type { Graph, NodeRegistry, RunOutputs, RunServices } from './types';
import { topoSort, resolveInputs } from './graph';
import { NODE_DESCRIPTORS } from './descriptors';

/** Run-wide context injected by the API route (absent in pure-engine tests). */
export interface RunBase {
  userId?: string;
  services?: RunServices;
}

/** Thrown when a node's run() fails or its type is unknown. v1 is fail-fast: one error stops the run.
 *  Carries the outputs of the nodes that DID complete (in order) so the UI can mark them succeeded. */
export class NodeRunError extends Error {
  public outputs: Record<string, RunOutputs> = {};
  constructor(
    public readonly nodeId: string,
    public readonly nodeType: string,
    public readonly cause: unknown,
  ) {
    super(`Node "${nodeId}" (${nodeType}) failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'NodeRunError';
  }
}

export interface RunResult {
  /** Per-node outputs, keyed by node id then output-port name. */
  outputs: Record<string, RunOutputs>;
  order: string[];
}

// Bound how much work one run can trigger: a big graph (or many AI nodes) is many model calls. Shared by
// the /run route and the cron runner so both enforce the same ceiling.
export const MAX_NODES = 60;
export const MAX_AI_NODES = 3;

/** Reject oversized graphs before running. Returns a human-readable error, or null if within limits. */
export function graphLimitError(graph: Graph): string | null {
  const nodes = graph.nodes ?? [];
  if (nodes.length > MAX_NODES) return `Flow too large — max ${MAX_NODES} nodes.`;
  if (nodes.filter(n => n.type === 'ai').length > MAX_AI_NODES) return `Too many AI nodes — max ${MAX_AI_NODES} per run.`;
  return null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sleep = (ms: number) => (ms > 0 ? new Promise<void>(r => setTimeout(r, ms)) : Promise.resolve());

/** Per-node error policy, read off the node's own config (descriptors expose these as params).
 *  Retry is refused for non-idempotent HTTP methods: a POST that timed out may have ALREADY applied
 *  on the remote side — re-sending it duplicates the write. (config.method only exists on http nodes.) */
function errorPolicy(config: Record<string, unknown>): { maxTries: number; waitMs: number; continueOnFail: boolean } {
  const method = typeof config.method === 'string' ? config.method.toUpperCase() : undefined;
  const idempotent = method === undefined || method === 'GET' || method === 'HEAD';
  const retry = config.retryOnFail === true && idempotent;
  const wait = Number(config.waitBetweenTries);
  return {
    maxTries: retry ? clamp(Math.trunc(Number(config.maxTries)) || 3, 2, 5) : 1,
    waitMs: clamp(Number.isFinite(wait) ? wait : 1000, 0, 5000),
    continueOnFail: config.continueOnFail === true,
  };
}

/**
 * Execute a graph synchronously in topological order (v1). Each node receives its resolved inputs
 * (item arrays per port) and returns outputs per port. Default is fail-fast: a node error throws a
 * NodeRunError and halts the run (decision §8) — but a node may opt into `retryOnFail` (bounded
 * re-attempts with a wait between tries, n8n-style) and/or `continueOnFail` (emit one { error } item
 * on its first output port and let the run go on). Designed to later grow a `wait()` path (final phase).
 */
export async function runGraph(graph: Graph, registry: NodeRegistry, base: RunBase = {}): Promise<RunResult> {
  const order = topoSort(graph);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const outputs: Record<string, RunOutputs> = {};
  // Same label derivation as the binding UI (AutomationsSection.incomingData) so binding paths that
  // address an upstream by label resolve identically at run time.
  const labelOf = (nodeId: string) => {
    const n = byId.get(nodeId);
    return n?.label || (n ? NODE_DESCRIPTORS[n.type]?.label : undefined) || nodeId;
  };

  for (const id of order) {
    const node = byId.get(id)!;
    const def = registry[node.type];
    const fail = (cause: unknown) => { const e = new NodeRunError(id, node.type, cause); e.outputs = outputs; return e; };
    if (!def) throw fail(new Error(`Unknown node type "${node.type}"`));
    const inputs = resolveInputs(node, graph.edges, outputs, labelOf);
    const config = node.config ?? {};
    const policy = errorPolicy(config);
    let lastError: unknown;
    let done = false;
    for (let attempt = 1; attempt <= policy.maxTries && !done; attempt++) {
      try {
        outputs[id] = await def.run({ config, inputs, userId: base.userId, services: base.services });
        done = true;
      } catch (err) {
        lastError = err;
        if (attempt < policy.maxTries) await sleep(policy.waitMs);
      }
    }
    if (!done) {
      if (!policy.continueOnFail) throw fail(lastError);
      // Same { error } shape the code node's own failure path uses — downstream checks recognise it.
      const port = node.outputs?.[0]?.id ?? 'out';
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      outputs[id] = { [port]: [{ json: { error: message } }] };
    }
  }

  return { outputs, order };
}

/** Transitive upstreams of `targetId` (everything it depends on), plus the target itself. */
function ancestorsInclusive(graph: Graph, targetId: string): Set<string> {
  const parents = new Map<string, string[]>();
  for (const e of graph.edges) {
    const arr = parents.get(e.to.node) ?? [];
    arr.push(e.from.node);
    parents.set(e.to.node, arr);
  }
  const keep = new Set<string>();
  const stack = [targetId];
  while (stack.length) {
    const id = stack.pop()!;
    if (keep.has(id)) continue;
    keep.add(id);
    for (const p of parents.get(id) ?? []) stack.push(p);
  }
  return keep;
}

/**
 * Run ONLY the subgraph that produces `targetId`'s output — the target node and all its transitive
 * upstreams, in topological order; nothing downstream, nothing on unrelated branches. This is how a
 * node's REAL output is grounded at build time (the field-mapping sample, and the agentic builder)
 * instead of test-running it with empty inputs, which is the main cause of "the template got the wrong
 * data": the sample you map against must be produced by the same upstream chain the real run uses.
 * Returns the same RunResult shape as runGraph (outputs keyed by node id, then port).
 */
export async function runGraphUpTo(
  graph: Graph,
  registry: NodeRegistry,
  targetId: string,
  base: RunBase = {},
): Promise<RunResult> {
  if (!graph.nodes.some(n => n.id === targetId)) throw new Error(`Unknown target node "${targetId}"`);
  const keep = ancestorsInclusive(graph, targetId);
  const sub: Graph = {
    nodes: graph.nodes.filter(n => keep.has(n.id)),
    edges: graph.edges.filter(e => keep.has(e.from.node) && keep.has(e.to.node)),
  };
  return runGraph(sub, registry, base);
}
