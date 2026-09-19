import { describe, it, expect } from 'vitest';
import { summarizeDiff, diffLabel } from './changeDiff';

describe('summarizeDiff', () => {
  it('formats a changed scalar as from→to', () => {
    expect(summarizeDiff({ fontSize: 68 }, { fontSize: 88 })).toEqual(['fontSize 68→88']);
  });

  it('formats a newly-set value as → to', () => {
    expect(summarizeDiff({}, { opacity: 50 })).toEqual(['opacity → 50']);
  });

  it('omits unchanged values', () => {
    expect(summarizeDiff({ fontSize: 88, weight: 700 }, { fontSize: 88 })).toEqual([]);
  });

  it('recurses into nested objects and reports the leaf key', () => {
    expect(summarizeDiff(
      { headline: { fontSize: 68, color: '#ffffff' } },
      { headline: { fontSize: 88 } },
    )).toEqual(['fontSize 68→88']);
  });

  it('keeps hex colors bare and quotes free text', () => {
    expect(summarizeDiff({ color: '#ffffff' }, { color: '#111111' })).toEqual(['color #ffffff→#111111']);
    expect(summarizeDiff({ font: 'Inter' }, { font: 'Georgia' })).toEqual(['font “Inter”→“Georgia”']);
  });

  it('renders booleans as on/off', () => {
    expect(summarizeDiff({ shadow: false }, { shadow: true })).toEqual(['shadow off→on']);
  });

  it('summarizes an array field by key name only', () => {
    expect(summarizeDiff({}, { imageBoxes: [{ id: 'a' }, { id: 'b' }] })).toEqual(['imageBoxes']);
  });

  it('respects the limit', () => {
    const before = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    const patch = { a: 10, b: 20, c: 30, d: 40, e: 50 };
    expect(summarizeDiff(before, patch, 3)).toHaveLength(3);
  });

  it('truncates a long string value', () => {
    const long = 'x'.repeat(40);
    const [out] = summarizeDiff({ t: 'short' }, { t: long });
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(40);
  });
});

describe('diffLabel', () => {
  it('prefixes with Set and joins with ·', () => {
    expect(diffLabel({ fontSize: 68, color: '#fff' }, { fontSize: 88, color: '#111' }, 'fallback'))
      .toBe('Set fontSize 68→88 · color #fff→#111');
  });

  it('falls back when nothing scalar changed', () => {
    expect(diffLabel({ a: 1 }, { a: 1 }, 'Updated slide')).toBe('Updated slide');
    expect(diffLabel({}, { imageBoxes: [{ id: 'x' }] }, 'Updated an image')).toBe('Set imageBoxes');
  });
});
