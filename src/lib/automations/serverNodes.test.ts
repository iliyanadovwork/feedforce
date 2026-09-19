import { describe, it, expect } from 'vitest';
import { serverNodeRegistry } from './serverNodes';
import type { RunContext } from './types';

const ctx = (partial: Partial<RunContext>): RunContext => ({ config: {}, inputs: {}, ...partial });

describe('if node', () => {
  const run = (condition: string, value: unknown) =>
    serverNodeRegistry.if.run(ctx({ config: { condition }, inputs: { in: [{ json: { value } }] } }));

  it('routes truthy comparisons to the true port', () => {
    const out = run('{{value}} > 5', 10) as Record<string, unknown[]>;
    expect(out.true).toHaveLength(1);
    expect(out.false).toHaveLength(0);
  });

  it('routes failing comparisons to the false port', () => {
    const out = run('{{value}} > 5', 2) as Record<string, unknown[]>;
    expect(out.true).toHaveLength(0);
    expect(out.false).toHaveLength(1);
  });

  it('supports string equality and contains', () => {
    const eq = run('{{value}} == "hi"', 'hi') as Record<string, unknown[]>;
    expect(eq.true).toHaveLength(1);
    const has = run('{{value}} contains "ell"', 'hello') as Record<string, unknown[]>;
    expect(has.true).toHaveLength(1);
  });

  it('an empty condition passes everything through true', () => {
    const out = run('', 0) as Record<string, unknown[]>;
    expect(out.true).toHaveLength(1);
  });

  it('unwraps a { data } envelope before evaluating', () => {
    const out = serverNodeRegistry.if.run(ctx({
      config: { condition: '{{n}} >= 3' },
      inputs: { in: [{ json: { status: 200, data: { n: 4 } } }] },
    })) as Record<string, unknown[]>;
    expect(out.true).toHaveLength(1);
  });
});

describe('ai node', () => {
  it('fills {{expressions}} from input and parses schema-constrained JSON', async () => {
    let seenPrompt = '';
    const out = await serverNodeRegistry.ai.run(ctx({
      config: { prompt: 'Slides about {{topic}}', schema: '{"slides":[]}' },
      inputs: { in: [{ json: { topic: 'Bitcoin' } }] },
      services: {
        llm: async (prompt) => { seenPrompt = prompt; return '{"slides":[{"headline":"Hi"}]}'; },
      },
    }));
    expect(seenPrompt).toBe('Slides about Bitcoin');
    const json = (out.out[0].json as { slides: Array<{ headline: string }> });
    expect(json.slides[0].headline).toBe('Hi');
  });

  it('returns { text } when no schema is set', async () => {
    const out = await serverNodeRegistry.ai.run(ctx({
      config: { prompt: 'hello' },
      services: { llm: async () => 'plain text reply' },
    }));
    expect(out.out[0].json).toEqual({ text: 'plain text reply' });
  });

  it('throws without an LLM service', async () => {
    await expect(serverNodeRegistry.ai.run(ctx({ config: { prompt: 'x' } }))).rejects.toThrow();
  });
});

describe('code node', () => {
  const run = (code: string, inputs = {}) => serverNodeRegistry.code.run(ctx({ config: { code }, inputs })) as
    Promise<Record<string, Array<{ json: unknown }>>> | Record<string, Array<{ json: unknown }>>;

  it('emits the returned object as one item on the out port', async () => {
    const out = await run('export function run(ctx) { return { doubled: ctx.input.n * 2 }; }', { in: [{ json: { n: 2 } }] });
    expect(out.out[0].json).toEqual({ doubled: 4 });
  });

  it('fans an array out to one item per element', async () => {
    const out = await run('export default function run() { return [{ a: 1 }, { a: 2 }]; }');
    expect(out.out.map(i => i.json)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('exposes ctx.input as the unwrapped upstream data', async () => {
    const out = await run('export default function run(ctx) { return { n: ctx.input.value }; }', { in: [{ json: { status: 200, data: { value: 7 } } }] });
    expect(out.out[0].json).toEqual({ n: 7 });
  });

  it('merges multi-source fan-in into ctx.input keyed by source label', async () => {
    const out = await run(
      'export function run(ctx) { return { sum: ctx.input["Prices"].gbp + ctx.input["Rates"].fee }; }',
      { in: [{ json: { data: { gbp: 10 } }, source: 'Prices' }, { json: { data: { fee: 5 } }, source: 'Rates' }] },
    );
    expect(out.out[0].json).toEqual({ sum: 15 });
  });

  it('keeps single-source ctx.input unwrapped (no label wrapper) even with several items', async () => {
    const out = await run(
      'export function run(ctx) { return { n: ctx.input.n }; }',
      { in: [{ json: { n: 1 }, source: 'A' }, { json: { n: 2 }, source: 'A' }] },
    );
    expect(out.out[0].json).toEqual({ n: 1 });
  });

  it('accepts a bare anonymous (ctx) => {…} function', async () => {
    const out = await run('(ctx) => { return { first: ctx.input[0] }; }', { in: [{ json: { data: [10, 20] } }] });
    expect(out.out[0].json).toEqual({ first: 10 });
  });

  it('supports async code', async () => {
    const out = await run('async (ctx) => { return { ok: true }; }', { in: [{ json: {} }] });
    expect(out.out[0].json).toEqual({ ok: true });
  });

  it('has no access to require/process (sandboxed)', async () => {
    await expect(Promise.resolve(run('export function run() { return { out: require("fs") }; }'))).rejects.toThrow();
  });

  it('throws when no entry function is present', async () => {
    await expect(Promise.resolve(run('const x = 5;'))).rejects.toThrow(/run\(ctx\)/);
  });

  it('still resolves an entry when helpers precede it (separate-compile forms)', async () => {
    const out = await run('export const dbl = (x) => x * 2; export function run(ctx) { return { n: dbl(ctx.input.n) }; }', { in: [{ json: { n: 3 } }] });
    expect(out.out[0].json).toEqual({ n: 6 });
  });

  it('the classic constructor.constructor escape cannot reach the host process', async () => {
    // In the isolated realm `process` does not exist, so `typeof process` is 'undefined' — the escape
    // that previously reached the real process (and env secrets) now resolves to nothing.
    const out = await run('run = (ctx) => ({ p: ctx.constructor.constructor("return typeof process")() });', { in: [{ json: {} }] });
    expect((out.out[0].json as { p: string }).p).toBe('undefined');
  });

  it('cannot read a host env secret via an escape attempt', async () => {
    const code = 'run = (ctx) => { try { return { v: ctx.constructor.constructor("return process.env.SUPABASE_SECRET_KEY")() }; } catch (e) { return { v: "blocked" }; } };';
    const out = await run(code, { in: [{ json: {} }] });
    expect((out.out[0].json as { v: string }).v).toBe('blocked');
  });

  it('a synchronous infinite loop is bounded by the timeout', async () => {
    await expect(Promise.resolve(run('run = () => { while (true) {} };', { in: [{ json: {} }] }))).rejects.toThrow(/Code failed|timed out/i);
  });
});

describe('http node url mapping', () => {
  const runWithUrl = async (url: string, inputJson: Record<string, unknown>) => {
    const seen: string[] = [];
    const realFetch = global.fetch;
    global.fetch = (async (u: RequestInfo | URL) => {
      seen.push(String(u));
      return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      await serverNodeRegistry.http.run(ctx({ config: { url, method: 'GET' }, inputs: { in: [{ json: inputJson }] } }));
    } finally {
      global.fetch = realFetch;
    }
    return seen[0];
  };

  it('resolves {{ }} mappings from the upstream input, URL-encoded', async () => {
    const fetched = await runWithUrl(
      'https://api.coingecko.com/api/v3/coins/{{id}}/market_chart?vs_currency={{cur}}',
      { data: { id: 'bit coin', cur: 'usd&days=9' } },   // envelope unwrapped like the engine does
    );
    expect(fetched).toBe('https://api.coingecko.com/api/v3/coins/bit%20coin/market_chart?vs_currency=usd%26days%3D9');
  });

  it('supports the natural {{input.id}} spelling via the input.-prefix fallback', async () => {
    const fetched = await runWithUrl('https://api.coingecko.com/api/v3/coins/{{input.id}}/market_chart', { data: { id: 'ethereum' } });
    expect(fetched).toBe('https://api.coingecko.com/api/v3/coins/ethereum/market_chart');
  });

  it('leaves untemplated urls exactly as written', async () => {
    const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=3';
    expect(await runWithUrl(url, {})).toBe(url);
  });
});
