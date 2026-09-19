import { describe, it, expect } from 'vitest';
import {
  MAIN_SRC, buildTimelineLayout, timelineAtOut, timelineOutOf,
  clipsFromSegments, isLegacyShape, saveTimeline, loadTimeline, mkClipId,
  type TimelineClip, type ReelTimeline,
} from './timeline';

// The timeline model is shared by preview playback (canvas sequencer), the exporter and the bar —
// these tests pin the mapping they all rely on: output = clips packed in ARRAY order (never sorted),
// so reordering clips reorders the output.

const clip = (src: string, start: number, end: number): TimelineClip => ({ id: mkClipId(), src, start, end });

describe('buildTimelineLayout — array order, not source order', () => {
  it('packs clips back-to-back in array order', () => {
    // Second clip starts EARLIER in source time — a reordered edit. Sorted layout would swap them.
    const L = buildTimelineLayout([clip(MAIN_SRC, 10, 14), clip(MAIN_SRC, 2, 5)]);
    expect(L.total).toBe(7);
    expect(L.items.map(i => [i.out0, i.out1])).toEqual([[0, 4], [4, 7]]);
  });

  it('handles an empty clip list', () => {
    expect(buildTimelineLayout([]).total).toBe(0);
  });
});

describe('timelineAtOut / timelineOutOf', () => {
  const clips = [clip('u1', 0, 3), clip(MAIN_SRC, 10, 12)];   // upload first, then a main window
  const L = buildTimelineLayout(clips);

  it('maps output time to (clip, source time) across sources', () => {
    expect(timelineAtOut(1.5, L)).toEqual({ index: 0, srcT: 1.5 });
    expect(timelineAtOut(4, L)).toEqual({ index: 1, srcT: 11 });   // 1s into the second clip → src 10+1
  });

  it('clamps: t=0 hits the first clip in-point, t=total resolves to the last clip out-point', () => {
    expect(timelineAtOut(0, L)).toEqual({ index: 0, srcT: 0 });
    expect(timelineAtOut(5, L)).toEqual({ index: 1, srcT: 12 });
    expect(timelineAtOut(99, L)).toEqual({ index: 1, srcT: 12 });
  });

  it('is null only for an empty layout', () => {
    expect(timelineAtOut(0, buildTimelineLayout([]))).toBeNull();
  });

  it('round-trips through timelineOutOf', () => {
    const at = timelineAtOut(4.5, L)!;
    expect(timelineOutOf(at.index, at.srcT, L)).toBeCloseTo(4.5, 10);
  });
});

describe('legacy segments conversion', () => {
  it('sorts segments by source time (legacy output order) and targets MAIN', () => {
    const clips = clipsFromSegments([{ start: 8, end: 9 }, { start: 1, end: 3 }]);
    expect(clips.map(c => [c.src, c.start, c.end])).toEqual([[MAIN_SRC, 1, 3], [MAIN_SRC, 8, 9]]);
  });
});

describe('isLegacyShape — what may persist as `segments`', () => {
  it('true for main-only clips in source order', () => {
    expect(isLegacyShape({ sources: [], clips: [clip(MAIN_SRC, 0, 2), clip(MAIN_SRC, 3, 5)] })).toBe(true);
  });
  it('false with an extra source, a non-main clip, or out-of-order clips', () => {
    expect(isLegacyShape({ sources: [{ id: 's1', url: 'u' }], clips: [clip(MAIN_SRC, 0, 2)] })).toBe(false);
    expect(isLegacyShape({ sources: [], clips: [clip('s1', 0, 2)] })).toBe(false);
    expect(isLegacyShape({ sources: [], clips: [clip(MAIN_SRC, 3, 5), clip(MAIN_SRC, 0, 2)] })).toBe(false);
  });
});

describe('save/load round-trip', () => {
  it('persists sources + ordered clips (ids are session-only) and restores them', () => {
    const t: ReelTimeline = {
      sources: [{ id: 's1', url: 'https://x/storage/v1/object/public/post-videos/u/1_a.mp4', name: 'a.mp4' }],
      clips: [clip('s1', 0, 2), clip(MAIN_SRC, 5, 8)],
    };
    const restored = loadTimeline(saveTimeline(t))!;
    expect(restored.sources).toEqual(t.sources);
    expect(restored.clips.map(c => [c.src, c.start, c.end])).toEqual([['s1', 0, 2], [MAIN_SRC, 5, 8]]);
    expect(restored.clips.every(c => typeof c.id === 'string' && c.id)).toBe(true);
  });

  it('drops clips with unresolvable sources, degenerate windows, and unreferenced sources', () => {
    const restored = loadTimeline({
      sources: [{ id: 's1', url: 'u1' }, { id: 'dead', url: 'u2' }],
      clips: [
        { src: 's1', start: 0, end: 2 },
        { src: 'missing', start: 0, end: 1 },   // unknown source → dropped
        { src: MAIN_SRC, start: 3, end: 3 },    // zero-length → dropped
        { src: MAIN_SRC, start: -1, end: 1 },   // negative in-point → dropped
      ],
    })!;
    expect(restored.clips.map(c => [c.src, c.start, c.end])).toEqual([['s1', 0, 2]]);
    expect(restored.sources.map(s => s.id)).toEqual(['s1']);   // 'dead' unreferenced → dropped
  });

  it('returns null for garbage or an empty clip list', () => {
    expect(loadTimeline(null)).toBeNull();
    expect(loadTimeline({ sources: [], clips: [] })).toBeNull();
    expect(loadTimeline('nope')).toBeNull();
  });
});
