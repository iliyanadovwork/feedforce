import { describe, it, expect } from 'vitest';
import { runBuildAgent, looksStructured, type AgentLLM, type SourcePlan, type CodePlan } from './buildAgent';
import type { Graph } from './types';
import type { RunResult } from './engine';

// An HTTP-node engine result with the {status,ok,data} envelope the real http node emits.
const httpRes = (status: number, ok: boolean, data: unknown): RunResult =>
  ({ outputs: { source: { out: [{ json: { status, ok, data } }] } }, order: ['trigger', 'source'] });
const codeRes = (json: unknown): RunResult =>
  ({ outputs: { transform: { out: [{ json: json as Record<string, unknown> }] } }, order: ['transform'] });

const llm = (o: Partial<AgentLLM> = {}): AgentLLM => ({
  discover: async () => 'api.example.com/data',
  planSource: async (): Promise<SourcePlan> => ({ url: 'https://good.api/data', authKind: 'none' }),
  planCode: async (): Promise<CodePlan> => ({ needsCode: false }),
  ...o,
});

// runUpTo keyed on the current HTTP url + the requested target node.
const runner = (fn: (url: string, targetId: string) => RunResult) =>
  async (graph: Graph, targetId: string) => {
    const url = String(graph.nodes.find(n => n.id === 'source')?.config?.url ?? '');
    return fn(url, targetId);
  };

describe('looksStructured', () => {
  it('accepts objects and non-empty arrays; rejects strings/empties/null', () => {
    expect(looksStructured({ a: 1 })).toBe(true);
    expect(looksStructured([1])).toBe(true);
    expect(looksStructured('hi')).toBe(false);
    expect(looksStructured([])).toBe(false);
    expect(looksStructured({})).toBe(false);
    expect(looksStructured(null)).toBe(false);
  });
});

describe('runBuildAgent', () => {
  it('happy path: source returns structured data, no transform needed → done', async () => {
    const out = await runBuildAgent({ goal: 'bitcoin price' }, {
      llm: llm(),
      runUpTo: runner(() => httpRes(200, true, { price: 42 })),
    });
    expect(out.status).toBe('done');
    expect(out.graph.nodes.find(n => n.id === 'transform')).toBeUndefined(); // no code node
    // real data path source → template
    expect(out.graph.edges.some(e => e.from.node === 'source' && e.to.node === 'template')).toBe(true);
  });

  it('pauses for a key when the plan says one is required', async () => {
    const out = await runBuildAgent({ goal: 'x' }, {
      llm: llm({ planSource: async () => ({ url: 'https://api/data', authKind: 'apiKey', needsKey: true }) }),
      runUpTo: runner(() => httpRes(200, true, { a: 1 })),
    });
    expect(out.status).toBe('need_key');
    if (out.status === 'need_key') expect(out.httpNodeId).toBe('source');
  });

  it('pauses for a key when the source returns 401/403 at run time', async () => {
    const out = await runBuildAgent({ goal: 'x' }, {
      llm: llm(),
      runUpTo: runner(() => httpRes(403, false, 'forbidden')),
    });
    expect(out.status).toBe('need_key');
  });

  it('repairs a failing source and succeeds on a working endpoint', async () => {
    let sp = 0;
    const out = await runBuildAgent({ goal: 'x' }, {
      llm: llm({ planSource: async () => (sp++ === 0 ? { url: 'https://bad.api', authKind: 'none' } : { url: 'https://good.api', authKind: 'none' }) }),
      runUpTo: runner((url) => (url.includes('bad') ? httpRes(404, false, 'not found') : httpRes(200, true, { ok: 1 }))),
    });
    expect(out.status).toBe('done');
    expect(out.graph.nodes.find(n => n.id === 'source')?.config?.url).toBe('https://good.api');
  });

  it('inserts + tests a Code transform when the model asks for one', async () => {
    const out = await runBuildAgent({ goal: 'x' }, {
      llm: llm({ planCode: async () => ({ needsCode: true, code: 'export default function run(ctx){ return { rows: ctx.input }; }' }) }),
      runUpTo: runner((_url, target) => (target === 'transform' ? codeRes({ rows: [1, 2] }) : httpRes(200, true, [{ a: 1 }]))),
    });
    expect(out.status).toBe('done');
    expect(out.graph.nodes.find(n => n.id === 'transform')).toBeDefined();
    expect(out.graph.edges.some(e => e.from.node === 'transform' && e.to.node === 'template')).toBe(true);
    expect(out.graph.edges.some(e => e.from.node === 'source' && e.to.node === 'transform')).toBe(true);
  });

  it('falls back to the raw source when the transform never settles', async () => {
    const out = await runBuildAgent({ goal: 'x' }, {
      llm: llm({ planCode: async () => ({ needsCode: true, code: 'export default function run(){ return null; }' }) }),
      runUpTo: runner((_url, target) => (target === 'transform' ? codeRes(null) : httpRes(200, true, { a: 1 }))),
      maxRepairs: 1,
    });
    expect(out.status).toBe('done');
    expect(out.graph.nodes.find(n => n.id === 'transform')).toBeUndefined(); // removed
    expect(out.graph.edges.some(e => e.from.node === 'source' && e.to.node === 'template')).toBe(true);
  });

  it('resumes with a credential attached to the source', async () => {
    const first = await runBuildAgent({ goal: 'x' }, {
      llm: llm({ planSource: async () => ({ url: 'https://api/data', authKind: 'apiKey', needsKey: true }) }),
      runUpTo: runner(() => httpRes(200, true, { a: 1 })),
    });
    expect(first.status).toBe('need_key');
    const resumed = await runBuildAgent(
      { goal: 'x', resume: { graph: first.graph, httpNodeId: 'source' }, credentialId: 'cred_123' },
      { llm: llm(), runUpTo: runner(() => httpRes(200, true, { a: 1 })) },
    );
    expect(resumed.status).toBe('done');
    expect(resumed.graph.nodes.find(n => n.id === 'source')?.config?.credentialId).toBe('cred_123');
  });

  it('grounds phase 2 on the phase-1 sample — a source flake after success cannot crash the build', async () => {
    let sourceRuns = 0;
    let sampleSeen: unknown;
    const out = await runBuildAgent({ goal: 'x' }, {
      llm: llm({ planCode: async (_g, sample) => { sampleSeen = sample; return { needsCode: false }; } }),
      runUpTo: async (graph, targetId) => {
        if (targetId === 'source' && ++sourceRuns > 1) throw new Error('source flaked');
        return runner(() => httpRes(200, true, { a: 1 }))(graph, targetId);
      },
    });
    expect(out.status).toBe('done');
    expect(sourceRuns).toBe(1);              // no unguarded re-run between phases
    expect(sampleSeen).toEqual({ a: 1 });    // planCode still sees the real data sample
  });

  it('gives up cleanly when no source ever returns usable data', async () => {
    const out = await runBuildAgent({ goal: 'x' }, {
      llm: llm(),
      runUpTo: runner(() => httpRes(500, false, 'server error')),
      maxRepairs: 1,
    });
    expect(out.status).toBe('failed');
  });
});
