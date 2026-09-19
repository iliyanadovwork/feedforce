import { describe, it, expect } from 'vitest';

// Source-change guards for per-reel framing (see framingSource.ts). The bug these lock down:
// replacing a reel's link kept the row's saved trim (made for the PREVIOUS video) and the restore
// re-applied it to the new one, capping the output at the old video's length. Layer 1 strips
// time-domain framing at the source-change boundary; layer 2 clamps restored windows to the
// actually-loaded duration (out-of-range healing only — an in-range stale window is
// indistinguishable from a deliberate trim, which is exactly why layer 1 exists).

import {
  stripTimeDomainFraming, urlChangeInvalidatesVideo, localVideoChangeInvalidatesVideo, clampTrimWindow,
} from './framingSource';
import type { Framing } from '@/app/components/TikTokCanvas/types';
import type { VideoEntry } from '@/app/types';

const entry = (over: Partial<VideoEntry>): VideoEntry => ({
  id: 'r1', url: '', caption: '', description: '', data: null, loading: false, error: '',
  mode: 'twitter',
  ...over,
} as VideoEntry);

describe('stripTimeDomainFraming — the source-change invalidation', () => {
  it('strips trim, segments, and timeline; keeps crop/pan/zoom/includeEdit', () => {
    const f: Framing = {
      box: { x: 60, y: 510, w: 960, h: 900 },
      videoOffset: { x: 3, y: -8 }, videoScale: 1.4, includeEdit: true,
      trimStart: 2, trimEnd: 30.5,
      segments: [{ start: 2, end: 10 }],
      timeline: { sources: [], clips: [] } as unknown as Framing['timeline'],
    };
    const s = stripTimeDomainFraming(f);
    expect(s).toEqual({
      box: { x: 60, y: 510, w: 960, h: 900 },
      videoOffset: { x: 3, y: -8 }, videoScale: 1.4, includeEdit: true,
    });
    // The input is not mutated — the caller owns state identity decisions.
    expect(f.trimEnd).toBe(30.5);
  });

  it('strips when only a single time-domain field is present', () => {
    expect(stripTimeDomainFraming({ trimEnd: 30 })).toEqual({});
    expect(stripTimeDomainFraming({ videoScale: 2, segments: [] })).toEqual({ videoScale: 2 });
  });

  it('returns the SAME reference when there is nothing to strip (cheap no-op detection)', () => {
    const clean: Framing = { box: { x: 0, y: 0, w: 10, h: 10 }, videoScale: 1 };
    expect(stripTimeDomainFraming(clean)).toBe(clean);
    const empty: Framing = {};
    expect(stripTimeDomainFraming(empty)).toBe(empty);
  });
});

describe('urlChangeInvalidatesVideo — shared predicate with updateEntry', () => {
  it('false without a previous entry, or when the url is unchanged', () => {
    expect(urlChangeInvalidatesVideo(undefined, 'https://a')).toBe(false);
    expect(urlChangeInvalidatesVideo(entry({ url: 'https://a', videoUrl: 'v' }), 'https://a')).toBe(false);
  });

  it('false when the url changes but no video was ever fetched/stored (fresh row typing)', () => {
    expect(urlChangeInvalidatesVideo(entry({ url: 'https://a' }), 'https://b')).toBe(false);
  });

  it('true when a changed url discards fetched data, a stored clip, or a poster', () => {
    expect(urlChangeInvalidatesVideo(entry({ url: 'https://a', data: {} as VideoEntry['data'] }), 'https://b')).toBe(true);
    expect(urlChangeInvalidatesVideo(entry({ url: 'https://a', videoUrl: 'stored.mp4' }), 'https://b')).toBe(true);
    expect(urlChangeInvalidatesVideo(entry({ url: 'https://a', posterUrl: 'p.jpg' }), 'https://b')).toBe(true);
  });

  it('treats an absent previous url as empty (first paste over a stored clip still invalidates)', () => {
    expect(urlChangeInvalidatesVideo(entry({ url: undefined as unknown as string, videoUrl: 'v' }), 'https://b')).toBe(true);
  });
});

describe('localVideoChangeInvalidatesVideo — upload replace/remove', () => {
  it('false when the local src is unchanged or the row never had a video', () => {
    expect(localVideoChangeInvalidatesVideo(entry({ localVideoSrc: 'blob:x' }), 'blob:x')).toBe(false);
    expect(localVideoChangeInvalidatesVideo(entry({}), 'blob:new')).toBe(false);
    expect(localVideoChangeInvalidatesVideo(undefined, 'blob:new')).toBe(false);
  });

  it('true when a new upload replaces an existing upload, stored clip, or fetched link', () => {
    expect(localVideoChangeInvalidatesVideo(entry({ localVideoSrc: 'blob:old' }), 'blob:new')).toBe(true);
    expect(localVideoChangeInvalidatesVideo(entry({ videoUrl: 'stored.mp4' }), 'blob:new')).toBe(true);
    expect(localVideoChangeInvalidatesVideo(entry({ data: {} as VideoEntry['data'] }), 'blob:new')).toBe(true);
  });

  it('true when removing the video (empty src) from a row that had one', () => {
    expect(localVideoChangeInvalidatesVideo(entry({ localVideoSrc: 'blob:old' }), '')).toBe(true);
  });

  it('true when removing a RESTORED upload (videoUrl only — the session blob died on reload)', () => {
    // Regression: this returned false (both srcs ''), so remove-then-re-upload on a restored
    // uploaded reel skipped the strip and resurrected the stale-trim bug through an ordinary flow.
    expect(localVideoChangeInvalidatesVideo(entry({ videoUrl: 'stored.mp4' }), '')).toBe(true);
    expect(localVideoChangeInvalidatesVideo(entry({ data: {} as VideoEntry['data'] }), '')).toBe(true);
  });
});

describe('clampTrimWindow — restore-time out-of-range healing', () => {
  it('leaves an in-range window untouched (deliberate trims survive)', () => {
    expect(clampTrimWindow(2, 30, 60)).toEqual({ trimStart: 2, trimEnd: 30 });
  });

  it('clamps an end beyond the loaded video to its duration', () => {
    expect(clampTrimWindow(0, 45, 30)).toEqual({ trimStart: 0, trimEnd: 30 });
  });

  it('collapses (null) when the start is at/past the loaded end — apply nothing', () => {
    expect(clampTrimWindow(35, 45, 30)).toBeNull();
    expect(clampTrimWindow(30, undefined, 30)).toBeNull();
  });

  it('collapses (null) when the clamped window is empty or inverted', () => {
    expect(clampTrimWindow(10, 10, 60)).toBeNull();
    expect(clampTrimWindow(20, 10, 60)).toBeNull();
  });

  it('applies no cap while the duration is unknown (not loaded / NaN / 0) — verbatim behaviour', () => {
    expect(clampTrimWindow(2, 45, undefined)).toEqual({ trimStart: 2, trimEnd: 45 });
    expect(clampTrimWindow(2, 45, NaN)).toEqual({ trimStart: 2, trimEnd: 45 });
    expect(clampTrimWindow(2, 45, 0)).toEqual({ trimStart: 2, trimEnd: 45 });
  });

  it('applies no cap for an Infinity duration (live / unknown-length streams report Infinity)', () => {
    expect(clampTrimWindow(2, 45, Infinity)).toEqual({ trimStart: 2, trimEnd: 45 });
  });

  it('floors a negative start at 0 and passes partial windows through', () => {
    expect(clampTrimWindow(-1, 20, 60)).toEqual({ trimStart: 0, trimEnd: 20 });
    expect(clampTrimWindow(undefined, 20, 60)).toEqual({ trimStart: undefined, trimEnd: 20 });
    expect(clampTrimWindow(undefined, undefined, 60)).toEqual({ trimStart: undefined, trimEnd: undefined });
  });
});
