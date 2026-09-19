import { CANVAS_H } from '../constants';

// ── FeedForce rewards sticker ─────────────────────────────────────────────────────────────────────
// Enrolled rewards-program members can brand a reel with a small FeedForce lockup + tagline, drawn
// just below the bottom edge of the video crop in BOTH the live preview and the baked export (the
// two callers pass identical geometry — WYSIWYG). Pure layout + variant helpers are exported so the
// math is unit-testable without a canvas.

export const REWARDS_TAGLINE = 'The first AI software that pays you to use it';

export const STICKER_GAP = 52;      // px below the crop's bottom edge (1080×1920 canvas space)
export const LOCKUP_H = 54;         // logo lockup height
export const TAGLINE_PX = 23;       // tagline font size (Libre Franklin, already loaded by caption paths)
export const TAGLINE_GAP = 22;      // gap between lockup bottom and tagline top
export const BOTTOM_MARGIN = 12;    // the clamp keeps at least this much canvas below the sticker

// The lockup SVGs' intrinsic size is 475.39×62.24 → natural width ≈ 489 at the 64px lockup height.
const LOCKUP_AR = 475.39 / 62.24;

/** Public path of the lockup asset for a variant ('black' = dark mark for light backgrounds). */
export const rewardsStickerSrc = (variant: 'black' | 'white') => `/feedforce-logo-${variant}.svg`;

const LIBRE = '"Libre Franklin", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export interface RewardsStickerLayout {
  scale: number;    // uniform shrink applied when the natural sticker is wider than the crop
  height: number;   // total sticker height (lockup + gap + tagline line box), scaled
  lockup: { x: number; y: number; w: number; h: number };
  tagline: { x: number; y: number; px: number; w: number };   // x = centre, y = top of the line box
}

// PURE layout (exported for tests): takes the measured tagline width — either a number or a measure
// function — instead of a ctx, so tests don't need a canvas. The sticker is centred on `centerX`,
// sits STICKER_GAP below `bottomY` (the crop's bottom edge), shrinks uniformly to fit `maxW`, and is
// CLAMPED back up when the crop runs near the canvas bottom — clamped, never hidden.
export function stickerLayout({ centerX, bottomY, maxW, measureTagline }: {
  centerX: number;
  bottomY: number;
  maxW: number;
  /** Tagline width at TAGLINE_PX, or a measurer invoked with (REWARDS_TAGLINE, TAGLINE_PX). */
  measureTagline: number | ((text: string, px: number) => number);
}): RewardsStickerLayout {
  const taglineW = typeof measureTagline === 'number' ? measureTagline : measureTagline(REWARDS_TAGLINE, TAGLINE_PX);
  const lockupW = LOCKUP_H * LOCKUP_AR;   // ≈ 412 at LOCKUP_H 54
  const naturalW = Math.max(lockupW, taglineW);
  const k = Math.min(1, (maxW * 0.92) / naturalW);   // uniform scale; never enlarge past natural size
  const height = k * (LOCKUP_H + TAGLINE_GAP + TAGLINE_PX * 1.2);   // ×1.2 = the tagline's line box
  // Clamp, never hide: a crop reaching the canvas bottom pulls the sticker up INTO the frame.
  const y = Math.min(bottomY + STICKER_GAP, CANVAS_H - height - BOTTOM_MARGIN);
  return {
    scale: k,
    height,
    lockup: { x: centerX - (lockupW * k) / 2, y, w: lockupW * k, h: LOCKUP_H * k },
    tagline: { x: centerX, y: y + k * (LOCKUP_H + TAGLINE_GAP), px: TAGLINE_PX * k, w: taglineW * k },
  };
}

// Pick the lockup variant for the background the sticker sits on: light backgrounds get the black
// mark, dark (or unparseable) backgrounds get the white one — failing to white matches the templates'
// default dark look.
export function stickerVariant(bg: string): 'black' | 'white' {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return 'white';
  const hex = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;   // relative luminance of the sRGB bytes
  return lum > 0.6 ? 'black' : 'white';
}

export function drawRewardsSticker({ ctx, img, variant, centerX, bottomY, maxW }: {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  img: HTMLImageElement | null;
  variant: 'black' | 'white';
  centerX: number;
  bottomY: number;
  maxW: number;
}): void {
  ctx.save();
  ctx.font = `400 ${TAGLINE_PX}px ${LIBRE}`;
  const L = stickerLayout({ centerX, bottomY, maxW, measureTagline: ctx.measureText(REWARDS_TAGLINE).width });

  if (img && img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, L.lockup.x, L.lockup.y, L.lockup.w, L.lockup.h);
  } else {
    // Lockup not usable (still loading / failed) → a bold wordmark in its slot: the sticker must
    // never silently vanish from a bake.
    ctx.font = `700 ${Math.round(L.lockup.h * 0.9)}px ${LIBRE}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = variant === 'black' ? '#000' : '#fff';
    ctx.fillText('FeedForce', centerX, L.lockup.y + L.lockup.h / 2);
  }

  ctx.font = `400 ${L.tagline.px}px ${LIBRE}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = variant === 'black' ? 'rgba(0,0,0,.72)' : 'rgba(255,255,255,.85)';
  ctx.fillText(REWARDS_TAGLINE, L.tagline.x, L.tagline.y);
  ctx.restore();
}

// The vertical space to RESERVE for the sticker when auto-centring a reel: crop bottom + gap + the
// sticker's full height. Deliberately UNCLAMPED — unlike drawRewardsSticker it ignores the
// near-canvas-bottom clamp. That clamp is a draw-time safety net for a crop pinned to the floor;
// centring then pulls the crop toward the middle, so the sticker ends up drawing unclamped at its
// final spot. Reserving the CLAMPED value instead would make the reserve a saturating (non-affine)
// function of bottomY, so it would not shift 1:1 with the crop: one "Center" press would land
// off-centre and a second would move it again (breaking idempotency). Unclamped keeps the reserve
// affine in bottomY, which is what makes centring land in one pass and stay a no-op afterwards.
// Height still comes from stickerLayout (same font + measure as the draw) so it tracks any shrink.
export function stickerReservedBottom({ ctx, bottomY, maxW }: {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  bottomY: number;
  maxW: number;
}): number {
  ctx.save();
  ctx.font = `400 ${TAGLINE_PX}px ${LIBRE}`;
  const L = stickerLayout({ centerX: 0, bottomY, maxW, measureTagline: ctx.measureText(REWARDS_TAGLINE).width });
  ctx.restore();
  return bottomY + STICKER_GAP + L.height;   // unclamped: crop bottom + gap + sticker height
}
