import { describe, expect, it } from 'vitest';
import { runLogNodes, lastRunFromLog } from './runLog';
import type { RunOutputs } from './types';

describe('runLogNodes / lastRunFromLog', () => {
  it('persists the first item per port with counts, and round-trips into the lastRun shape', () => {
    const outputs: Record<string, RunOutputs> = {
      a: { out: [{ json: { status: 200, ok: true, data: [1, 2] } }] },
      b: { true: [{ json: { v: 1 } }, { json: { v: 2 } }], false: [] },
    };
    const log = runLogNodes(outputs, ['a', 'b']);
    expect(log.a.ports.out).toEqual({ status: 200, ok: true, data: [1, 2] });
    expect(log.b.counts).toEqual({ true: 2, false: 0 });
    expect(log.b.ports.false).toBeUndefined(); // empty port → no sample

    const hydrated = lastRunFromLog(log);
    expect(hydrated.a.out).toEqual([{ json: { status: 200, ok: true, data: [1, 2] } }]);
    expect(hydrated.b.true).toEqual([{ json: { v: 1 } }]);
    expect(hydrated.b.false).toBeUndefined();
  });

  it('clips oversized values behind a sentinel that hydration SKIPS (no phantom shapes)', () => {
    const big = { blob: 'x'.repeat(10_000) };
    const log = runLogNodes({ a: { out: [{ json: big }], meta: [{ json: { n: 1 } }] } }, ['a']);
    const clipped = log.a.ports.out as Record<string, string>;
    expect(clipped.__ff_clipped.endsWith('…(truncated)')).toBe(true);
    const hydrated = lastRunFromLog(log);
    expect(hydrated.a.out).toBeUndefined();              // clipped port → not rehydrated at all
    expect(hydrated.a.meta).toEqual([{ json: { n: 1 } }]); // intact ports still hydrate
  });

  it('tolerates garbage input on hydration', () => {
    expect(lastRunFromLog(undefined)).toEqual({});
    expect(lastRunFromLog('nope')).toEqual({});
    expect(lastRunFromLog({ a: { ports: null }, b: 7 })).toEqual({});
  });
});
