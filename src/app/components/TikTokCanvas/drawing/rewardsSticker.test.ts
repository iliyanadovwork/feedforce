import { describe, it, expect } from 'vitest';

// FeedForce rewards sticker — pure layout + variant math. stickerLayout takes the measured tagline
// width (a number or a measure function) instead of a ctx, precisely so these tests need no canvas.

import {
  stickerLayout, stickerReservedBottom, stickerVariant, REWARDS_TAGLINE,
  STICKER_GAP, LOCKUP_H, TAGLINE_PX, TAGLINE_GAP, BOTTOM_MARGIN,
} from './drawRewardsSticker';

const CANVAS_H = 1920;   // the canvas space the clamp is defined against

// A representative tagline width at TAGLINE_PX (real Libre Franklin measures ~500px; either side of
// the ~412px natural lockup width exercises the same max() branch).
const TAGLINE_W = 480;

describe('stickerLayout — geometry', () => {
  it('centres the lockup and tagline on centerX and sits STICKER_GAP below the crop bottom', () => {
    const L = stickerLayout({ centerX: 540, bottomY: 900, maxW: 960, measureTagline: TAGLINE_W });
    expect(L.lockup.x + L.lockup.w / 2).toBeCloseTo(540, 6);
    expect(L.tagline.x).toBe(540);
    expect(L.lockup.y).toBe(900 + STICKER_GAP);
    // Tagline sits TAGLINE_GAP under the lockup (unscaled here — see the no-upscale test below).
    expect(L.tagline.y).toBeCloseTo(L.lockup.y + LOCKUP_H + TAGLINE_GAP, 6);
  });

  it('never upscales: a wide crop keeps the natural 64px lockup and 26px tagline', () => {
    const L = stickerLayout({ centerX: 540, bottomY: 400, maxW: 2000, measureTagline: TAGLINE_W });
    expect(L.scale).toBe(1);
    expect(L.lockup.h).toBe(LOCKUP_H);
    expect(L.tagline.px).toBe(TAGLINE_PX);
  });

  it('shrinks uniformly to fit a narrow crop (92% of maxW), tagline scaling with the lockup', () => {
    const maxW = 200;
    const L = stickerLayout({ centerX: 100, bottomY: 400, maxW, measureTagline: TAGLINE_W });
    expect(L.scale).toBeLessThan(1);
    // The widest part of the sticker lands exactly on the 92% budget…
    expect(Math.max(L.lockup.w, L.tagline.w)).toBeCloseTo(maxW * 0.92, 6);
    // …and both parts carry the SAME scale (uniform, not per-part).
    expect(L.lockup.h / LOCKUP_H).toBeCloseTo(L.tagline.px / TAGLINE_PX, 9);
  });

  it('a tagline wider than the lockup drives the shrink (naturalW is the max of the two)', () => {
    const wide = stickerLayout({ centerX: 540, bottomY: 400, maxW: 500, measureTagline: 900 });
    const narrow = stickerLayout({ centerX: 540, bottomY: 400, maxW: 500, measureTagline: 100 });
    expect(wide.scale).toBeLessThan(narrow.scale);
    expect(wide.tagline.w).toBeCloseTo(500 * 0.92, 6);
  });

  it('clamps at the canvas bottom — never pushed off-frame, never hidden', () => {
    const L = stickerLayout({ centerX: 540, bottomY: 1900, maxW: 960, measureTagline: TAGLINE_W });
    // The unclamped position (1900 + 28) would overflow 1920; the clamp pulls it back inside.
    expect(L.lockup.y).toBeLessThan(1900 + STICKER_GAP);
    expect(L.lockup.y + L.height).toBeCloseTo(CANVAS_H - BOTTOM_MARGIN, 6);
  });

  it('does not clamp while there is room below the crop', () => {
    const L = stickerLayout({ centerX: 540, bottomY: 1000, maxW: 960, measureTagline: TAGLINE_W });
    expect(L.lockup.y).toBe(1000 + STICKER_GAP);
  });

  it('accepts a measure FUNCTION and calls it with the tagline text at TAGLINE_PX', () => {
    let seen: [string, number] | null = null;
    const L = stickerLayout({
      centerX: 540, bottomY: 900, maxW: 960,
      measureTagline: (text, px) => { seen = [text, px]; return TAGLINE_W; },
    });
    expect(seen).toEqual([REWARDS_TAGLINE, TAGLINE_PX]);
    expect(L.tagline.w).toBe(TAGLINE_W);   // scale 1 at this width
  });
});

describe('stickerReservedBottom — the auto-centring reserve', () => {
  // Unlike stickerLayout, this helper takes a real ctx (it sets ctx.font + calls ctx.measureText).
  // The node test env has no canvas, so stub the two members it touches; cast through unknown since
  // the full CanvasRenderingContext2D type has hundreds of members we don't implement.
  const stubCtx = (taglineW: number) => ({
    save() {}, restore() {}, font: '',
    measureText: () => ({ width: taglineW }),
  }) as unknown as CanvasRenderingContext2D;

  // Wide band → k = 1 → height = LOCKUP_H + TAGLINE_GAP + TAGLINE_PX*1.2 = 54 + 22 + 27.6 = 103.6.
  const HEIGHT = LOCKUP_H + TAGLINE_GAP + TAGLINE_PX * 1.2;

  it('reserves crop bottom + STICKER_GAP + height (wide band, k = 1)', () => {
    expect(stickerReservedBottom({ ctx: stubCtx(500), bottomY: 1000, maxW: 960 }))
      .toBeCloseTo(1000 + STICKER_GAP + HEIGHT, 6);   // 1155.6
  });

  it('extends past the video-band bottom, so enabling the sticker grows the composition', () => {
    const bandBottom = 1410;   // default reel band: bandY 510 + bandH 900
    const reserved = stickerReservedBottom({ ctx: stubCtx(500), bottomY: bandBottom, maxW: 960 });
    expect(reserved).toBeGreaterThan(bandBottom);
    expect(reserved).toBeCloseTo(bandBottom + STICKER_GAP + HEIGHT, 6);   // 1565.6
  });

  it('is AFFINE in bottomY — shifting the crop by d shifts the reserve by exactly d', () => {
    // The invariant that keeps centring one-press + idempotent: the reserve must move 1:1 with the
    // crop. A CLAMPED bottom would saturate near the canvas floor and break this (see next test).
    const a = stickerReservedBottom({ ctx: stubCtx(500), bottomY: 1000, maxW: 960 });
    const b = stickerReservedBottom({ ctx: stubCtx(500), bottomY: 700, maxW: 960 });
    expect(a - b).toBeCloseTo(300, 9);
  });

  it('does NOT clamp near the canvas floor, even though the DRAWN sticker does', () => {
    // A crop pinned to the floor: stickerLayout clamps the drawn sticker to CANVAS_H - BOTTOM_MARGIN,
    // but the reserve stays unclamped so centring can pull the crop up to where it actually fits.
    const drawn = stickerLayout({ centerX: 540, bottomY: 1900, maxW: 960, measureTagline: 500 });
    expect(drawn.lockup.y + drawn.height).toBeCloseTo(CANVAS_H - BOTTOM_MARGIN, 6);   // 1908, clamped
    expect(stickerReservedBottom({ ctx: stubCtx(500), bottomY: 1900, maxW: 960 }))
      .toBeCloseTo(1900 + STICKER_GAP + HEIGHT, 6);   // 2055.6, unclamped
  });

  it('is font-independent for every real reel band (k stays 1)', () => {
    // bandW ∈ [840, 1080]; narrowest * 0.92 = 772.8 > any plausible tagline width, so k = 1 and a
    // fallback-vs-loaded measureText swing cannot change the reserve.
    const loaded   = stickerReservedBottom({ ctx: stubCtx(500), bottomY: 1000, maxW: 840 });
    const fallback = stickerReservedBottom({ ctx: stubCtx(700), bottomY: 1000, maxW: 840 });
    expect(fallback).toBeCloseTo(loaded, 9);
    expect(loaded).toBeCloseTo(1000 + STICKER_GAP + HEIGHT, 6);
  });
});

describe('stickerVariant — lockup colour for the background it sits on', () => {
  it('light backgrounds take the black mark (#rrggbb and #rgb forms)', () => {
    expect(stickerVariant('#fff')).toBe('black');
    expect(stickerVariant('#ffffff')).toBe('black');
    expect(stickerVariant('#FFD700')).toBe('black');   // gold, luminance ≈ 0.82
    expect(stickerVariant('  #fff  ')).toBe('black');  // tolerated whitespace
  });

  it('dark backgrounds take the white mark', () => {
    expect(stickerVariant('#000')).toBe('white');
    expect(stickerVariant('#000000')).toBe('white');
    expect(stickerVariant('#15202b')).toBe('white');   // Twitter dim
    expect(stickerVariant('#888888')).toBe('white');   // mid-gray 0.53 ≤ the 0.6 threshold
  });

  it('unparseable input fails safe to white (the templates default to dark backgrounds)', () => {
    expect(stickerVariant('')).toBe('white');
    expect(stickerVariant('red')).toBe('white');
    expect(stickerVariant('rgb(255,255,255)')).toBe('white');
    expect(stickerVariant('#12')).toBe('white');       // wrong length
    expect(stickerVariant('#12345g')).toBe('white');   // non-hex digit
    expect(stickerVariant('#12345678')).toBe('white'); // 8-digit (alpha) form not supported → safe
  });
});
