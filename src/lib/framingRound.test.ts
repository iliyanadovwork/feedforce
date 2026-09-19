import { describe, it, expect } from 'vitest';
import { roundFramingDeep } from './framingRound';

// Regression lock for the churn-clobber failure (2026-07-21): live getFraming() floats differed from the
// saved values by dust, so every video load armed the autosave with byte-different rows; the pending-edit
// guard then blocked foreign adoption on idle tabs and the armed stale save clobbered the foreign edit.
// Rounding at the write boundary makes churn rows byte-identical, which is what disarms all of that.

describe('roundFramingDeep', () => {
  it('rounds float dust away so an apply-then-read round-trip is byte-identical to the saved value', () => {
    const saved = { box: { x: 79, y: 486.5, w: 922, h: 947 }, videoScale: 1.1, videoOffset: { x: 0, y: 12 }, trimStart: 0, trimEnd: 88.1234 };
    const liveRead = { box: { x: 79.00000000000001, y: 486.49999999999994, w: 922, h: 947 }, videoScale: 1.1000000000000003, videoOffset: { x: 5.551115123125783e-17, y: 12 }, trimStart: 0, trimEnd: 88.12341000000001 };
    expect(JSON.stringify(roundFramingDeep(liveRead))).toBe(JSON.stringify(roundFramingDeep(saved)));
  });

  it('is idempotent (round of round equals round), which guarantees write convergence', () => {
    const f = { box: { x: 123.45678, y: -0.000001, w: 922.00004, h: 946.6666666666666 }, videoScale: 1.14999999, trimEnd: 87.65432 };
    const once = roundFramingDeep(f);
    expect(roundFramingDeep(once)).toEqual(once);
  });

  it('snaps sub-epsilon values and negative zero to a plain 0 (jsonb E-notation guard)', () => {
    expect(roundFramingDeep({ videoOffset: { x: 5.551115123125783e-17, y: -0 } }))
      .toEqual({ videoOffset: { x: 0, y: 0 } });
  });

  it('rounds inside segments arrays and leaves non-numbers untouched', () => {
    const f = { includeEdit: true, segments: [{ start: 0.123456789, end: 3.999999999 }] };
    expect(roundFramingDeep(f)).toEqual({ includeEdit: true, segments: [{ start: 0.1235, end: 4 }] });
  });

  it('passes empty framing and odd values through safely', () => {
    expect(roundFramingDeep({})).toEqual({});
    expect(roundFramingDeep({ videoScale: Infinity })).toEqual({ videoScale: Infinity });   // non-finite untouched
  });
});
