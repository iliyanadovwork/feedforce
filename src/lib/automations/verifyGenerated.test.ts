import { describe, expect, it, vi } from 'vitest';
import { verifyGeneratedCodeNodes, ungroundedHttpUpstreams, verifyMappings, verifyTemplateConfig } from './verifyGenerated';
import { serverNodeRegistry } from './serverNodes';
import type { Edge, FlowNode } from './types';

const node = (id: string, type: string, label: string, code?: string): FlowNode => ({
  id, type, label, x: 0, y: 0, inputs: [{ id: 'in', name: 'In', dataType: 'any' }], outputs: [{ id: 'out', name: 'Out', dataType: 'any' }],
  config: code !== undefined ? { code } : {},
} as FlowNode);
const edge = (from: string, to: string): Edge => ({ id: `${from}->${to}`, from: { node: from, port: 'out' }, to: { node: to, port: 'in' } });

// The real vm runner, plumbed the same way the generate route does it.
const vmRun = async (code: string, input: unknown) => {
  const res = await serverNodeRegistry.code.run({ config: { code }, inputs: { in: [{ json: { data: input } as Record<string, unknown> }] } });
  return res.out ?? [];
};

const COINS = [
  { name: 'Bitcoin', symbol: 'btc', current_price: 64987, price_change_percentage_24h: 0.77 },
  { name: 'Ethereum', symbol: 'eth', current_price: 1928, price_change_percentage_24h: 3.19 },
];

describe('verifyGeneratedCodeNodes', () => {
  it('statically rejects label-keyed ctx.input on a single-upstream code node (no run data needed)', async () => {
    const runCode = vi.fn();
    const problems = await verifyGeneratedCodeNodes(
      [node('a', 'http', 'Source'), node('b', 'code', 'Extract', 'export default function run(ctx){ return ctx.input["Source"]; }')],
      [edge('a', 'b')],
      new Map(),
      runCode,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/ONE upstream/);
    expect(runCode).not.toHaveBeenCalled();
  });

  it('skips the static rule for fan-in (2+ upstreams), where label-keying is correct', async () => {
    const problems = await verifyGeneratedCodeNodes(
      [node('a', 'http', 'A'), node('a2', 'http', 'B'), node('b', 'code', 'Merge', 'export default function run(ctx){ return ctx.input["A"]; }')],
      [edge('a', 'b'), edge('a2', 'b')],
      new Map(),
      vi.fn(),
    );
    expect(problems).toEqual([]);
  });

  it('executes against the upstream\'s real emitted data and flags {error}-shaped results', async () => {
    const broken = 'export default function run(ctx){ const c = Array.isArray(ctx.input.data) ? ctx.input.data : []; if (!c.length) return { error: "No top gainer data found" }; return c[0]; }';
    const problems = await verifyGeneratedCodeNodes(
      [node('a', 'http', 'CoinGecko'), node('b', 'code', 'Extract', broken)],
      [edge('a', 'b')],
      new Map([['CoinGecko', { status: 200, ok: true, data: COINS }]]),
      vmRun,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/failure path fired/);
  });

  it('passes code that works on the real data', async () => {
    const good = 'export default function run(ctx){ const c = ctx.input; const top = [...c].sort((x,y)=>y.price_change_percentage_24h-x.price_change_percentage_24h)[0]; return { name: top.name, price: top.current_price }; }';
    const problems = await verifyGeneratedCodeNodes(
      [node('a', 'http', 'CoinGecko'), node('b', 'code', 'Extract', good)],
      [edge('a', 'b')],
      new Map([['CoinGecko', { status: 200, ok: true, data: COINS }]]),
      vmRun,
    );
    expect(problems).toEqual([]);
  });

  it('flags code that throws on the real data', async () => {
    const throwing = 'export default function run(ctx){ return ctx.input.items.map(x => x.name); }';
    const problems = await verifyGeneratedCodeNodes(
      [node('a', 'http', 'CoinGecko'), node('b', 'code', 'Extract', throwing)],
      [edge('a', 'b')],
      new Map([['CoinGecko', { status: 200, ok: true, data: COINS }]]),
      vmRun,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/threw/);
  });

  it('skips execution when the upstream label has no run data (static rule still applies)', async () => {
    const runCode = vi.fn();
    const problems = await verifyGeneratedCodeNodes(
      [node('a', 'http', 'Renamed Source'), node('b', 'code', 'Extract', 'export default function run(ctx){ return { ok: ctx.input }; }')],
      [edge('a', 'b')],
      new Map([['Old Label', [1, 2]]]),
      runCode,
    );
    expect(problems).toEqual([]);
    expect(runCode).not.toHaveBeenCalled();
  });

  it('includes the real ctx.input sample in failure messages when grounded', async () => {
    const broken = 'export default function run(ctx){ return { error: "nope" }; }';
    const problems = await verifyGeneratedCodeNodes(
      [node('a', 'http', 'CoinGecko'), node('b', 'code', 'Extract', broken)],
      [edge('a', 'b')],
      new Map([['CoinGecko', { status: 200, ok: true, data: COINS }]]),
      vmRun,
    );
    expect(problems[0]).toMatch(/REAL ctx\.input is: \[\{"name":"Bitcoin"/);
  });
});

describe('emitted-sample lookup by id', () => {
  it('grounds a node via the id:<nodeId> key even when its label does not match', async () => {
    const broken = 'export default function run(ctx){ return { error: "nope" }; }';
    const problems = await verifyGeneratedCodeNodes(
      [node('src1', 'http', 'Renamed Since'), node('b', 'code', 'Extract', broken)],
      [edge('src1', 'b')],
      new Map([['id:src1', { status: 200, ok: true, data: COINS }]]),
      vmRun,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/failure path fired/);
  });
});

describe('verifyMappings', () => {
  const withConfig = (id: string, type: string, label: string, config: Record<string, unknown>): FlowNode =>
    ({ ...node(id, type, label), config } as FlowNode);
  const SAMPLE = { status: 200, ok: true, data: { coins: COINS, meta: { asOf: 'today' } } };

  it('flags an http {{ }} url path that resolves to nothing in the real upstream data', () => {
    const nodes = [node('a', 'http', 'Src'), withConfig('b', 'http', 'Chained', { url: 'https://x.test/{{coins.0.slug}}' })];
    const problems = verifyMappings(nodes, [edge('a', 'b')], new Map([['Src', SAMPLE]]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/coins\.0\.slug/);
  });

  it('passes http/ai/if mappings whose paths exist (including input. and $json. prefixes)', () => {
    const nodes = [
      node('a', 'http', 'Src'),
      withConfig('b', 'http', 'Chained', { url: 'https://x.test/{{input.coins.0.symbol}}?at={{$json.meta.asOf}}' }),
      withConfig('c', 'ai', 'Brain', { prompt: 'Top of {{coins.0.name}} from {{input}}' }),
      withConfig('d', 'if', 'Gate', { condition: '{{coins.0.current_price}} > 0' }),
    ];
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('a', 'd')];
    const problems = verifyMappings(nodes, edges, new Map([['Src', SAMPLE]]));
    expect(problems).toEqual([]);
  });

  it('flags a template binding path missing from the data reaching the template', () => {
    const tpl = withConfig('t', 'template', 'Apply', { templateId: 'carousel:x', bindings: { headline: 'coins.0.name', price: 'coins.0.nope' } });
    tpl.inputs = [{ id: 'data', name: 'Data', dataType: 'object' }];
    const problems = verifyMappings(
      [node('a', 'http', 'Src'), tpl],
      [{ id: 'a->t', from: { node: 'a', port: 'out' }, to: { node: 't', port: 'data' } }],
      new Map([['Src', SAMPLE]]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/\{price\}/);
    expect(problems[0]).toMatch(/coins\.0\.nope/);
  });

  it('checks fan-in against the label-keyed merged input, and skips when any upstream is ungrounded', () => {
    const code = withConfig('m', 'http', 'Merge', { url: 'https://x.test/{{A.coins.0.symbol}}/{{B.rate}}' });
    const nodes = [node('a', 'http', 'A'), node('a2', 'http', 'B'), code];
    const edges = [edge('a', 'm'), edge('a2', 'm')];
    // Both grounded → the A.* path resolves, the bad B path is flagged.
    const problems = verifyMappings(nodes, edges, new Map<string, unknown>([['A', SAMPLE], ['B', { data: { fx: 1.2 } }]]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/B\.rate/);
    // One upstream ungrounded → nothing to check against, no false positives.
    expect(verifyMappings(nodes, edges, new Map([['A', SAMPLE]]))).toEqual([]);
  });
});

describe('verifyTemplateConfig', () => {
  const templates = [{ value: 'carousel:t1', name: 'Crypto daily', placeholders: ['headline', 'price'] }];
  const tplNode = (config: Record<string, unknown>): FlowNode => ({ ...node('t', 'template', 'Apply'), config } as FlowNode);

  it('flags a templateId that is not one of the user\'s templates', () => {
    const problems = verifyTemplateConfig([tplNode({ templateId: 'carousel:made-up' })], templates);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/carousel:t1/); // the valid values ride along for the retry
  });

  it('flags bindings to placeholders the template does not contain (el: keys pass)', () => {
    const problems = verifyTemplateConfig(
      [tplNode({ templateId: 'carousel:t1', bindings: { headline: 'a.b', bogus: 'c.d', 'el:fe1:series': 'e.f' } })],
      templates,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/\{bogus\}/);
  });

  it('passes valid config, unset templateId, and non-carousel (user-picked) values', () => {
    expect(verifyTemplateConfig([tplNode({ templateId: 'carousel:t1', bindings: { price: 'x.y' } })], templates)).toEqual([]);
    expect(verifyTemplateConfig([tplNode({})], templates)).toEqual([]);
    expect(verifyTemplateConfig([tplNode({ templateId: 'twitter:r1' })], templates)).toEqual([]);
  });
});

describe('ungroundedHttpUpstreams', () => {
  it('lists http sources feeding code nodes that have no run data, once each', () => {
    const nodes = [node('a', 'http', 'Source'), node('b', 'code', 'X', 'export default function run(ctx){ return ctx.input; }'), node('c', 'code', 'Y', 'export default function run(ctx){ return ctx.input; }')];
    const ups = ungroundedHttpUpstreams(nodes, [edge('a', 'b'), edge('a', 'c')], new Map());
    expect(ups.map(u => u.id)).toEqual(['a']);
  });

  it('excludes sources that already have run data, non-http upstreams, and fan-in code nodes', () => {
    const nodes = [
      node('a', 'http', 'Grounded'), node('a2', 'ai', 'Brain'), node('a3', 'http', 'FanA'), node('a4', 'http', 'FanB'),
      node('b', 'code', 'X', 'code'), node('c', 'code', 'Y', 'code'), node('d', 'code', 'Z', 'code'),
    ];
    const edges = [edge('a', 'b'), edge('a2', 'c'), edge('a3', 'd'), edge('a4', 'd')];
    const ups = ungroundedHttpUpstreams(nodes, edges, new Map([['Grounded', { data: [] }]]));
    expect(ups).toEqual([]);
  });
});
