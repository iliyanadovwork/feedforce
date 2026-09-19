import { describe, it, expect } from 'vitest';
import { MIN_REEL_S, MAX_REEL_S, effectiveReelDuration, classifyReelDuration } from './reelDuration';

// Pins the Reels-tab eligibility window (5..90s, both ends inclusive) and the fallback ladder of
// effectiveReelDuration: saved multi-clip timeline (summed clip windows) first, else valid trim
// window, else finite positive source duration, else null.

describe('constants', () => {
  it('pin the Reels-tab eligibility window at 5..90s', () => {
    expect(MIN_REEL_S).toBe(5);
    expect(MAX_REEL_S).toBe(90);
  });
});

describe('effectiveReelDuration', () => {
  it('sums a saved multi-clip timeline — the output IS the clips, the trim window is irrelevant', () => {
    // Stitched reel: 10s trim on main, plus two 60s uploaded clips → 130s output. Classifying by
    // the trim window would silently miss the over-90s "posts as a video, not a Reel" case.
    const framing = {
      trimStart: 0, trimEnd: 10,
      timeline: { clips: [{ start: 0, end: 10 }, { start: 0, end: 60 }, { start: 0, end: 60 }] },
    };
    expect(effectiveReelDuration(framing, 45)).toBe(130);
  });

  it('sums legacy `segments` cuts — the export renders only the kept windows, not the trim span', () => {
    // Keep [0..10] + [110..120] of a 120s video: output is 20s, but trimEnd−trimStart says 120s
    // (over the 90s Reels limit) — classifying by the trim span wrongly warned on an eligible reel.
    expect(effectiveReelDuration(
      { trimStart: 0, trimEnd: 120, segments: [{ start: 0, end: 10 }, { start: 110, end: 120 }] }, 120,
    )).toBe(20);
  });

  it('ignores a malformed/empty timeline and falls back to the trim ladder', () => {
    expect(effectiveReelDuration({ trimStart: 2, trimEnd: 9, timeline: { clips: [] } }, 60)).toBe(7);
    expect(effectiveReelDuration({ trimStart: 2, trimEnd: 9, timeline: { clips: [{ start: NaN, end: 5 }] } }, 60)).toBe(7);
    expect(effectiveReelDuration({ trimStart: 2, trimEnd: 9, timeline: { clips: [{ start: 5, end: 5 }] } }, 60)).toBe(7);
  });

  it('uses the trim window when both bounds are valid', () => {
    expect(effectiveReelDuration({ trimStart: 2, trimEnd: 9.5 }, 60)).toBe(7.5);
    expect(effectiveReelDuration({ trimStart: 0, trimEnd: 30 }, 60)).toBe(30); // trimStart 0 is valid
    // The trim window wins even when it disagrees with the source duration.
    expect(effectiveReelDuration({ trimStart: 10, trimEnd: 100 }, 15)).toBe(90);
  });

  it('falls back to source when the trim window is degenerate (equal bounds)', () => {
    expect(effectiveReelDuration({ trimStart: 5, trimEnd: 5 }, 60)).toBe(60);
    expect(effectiveReelDuration({ trimStart: 5, trimEnd: 5 }, null)).toBeNull();
  });

  it('falls back to source when the trim window is inverted', () => {
    expect(effectiveReelDuration({ trimStart: 10, trimEnd: 5 }, 60)).toBe(60);
  });

  it('falls back to source when trimStart is negative', () => {
    expect(effectiveReelDuration({ trimStart: -1, trimEnd: 10 }, 60)).toBe(60);
  });

  it('falls back to source when either trim bound is NaN or Infinity', () => {
    expect(effectiveReelDuration({ trimStart: NaN, trimEnd: 10 }, 60)).toBe(60);
    expect(effectiveReelDuration({ trimStart: 0, trimEnd: NaN }, 60)).toBe(60);
    expect(effectiveReelDuration({ trimStart: 0, trimEnd: Infinity }, 60)).toBe(60);
    expect(effectiveReelDuration({ trimStart: -Infinity, trimEnd: 10 }, 60)).toBe(60);
  });

  it('falls back to source when a trim bound is missing (partial framing)', () => {
    expect(effectiveReelDuration({ trimStart: 2 }, 60)).toBe(60);
    expect(effectiveReelDuration({ trimEnd: 9 }, 60)).toBe(60);
    expect(effectiveReelDuration({}, 60)).toBe(60);
  });

  it('falls back to source when framing is undefined or null', () => {
    expect(effectiveReelDuration(undefined, 42)).toBe(42);
    expect(effectiveReelDuration(null, 42)).toBe(42);
  });

  it('returns null when the source duration is not a finite positive number', () => {
    expect(effectiveReelDuration(undefined, null)).toBeNull();
    expect(effectiveReelDuration(undefined, 0)).toBeNull();
    expect(effectiveReelDuration(undefined, -3)).toBeNull();
    expect(effectiveReelDuration(undefined, NaN)).toBeNull();
    expect(effectiveReelDuration(undefined, Infinity)).toBeNull();
  });

  it('returns null when both the trim window and the source are unusable', () => {
    expect(effectiveReelDuration({ trimStart: 10, trimEnd: 5 }, NaN)).toBeNull();
    expect(effectiveReelDuration({ trimStart: NaN, trimEnd: NaN }, null)).toBeNull();
  });
});

describe('classifyReelDuration', () => {
  it('null is unknown', () => {
    expect(classifyReelDuration(null)).toBe('unknown');
  });

  it('below 5s is short (0 included)', () => {
    expect(classifyReelDuration(4.99)).toBe('short');
    expect(classifyReelDuration(0)).toBe('short');
    expect(classifyReelDuration(3)).toBe('short'); // API-publishable but not Reels-tab eligible
  });

  it('boundaries are inclusive: exactly 5s and exactly 90s are ok', () => {
    expect(classifyReelDuration(MIN_REEL_S)).toBe('ok');
    expect(classifyReelDuration(MAX_REEL_S)).toBe('ok');
    expect(classifyReelDuration(30)).toBe('ok');
  });

  it('above 90s is long', () => {
    expect(classifyReelDuration(90.01)).toBe('long');
    expect(classifyReelDuration(900)).toBe('long');
    expect(classifyReelDuration(Infinity)).toBe('long');
  });

  it('NaN reads as unknown (defensive, effectiveReelDuration never emits it)', () => {
    expect(classifyReelDuration(NaN)).toBe('unknown');
  });
});

describe('pipeline (effective duration into classification)', () => {
  it('classifies the trim window, not the source clip', () => {
    // 120s source trimmed to 3s: short despite a long source.
    expect(classifyReelDuration(effectiveReelDuration({ trimStart: 0, trimEnd: 3 }, 120))).toBe('short');
    // 120s source trimmed to 60s: ok despite a too-long source.
    expect(classifyReelDuration(effectiveReelDuration({ trimStart: 30, trimEnd: 90 }, 120))).toBe('ok');
  });

  it('classifies the source when no trim window is set', () => {
    expect(classifyReelDuration(effectiveReelDuration(null, 120))).toBe('long');
    expect(classifyReelDuration(effectiveReelDuration(null, 45))).toBe('ok');
    expect(classifyReelDuration(effectiveReelDuration(null, null))).toBe('unknown');
  });
});
