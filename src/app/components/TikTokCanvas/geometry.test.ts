import { describe, it, expect } from 'vitest';
import { CANVAS_W, CANVAS_H } from './constants';
import { calcVideoBox, isLoadableVideoSrc } from './hooks/useVideoLoading';
import { reelLayout, reelVideoRect, reelCellRegionRects } from './drawing/drawReelCell';
import { defaultTwitterTemplateSettings } from '../twitterTemplateTypes';
import type { TwitterTemplateSettings } from '../twitterTemplateTypes';

// Reel canvas is a fixed 1080×1920 portrait — every number below assumes it.
it('canvas constants are 1080×1920', () => {
  expect(CANVAS_W).toBe(1080);
  expect(CANVAS_H).toBe(1920);
});

const settings = (over?: Partial<TwitterTemplateSettings>): TwitterTemplateSettings =>
  ({ ...defaultTwitterTemplateSettings(), ...over });

// toEqual with FP tolerance — scale math like 1920·(1000/1920) yields 1000.0000000000001.
const expectBoxCloseTo = (b: { x: number; y: number; w: number; h: number }, e: { x: number; y: number; w: number; h: number }) => {
  expect(b.x).toBeCloseTo(e.x, 9);
  expect(b.y).toBeCloseTo(e.y, 9);
  expect(b.w).toBeCloseTo(e.w, 9);
  expect(b.h).toBeCloseTo(e.h, 9);
};

// ── calcVideoBox ────────────────────────────────────────────────────────────────

describe('calcVideoBox — cellMode band invariant', () => {
  // Standard template: cellMargin 60 → targetW = 1080 − 120 = 960; default band 900.
  const TARGET_W = 960;
  const BAND_H = 900;

  it('returns the centred band {60, 510, 960, 900} for the standard template', () => {
    expect(calcVideoBox(1920, 1080, 'clean', TARGET_W, BAND_H, true))
      .toEqual({ x: (1080 - 960) / 2, y: (1920 - 900) / 2, w: 960, h: 900 });
    expect(calcVideoBox(1920, 1080, 'clean', TARGET_W, BAND_H, true))
      .toEqual({ x: 60, y: 510, w: 960, h: 900 });
  });

  it('REGRESSION (sheet-sent reels): a 1080×1920 clip in cellMode must NOT get the full canvas', () => {
    // The prod bug: sheet-sent reels rendered full-canvas {0,0,1080,1920} until a template
    // switch recomputed the band. The band is what cellMode must ALWAYS return.
    const b = calcVideoBox(1080, 1920, 'clean', TARGET_W, BAND_H, true);
    expect(b).not.toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
    expect(b).toEqual({ x: 60, y: 510, w: 960, h: 900 });
  });

  it.each([
    [1920, 1080],   // landscape
    [1080, 1920],   // portrait, exactly canvas-sized
    [640, 480],     // small 4:3
    [1, 1],         // degenerate
    [3841, 2161],   // odd, huge
  ])('is independent of the clip dimensions (%d×%d)', (vw, vh) => {
    expect(calcVideoBox(vw, vh, 'default', TARGET_W, BAND_H, true))
      .toEqual({ x: 60, y: 510, w: 960, h: 900 });
  });

  it('ignores the brand — "clean" in cellMode still returns the band, never full-width', () => {
    expect(calcVideoBox(1920, 1080, 'clean', TARGET_W, BAND_H, true))
      .toEqual(calcVideoBox(1920, 1080, 'sonotrade', TARGET_W, BAND_H, true));
  });

  it('centres odd band dimensions with half-pixel coordinates', () => {
    // cellMargin 59.5 → targetW 961; bandH 901.
    expect(calcVideoBox(1920, 1080, 'x', 961, 901, true))
      .toEqual({ x: 59.5, y: 509.5, w: 961, h: 901 });
  });

  it('band wider/taller than the canvas goes negative (centred overflow), no clamping', () => {
    expect(calcVideoBox(500, 500, 'x', 1200, 2000, true))
      .toEqual({ x: -60, y: -40, w: 1200, h: 2000 });
  });
});

describe('calcVideoBox — brand "clean" (full-width fit, vertically centred)', () => {
  it('landscape 1920×1080: scale 0.5625 → {0, 656.25, 1080, 607.5}', () => {
    // drawH = vh * (1080/vw) = 1080 * 0.5625 = 607.5; y = (1920 − 607.5)/2.
    expect(calcVideoBox(1920, 1080, 'clean', 1000, 900, false))
      .toEqual({ x: 0, y: 656.25, w: 1080, h: 607.5 });
  });

  it('canvas-sized 1080×1920 fills exactly: {0, 0, 1080, 1920}', () => {
    expect(calcVideoBox(1080, 1920, 'clean', 1000, 900, false))
      .toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
  });

  it('tall 540×1920 overflows vertically: drawH 3840, y −960 (full-width wins, no height cap)', () => {
    expect(calcVideoBox(540, 1920, 'clean', 1000, 900, false))
      .toEqual({ x: 0, y: -960, w: 1080, h: 3840 });
  });

  it('odd dims 1000×707: drawH = 707·1.08 = 763.56', () => {
    const b = calcVideoBox(1000, 707, 'clean', 1000, 900, false);
    expect(b.x).toBe(0);
    expect(b.w).toBe(1080);
    expect(b.h).toBeCloseTo(763.56, 10);
    expect(b.y).toBeCloseTo((1920 - 763.56) / 2, 10);   // 578.22
  });

  it('ignores targetW and bandH entirely', () => {
    expect(calcVideoBox(1920, 1080, 'clean', 1000, 900, false))
      .toEqual(calcVideoBox(1920, 1080, 'clean', 1, 1, false));
  });
});

describe('calcVideoBox — default brand (aspect-fit within targetW×1920, centred both axes)', () => {
  it('width-limited landscape 1920×1080 @ targetW 1000: {40, 678.75, 1000, 562.5}', () => {
    // scale = min(1000/1920, 1920/1080) = 0.5208333…; drawW = 1000, drawH = 562.5.
    expectBoxCloseTo(calcVideoBox(1920, 1080, 'sonotrade', 1000, 900, false),
      { x: 40, y: 678.75, w: 1000, h: 562.5 });
  });

  it('width-limited portrait 1080×1920 @ targetW 1000: w=1000, h=1777.7…, centred', () => {
    const b = calcVideoBox(1080, 1920, 'sonotrade', 1000, 900, false);
    expect(b.w).toBeCloseTo(1000, 10);
    expect(b.h).toBeCloseTo(1920 * (1000 / 1080), 10);   // 1777.777…
    expect(b.x).toBeCloseTo(40, 10);
    expect(b.y).toBeCloseTo((1920 - 1920 * (1000 / 1080)) / 2, 10);   // 71.111…
  });

  it('height-limited 500×2000 @ targetW 1000: scale 0.96 → {300, 0, 480, 1920}', () => {
    expect(calcVideoBox(500, 2000, 'sonotrade', 1000, 900, false))
      .toEqual({ x: 300, y: 0, w: 480, h: 1920 });
  });

  it('square 1000×1000 @ targetW 1000: scale 1 → {40, 460, 1000, 1000}', () => {
    expect(calcVideoBox(1000, 1000, 'sonotrade', 1000, 900, false))
      .toEqual({ x: 40, y: 460, w: 1000, h: 1000 });
  });

  it('odd dims 1013×764 @ targetW 1000 (width-limited): exact ratios', () => {
    const scale = 1000 / 1013;   // < 1920/764 = 2.513…, so width wins
    const b = calcVideoBox(1013, 764, 'sonotrade', 1000, 900, false);
    expect(b.w).toBeCloseTo(1000, 10);
    expect(b.h).toBeCloseTo(764 * scale, 10);            // 754.195…
    expect(b.x).toBeCloseTo(40, 10);
    expect(b.y).toBeCloseTo((1920 - 764 * scale) / 2, 10);
  });

  it('bandH does not influence the non-cell default fit', () => {
    expect(calcVideoBox(1920, 1080, 'sonotrade', 1000, 900, false))
      .toEqual(calcVideoBox(1920, 1080, 'sonotrade', 1000, 1, false));
  });

  it('any brand other than "clean" takes the default path (including "")', () => {
    const expected = { x: 40, y: 678.75, w: 1000, h: 562.5 };
    expectBoxCloseTo(calcVideoBox(1920, 1080, '', 1000, 900, false), expected);
    expectBoxCloseTo(calcVideoBox(1920, 1080, 'default', 1000, 900, false), expected);
    // Brand comparison is exact/case-sensitive: "Clean" is not the clean layout.
    expectBoxCloseTo(calcVideoBox(1920, 1080, 'Clean', 1000, 900, false), expected);
  });
});

// ── srcValid gate ───────────────────────────────────────────────────────────────

describe('isLoadableVideoSrc — the srcValid gate', () => {
  it.each([
    'blob:http://localhost:3000/2f1a3c66-9d7e-4b5e-9a1c-000000000000',   // upload (black-upload prod bug)
    'data:video/mp4;base64,AAAAIGZ0eXBpc29t',                            // inline data
    'https://bhprseixvxyxgqfjssgp.supabase.co/storage/v1/object/public/reels/v.mp4', // persisted upload
    'http://cdn.example.com/v.mp4',                                       // plain http also passes https?:
    '/api/proxy?stream=1&url=https%3A%2F%2Fcdn.example.com%2Fv.mp4',      // proxied remote (relative, no scheme)
    '/api/proxy?url=x',                                                   // minimal proxied form
  ])('accepts %s', (src) => {
    expect(isLoadableVideoSrc(src)).toBe(true);
  });

  it('scheme match is case-insensitive (BLOB:/DATA:/HTTPS:)', () => {
    expect(isLoadableVideoSrc('BLOB:http://localhost/abc')).toBe(true);
    expect(isLoadableVideoSrc('DATA:video/mp4;base64,AA')).toBe(true);
    expect(isLoadableVideoSrc('HTTPS://cdn.example.com/v.mp4')).toBe(true);
  });

  it('rejects the empty-proxy sentinel "/api/proxy?stream=1&url=" (not-yet-fetched bestVideoUrl)', () => {
    expect(isLoadableVideoSrc('/api/proxy?stream=1&url=')).toBe(false);
  });

  it.each([
    '',                       // empty
    'garbage',                // plain garbage
    'video.mp4',              // bare filename, no scheme
    '/videos/local.mp4',      // relative path, not proxied
    'ftp://example.com/v.mp4',// unsupported scheme, no url= param
    '/api/proxy?stream=1',    // proxy link with no url param at all
    'url=',                   // sentinel suffix alone
  ])('rejects %j', (src) => {
    expect(isLoadableVideoSrc(src)).toBe(false);
  });

  it('the sentinel guard wins over the scheme: ANY src ending in "url=" is rejected', () => {
    // Deliberate production semantics — endsWith('url=') is checked before the scheme allowlist.
    expect(isLoadableVideoSrc('https://cdn.example.com/watch?url=')).toBe(false);
    expect(isLoadableVideoSrc('blob:http://localhost/url=')).toBe(false);
  });
});

// ── reelLayout ──────────────────────────────────────────────────────────────────

describe('reelLayout', () => {
  it('defaults (no videoBandHeight/cellMargin): band 960×900 at (60, 510), cellH 510, pad 60', () => {
    expect(reelLayout(settings()))
      .toEqual({ bandX: 60, bandY: 510, bandW: 960, bandH: 900, cellH: 510, pad: 60 });
  });

  it('custom videoBandHeight 1200 + cellMargin 40', () => {
    expect(reelLayout(settings({ videoBandHeight: 1200, cellMargin: 40 })))
      .toEqual({ bandX: 40, bandY: 360, bandW: 1000, bandH: 1200, cellH: 360, pad: 40 });
  });

  it('cellMargin 0: band spans the full canvas width', () => {
    expect(reelLayout(settings({ cellMargin: 0 })))
      .toEqual({ bandX: 0, bandY: 510, bandW: 1080, bandH: 900, cellH: 510, pad: 0 });
  });

  it('full-height band (1920): cellH clamps to 0, bandY 0', () => {
    expect(reelLayout(settings({ videoBandHeight: 1920 })))
      .toEqual({ bandX: 60, bandY: 0, bandW: 960, bandH: 1920, cellH: 0, pad: 60 });
  });

  it('band taller than the canvas (2000): cellH clamps at 0 (never negative), bandH passes through', () => {
    expect(reelLayout(settings({ videoBandHeight: 2000 })))
      .toEqual({ bandX: 60, bandY: 0, bandW: 960, bandH: 2000, cellH: 0, pad: 60 });
  });

  it('odd bandH 901: cellH 509.5 (half-pixel, no rounding)', () => {
    expect(reelLayout(settings({ videoBandHeight: 901 })))
      .toEqual({ bandX: 60, bandY: 509.5, bandW: 960, bandH: 901, cellH: 509.5, pad: 60 });
  });
});

// ── reelVideoRect ───────────────────────────────────────────────────────────────

describe('reelVideoRect — cover-fit into the band + zoom/pan', () => {
  const L = reelLayout(settings());   // {bandX:60, bandY:510, bandW:960, bandH:900}

  it('exact band-sized clip (960×900), no zoom/pan: fills the band exactly', () => {
    expect(reelVideoRect(960, 900, L, 1, 0, 0)).toEqual({ dx: 60, dy: 510, dw: 960, dh: 900 });
  });

  it('landscape 1920×1080: height-limited COVER (scale 900/1080), overflows horizontally', () => {
    // scale = max(960/1920, 900/1080) = 0.8333… → dw 1600, dh 900; dx = 60 + (960−1600)/2 = −260.
    const r = reelVideoRect(1920, 1080, L, 1, 0, 0);
    expect(r.dw).toBeCloseTo(1600, 10);
    expect(r.dh).toBeCloseTo(900, 10);
    expect(r.dx).toBeCloseTo(-260, 10);
    expect(r.dy).toBeCloseTo(510, 10);
  });

  it('portrait 1080×1920: width-limited COVER (scale 960/1080), overflows vertically', () => {
    // scale = max(960/1080, 900/1920) = 0.8888… → dw 960, dh 1706.66…; dy = 510 + (900−dh)/2.
    const r = reelVideoRect(1080, 1920, L, 1, 0, 0);
    expect(r.dw).toBeCloseTo(960, 10);
    expect(r.dh).toBeCloseTo(1920 * (960 / 1080), 10);           // 1706.666…
    expect(r.dx).toBeCloseTo(60, 10);
    expect(r.dy).toBeCloseTo(510 + (900 - 1920 * (960 / 1080)) / 2, 10);   // 106.666…
  });

  it('zoom scaleMul 2 doubles the draw size and re-centres', () => {
    expect(reelVideoRect(960, 900, L, 2, 0, 0)).toEqual({ dx: -420, dy: 60, dw: 1920, dh: 1800 });
  });

  it('pan (ox, oy) offsets dx/dy only', () => {
    expect(reelVideoRect(960, 900, L, 1, 15, -25)).toEqual({ dx: 75, dy: 485, dw: 960, dh: 900 });
  });

  it('cover never letterboxes: draw rect ≥ band on both axes for any clip', () => {
    for (const [vw, vh] of [[1234, 771], [333, 999], [4096, 2160], [960, 900]]) {
      const r = reelVideoRect(vw, vh, L, 1, 0, 0);
      expect(r.dw).toBeGreaterThanOrEqual(L.bandW - 1e-9);
      expect(r.dh).toBeGreaterThanOrEqual(L.bandH - 1e-9);
      // and it stays centred on the band
      expect(r.dx + r.dw / 2).toBeCloseTo(L.bandX + L.bandW / 2, 8);
      expect(r.dy + r.dh / 2).toBeCloseTo(L.bandY + L.bandH / 2, 8);
    }
  });
});

// ── reelCellRegionRects ─────────────────────────────────────────────────────────

describe('reelCellRegionRects — four equal stacked cells around the band', () => {
  it('default layout: h = (510 − 60 − 40 − 40)/2 = 185, exact rects', () => {
    const rects = reelCellRegionRects(reelLayout(settings()));
    expect(rects).toEqual([
      { key: 'top',     x: 60, y: 60,   w: 960, h: 185 },   // outer top = pad
      { key: 'top2',    x: 60, y: 285,  w: 960, h: 185 },   // 60 + 185 + CELL_GAP 40
      { key: 'bottom',  x: 60, y: 1450, w: 960, h: 185 },   // bandBottom 1410 + VIDEO_GAP 40
      { key: 'bottom2', x: 60, y: 1675, w: 960, h: 185 },   // 1450 + 185 + 40
    ]);
    // Symmetry teeth: top2 bottom edge sits VIDEO_GAP above the band; bottom2 ends pad above the canvas edge.
    expect(rects[1].y + rects[1].h).toBe(510 - 40);
    expect(rects[3].y + rects[3].h).toBe(1920 - 60);
  });

  it('custom bandH 1000 / pad 40: h = (460 − 40 − 40 − 40)/2 = 170', () => {
    const rects = reelCellRegionRects(reelLayout(settings({ videoBandHeight: 1000, cellMargin: 40 })));
    expect(rects).toEqual([
      { key: 'top',     x: 40, y: 40,   w: 1000, h: 170 },
      { key: 'top2',    x: 40, y: 250,  w: 1000, h: 170 },
      { key: 'bottom',  x: 40, y: 1500, w: 1000, h: 170 },   // 460 + 1000 + 40
      { key: 'bottom2', x: 40, y: 1710, w: 1000, h: 170 },
    ]);
    expect(rects[3].y + rects[3].h).toBe(1920 - 40);
  });

  it('tall band squeezes cells to h=0 (clamped, never negative)', () => {
    // bandH 1800 → cellH 60; (60 − 60 − 40 − 40)/2 < 0 → h clamps to 0.
    const rects = reelCellRegionRects(reelLayout(settings({ videoBandHeight: 1800 })));
    for (const r of rects) expect(r.h).toBe(0);
  });

  it('huge pad clamps width to 0 too', () => {
    const rects = reelCellRegionRects(reelLayout(settings({ cellMargin: 600 })));
    for (const r of rects) expect(r.w).toBe(0);
  });

  it('all four cells are always equal-sized', () => {
    for (const over of [{}, { videoBandHeight: 1234, cellMargin: 17 }, { videoBandHeight: 901, cellMargin: 0 }]) {
      const rects = reelCellRegionRects(reelLayout(settings(over)));
      const { w, h } = rects[0];
      for (const r of rects) { expect(r.w).toBe(w); expect(r.h).toBe(h); }
    }
  });
});
