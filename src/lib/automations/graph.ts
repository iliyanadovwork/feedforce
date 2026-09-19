import type { Graph, Edge, FlowNode, RunInputs, RunOutputs } from './types';

/**
 * Topologically order the nodes for execution. Throws on a cycle (incl. self-loops). Isolated nodes
 * (no edges) are included. Dangling edges (referencing missing nodes) are ignored.
 * Kahn's algorithm over distinct node→node dependency pairs.
 */
export function topoSort(graph: Graph): string[] {
  const ids = graph.nodes.map(n => n.id);
  const idSet = new Set(ids);
  const indeg = new Map<string, number>();
  const adj = new Map<string, Set<string>>();
  for (const id of ids) { indeg.set(id, 0); adj.set(id, new Set()); }

  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (!idSet.has(e.from.node) || !idSet.has(e.to.node)) continue; // ignore dangling
    const key = `${e.from.node}->${e.to.node}`;
    if (seen.has(key)) continue;                                    // count a dependency once
    seen.add(key);
    adj.get(e.from.node)!.add(e.to.node);
    indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);          // self-loop ⇒ indeg never 0 ⇒ cycle
  }

  const queue = ids.filter(id => (indeg.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const to of adj.get(id)!) {
      const d = (indeg.get(to) ?? 0) - 1;
      indeg.set(to, d);
      if (d === 0) queue.push(to);
    }
  }

  if (order.length !== ids.length) throw new Error('Graph has a cycle');
  return order;
}

/**
 * Distinct display labels for a node's upstream sources, in edge order: the node's own label first,
 * else the fallback (descriptor label / node id); duplicates get " 2", " 3"… so two unlabeled "HTTP
 * request" nodes stay addressable separately. The binding UI derives labels the same way — keep in sync.
 */
export function sourceLabels(
  nodeId: string,
  edges: Edge[],
  labelOf: (nodeId: string) => string,
): Map<string, string> {
  const labels = new Map<string, string>();   // source node id → deduped label
  const used = new Map<string, number>();
  for (const e of edges) {
    if (e.to.node !== nodeId || labels.has(e.from.node)) continue;
    const base = labelOf(e.from.node);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    labels.set(e.from.node, n === 1 ? base : `${base} ${n}`);
  }
  return labels;
}

/**
 * Gather a node's inputs from upstream outputs already in the cache. Multiple edges into the same
 * input port concatenate (fan-in) — and since execution is topological, every upstream has already
 * finished: a node with several inputs inherently waits for all of them. Ports with no incoming edge
 * are simply absent. When `labelOf` is provided, each item is stamped with its source node's label so
 * fan-in consumers can expose inputs keyed by source.
 */
export function resolveInputs(
  node: FlowNode,
  edges: Edge[],
  cache: Record<string, RunOutputs>,
  labelOf?: (nodeId: string) => string,
): RunInputs {
  const labels = labelOf ? sourceLabels(node.id, edges, labelOf) : null;
  const inputs: RunInputs = {};
  for (const e of edges) {
    if (e.to.node !== node.id) continue;
    let upstream = cache[e.from.node]?.[e.from.port] ?? [];
    if (labels) {
      const source = labels.get(e.from.node);
      upstream = upstream.map(it => ({ ...it, source }));
    }
    inputs[e.to.port] = (inputs[e.to.port] ?? []).concat(upstream);
  }
  return inputs;
}
