import { describe, it, expect } from 'vitest';
import { runGraph, runGraphUpTo, NodeRunError } from './engine';
import type { Graph, NodeRegistry } from './types';

const g = (nodes: Array<[string, string]>, edges: Array<[string, string, string, string]>): Graph => ({
  nodes: nodes.map(([id, type]) => ({ id, type, inputs: [], outputs: [] })),
  edges: edges.map(([fn, fp, tn, tp], i) => ({ id: String(i), from: { node: fn, port: fp }, to: { node: tn, port: tp } })),
});

describe('runGraph', () => {
  it('runs source → transform → sink and passes items through', async () => {
    const registry: NodeRegistry = {
      source: { id: 'source', run: () => ({ out: [{ json: { n: 1 } }, { json: { n: 2 } }] }) },
      double: { id: 'double', run: ({ inputs }) => ({ out: (inputs.in ?? []).map(it => ({ json: { n: (it.json.n as number) * 2 } })) }) },
      sink: { id: 'sink', run: ({ inputs }) => ({ collected: inputs.in ?? [] }) },
    };
    const graph = g(
      [['s', 'source'], ['d', 'double'], ['k', 'sink']],
      [['s', 'out', 'd', 'in'], ['d', 'out', 'k', 'in']],
    );
    const { outputs, order } = await runGraph(graph, registry);
    expect(order.indexOf('s')).toBeLessThan(order.indexOf('d'));
    expect(outputs.d.out).toEqual([{ json: { n: 2 } }, { json: { n: 4 } }]);
    // Inputs are stamped with their source node's label (id here — no label/descriptor) by resolveInputs.
    expect(outputs.k.collected).toEqual([{ json: { n: 2 }, source: 'd' }, { json: { n: 4 }, source: 'd' }]);
  });

  it('stamps fan-in items with deduped source labels', async () => {
    const registry: NodeRegistry = {
      emit: { id: 'emit', run: ({ config }) => ({ out: [{ json: { v: config.v } }] }) },
      sink: { id: 'sink', run: ({ inputs }) => ({ collected: inputs.in ?? [] }) },
    };
    const graph = g(
      [['a', 'emit'], ['b', 'emit'], ['c', 'emit'], ['k', 'sink']],
      [['a', 'out', 'k', 'in'], ['b', 'out', 'k', 'in'], ['c', 'out', 'k', 'in']],
    );
    graph.nodes[0].config = { v: 1 }; graph.nodes[1].config = { v: 2 }; graph.nodes[2].config = { v: 3 };
    graph.nodes[0].label = 'Prices';      // explicit label wins
    graph.nodes[1].label = 'Prices';      // duplicate → numbered
    const { outputs } = await runGraph(graph, registry);
    expect(outputs.k.collected.map(i => i.source)).toEqual(['Prices', 'Prices 2', 'c']);
  });

  it('reads config and supports fan-out → fan-in', async () => {
    const registry: NodeRegistry = {
      emit: { id: 'emit', run: ({ config }) => ({ out: Array.from({ length: config.count as number }, (_, i) => ({ json: { i } })) }) },
      pass: { id: 'pass', run: ({ inputs }) => ({ out: inputs.in ?? [] }) },
      merge: { id: 'merge', run: ({ inputs }) => ({ out: inputs.in ?? [] }) },
    };
    const graph = g(
      [['e', 'emit'], ['a', 'pass'], ['b', 'pass'], ['m', 'merge']],
      [['e', 'out', 'a', 'in'], ['e', 'out', 'b', 'in'], ['a', 'out', 'm', 'in'], ['b', 'out', 'm', 'in']],
    );
    graph.nodes[0].config = { count: 3 };
    const { outputs } = await runGraph(graph, registry);
    expect(outputs.e.out).toHaveLength(3);
    expect(outputs.m.out).toHaveLength(6); // 3 via a + 3 via b
  });

  it('awaits async node run()', async () => {
    const registry: NodeRegistry = {
      asyncSrc: { id: 'asyncSrc', run: async () => { await Promise.resolve(); return { out: [{ json: { ok: true } }] }; } },
    };
    const { outputs } = await runGraph(g([['a', 'asyncSrc']], []), registry);
    expect(outputs.a.out).toEqual([{ json: { ok: true } }]);
  });

  it('fails fast with NodeRunError when a node throws', async () => {
    const registry: NodeRegistry = { boom: { id: 'boom', run: () => { throw new Error('kaboom'); } } };
    const graph = g([['x', 'boom']], []);
    await expect(runGraph(graph, registry)).rejects.toBeInstanceOf(NodeRunError);
    await expect(runGraph(graph, registry)).rejects.toThrow(/kaboom/);
  });

  it('carries the completed nodes outputs on the error (for green/red UI)', async () => {
    const registry: NodeRegistry = {
      ok: { id: 'ok', run: () => ({ out: [{ json: { v: 1 } }] }) },
      boom: { id: 'boom', run: () => { throw new Error('stop'); } },
    };
    const graph = g([['a', 'ok'], ['b', 'boom']], [['a', 'out', 'b', 'in']]);
    let err: NodeRunError | undefined;
    try { await runGraph(graph, registry); } catch (e) { err = e as NodeRunError; }
    expect(err).toBeInstanceOf(NodeRunError);
    expect(err!.nodeId).toBe('b');
    expect(err!.outputs.a.out).toEqual([{ json: { v: 1 } }]); // 'a' completed before 'b' failed
    expect(err!.outputs.b).toBeUndefined();                    // 'b' produced nothing
  });

  it('does not run downstream nodes after an upstream failure', async () => {
    let ranDownstream = false;
    const registry: NodeRegistry = {
      boom: { id: 'boom', run: () => { throw new Error('stop'); } },
      after: { id: 'after', run: () => { ranDownstream = true; return {}; } },
    };
    const graph = g([['x', 'boom'], ['y', 'after']], [['x', 'out', 'y', 'in']]);
    await expect(runGraph(graph, registry)).rejects.toBeInstanceOf(NodeRunError);
    expect(ranDownstream).toBe(false);
  });

  it('throws NodeRunError for an unknown node type', async () => {
    await expect(runGraph(g([['x', 'nope']], []), {})).rejects.toThrow(/Unknown node type/);
  });

  it('propagates a cycle error from topoSort', async () => {
    const graph = g([['a', 'pass'], ['b', 'pass']], [['a', 'o', 'b', 'i'], ['b', 'o', 'a', 'i']]);
    await expect(runGraph(graph, { pass: { id: 'pass', run: () => ({}) } })).rejects.toThrow(/cycle/i);
  });

  it('retryOnFail re-attempts a failing node and succeeds without surfacing the earlier failures', async () => {
    let calls = 0;
    const registry: NodeRegistry = {
      flaky: { id: 'flaky', run: () => { if (++calls < 3) throw new Error('503'); return { out: [{ json: { ok: true } }] }; } },
    };
    const graph = g([['x', 'flaky']], []);
    graph.nodes[0].config = { retryOnFail: true, maxTries: 3, waitBetweenTries: 0 };
    const { outputs } = await runGraph(graph, registry);
    expect(calls).toBe(3);
    expect(outputs.x.out).toEqual([{ json: { ok: true } }]);
  });

  it('retryOnFail gives up after maxTries (clamped 2–5) and fails the run by default', async () => {
    let calls = 0;
    const registry: NodeRegistry = { flaky: { id: 'flaky', run: () => { calls++; throw new Error('down'); } } };
    const graph = g([['x', 'flaky']], []);
    graph.nodes[0].config = { retryOnFail: true, maxTries: 99, waitBetweenTries: 0 }; // clamps to 5
    await expect(runGraph(graph, registry)).rejects.toThrow(/down/);
    expect(calls).toBe(5);
  });

  it('refuses to retry non-idempotent HTTP methods (a timed-out POST may already have applied)', async () => {
    let calls = 0;
    const registry: NodeRegistry = { flaky: { id: 'flaky', run: () => { calls++; throw new Error('timeout'); } } };
    const graph = g([['x', 'flaky']], []);
    graph.nodes[0].config = { method: 'POST', retryOnFail: true, maxTries: 5, waitBetweenTries: 0 };
    await expect(runGraph(graph, registry)).rejects.toThrow(/timeout/);
    expect(calls).toBe(1); // no re-send of a write
  });

  it('without retryOnFail a node runs exactly once', async () => {
    let calls = 0;
    const registry: NodeRegistry = { boom: { id: 'boom', run: () => { calls++; throw new Error('stop'); } } };
    await expect(runGraph(g([['x', 'boom']], []), registry)).rejects.toBeInstanceOf(NodeRunError);
    expect(calls).toBe(1);
  });

  it('continueOnFail emits one { error } item on the first output port and the run goes on', async () => {
    const registry: NodeRegistry = {
      boom: { id: 'boom', run: () => { throw new Error('kaput'); } },
      sink: { id: 'sink', run: ({ inputs }) => ({ collected: inputs.in ?? [] }) },
    };
    const graph = g([['x', 'boom'], ['k', 'sink']], [['x', 'out', 'k', 'in']]);
    graph.nodes[0].config = { continueOnFail: true };
    graph.nodes[0].outputs = [{ id: 'out', name: 'Out', dataType: 'any' }];
    const { outputs, order } = await runGraph(graph, registry);
    expect(outputs.x.out).toEqual([{ json: { error: 'kaput' } }]);
    expect(outputs.k.collected).toEqual([{ json: { error: 'kaput' }, source: 'x' }]); // downstream still ran
    expect(order).toEqual(['x', 'k']);
  });

  it('retryOnFail + continueOnFail: retries first, then continues with the { error } item', async () => {
    let calls = 0;
    const registry: NodeRegistry = { flaky: { id: 'flaky', run: () => { calls++; throw new Error('always down'); } } };
    const graph = g([['x', 'flaky']], []);
    graph.nodes[0].config = { retryOnFail: true, maxTries: 2, waitBetweenTries: 0, continueOnFail: true };
    const { outputs } = await runGraph(graph, registry);
    expect(calls).toBe(2);
    expect(outputs.x.out).toEqual([{ json: { error: 'always down' } }]);
  });
});

describe('runGraphUpTo', () => {
  it('runs only the target and its upstreams — skips downstream and unrelated branches', async () => {
    const ran = new Set<string>();
    const registry: NodeRegistry = {
      emit: { id: 'emit', run: ({ config }) => { ran.add(config.tag as string); return { out: [{ json: { v: config.v } }] }; } },
      pass: { id: 'pass', run: ({ inputs, config }) => { ran.add(config.tag as string); return { out: inputs.in ?? [] }; } },
    };
    // s → m → t(target) → d(downstream) ; u is an unrelated source
    const graph = g(
      [['s', 'emit'], ['m', 'pass'], ['t', 'pass'], ['d', 'pass'], ['u', 'emit']],
      [['s', 'out', 'm', 'in'], ['m', 'out', 't', 'in'], ['t', 'out', 'd', 'in']],
    );
    graph.nodes[0].config = { tag: 's', v: 1 };
    graph.nodes[1].config = { tag: 'm' };
    graph.nodes[2].config = { tag: 't' };
    graph.nodes[3].config = { tag: 'd' };
    graph.nodes[4].config = { tag: 'u', v: 9 };
    const { outputs } = await runGraphUpTo(graph, registry, 't');
    expect(ran).toEqual(new Set(['s', 'm', 't']));   // not 'd' (downstream), not 'u' (unrelated)
    expect(outputs.t.out).toEqual([{ json: { v: 1 }, source: 'm' }]); // real data flowed s→m→t
    expect(outputs.d).toBeUndefined();
  });

  it('grounds a node with its REAL upstream input (the fix for empty-input test-runs)', async () => {
    const registry: NodeRegistry = {
      src: { id: 'src', run: () => ({ out: [{ json: { name: 'BTC', price: 42 } }] }) },
      xform: { id: 'xform', run: ({ inputs }) => ({ out: (inputs.in ?? []).map(it => ({ json: { ticker: (it.json as { name: string }).name } })) }) },
    };
    const graph = g([['a', 'src'], ['b', 'xform']], [['a', 'out', 'b', 'in']]);
    const { outputs } = await runGraphUpTo(graph, registry, 'b');
    // xform built fresh output items, so they carry no source stamp — the point is `name` reached it.
    expect(outputs.b.out).toEqual([{ json: { ticker: 'BTC' } }]);
  });

  it('throws for an unknown target node', async () => {
    await expect(runGraphUpTo(g([['a', 'pass']], []), { pass: { id: 'pass', run: () => ({}) } }, 'zzz'))
      .rejects.toThrow(/Unknown target/);
  });
});
