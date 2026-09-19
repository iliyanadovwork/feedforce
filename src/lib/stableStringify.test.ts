import { describe, it, expect } from 'vitest';
import { stableStringify } from './stableStringify';

// stableStringify underpins the multi-tab live-sync fix: it compares a reels/rows array we WROTE against
// the same array echoed back over Realtime. Postgres jsonb does not preserve key order, so this MUST be
// order-invariant or (a) our own echo is never recognised (we'd re-adopt our own write in a loop) and
// (b) the save-storm dedup never fires. These tests pin that invariant.

describe('stableStringify', () => {
  it('produces identical output regardless of object key insertion order (the jsonb-reorder case)', () => {
    const ours = { id: 'a', name: 'x', mode: 'twitter', framing: { x: 0, y: 1, w: 2, h: 3 } };
    const jsonbReordered = { framing: { h: 3, w: 2, y: 1, x: 0 }, mode: 'twitter', name: 'x', id: 'a' };
    expect(stableStringify(ours)).toBe(stableStringify(jsonbReordered));
  });

  it('sorts keys recursively (nested objects inside arrays)', () => {
    const a = [{ id: '1', framing: { b: 2, a: 1 } }, { id: '2', framing: { d: 4, c: 3 } }];
    const b = [{ framing: { a: 1, b: 2 }, id: '1' }, { framing: { c: 3, d: 4 }, id: '2' }];
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('preserves ARRAY order (arrays are order-significant — only object keys are sorted)', () => {
    expect(stableStringify(['b', 'a'])).not.toBe(stableStringify(['a', 'b']));
    // Reordering reels in the grid IS a real change and must NOT be seen as a no-op.
    const r1 = [{ id: '1' }, { id: '2' }];
    const r2 = [{ id: '2' }, { id: '1' }];
    expect(stableStringify(r1)).not.toBe(stableStringify(r2));
  });

  it('distinguishes genuinely different data (a deleted reel is not equal to the full set)', () => {
    const full = [{ id: '1' }, { id: '2' }, { id: '3' }];
    const afterDelete = [{ id: '1' }, { id: '3' }];
    expect(stableStringify(full)).not.toBe(stableStringify(afterDelete));
  });

  it('handles primitives, null, and empty containers', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('s')).toBe('"s"');
    expect(stableStringify([])).toBe('[]');
    expect(stableStringify({})).toBe('{}');
  });

  it('treats a nested null value as data (not an empty object)', () => {
    expect(stableStringify({ templateId: null })).toBe('{"templateId":null}');
    expect(stableStringify({ templateId: null })).not.toBe(stableStringify({ templateId: {} }));
  });

  it('is stable across repeated calls on equal-but-distinct objects (echo suppression across ticks)', () => {
    const write = { caption: 'hi', url: 'https://x', id: '1', videoUrl: '', framing: { y: 10, x: 5 } };
    const echo = JSON.parse(JSON.stringify(write)) as typeof write; // structural clone, same key order
    const echoReordered = { framing: { x: 5, y: 10 }, videoUrl: '', id: '1', url: 'https://x', caption: 'hi' };
    expect(stableStringify(write)).toBe(stableStringify(echo));
    expect(stableStringify(write)).toBe(stableStringify(echoReordered));
  });
});
