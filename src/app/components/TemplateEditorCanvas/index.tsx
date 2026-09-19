'use client';

import type { EncodedAudioPacketSource, EncodedPacket } from 'mediabunny';

import React, { useRef, useEffect, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { QUOTE_STYLES, QUOTE_STYLES_PAIRED, ALL_QUOTE_STYLES } from '../templateEditorQuoteStyles';
import type { QuoteStyle } from '../templateEditorQuoteStyles';
import type {
  TemplateEditorCanvasRef, CarouselTextAlign, CarouselFontLabel,
  CarouselSettings, CarouselBgLayerState, SlotContent, LayerId, TagStyle, TextSpan,
  SidebarElementData, DividerSubSlotContent, DividerStyleSettings, ImageBoxFade, FadeStop, SlotCrop,
  ImageBox, ImageEffects, TextBoxStyle, ImageBoxPerspective, PerspectiveMode,
  SwipeStyle, SwipeArrowType, SwipeLayout, SwipeDirection, ShadowStyle, FreeElement,
} from '../templateEditorTypes';
import { removeBackgroundBlob } from './imageRemoval';
import { warpImageToQuad, type WarpPt } from './perspectiveWarp';
import {
  MAX_FONT, SUB_MAX, defaultTagStyle, TAG_PRESETS, defaultDividerSettings, defaultTextBox, defaultCarouselSettings,
  defaultSwipeStyle, SWIPE_PRESETS, defaultFadeStops, sampleFadeStops, orderedLayerIds,
  HEADLINE_LAYER_ID, SUB_LAYER_ID,
} from '../templateEditorTypes';
import { resolveCarouselFont, useCustomFonts } from '../customFonts';
import { LayersPanel } from '../TemplateEditorSettingsPanel';

// Shared 2D context for text measurement (element bounds for × placement).
let _measureCtx: CanvasRenderingContext2D | null = null;
function measureCtx2D(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
  return _measureCtx;
}
import { TemplateEditorSwipePreviewMini } from '../TemplateEditorSwipePreviewMini';
import { CloseIcon } from '@/lib/icons';

import {
  CAROUSEL_W as W, CAROUSEL_H as H,
  CAROUSEL_PREVIEW_W, CAROUSEL_PREVIEW_H,
  DISPLAY_SCALE,
  LOGO_PH, LOGO_CW, LOGO_CH,
} from './constants';
export { CAROUSEL_PREVIEW_W, CAROUSEL_PREVIEW_H, LOGO_PH };

import { divHexToRgba, drawWaveSegment, applyShadow, clearShadow, drawDividerOnCanvas, getSubZoneCanvasBounds } from './drawing/divider';
import { ensureFontLoaded, wrapText, drawAligned, hexToRgba, roundRectPath, drawTag, drawLogoFit } from './drawing/helpers';
import { drawSwipeArrow, drawSwipeOnCanvas } from './drawing/swipe';
import { wrapTextOffsets, wrapSpanLines, getLineSpanSegs, drawSpanLine, spansToHtml, rgbToHex, htmlToSpans, buildFiller, alternateWeightSpans, layoutFitToWidth, placeholderSpans } from './drawing/spans';
import { highlightPlaceholders } from './liveHighlight';
import { renderCustomElement } from '@/lib/customElements/runtime';

// Module-level cache of decoded <img> elements, keyed by URL, shared across (re)mounts of the canvas.
// On a remount (e.g. switching Reels→Carousel) a cached image is already complete, so the layer that
// uses it draws on the first pass instead of popping in later when a fresh Image's onload fires —
// that's what made the elements load in one-by-one rather than all together.
const EDITOR_IMAGE_CACHE_MAX = 150; // decoded images are big — cap the cache so long sessions don't grow unbounded
const editorImageCache = new Map<string, HTMLImageElement>();
function cachedEditorImage(url: string): HTMLImageElement {
  let img = editorImageCache.get(url);
  if (img) {
    // LRU touch: re-insert so the most recently used entries survive eviction.
    editorImageCache.delete(url);
    editorImageCache.set(url, img);
    return img;
  }
  img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  editorImageCache.set(url, img);
  if (editorImageCache.size > EDITOR_IMAGE_CACHE_MAX) {
    const oldest = editorImageCache.keys().next().value;
    if (oldest !== undefined) editorImageCache.delete(oldest);
  }
  return img;
}

const RICH_COLORS = [
  '#ffffff', '#000000', '#9ca3af',
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e',
];

// ── Image-box subject-split effect helpers (foreground / background adjustments) ──
function imageEffectsActive(e?: ImageEffects): boolean {
  return !!e && ((e.brightness ?? 0) !== 0 || (e.blur ?? 0) > 0 || (e.noise ?? 0) > 0);
}
function imageFadeActive(f?: ImageBoxFade): boolean {
  return !!f && (f.enabled ?? true) && ((f.top ?? 0) > 0 || (f.bottom ?? 0) > 0 || (f.left ?? 0) > 0 || (f.right ?? 0) > 0);
}
// Perspective is active when any corner is offset from the box's natural rectangle.
function perspectiveActive(p?: ImageBoxPerspective): boolean {
  if (!p) return false;
  for (const c of [p.tl, p.tr, p.br, p.bl]) if ((c?.x ?? 0) !== 0 || (c?.y ?? 0) !== 0) return true;
  return false;
}
const IDENTITY_PERSPECTIVE: ImageBoxPerspective = { tl: { x: 0, y: 0 }, tr: { x: 0, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } };
type Corner = 'tl' | 'tr' | 'br' | 'bl';
const ROW_PARTNER: Record<Corner, Corner> = { tl: 'tr', tr: 'tl', bl: 'br', br: 'bl' }; // same horizontal edge
const COL_PARTNER: Record<Corner, Corner> = { tl: 'bl', bl: 'tl', tr: 'br', br: 'tr' }; // same vertical edge
// The 4 perspective corner handles, with their fractional position on the box rect.
const PCORNERS: { id: Corner; fx: 0 | 1; fy: 0 | 1 }[] = [
  { id: 'tl', fx: 0, fy: 0 }, { id: 'tr', fx: 1, fy: 0 }, { id: 'br', fx: 1, fy: 1 }, { id: 'bl', fx: 0, fy: 1 },
];
// Update the destination quad when a corner is dragged by (dpx, dpy) canvas px from `start`,
// constrained by the active mode. Distort = free corner; Perspective = the same-edge partner
// mirrors (symmetric trapezoid, axis chosen by the dominant drag direction); Skew = the same-edge
// partner follows (the whole edge slides → parallelogram).
function updatePerspective(id: Corner, dpx: number, dpy: number, start: ImageBoxPerspective, mode: PerspectiveMode): ImageBoxPerspective {
  const p: ImageBoxPerspective = { tl: { ...start.tl }, tr: { ...start.tr }, br: { ...start.br }, bl: { ...start.bl } };
  if (mode === 'distort') {
    p[id] = { x: start[id].x + dpx, y: start[id].y + dpy };
  } else if (mode === 'perspective') {
    if (Math.abs(dpx) >= Math.abs(dpy)) {
      const r = ROW_PARTNER[id];
      p[id] = { ...p[id], x: start[id].x + dpx };
      p[r]  = { ...p[r],  x: start[r].x - dpx };
    } else {
      const c = COL_PARTNER[id];
      p[id] = { ...p[id], y: start[id].y + dpy };
      p[c]  = { ...p[c],  y: start[c].y - dpy };
    }
  } else { // skew
    if (Math.abs(dpx) >= Math.abs(dpy)) {
      const r = ROW_PARTNER[id];
      p[id] = { ...p[id], x: start[id].x + dpx };
      p[r]  = { ...p[r],  x: start[r].x + dpx };
    } else {
      const c = COL_PARTNER[id];
      p[id] = { ...p[id], y: start[id].y + dpy };
      p[c]  = { ...p[c],  y: start[c].y + dpy };
    }
  }
  return p;
}
// brightness + gaussian blur as GPU ctx.filter ops. The blur radius is in DEVICE px
// (blur × sc) and applied with no scale transform active, exactly like the main bg blur
// (`blur(amount * sc)`), so preview (sc=1) and 4× export stay visually consistent.
// Returns 'none' when no-op.
function imageEffectsFilter(e: ImageEffects | undefined, sc: number): string {
  const parts: string[] = [];
  const b = e?.brightness ?? 0;
  const blur = e?.blur ?? 0;
  if (b !== 0)   parts.push(`brightness(${Math.max(0, 1 + b / 100)})`);
  if (blur > 0)  parts.push(`blur(${Math.max(1, Math.round(blur * sc))}px)`);
  return parts.length ? parts.join(' ') : 'none';
}
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// Chris Wellons' "lowbias32" integer hash — strong avalanche, so hashing a coordinate/counter
// yields white-noise-quality output. A single xorshift round (the previous approach) leaves
// neighbouring pixels correlated, producing a visible lattice/moiré; this fully decorrelates.
function hashU32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x >>> 0;
}
// Monochromatic (grayscale) Gaussian noise over an ImageData buffer — film-grain-like white
// noise, the way Photoshop's Add Noise (Gaussian + Monochromatic) does it: each pixel is an
// INDEPENDENT normal draw (no spatial structure). Deterministic (the randomness comes from a
// strong hash of the canvas-space coordinate + per-layer seed, not Math.random), so it never
// flickers on redraw and the 4× export matches the preview; sampled at col = floor(px / sc)
// so grain size is the same in preview (sc=1) and export.
function applyMonoNoise(data: Uint8ClampedArray, w: number, h: number, sc: number, amount: number, seed: number, skipTransparent: boolean): void {
  if (amount <= 0) return;
  const sigma = (amount / 100) * 40;           // Gaussian std-dev in luma levels at 100%
  const step  = Math.max(1, Math.round(sc));
  const TAU   = Math.PI * 2;
  for (let y = 0; y < h; y++) {
    const cy = (y / step) | 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) << 2;
      if (skipTransparent && data[i + 3] === 0) continue;
      const cx = (x / step) | 0;
      // White-noise per-pixel randomness: avalanche-hash the canvas coord + seed, then derive
      // a second independent stream by re-hashing — gives two decorrelated uniforms.
      const r1 = hashU32((Math.imul(cx, 374761393) + Math.imul(cy, 3266489917) + seed) | 0);
      const r2 = hashU32(r1 ^ 0x9e3779b9);
      // Box–Muller transform → standard normal, scaled to sigma.
      const u1 = (r1 + 0.5) / 4294967296;      // (0,1) — avoid log(0)
      const u2 = r2 / 4294967296;              // [0,1)
      const d = Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2) * sigma;
      data[i]     += d;   // Uint8ClampedArray clamps to [0,255] on assignment
      data[i + 1] += d;
      data[i + 2] += d;
    }
  }
}

// Paint one effect layer into a device-pixel buffer context: brightness + gaussian blur (ctx.filter),
// then monochromatic noise. When overdraw is true (a box-filling layer whose blurred edges should stay
// solid edge-to-edge), the draw is over-extended past the buffer so the blur kernel never samples the
// transparent area outside the image. When overdraw is false the blur fades to transparent at the edges
// — wanted for the subject cut-out's silhouette, and opt-in for box-filling layers via blurEdgeFade.
function paintLayer(
  tctx: CanvasRenderingContext2D, image: CanvasImageSource, effects: ImageEffects | undefined, seed: number,
  w: number, h: number, sc: number, sx: number, sy: number, sw: number, sh: number, overdraw: boolean,
): void {
  const blur = effects?.blur ?? 0;
  tctx.filter = imageEffectsFilter(effects, sc);
  if (overdraw && blur > 0) {
    const m = Math.max(1, Math.round(blur * sc)) * 2;
    tctx.drawImage(image, sx, sy, sw, sh, -m, -m, w + 2 * m, h + 2 * m);
  } else {
    tctx.drawImage(image, sx, sy, sw, sh, 0, 0, w, h);
  }
  tctx.filter = 'none';
  const noise = effects?.noise ?? 0;
  if (noise > 0) {
    try {
      const id = tctx.getImageData(0, 0, w, h);
      applyMonoNoise(id.data, w, h, sc, noise, seed, true);
      tctx.putImageData(id, 0, 0);
    } catch { /* tainted canvas — skip noise rather than break the render/export */ }
  }
}

// Clipboard for copy/paste of a layer (text or image box). Module-level singleton so it survives the
// active canvas re-rendering with another slide/template's settings — enabling paste across canvases.
let layerClipboard: { kind: 'text'; box: TextBoxStyle } | { kind: 'image'; box: ImageBox } | null = null;

// True when a paste event's clipboard carries an image or video FILE (screenshot, copied media…).
// This is the coordination contract between the two window 'paste' listeners so one ⌘/Ctrl+V is
// always exactly one action: the media paste in TemplateEditorGrid acts only when this is true,
// and the layer paste below defers when it is true (where media is allowed) — clipboard files
// outrank the internal layer clipboard. Keying on the EVENT (not on whether a layer was ever copied) matters:
// layerClipboard is never cleared, so gating media paste on it being empty would permanently
// disable paste-to-canvas after the first ⌘/Ctrl+C of a layer.
export function clipboardEventHasMediaFile(e: ClipboardEvent): boolean {
  return Array.from(e.clipboardData?.items ?? []).some(
    it => it.kind === 'file' && (it.type.startsWith('image/') || it.type.startsWith('video/')));
}

// Snap guide lines for moving/resizing boxes: canvas edges, 60px margins, and centre.
const SNAP_PX = 12, SNAP_EDGE = 60;
const X_GUIDES = [0, SNAP_EDGE, W / 2, W - SNAP_EDGE, W];
const Y_GUIDES = [0, SNAP_EDGE, H / 2, H - SNAP_EDGE, H];
function nearestGuide(v: number, guides: number[], thresh = SNAP_PX): number | null {
  let best: number | null = null, bestD = thresh;
  for (const g of guides) { const d = Math.abs(v - g); if (d <= bestD) { bestD = d; best = g; } }
  return best;
}

// Apply per-edge fades inside an image box's offscreen buffer (coords in canvas px).
// No colour → erase the image's alpha toward the edge (destination-out).
// Colour set → paint the colour over the image toward the edge (source-atop, so it
// only affects the image's existing pixels — transparent areas stay transparent).
function paintImageBoxFades(bctx: CanvasRenderingContext2D, fade: ImageBoxFade, bw: number, bh: number) {
  const transparent = !fade.color;
  const colorAt = transparent
    ? (a: number) => `rgba(0,0,0,${a.toFixed(3)})`
    : (a: number) => hexToRgba(fade.color!, a);
  const st = fade.stops ?? {};
  // Each edge's gradient runs from the edge (pos 0) inward to its reach distance (pos 1),
  // following that edge's opacity curve (default = linear ramp). vis = image visibility, so
  // the fill alpha (erase amount in transparent mode / colour cover in colour mode) is 1 - vis.
  const grad = (x0: number, y0: number, x1: number, y1: number, stops: FadeStop[]) => {
    const g = bctx.createLinearGradient(x0, y0, x1, y1);
    for (const { pos, vis } of sampleFadeStops(stops)) g.addColorStop(Math.min(1, Math.max(0, pos)), colorAt(1 - vis));
    return g;
  };
  bctx.save();
  bctx.globalCompositeOperation = transparent ? 'destination-out' : 'source-atop';
  const t = fade.top ?? 0, b = fade.bottom ?? 0, l = fade.left ?? 0, r = fade.right ?? 0;
  if (t > 0) { const d = bh * t / 100; bctx.fillStyle = grad(0, 0, 0, d,       st.top    ?? defaultFadeStops()); bctx.fillRect(0, 0, bw, d); }
  if (b > 0) { const d = bh * b / 100; bctx.fillStyle = grad(0, bh, 0, bh - d, st.bottom ?? defaultFadeStops()); bctx.fillRect(0, bh - d, bw, d); }
  if (l > 0) { const d = bw * l / 100; bctx.fillStyle = grad(0, 0, d, 0,       st.left   ?? defaultFadeStops()); bctx.fillRect(0, 0, d, bh); }
  if (r > 0) { const d = bw * r / 100; bctx.fillStyle = grad(bw, 0, bw - d, 0, st.right  ?? defaultFadeStops()); bctx.fillRect(bw - d, 0, d, bh); }
  bctx.restore();
}

interface TemplateEditorCanvasProps {
  imageSrc: string;
  videoSrc?: string;
  headline: string;
  subheadline: string;
  // Display-time data fill (automations "preview with data"): the DRAWN text replaces {placeholder}
  // tokens with these values and custom elements render with this data merged in, while the underlying
  // props/settings — and every edit surface — keep the raw tokens. Absent on the normal editor pages.
  displayValues?: Record<string, string>;
  displayElementData?: Record<string, Record<string, unknown>>;
  settings: CarouselSettings;
  onScaleChange?: (scale: number) => void;
  onSettingsChange?: (partial: Partial<CarouselSettings>) => void;
  onBgLayerStateChange?: (s: CarouselBgLayerState) => void;
  brandLogoSrc?: string;
  onRecordingStateChange?: (state: { isRecording: boolean; recProgress: number; recStatus: string }) => void;
  onHeadlineChange?: (text: string) => void;
  onSubheadlineChange?: (text: string) => void;
  rectMode?: boolean;
  isDraggingElement?: boolean;
  // Posts only: templates define structure, not content — image boxes live in posts.
  allowImages?: boolean;
  // What kind of palette item is mid-drag (drives which drop indicators show)
  draggingKind?: SidebarElementData['type'] | null;
  invertedSlots?: boolean;
  onSlotDrop?: (slotIndex: number, data: SidebarElementData) => void;
  staticMode?: boolean;
  onSelectedImageBoxChange?: (idx: number | null) => void;
  onSelectedFreeElChange?: (idx: number | null) => void;
  onSelectedTextBoxChange?: (idx: number | null) => void;
  onSelectedZoneSlotChange?: (slot: { kind: 'logo' | 'tag' | 'quote' | 'swipe'; index: number } | null) => void;
  onRichEditTargetChange?: (t: 'headline' | 'sub' | null) => void;
  onTextEditStateChange?: (s: { boxIndex: number | null; hasSelection: boolean }) => void;
  // Auto-height: report each text box's measured wrapped-text height (canvas units, keyed by box id)
  // so the settings panel can show it in the (read-only) Height field.
  onTextBoxHeightsChange?: (heights: Record<string, number>) => void;
  lockImageAspect?: boolean;
  cleanView?: boolean;   // hide all editor chrome (frames, guides, slots, handles) for a clean preview
  // Subject split: upload a per-box cut-out PNG (returns its public URL) so it persists; report per-box bg-removal status.
  onUploadImage?: (blob: Blob, filename: string) => Promise<string | null>;
  onImageBoxBgStateChange?: (statuses: Record<string, 'processing' | 'error'>) => void;
  // Image expansion preview: id of the box being set up for BRIA expand — shades the fill area on the canvas.
  expandPreviewBoxId?: string | null;
  // Perspective/distort transform: the box whose corner handles are shown, and the active edit mode.
  perspectiveBoxId?: string | null;
  perspectiveMode?: PerspectiveMode;
}

// ── TemplateEditorCanvas (canvas + pan/zoom only) ──────────────────────────────────

const TemplateEditorCanvas = forwardRef<TemplateEditorCanvasRef, TemplateEditorCanvasProps>(
  function TemplateEditorCanvas({ imageSrc, videoSrc, headline, subheadline, settings, onScaleChange, onSettingsChange, onBgLayerStateChange, brandLogoSrc, onRecordingStateChange, onHeadlineChange, onSubheadlineChange, rectMode = false, isDraggingElement = false, allowImages = true, draggingKind = null, invertedSlots = false, onSlotDrop, staticMode = false, onSelectedImageBoxChange, onSelectedFreeElChange, onSelectedTextBoxChange, onSelectedZoneSlotChange, onRichEditTargetChange, onTextEditStateChange, onTextBoxHeightsChange, lockImageAspect = true, cleanView = false, onUploadImage, onImageBoxBgStateChange, expandPreviewBoxId, perspectiveBoxId, perspectiveMode = 'distort', displayValues, displayElementData }, ref) {
    const canvasRef    = useRef<HTMLCanvasElement>(null);
    const wrapperRef   = useRef<HTMLDivElement>(null);
    const cachedImgRef = useRef<HTMLImageElement | null>(null);
    const videoRef     = useRef<HTMLVideoElement>(null);
    const animFrameRef  = useRef<number | null>(null);
    const pulseAlphaRef = useRef(0.12);
    const isDraggingElementRef = useRef(isDraggingElement);
    const textDragRef = useRef(false);
    const invertedSlotsRef     = useRef(invertedSlots);
    const pulseRafRef   = useRef<number | null>(null);
    const videoModeRef = useRef(!!videoSrc);
    useEffect(() => { videoModeRef.current = !!videoSrc; }, [videoSrc]);
    const trimStartRef = useRef(0);
    const trimEndRef   = useRef(Infinity);

    const videoSrcRef = useRef<string | undefined>(videoSrc);
    useEffect(() => { videoSrcRef.current = videoSrc; }, [videoSrc]);
    const [isVideoExporting,    setIsVideoExporting]    = useState(false);
    const [videoExportProgress, setVideoExportProgress] = useState(0);
    const [videoExportStatus,   setVideoExportStatus]   = useState('');
    const videoExportAbortRef         = useRef<AbortController | null>(null);
    const onRecordingStateChangeRef   = useRef(onRecordingStateChange);
    useEffect(() => { onRecordingStateChangeRef.current = onRecordingStateChange; }, [onRecordingStateChange]);

    const imgOffsetRef      = useRef({ x: 0, y: 0 });
    const imgScaleRef       = useRef(1);
    // Stores committed crop as source-rect in image's natural pixel coords
    const imgSrcCropRef     = useRef<{ sx: number; sy: number; sw: number; sh: number } | null>(null);
    // Saved state from before entering crop mode (for Escape / cancel)
    const cropEntryStateRef = useRef<{
      crop:  typeof imgSrcCropRef.current;
      ox: number; oy: number; sc: number;
    } | null>(null);
    const [imgScale,   setImgScale]   = useState(1);
    const [isDragging, setIsDragging] = useState(false);
    const [isCropMode, setIsCropMode] = useState(false);
    const [cropRect,   setCropRect]   = useState({ x: 0, y: 0, w: CAROUSEL_PREVIEW_W, h: CAROUSEL_PREVIEW_H });
    const [cropLock,   setCropLock]   = useState<'free' | '4:5'>('free');
    const dragStartRef     = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });
    const cropOverlayRef   = useRef<HTMLCanvasElement>(null);
    const cropActiveHandle = useRef<string | null>(null);
    const cropDragStart    = useRef({ mx: 0, my: 0, rect: { x: 0, y: 0, w: 0, h: 0 } });
    const cropRectRef      = useRef({ x: 0, y: 0, w: CAROUSEL_PREVIEW_W, h: CAROUSEL_PREVIEW_H });
    const cropLockRef      = useRef<'free' | '4:5'>('free');
    useEffect(() => { cropRectRef.current = cropRect; }, [cropRect]);
    useEffect(() => { cropLockRef.current = cropLock; }, [cropLock]);

    const [slots,         setSlots]         = useState<(SlotContent | null)[]>(Array(3).fill(null));
    const slotsRef        = useRef<(SlotContent | null)[]>(Array(6).fill(null));
    const logoImgsRef     = useRef<(HTMLImageElement | null)[]>(Array(3).fill(null));
    const zoneLogoImgsRef = useRef<(HTMLImageElement | null)[]>(Array(9).fill(null));
    // Freeform logo elements — images keyed by element id
    const freeLogoImgsRef = useRef<Record<string, HTMLImageElement | null>>({});
    const subImgRefsArr   = useRef<(HTMLImageElement | null)[]>(Array(3).fill(null));

    // ── Rect mode state (replaces both circles when rectMode=true) ────────────
    // Stores the preview-px band [top, bottom, left, right] between the top-3 and bottom-3 tag slots (rectMode)
    const rectBandRef                     = useRef({ top: 0, bottom: 0, left: 0, right: 0 });

    const [circleSrcs, setCircleSrcs] = useState<(string|null)[]>([null, null]);
    const circleImgRefsArr    = useRef<(HTMLImageElement|null)[]>([null, null]);
    const circleInput0Ref     = useRef<HTMLInputElement>(null);
    const circleInput1Ref     = useRef<HTMLInputElement>(null);
    const circlePosRefsArr    = useRef<({x:number;y:number}|null)[]>([null, null]);
    const [circlePoses, setCirclePoses]   = useState<({x:number;y:number}|null)[]>([null, null]);
    const [activeDragCircle, setActiveDragCircle]     = useState<number|null>(null);
    const circleDragStart     = useRef({ mx: 0, my: 0, cx: 0, cy: 0 });
    const [activeDragTextBox, setActiveDragTextBox]   = useState<number|null>(null);
    const textBoxDragStart    = useRef({ mx: 0, my: 0, x: 0, y: 0 });
    const [selectedTextBox, setSelectedTextBox]       = useState<number|null>(null);
    const [activeResizeTextBox, setActiveResizeTextBox] = useState<number|null>(null);
    const textBoxResizeStart  = useRef({ handle: 'se', mx: 0, my: 0, x: 0, y: 0, w: 0, h: 0 });
    const [snapGuideX, _setSnapGuideX] = useState<number|null>(null);  // canvas px
    const [snapGuideY, _setSnapGuideY] = useState<number|null>(null);  // canvas px
    // No-op bailout (like setFreeSnap/setTextSnap): the drag handlers call these every frame, so skip the
    // re-render when the guide position is unchanged — fewer commits per drag frame.
    const setSnapGuideX = (v: number | null) => _setSnapGuideX(p => p === v ? p : v);
    const setSnapGuideY = (v: number | null) => _setSnapGuideY(p => p === v ? p : v);
    const [altHeld, setAltHeld] = useState(false);  // Option/Alt held → show spacing measurements
    // Image boxes (free positioned images dropped from Uploads)
    const [selectedImageBox, setSelectedImageBox]         = useState<number|null>(null);
    const [activeDragImageBox, setActiveDragImageBox]     = useState<number|null>(null);
    const [activeResizeImageBox, setActiveResizeImageBox] = useState<number|null>(null);
    const imageBoxDragStart   = useRef({ mx: 0, my: 0, x: 0, y: 0 });
    const imageBoxResizeStart = useRef({ handle: 'se', mx: 0, my: 0, x: 0, y: 0, w: 0, h: 0, aspect: 1 });
    // Centre-edge handles crop instead of scaling (changes aspect, ignores the lock)
    const [activeCropImageBox, setActiveCropImageBox] = useState<number|null>(null);
    const imageBoxCropStart   = useRef({ handle: 'e', mx: 0, my: 0, x: 0, y: 0, w: 0, h: 0, cropL: 0, cropR: 0, cropT: 0, cropB: 0 });
    // Drag-replace: index of the image/video box a MATCHING tray payload is hovering over — dropping
    // swaps that box's media in place (see the frame's onDragOver/onDrop and replaceBoxMedia).
    const [dropReplaceImageBox, setDropReplaceImageBox] = useState<number|null>(null);
    // Circular image-box reframe: double-click a circular box → drag pans the photo inside the disc, scroll zooms.
    const [reframeImageBox, setReframeImageBox] = useState<number|null>(null);
    const imageBoxReframeStart = useRef({ mx: 0, my: 0, startX: 0, startY: 0, sw: 1, sh: 1, slackX: 0, slackY: 0, bwPx: 1, bhPx: 1 });
    const imageBoxDivRefs = useRef<(HTMLDivElement | null)[]>([]);
    const imageBoxImgsRef     = useRef<Map<string, HTMLImageElement>>(new Map());
    const imageBoxBufRef      = useRef<HTMLCanvasElement | null>(null);  // offscreen buffer for rounded-corner shadows
    const circleRadsArr       = useRef<number[]>([90, 90]);
    const [circleRadii, setCircleRadii]   = useState<number[]>([90, 90]);
    const [activeResizeCircle, setActiveResizeCircle] = useState<number|null>(null);
    const circleResizeStart   = useRef({ cx: 0, cy: 0 });
    const circleImgOffsetsArr = useRef<{x:number;y:number}[]>([{x:0,y:0},{x:0,y:0}]);
    const circleImgScalesArr  = useRef<number[]>([1, 1]);
    const [circleImgEditModes, setCircleImgEditModes] = useState<boolean[]>([false, false]);
    const [activeImgDragCircle, setActiveImgDragCircle]   = useState<number|null>(null);
    const circleImgDragStart  = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });
    const [activeZoomDragCircle, setActiveZoomDragCircle] = useState<number|null>(null);
    const circleZoomDragStart = useRef({ my: 0, scale: 1 });
    const circleEl0Ref        = useRef<HTMLDivElement>(null);
    const circleEl1Ref        = useRef<HTMLDivElement>(null);
    const fgMaskImgRef          = useRef<HTMLImageElement | null>(null);
    const [fgMaskSrc, setFgMaskSrc] = useState<string | null>(null);
    const fgMaskSrcRef          = useRef<string | null>(null);
    const [isBgProcessing, setIsBgProcessing] = useState(false);
    const [bgProcessError, setBgProcessError] = useState(false);
    // Per-image-box subject split: cut-out images (keyed by source url), an fg-layer
    // offscreen buffer, in-flight guards, and per-box bg-removal status for the panel.
    const imageBoxFgImgsRef     = useRef<Map<string, HTMLImageElement>>(new Map());
    const imageBoxFgBufRef      = useRef<HTMLCanvasElement | null>(null);
    const imageBoxFgPendingRef  = useRef<Set<string>>(new Set());
    const imageBoxFgPromisesRef = useRef<Map<string, Promise<void>>>(new Map());   // export waits on these
    const [imageBoxBgStatus, setImageBoxBgStatus] = useState<Record<string, 'processing' | 'error'>>({});
    const [imageBoxSrcTick, setImageBoxSrcTick] = useState(0);   // bumped when a box source loads → re-runs the split compute
    // Latest callbacks via refs so the (per-box) split effect needn't list them as deps.
    const onUploadImageRef    = useRef(onUploadImage);
    const onSettingsChangeRef = useRef(onSettingsChange);
    useEffect(() => { onUploadImageRef.current = onUploadImage; onSettingsChangeRef.current = onSettingsChange; });
    useEffect(() => { onImageBoxBgStateChange?.(imageBoxBgStatus); }, [imageBoxBgStatus, onImageBoxBgStateChange]);
    useEffect(() => { circlePosRefsArr.current = [...circlePoses]; }, [circlePoses]);
    useEffect(() => { circleRadsArr.current    = [...circleRadii]; }, [circleRadii]);
    const instanceId      = useRef(Math.random().toString(36).slice(2)).current;
    const [customTagText,   setCustomTagText]   = useState('');
    const [showCustom,      setShowCustom]      = useState(false);
    const [showQuotePicker, setShowQuotePicker] = useState<number | null>(null);
    // blockTopPv tracks the text-block's top edge in preview-px so above-headline slots stay anchored
    const [blockTopPv,   setBlockTopPv]   = useState(384);
    const [headBlockHPv, setHeadBlockHPv] = useState(0);
    const [subBlockHPv,  setSubBlockHPv]  = useState(0);
    // Auto-height for free text boxes: drawTextBox measures each (non-fit-to-width) box's wrapped text
    // height (canvas units) and stores it here so the selection frame + resize hug the text vertically.
    const [textBoxHeights, setTextBoxHeights] = useState<Record<string, number>>({});
    const [gapPv,        setGapPv]        = useState(0);

    // ── Drag bookkeeping for the merged skeleton/freeform experience ──────────
    const [freeDragKind, setFreeDragKind] = useState<FreeElement['kind'] | null>(null);
    const [selectedFreeEl, setSelectedFreeEl] = useState<number | null>(null);
    const [selectedZoneSlot, setSelectedZoneSlot] = useState<{ kind: 'logo' | 'tag' | 'quote' | 'swipe'; index: number } | null>(null);
    const [playingVideoUrl, setPlayingVideoUrl] = useState<string | null>(null);
    const videoBoxElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());  // one <video> per videoUrl for video boxes
    const [freeSnap, _setFreeSnap] = useState<{ row: number; zi: number } | null>(null);
    const freeSnapRef = useRef<{ row: number; zi: number } | null>(null);
    const setFreeSnap = (v: { row: number; zi: number } | null) => {
      freeSnapRef.current = v;
      _setFreeSnap(prev => (prev?.row === v?.row && prev?.zi === v?.zi ? prev : v));
    };
    const [activeResizeFreeEl, setActiveResizeFreeEl] = useState<number | null>(null);
    const freeElResizeStart = useRef({ handle: 'se', mx: 0, my: 0, x: 0, y: 0, w: 0, h: 0, aspect: 1 });
    const [textDragActive, setTextDragActive] = useState(false);
    const [textSnap, _setTextSnap] = useState<'headline' | 'sub' | null>(null);
    const textSnapRef = useRef<'headline' | 'sub' | null>(null);
    const setTextSnap = (v: 'headline' | 'sub' | null) => {
      textSnapRef.current = v;
      _setTextSnap(prev => (prev === v ? prev : v));
    };
    // Which indicators appear depends on WHAT is being dragged: zone rows are
    // drop points for elements; the headline/sub bands are drop points for text.
    const elementDrag = freeDragKind != null ||
      (draggingKind != null && draggingKind !== 'text' && draggingKind !== 'image');
    const textDrag = textDragActive || draggingKind === 'text';
    // Rich text editing overlay
    const [richEditTarget, setRichEditTarget] = useState<'headline' | 'sub' | null>(null);
    const richEditTargetRef  = useRef<'headline' | 'sub' | null>(null);
    // Single-selection invariant: at most ONE element is ever selected. Selecting any element clears the
    // other four selection kinds — image box / text box / free element / zone slot / headline-sub rich
    // edit — regardless of type. Every selection entry point routes through these helpers.
    const clearOtherSelections = (keep: 'image' | 'text' | 'free' | 'zone' | 'rich') => {
      if (keep !== 'image') setSelectedImageBox(null);
      if (keep !== 'text')  setSelectedTextBox(null);
      if (keep !== 'free')  setSelectedFreeEl(null);
      if (keep !== 'zone')  setSelectedZoneSlot(null);
      if (keep !== 'rich')  setRichEditTarget(null);
    };
    const selectImageBoxOnly = (i: number | null) => { clearOtherSelections('image'); setSelectedImageBox(i); };
    const selectTextBoxOnly  = (i: number | null) => { clearOtherSelections('text');  setSelectedTextBox(i); };
    const selectFreeElOnly   = (i: number | null) => { clearOtherSelections('free');  setSelectedFreeEl(i); };
    const selectRichEditOnly = (t: 'headline' | 'sub' | null) => { clearOtherSelections('rich'); setRichEditTarget(t); };
    // Select a zone slot (logo/tag/quote/swipe), clearing every other selection.
    const selectZone = (kind: 'logo' | 'tag' | 'quote' | 'swipe', index: number) => {
      clearOtherSelections('zone'); setSelectedZoneSlot({ kind, index });
    };
    const richEditRef        = useRef<HTMLDivElement>(null);
    // Inline editing of a free text box (double-click to type straight into it)
    const [editingTextBox, setEditingTextBox] = useState<number | null>(null);
    const editingTextBoxRef = useRef<number | null>(null);
    const editTextRef       = useRef<HTMLDivElement>(null);
    const savedSelRef        = useRef<Range | null>(null);
    const [toolbarPos,     setToolbarPos]     = useState<{ top: number; left: number } | null>(null);

    const headlineRef    = useRef(headline);
    const subheadlineRef = useRef(subheadline);
    useEffect(() => { headlineRef.current    = headline; },    [headline]);
    useEffect(() => { subheadlineRef.current = subheadline; }, [subheadline]);
    // Display-time data fill — read via refs so the (deps-free) drawCanvas sees the latest values.
    const displayValuesRef = useRef(displayValues);
    const displayElementDataRef = useRef(displayElementData);
    useEffect(() => { displayValuesRef.current = displayValues; displayElementDataRef.current = displayElementData; });
    // Same token grammar as lib/automations fillText; unmapped tokens stay as-is (drawn as {variables}).
    const substDisplay = useCallback((t: string): string => {
      const v = displayValuesRef.current;
      if (!v || !t || t.indexOf('{') === -1) return t;
      return t.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (m, k) => (k in v ? v[k] : m));
    }, []);
    // Clear stale spans if the headline text is changed externally (e.g., settings panel textarea)
    useEffect(() => {
      if (!settingsRef.current.headlineSpans) return;
      const t = settingsRef.current.headlineSpans.map(s => s.text).join('');
      if (t !== headline) onSettingsChange?.({ headlineSpans: null });
    }, [headline]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
      if (!settingsRef.current.subSpans) return;
      const t = settingsRef.current.subSpans.map(s => s.text).join('');
      if (t !== subheadline) onSettingsChange?.({ subSpans: null });
    }, [subheadline]); // eslint-disable-line react-hooks/exhaustive-deps

    const drawCanvas = useCallback((
      img: HTMLImageElement | null,
      imgOx: number, imgOy: number, imgSc: number,
      s: CarouselSettings,
      targetCanvas?: HTMLCanvasElement | OffscreenCanvas,
      videoFrameOverride?: { source: CanvasImageSource; vw: number; vh: number } | null,
    ) => {
      const canvas = targetCanvas ?? canvasRef.current;
      if (!canvas) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (canvas as any).getContext('2d') as CanvasRenderingContext2D | null;
      if (!ctx) return;
      const sc = canvas.width / W;
      ctx.setTransform(sc, 0, 0, sc, 0, 0);

      const setLS = (px: number) => { (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${px * sc}px`; };

      const fontDef    = resolveCarouselFont(s.fontLabel);
      const subFontDef = resolveCarouselFont(s.subFontLabel);
      const fs  = (sz: number) => `${s.italic    ? 'italic ' : ''}${s.fontWeight}  ${sz}px ${fontDef.css}`;
      const sfs = (sz: number) => `${s.subItalic ? 'italic ' : ''}${s.subFontWeight} ${sz}px ${subFontDef.css}`;

      ctx.clearRect(0, 0, W, H);
      if (!s.canvasTransparent) {
        ctx.fillStyle = s.canvasColor ?? '#000000';
        ctx.fillRect(0, 0, W, H);
      }
      // (transparent → leave the cleared, alpha-0 background; the editor shows a checkerboard behind it)

      if (img) {
        const crop = imgSrcCropRef.current;
        const sx = crop?.sx ?? 0;
        const sy = crop?.sy ?? 0;
        const sw = crop?.sw ?? img.naturalWidth;
        const sh = crop?.sh ?? img.naturalHeight;
        const baseScale      = Math.max(W / sw, H / sh);
        const effectiveScale = baseScale * imgSc;
        const drawW = sw * effectiveScale;
        const drawH = sh * effectiveScale;
        const drawX = (W - drawW) / 2 + imgOx;
        const drawY = (H - drawH) / 2 + imgOy;
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
        const fgMask = fgMaskImgRef.current;
        if (s.bgBlurEnabled && fgMask) {
          const defaultOrder: LayerId[] = ['background', 'circle', 'circle2', 'subject'];
          const order: LayerId[] = (s.layerOrder && s.layerOrder.length >= 4) ? s.layerOrder : defaultOrder;
          const drawCircle = (ci: number) => {
            const _cImg = circleImgRefsArr.current[ci];
            if (!_cImg) return;
            const _pos = circlePosRefsArr.current[ci];
            const _defX = ci === 0 ? Math.round(CAROUSEL_PREVIEW_W / 4) : Math.round(CAROUSEL_PREVIEW_W * 3 / 4);
            const _cX = _pos ? _pos.x / DISPLAY_SCALE : _defX / DISPLAY_SCALE;
            const _cY = _pos ? _pos.y / DISPLAY_SCALE : H / 2;
            const _cR = Math.round(circleRadsArr.current[ci] / DISPLAY_SCALE);
            const _shadowEnabled = ci === 0 ? s.circleShadowEnabled : s.circle2ShadowEnabled;
            const _lift = ci === 0 ? s.circleLift : s.circle2Lift;
            if (_shadowEnabled || _lift > 0) {
              ctx.save();
              if (_shadowEnabled) {
                ctx.shadowBlur    = ci === 0 ? s.circleShadowBlur    : s.circle2ShadowBlur;
                ctx.shadowOffsetX = ci === 0 ? s.circleShadowOffsetX : s.circle2ShadowOffsetX;
                ctx.shadowOffsetY = ci === 0 ? s.circleShadowOffsetY : s.circle2ShadowOffsetY;
                ctx.shadowColor   = hexToRgba(ci === 0 ? s.circleShadowColor : s.circle2ShadowColor, (ci === 0 ? s.circleShadowOpacity : s.circle2ShadowOpacity) / 100);
              } else {
                ctx.shadowBlur = _lift * 0.5; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = _lift * 0.3; ctx.shadowColor = 'rgba(0,0,0,0.7)';
              }
              ctx.beginPath(); ctx.arc(_cX, _cY, _cR, 0, Math.PI * 2); ctx.fillStyle = '#000'; ctx.fill();
              ctx.restore();
            }
            ctx.save();
            ctx.beginPath(); ctx.arc(_cX, _cY, _cR, 0, Math.PI * 2); ctx.clip();
            const _cs  = Math.max((_cR * 2) / _cImg.naturalWidth, (_cR * 2) / _cImg.naturalHeight);
            const _ecs = _cs * circleImgScalesArr.current[ci];
            const _off = circleImgOffsetsArr.current[ci];
            const _cdw = _cImg.naturalWidth * _ecs, _cdh = _cImg.naturalHeight * _ecs;
            ctx.drawImage(_cImg, _cX - _cdw / 2 + _off.x, _cY - _cdh / 2 + _off.y, _cdw, _cdh);
            ctx.restore();
            const _bw = ci === 0 ? s.circleBorderWidth   : s.circle2BorderWidth;
            const _bo = ci === 0 ? s.circleBorderOpacity : s.circle2BorderOpacity;
            const _bc = ci === 0 ? s.circleBorderColor   : s.circle2BorderColor;
            if (_bw > 0 && _bo > 0) {
              ctx.save();
              ctx.beginPath(); ctx.arc(_cX, _cY, _cR, 0, Math.PI * 2);
              ctx.strokeStyle = hexToRgba(_bc, _bo / 100); ctx.lineWidth = _bw; ctx.stroke();
              ctx.restore();
            }
          };
          const drawRect = () => {
            const _rImg = circleImgRefsArr.current[0];
            if (!_rImg) return;
            const { top: _rtPv, bottom: _rbPv, left: _rlPv } = rectBandRef.current;
            const _rl  = _rlPv / DISPLAY_SCALE;
            const _rt  = _rtPv / DISPLAY_SCALE;
            const _rw  = W - _rl * 2;
            const _rh  = (_rbPv - _rtPv) / DISPLAY_SCALE;
            const SHIFT_CV = Math.round(50 / DISPLAY_SCALE);
            const _pos = circlePosRefsArr.current[0];
            const _cr  = _pos ? Math.round(circleRadsArr.current[0] / DISPLAY_SCALE) : Math.min(_rh, _rw) / 2 - Math.round(4 / DISPLAY_SCALE);
            const _cx  = _pos ? _pos.x / DISPLAY_SCALE : W / 2 + SHIFT_CV;
            const _cy  = _pos ? _pos.y / DISPLAY_SCALE : _rt + _rh / 2;
            ctx.save();
            ctx.beginPath(); ctx.arc(_cx, _cy, _cr, 0, Math.PI * 2); ctx.clip();
            const _cs  = Math.max((_cr * 2) / _rImg.naturalWidth, (_cr * 2) / _rImg.naturalHeight);
            const _ecs = _cs * circleImgScalesArr.current[0];
            const _off = circleImgOffsetsArr.current[0];
            const _cdw = _rImg.naturalWidth * _ecs, _cdh = _rImg.naturalHeight * _ecs;
            ctx.drawImage(_rImg, _cx - _cdw / 2 + _off.x, _cy - _cdh / 2 + _off.y, _cdw, _cdh);
            ctx.restore();
          };

          for (const layer of order) {
            if (layer === 'background') {
              if (s.bgBlurAmount > 0) {
                const blurPx = Math.max(1, Math.round(s.bgBlurAmount * sc));
                ctx.filter = `blur(${blurPx}px)`;
                // Overdraw past the canvas edges so the blur kernel never samples the transparent
                // area outside the image — otherwise the borders fade out and the slide background
                // bleeds through. Margin ≈ 2× the blur radius covers the gaussian falloff; the
                // canvas bitmap crops the overflow.
                const m = blurPx * 2;
                ctx.drawImage(img, sx, sy, sw, sh, drawX - m, drawY - m, drawW + 2 * m, drawH + 2 * m);
                ctx.filter = 'none';
              } else {
                ctx.drawImage(img, sx, sy, sw, sh, drawX, drawY, drawW, drawH);
              }
              if (s.bgDarkenAmount > 0) {
                ctx.fillStyle = `rgba(0,0,0,${(s.bgDarkenAmount / 100).toFixed(3)})`;
                ctx.fillRect(0, 0, W, H);
              }
            } else if (layer === 'circle') {
              rectMode ? drawRect() : drawCircle(0);
            } else if (layer === 'circle2') {
              if (!rectMode) drawCircle(1);
            } else if (layer === 'subject') {
              ctx.drawImage(fgMask, sx, sy, sw, sh, drawX, drawY, drawW, drawH);
            }
          }
        } else {
          ctx.drawImage(img, sx, sy, sw, sh, drawX, drawY, drawW, drawH);
        }
        ctx.restore();
      } else if (videoFrameOverride || (videoRef.current && videoRef.current.readyState >= 2)) {
        const vSrc: CanvasImageSource = videoFrameOverride ? videoFrameOverride.source : videoRef.current!;
        const vw = videoFrameOverride ? videoFrameOverride.vw : (videoRef.current!.videoWidth || 1);
        const vh = videoFrameOverride ? videoFrameOverride.vh : (videoRef.current!.videoHeight || 1);
        const crop = imgSrcCropRef.current;
        const sx = crop?.sx ?? 0, sy = crop?.sy ?? 0;
        const sw = crop?.sw ?? vw, sh = crop?.sh ?? vh;
        const baseScale = Math.max(W / sw, H / sh);
        const drawW = sw * baseScale * imgSc, drawH = sh * baseScale * imgSc;
        const drawX = (W - drawW) / 2 + imgOx, drawY = (H - drawH) / 2 + imgOy;
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
        ctx.drawImage(vSrc, sx, sy, sw, sh, drawX, drawY, drawW, drawH);
        if (s.bgDarkenAmount > 0) {
          ctx.fillStyle = `rgba(0,0,0,${(s.bgDarkenAmount / 100).toFixed(3)})`;
          ctx.fillRect(0, 0, W, H);
        }
        ctx.restore();
      }

      const rawHead0 = s.headlineSpans ? s.headlineSpans.map(sp => sp.text).join('') : headlineRef.current;
      const rawSub0  = s.subSpans      ? s.subSpans.map(sp => sp.text).join('')      : subheadlineRef.current;
      // Data fill for display: mapped {tokens} draw as their values (layout measures the same string).
      // When a fill changed the text, the raw rich spans no longer line up — fall back to placeholder
      // tinting for that draw (headFilled/subFilled below).
      const rawHead = substDisplay(rawHead0);
      const rawSub  = substDisplay(rawSub0);
      const headFilled = rawHead !== rawHead0;
      const subFilled  = rawSub !== rawSub0;
      const text    = s.allCaps    ? rawHead.trim().toUpperCase() : rawHead.trim();
      const subText = s.subAllCaps ? rawSub.trim().toUpperCase()  : rawSub.trim();
      // Skip the rest only when there's truly NOTHING to draw. Slot/zone content,
      // dividers and freeform elements all render below and are independent of the
      // headline/sub block — an empty-text slide must still draw them.
      const hasSlotContent = !!(
        (s.freeElements ?? []).length ||
        s.tagZoneSlots?.some(Boolean) || s.quoteZoneSlots?.some(Boolean) ||
        s.zoneLogoSlots?.some(Boolean) || s.swipeZoneSlots?.some(Boolean) ||
        s.dividerSlots?.some(Boolean) ||
        (s.tagSlots ?? []).some(Boolean) || (s.quoteSlots ?? []).some(Boolean) ||
        (s.logoRowSlots ?? []).some(Boolean) ||
        logoImgsRef.current.some(Boolean) || slotsRef.current.some(Boolean)
      );
      // The settings fade is drawn further below, so an otherwise-empty slide with the fade enabled
      // must NOT bail here — else the fade never renders on a blank canvas.
      const fadeWillShow = !!(s.showFade || s.showTopFade) && !s.fadeHidden;
      if (!text && !subText && !(s.imageBoxes ?? []).length && !(s.textBoxes ?? []).length && !hasSlotContent && !textDragRef.current && !fadeWillShow) return;

      const padX      = Math.round(32 + s.contentPadding * 0.64);
      const padBot    = Math.round(40 + s.contentPadding * 0.80);
      const MAX_W     = W - padX * 2;
      const lsPx      = (s.lSpacing    / 100) * 20;
      const subLsPx   = (s.subLSpacing / 100) * 20;
      const lhMult    = 1.0 + (s.lHeight    / 100) * 1.2;
      const subLhMult = 1.0 + (s.subLHeight / 100) * 1.2;

      const hasSub   = subText.length > 0;

      const hSize = s.fontSize;
      let hLines: string[] = [];
      if (text) {
        setLS(lsPx);
        ctx.font = fs(hSize);
        hLines = wrapText(ctx, text, MAX_W);
      }
      const hLineH  = hSize * lhMult;
      // Text drag: a vacant slot reserves one line of its own height, so the
      // layout previews the final positions and the drop band matches exactly.
      const reserveText = textDragRef.current;
      const hBlockH = hLines.length * hLineH + (reserveText && !text ? hLineH : 0);

      const sSize = s.subFontSize;
      let sLines: string[] = [];
      if (subText) {
        setLS(subLsPx);
        ctx.font = sfs(sSize);
        sLines = wrapText(ctx, subText, MAX_W);
      }
      const sLineH  = sSize * subLhMult;
      const sBlockH = sLines.length * sLineH + (reserveText && !subText ? sLineH : 0);
      const gap         = (hasSub || (reserveText && !subText)) && (text || (reserveText && !text))
        ? hSize * (s.headSubGap / 100) : 0;
      // Bottom slot is hidden when nothing is placed there and nothing is being dragged
      const hasBottomContent = !!(
        slotsRef.current[2] ||
        s.dividerSlots?.[2] ||
        s.tagSlots?.[2] ||
        s.quoteSlots?.[2] ||
        s.tagZoneSlots?.slice(6).some(Boolean) ||
        s.zoneLogoSlots?.slice(6).some(Boolean) ||
        s.quoteZoneSlots?.slice(6).some(Boolean) ||
        s.swipeZoneSlots?.slice(6).some(Boolean)
      );
      const invSl = invertedSlotsRef.current;
      const hasTopContent = !!(
        slotsRef.current[0] || s.dividerSlots?.[0] || s.tagSlots?.[0] || s.quoteSlots?.[0] ||
        s.tagZoneSlots?.slice(0, 3).some(Boolean) || s.zoneLogoSlots?.slice(0, 3).some(Boolean) ||
        s.quoteZoneSlots?.slice(0, 3).some(Boolean) || s.swipeZoneSlots?.slice(0, 3).some(Boolean)
      );
      const showBottomSlot = invSl ? true  : (isDraggingElementRef.current || hasBottomContent);
      const showTopSlot    = invSl ? (isDraggingElementRef.current || hasTopContent) : true;
      const showMiddleSlot = !invSl;
      const showSlot       = [showTopSlot, showMiddleSlot, showBottomSlot] as const;
      const subSlotCV   = H - (showBottomSlot ? LOGO_CH + padX : padX);
      const aboveGapCV  = Math.round(s.aboveLogoGap / DISPLAY_SCALE);
      // Inverted: text sits just below top slot when visible, or at padX when top slot is hidden
      // Normal: aboveGapCV only moves slot 1 upward — text stays anchored above the bottom slot
      const blockTop    = invSl
        ? (showTopSlot ? (padX + LOGO_CH + aboveGapCV) : padX)
        : Math.max(padX, subSlotCV - (hBlockH + gap + sBlockH));

      if (!targetCanvas) {
        const btp = Math.round(blockTop * DISPLAY_SCALE);
        setBlockTopPv(prev => prev === btp ? prev : btp);
        const hbhPv = Math.round(hBlockH * DISPLAY_SCALE);
        setHeadBlockHPv(prev => prev === hbhPv ? prev : hbhPv);
        const sbhPv = Math.round(sBlockH * DISPLAY_SCALE);
        setSubBlockHPv(prev => prev === sbhPv ? prev : sbhPv);
        const gPv = Math.round(gap * DISPLAY_SCALE);
        setGapPv(prev => prev === gPv ? prev : gPv);
      }

      // Free-element layer order (+ the settings fade). Computed once; reused by the element pass below.
      const imgBoxes = s.imageBoxes ?? [];
      const txtBoxes = s.textBoxes ?? [];
      const freeEls  = s.freeElements ?? [];
      const fadeEnabled  = !!(s.showFade || s.showTopFade);
      const fadeShown    = fadeEnabled && !s.fadeHidden;
      const layers       = orderedLayerIds(imgBoxes, txtBoxes, freeEls, s.layerOrderIds, fadeEnabled, true, s.zoneLogoSlots, { tagSlots: s.tagSlots, quoteSlots: s.quoteSlots, tagZoneSlots: s.tagZoneSlots, quoteZoneSlots: s.quoteZoneSlots, swipeZoneSlots: s.swipeZoneSlots });
      const fadeAtBottom = layers.length > 0 && layers[0].kind === 'fade';

      // Settings fade (bottom + top gradient overlay). Drawn here when it's the bottom layer — its
      // original position, under all content — otherwise within the element pass at its layer position.
      // Fill a gradient with many smoothstep-sampled stops (alpha a0→a1). smoothstep has zero slope at
      // both ends, so the transparent end ramps in gradually instead of starting at a linear slope — that
      // slope discontinuity is what reads as a hard "line" at the edge of the fade.
      const addSmoothStops = (g: CanvasGradient, a0: number, a1: number, steps = 32) => {
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const s = t * t * (3 - 2 * t);
          g.addColorStop(t, `rgba(0,0,0,${(a0 + (a1 - a0) * s).toFixed(4)})`);
        }
      };
      const drawFade = () => {
        if (s.showFade) {
          const alpha    = s.fadeIntensity / 100;
          const floorH   = H * 0.6 * (s.fadeFloor / 100);
          const floorTop = H - floorH;
          if (floorH > 0) {
            ctx.fillStyle = `rgba(0,0,0,${alpha.toFixed(3)})`;
            ctx.fillRect(0, floorTop, W, floorH);
          }
          const fadeH      = H * 0.05 + H * 0.95 * (s.fadeReach / 100);
          const gradBottom = floorTop + 0.3;
          const gradTop    = Math.max(0, gradBottom - fadeH);
          if (fadeH > 0 && gradBottom > 0) {
            const grad = ctx.createLinearGradient(0, gradTop, 0, gradBottom);
            addSmoothStops(grad, 0, alpha);   // transparent (top) → solid (bottom)
            ctx.fillStyle = grad;
            ctx.fillRect(0, gradTop, W, gradBottom - gradTop);
          }
        }
        if (s.showTopFade) {
          const alpha  = (s.topFadeIntensity ?? 85) / 100;
          const floorH = H * 0.6 * ((s.topFadeFloor ?? 20) / 100);
          if (floorH > 0) {
            ctx.fillStyle = `rgba(0,0,0,${alpha.toFixed(3)})`;
            ctx.fillRect(0, 0, W, floorH);
          }
          const fadeH      = H * 0.05 + H * 0.95 * ((s.topFadeReach ?? 40) / 100);
          const gradTop    = floorH - 0.3;
          const gradBottom = Math.min(H, gradTop + fadeH);
          if (fadeH > 0 && gradTop < H) {
            const grad = ctx.createLinearGradient(0, gradTop, 0, gradBottom);
            addSmoothStops(grad, alpha, 0);   // solid (top) → transparent (bottom)
            ctx.fillStyle = grad;
            ctx.fillRect(0, gradTop, W, gradBottom - gradTop);
          }
        }
      };
      if (fadeShown && fadeAtBottom) drawFade();

      // Slot Y positions (top / above-headline / sub rows). Declared OUTSIDE the deferred overlay
      // closure below because the circle-image layout further down also reads logoCY_top / logoCY_above.
      const logoCY_top   = padX;
      const logoCY_above = Math.max(0, blockTop - LOGO_CH - Math.round(s.aboveLogoGap / DISPLAY_SCALE));
      const logoCY_sub   = H - LOGO_CH - padX;
      const logoCYs      = [logoCY_top, logoCY_above, logoCY_sub];

      // Skeleton overlays (logos, tags, quotes, dividers, swipes in their fixed slots) paint LAST —
      // after the layer-order loop below — so they sit in front of image/video boxes, like the
      // headline/sub text. This closure captures the layout computed inside it; only the *call* is
      // deferred (these used to draw inline here, i.e. behind every layer).
      const paintSkeletonOverlays = () => {
      const slotFW = W - 2 * padX;
      // Row logos are now painted by paintRowLogos (kind 'skeletonlogos') so they sit BEHIND the hoisted
      // tag/quote/swipe layers — their historical back-most skeleton position.
      // Row tags + row quote marks are now hoisted into the z-order loop (kinds 'rowtag' / 'rowquote'
      // via drawRowTag / drawRowQuote), so each stacks + hides like every other layer.

      // Zone-level independent tag / quote / swipe items (row*3+zone) are now hoisted into the z-order
      // loop (kinds 'zonetag' / 'zonequote' / 'zoneswipe' via drawZoneTag / drawZoneQuote / drawZoneSwipe),
      // so each stacks + hides like every other layer. (Zone logos were already hoisted to 'zonelogo'.)

      // Draw dividers + sub-slot content together (merged so line gaps recalculate from actual content)
      (s.dividerSlots ?? []).forEach((divId, li) => {
        if (!divId || li > 2) return;
        if (li <= 2 && !showSlot[li]) return;
        const subContent = s.dividerSubSlots?.[li] ?? null;
        const szC = subContent ? getSubZoneCanvasBounds(divId, padX, logoCYs[li], slotFW, LOGO_CH) : null;

        // Measure actual rendered content width + center so lines align to content
        let contentW: number | null = null;
        let contentCY: number | null = null;
        let fittedTs: TagStyle | null = null;
        const va = li === 0 ? 'top' as const : li === 2 ? 'bottom' as const : 'center' as const;
        if (subContent && szC) {
          if (subContent.type === 'image') {
            const img = subImgRefsArr.current[li];
            if (img) {
              const imgS = Math.min(szC.w / img.naturalWidth, szC.h / img.naturalHeight);
              const dh = img.naturalHeight * imgS;
              const dy = va === 'top' ? szC.y : va === 'bottom' ? szC.y + szC.h - dh : szC.y + (szC.h - dh) / 2;
              contentW = img.naturalWidth * imgS;
              contentCY = dy + dh / 2;
            }
          } else if (subContent.type === 'tag') {
            const ts = subContent.style;
            const tfd = resolveCarouselFont(ts.fontLabel);
            const pxScale = 1 / DISPLAY_SCALE;
            const tc = ts.textCase ?? 'none';
            const dispTxt = tc === 'upper' ? subContent.text.toUpperCase() : subContent.text;
            const variant = tc === 'smallcaps' ? 'small-caps ' : '';
            let fsPx = Math.round(ts.fontSize * pxScale);
            (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing =
              `${((ts.letterSpacing ?? 0) * pxScale).toFixed(2)}px`;
            ctx.font = `${ts.italic ? 'italic ' : ''}${variant}${ts.fontWeight} ${fsPx}px ${tfd.css}`;
            const pxPad = Math.round(ts.paddingX * pxScale);
            const pxPy  = Math.round(ts.paddingY * pxScale);
            // Always measure against full slot width — sub-zone (140px) would artificially shrink font
            const avail = slotFW - pxPad * 2;
            let tw = ctx.measureText(dispTxt).width;
            if (tw > avail && avail > 0) {
              fsPx = Math.max(6, Math.floor(fsPx * avail / tw));
              ctx.font = `${ts.italic ? 'italic ' : ''}${variant}${ts.fontWeight} ${fsPx}px ${tfd.css}`;
              tw = ctx.measureText(dispTxt).width;
            }
            contentW = Math.max(1, tw + pxPad * 2);
            fittedTs = { ...ts, fontSize: Math.round(fsPx / pxScale) };
            const boxH = Math.round(fsPx * 1.2 + pxPy * 2);
            const by = va === 'top' ? logoCYs[li] : va === 'bottom' ? logoCYs[li] + LOGO_CH - boxH : logoCYs[li] + (LOGO_CH - boxH) / 2;
            contentCY = by + boxH / 2;
          } else if (subContent.type === 'swipe') {
            contentW = szC.w;
            contentCY = szC.y + szC.h / 2;
          }
        }

        // For dividers without tag/logo content, pin line to top edge (slot 0) or bottom edge (slots 1/2)
        const isContentDiv = divId.startsWith('tag') || divId.startsWith('logo');
        const positionalCY = (!isContentDiv && contentW == null)
          ? (li === 0 ? logoCYs[li] : logoCYs[li] + LOGO_CH)
          : null;

        // Draw divider lines — placeholder box hidden when contentW is known; lines align to content center
        const divLift = s.dividerSettings?.[li]?.shadow?.lift ?? 0;
        applyShadow(ctx, s.dividerSettings?.[li]?.shadow);
        drawDividerOnCanvas(ctx, divId, padX, logoCYs[li] - divLift, slotFW, LOGO_CH, contentW, contentCY != null ? contentCY - divLift : positionalCY != null ? positionalCY - divLift : null, s.dividerSettings?.[li], pulseAlphaRef.current);
        clearShadow(ctx);

        // Draw content clipped to the original placeholder zone
        if (subContent && szC) {
          const ha = divId.includes('left') ? 'left'   as const
                   : divId.includes('right') ? 'right'  as const
                   : 'center' as const;
          if (subContent.type === 'image') {
            const img = subImgRefsArr.current[li];
            if (img) {
              const isCircle = s.imageShape === 'circle';
              ctx.save();
              if (!isCircle) { ctx.beginPath(); ctx.roundRect(szC.x, szC.y, szC.w, szC.h, 8); ctx.clip(); }
              drawLogoFit(ctx, img, szC.x, szC.y, szC.w, szC.h, ha, va, 100, 0, isCircle, subContent.crop);
              ctx.restore();
            }
          } else if (subContent.type === 'tag' && fittedTs) {
            const tfd = resolveCarouselFont(fittedTs.fontLabel);
            drawTag(ctx, subContent.text, padX, logoCYs[li], slotFW, LOGO_CH, ha, va, fittedTs, tfd.css, 1 / DISPLAY_SCALE);
          } else if (subContent.type === 'swipe') {
            const sfd = resolveCarouselFont(subContent.style.fontLabel);
            drawSwipeOnCanvas(ctx, szC.x, szC.y, szC.w, szC.h, ha, va, subContent.style, sfd.css);
          }
        }
      });
      };  // end paintSkeletonOverlays

      // Freeform zone-style elements — escaped skeleton-box content. Each draws
      // centered inside its stored box, with the same helpers as its zone twin.
      // Invoked from the unified element pass below at its layer position.
      const drawFreeElement = (el: FreeElement) => {
        const ex = el.x, ey = el.y, ew = el.width, eh = el.height;
        if (el.kind === 'tag') {
          const tfd = resolveCarouselFont(el.style.fontLabel);
          const lift = el.style.shadow?.lift ?? 0;
          applyShadow(ctx, el.style.shadow);
          drawTag(ctx, el.text, ex, ey - lift, ew, eh, 'center', 'center', el.style, tfd.css, 1 / DISPLAY_SCALE);
          clearShadow(ctx);
        } else if (el.kind === 'logo') {
          const img = freeLogoImgsRef.current[el.id];
          if (img) {
            // Per-logo style (set via the selected-logo settings section) with a fallback to the global logo style.
            const lShadow = el.shadow ?? s.logoShadow;
            ctx.save();
            ctx.globalAlpha = (el.opacity ?? s.logoOpacity ?? 100) / 100;
            applyShadow(ctx, lShadow);
            drawLogoFit(ctx, img, ex, ey, ew, eh, 'center', 'center', el.scale ?? s.logoScale ?? 100, el.cornerRadius ?? s.logoCornerRadius ?? 0, (el.shape ?? s.logoShape) === 'circle');
            clearShadow(ctx);
            ctx.restore();
          }
        } else if (el.kind === 'quote') {
          const qs = ALL_QUOTE_STYLES.find(q => q.id === el.styleId);
          if (qs) {
            const qColor = s.quoteColor ?? '#ffffff';
            const qSize  = s.quoteSize  ?? 120;
            const qAlpha = (s.quoteOpacity ?? 100) / 100;
            const [vbX, vbY, vbW, vbH] = qs.viewBox;
            const scale = Math.min(qSize / vbW, qSize / vbH);
            const drawW = vbW * scale, drawH = vbH * scale;
            const quoteGap = qs.paired ? (s.quoteGap ?? 8) : 0;
            const totalW   = qs.paired ? drawW * 2 + quoteGap : drawW;
            const zqLift = s.quoteShadow?.lift ?? 0;
            const qx = ex + (ew - totalW) / 2;
            const qy = ey + (eh - drawH) / 2 - zqLift;
            ctx.save(); ctx.globalAlpha = qAlpha; ctx.fillStyle = qColor;
            applyShadow(ctx, s.quoteShadow);
            ctx.translate(qx - vbX * scale, qy - vbY * scale);
            ctx.scale(scale, scale);
            if (qs.pathOffset) ctx.translate(qs.pathOffset.x, qs.pathOffset.y);
            for (const pathD of qs.paths) ctx.fill(new Path2D(pathD));
            clearShadow(ctx);
            ctx.restore();
            if (qs.paired) {
              const cx2 = qx + drawW + quoteGap;
              ctx.save(); ctx.globalAlpha = qAlpha; ctx.fillStyle = qColor;
              applyShadow(ctx, s.quoteShadow);
              ctx.translate(cx2 + drawW / 2, qy + drawH / 2); ctx.rotate(Math.PI);
              ctx.translate(-drawW / 2, -drawH / 2); ctx.translate(-vbX * scale, -vbY * scale);
              ctx.scale(scale, scale);
              if (qs.pathOffset) ctx.translate(qs.pathOffset.x, qs.pathOffset.y);
              for (const pathD of qs.paths) ctx.fill(new Path2D(pathD));
              clearShadow(ctx);
              ctx.restore();
            }
          }
        } else if (el.kind === 'swipe') {
          const sfd = resolveCarouselFont(el.style.fontLabel);
          const lift = el.style.shadow?.lift ?? 0;
          applyShadow(ctx, el.style.shadow);
          drawSwipeOnCanvas(ctx, ex, ey - lift, ew, eh, 'center', 'center', el.style, sfd.css);
          clearShadow(ctx);
        } else if (el.kind === 'divider') {
          const sub = el.sub && el.sub.type !== 'image' ? el.sub : null;
          drawDividerOnCanvas(ctx, el.dividerId, ex, ey, ew, eh, null, null, el.settings ?? null);
          if (sub) {
            const szC = getSubZoneCanvasBounds(el.dividerId, ex, ey, ew, eh);
            if (sub.type === 'tag') {
              const tfd = resolveCarouselFont(sub.style.fontLabel);
              drawTag(ctx, sub.text, ex, ey, ew, eh, 'center', 'center', sub.style, tfd.css, 1 / DISPLAY_SCALE);
            } else if (sub.type === 'swipe' && szC) {
              const sfd = resolveCarouselFont(sub.style.fontLabel);
              drawSwipeOnCanvas(ctx, szC.x, szC.y, szC.w, szC.h, 'center', 'center', sub.style, sfd.css);
            }
          }
        } else if (el.kind === 'custom') {
          // AI-generated element: translate so the draw-function works in its own 0..w × 0..h box, hand it
          // a brand theme + its data, and let the sandboxed runtime draw it. Carousels render the settled
          // frame (progress 1); a video context would step progress over time.
          const fam = resolveCarouselFont(s.fontLabel).css;
          ctx.save();
          ctx.translate(ex, ey);
          renderCustomElement(ctx, el.code, {
            width: ew, height: eh, progress: 1, t: 0,
            // Data fill for display: merge mapped chart/table inputs over the element's sample data.
            data: (() => {
              const mapped = displayElementDataRef.current?.[el.id];
              if (!mapped) return el.data ?? null;
              const base = el.data && typeof el.data === 'object' ? el.data as Record<string, unknown> : {};
              return { ...base, ...mapped };
            })(),
            theme: {
              fg: s.headlineColor ?? '#ffffff',
              bg: s.canvasColor ?? '#000000',
              accent: '#3b82f6',
              muted: 'rgba(255,255,255,0.45)',
              positive: '#22c55e',
              negative: '#ef4444',
              fontFamily: fam,
            },
          });
          ctx.restore();
        }
      };

      // Circle images (drawn between top and bottom slot rows)
      const circleCY = (logoCY_top + LOGO_CH + logoCY_above) / 2; // midpoint between slot 0 and slot 1
      [0, 1].forEach(ci => {
        if (rectMode && ci === 0) return; // rectMode ci=0 handled by drawRect() in bgBlur path and rect block below
        const circleImg = circleImgRefsArr.current[ci];
        if (!circleImg || (s.bgBlurEnabled && fgMaskImgRef.current) || videoModeRef.current) return;
        const pos = circlePosRefsArr.current[ci];
        const _defX  = ci === 0 ? Math.round(CAROUSEL_PREVIEW_W / 4) : Math.round(CAROUSEL_PREVIEW_W * 3 / 4);
        const circleCX   = pos ? pos.x / DISPLAY_SCALE : _defX / DISPLAY_SCALE;
        const circleCanY = pos ? pos.y / DISPLAY_SCALE : circleCY;
        const circleR    = Math.round(circleRadsArr.current[ci] / DISPLAY_SCALE);
        const imgOffset  = circleImgOffsetsArr.current[ci];
        const imgScale   = circleImgScalesArr.current[ci];
        const shadowEnabled = ci === 0 ? s.circleShadowEnabled : s.circle2ShadowEnabled;
        const lift          = ci === 0 ? s.circleLift          : s.circle2Lift;
        if (shadowEnabled || lift > 0) {
          ctx.save();
          if (shadowEnabled) {
            ctx.shadowBlur    = ci === 0 ? s.circleShadowBlur    : s.circle2ShadowBlur;
            ctx.shadowOffsetX = ci === 0 ? s.circleShadowOffsetX : s.circle2ShadowOffsetX;
            ctx.shadowOffsetY = ci === 0 ? s.circleShadowOffsetY : s.circle2ShadowOffsetY;
            ctx.shadowColor   = hexToRgba(ci === 0 ? s.circleShadowColor : s.circle2ShadowColor, (ci === 0 ? s.circleShadowOpacity : s.circle2ShadowOpacity) / 100);
          } else {
            ctx.shadowBlur = lift * 0.5; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = lift * 0.3; ctx.shadowColor = 'rgba(0,0,0,0.7)';
          }
          ctx.beginPath(); ctx.arc(circleCX, circleCanY, circleR, 0, Math.PI * 2); ctx.fillStyle = '#000'; ctx.fill();
          ctx.restore();
        }
        ctx.save();
        ctx.beginPath(); ctx.arc(circleCX, circleCanY, circleR, 0, Math.PI * 2); ctx.clip();
        const cs = Math.max((circleR * 2) / circleImg.naturalWidth, (circleR * 2) / circleImg.naturalHeight);
        const effectiveCs = cs * imgScale;
        const cdw = circleImg.naturalWidth * effectiveCs, cdh = circleImg.naturalHeight * effectiveCs;
        ctx.drawImage(circleImg, circleCX - cdw / 2 + imgOffset.x, circleCanY - cdh / 2 + imgOffset.y, cdw, cdh);
        ctx.restore();
        const bw = ci === 0 ? s.circleBorderWidth   : s.circle2BorderWidth;
        const bo = ci === 0 ? s.circleBorderOpacity : s.circle2BorderOpacity;
        const bc = ci === 0 ? s.circleBorderColor   : s.circle2BorderColor;
        if (bw > 0 && bo > 0) {
          ctx.save();
          ctx.beginPath(); ctx.arc(circleCX, circleCanY, circleR, 0, Math.PI * 2);
          ctx.strokeStyle = hexToRgba(bc, bo / 100); ctx.lineWidth = bw; ctx.stroke();
          ctx.restore();
        }
      });

      // Rect-mode circle — non-bgBlur path (bgBlur path uses drawRect inside layer loop)
      if (rectMode) {
        const rImg = circleImgRefsArr.current[0];
        if (rImg && !(s.bgBlurEnabled && fgMaskImgRef.current) && !videoModeRef.current) {
          const { top: _rtPv, bottom: _rbPv, left: _rlPv } = rectBandRef.current;
          const _rl  = _rlPv / DISPLAY_SCALE;
          const _rt  = _rtPv / DISPLAY_SCALE;
          const _rw  = W - _rl * 2;
          const _rh  = (_rbPv - _rtPv) / DISPLAY_SCALE;
          const SHIFT_CV = Math.round(50 / DISPLAY_SCALE);
          const _pos = circlePosRefsArr.current[0];
          const _cr  = _pos ? Math.round(circleRadsArr.current[0] / DISPLAY_SCALE) : Math.min(_rh, _rw) / 2 - Math.round(4 / DISPLAY_SCALE);
          const _cx  = _pos ? _pos.x / DISPLAY_SCALE : W / 2 + SHIFT_CV;
          const _cy  = _pos ? _pos.y / DISPLAY_SCALE : _rt + _rh / 2;
          ctx.save();
          ctx.beginPath(); ctx.arc(_cx, _cy, _cr, 0, Math.PI * 2); ctx.clip();
          const _cs  = Math.max((_cr * 2) / rImg.naturalWidth, (_cr * 2) / rImg.naturalHeight);
          const _ecs = _cs * circleImgScalesArr.current[0];
          const _off = circleImgOffsetsArr.current[0];
          const _cdw = rImg.naturalWidth * _ecs, _cdh = rImg.naturalHeight * _ecs;
          ctx.drawImage(rImg, _cx - _cdw / 2 + _off.x, _cy - _cdh / 2 + _off.y, _cdw, _cdh);
          ctx.restore();
        }
      }

      ctx.textBaseline = 'alphabetic';

      const editHead = !targetCanvas && richEditTargetRef.current === 'headline';
      const editSub  = !targetCanvas && richEditTargetRef.current === 'sub';
      const headColor = s.headlineColor ?? '#ffffff';
      const subColor  = s.subheadlineColor ?? '#ffffff';
      const headLift = s.headlineShadow?.lift ?? 0;
      const subLift  = s.subShadow?.lift ?? 0;

      // Skeleton text (headline + subheadline) is painted LAST — after the layer-order loop below —
      // so it always sits in front of image/video boxes and free elements. This closure captures the
      // layout computed above; only the *call* is deferred (it used to run inline here, i.e. behind).
      const paintHeadlineText = () => {
        ctx.textBaseline = 'alphabetic';
        applyShadow(ctx, s.headlineShadow);
        if (text && !editHead && !s.headlineHidden) {
          ctx.fillStyle = headColor;
          setLS(lsPx); ctx.font = fs(hSize);
          // Manual rich spans win; otherwise tint any {placeholders} gray so they read as variables.
          // (Skip spans when a data fill changed the text — their offsets no longer match.)
          const headBase = (s.headlineSpans && s.headlineSpans.length > 0 && !headFilled) ? s.headlineSpans : placeholderSpans(text);
          if (headBase) {
            const dispSpans = s.allCaps ? headBase.map(sp => ({ ...sp, text: sp.text.toUpperCase() })) : headBase;
            const linesWO = wrapTextOffsets(ctx, text, MAX_W);
            let y = blockTop - headLift + hLineH * 0.82;
            for (const { line, offset } of linesWO) {
              drawSpanLine(ctx, getLineSpanSegs(dispSpans, offset, line), y, s.textAlign, padX, MAX_W, W, fontDef.css, hSize, s.fontWeight, s.italic, headColor, lsPx, sc);
              y += hLineH;
            }
          } else {
            let y = blockTop - headLift + hLineH * 0.82;
            hLines.forEach((line, i) => { drawAligned(ctx, line, y, i === hLines.length - 1, s.textAlign, padX, MAX_W, W); y += hLineH; });
          }
        }
        clearShadow(ctx);
      };
      const paintSubText = () => {
        ctx.textBaseline = 'alphabetic';
        applyShadow(ctx, s.subShadow);
        if (subText && !editSub && !s.subHidden) {
          ctx.fillStyle = subColor;
          setLS(subLsPx); ctx.font = sfs(sSize);
          const subBase = (s.subSpans && s.subSpans.length > 0 && !subFilled) ? s.subSpans : placeholderSpans(subText);
          if (subBase) {
            const dispSpans = s.subAllCaps ? subBase.map(sp => ({ ...sp, text: sp.text.toUpperCase() })) : subBase;
            const linesWO = wrapTextOffsets(ctx, subText, MAX_W);
            let y = blockTop - subLift + hBlockH + gap + sLineH * 0.82;
            for (const { line, offset } of linesWO) {
              drawSpanLine(ctx, getLineSpanSegs(dispSpans, offset, line), y, s.subTextAlign, padX, MAX_W, W, subFontDef.css, sSize, s.subFontWeight, s.subItalic, subColor, subLsPx, sc);
              y += sLineH;
            }
          } else {
            let y = blockTop - subLift + hBlockH + gap + sLineH * 0.82;
            sLines.forEach((line, i) => { drawAligned(ctx, line, y, i === sLines.length - 1, s.subTextAlign, padX, MAX_W, W); y += sLineH; });
          }
        }
        clearShadow(ctx);
      };

      // ── Free elements (image + text boxes) — drawn in unified layer order; hidden ones skipped ──
      const drawImageBox = (b: ImageBox) => {
        const isCircle = b.shape === 'circle';   // clip to a circle inscribed in the box (overrides corner radius)
        // The disc is a centred square of side = min(box side); the photo is drawn into THAT square (not the
        // whole box), so it never distorts and there is real pan room for a non-square photo even at zoom 1.
        const circleDia = Math.min(b.width, b.height);          // disc diameter (canvas px)
        const circleX   = b.x + (b.width  - circleDia) / 2;     // centred-square top-left
        const circleY   = b.y + (b.height - circleDia) / 2;
        // Circle reframe: sample a SQUARE of the source (the disc shows a square), sized by zoom and panned
        // by x/y (−1..1). Mirrors drawLogoFit / the photo slots. Replaces the edge `crop` for circles.
        const circleCoverRect = (natW: number, natH: number) => {
          const cc = b.circleCrop;
          const zoom = Math.max(1, cc?.zoom ?? 1);
          const ox = Math.max(-1, Math.min(1, cc?.x ?? 0));
          const oy = Math.max(-1, Math.min(1, cc?.y ?? 0));
          const ss = Math.max(1, Math.min(natW, natH) / zoom);   // sampled square side (source px)
          const slackX = natW - ss, slackY = natH - ss;
          return { sx: slackX / 2 + ox * slackX / 2, sy: slackY / 2 + oy * slackY / 2, sw: ss, sh: ss };
        };
        // Video box: paint the live video frame (simple path — opacity/blend/shadow/corner-radius/crop).
        // The image fx/cache/split path below assumes a static source, so videos take this branch instead.
        if (b.videoUrl) {
          const v = videoBoxElsRef.current.get(b.videoUrl);
          if (!v || v.readyState < 2 || !v.videoWidth) return;
          const cp = b.crop;
          const cL = cp?.left ?? 0, cR = cp?.right ?? 0, cT = cp?.top ?? 0, cB = cp?.bottom ?? 0;
          // Cover-crop for circles, but keep honouring a legacy edge-crop (saved before reframe existed)
          // until the user reframes — otherwise their framing would silently reset on load.
          const useCover = isCircle && (b.circleCrop != null || (cL === 0 && cR === 0 && cT === 0 && cB === 0));
          const { sx: vsx, sy: vsy, sw: vsw, sh: vsh } = useCover
            ? circleCoverRect(v.videoWidth, v.videoHeight)
            : { sx: cL * v.videoWidth, sy: cT * v.videoHeight, sw: Math.max(1, (1 - cL - cR) * v.videoWidth), sh: Math.max(1, (1 - cT - cB) * v.videoHeight) };
          ctx.save();
          ctx.globalAlpha = (b.opacity ?? 100) / 100;
          if (b.blend) ctx.globalCompositeOperation = b.blend as GlobalCompositeOperation;
          applyShadow(ctx, b.shadow);
          if (isCircle) { ctx.beginPath(); ctx.arc(b.x + b.width / 2, b.y + b.height / 2, circleDia / 2, 0, Math.PI * 2); ctx.clip(); }
          else if ((b.cornerRadius ?? 0) > 0) { roundRectPath(ctx, b.x, b.y, b.width, b.height, b.cornerRadius); ctx.clip(); }
          if (useCover) ctx.drawImage(v, vsx, vsy, vsw, vsh, circleX, circleY, circleDia, circleDia);   // square → disc square
          else          ctx.drawImage(v, vsx, vsy, vsw, vsh, b.x, b.y, b.width, b.height);
          ctx.restore();
          return;
        }
        const img = imageBoxImgsRef.current.get(b.url);
        if (!img || !img.complete || !img.naturalWidth) return;
        const radius = b.cornerRadius ?? 0;
        // Crop = source sub-rectangle (fraction off each edge) drawn into the box.
        const cp = b.crop;
        const cL = cp?.left ?? 0, cR = cp?.right ?? 0, cT = cp?.top ?? 0, cB = cp?.bottom ?? 0;
        // Cover-crop for circles, but keep honouring a legacy edge-crop (saved before reframe existed)
        // until the user reframes — otherwise their framing would silently reset on load.
        const useCover = isCircle && (b.circleCrop != null || (cL === 0 && cR === 0 && cT === 0 && cB === 0));
        // objectFit 'cover' (rect boxes): fill the box preserving the source aspect, centre-cropping
        // the overflow — no stretch, no gaps (automation-injected slide backgrounds).
        const rectCoverRect = (natW: number, natH: number) => {
          const scale = Math.max(b.width / natW, b.height / natH);
          const cw = b.width / scale, ch = b.height / scale;
          return { sx: (natW - cw) / 2, sy: (natH - ch) / 2, sw: cw, sh: ch };
        };
        const { sx, sy, sw, sh } = useCover
          ? circleCoverRect(img.naturalWidth, img.naturalHeight)
          : !isCircle && b.objectFit === 'cover'
            ? rectCoverRect(img.naturalWidth, img.naturalHeight)
            : {
                sx: cL * img.naturalWidth,
                sy: cT * img.naturalHeight,
                sw: Math.max(1, (1 - cL - cR) * img.naturalWidth),
                sh: Math.max(1, (1 - cT - cB) * img.naturalHeight),
              };
        // Foreground/background adjustments. When "detect background" is on and the cut-out is ready,
        // the foreground effects apply to the subject and the background effects to the rest; otherwise
        // the foreground effects apply to the WHOLE image. (Effects: brightness/blur/noise. Edge fade is
        // applied over the composited result.)
        const fgImg = imageBoxFgImgsRef.current.get(b.url);
        const split    = !!b.splitEnabled && !!fgImg && fgImg.complete && !!fgImg.naturalWidth;
        const fgActive = imageEffectsActive(b.fgEffects);
        const bgActive = split && imageEffectsActive(b.bgEffects);
        // Edge fade is per-layer: b.fade = foreground (subject when split, whole image otherwise);
        // b.bgFade = background (split only).
        const fgFadeActive = imageFadeActive(b.fade);
        const bgFadeActive = split && imageFadeActive(b.bgFade);
        const layered  = split && (fgActive || bgActive || fgFadeActive || bgFadeActive);
        // Perspective: warp the finished box buffer onto the destination quad (WebGL). Forces the
        // buffered path so there is always a rectangular source texture to warp.
        const persp = perspectiveActive(b.perspective) ? b.perspective! : null;
        ctx.save();
        ctx.globalAlpha = (b.opacity ?? 100) / 100;
        if (b.blend) ctx.globalCompositeOperation = b.blend as GlobalCompositeOperation;
        applyShadow(ctx, b.shadow);
        if (radius > 0 || isCircle || fgFadeActive || bgFadeActive || fgActive || bgActive || persp) {
          // Composite into an offscreen buffer (device px) so the drop shadow follows the silhouette
          // and filters render cleanly. Rounded-corner clip + edge fades use scaled (box) space.
          const buf = imageBoxBufRef.current ?? (imageBoxBufRef.current = document.createElement('canvas'));
          // A cover-crop circle buffers a SQUARE (the disc) drawn from a square source, so it never distorts;
          // everything else (rect, legacy edge-crop circle) buffers the full box.
          const w = Math.max(1, Math.round((useCover ? circleDia : b.width)  * sc));
          const h = Math.max(1, Math.round((useCover ? circleDia : b.height) * sc));
          const fadeW = useCover ? circleDia : b.width, fadeH = useCover ? circleDia : b.height;
          buf.width = w; buf.height = h;   // assigning size also clears the buffer
          const bctx = buf.getContext('2d');
          if (bctx) {
            bctx.save();
            if (isCircle) { bctx.beginPath(); bctx.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, Math.PI * 2); bctx.clip(); }
            else if (radius > 0) { roundRectPath(bctx, 0, 0, w, h, radius * sc); bctx.clip(); }
            if (layered) {
              // Background = full image + bg effects, then the background edge fade.
              paintLayer(bctx, img, b.bgEffects, hashStr(b.id), w, h, sc, sx, sy, sw, sh, !b.bgEffects?.blurEdgeFade);
              if (bgFadeActive) { bctx.save(); bctx.scale(sc, sc); paintImageBoxFades(bctx, b.bgFade!, fadeW, fadeH); bctx.restore(); }
              // Foreground = subject cut-out + fg effects, then the foreground edge fade, composited on top.
              const fbuf = imageBoxFgBufRef.current ?? (imageBoxFgBufRef.current = document.createElement('canvas'));
              fbuf.width = w; fbuf.height = h;
              const fctx = fbuf.getContext('2d');
              if (fctx) {
                paintLayer(fctx, fgImg!, b.fgEffects, hashStr(b.id) ^ 0x9e3779b9, w, h, sc, sx, sy, sw, sh, false);
                if (fgFadeActive) { fctx.save(); fctx.scale(sc, sc); paintImageBoxFades(fctx, b.fade!, fadeW, fadeH); fctx.restore(); }
                bctx.save(); bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.drawImage(fbuf, 0, 0); bctx.restore();
              }
            } else {
              // Not separated: the foreground effects + edge fade apply to the whole image.
              paintLayer(bctx, img, b.fgEffects, hashStr(b.id), w, h, sc, sx, sy, sw, sh, !b.fgEffects?.blurEdgeFade);
              if (fgFadeActive) { bctx.save(); bctx.scale(sc, sc); paintImageBoxFades(bctx, b.fade!, fadeW, fadeH); bctx.restore(); }
            }
            bctx.restore();
            if (persp) {
              // Destination quad corners (canvas px) = box rect corners + per-corner offsets.
              const cr = [
                { x: b.x + persp.tl.x,           y: b.y + persp.tl.y },
                { x: b.x + b.width + persp.tr.x, y: b.y + persp.tr.y },
                { x: b.x + b.width + persp.br.x, y: b.y + b.height + persp.br.y },
                { x: b.x + persp.bl.x,           y: b.y + b.height + persp.bl.y },
              ];
              const minX = Math.min(cr[0].x, cr[1].x, cr[2].x, cr[3].x);
              const minY = Math.min(cr[0].y, cr[1].y, cr[2].y, cr[3].y);
              const qw = Math.max(1, Math.max(cr[0].x, cr[1].x, cr[2].x, cr[3].x) - minX);
              const qh = Math.max(1, Math.max(cr[0].y, cr[1].y, cr[2].y, cr[3].y) - minY);
              // Corners relative to the bounding box, in device px (the GL output space).
              const gc = cr.map(p => ({ x: (p.x - minX) * sc, y: (p.y - minY) * sc })) as [WarpPt, WarpPt, WarpPt, WarpPt];
              const warped = warpImageToQuad(buf, gc, qw * sc, qh * sc);
              if (warped) ctx.drawImage(warped, minX, minY, qw, qh);
              else ctx.drawImage(buf, b.x, b.y, b.width, b.height);   // WebGL unavailable / degenerate quad
            } else if (useCover) {
              ctx.drawImage(buf, circleX, circleY, circleDia, circleDia);   // square disc buffer → centred square
            } else {
              ctx.drawImage(buf, b.x, b.y, b.width, b.height);
            }
          }
        } else {
          ctx.drawImage(img, sx, sy, sw, sh, b.x, b.y, b.width, b.height);
        }
        ctx.restore();
      };

      const drawTextBox = (tbIn: TextBoxStyle) => {
        if (!tbIn) return;
        // Data fill for display: draw mapped {tokens} as their values; drop the box's rich spans when a
        // fill changed the text (their offsets no longer match). The stored box keeps the raw tokens.
        const tbFilledText = substDisplay(tbIn.text ?? '');
        const tb: TextBoxStyle = tbFilledText !== (tbIn.text ?? '') ? { ...tbIn, text: tbFilledText, spans: undefined } : tbIn;
        // Placeholder "highlight": alternate primary/secondary weight per word, computed live from the
        // current weights. Otherwise use the box's own per-run spans (manual styling).
        const placeholderAlt = !!tb.fillPlaceholder && tb.secondaryWeight != null && tb.secondaryWeight !== tb.fontWeight && !!tb.text;
        // Manual spans win; else tint {placeholders} gray (null when the box has no token → plain draw).
        const renderSpans = placeholderAlt ? alternateWeightSpans(tb.text, tb.fontWeight, tb.secondaryWeight!) : (tb.spans ?? placeholderSpans(tb.text) ?? undefined);
        const hasSpans = !!(renderSpans && renderSpans.length > 0);
        if (!hasSpans && !tb.text) return;
        const tbFont  = resolveCarouselFont(tb.fontLabel);
        const tbW     = tb.width  ?? 540;
        const tbH     = tb.height ?? 200;
        const tbVA    = tb.vAlign ?? 'top';
        const tbLineH = tb.fontSize * (1.0 + ((tb.lineHeight ?? 15) / 100) * 1.2);
        ctx.save();
        ctx.globalAlpha  = (tb.opacity ?? 100) / 100;
        applyShadow(ctx, tb.shadow);
        ctx.textBaseline = 'top';
        ctx.font         = `${tb.italic ? 'italic ' : ''}${tb.fontWeight} ${tb.fontSize}px ${tbFont.css}`;
        setLS(tb.letterSpacing ?? 0);

        if (tb.fitToWidth) {
          // Poster mode: auto-break + scale each line's font size to fill the box width.
          const fitSpans: TextSpan[] = hasSpans
            ? (tb.allCaps ? renderSpans!.map(s => ({ ...s, text: s.text.toUpperCase() })) : renderSpans!)
            : [{ text: tb.allCaps ? (tb.text ?? '').toUpperCase() : (tb.text ?? '') }];
          const factor = 1.0 + ((tb.lineHeight ?? 15) / 100) * 1.2;
          const { lines, totalHeight } = layoutFitToWidth(ctx, fitSpans, tbW, tbH, factor, tbFont.css, tb.fontWeight, tb.italic);
          const canvasW = 2 * tb.x + tbW;
          let y = tb.y + (tbVA === 'middle' ? (tbH - totalHeight) / 2 : tbVA === 'bottom' ? (tbH - totalHeight) : 0);
          for (const ln of lines) {
            drawSpanLine(ctx, ln.segs, y, 'left', tb.x, tbW, canvasW, tbFont.css, ln.size, tb.fontWeight, tb.italic, tb.color ?? '#ffffff', 0, sc);
            y += ln.height;
          }
          clearShadow(ctx);
          ctx.restore();
          return;
        }

        if (hasSpans) {
          // Rich per-run styling: wrap (approximated with the base font), then draw each line's segments.
          const eSpans = tb.allCaps ? renderSpans!.map(sp => ({ ...sp, text: sp.text.toUpperCase() })) : renderSpans!;
          const plain = eSpans.map(sp => sp.text).join('');
          const wrapped: { line: string; offset: number; last: boolean }[] = [];
          let g = 0;
          for (const para of plain.split('\n')) {
            if (para === '') { wrapped.push({ line: '', offset: g, last: true }); g += 1; continue; }
            const wls = wrapSpanLines(ctx, eSpans, para, g, tbW, tbFont.css, tb.fontSize, tb.fontWeight, tb.italic);
            wls.forEach((wl, k) => wrapped.push({ line: wl.line, offset: g + wl.offset, last: k === wls.length - 1 }));
            g += para.length + 1;
          }
          const textH  = wrapped.length * tbLineH;
          setTextBoxHeights(prev => prev[tb.id] === textH ? prev : { ...prev, [tb.id]: textH });
          const canvasW = 2 * tb.x + tbW;   // makes drawSpanLine's centre/right alignment box-relative
          // Auto-height: the box hugs the text, so it always draws from the top (vAlign is moot).
          let y = tb.y;
          for (const { line, offset, last } of wrapped) {
            // justify: stretch every line except the final (short) one, which is centred
            const lineAlign = tb.align === 'justify' && last ? 'center' : tb.align;
            drawSpanLine(ctx, getLineSpanSegs(eSpans, offset, line), y, lineAlign, tb.x, tbW, canvasW, tbFont.css, tb.fontSize, tb.fontWeight, tb.italic, tb.color ?? '#ffffff', tb.letterSpacing ?? 0, sc, tb.align === 'justify' && !last);
            y += tbLineH;
          }
        } else {
          ctx.fillStyle = tb.color ?? '#ffffff';
          const tbText = tb.allCaps ? tb.text.toUpperCase() : tb.text;
          const tbLines: { line: string; last: boolean }[] = [];
          for (const para of tbText.split('\n')) {
            if (para === '') { tbLines.push({ line: '', last: true }); continue; }
            const wls = wrapText(ctx, para, tbW);
            wls.forEach((wl, k) => tbLines.push({ line: wl, last: k === wls.length - 1 }));
          }
          const tbTextH   = tbLines.length * tbLineH;
          setTextBoxHeights(prev => prev[tb.id] === tbTextH ? prev : { ...prev, [tb.id]: tbTextH });
          const isJustify = tb.align === 'justify';
          const tbAX      = tb.align === 'center' ? tb.x + tbW / 2 : tb.align === 'right' ? tb.x + tbW : tb.x;
          // Auto-height: the box hugs the text, so it always draws from the top (vAlign is moot).
          let   tbY       = tb.y;
          const spc = ctx as CanvasRenderingContext2D & { wordSpacing?: string };
          spc.wordSpacing = '0px';
          for (const { line, last } of tbLines) {
            if (isJustify && !last) {
              // stretch: widen word gaps so the line fills the box width
              ctx.textAlign = 'left';
              const natural = ctx.measureText(line).width;
              const gaps = (line.match(/ /g) || []).length;
              spc.wordSpacing = gaps > 0 && tbW > natural ? `${((tbW - natural) / gaps).toFixed(2)}px` : '0px';
              ctx.fillText(line, tb.x, tbY);
              spc.wordSpacing = '0px';
            } else if (isJustify) {
              // justify's final (short) line is centred
              ctx.textAlign = 'center';
              ctx.fillText(line, tb.x + tbW / 2, tbY);
            } else {
              ctx.textAlign = tb.align === 'center' ? 'center' : tb.align === 'right' ? 'right' : 'left';
              ctx.fillText(line, tbAX, tbY);
            }
            tbY += tbLineH;
          }
        }
        clearShadow(ctx);
        ctx.restore();
      };

      const editingTbId = editingTextBoxRef.current != null ? txtBoxes[editingTextBoxRef.current]?.id : null;
      // Draw a single zone/grid logo at its (fixed) grid position — invoked from the z-order loop so
      // a zone logo stacks like any other layer. Position math mirrors the skeleton zone layout.
      const drawZoneLogo = (fi: number) => {
        const row = Math.floor(fi / 3), zi = fi % 3;
        if (row <= 2 && !showSlot[row]) return;
        if (s.dividerSlots?.[row]) return;
        if (!s.zoneLogoSlots?.[fi] || s.zoneLogoStyles?.[fi]?.hidden) return;
        const zImg = zoneLogoImgsRef.current[fi];
        if (!zImg) return;
        const zoneW = (W - 2 * padX) / 3;
        const zoneX = padX + zi * zoneW;
        const lha = zi === 0 ? 'left' as const : zi === 2 ? 'right' as const : 'center' as const;
        const lva = row === 0 ? 'top' as const : row === 2 ? 'bottom' as const : 'center' as const;
        const zStyle = s.zoneLogoStyles?.[fi];
        ctx.save();
        ctx.globalAlpha = (zStyle?.opacity ?? s.logoOpacity ?? 100) / 100;
        applyShadow(ctx, zStyle?.shadow ?? s.logoShadow);
        drawLogoFit(ctx, zImg, zoneX, logoCYs[row], zoneW, LOGO_CH, lha, lva, zStyle?.scale ?? s.logoScale ?? 100, zStyle?.cornerRadius ?? s.logoCornerRadius ?? 0, (zStyle?.shape ?? s.logoShape) === 'circle');
        clearShadow(ctx);
        ctx.restore();
      };
      // The 3 row-aligned brand logos — painted from the z-order loop (kind 'skeletonlogos') as one band
      // that defaults BEHIND the hoisted tag/quote/swipe layers (their historical back-most position).
      const paintRowLogos = () => {
        const slotFW = W - 2 * padX;
        const logoAlpha = (s.logoOpacity ?? 100) / 100;
        logoImgsRef.current.forEach((logoImg, li) => {
          if (!logoImg || li > 2) return;
          if (li <= 2 && !showSlot[li]) return;
          ctx.save();
          ctx.globalAlpha = logoAlpha;
          const lha = (s.logoSlotAligns?.[li] ?? 'center') as 'left' | 'center' | 'right';
          const lva = li === 0 ? 'top' as const : 'bottom' as const;
          applyShadow(ctx, s.logoShadow);
          drawLogoFit(ctx, logoImg, padX, logoCYs[li], slotFW, LOGO_CH, lha, lva, s.logoScale ?? 100, s.logoCornerRadius ?? 0, s.logoShape === 'circle');
          clearShadow(ctx);
          ctx.restore();
        });
      };
      // Skeleton tag/quote/swipe slots — hoisted out of paintSkeletonOverlays so each paints from the
      // z-order loop and stacks + hides like every other layer. Geometry mirrors the skeleton zone layout.
      const drawRowTag = (li: number) => {
        const tagSlot = s.tagSlots?.[li];
        if (!tagSlot || li > 2) return;
        if (li <= 2 && !showSlot[li]) return;
        if (s.tagSlotsHidden?.[li]) return;
        const slotFW = W - 2 * padX;
        const ts = tagSlot.style;
        const tagFontDef = resolveCarouselFont(ts.fontLabel);
        const ha = (s.tagSlotAligns?.[li] ?? 'center') as 'left' | 'center' | 'right';
        const va = li === 0 ? 'top' as const : 'bottom' as const;
        const tagSlotLift = ts.shadow?.lift ?? 0;
        applyShadow(ctx, ts.shadow);
        drawTag(ctx, tagSlot.text, padX, logoCYs[li] - tagSlotLift, slotFW, LOGO_CH, ha, va, ts, tagFontDef.css, 1 / DISPLAY_SCALE);
        clearShadow(ctx);
      };
      // Draw a paired/single quote mark for a quote style at (x,y,w,h) with the given anchors.
      const paintQuoteMark = (styleId: string, x: number, y: number, w: number, h: number, ha: 'left' | 'center' | 'right', va: 'top' | 'center' | 'bottom') => {
        const qs = ALL_QUOTE_STYLES.find(q => q.id === styleId);
        if (!qs) return;
        const qColor   = s.quoteColor   ?? '#ffffff';
        const qSize    = s.quoteSize    ?? 120;
        const qAlpha   = (s.quoteOpacity ?? 100) / 100;
        const [vbX, vbY, vbW, vbH] = qs.viewBox;
        const scale    = Math.min(qSize / vbW, qSize / vbH);
        const drawW    = vbW * scale;
        const drawH    = vbH * scale;
        const quoteGap = qs.paired ? (s.quoteGap ?? 8) : 0;
        const totalW   = qs.paired ? drawW * 2 + quoteGap : drawW;
        const quoteLift = s.quoteShadow?.lift ?? 0;
        const qx = ha === 'left' ? x : ha === 'right' ? x + w - totalW : x + (w - totalW) / 2;
        const qy = (va === 'top' ? y : va === 'bottom' ? y + h - drawH : y + (h - drawH) / 2) - quoteLift;
        ctx.save();
        ctx.globalAlpha = qAlpha;
        ctx.fillStyle   = qColor;
        applyShadow(ctx, s.quoteShadow);
        ctx.translate(qx - vbX * scale, qy - vbY * scale);
        ctx.scale(scale, scale);
        if (qs.pathOffset) ctx.translate(qs.pathOffset.x, qs.pathOffset.y);
        for (const pathD of qs.paths) ctx.fill(new Path2D(pathD));
        clearShadow(ctx);
        ctx.restore();
        if (qs.paired) {
          const cx = qx + drawW + quoteGap;
          ctx.save();
          ctx.globalAlpha = qAlpha;
          ctx.fillStyle   = qColor;
          applyShadow(ctx, s.quoteShadow);
          ctx.translate(cx + drawW / 2, qy + drawH / 2);
          ctx.rotate(Math.PI);
          ctx.translate(-drawW / 2, -drawH / 2);
          ctx.translate(-vbX * scale, -vbY * scale);
          ctx.scale(scale, scale);
          if (qs.pathOffset) ctx.translate(qs.pathOffset.x, qs.pathOffset.y);
          for (const pathD of qs.paths) ctx.fill(new Path2D(pathD));
          clearShadow(ctx);
          ctx.restore();
        }
      };
      const drawRowQuote = (li: number) => {
        const styleId = s.quoteSlots?.[li];
        if (!styleId || li > 2) return;
        if (li <= 2 && !showSlot[li]) return;
        if (s.quoteSlotsHidden?.[li]) return;
        // Row quotes draw centred across the full slot width, vertically centred in the slot band.
        paintQuoteMark(styleId, padX, logoCYs[li], W - 2 * padX, LOGO_CH, 'center', 'center');
      };
      // Common gate + geometry for a 3×3 zone slot (fi = row*3 + zone). Returns null when the slot's
      // row is hidden / occupied by a divider (matching the old zone-loop guards).
      const zoneGeom = (fi: number) => {
        const row = Math.floor(fi / 3), zi = fi % 3;
        if (row > 2) return null;   // 3×3 grid only — guards against any over-length slot array (NaN positions)
        if (!showSlot[row]) return null;
        if (s.dividerSlots?.[row]) return null;
        const zoneW = (W - 2 * padX) / 3;
        const zoneX = padX + zi * zoneW;
        const lha = zi === 0 ? 'left' as const : zi === 2 ? 'right' as const : 'center' as const;
        const lva = row === 0 ? 'top' as const : row === 2 ? 'bottom' as const : 'center' as const;
        return { row, zi, zoneW, zoneX, lha, lva };
      };
      const drawZoneTag = (fi: number) => {
        const zt = s.tagZoneSlots?.[fi];
        if (!zt || s.tagZoneHidden?.[fi]) return;
        const g = zoneGeom(fi);
        if (!g) return;
        const tfd = resolveCarouselFont(zt.style.fontLabel);
        const tzLift = zt.style.shadow?.lift ?? 0;
        applyShadow(ctx, zt.style.shadow);
        drawTag(ctx, zt.text, g.zoneX, logoCYs[g.row] - tzLift, g.zoneW, LOGO_CH, g.lha, g.lva, zt.style, tfd.css, 1 / DISPLAY_SCALE);
        clearShadow(ctx);
      };
      const drawZoneQuote = (fi: number) => {
        const zq = s.quoteZoneSlots?.[fi];
        if (!zq || s.quoteZoneHidden?.[fi]) return;
        const g = zoneGeom(fi);
        if (!g) return;
        paintQuoteMark(zq, g.zoneX, logoCYs[g.row], g.zoneW, LOGO_CH, g.lha, g.lva);
      };
      const drawZoneSwipe = (fi: number) => {
        const zsw = s.swipeZoneSlots?.[fi];
        if (!zsw || s.swipeZoneHidden?.[fi]) return;
        const g = zoneGeom(fi);
        if (!g) return;
        const sfd = resolveCarouselFont(zsw.fontLabel);
        const zswLift = zsw.shadow?.lift ?? 0;
        applyShadow(ctx, zsw.shadow);
        drawSwipeOnCanvas(ctx, g.zoneX, logoCYs[g.row] - zswLift, g.zoneW, LOGO_CH, g.lha, g.lva, zsw, sfd.css);
        clearShadow(ctx);
      };
      // Each layer paints at its position in `layers`. The skeleton's parts — boxed overlays, the
      // headline line and the sub line — are now independent, so anything can sit between them.
      for (const { kind, id } of layers) {
        if (kind === 'fade')          { if (fadeShown && !fadeAtBottom) drawFade(); }
        else if (kind === 'skeleton') { paintSkeletonOverlays(); }
        else if (kind === 'skeletonlogos') { paintRowLogos(); }
        else if (kind === 'headline') { paintHeadlineText(); }
        else if (kind === 'sub')      { paintSubText(); }
        else if (kind === 'image')    { const b  = imgBoxes.find(x => x.id === id); if (b  && !b.hidden)  drawImageBox(b); }
        else if (kind === 'free')     { const fe = freeEls.find(x => x.id === id);  if (fe && !fe.hidden) drawFreeElement(fe); }
        else if (kind === 'zonelogo') { drawZoneLogo(Number(id.slice(9))); }
        else if (kind === 'rowtag')    { drawRowTag(Number(id.slice(7))); }
        else if (kind === 'rowquote')  { drawRowQuote(Number(id.slice(9))); }
        else if (kind === 'zonetag')   { drawZoneTag(Number(id.slice(8))); }
        else if (kind === 'zonequote') { drawZoneQuote(Number(id.slice(10))); }
        else if (kind === 'zoneswipe') { drawZoneSwipe(Number(id.slice(10))); }
        else                          { const tb = txtBoxes.find(x => x.id === id); if (tb && !tb.hidden && tb.id !== editingTbId) drawTextBox(tb); }
      }
      setLS(0);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const settingsRef = useRef(settings);
    useEffect(() => { settingsRef.current = settings; });
    useEffect(() => { slotsRef.current = slots; });
    const onBgLayerStateChangeRef = useRef(onBgLayerStateChange);
    useEffect(() => { onBgLayerStateChangeRef.current = onBgLayerStateChange; });
    useEffect(() => {
      onBgLayerStateChangeRef.current?.({ fgMaskReady: !!fgMaskSrc, isBgProcessing, bgProcessError });
    }, [fgMaskSrc, isBgProcessing, bgProcessError]);

    // Surface the selected image box upward so the settings panel can edit it
    const onSelectedImageBoxChangeRef = useRef(onSelectedImageBoxChange);
    useEffect(() => { onSelectedImageBoxChangeRef.current = onSelectedImageBoxChange; });
    // Surface inline text-edit state (which box + whether a run is selected) for the settings panel's rich-text controls
    const onTextEditStateChangeRef = useRef(onTextEditStateChange);
    useEffect(() => { onTextEditStateChangeRef.current = onTextEditStateChange; });
    useEffect(() => { onSelectedImageBoxChangeRef.current?.(selectedImageBox); }, [selectedImageBox]);
    // Surface the selected free element (e.g. a logo) so the settings panel can show its per-element controls.
    const onSelectedFreeElChangeRef = useRef(onSelectedFreeElChange);
    useEffect(() => { onSelectedFreeElChangeRef.current = onSelectedFreeElChange; });
    useEffect(() => { onSelectedFreeElChangeRef.current?.(selectedFreeEl); }, [selectedFreeEl]);
    // Surface the plain text-box selection (single-click outline) so its panel island opens with it.
    const onSelectedTextBoxChangeRef = useRef(onSelectedTextBoxChange);
    useEffect(() => { onSelectedTextBoxChangeRef.current = onSelectedTextBoxChange; });
    useEffect(() => { onSelectedTextBoxChangeRef.current?.(selectedTextBox); }, [selectedTextBox]);
    // Surface measured text-box auto-heights to the settings panel (read-only Height field).
    const onTextBoxHeightsChangeRef = useRef(onTextBoxHeightsChange);
    useEffect(() => { onTextBoxHeightsChangeRef.current = onTextBoxHeightsChange; });
    useEffect(() => { onTextBoxHeightsChangeRef.current?.(textBoxHeights); }, [textBoxHeights]);
    const onSelectedZoneSlotChangeRef = useRef(onSelectedZoneSlotChange);
    useEffect(() => { onSelectedZoneSlotChangeRef.current = onSelectedZoneSlotChange; });
    useEffect(() => { onSelectedZoneSlotChangeRef.current?.(selectedZoneSlot); }, [selectedZoneSlot]);
    const onRichEditTargetChangeRef = useRef(onRichEditTargetChange);
    useEffect(() => { onRichEditTargetChangeRef.current = onRichEditTargetChange; });
    useEffect(() => { onRichEditTargetChangeRef.current?.(richEditTarget); }, [richEditTarget]);
    // Drop the zone-slot selection if its slot becomes empty.
    useEffect(() => {
      if (!selectedZoneSlot) return;
      const { kind, index } = selectedZoneSlot;
      const arr = kind === 'logo' ? settings.zoneLogoSlots : kind === 'tag' ? settings.tagZoneSlots : kind === 'quote' ? settings.quoteZoneSlots : settings.swipeZoneSlots;
      if (!(arr ?? [])[index]) setSelectedZoneSlot(null);
    }, [settings.zoneLogoSlots, settings.tagZoneSlots, settings.quoteZoneSlots, settings.swipeZoneSlots, selectedZoneSlot]);
    // Selecting any other element (image/text/free box or the headline/sub edit) clears the
    // zone-slot selection, so only one thing is ever selected at a time.
    useEffect(() => {
      if (selectedImageBox !== null || selectedTextBox !== null || selectedFreeEl !== null || richEditTarget !== null) setSelectedZoneSlot(null);
    }, [selectedImageBox, selectedTextBox, selectedFreeEl, richEditTarget]);
    // Mirror the aspect-lock into a ref so the resize mousemove handler reads the latest value
    const lockImageAspectRef = useRef(lockImageAspect);
    useEffect(() => { lockImageAspectRef.current = lockImageAspect; });
    // Clear selection if the selected box disappears (e.g. removed from the settings panel)
    useEffect(() => {
      if (selectedImageBox !== null && !(settings.imageBoxes ?? [])[selectedImageBox]) setSelectedImageBox(null);
    }, [settings.imageBoxes, selectedImageBox]);

    const redraw = useCallback((img: HTMLImageElement | null) => {
      drawCanvas(img, imgOffsetRef.current.x, imgOffsetRef.current.y, imgScaleRef.current, settingsRef.current);
    }, [drawCanvas]);

    // Circular photo slots (divider sub-content) — write a new reframe crop for slot `i` and repaint.
    const commitSubCrop = useCallback((i: number, crop: SlotCrop) => {
      const curSub = [...(settingsRef.current.dividerSubSlots ?? Array(3).fill(null))] as (DividerSubSlotContent | null)[];
      const existing = curSub[i];
      if (!existing || existing.type !== 'image') return;
      curSub[i] = { ...existing, crop };
      settingsRef.current = { ...settingsRef.current, dividerSubSlots: curSub };
      onSettingsChange?.({ dividerSubSlots: curSub });
      redraw(cachedImgRef.current);
    }, [onSettingsChange, redraw]);

    // Begin a drag-to-reframe on a circular photo slot. Reads the image's natural size + current zoom
    // so pointer motion pans the source 1:1 with the cursor; a plain click (no movement) still opens
    // the slot picker. No-op unless slots are circular and this slot holds a photo.
    const startSubCropDrag = useCallback((i: number, e: React.MouseEvent) => {
      if (settingsRef.current.imageShape !== 'circle') return;
      const sc = settingsRef.current.dividerSubSlots?.[i];
      if (sc?.type !== 'image') return;
      const img = subImgRefsArr.current[i];
      if (!img || !img.naturalWidth) return;
      e.preventDefault();
      e.stopPropagation();   // don't let the wrapper start a canvas pan while we reframe
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const dScreen = Math.max(1, Math.min(rect.width, rect.height));   // circle diameter on screen
      const zoom = Math.max(1, sc.crop?.zoom ?? 1);
      const ss = Math.min(img.naturalWidth, img.naturalHeight) / zoom;  // sampled square (source px)
      const slackX = img.naturalWidth - ss, slackY = img.naturalHeight - ss;
      const startX = sc.crop?.x ?? 0, startY = sc.crop?.y ?? 0;
      const mx = e.clientX, my = e.clientY;
      let moved = false;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - mx, dy = ev.clientY - my;
        if (!moved && Math.hypot(dx, dy) < 3) return;   // click vs drag threshold
        moved = true;
        // Drag the photo with the cursor: cursor right → reveal the left of the source (crop moves −x).
        const nx = slackX > 0 ? Math.max(-1, Math.min(1, startX - (2 * dx * ss) / (slackX * dScreen))) : 0;
        const ny = slackY > 0 ? Math.max(-1, Math.min(1, startY - (2 * dy * ss) / (slackY * dScreen))) : 0;
        commitSubCrop(i, { x: nx, y: ny, zoom });
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (moved) suppressSubClickRef.current = true;   // swallow the click that follows a drag
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }, [commitSubCrop]);

    // Wheel-to-zoom on circular photo slots. Native listener (passive:false) so we can preventDefault +
    // stopPropagation, matching the sub-slot drag reframe.
    useEffect(() => {
      const cleanups: (() => void)[] = [];
      subSlotBtnRefs.current.forEach((el, i) => {
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
          if (settingsRef.current.imageShape !== 'circle') return;
          const cur = settingsRef.current.dividerSubSlots?.[i];
          if (cur?.type !== 'image') return;
          e.preventDefault(); e.stopPropagation();
          const z = Math.max(1, Math.min(5, (cur.crop?.zoom ?? 1) * (1 + (-e.deltaY) * 0.0015)));
          commitSubCrop(i, { ...(cur.crop ?? {}), zoom: z });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        cleanups.push(() => el.removeEventListener('wheel', onWheel));
      });
      return () => cleanups.forEach(c => c());
    }, [settings.imageShape, settings.dividerSubSlots, settings.dividerSlots, commitSubCrop]);

    // ── Circular image-box reframe (drag to pan + scroll to zoom inside the disc) ──
    const commitCircleCrop = useCallback((i: number, cc: SlotCrop) => {
      const cur = [...(settingsRef.current.imageBoxes ?? [])];
      if (!cur[i]) return;
      cur[i] = { ...cur[i], circleCrop: cc };
      settingsRef.current = { ...settingsRef.current, imageBoxes: cur };
      onSettingsChange?.({ imageBoxes: cur });
      redraw(cachedImgRef.current);
    }, [onSettingsChange, redraw]);

    // Begin a reframe pan on a circular image box (only when that box is in reframe mode). Captures the
    // cover-crop geometry so pointer motion pans the photo 1:1 with the cursor.
    const startImageBoxReframe = useCallback((i: number, e: React.MouseEvent) => {
      const b = settingsRef.current.imageBoxes?.[i];
      if (!b || b.shape !== 'circle') return;
      let natW = 0, natH = 0;
      if (b.videoUrl) { const v = videoBoxElsRef.current.get(b.videoUrl); natW = v?.videoWidth ?? 0; natH = v?.videoHeight ?? 0; }
      else { const im = imageBoxImgsRef.current.get(b.url); natW = im?.naturalWidth ?? 0; natH = im?.naturalHeight ?? 0; }
      if (!natW || !natH) return;
      e.preventDefault(); e.stopPropagation();
      const cc = b.circleCrop;
      const zoom = Math.max(1, cc?.zoom ?? 1);
      const ss = Math.max(1, Math.min(natW, natH) / zoom);          // square sample (matches the draw)
      const dScreen = Math.min(b.width, b.height) * DISPLAY_SCALE;  // disc diameter on screen
      imageBoxReframeStart.current = {
        mx: e.clientX, my: e.clientY,
        startX: cc?.x ?? 0, startY: cc?.y ?? 0,
        sw: ss, sh: ss, slackX: natW - ss, slackY: natH - ss,
        bwPx: dScreen, bhPx: dScreen,
      };
      const onMove = (ev: MouseEvent) => {
        const s0 = imageBoxReframeStart.current;
        const dx = ev.clientX - s0.mx, dy = ev.clientY - s0.my;
        // screen px per source px = boxPx / sampledSrc; 1:1 drag ⇒ Δpan = −2·d / (scale·slack).
        const nx = s0.slackX > 0 ? Math.max(-1, Math.min(1, s0.startX - (2 * dx * s0.sw) / (s0.bwPx * s0.slackX))) : 0;
        const ny = s0.slackY > 0 ? Math.max(-1, Math.min(1, s0.startY - (2 * dy * s0.sh) / (s0.bhPx * s0.slackY))) : 0;
        // Preserve any zoom applied mid-drag (wheel) rather than snapping back to the drag-start value.
        const curZoom = settingsRef.current.imageBoxes?.[i]?.circleCrop?.zoom ?? zoom;
        commitCircleCrop(i, { x: nx, y: ny, zoom: curZoom });
      };
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }, [commitCircleCrop]);

    // Leave reframe when the box is deselected or a different one is selected.
    useEffect(() => {
      if (reframeImageBox !== null && selectedImageBox !== reframeImageBox) setReframeImageBox(null);
    }, [selectedImageBox, reframeImageBox]);

    // reframeImageBox is a bare array index; a length change (delete / add / undo / redo of either) can
    // shift it onto a different box. Exit reframe on any such restructure so drag/scroll never edits the
    // wrong box. Crop edits keep the length, so an active reframe survives them.
    const imageBoxCount = (settings.imageBoxes ?? []).length;
    useEffect(() => {
      setReframeImageBox(null);
    }, [imageBoxCount]);

    // Escape exits reframe.
    useEffect(() => {
      if (reframeImageBox === null) return;
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setReframeImageBox(null); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [reframeImageBox]);

    // Scroll-to-zoom on the box being reframed. Native listener (passive:false) so we can preventDefault.
    useEffect(() => {
      const i = reframeImageBox;
      if (i === null) return;
      const el = imageBoxDivRefs.current[i];
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        const b = settingsRef.current.imageBoxes?.[i];
        if (!b || b.shape !== 'circle') return;
        e.preventDefault(); e.stopPropagation();
        const z = Math.max(1, Math.min(5, (b.circleCrop?.zoom ?? 1) * (1 + (-e.deltaY) * 0.0015)));
        commitCircleCrop(i, { ...(b.circleCrop ?? {}), zoom: z });
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    }, [reframeImageBox, commitCircleCrop]);

    // Sync element-drag / invertedSlots into refs so drawCanvas can access the latest
    // value. Only ELEMENT drags reserve slot-row space in the layout — text drags
    // don't show the rows, so they must not shove the text block around.
    useEffect(() => {
      isDraggingElementRef.current = elementDrag;
      redraw(cachedImgRef.current);
    }, [elementDrag, redraw]);
    useEffect(() => {
      textDragRef.current = textDrag;
      redraw(cachedImgRef.current);
    }, [textDrag, redraw]);
    useEffect(() => {
      invertedSlotsRef.current = invertedSlots;
      redraw(cachedImgRef.current);
    }, [invertedSlots, redraw]);

    // Text-only redraw — stable drawCanvas means this won't cascade into image-reset effects
    useEffect(() => {
      redraw(cachedImgRef.current);
    }, [headline, subheadline]); // eslint-disable-line react-hooks/exhaustive-deps

    // Rich text edit mode — sync ref, redraw (hides canvas text), then init contentEditable
    useEffect(() => {
      richEditTargetRef.current = richEditTarget;
      redraw(cachedImgRef.current);
      if (!richEditTarget || !richEditRef.current) return;
      const s = settingsRef.current;
      const isHead = richEditTarget === 'headline';
      const spans = isHead ? s.headlineSpans : s.subSpans;
      const plainText = isHead
        ? (s.allCaps ? headlineRef.current.toUpperCase() : headlineRef.current)
        : (s.subAllCaps ? subheadlineRef.current.toUpperCase() : subheadlineRef.current);
      richEditRef.current.innerHTML = (spans && spans.length > 0)
        ? spansToHtml(spans)
        : plainText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      highlightPlaceholders(richEditRef.current);   // gray any {tokens} immediately on entering edit mode
      richEditRef.current.focus();
      const range = document.createRange();
      range.selectNodeContents(richEditRef.current);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }, [richEditTarget, redraw]);  

    // Track text selection inside contentEditable to show floating toolbar
    useEffect(() => {
      if (!richEditTarget) { setToolbarPos(null); return; }
      function onSelChange() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !richEditRef.current?.contains(sel.anchorNode)) {
          setToolbarPos(null); return;
        }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        // Viewport coords so the fixed toolbar floats above everything (not clipped by the canvas).
        setToolbarPos({
          top:  rect.top - 44,
          left: rect.left,
        });
      }
      document.addEventListener('selectionchange', onSelChange);
      return () => document.removeEventListener('selectionchange', onSelChange);
    }, [richEditTarget]);

    // Commit a free text box change (used by inline editing + drag/resize handlers)
    const updateTextBox = useCallback((idx: number, patch: Partial<TextBoxStyle>) => {
      const cur = [...(settingsRef.current.textBoxes ?? [])];
      if (!cur[idx]) return;
      cur[idx] = { ...cur[idx], ...patch };
      settingsRef.current = { ...settingsRef.current, textBoxes: cur };
      onSettingsChange?.({ textBoxes: cur });
      redraw(cachedImgRef.current);
    }, [onSettingsChange, redraw]);

    // Save the editor's current rich content as spans (+ plain text fallback) onto the text box.
    const commitTextSpans = useCallback((spans: TextSpan[]) => {
      const idx = editingTextBoxRef.current;
      if (idx == null) return;
      const text = spans.map(sp => sp.text).join('');
      const hasStyle = spans.some(sp => sp.color || sp.bold || sp.italic || sp.weight);
      // Editing claims the box: stop auto-filling so the user's content is never overwritten.
      updateTextBox(idx, { spans: hasStyle ? spans : undefined, text, fillPlaceholder: false });
    }, [updateTextBox]);
    // Italic / colour via execCommand on the inline editor's selection; then re-read the DOM into spans.
    const richTextCmd = useCallback((cmd: string, val?: string) => {
      const el = editTextRef.current;
      if (editingTextBoxRef.current == null || !el) return;
      document.execCommand(cmd, false, val);
      commitTextSpans(htmlToSpans(el));
    }, [commitTextSpans]);
    // Apply a font weight to the current selection (no execCommand for arbitrary weight) — wrap the
    // range in a weight span, stripping any inner weight so the new one wins.
    const applyTextWeight = useCallback((weight: number) => {
      const el = editTextRef.current;
      const sel = window.getSelection();
      if (editingTextBoxRef.current == null || !el || !sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (range.collapsed || !el.contains(range.commonAncestorContainer)) return;
      const frag = range.extractContents();
      frag.querySelectorAll<HTMLElement>('[style]').forEach(n => { n.style.fontWeight = ''; });
      const span = document.createElement('span');
      span.style.fontWeight = String(weight);
      span.appendChild(frag);
      range.insertNode(span);
      const r = document.createRange();
      r.selectNodeContents(span);
      sel.removeAllRanges();
      sel.addRange(r);
      commitTextSpans(htmlToSpans(el));
    }, [commitTextSpans]);

    // Inline text-box edit mode — sync ref, redraw (hides that box's canvas text), seed the editor + focus
    useEffect(() => {
      editingTextBoxRef.current = editingTextBox;
      redraw(cachedImgRef.current);
      onTextEditStateChangeRef.current?.({ boxIndex: editingTextBox, hasSelection: false });
      if (editingTextBox == null || !editTextRef.current) return;
      const tb = (settingsRef.current.textBoxes ?? [])[editingTextBox];
      if (!tb) return;
      editTextRef.current.innerHTML = spansToHtml(tb.spans && tb.spans.length > 0 ? tb.spans : [{ text: tb.text ?? '' }]);
      highlightPlaceholders(editTextRef.current);   // gray any {tokens} immediately on entering edit mode
      editTextRef.current.focus();
      const range = document.createRange();
      range.selectNodeContents(editTextRef.current);
      range.collapse(false);   // cursor at end
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }, [editingTextBox, redraw]);

    // Report selection state (which box is being edited + whether a run is selected) so the settings
    // panel can light up its rich-text controls for that box.
    useEffect(() => {
      if (editingTextBox == null) return;
      function onSel() {
        const sel = window.getSelection();
        const has = !!sel && !sel.isCollapsed && !!editTextRef.current?.contains(sel.anchorNode) && sel.toString().trim().length > 0;
        onTextEditStateChangeRef.current?.({ boxIndex: editingTextBoxRef.current, hasSelection: has });
      }
      document.addEventListener('selectionchange', onSel);
      return () => document.removeEventListener('selectionchange', onSel);
    }, [editingTextBox]);

    // Drop inline-edit if its box disappears
    useEffect(() => {
      if (editingTextBox !== null && !(settings.textBoxes ?? [])[editingTextBox]) setEditingTextBox(null);
    }, [settings.textBoxes, editingTextBox]);

    // Clean view hides the inline editor; exit edit mode so the box renders normally on the canvas.
    useEffect(() => { if (cleanView) setEditingTextBox(null); }, [cleanView]);

    const drawCropOverlay = useCallback((r: { x: number; y: number; w: number; h: number }) => {
      const vc = cropOverlayRef.current;
      if (!vc) return;
      const ctx = vc.getContext('2d');
      if (!ctx) return;
      const PW = CAROUSEL_PREVIEW_W, PH = CAROUSEL_PREVIEW_H;
      ctx.clearRect(0, 0, PW, PH);
      // Dim the 4 strips outside the crop rect
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, PW, r.y);
      ctx.fillRect(0, r.y, r.x, r.h);
      ctx.fillRect(r.x + r.w, r.y, PW - r.x - r.w, r.h);
      ctx.fillRect(0, r.y + r.h, PW, PH - r.y - r.h);
      // Crop border
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      // Rule-of-thirds grid
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 0.5;
      for (let i = 1; i <= 2; i++) {
        const gx = r.x + r.w * i / 3, gy = r.y + r.h * i / 3;
        ctx.beginPath(); ctx.moveTo(gx, r.y); ctx.lineTo(gx, r.y + r.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(r.x, gy); ctx.lineTo(r.x + r.w, gy); ctx.stroke();
      }
    }, []);

    function handleLogoFile(idx: number, e: React.ChangeEvent<HTMLInputElement>) {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = '';
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        logoImgsRef.current[idx] = img;
        const next = [...slotsRef.current] as (SlotContent | null)[];
        next[idx] = { type: 'image', url };
        slotsRef.current = next;
        setSlots(next);
        const curTagSlots   = [...(settingsRef.current.tagSlots   ?? Array(6).fill(null))];
        const curQuoteSlots = [...(settingsRef.current.quoteSlots ?? Array(6).fill(null))];
        const hadTag   = !!curTagSlots[idx];
        const hadQuote = !!curQuoteSlots[idx];
        curTagSlots[idx]   = null;
        curQuoteSlots[idx] = null;
        if (hadTag || hadQuote) onSettingsChange?.({ tagSlots: curTagSlots, quoteSlots: curQuoteSlots });
        redraw(cachedImgRef.current);
      };
      img.src = url;
    }

    function removeSlot(idx: number) {
      const imgSlot = slotsRef.current[idx];
      if (imgSlot?.type === 'image') URL.revokeObjectURL(imgSlot.url);
      logoImgsRef.current[idx] = null;
      const next = [...slotsRef.current] as (SlotContent | null)[];
      next[idx] = null;
      slotsRef.current = next;
      setSlots(next);
      const curTagSlots   = [...(settingsRef.current.tagSlots   ?? Array(3).fill(null))];
      const curQuoteSlots = [...(settingsRef.current.quoteSlots ?? Array(3).fill(null))];
      const curLogoAligns = [...(settingsRef.current.logoSlotAligns ?? Array(3).fill('center'))] as ('left'|'center'|'right')[];
      const curLogoRow    = [...(settingsRef.current.logoRowSlots ?? Array(3).fill(null))];
      curTagSlots[idx]   = null;
      curQuoteSlots[idx] = null;
      curLogoAligns[idx] = 'center';
      curLogoRow[idx]    = null;
      settingsRef.current = { ...settingsRef.current, tagSlots: curTagSlots, quoteSlots: curQuoteSlots, logoSlotAligns: curLogoAligns, logoRowSlots: curLogoRow };
      onSettingsChange?.({ tagSlots: curTagSlots, quoteSlots: curQuoteSlots, logoSlotAligns: curLogoAligns, logoRowSlots: curLogoRow });
      redraw(cachedImgRef.current);
    }

    const [openSlot, setOpenSlot] = useState<number | null>(null);
    const [slotDropdownPos, setSlotDropdownPos] = useState<{ x: number; y: number } | null>(null);
    const slotContainerRefs = useRef<(HTMLDivElement | null)[]>(Array(3).fill(null));
    const [openSubSlot, setOpenSubSlot] = useState<number | null>(null);
    const [showSubCustom, setShowSubCustom] = useState(false);
    const subSlotBtnRefs = useRef<(HTMLButtonElement | null)[]>(Array(3).fill(null));
    // Set true when a circular-slot reframe drag just ended, so the button's onClick (open picker) is skipped.
    const suppressSubClickRef = useRef(false);
    const [subDropdownPos, setSubDropdownPos] = useState<{ x: number; y: number } | null>(null);
    const [dragOverSlot, setDragOverSlot] = useState<number | null>(null);
    const [dragOverZone, setDragOverZone] = useState<'left' | 'center' | 'right' | null>(null);
    const [isDividerDrag, setIsDividerDrag] = useState(false);
    const [subDragOverSlot, setSubDragOverSlot] = useState<number | null>(null);
    const [subSlotFilled, setSubSlotFilled] = useState<boolean[]>(() =>
      (settings.dividerSubSlots ?? Array(3).fill(null)).map((s: DividerSubSlotContent | null) => s !== null)
    );
    useEffect(() => {
      setSubSlotFilled((settings.dividerSubSlots ?? Array(3).fill(null)).map((s: DividerSubSlotContent | null) => s !== null));
    }, [settings.dividerSubSlots]);
    const pendingSlotZoneRef = useRef<'left' | 'center' | 'right'>('center');

    // Close slot dropdown when clicking outside any slot or the portal dropdown
    useEffect(() => {
      if (openSlot === null) return;
      function onDoc(e: MouseEvent) {
        if ((e.target as Element).closest('[data-carousel-slot]')) return;
        if ((e.target as Element).closest('[data-slot-dropdown]')) return;
        setOpenSlot(null);
        setSlotDropdownPos(null);
        setShowCustom(false);
      }
      document.addEventListener('mousedown', onDoc);
      return () => document.removeEventListener('mousedown', onDoc);
    }, [openSlot]);

    useEffect(() => {
      if (openSubSlot === null) return;
      function onDoc(e: MouseEvent) {
        if ((e.target as Element).closest('[data-carousel-slot]')) return;
        setOpenSubSlot(null);
        setSubDropdownPos(null);
        setShowSubCustom(false);
      }
      document.addEventListener('mousedown', onDoc);
      return () => document.removeEventListener('mousedown', onDoc);
    }, [openSubSlot]);

    // Load sub-slot images when settings change (e.g. on remount or external settings update)
    useEffect(() => {
      (settings.dividerSubSlots ?? []).forEach((sub, i) => {
        if (sub?.type === 'image' && !subImgRefsArr.current[i]) {
          const img = cachedEditorImage(sub.url);
          img.onload = () => { subImgRefsArr.current[i] = img; redraw(cachedImgRef.current); };
          if (img.complete && img.naturalWidth > 0) { subImgRefsArr.current[i] = img; redraw(cachedImgRef.current); }
        }
        if (!sub || sub.type !== 'image') subImgRefsArr.current[i] = null;
      });
    }, [settings.dividerSubSlots]); // eslint-disable-line react-hooks/exhaustive-deps

    // Restore zone logo images when settings are hydrated from DB
    useEffect(() => {
      (settings.zoneLogoSlots ?? []).forEach((logoUrl, fi) => {
        if (!logoUrl) { zoneLogoImgsRef.current[fi] = null; return; }
        const img = cachedEditorImage(logoUrl);
        img.onload = () => { zoneLogoImgsRef.current[fi] = img; redraw(cachedImgRef.current); };
        if (img.complete && img.naturalWidth > 0) { zoneLogoImgsRef.current[fi] = img; redraw(cachedImgRef.current); }
      });
    }, [settings.zoneLogoSlots]); // eslint-disable-line react-hooks/exhaustive-deps

    // Restore freeform logo element images when settings are hydrated from DB
    useEffect(() => {
      (settings.freeElements ?? []).forEach(el => {
        if (el.kind !== 'logo') return;
        const existing = freeLogoImgsRef.current[el.id];
        if (existing && existing.src === el.url) return;
        const img = cachedEditorImage(el.url);
        img.onload = () => { freeLogoImgsRef.current[el.id] = img; redraw(cachedImgRef.current); };
        if (img.complete && img.naturalWidth > 0) { freeLogoImgsRef.current[el.id] = img; redraw(cachedImgRef.current); }
      });
    }, [settings.freeElements]); // eslint-disable-line react-hooks/exhaustive-deps

    // Restore row-slot logo images when settings are hydrated from DB
    useEffect(() => {
      (settings.logoRowSlots ?? []).forEach((logoUrl, idx) => {
        if (!logoUrl) { logoImgsRef.current[idx] = null; return; }
        const img = cachedEditorImage(logoUrl);
        const apply = () => {
          logoImgsRef.current[idx] = img;
          const next = [...slotsRef.current] as (SlotContent | null)[];
          next[idx] = { type: 'image', url: logoUrl };
          slotsRef.current = next;
          setSlots(next);
          redraw(cachedImgRef.current);
        };
        img.onload = apply;
        if (img.complete && img.naturalWidth > 0) apply();
      });
    }, [settings.logoRowSlots]); // eslint-disable-line react-hooks/exhaustive-deps

    function selectBrandLogo(idx: number) {
      if (!brandLogoSrc) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      let applied = false;
      const apply = () => {
        if (applied) return;
        applied = true;
        logoImgsRef.current[idx] = img;
        const next = [...slotsRef.current] as (SlotContent | null)[];
        next[idx] = { type: 'image', url: brandLogoSrc };
        slotsRef.current = next;
        setSlots(next);
        const curTagSlots   = [...(settingsRef.current.tagSlots   ?? Array(3).fill(null))];
        const curQuoteSlots = [...(settingsRef.current.quoteSlots ?? Array(3).fill(null))];
        const curLogoRow    = [...(settingsRef.current.logoRowSlots ?? Array(3).fill(null))];
        curTagSlots[idx]   = null;
        curQuoteSlots[idx] = null;
        curLogoRow[idx]    = brandLogoSrc;
        settingsRef.current = { ...settingsRef.current, tagSlots: curTagSlots, quoteSlots: curQuoteSlots, logoRowSlots: curLogoRow };
        onSettingsChange?.({ tagSlots: curTagSlots, quoteSlots: curQuoteSlots, logoRowSlots: curLogoRow });
        redraw(cachedImgRef.current);
      };
      img.onload = apply;
      img.src = brandLogoSrc;
      if (img.complete && img.naturalWidth > 0) apply();
    }

    function selectTag(idx: number, text: string, style: TagStyle) {
      const imgSlot = slotsRef.current[idx];
      if (imgSlot?.type === 'image') URL.revokeObjectURL(imgSlot.url);
      logoImgsRef.current[idx] = null;
      const next = [...slotsRef.current] as (SlotContent | null)[];
      next[idx] = null;
      slotsRef.current = next;
      setSlots(next);
      const curTagSlots   = [...(settingsRef.current.tagSlots   ?? Array(3).fill(null))];
      const curQuoteSlots = [...(settingsRef.current.quoteSlots ?? Array(3).fill(null))];
      curTagSlots[idx]   = { text, style };
      curQuoteSlots[idx] = null;
      settingsRef.current = { ...settingsRef.current, tagSlots: curTagSlots, quoteSlots: curQuoteSlots };
      onSettingsChange?.({ tagSlots: curTagSlots, quoteSlots: curQuoteSlots });
    }

    const ZONES = ['left', 'center', 'right'] as const;
    function ziFromZone(z: 'left' | 'center' | 'right') { return z === 'left' ? 0 : z === 'center' ? 1 : 2; }

    function selectTagZone(row: number, zone: 'left' | 'center' | 'right', text: string, style: TagStyle) {
      const fi = row * 3 + ziFromZone(zone);
      const cur = [...(settingsRef.current.tagZoneSlots ?? Array(9).fill(null))];
      cur[fi] = { text, style };
      settingsRef.current = { ...settingsRef.current, tagZoneSlots: cur };
      onSettingsChange?.({ tagZoneSlots: cur });
      redraw(cachedImgRef.current);
    }

    function selectBrandLogoZone(row: number, zone: 'left' | 'center' | 'right', url?: string) {
      const src = url ?? brandLogoSrc;
      if (!src) return;
      const fi = row * 3 + ziFromZone(zone);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      let applied = false;
      const apply = () => {
        if (applied) return;
        applied = true;
        zoneLogoImgsRef.current[fi] = img;
        const cur = [...(settingsRef.current.zoneLogoSlots ?? Array(9).fill(null))];
        cur[fi] = src;
        settingsRef.current = { ...settingsRef.current, zoneLogoSlots: cur };
        onSettingsChange?.({ zoneLogoSlots: cur });
        redraw(cachedImgRef.current);
      };
      img.onload = apply;
      img.src = src;
      if (img.complete && img.naturalWidth > 0) apply();
    }

    function selectQuoteZone(row: number, zone: 'left' | 'center' | 'right', styleId: string) {
      const fi = row * 3 + ziFromZone(zone);
      const cur = [...(settingsRef.current.quoteZoneSlots ?? Array(9).fill(null))];
      cur[fi] = styleId;
      settingsRef.current = { ...settingsRef.current, quoteZoneSlots: cur };
      onSettingsChange?.({ quoteZoneSlots: cur });
      redraw(cachedImgRef.current);
    }

    function selectSwipeZone(row: number, zone: 'left' | 'center' | 'right', style: SwipeStyle) {
      const fi = row * 3 + ziFromZone(zone);
      const cur = [...(settingsRef.current.swipeZoneSlots ?? Array(9).fill(null))];
      cur[fi] = style;
      settingsRef.current = { ...settingsRef.current, swipeZoneSlots: cur };
      onSettingsChange?.({ swipeZoneSlots: cur });
      redraw(cachedImgRef.current);
    }

    function removeZoneSlot(row: number, zone: 'left' | 'center' | 'right') {
      const fi = row * 3 + ziFromZone(zone);
      const curTag   = [...(settingsRef.current.tagZoneSlots   ?? Array(9).fill(null))];
      const curQuo   = [...(settingsRef.current.quoteZoneSlots ?? Array(9).fill(null))];
      const curLogo  = [...(settingsRef.current.zoneLogoSlots  ?? Array(9).fill(null))];
      const curSwipe = [...(settingsRef.current.swipeZoneSlots ?? Array(9).fill(null))];
      curTag[fi]  = null;
      curQuo[fi]  = null;
      curLogo[fi] = null;
      curSwipe[fi] = null;
      zoneLogoImgsRef.current[fi] = null;
      settingsRef.current = { ...settingsRef.current, tagZoneSlots: curTag, quoteZoneSlots: curQuo, zoneLogoSlots: curLogo, swipeZoneSlots: curSwipe };
      onSettingsChange?.({ tagZoneSlots: curTag, quoteZoneSlots: curQuo, zoneLogoSlots: curLogo, swipeZoneSlots: curSwipe });
      redraw(cachedImgRef.current);
    }

    // ── Freeform elements (merged skeleton/freeform experience) ───────────────
    // A skeleton box's content can be dragged OUT (becomes a free element, the
    // box frees up), roam the canvas, and be dragged back over any empty box to
    // snap in. Boxes hold at most one element.

    function newElementId(): string {
      return (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : `fe-${Date.now()}-${Math.floor(performance.now() * 1000) % 100000}`;
    }

    function zoneIsEmpty(row: number, zi: number): boolean {
      const s = settingsRef.current;
      const fi = row * 3 + zi;
      if (s.dividerSlots?.[row]) return false;
      if (slotsRef.current[row]) return false;   // uploaded image occupies the whole row
      return !s.tagZoneSlots?.[fi] && !s.zoneLogoSlots?.[fi] && !s.quoteZoneSlots?.[fi] && !s.swipeZoneSlots?.[fi];
    }
    function rowIsEmpty(row: number): boolean {
      return zoneIsEmpty(row, 0) && zoneIsEmpty(row, 1) && zoneIsEmpty(row, 2);
    }

    // Which skeleton box is under the cursor (client coords)? Divider elements
    // target whole rows (zi = -1); everything else targets a single zone.
    function hitSnapTarget(kind: FreeElement['kind'], clientX: number, clientY: number): { row: number; zi: number } | null {
      for (let i = 0; i < 3; i++) {
        const rowEl = slotContainerRefs.current[i];
        if (!rowEl) continue;
        const r = rowEl.getBoundingClientRect();
        if (clientX < r.left || clientX > r.right || clientY < r.top - 8 || clientY > r.bottom + 8) continue;
        if (kind === 'divider') return rowIsEmpty(i) ? { row: i, zi: -1 } : null;
        const zi = Math.max(0, Math.min(2, Math.floor((clientX - r.left) / (r.width / 3))));
        return zoneIsEmpty(i, zi) ? { row: i, zi } : null;
      }
      return null;
    }

    function applyFreePatch(patch: Partial<CarouselSettings>) {
      settingsRef.current = { ...settingsRef.current, ...patch };
      onSettingsChange?.(patch);
      redraw(cachedImgRef.current);
    }

    function snapFreeElementIntoBox(index: number, row: number, zi: number) {
      const s = settingsRef.current;
      const el = (s.freeElements ?? [])[index];
      if (!el) return;
      const free = [...(s.freeElements ?? [])];
      free.splice(index, 1);
      if (el.kind === 'divider') {
        if (!rowIsEmpty(row)) return;
        const cur    = [...(s.dividerSlots    ?? Array(3).fill(null))];
        const curSub = [...(s.dividerSubSlots ?? Array(3).fill(null))] as (DividerSubSlotContent | null)[];
        const curDs  = [...(s.dividerSettings ?? Array(3).fill(null))] as (Partial<DividerStyleSettings> | null)[];
        cur[row] = el.dividerId; curSub[row] = el.sub ?? null; curDs[row] = el.settings ?? null;
        applyFreePatch({ freeElements: free, dividerSlots: cur, dividerSubSlots: curSub, dividerSettings: curDs });
        return;
      }
      if (!zoneIsEmpty(row, zi)) return;
      const fi = row * 3 + zi;
      if (el.kind === 'tag') {
        const cur = [...(s.tagZoneSlots ?? Array(9).fill(null))];
        cur[fi] = { text: el.text, style: el.style };
        applyFreePatch({ freeElements: free, tagZoneSlots: cur });
      } else if (el.kind === 'quote') {
        const cur = [...(s.quoteZoneSlots ?? Array(9).fill(null))];
        cur[fi] = el.styleId;
        applyFreePatch({ freeElements: free, quoteZoneSlots: cur });
      } else if (el.kind === 'swipe') {
        const cur = [...(s.swipeZoneSlots ?? Array(9).fill(null))];
        cur[fi] = el.style;
        applyFreePatch({ freeElements: free, swipeZoneSlots: cur });
      } else if (el.kind === 'logo') {
        const cur = [...(s.zoneLogoSlots ?? Array(9).fill(null))];
        cur[fi] = el.url;
        delete freeLogoImgsRef.current[el.id];   // zone-logo effect reloads it by url
        applyFreePatch({ freeElements: free, zoneLogoSlots: cur });
      }
    }

    function removeFreeElement(index: number) {
      const free = [...(settingsRef.current.freeElements ?? [])];
      const el = free[index];
      if (!el) return;
      if (el.kind === 'logo') delete freeLogoImgsRef.current[el.id];
      free.splice(index, 1);
      setSelectedFreeEl(null);
      applyFreePatch({ freeElements: free });
    }

    // Drag a free element by index. grab offsets keep the element under the
    // cursor where it was picked up; snaps into an empty box on release.
    function bindFreeElementDrag(index: number, startClientX: number, startClientY: number) {
      const el0 = (settingsRef.current.freeElements ?? [])[index];
      if (!el0) return;
      const startX = el0.x, startY = el0.y;
      setFreeDragKind(el0.kind);
      selectFreeElOnly(index);
      const onMove = (ev: MouseEvent) => {
        const free = [...(settingsRef.current.freeElements ?? [])];
        const el = free[index];
        if (!el) return;
        let nx = Math.round(Math.max(-el.width / 2, Math.min(W - el.width / 2, startX + (ev.clientX - startClientX) / DISPLAY_SCALE)));
        let ny = Math.round(Math.max(-el.height / 2, Math.min(H - el.height / 2, startY + (ev.clientY - startClientY) / DISPLAY_SCALE)));
        // Zone snap (drop into an empty box on release) takes precedence; otherwise snap to the guidelines
        // (canvas edges / 60px margins / centre) — the same targets image + text boxes already use.
        const zone = hitSnapTarget(el.kind, ev.clientX, ev.clientY);
        setFreeSnap(zone);
        let gx: number | null = null, gy: number | null = null;
        if (!zone) {
          const w = el.width, h = el.height;
          const xT = [[0, 0], [SNAP_EDGE, SNAP_EDGE], [Math.round(W / 2 - w / 2), Math.round(W / 2)], [W - SNAP_EDGE - w, W - SNAP_EDGE], [W - w, W]];
          const yT = [[0, 0], [SNAP_EDGE, SNAP_EDGE], [Math.round(H / 2 - h / 2), Math.round(H / 2)], [H - SNAP_EDGE - h, H - SNAP_EDGE], [H - h, H]];
          for (const [tx, g] of xT) { if (Math.abs(nx - tx) <= SNAP_PX) { nx = tx; gx = g; break; } }
          for (const [ty, g] of yT) { if (Math.abs(ny - ty) <= SNAP_PX) { ny = ty; gy = g; break; } }
        }
        setSnapGuideX(gx); setSnapGuideY(gy);
        free[index] = { ...el, x: nx, y: ny };
        settingsRef.current = { ...settingsRef.current, freeElements: free };
        onSettingsChange?.({ freeElements: free });
        redraw(cachedImgRef.current);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const snap = freeSnapRef.current;
        setFreeDragKind(null);
        setFreeSnap(null);
        setSnapGuideX(null); setSnapGuideY(null);
        if (snap) snapFreeElementIntoBox(index, snap.row, snap.zi);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    // Resize a free element (any kind, incl. custom) from a corner/edge handle. Mirrors the image-box
    // corner-scale logic: anchors the opposite edge, clamps to a minimum size, snaps to the canvas
    // guides, and (shift held) locks the aspect ratio captured at drag-start.
    function bindFreeElementResize(index: number, handle: string, startClientX: number, startClientY: number) {
      const el0 = (settingsRef.current.freeElements ?? [])[index];
      if (!el0) return;
      freeElResizeStart.current = { handle, mx: startClientX, my: startClientY, x: el0.x, y: el0.y, w: el0.width, h: el0.height, aspect: (el0.width / el0.height) || 1 };
      setActiveResizeFreeEl(index);
      const MIN = 20;
      const onMove = (ev: MouseEvent) => {
        const s0 = freeElResizeStart.current;
        const dx = Math.round((ev.clientX - s0.mx) / DISPLAY_SCALE);
        const dy = Math.round((ev.clientY - s0.my) / DISPLAY_SCALE);
        const hasE = s0.handle.includes('e'), hasW = s0.handle.includes('w');
        const hasS = s0.handle.includes('s'), hasN = s0.handle.includes('n');
        let w = s0.w + (hasE ? dx : hasW ? -dx : 0);
        let h = s0.h + (hasS ? dy : hasN ? -dy : 0);
        let gx: number | null = null, gy: number | null = null;
        if (ev.shiftKey && s0.w > 0 && s0.h > 0) {
          const aspect = s0.aspect || s0.w / s0.h || 1;
          if (Math.abs(w / s0.w - 1) >= Math.abs(h / s0.h - 1)) {
            if (hasE)      { const g = nearestGuide(s0.x + w, X_GUIDES);        if (g !== null && g - s0.x >= MIN) { w = g - s0.x; gx = g; } }
            else if (hasW) { const g = nearestGuide(s0.x + s0.w - w, X_GUIDES); if (g !== null && s0.x + s0.w - g >= MIN) { w = s0.x + s0.w - g; gx = g; } }
            h = w / aspect;
          } else {
            if (hasS)      { const g = nearestGuide(s0.y + h, Y_GUIDES);        if (g !== null && g - s0.y >= MIN) { h = g - s0.y; gy = g; } }
            else if (hasN) { const g = nearestGuide(s0.y + s0.h - h, Y_GUIDES); if (g !== null && s0.y + s0.h - g >= MIN) { h = s0.y + s0.h - g; gy = g; } }
            w = h * aspect;
          }
          if (w < MIN) { w = MIN; h = w / aspect; }
          if (h < MIN) { h = MIN; w = h * aspect; }
        } else {
          if (hasE)      { const g = nearestGuide(s0.x + w, X_GUIDES);        if (g !== null && g - s0.x >= MIN) { w = g - s0.x; gx = g; } }
          else if (hasW) { const g = nearestGuide(s0.x + s0.w - w, X_GUIDES); if (g !== null && s0.x + s0.w - g >= MIN) { w = s0.x + s0.w - g; gx = g; } }
          if (hasS)      { const g = nearestGuide(s0.y + h, Y_GUIDES);        if (g !== null && g - s0.y >= MIN) { h = g - s0.y; gy = g; } }
          else if (hasN) { const g = nearestGuide(s0.y + s0.h - h, Y_GUIDES); if (g !== null && s0.y + s0.h - g >= MIN) { h = s0.y + s0.h - g; gy = g; } }
          w = Math.max(MIN, w);
          h = Math.max(MIN, h);
        }
        // No top/left clamp: symmetric with the free-element drag, which also allows going negative.
        const x = hasW ? s0.x + s0.w - w : s0.x;
        const y = hasN ? s0.y + s0.h - h : s0.y;
        setSnapGuideX(gx); setSnapGuideY(gy);
        const free = [...(settingsRef.current.freeElements ?? [])];
        if (!free[index]) return;
        free[index] = { ...free[index], x, y, width: w, height: h };
        settingsRef.current = { ...settingsRef.current, freeElements: free };
        onSettingsChange?.({ freeElements: free });
        redraw(cachedImgRef.current);
      };
      const onUp = () => {
        setActiveResizeFreeEl(null);
        setSnapGuideX(null); setSnapGuideY(null);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    // Build a free element from a sidebar palette drop at canvas coords (cx, cy
    // = drop centre). Sizes approximate the rendered content; the box is just a
    // hit/anchor area — drawing centers the content inside it.
    function freeElementFromSidebar(d: SidebarElementData, cx: number, cy: number): FreeElement | null {
      const s = settingsRef.current;
      const id = newElementId();
      if (d.type === 'tag' && d.text && d.style) {
        const st = d.style;
        const w = Math.max(80, Math.min(700, Math.round(d.text.length * st.fontSize * 0.62 + st.paddingX * 2 + 24)));
        const h = Math.round(st.fontSize + st.paddingY * 2 + 12);
        return { id, kind: 'tag', text: d.text, style: st, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h };
      }
      if (d.type === 'quote' && d.id) {
        const size = s.quoteSize ?? 120;
        const qs = ALL_QUOTE_STYLES.find(q => q.id === d.id);
        const w = Math.round(qs?.paired ? size * 2 + (s.quoteGap ?? 8) : size);
        return { id, kind: 'quote', styleId: d.id, x: Math.round(cx - w / 2), y: Math.round(cy - size / 2), width: w, height: size };
      }
      if (d.type === 'swipe' && d.swipeStyle) {
        const st = d.swipeStyle;
        const textW  = st.layout !== 'arrow-only' && st.text ? st.text.length * st.fontSize * 0.55 : 0;
        const arrowW = st.layout !== 'text-only' ? (st.arrowLength ?? 60) + (st.arrowHeadSize ?? 10) * 1.2 : 0;
        const w = Math.max(60, Math.round(textW + arrowW + (st.gap ?? 12)));
        const h = Math.round(Math.max(st.fontSize, (st.arrowHeadSize ?? 10) * 2) + 16);
        return { id, kind: 'swipe', style: st, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h };
      }
      if (d.type === 'logo') {
        const url = d.url ?? brandLogoSrc;
        if (!url) return null;
        const w = 300, h = LOGO_CH;
        return { id, kind: 'logo', url, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h };
      }
      if (d.type === 'divider' && d.id) {
        const padX = Math.round(32 + (s.contentPadding ?? 50) * 0.64);
        const w = W - 2 * padX;
        return { id, kind: 'divider', dividerId: d.id, x: padX, y: Math.round(cy - LOGO_CH / 2), width: w, height: LOGO_CH };
      }
      return null;
    }

    function addFreeElementFromSidebar(d: SidebarElementData, cx: number, cy: number): boolean {
      const el = freeElementFromSidebar(d, cx, cy);
      if (!el) return false;
      applyFreePatch({ freeElements: [...(settingsRef.current.freeElements ?? []), el] });
      return true;
    }

    // ── Headline / Sub-headline as skeleton text slots ─────────────────────────
    // The headline & sub are predefined text boxes. Dragging one out clones its
    // styling into a freeform TextBoxStyle (branching: later headline-setting
    // changes don't touch the clone) and vacates the slot. Dragging any text box
    // over a VACANT slot snaps it in, and the slot's settings INHERIT the box's
    // styling. Works cross-slot (sub → headline, palette presets → either slot).

    // Slot bands in PREVIEW px. During a text drag drawCanvas RESERVES one line
    // for each vacant slot (see hBlockH/sBlockH), so the measured block state
    // already describes the final stacked layout — bands read straight off it
    // and are exactly the height/position of the text that will land there.
    function textSlotBands() {
      const headOccupied = !!headlineRef.current.trim();
      const subOccupied  = !!subheadlineRef.current.trim();
      return {
        headOccupied, subOccupied,
        head: { top: blockTopPv, height: headBlockHPv },
        sub:  { top: blockTopPv + headBlockHPv + gapPv, height: subBlockHPv },
      };
    }

    // The visual band is exactly one text line tall — too small as a target.
    // The HIT zone is padded well beyond it (split at the midpoint when both
    // slots are vacant so the zones never overlap).
    const TEXT_SLOT_HIT_PAD = 28;
    function hitTextSlot(clientX: number, clientY: number): 'headline' | 'sub' | null {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const mx = clientX - rect.left, my = clientY - rect.top;
      const padPv = Math.round((32 + settingsRef.current.contentPadding * 0.64) * DISPLAY_SCALE);
      if (mx < padPv - 12 || mx > CAROUSEL_PREVIEW_W - padPv + 12) return null;
      const bands = textSlotBands();
      const headHit = !bands.headOccupied
        ? { top: bands.head.top - TEXT_SLOT_HIT_PAD, bottom: bands.head.top + bands.head.height + TEXT_SLOT_HIT_PAD }
        : null;
      const subHit = !bands.subOccupied
        ? { top: bands.sub.top - TEXT_SLOT_HIT_PAD, bottom: bands.sub.top + bands.sub.height + TEXT_SLOT_HIT_PAD }
        : null;
      if (headHit && subHit) {
        const mid = (bands.head.top + bands.head.height + bands.sub.top) / 2;
        headHit.bottom = Math.min(headHit.bottom, mid);
        subHit.top = Math.max(subHit.top, mid);
      }
      if (headHit && my >= headHit.top && my <= headHit.bottom) return 'headline';
      if (subHit && my >= subHit.top && my <= subHit.bottom) return 'sub';
      return null;
    }

    // Clone the slot's current styling + text into a freeform text box (branch point).
    function slotToTextBox(which: 'headline' | 'sub'): TextBoxStyle | null {
      const s = settingsRef.current;
      const isHead = which === 'headline';
      const text = (isHead ? headlineRef.current : subheadlineRef.current);
      if (!text.trim()) return null;
      const padX = Math.round(32 + s.contentPadding * 0.64);
      const topPv = isHead ? blockTopPv : blockTopPv + headBlockHPv + gapPv;
      const hPv   = isHead ? headBlockHPv : subBlockHPv;
      return {
        id: (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID() : `tb-${Math.floor(Math.random() * 1e9).toString(36)}`,
        text,
        x: padX,
        y: Math.round(topPv / DISPLAY_SCALE),
        width: W - 2 * padX,
        height: Math.max(40, Math.round(hPv / DISPLAY_SCALE)),
        fontLabel:  isHead ? s.fontLabel : s.subFontLabel,
        fontSize:   isHead ? s.fontSize : s.subFontSize,
        fontWeight: isHead ? s.fontWeight : s.subFontWeight,
        italic:     isHead ? s.italic : s.subItalic,
        allCaps:    isHead ? s.allCaps : s.subAllCaps,
        spans:      (isHead ? s.headlineSpans : s.subSpans) ?? undefined,
        color:      (isHead ? s.headlineColor : s.subheadlineColor) ?? '#ffffff',
        align:      isHead ? s.textAlign : s.subTextAlign,
        vAlign: 'top',
        letterSpacing: ((isHead ? s.lSpacing : s.subLSpacing) / 100) * 20,
        lineHeight:    isHead ? s.lHeight : s.subLHeight,
        opacity: 100,
        shadow: (isHead ? s.headlineShadow : s.subShadow) ?? undefined,
        label: isHead ? 'Headline' : 'Sub-headline',
      };
    }

    // Snap a text box into a vacant slot: the slot settings inherit the box's styling.
    function snapTextBoxIntoSlot(idx: number, which: 'headline' | 'sub') {
      const s = settingsRef.current;
      const tb = (s.textBoxes ?? [])[idx];
      if (!tb) return;
      const isHead = which === 'headline';
      if ((isHead ? headlineRef.current : subheadlineRef.current).trim()) return;   // occupied
      const arr = [...(s.textBoxes ?? [])];
      arr.splice(idx, 1);
      const lSp = Math.round((tb.letterSpacing ?? 0) * 5);   // canvas px → setting units
      const patch: Partial<CarouselSettings> = isHead
        ? {
            textBoxes: arr,
            fontLabel: tb.fontLabel, fontSize: tb.fontSize, fontWeight: tb.fontWeight,
            italic: tb.italic, allCaps: !!tb.allCaps, textAlign: tb.align,
            lHeight: tb.lineHeight, lSpacing: lSp,
            headlineColor: tb.color, headlineShadow: tb.shadow ?? undefined, headlineSpans: tb.spans ?? null,
          }
        : {
            textBoxes: arr,
            subFontLabel: tb.fontLabel, subFontSize: tb.fontSize, subFontWeight: tb.fontWeight,
            subItalic: tb.italic, subAllCaps: !!tb.allCaps, subTextAlign: tb.align,
            subLHeight: tb.lineHeight, subLSpacing: lSp,
            subheadlineColor: tb.color, subShadow: tb.shadow ?? undefined, subSpans: tb.spans ?? null,
          };
      settingsRef.current = { ...s, ...patch };
      onSettingsChange?.(patch);
      if (isHead) onHeadlineChange?.(tb.text); else onSubheadlineChange?.(tb.text);
      setSelectedTextBox(null);
      redraw(cachedImgRef.current);
    }

    // Palette text preset dropped on a VACANT slot: the slot inherits the preset.
    function applyTextPresetToSlot(which: 'headline' | 'sub', preset: Partial<TextBoxStyle>, text: string) {
      const s = settingsRef.current;
      const isHead = which === 'headline';
      if ((isHead ? headlineRef.current : subheadlineRef.current).trim()) return;
      const lSp = preset.letterSpacing != null ? Math.round(preset.letterSpacing * 5) : undefined;
      const patch: Partial<CarouselSettings> = isHead
        ? {
            ...(preset.fontLabel  != null && { fontLabel: preset.fontLabel }),
            ...(preset.fontSize   != null && { fontSize: preset.fontSize }),
            ...(preset.fontWeight != null && { fontWeight: preset.fontWeight }),
            ...(preset.italic     != null && { italic: preset.italic }),
            ...(preset.allCaps    != null && { allCaps: preset.allCaps }),
            ...(preset.align      != null && { textAlign: preset.align }),
            ...(preset.lineHeight != null && { lHeight: preset.lineHeight }),
            ...(lSp               != null && { lSpacing: lSp }),
            ...(preset.color      != null && { headlineColor: preset.color }),
            headlineSpans: null,
          }
        : {
            ...(preset.fontLabel  != null && { subFontLabel: preset.fontLabel }),
            ...(preset.fontSize   != null && { subFontSize: preset.fontSize }),
            ...(preset.fontWeight != null && { subFontWeight: preset.fontWeight }),
            ...(preset.italic     != null && { subItalic: preset.italic }),
            ...(preset.allCaps    != null && { subAllCaps: preset.allCaps }),
            ...(preset.align      != null && { subTextAlign: preset.align }),
            ...(preset.lineHeight != null && { subLHeight: preset.lineHeight }),
            ...(lSp               != null && { subLSpacing: lSp }),
            ...(preset.color      != null && { subheadlineColor: preset.color }),
            subSpans: null,
          };
      settingsRef.current = { ...s, ...patch };
      onSettingsChange?.(patch);
      if (isHead) onHeadlineChange?.(text); else onSubheadlineChange?.(text);
      redraw(cachedImgRef.current);
    }

    // Bind a text-box drag (window listeners) with slot-snap detection. Used by
    // the escape drag below; the regular overlay drag adds the same snap calls.
    function bindTextBoxSlotDrag(idx: number, startClientX: number, startClientY: number, startX: number, startY: number) {
      setTextDragActive(true);
      const onMove = (ev: MouseEvent) => {
        const cur = [...(settingsRef.current.textBoxes ?? [])];
        const box = cur[idx];
        if (!box) return;
        const nx = Math.round(startX + (ev.clientX - startClientX) / DISPLAY_SCALE);
        const ny = Math.round(startY + (ev.clientY - startClientY) / DISPLAY_SCALE);
        cur[idx] = { ...box, x: nx, y: ny };
        settingsRef.current = { ...settingsRef.current, textBoxes: cur };
        onSettingsChange?.({ textBoxes: cur });
        setTextSnap(hitTextSlot(ev.clientX, ev.clientY));
        redraw(cachedImgRef.current);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const snap = textSnapRef.current;
        setTextDragActive(false);
        setTextSnap(null);
        setActiveDragTextBox(null);
        if (snap) snapTextBoxIntoSlot(idx, snap);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    // Drag the headline/sub OUT of its skeleton slot: past a threshold the text
    // (with its full styling) becomes a freeform text box and the slot vacates.
    function startSlotTextEscapeDrag(e: React.MouseEvent, which: 'headline' | 'sub') {
      if (e.button !== 0) return;
      const startCX = e.clientX, startCY = e.clientY;
      let converted = false;
      const onMove = (ev: MouseEvent) => {
        if (converted) return;
        if (Math.abs(ev.clientX - startCX) < 6 && Math.abs(ev.clientY - startCY) < 6) return;
        const tb = slotToTextBox(which);
        if (!tb) { onUp(); return; }
        converted = true;
        const s = settingsRef.current;
        const arr = [...(s.textBoxes ?? []), tb];
        const idx = arr.length - 1;
        // The clone carries the inherited styling with it; the slot itself goes
        // back to stock skeleton styling, ready for the next occupant.
        const d = defaultCarouselSettings();
        const patch: Partial<CarouselSettings> = which === 'headline'
          ? {
              textBoxes: arr, headlineSpans: null,
              fontLabel: d.fontLabel, fontSize: d.fontSize, fontWeight: d.fontWeight,
              italic: d.italic, allCaps: d.allCaps, textAlign: d.textAlign,
              lHeight: d.lHeight, lSpacing: d.lSpacing,
              headlineColor: d.headlineColor ?? '#ffffff', headlineShadow: undefined,
            }
          : {
              textBoxes: arr, subSpans: null,
              subFontLabel: d.subFontLabel, subFontSize: d.subFontSize, subFontWeight: d.subFontWeight,
              subItalic: d.subItalic, subAllCaps: d.subAllCaps, subTextAlign: d.subTextAlign,
              subLHeight: d.subLHeight, subLSpacing: d.subLSpacing,
              subheadlineColor: d.subheadlineColor ?? '#ffffff', subShadow: undefined,
            };
        settingsRef.current = { ...s, ...patch };
        onSettingsChange?.(patch);
        if (which === 'headline') onHeadlineChange?.(''); else onSubheadlineChange?.('');
        selectTextBoxOnly(idx);
        setActiveDragTextBox(idx);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        bindTextBoxSlotDrag(idx, startCX, startCY, tb.x, tb.y);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    // Rect of the actually-DRAWN content inside a box (canvas px, relative to the
    // box origin). Mirrors the drawing math of each kind so UI chrome (the ×)
    // can sit exactly on the element's corner rather than the hit-box corner.
    type ContentPayload =
      | { kind: 'tag'; text: string; style: TagStyle }
      | { kind: 'quote'; styleId: string }
      | { kind: 'swipe'; style: SwipeStyle }
      | { kind: 'logo'; img: HTMLImageElement | null }
      | { kind: 'divider' };
    function contentRectInBox(
      payload: ContentPayload,
      boxW: number, boxH: number,
      ha: 'left' | 'center' | 'right', va: 'top' | 'center' | 'bottom',
    ): { x: number; y: number; w: number; h: number } {
      const s = settingsRef.current;
      const mctx = measureCtx2D();
      const anchor = (w: number, h: number) => ({
        x: ha === 'left' ? 0 : ha === 'right' ? boxW - w : (boxW - w) / 2,
        y: va === 'top' ? 0 : va === 'bottom' ? boxH - h : (boxH - h) / 2,
        w, h,
      });
      if (payload.kind === 'tag') {
        const ts = payload.style;
        const k  = 1 / DISPLAY_SCALE;
        const fs = Math.round(ts.fontSize * k), px = Math.round(ts.paddingX * k), py = Math.round(ts.paddingY * k);
        const tc = ts.textCase ?? 'none';
        const t  = tc === 'upper' ? payload.text.toUpperCase() : payload.text;
        let textW = t.length * fs * 0.55;
        if (mctx) {
          mctx.font = `${ts.italic ? 'italic ' : ''}${tc === 'smallcaps' ? 'small-caps ' : ''}${ts.fontWeight} ${fs}px ${resolveCarouselFont(ts.fontLabel).css}`;
          (mctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${((ts.letterSpacing ?? 0) * k).toFixed(2)}px`;
          textW = mctx.measureText(t).width;
          (mctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
        }
        return anchor(Math.round(textW + px * 2), Math.round(fs * 1.2 + py * 2));
      }
      if (payload.kind === 'quote') {
        const qs = ALL_QUOTE_STYLES.find(q => q.id === payload.styleId);
        if (!qs) return anchor(boxW, boxH);
        const qSize = s.quoteSize ?? 120;
        const [, , vbW, vbH] = qs.viewBox;
        const scale = Math.min(qSize / vbW, qSize / vbH);
        const drawW = vbW * scale, drawH = vbH * scale;
        const totalW = qs.paired ? drawW * 2 + (s.quoteGap ?? 8) : drawW;
        return anchor(totalW, drawH);
      }
      if (payload.kind === 'swipe') {
        const st = payload.style;
        const text = st.allCaps ? (st.text ?? '').toUpperCase() : (st.text ?? '');
        const fs = st.fontSize;
        const arrowLen = st.arrowType !== 'chevron' && st.arrowType !== 'double-chevron' ? (st.arrowLength ?? 60) : 0;
        const headSize = st.arrowHeadSize ?? 10;
        const gap = st.gap ?? 12;
        const showText  = st.layout !== 'arrow-only' && text.length > 0;
        const showArrow = st.layout !== 'text-only';
        let textW = showText ? text.length * fs * 0.55 : 0;
        if (mctx && showText) {
          mctx.font = `${st.fontWeight} ${fs}px ${resolveCarouselFont(st.fontLabel).css}`;
          (mctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${st.letterSpacing ?? 0}px`;
          textW = mctx.measureText(text).width;
          (mctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
        }
        const arrowTotalW = showArrow ? arrowLen + headSize * 1.2 : 0;
        let totalW = 0, totalH = 0;
        if (st.layout === 'stacked') {
          totalW = Math.max(showText ? textW : 0, arrowTotalW);
          totalH = (showText ? fs : 0) + (showText && showArrow ? gap : 0) + (showArrow ? headSize * 2 : 0);
        } else if (st.layout === 'arrow-only') {
          totalW = arrowTotalW; totalH = headSize * 2;
        } else if (st.layout === 'text-only') {
          totalW = textW; totalH = fs;
        } else {
          totalW = (showText ? textW : 0) + (showText && showArrow ? gap : 0) + arrowTotalW;
          totalH = Math.max(showText ? fs : 0, headSize * 2);
        }
        return anchor(totalW, totalH);
      }
      if (payload.kind === 'logo' && payload.img) {
        const img = payload.img;
        const fitS = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
        const dw = img.naturalWidth  * fitS * ((s.logoScale ?? 100) / 100);
        const dh = img.naturalHeight * fitS * ((s.logoScale ?? 100) / 100);
        return anchor(dw, dh);
      }
      return { x: 0, y: 0, w: boxW, h: boxH };
    }

    // Drag content OUT of a skeleton box: past a small threshold the content is
    // converted to a free element (the box frees up) and follows the cursor.
    function startZoneEscapeDrag(
      e: React.MouseEvent,
      makeElement: (box: { x: number; y: number; w: number; h: number }) => { el: FreeElement; clearPatch: Partial<CarouselSettings> } | null,
    ) {
      if (e.button !== 0) return;
      if ((e.target as Element).closest('button')) return;   // the remove ×, sub-slot button, …
      e.stopPropagation();
      e.preventDefault();
      const startCX = e.clientX, startCY = e.clientY;
      const cellRect = (e.currentTarget as Element).getBoundingClientRect();
      const wrapRect = wrapperRef.current?.getBoundingClientRect();
      if (!wrapRect) return;
      const box = {
        x: Math.round((cellRect.left - wrapRect.left) / DISPLAY_SCALE),
        y: Math.round((cellRect.top  - wrapRect.top)  / DISPLAY_SCALE),
        w: Math.round(cellRect.width  / DISPLAY_SCALE),
        h: Math.round(cellRect.height / DISPLAY_SCALE),
      };
      let converted = false;
      let elIndex = -1;
      let kind: FreeElement['kind'] = 'tag';
      const onMove = (ev: MouseEvent) => {
        if (!converted) {
          if (Math.abs(ev.clientX - startCX) < 6 && Math.abs(ev.clientY - startCY) < 6) return;
          const made = makeElement(box);
          if (!made) { onUp(); return; }
          converted = true;
          kind = made.el.kind;
          const free = [...(settingsRef.current.freeElements ?? []), made.el];
          elIndex = free.length - 1;
          applyFreePatch({ freeElements: free, ...made.clearPatch });
          setFreeDragKind(kind);
          selectFreeElOnly(elIndex);
        }
        const free = [...(settingsRef.current.freeElements ?? [])];
        const el = free[elIndex];
        if (!el) return;
        const nx = Math.round(Math.max(-el.width / 2, Math.min(W - el.width / 2, box.x + (ev.clientX - startCX) / DISPLAY_SCALE)));
        const ny = Math.round(Math.max(-el.height / 2, Math.min(H - el.height / 2, box.y + (ev.clientY - startCY) / DISPLAY_SCALE)));
        free[elIndex] = { ...el, x: nx, y: ny };
        settingsRef.current = { ...settingsRef.current, freeElements: free };
        onSettingsChange?.({ freeElements: free });
        setFreeSnap(hitSnapTarget(el.kind, ev.clientX, ev.clientY));
        redraw(cachedImgRef.current);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const snap = freeSnapRef.current;
        setFreeDragKind(null);
        setFreeSnap(null);
        if (converted && snap && elIndex >= 0) snapFreeElementIntoBox(elIndex, snap.row, snap.zi);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    function setTagSlotAlign(idx: number, align: 'left' | 'center' | 'right') {
      const cur = [0, 1, 2].map(k =>
        (settingsRef.current.tagSlotAligns?.[k] ?? 'center') as 'left' | 'center' | 'right'
      );
      cur[idx] = align;
      settingsRef.current = { ...settingsRef.current, tagSlotAligns: cur };
      onSettingsChange?.({ tagSlotAligns: cur });
      redraw(cachedImgRef.current);
    }

    function setLogoSlotAlign(idx: number, align: 'left' | 'center' | 'right') {
      const cur = [0, 1, 2].map(k =>
        (settingsRef.current.logoSlotAligns?.[k] ?? 'center') as 'left' | 'center' | 'right'
      );
      cur[idx] = align;
      settingsRef.current = { ...settingsRef.current, logoSlotAligns: cur };
      onSettingsChange?.({ logoSlotAligns: cur });
      redraw(cachedImgRef.current);
    }

    function selectQuote(idx: number, styleId: string) {
      const imgSlot = slotsRef.current[idx];
      if (imgSlot?.type === 'image') URL.revokeObjectURL(imgSlot.url);
      logoImgsRef.current[idx] = null;
      const next = [...slotsRef.current] as (SlotContent | null)[];
      next[idx] = null;
      slotsRef.current = next;
      setSlots(next);
      const curTagSlots   = [...(settingsRef.current.tagSlots   ?? Array(3).fill(null))];
      const curQuoteSlots = [...(settingsRef.current.quoteSlots ?? Array(3).fill(null))];
      curTagSlots[idx]   = null;
      curQuoteSlots[idx] = styleId;
      settingsRef.current = { ...settingsRef.current, tagSlots: curTagSlots, quoteSlots: curQuoteSlots };
      onSettingsChange?.({ tagSlots: curTagSlots, quoteSlots: curQuoteSlots });
    }

    function handleSubSlotFile(idx: number, e: React.ChangeEvent<HTMLInputElement>) {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = '';
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        subImgRefsArr.current[idx] = img;
        const cur = [...(settingsRef.current.dividerSubSlots ?? Array(3).fill(null))] as (DividerSubSlotContent | null)[];
        cur[idx] = { type: 'image', url };
        settingsRef.current = { ...settingsRef.current, dividerSubSlots: cur };
        onSettingsChange?.({ dividerSubSlots: cur });
        redraw(cachedImgRef.current);
      };
      img.src = url;
    }

    function selectSubBrandLogo(idx: number, url?: string) {
      const src = url ?? brandLogoSrc;
      if (!src) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      let applied = false;
      const apply = () => {
        if (applied) return;
        applied = true;
        subImgRefsArr.current[idx] = img;
        const cur = [...(settingsRef.current.dividerSubSlots ?? Array(3).fill(null))] as (DividerSubSlotContent | null)[];
        cur[idx] = { type: 'image', url: src };
        settingsRef.current = { ...settingsRef.current, dividerSubSlots: cur };
        onSettingsChange?.({ dividerSubSlots: cur });
        redraw(cachedImgRef.current);
      };
      img.onload = apply;
      img.src = src;
      if (img.complete && img.naturalWidth > 0) apply();
      setSubSlotFilled(prev => { const n = [...prev]; n[idx] = true; return n; });
    }

    function selectSubTag(idx: number, text: string, style: TagStyle) {
      const cur = [...(settingsRef.current.dividerSubSlots ?? Array(3).fill(null))] as (DividerSubSlotContent | null)[];
      cur[idx] = { type: 'tag', text, style };
      settingsRef.current = { ...settingsRef.current, dividerSubSlots: cur };
      onSettingsChange?.({ dividerSubSlots: cur });
      redraw(cachedImgRef.current);
      setSubSlotFilled(prev => { const n = [...prev]; n[idx] = true; return n; });
    }

    function selectSubSwipe(idx: number, style: SwipeStyle) {
      const cur = [...(settingsRef.current.dividerSubSlots ?? Array(3).fill(null))] as (DividerSubSlotContent | null)[];
      cur[idx] = { type: 'swipe', style };
      settingsRef.current = { ...settingsRef.current, dividerSubSlots: cur };
      onSettingsChange?.({ dividerSubSlots: cur });
      redraw(cachedImgRef.current);
      setSubSlotFilled(prev => { const n = [...prev]; n[idx] = true; return n; });
    }

    function clearSubSlot(idx: number) {
      const sub = settingsRef.current.dividerSubSlots?.[idx];
      if (sub?.type === 'image') URL.revokeObjectURL(sub.url);
      subImgRefsArr.current[idx] = null;
      const cur = [...(settingsRef.current.dividerSubSlots ?? Array(3).fill(null))] as (DividerSubSlotContent | null)[];
      cur[idx] = null;
      settingsRef.current = { ...settingsRef.current, dividerSubSlots: cur };
      onSettingsChange?.({ dividerSubSlots: cur });
      redraw(cachedImgRef.current);
      setSubSlotFilled(prev => { const n = [...prev]; n[idx] = false; return n; });
    }

    // Image load — reset transform + crop + clear bg mask
    useEffect(() => {
      imgOffsetRef.current  = { x: 0, y: 0 };
      imgScaleRef.current   = 1; setImgScale(1);
      imgSrcCropRef.current = null;
      fgMaskImgRef.current  = null;
      fgMaskSrcRef.current  = null;
      setFgMaskSrc(null);
      setBgProcessError(false);
      onSettingsChange?.({ bgBlurEnabled: false });
      if (!imageSrc) { cachedImgRef.current = null; redraw(null); return; }
      const img = cachedEditorImage(imageSrc);
      const apply = () => { cachedImgRef.current = img; redraw(img); runBgRemovalRef.current('split'); };
      // On a cache hit (e.g. re-mount after a Carousel⇄Reels swap) the photo is already decoded, so
      // draw it synchronously — it's on the canvas before the fade-in runs, fading in with everything
      // else instead of popping in a beat later once a fresh Image's onload fires.
      if (img.complete && img.naturalWidth > 0) apply();
      else { img.onload = apply; img.onerror = () => { cachedImgRef.current = null; redraw(null); }; }
    }, [imageSrc, redraw]);   // eslint-disable-line react-hooks/exhaustive-deps

    // Video mode: reset transform on src change + run animation loop for live draw
    useEffect(() => {
      if (!videoSrc) { if (animFrameRef.current !== null) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; } return; }
      imgOffsetRef.current = { x: 0, y: 0 };
      imgScaleRef.current  = 1; setImgScale(1);
      imgSrcCropRef.current = null;
      trimStartRef.current = 0;
      trimEndRef.current   = Infinity;
    }, [videoSrc]);  

    useEffect(() => {
      if (!videoSrc) return;
      let id: number;
      let lastDrawTime = 0;
      const loop = () => {
        const v = videoRef.current;
        if (v && !v.paused) {
          const end = trimEndRef.current === Infinity ? v.duration : trimEndRef.current;
          if (!isNaN(end) && v.currentTime >= end) {
            v.currentTime = trimStartRef.current;
          }
          lastDrawTime = 0; // reset throttle so next paused check draws immediately
          redraw(null);
        } else {
          const now = performance.now();
          if (now - lastDrawTime >= 100) {
            lastDrawTime = now;
            redraw(null);
          }
        }
        id = requestAnimationFrame(loop);
      };
      id = requestAnimationFrame(loop);
      animFrameRef.current = id;
      return () => { cancelAnimationFrame(id); animFrameRef.current = null; };
    }, [videoSrc, redraw]);

    // Pulse animation loop for divider placeholder boxes. Skip entirely in staticMode — static
    // previews (scheduler, remix tiles) must not spin a 60fps repaint loop, and the placeholder
    // isn't drawn there anyway.
    useEffect(() => {
      const hasDivSlots = !staticMode && (settings.dividerSlots ?? []).some(d => d !== null);
      if (!hasDivSlots) {
        if (pulseRafRef.current !== null) { cancelAnimationFrame(pulseRafRef.current); pulseRafRef.current = null; }
        pulseAlphaRef.current = 0.12;
        return;
      }
      let id: number;
      const tick = (t: number) => {
        pulseAlphaRef.current = 0.08 + 0.06 * Math.sin(t / 900 * Math.PI * 2);
        if (!videoModeRef.current) redraw(cachedImgRef.current);
        id = requestAnimationFrame(tick);
      };
      id = requestAnimationFrame(tick);
      pulseRafRef.current = id;
      return () => { cancelAnimationFrame(id); pulseRafRef.current = null; };
    }, [settings.dividerSlots, redraw, staticMode]);

    // Load foreground mask image when mask src changes
    useEffect(() => {
      if (!fgMaskSrc) { fgMaskImgRef.current = null; return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { fgMaskImgRef.current = img; redraw(cachedImgRef.current); };
      img.src = fgMaskSrc;
    }, [fgMaskSrc, redraw]);

    // Circle image loads (separate effects so changing one src doesn't re-trigger the other)
    const [circleSrc0, circleSrc1] = [circleSrcs[0], circleSrcs[1]];
    useEffect(() => {
      if (!circleSrc0) { circleImgRefsArr.current[0] = null; redraw(cachedImgRef.current); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { circleImgRefsArr.current[0] = img; redraw(cachedImgRef.current); };
      img.src = circleSrc0;
    }, [circleSrc0, redraw]);
    useEffect(() => {
      if (!circleSrc1) { circleImgRefsArr.current[1] = null; redraw(cachedImgRef.current); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { circleImgRefsArr.current[1] = img; redraw(cachedImgRef.current); };
      img.src = circleSrc1;
    }, [circleSrc1, redraw]);

    // Font async redraw
    useEffect(() => {
      const f1 = resolveCarouselFont(settings.fontLabel);
      const f2 = resolveCarouselFont(settings.subFontLabel);
      Promise.all([
        ensureFontLoaded(f1, settings.fontWeight, settings.italic),
        ensureFontLoaded(f2, settings.subFontWeight, settings.subItalic),
      ]).then(() => redraw(cachedImgRef.current));
    }, [settings.fontLabel, settings.fontWeight, settings.italic, settings.subFontLabel, settings.subFontWeight, settings.subItalic, redraw]);

    // Redraw when an uploaded font finishes loading (or the custom-font set changes)
    const customFonts = useCustomFonts();
    useEffect(() => { redraw(cachedImgRef.current); }, [customFonts, redraw]);

    // Preload fonts used by free text boxes, then redraw. Loads the secondary (highlight) weight too —
    // otherwise the canvas falls back to the nearest loaded weight and the alternation looks uniform.
    useEffect(() => {
      const boxes = settings.textBoxes ?? [];
      if (!boxes.length) return;
      Promise.all(boxes.flatMap(tb => {
        const f = resolveCarouselFont(tb.fontLabel);
        const loads = [ensureFontLoaded(f, tb.fontWeight, tb.italic)];
        if (tb.secondaryWeight != null) loads.push(ensureFontLoaded(f, tb.secondaryWeight, tb.italic));
        return loads;
      })).then(() => redraw(cachedImgRef.current));
    }, [settings.textBoxes, redraw]);

    // Fill placeholder text boxes with their chosen number of lorem words (alternating primary/secondary
    // weight when a secondary is set). Skips a box being inline-edited; the `changed` guard makes the write
    // a fixed point so it doesn't loop on its own settings update.
    useEffect(() => {
      const boxes = settings.textBoxes ?? [];
      if (!boxes.some(b => b.fillPlaceholder)) return;
      const editingId = editingTextBoxRef.current;
      let changed = false;
      const next = boxes.map((b, i) => {
        if (!b.fillPlaceholder || i === editingId) return b;
        const text = buildFiller(b.placeholderWords ?? 8);
        // Store plain text only — the primary/secondary alternation is applied at render time.
        if (text !== b.text || (b.spans && b.spans.length)) { changed = true; return { ...b, text, spans: undefined }; }
        return b;
      });
      if (changed) {
        settingsRef.current = { ...settingsRef.current, textBoxes: next };
        // Via the ref (not the prop) so this effect doesn't re-run on every parent render — the
        // onSettingsChange prop is a fresh closure each render, which would otherwise re-enter this
        // setState-bearing effect and can spiral into "Maximum update depth exceeded".
        onSettingsChangeRef.current?.({ textBoxes: next });
      }
    }, [settings.textBoxes, editingTextBox]);

    // Sync redraw on any settings change — but NOT mid-drag. During an element/text drag the handler
    // already repaints every frame via its own redraw() (using the live settingsRef), so re-entering
    // the (setState-bearing) drawCanvas here on each per-frame settings update is pure redundant work
    // that, frame after frame, pumps React's nested-update counter into "Maximum update depth exceeded"
    // — exactly the settings-keyed-effect-calls-setState spiral the onSettingsChangeRef note above warns
    // about. The drag's own redraw keeps the canvas current; this effect resumes on the next settle.
    useEffect(() => {
      if (isDraggingElementRef.current || textDragRef.current) return;
      drawCanvas(cachedImgRef.current, imgOffsetRef.current.x, imgOffsetRef.current.y, imgScaleRef.current, settings);
    }, [drawCanvas, settings]);

    // Redraw when the display-time data fill changes (mapping a placeholder/chart input in automations).
    useEffect(() => {
      if (!displayValues && !displayElementData) return;
      if (isDraggingElementRef.current || textDragRef.current) return;
      drawCanvas(cachedImgRef.current, imgOffsetRef.current.x, imgOffsetRef.current.y, imgScaleRef.current, settingsRef.current);
    }, [drawCanvas, displayValues, displayElementData]);

    // (Background scroll-wheel zoom removed — the background stays at its set scale; reposition by dragging.)

    // Drag
    useEffect(() => {
      function onMove(e: MouseEvent) {
        if (!isDragging) return;
        const dx = (e.clientX - dragStartRef.current.mx) / DISPLAY_SCALE;
        const dy = (e.clientY - dragStartRef.current.my) / DISPLAY_SCALE;
        imgOffsetRef.current = { x: dragStartRef.current.ox + dx, y: dragStartRef.current.oy + dy };
        redraw(cachedImgRef.current);
      }
      function onUp() { setIsDragging(false); }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    }, [isDragging, redraw]);

    // Circle drag (handles whichever circle is active)
    // Circle drag wired synchronously in the circle element's onMouseDown (see render) — releases on mouse-up.

    // Free text box drag — wired synchronously in the text box onMouseDown (see render) so it
    // releases on mouse-up; moves the active box and snaps edges + centre to canvas guides.

    // Free text box resize — wired synchronously in the resize-handle onMouseDown (see render) so
    // it releases on mouse-up; drag a handle to resize the frame (text rewraps).

    // Free text box keyboard — Delete/Backspace removes, arrows nudge (Shift = 10px), Escape deselects
    useEffect(() => {
      if (selectedTextBox === null) return;
      const idx = selectedTextBox;
      function onKey(e: KeyboardEvent) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.key === 'Escape') { setSelectedTextBox(null); return; }
        if ((settingsRef.current.textBoxes ?? [])[idx]?.locked) return;   // locked: no delete/move
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          const cur = [...(settingsRef.current.textBoxes ?? [])];
          if (!cur[idx]) return;
          cur.splice(idx, 1);
          settingsRef.current = { ...settingsRef.current, textBoxes: cur };
          onSettingsChange?.({ textBoxes: cur });
          setSelectedTextBox(null);
          redraw(cachedImgRef.current);
          return;
        }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const cur = [...(settingsRef.current.textBoxes ?? [])];
        const tb = cur[idx];
        if (!tb || tb.locked) return;
        let nx = tb.x, ny = tb.y;
        if (e.key === 'ArrowLeft')  nx -= step;
        if (e.key === 'ArrowRight') nx += step;
        if (e.key === 'ArrowUp')    ny -= step;
        if (e.key === 'ArrowDown')  ny += step;
        cur[idx] = { ...tb, x: Math.max(0, Math.min(W, nx)), y: Math.max(0, Math.min(H, ny)) };
        settingsRef.current = { ...settingsRef.current, textBoxes: cur };
        onSettingsChange?.({ textBoxes: cur });
        redraw(cachedImgRef.current);
      }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [selectedTextBox, redraw, onSettingsChange]);

    // Option/Alt while a text or image box is selected → show edge-to-canvas spacing measurements
    useEffect(() => {
      if (selectedTextBox === null && selectedImageBox === null) { setAltHeld(false); return; }
      function sync(e: KeyboardEvent) { setAltHeld(e.altKey); }
      function clear() { setAltHeld(false); }
      window.addEventListener('keydown', sync);
      window.addEventListener('keyup', sync);
      window.addEventListener('blur', clear);
      return () => {
        window.removeEventListener('keydown', sync);
        window.removeEventListener('keyup', sync);
        window.removeEventListener('blur', clear);
      };
    }, [selectedTextBox, selectedImageBox]);

    // ── Image boxes: load sources (redraw on load) ──────────────────────────────
    useEffect(() => {
      const boxes = settings.imageBoxes ?? [];
      // Evict cached source images + cut-outs for urls no longer referenced (e.g. after an
      // expand/replace or a box delete) so the caches don't grow unbounded over a session.
      const liveUrls = new Set(boxes.map(b => b.url));
      for (const url of [...imageBoxImgsRef.current.keys()])   if (!liveUrls.has(url)) imageBoxImgsRef.current.delete(url);
      for (const url of [...imageBoxFgImgsRef.current.keys()]) if (!liveUrls.has(url)) imageBoxFgImgsRef.current.delete(url);
      let pending = false;
      for (const b of boxes) {
        if (b.videoUrl) continue;   // video boxes render from a <video>, not the image cache
        if (!imageBoxImgsRef.current.has(b.url)) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { setImageBoxSrcTick(t => t + 1); redraw(cachedImgRef.current); };   // tick re-runs the split compute for boxes waiting on this source
          img.onerror = () => {
            // Drop the broken entry so a later settings change can retry the load.
            console.warn('[imageBox] image failed to load (CORS or stale URL?):', b.url);
            imageBoxImgsRef.current.delete(b.url);
          };
          img.src = b.url;
          imageBoxImgsRef.current.set(b.url, img);
          pending = true;
        }
      }
      if (pending) redraw(cachedImgRef.current);
    }, [settings.imageBoxes, redraw]);

    // ── Image boxes: subject split — load/compute the cut-out per split-enabled box ──
    // For each box with splitEnabled: load its persisted cut-out (fgUrl) if present,
    // else run removeBackground once on the source image, cache it, persist the PNG to
    // storage (via onUploadImage → box.fgUrl), and redraw. Cut-outs are keyed by the
    // source url so identical sources share one model run; guards dedupe in-flight work.
    useEffect(() => {
      const boxes = settings.imageBoxes ?? [];
      for (const b of boxes) {
        if (!b.splitEnabled) continue;
        const key = b.url;
        if (imageBoxFgImgsRef.current.has(key) || imageBoxFgPendingRef.current.has(key)) continue;

        // Persisted cut-out → load directly, no model run.
        if (b.fgUrl) {
          imageBoxFgPendingRef.current.add(key);
          const fimg = new Image();
          fimg.crossOrigin = 'anonymous';
          const p = new Promise<void>(resolve => {
            fimg.onload = () => {
              imageBoxFgImgsRef.current.set(key, fimg);
              imageBoxFgPendingRef.current.delete(key);
              imageBoxFgPromisesRef.current.delete(key);
              redraw(cachedImgRef.current);
              resolve();
            };
            fimg.onerror = () => {
              // Stale/404 fgUrl — drop the guard so a later pass recomputes from source.
              imageBoxFgPendingRef.current.delete(key);
              imageBoxFgPromisesRef.current.delete(key);
              resolve();
            };
          });
          imageBoxFgPromisesRef.current.set(key, p);
          fimg.src = b.fgUrl;
          continue;
        }

        // No cut-out yet — need the source image loaded before we can compute.
        const srcImg = imageBoxImgsRef.current.get(b.url);
        if (!srcImg || !srcImg.complete || !srcImg.naturalWidth) continue;   // retry on a later pass
        const boxId = b.id;
        imageBoxFgPendingRef.current.add(key);
        const p = (async () => {
          setImageBoxBgStatus(prev => ({ ...prev, [boxId]: 'processing' }));
          try {
            const pngBlob = await removeBackgroundBlob(srcImg);
            const objUrl  = URL.createObjectURL(pngBlob);
            const fimg = new Image();
            fimg.crossOrigin = 'anonymous';
            await new Promise<void>((res, rej) => { fimg.onload = () => res(); fimg.onerror = () => rej(new Error('cut-out load failed')); fimg.src = objUrl; });
            imageBoxFgImgsRef.current.set(key, fimg);
            redraw(cachedImgRef.current);
            setImageBoxBgStatus(prev => { const n = { ...prev }; delete n[boxId]; return n; });
            // Persist the cut-out so it survives reload/export without re-running the model.
            const publicUrl = await onUploadImageRef.current?.(pngBlob, `cutout-${boxId}.png`);
            if (publicUrl) {
              const cur = [...(settingsRef.current.imageBoxes ?? [])];
              const idx = cur.findIndex(x => x.id === boxId);
              // Persist only if the box still shows the source this run computed from: a drag-replace
              // (replaceBoxMedia) keeps the box id but swaps its url mid-run, and writing the OLD
              // source's cut-out onto it would composite the old subject over the new photo — and
              // persist that (or clobber the new url's own fresh cut-out if this run finishes last).
              if (idx >= 0 && cur[idx].url === key) {
                cur[idx] = { ...cur[idx], fgUrl: publicUrl };
                settingsRef.current = { ...settingsRef.current, imageBoxes: cur };
                onSettingsChangeRef.current?.({ imageBoxes: cur });
              }
            }
          } catch (err) {
            console.error('[imageBox split] removeBackground failed:', err);
            setImageBoxBgStatus(prev => ({ ...prev, [boxId]: 'error' }));
          } finally {
            imageBoxFgPendingRef.current.delete(key);
            imageBoxFgPromisesRef.current.delete(key);
          }
        })();
        imageBoxFgPromisesRef.current.set(key, p);
      }
    }, [settings.imageBoxes, imageBoxSrcTick, redraw]);

    // Image box drag — move; reuses the text-box snap guides
    // NOTE: image-box dragging is wired synchronously inside each frame's onMouseDown (see the
    // image box frames in the render below) — NOT from a state-driven effect here. Binding the
    // window mousemove/mouseup at mousedown guarantees the release is caught; an effect keyed on
    // activeDragImageBox binds a render too late and can drop a quick mouseup, leaving the box
    // stuck to the cursor until the next click.

    // Image box resize — wired synchronously in the corner-handle onMouseDown (see render) so it
    // releases on mouse-up; 8 handles, aspect kept when the panel lock is on or Shift is held.

    // Image box crop — wired synchronously in the centre-edge-handle onMouseDown (see render) so
    // it releases on mouse-up; drags the box edge over a fixed-scale image (always changes aspect).

    // Image box keyboard — Delete/Backspace removes, arrows nudge (Shift = 10px), Escape deselects
    useEffect(() => {
      if (selectedImageBox === null) return;
      const idx = selectedImageBox;
      function onKey(e: KeyboardEvent) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.key === 'Escape') { setSelectedImageBox(null); return; }
        if ((settingsRef.current.imageBoxes ?? [])[idx]?.locked) return;   // locked: no delete/move
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          const cur = [...(settingsRef.current.imageBoxes ?? [])];
          if (!cur[idx]) return;
          cur.splice(idx, 1);
          settingsRef.current = { ...settingsRef.current, imageBoxes: cur };
          onSettingsChange?.({ imageBoxes: cur });
          setSelectedImageBox(null);
          redraw(cachedImgRef.current);
          return;
        }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const cur = [...(settingsRef.current.imageBoxes ?? [])];
        const b = cur[idx];
        if (!b) return;
        let nx = b.x, ny = b.y;
        if (e.key === 'ArrowLeft')  nx -= step;
        if (e.key === 'ArrowRight') nx += step;
        if (e.key === 'ArrowUp')    ny -= step;
        if (e.key === 'ArrowDown')  ny += step;
        cur[idx] = { ...b, x: Math.max(0, Math.min(W, nx)), y: Math.max(0, Math.min(H, ny)) };
        settingsRef.current = { ...settingsRef.current, imageBoxes: cur };
        onSettingsChange?.({ imageBoxes: cur });
        redraw(cachedImgRef.current);
      }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [selectedImageBox, redraw, onSettingsChange]);

    // Free element keyboard (tag / quote / swipe / logo / divider / custom) — Delete/Backspace removes,
    // arrows nudge (Shift = 10px), Escape deselects. Mirrors the image-box keyboard handler above.
    useEffect(() => {
      if (selectedFreeEl === null) return;
      const idx = selectedFreeEl;
      function onKey(e: KeyboardEvent) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.key === 'Escape') { setSelectedFreeEl(null); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          removeFreeElement(idx);
          return;
        }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const cur = [...(settingsRef.current.freeElements ?? [])];
        const el = cur[idx];
        if (!el) return;
        let nx = el.x, ny = el.y;
        if (e.key === 'ArrowLeft')  nx -= step;
        if (e.key === 'ArrowRight') nx += step;
        if (e.key === 'ArrowUp')    ny -= step;
        if (e.key === 'ArrowDown')  ny += step;
        cur[idx] = { ...el, x: Math.max(-el.width / 2, Math.min(W - el.width / 2, nx)), y: Math.max(-el.height / 2, Math.min(H - el.height / 2, ny)) };
        settingsRef.current = { ...settingsRef.current, freeElements: cur };
        onSettingsChange?.({ freeElements: cur });
        redraw(cachedImgRef.current);
      }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [selectedFreeEl, redraw, onSettingsChange]);

    // Create an image box from a dropped Uploads image (probe aspect, centre on drop point)
    const addImageBox = useCallback((url: string, cxCanvas: number, cyCanvas: number) => {
      const finalize = (aspect: number) => {
        const a = aspect || 1;
        const w = Math.round(Math.min(450, W * 0.6));
        const h = Math.max(20, w / a);  // full precision so width/height === native aspect exactly
        const x = Math.round(Math.max(0, Math.min(W - w, cxCanvas - w / 2)));
        const y = Math.round(Math.max(0, Math.min(H - h, cyCanvas - h / 2)));
        const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : `ib-${Math.floor(Math.random() * 1e9).toString(36)}`;
        const box = { id, url, x, y, width: w, height: h, opacity: 100, cornerRadius: 0, aspect: a };
        const cur = [...(settingsRef.current.imageBoxes ?? []), box];
        settingsRef.current = { ...settingsRef.current, imageBoxes: cur };
        onSettingsChange?.({ imageBoxes: cur });
        selectImageBoxOnly(cur.length - 1);
        redraw(cachedImgRef.current);
      };
      const cached = imageBoxImgsRef.current.get(url);
      if (cached && cached.complete && cached.naturalWidth) { finalize(cached.naturalWidth / cached.naturalHeight); return; }
      const probe = new Image();
      probe.crossOrigin = 'anonymous';
      probe.onload = () => { imageBoxImgsRef.current.set(url, probe); finalize(probe.naturalWidth / probe.naturalHeight || 1); };
      probe.onerror = () => console.warn('[imageBox] dropped image failed to load (CORS or bad URL?):', url);
      probe.src = url;
    }, [redraw, onSettingsChange]);

    // Create a VIDEO box from a dropped Uploads video — same as addImageBox, but the box renders the
    // video (videoUrl) instead of a static image. Aspect is probed from the file's intrinsic dimensions.
    const addVideoBox = useCallback((url: string, cxCanvas: number, cyCanvas: number) => {
      const finalize = (aspect: number) => {
        const a = aspect || (W / H);
        const w = Math.round(Math.min(450, W * 0.6));
        const h = Math.max(20, Math.round(w / a));
        const x = Math.round(Math.max(0, Math.min(W - w, cxCanvas - w / 2)));
        const y = Math.round(Math.max(0, Math.min(H - h, cyCanvas - h / 2)));
        const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID() : `vb-${Math.floor(Math.random() * 1e9).toString(36)}`;
        const box: ImageBox = { id, url, videoUrl: url, x, y, width: w, height: h, opacity: 100, cornerRadius: 0, aspect: a };
        const cur = [...(settingsRef.current.imageBoxes ?? []), box];
        settingsRef.current = { ...settingsRef.current, imageBoxes: cur };
        onSettingsChange?.({ imageBoxes: cur });
        selectImageBoxOnly(cur.length - 1);
        redraw(cachedImgRef.current);
      };
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.crossOrigin = 'anonymous';
      probe.onloadedmetadata = () => finalize(probe.videoWidth / probe.videoHeight || (W / H));
      probe.onerror = () => { console.warn('[videoBox] probe failed to load (CORS or bad URL?):', url); finalize(W / H); };
      probe.src = url;
    }, [redraw, onSettingsChange]);

    // Replace an existing box's media in place (a matching tray item dropped ONTO its frame). The
    // frame is kept — position/size, styling (radius/shadow/fades/blend/effects), lock/hidden, and
    // the layer order (same id) — while everything derived from the OLD source pixels resets:
    // crop/circleCrop (fractions of the old source rect), aspect (re-probed from the new file so
    // aspect-locked resizing tracks the new native ratio), and the split cut-out. Clearing fgUrl is
    // what makes split re-run: the per-source caches and the split effect key on box.url, so a new
    // url with no fgUrl triggers a fresh removeBackground pass (splitEnabled itself is kept).
    // Kind matching (image payload → image box, video payload → video box) is enforced by the
    // frame's dragover/drop gates, not here.
    const replaceBoxMedia = useCallback((idx: number, url: string, kind: 'image' | 'video') => {
      // Pin the target by id NOW: the aspect probe below is async, and imageBoxes can shift while
      // it loads (deleting an earlier box renumbers the rest), so an index captured at drop time
      // could land on a NEIGHBOUR by the time finalize runs. Re-resolving by id keeps the swap on
      // the box that was actually dropped on — or drops it if that box is gone.
      const targetId = settingsRef.current.imageBoxes?.[idx]?.id;
      if (!targetId) return;
      const finalize = (aspect: number) => {
        const cur = [...(settingsRef.current.imageBoxes ?? [])];
        const at = cur.findIndex(bx => bx.id === targetId);
        if (at < 0) return;   // box deleted while the probe was loading
        const b = cur[at];
        cur[at] = {
          ...b, url,
          aspect: aspect || undefined,   // unknown → resize falls back to width/height ratio
          crop: undefined, circleCrop: undefined, fgUrl: undefined,
          ...(kind === 'video' ? { videoUrl: url } : {}),
        };
        settingsRef.current = { ...settingsRef.current, imageBoxes: cur };
        onSettingsChange?.({ imageBoxes: cur });
        selectImageBoxOnly(at);
        redraw(cachedImgRef.current);
      };
      if (kind === 'video') {
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.crossOrigin = 'anonymous';
        probe.onloadedmetadata = () => finalize(probe.videoWidth / probe.videoHeight || (W / H));
        probe.onerror = () => { console.warn('[videoBox] replace probe failed to load (CORS or bad URL?):', url); finalize(W / H); };
        probe.src = url;
        return;
      }
      const cached = imageBoxImgsRef.current.get(url);
      if (cached && cached.complete && cached.naturalWidth) { finalize(cached.naturalWidth / cached.naturalHeight); return; }
      const probe = new Image();
      probe.crossOrigin = 'anonymous';
      probe.onload = () => { imageBoxImgsRef.current.set(url, probe); finalize(probe.naturalWidth / probe.naturalHeight || 1); };
      probe.onerror = () => console.warn('[imageBox] replacement image failed to load (CORS or bad URL?):', url);
      probe.src = url;
    }, [redraw, onSettingsChange]);

    // ── Video boxes: one <video> per source, drawn frame-by-frame. Keyed by videoUrl so shared sources
    //    reuse one element. Created PAUSED + muted (first frame); the on-canvas play button plays one with sound.
    useEffect(() => {
      const boxes = settings.imageBoxes ?? [];
      const liveVideoUrls = new Set(boxes.filter(b => b.videoUrl).map(b => b.videoUrl!));
      for (const [url, el] of [...videoBoxElsRef.current.entries()]) {
        if (!liveVideoUrls.has(url)) { el.pause(); el.removeAttribute('src'); el.load(); videoBoxElsRef.current.delete(url); }
      }
      setPlayingVideoUrl(prev => (prev && !liveVideoUrls.has(prev)) ? null : prev);
      for (const b of boxes) {
        if (!b.videoUrl || videoBoxElsRef.current.has(b.videoUrl)) continue;
        const el = document.createElement('video');
        el.crossOrigin = 'anonymous';
        el.loop = true;
        el.playsInline = true;
        el.muted = true;          // muted until the user presses play (then it plays with sound)
        el.preload = 'auto';
        el.onloadeddata = () => redraw(cachedImgRef.current);
        el.src = b.videoUrl;
        videoBoxElsRef.current.set(b.videoUrl, el);
      }
    }, [settings.imageBoxes, redraw]);

    // Drive a rAF redraw only while a video is actually playing, so its frames animate on the canvas.
    useEffect(() => {
      if (!playingVideoUrl) return;
      let raf = 0;
      const tick = () => { redraw(cachedImgRef.current); raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [playingVideoUrl, redraw]);

    // Play one video box with sound (pausing/muting any other), or pause it if it's the one playing.
    const toggleVideoPlay = useCallback((videoUrl: string) => {
      const el = videoBoxElsRef.current.get(videoUrl);
      if (!el) return;
      setPlayingVideoUrl(prev => {
        if (prev === videoUrl) { el.pause(); return null; }
        for (const [u, other] of videoBoxElsRef.current) { if (u !== videoUrl) { other.pause(); other.muted = true; } }
        el.muted = false;
        el.play().catch(() => {});
        return videoUrl;
      });
    }, []);

    // Release all video elements on unmount (stop playback + downloads).
    useEffect(() => {
      const els = videoBoxElsRef.current;
      return () => { for (const el of els.values()) { el.pause(); el.removeAttribute('src'); el.load(); } els.clear(); };
    }, []);

    // Paste the clipboard layer into the current canvas (a fresh id, placed on top, selected). Works across
    // slides/templates since the clipboard is a module singleton. Overlays keep their full-canvas position;
    // other layers nudge slightly so a same-canvas paste is visibly distinct from the original.
    const pasteLayer = useCallback(() => {
      if (!layerClipboard) return;
      const s = settingsRef.current;
      const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID() : `pl-${Math.floor(Math.random() * 1e9).toString(36)}`;
      const fadeOn = !!(s.showFade || s.showTopFade);
      const order  = orderedLayerIds(s.imageBoxes ?? [], s.textBoxes ?? [], s.freeElements ?? [], s.layerOrderIds, fadeOn, false, s.zoneLogoSlots, { tagSlots: s.tagSlots, quoteSlots: s.quoteSlots, tagZoneSlots: s.tagZoneSlots, quoteZoneSlots: s.quoteZoneSlots, swipeZoneSlots: s.swipeZoneSlots }).map(x => x.id);
      const clip = layerClipboard;
      // Paste at the exact same location (a fresh id keeps it a distinct layer).
      const box = { ...JSON.parse(JSON.stringify(clip.box)), id: newId() };
      if (clip.kind === 'text') {
        const textBoxes = [...(s.textBoxes ?? []), box as TextBoxStyle];
        const layerOrderIds = [...order, box.id];
        settingsRef.current = { ...s, textBoxes, layerOrderIds };
        onSettingsChange?.({ textBoxes, layerOrderIds });
        selectTextBoxOnly(textBoxes.length - 1);
      } else {
        const imageBoxes = [...(s.imageBoxes ?? []), box as ImageBox];
        const layerOrderIds = [...order, box.id];
        settingsRef.current = { ...s, imageBoxes, layerOrderIds };
        onSettingsChange?.({ imageBoxes, layerOrderIds });
        selectImageBoxOnly(imageBoxes.length - 1);
      }
      redraw(cachedImgRef.current);
    }, [onSettingsChange, redraw]);

    // Copy (⌘/Ctrl+C) the selected layer to the clipboard; paste it back into the current canvas.
    // Copy stays a keydown (it needs no clipboard payload), but paste listens to the window 'paste'
    // EVENT: only a paste event exposes the OS clipboard's files, and pasted media files must win
    // over the internal layer clipboard (see clipboardEventHasMediaFile) — a keydown handler cannot
    // tell the two apart. Both ignore typing contexts (inline text edit / inputs) so normal text
    // copy/paste still works.
    useEffect(() => {
      // Static previews (scheduler, remix tiles) must not bind the global copy/paste listeners —
      // layerClipboard is module-scoped, so a paste on the real editor would otherwise also fire
      // pasteLayer() on every mounted preview instance, corrupting all of them.
      if (staticMode) return;
      const typingNow = () => {
        const el = document.activeElement as HTMLElement | null;
        return editingTextBoxRef.current != null
          || (!!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
      };
      function onKey(e: KeyboardEvent) {
        if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
        if (e.key.toLowerCase() !== 'c') return;
        if (typingNow()) return;
        const s = settingsRef.current;
        if (selectedTextBox != null && s.textBoxes?.[selectedTextBox]) {
          layerClipboard = { kind: 'text', box: JSON.parse(JSON.stringify(s.textBoxes[selectedTextBox])) };
          e.preventDefault();
        } else if (selectedImageBox != null && s.imageBoxes?.[selectedImageBox]) {
          layerClipboard = { kind: 'image', box: JSON.parse(JSON.stringify(s.imageBoxes[selectedImageBox])) };
          e.preventDefault();
        }
      }
      function onPaste(e: ClipboardEvent) {
        if (typingNow()) return;
        // Clipboard files → the Grid's media paste owns this ⌘/Ctrl+V. But only defer where media
        // is actually allowed: in templates mode (allowImages false) no media-paste listener is
        // bound, so bailing there would leave ⌘/Ctrl+V dead for layer paste whenever the OS
        // clipboard happens to hold an image (e.g. an old screenshot).
        if (allowImages && clipboardEventHasMediaFile(e)) return;
        if (!layerClipboard) return;
        e.preventDefault();
        pasteLayer();
      }
      window.addEventListener('keydown', onKey);
      window.addEventListener('paste', onPaste);
      return () => {
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('paste', onPaste);
      };
    }, [selectedTextBox, selectedImageBox, pasteLayer, staticMode, allowImages]);


    // Circle resize / image pan / zoom — all wired synchronously in their respective onMouseDown
    // handlers (the resize handle, the circle element in edit mode, and the zoom handle; see
    // render) so each releases on mouse-up.

    // Circle image wheel zoom — attach to each circle element
    useEffect(() => {
      const els = [circleEl0Ref.current, circleEl1Ref.current];
      const cleanups: (() => void)[] = [];
      els.forEach((el, idx) => {
        if (!el || !circleSrcs[idx]) return;
        function onWheel(e: WheelEvent) {
          e.preventDefault(); e.stopPropagation();
          const next = Math.max(0.5, Math.min(10, circleImgScalesArr.current[idx] * (1 + (-e.deltaY) * 0.005)));
          circleImgScalesArr.current[idx] = next;
          redraw(cachedImgRef.current);
        }
        el.addEventListener('wheel', onWheel, { passive: false });
        cleanups.push(() => el.removeEventListener('wheel', onWheel));
      });
      return () => cleanups.forEach(c => c());
    }, [circleSrcs, redraw]);

    // Escape exits circle image edit mode
    useEffect(() => {
      if (!circleImgEditModes.some(Boolean)) return;
      function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') setCircleImgEditModes([false, false]);
      }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [circleImgEditModes]);

    // Escape exits crop mode and restores pre-entry state
    useEffect(() => {
      if (!isCropMode) return;
      function onKey(e: KeyboardEvent) {
        if (e.key !== 'Escape') return;
        const saved = cropEntryStateRef.current;
        if (saved) {
          imgSrcCropRef.current = saved.crop;
          imgOffsetRef.current  = { x: saved.ox, y: saved.oy };
          imgScaleRef.current   = saved.sc;
          setImgScale(saved.sc);
          onScaleChange?.(saved.sc);
          redraw(cachedImgRef.current);
          cropEntryStateRef.current = null;
        }
        setIsCropMode(false);
      }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [isCropMode, redraw, onScaleChange]);

    // Redraw overlay whenever cropRect changes (e.g. snap to 4:5, reset)
    useEffect(() => { if (isCropMode) drawCropOverlay(cropRect); }, [cropRect, isCropMode, drawCropOverlay]);
    // Draw overlay on enter; clear on exit
    useEffect(() => {
      if (isCropMode) { drawCropOverlay(cropRectRef.current); }
      else { cropOverlayRef.current?.getContext('2d')?.clearRect(0, 0, CAROUSEL_PREVIEW_W, CAROUSEL_PREVIEW_H); }
    }, [isCropMode, drawCropOverlay]);

    // Crop handle drag
    useEffect(() => {
      if (!isCropMode) return;
      const MIN = 40, PW = CAROUSEL_PREVIEW_W, PH = CAROUSEL_PREVIEW_H;
      const AR  = 4 / 5; // width / height for 4:5

      function computeRect(
        handle: string, dx: number, dy: number,
        s: { x: number; y: number; w: number; h: number },
        lock: 'free' | '4:5',
      ) {
        let { x, y, w, h } = s;
        const clW = (v: number) => Math.min(Math.max(v, MIN), PW);
        const clH = (v: number) => Math.min(Math.max(v, MIN), PH);
        switch (handle) {
          case 'se': w = clW(s.w + dx); h = lock === '4:5' ? w / AR : clH(s.h + dy); break;
          case 'sw': w = clW(s.w - dx); x = s.x + s.w - w; h = lock === '4:5' ? w / AR : clH(s.h + dy); break;
          case 'ne': w = clW(s.w + dx); h = lock === '4:5' ? w / AR : clH(s.h - dy); y = s.y + s.h - h; break;
          case 'nw': w = clW(s.w - dx); x = s.x + s.w - w; h = lock === '4:5' ? w / AR : clH(s.h - dy); y = s.y + s.h - h; break;
          case 'e':  w = clW(s.w + dx); if (lock === '4:5') { h = w / AR; y = s.y + (s.h - h) / 2; } break;
          case 'w':  w = clW(s.w - dx); x = s.x + s.w - w; if (lock === '4:5') { h = w / AR; y = s.y + (s.h - h) / 2; } break;
          case 's':  h = clH(s.h + dy); if (lock === '4:5') { w = h * AR; x = s.x + (s.w - w) / 2; } break;
          case 'n':  h = clH(s.h - dy); y = s.y + s.h - h; if (lock === '4:5') { w = h * AR; x = s.x + (s.w - w) / 2; } break;
        }
        // Clamp to canvas bounds
        if (x < 0) { w += x; x = 0; }
        if (y < 0) { h += y; y = 0; }
        if (x + w > PW) w = PW - x;
        if (y + h > PH) h = PH - y;
        return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      }

      function onMove(e: MouseEvent) {
        if (!cropActiveHandle.current) return;
        const dx = e.clientX - cropDragStart.current.mx;
        const dy = e.clientY - cropDragStart.current.my;
        const nr = computeRect(cropActiveHandle.current, dx, dy, cropDragStart.current.rect, cropLockRef.current);
        cropRectRef.current = nr;
        setCropRect(nr);
        drawCropOverlay(nr);
      }
      function onUp() { cropActiveHandle.current = null; }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    }, [isCropMode, drawCropOverlay]);

    const runBgRemovalRef = useRef<(mode: 'split' | 'blur') => void>(() => {});
    async function runBgRemoval(mode: 'split' | 'blur' = 'split') {
      const img = cachedImgRef.current;
      if (!img || isBgProcessing) return;
      // If mask already exists, just switch mode
      if (fgMaskSrcRef.current) {
        const cur = settingsRef.current;
        if (mode === 'split') {
          onSettingsChange?.({ bgBlurEnabled: !(cur.bgBlurEnabled && cur.bgBlurAmount === 0), bgBlurAmount: 0 });
        } else {
          const newEnabled = !(cur.bgBlurEnabled && cur.bgBlurAmount > 0);
          onSettingsChange?.({ bgBlurEnabled: newEnabled, bgBlurAmount: newEnabled ? (cur.bgBlurAmount > 0 ? cur.bgBlurAmount : 10) : 0 });
        }
        return;
      }
      setIsBgProcessing(true);
      setBgProcessError(false);
      try {
        const blob = await removeBackgroundBlob(img);
        const url = URL.createObjectURL(blob);
        fgMaskSrcRef.current = url;
        setFgMaskSrc(url);
        // Default to split (0 blur); blur mode activates only when explicitly requested
        onSettingsChange?.({ bgBlurEnabled: true, bgBlurAmount: mode === 'blur' ? (settingsRef.current.bgBlurAmount > 0 ? settingsRef.current.bgBlurAmount : 10) : 0 });
      } catch (err) {
        console.error('[BG Blur] removeBackground failed:', err);
        setBgProcessError(true);
      } finally {
        setIsBgProcessing(false);
      }
    }
    runBgRemovalRef.current = runBgRemoval;

    const startVideoExportRef = useRef<() => Promise<void>>(async () => {});
    const startVideoBoxExportRef = useRef<() => Promise<void>>(async () => {});

    async function startVideoExport(): Promise<void> {
      const srcUrl = videoSrcRef.current;
      if (!srcUrl || isVideoExporting) return;

      const abortController = new AbortController();
      videoExportAbortRef.current = abortController;
      const signal = abortController.signal;

      const emit = (progress: number, status: string) => {
        setVideoExportProgress(progress);
        setVideoExportStatus(status);
        onRecordingStateChangeRef.current?.({ isRecording: true, recProgress: progress, recStatus: status });
      };

      setIsVideoExporting(true);
      emit(0, 'Initializing...');

      try {
        // @ts-expect-error -- mp4box ships no usable type declarations
        const MP4BoxLib = (await import('mp4box')).default;
        const mediabunny = await import('mediabunny');
        const {
          Output, Mp4OutputFormat, BufferTarget, VideoSample, VideoSampleSource,
          Input, BlobSource, ALL_FORMATS, QUALITY_HIGH, EncodedAudioPacketSource, EncodedPacketSink,
        } = mediabunny;

        const EXPORT_FPS = 30;
        const EXPORT_FRAME_DURATION = 1 / EXPORT_FPS;

        emit(0, 'Downloading video...');
        const response = await fetch(srcUrl, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();

        if (signal.aborted) throw new Error('Cancelled');

        emit(0.05, 'Parsing video...');
        const MP4BoxFile = MP4BoxLib.createFile();
        const videoSamples: Array<{ data: Uint8Array; timestamp: number; duration: number; isKeyframe: boolean }> = [];
        const audioSamples: Array<{ data: Uint8Array; timestamp: number; duration: number }> = [];
        let videoTrackId: number | null = null;
        let audioTrackId: number | null = null;
        let videoTimescale = 90000;
        let audioTimescale = 44100;

        MP4BoxFile.onReady = (info: { tracks?: Array<{ id: number; type: string; timescale?: number }> }) => {
          for (const track of info.tracks || []) {
            if (track.type === 'video' && !videoTrackId) { videoTrackId = track.id; videoTimescale = track.timescale || 90000; }
            if (track.type === 'audio' && !audioTrackId) { audioTrackId = track.id; audioTimescale = track.timescale || 44100; }
          }
          if (videoTrackId) MP4BoxFile.setExtractionOptions(videoTrackId, null, { nbSamples: Infinity });
          if (audioTrackId) MP4BoxFile.setExtractionOptions(audioTrackId, null, { nbSamples: Infinity });
          MP4BoxFile.start();
        };
        MP4BoxFile.onSamples = (id: number, _user: unknown, samples: Array<{ data: ArrayBuffer; cts: number; duration: number; is_sync: boolean }>) => {
          if (id === videoTrackId) {
            for (const s of samples) videoSamples.push({ data: new Uint8Array(s.data), timestamp: s.cts / videoTimescale, duration: s.duration / videoTimescale, isKeyframe: s.is_sync });
          }
          if (id === audioTrackId) {
            for (const s of samples) audioSamples.push({ data: new Uint8Array(s.data), timestamp: s.cts / audioTimescale, duration: s.duration / audioTimescale });
          }
        };
        MP4BoxFile.onError = (e: unknown) => console.error('[MP4Box carousel]', e);

        const copy = arrayBuffer.slice(0);
        // @ts-expect-error -- mp4box ships no usable type declarations
        copy.fileStart = 0;
        MP4BoxFile.appendBuffer(copy);
        MP4BoxFile.flush();

        await new Promise<void>((resolve, reject) => {
          const t = Date.now();
          const id = setInterval(() => {
            if (videoSamples.length > 0) { clearInterval(id); resolve(); }
            else if (Date.now() - t > 10000) { clearInterval(id); reject(new Error('Timeout extracting video samples')); }
          }, 100);
        });

        if (videoSamples.length === 0) throw new Error('No video samples found');

        const lastSample = videoSamples[videoSamples.length - 1];
        const fullDuration = lastSample.timestamp + lastSample.duration;
        const clipStart = trimStartRef.current;
        const clipEnd = trimEndRef.current > 0 && trimEndRef.current <= fullDuration ? trimEndRef.current : fullDuration;
        const clipDuration = Math.max(0.1, clipEnd - clipStart);
        const totalFrames = Math.floor(clipDuration * EXPORT_FPS);

        emit(0.1, 'Decoding video...');

        const decodedFrames: Array<{ frame: VideoFrame; timestamp: number }> = [];
        const decoder = new VideoDecoder({
          output: (frame: VideoFrame) => { decodedFrames.push({ frame, timestamp: frame.timestamp / 1_000_000 }); },
          error: (e: Error) => console.error('[VideoDecoder carousel]', e),
        });

        let description: Uint8Array | undefined;
        if (typeof MP4BoxFile.getSampleDescription === 'function') {
          const descs = MP4BoxFile.getSampleDescription(videoTrackId);
          if (descs?.[0]) description = descs[0].avcC?.config || descs[0].avcC;
        }
        if (!description) {
          try {
            const stsd = MP4BoxFile.getTrackById(videoTrackId)?.mdia?.minf?.stbl?.stsd;
            const entry = stsd?.entries?.[0];
            if (entry?.avcC?.config?.length > 0) description = new Uint8Array(entry.avcC.config);
            else if (typeof entry?.avcC?.subarray === 'function') description = entry.avcC.subarray();
            else if (typeof entry?.avcC?.start !== 'undefined' && entry?.avcC?.size) description = new Uint8Array(arrayBuffer, entry.avcC.start + 8, entry.avcC.size - 8);
          } catch { /* ignore */ }
        }

        decoder.configure({ codec: 'avc1.64001F', codedWidth: 1080, codedHeight: 1920, description });

        for (let i = 0; i < videoSamples.length; i++) {
          if (signal.aborted) { decoder.close(); throw new Error('Cancelled'); }
          const vs = videoSamples[i];
          await decoder.decode(new EncodedVideoChunk({ type: vs.isKeyframe ? 'key' : 'delta', timestamp: vs.timestamp * 1_000_000, data: vs.data }));
          emit(0.1 + (i / videoSamples.length) * 0.2, 'Decoding video...');
        }
        await decoder.flush();
        decoder.close();

        emit(0.3, 'Preparing output...');

        const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        const videoSource = new VideoSampleSource({ codec: 'avc', bitrate: QUALITY_HIGH });
        output.addVideoTrack(videoSource);

        let audioSource: EncodedAudioPacketSource | null = null;
        let audioPackets: EncodedPacket[] = [];
        let audioDecoderConfigForExport: AudioDecoderConfig | null = null;

        if (audioSamples.length > 0) {
          try {
            const input = new Input({ source: new BlobSource(new Blob([arrayBuffer], { type: 'video/mp4' })), formats: ALL_FORMATS });
            const audioTrack = await input.getPrimaryAudioTrack();
            if (audioTrack) {
              audioDecoderConfigForExport = await audioTrack.getDecoderConfig();
              audioSource = new EncodedAudioPacketSource('aac');
              output.addAudioTrack(audioSource);
              const sink = new EncodedPacketSink(audioTrack);
              for await (const packet of sink.packets()) audioPackets.push(packet);
              const firstTs = audioPackets[0]?.timestamp || 0;
              audioPackets = audioPackets
                .map(p => p.clone({ timestamp: p.timestamp - firstTs }))
                .filter(p => p.timestamp >= clipStart && p.timestamp < clipEnd);
              if (audioPackets.length > 0) {
                const firstTrim = audioPackets[0].timestamp;
                audioPackets = audioPackets.map(p => p.clone({ timestamp: p.timestamp - firstTrim }));
              }
            }
          } catch (e) { console.error('[carousel audio]', e); }
        }

        emit(0.35, 'Rendering frames...');
        await output.start();

        const offscreen = new OffscreenCanvas(W, H);

        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
          if (signal.aborted) { await output.finalize(); throw new Error('Cancelled'); }

          const targetTs = frameIdx * EXPORT_FRAME_DURATION + clipStart;
          let sourceFrame = decodedFrames[0];
          for (const f of decodedFrames) {
            if (f.timestamp <= targetTs) sourceFrame = f;
            else break;
          }

          const vw = sourceFrame.frame.displayWidth;
          const vh = sourceFrame.frame.displayHeight;
          drawCanvas(
            null,
            imgOffsetRef.current.x, imgOffsetRef.current.y, imgScaleRef.current,
            settingsRef.current,
            offscreen,
            { source: sourceFrame.frame, vw, vh },
          );

          const sample = new VideoSample(offscreen, { timestamp: targetTs, duration: EXPORT_FRAME_DURATION });
          await videoSource.add(sample);
          sample.close();
          emit(0.35 + (frameIdx / totalFrames) * 0.55, `Rendering frame ${frameIdx + 1}/${totalFrames}`);
        }

        for (const { frame } of decodedFrames) frame.close();

        if (audioSource && audioPackets.length > 0) {
          for (let i = 0; i < audioPackets.length; i++) {
            await audioSource.add(audioPackets[i], i === 0 && audioDecoderConfigForExport ? { decoderConfig: audioDecoderConfigForExport } : undefined);
          }
        }

        emit(0.95, 'Finalizing...');
        await output.finalize();

        const buffer = output.target.buffer;
        if (!buffer) throw new Error('No buffer received from output');

        const blob = new Blob([buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: url, download: `carousel-${Date.now()}.mp4` }).click();
        URL.revokeObjectURL(url);

        emit(1, 'Done!');

      } catch (error) {
        if (error instanceof Error && error.message !== 'Cancelled') {
          console.error('[carousel video export]', error);
          setVideoExportStatus(`Error: ${error.message}`);
          onRecordingStateChangeRef.current?.({ isRecording: false, recProgress: 0, recStatus: `Error: ${error.message}` });
          setTimeout(() => setVideoExportStatus(''), 3000);
        }
      } finally {
        setIsVideoExporting(false);
        setVideoExportProgress(0);
        setVideoExportStatus('');
        onRecordingStateChangeRef.current?.({ isRecording: false, recProgress: 0, recStatus: '' });
        videoExportAbortRef.current = null;
      }
    }
    startVideoExportRef.current = startVideoExport;

    // Per-slide VIDEO export: composite the slide frame-by-frame (each video box seeked to the frame's
    // timestamp) → .mp4 via mediabunny, muxing the longest box's audio. Reuses drawCanvas so every layer
    // (images, text, fade, each video frame) is included. mp4/H.264, 60fps, full 1080×1350. (Ported from sonotool.)
    async function startVideoBoxExport(): Promise<void> {
      if (isVideoExporting) return;
      const boxes = (settingsRef.current.imageBoxes ?? []).filter(b => b.videoUrl);
      const vEls = boxes
        .map(b => ({ b, el: videoBoxElsRef.current.get(b.videoUrl!) }))
        .filter((x): x is { b: ImageBox; el: HTMLVideoElement } => !!x.el);
      if (vEls.length === 0) {
        // Video element not registered/loaded yet — tell the user instead of silently doing nothing.
        setVideoExportStatus('Error: video is still loading — try again in a moment');
        setTimeout(() => setVideoExportStatus(''), 3000);
        return;
      }

      const abortController = new AbortController();
      videoExportAbortRef.current = abortController;
      const signal = abortController.signal;
      const emit = (progress: number, status: string) => {
        setVideoExportProgress(progress);
        setVideoExportStatus(status);
        onRecordingStateChangeRef.current?.({ isRecording: true, recProgress: progress, recStatus: status });
      };
      setIsVideoExporting(true);
      emit(0, 'Initializing...');
      setPlayingVideoUrl(null);          // stop preview playback during export
      vEls.forEach(x => x.el.pause());   // drive frames by seeking, not playback

      try {
        const mediabunny = await import('mediabunny');
        const { Output, Mp4OutputFormat, BufferTarget, VideoSample, VideoSampleSource,
                Input, BlobSource, ALL_FORMATS, QUALITY_HIGH, EncodedAudioPacketSource, EncodedPacketSink } = mediabunny;

        // Make sure each source has loaded metadata (so duration + seeking work) before rendering frames;
        // otherwise duration is NaN and we'd emit a near-empty clip.
        emit(0.03, 'Loading video…');
        await Promise.all(vEls.map(x => x.el.readyState >= 1 ? Promise.resolve() : new Promise<void>(res => {
          const done = () => { x.el.removeEventListener('loadedmetadata', done); res(); };
          x.el.addEventListener('loadedmetadata', done);
          setTimeout(done, 4000);   // fallback so a stalled load can't hang the export
        })));

        const EXPORT_FPS = 60, FRAME_DUR = 1 / EXPORT_FPS;
        const durations = vEls.map(x => (isFinite(x.el.duration) && x.el.duration > 0 ? x.el.duration : 0));
        const maxDur = Math.min(30, Math.max(0.1, ...durations));   // longest video box, capped at 30s
        const totalFrames = Math.max(1, Math.floor(maxDur * EXPORT_FPS));
        const audioUrl = vEls[durations.indexOf(Math.max(...durations))]?.b.videoUrl ?? vEls[0].b.videoUrl!;

        emit(0.05, 'Preparing output...');
        const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        const videoSource = new VideoSampleSource({ codec: 'avc', bitrate: QUALITY_HIGH });
        output.addVideoTrack(videoSource);

        // Audio: copy the longest box's AAC packets (no re-encode), clipped to the export length.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let audioSource: any = null; let audioPackets: any[] = []; let audioDecoderConfig: unknown = null;
        try {
          if (!audioUrl) throw new Error('no-audio-source');
          const resp = await fetch(audioUrl, { signal });
          if (resp.ok) {
            const ab = await resp.arrayBuffer();
            const input = new Input({ source: new BlobSource(new Blob([ab], { type: 'video/mp4' })), formats: ALL_FORMATS });
            const at = await input.getPrimaryAudioTrack();
            if (at) {
              audioDecoderConfig = await at.getDecoderConfig();
              audioSource = new EncodedAudioPacketSource('aac');
              output.addAudioTrack(audioSource);
              const sink = new EncodedPacketSink(at);
              for await (const p of sink.packets()) audioPackets.push(p);
              const first = audioPackets[0]?.timestamp || 0;
              for (const p of audioPackets) p.timestamp -= first;
              audioPackets = audioPackets.filter((p) => p.timestamp < maxDur);
            }
          }
        } catch (e) { if (!signal.aborted && (e as Error)?.message !== 'no-audio-source') console.warn('[video export] audio skipped:', e); }

        await output.start();
        const offscreen = new OffscreenCanvas(W, H);
        const seekTo = (el: HTMLVideoElement, t: number) => new Promise<void>(res => {
          if (Math.abs(el.currentTime - t) < 1e-3 && el.readyState >= 2) { res(); return; }
          let done = false;
          const finish = () => { if (done) return; done = true; el.removeEventListener('seeked', finish); res(); };
          el.addEventListener('seeked', finish);
          try { el.currentTime = t; } catch { finish(); }
          setTimeout(finish, 500);   // fallback so a missed 'seeked' can't stall the export
        });

        emit(0.1, 'Rendering frames...');
        for (let i = 0; i < totalFrames; i++) {
          if (signal.aborted) { await output.finalize(); throw new Error('Cancelled'); }
          const t = i * FRAME_DUR;
          await Promise.all(vEls.map((x, k) => seekTo(x.el, durations[k] > 0 ? (t % durations[k]) : 0)));
          drawCanvas(cachedImgRef.current, imgOffsetRef.current.x, imgOffsetRef.current.y, imgScaleRef.current, settingsRef.current, offscreen);
          const sample = new VideoSample(offscreen, { timestamp: t, duration: FRAME_DUR });
          await videoSource.add(sample);
          sample.close();
          emit(0.1 + (i / totalFrames) * 0.8, `Rendering frame ${i + 1}/${totalFrames}`);
        }

        if (audioSource && audioPackets.length > 0) {
          for (let i = 0; i < audioPackets.length; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await audioSource.add(audioPackets[i], i === 0 ? { decoderConfig: audioDecoderConfig as any } : undefined);
          }
        }

        emit(0.95, 'Finalizing...');
        await output.finalize();
        const buffer = output.target.buffer;
        if (!buffer) throw new Error('No buffer received from output');
        const blob = new Blob([buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: url, download: `video-${Date.now()}.mp4` }).click();
        URL.revokeObjectURL(url);
        emit(1, 'Done!');
      } catch (error) {
        if (error instanceof Error && error.message !== 'Cancelled') {
          console.error('[video box export]', error);
          setVideoExportStatus(`Error: ${error.message}`);
          onRecordingStateChangeRef.current?.({ isRecording: false, recProgress: 0, recStatus: `Error: ${error.message}` });
          setTimeout(() => setVideoExportStatus(''), 3000);
        }
      } finally {
        setIsVideoExporting(false);
        setVideoExportProgress(0);
        setVideoExportStatus('');
        onRecordingStateChangeRef.current?.({ isRecording: false, recProgress: 0, recStatus: '' });
        videoExportAbortRef.current = null;
        vEls.forEach(x => { try { x.el.pause(); x.el.muted = true; x.el.currentTime = 0; } catch { /* ignore */ } });
        redraw(cachedImgRef.current);   // restore the static first-frame view
      }
    }
    startVideoBoxExportRef.current = startVideoBoxExport;

    useImperativeHandle(ref, () => {
      // Shared image-export path behind startDownload + exportBlob. Renders the current slide to a 4×
      // PNG blob; returns null for video slides (callers treat those as videos, not images).
      const renderPngBlob = async (): Promise<Blob | null> => {
        if (videoModeRef.current) return null;
        if ((settingsRef.current.imageBoxes ?? []).some(b => b.videoUrl)) return null;
        const EXPORT_SCALE = 4;
        const hiCanvas = document.createElement('canvas');
        hiCanvas.width = W * EXPORT_SCALE;
        hiCanvas.height = H * EXPORT_SCALE;
        if (animFrameRef.current !== null) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
        // Wait for any in-flight per-box subject cut-outs so split effects export reliably.
        if (imageBoxFgPromisesRef.current.size > 0) {
          await Promise.all([...imageBoxFgPromisesRef.current.values()]).catch(() => {});
        }
        drawCanvas(
          cachedImgRef.current,
          imgOffsetRef.current.x, imgOffsetRef.current.y, imgScaleRef.current,
          settingsRef.current,
          hiCanvas,
        );
        await new Promise(r => setTimeout(r, 30));
        return new Promise<Blob | null>(res => hiCanvas.toBlob(b => res(b), 'image/png'));
      };
      return {
      // Select a free element (logo etc.) from the panel; clears other selections so the
      // panel↔canvas open/selection binding stays 1:1. null deselects.
      selectFreeEl(i: number | null) {
        setSelectedFreeEl(i);
        if (i !== null) { setSelectedImageBox(null); setSelectedTextBox(null); setSelectedZoneSlot(null); setRichEditTarget(null); }
      },
      selectImageBox(i: number | null) {
        setSelectedImageBox(i);
        if (i !== null) { setSelectedFreeEl(null); setSelectedTextBox(null); setSelectedZoneSlot(null); setRichEditTarget(null); }
      },
      selectZoneLogo(i: number | null) {
        setSelectedZoneSlot(i === null ? null : { kind: 'logo', index: i });
        if (i !== null) { setSelectedFreeEl(null); setSelectedImageBox(null); setSelectedTextBox(null); setRichEditTarget(null); }
      },
      // Plain text-box select (outline + handles); clears the other selections to stay 1:1. null deselects.
      selectTextBox(i: number | null) {
        setSelectedTextBox(i);
        if (i !== null) { setSelectedFreeEl(null); setSelectedImageBox(null); setSelectedZoneSlot(null); setRichEditTarget(null); }
      },
      // Select any 3×3 zone slot (tag/quote/swipe/logo) by kind + index. null deselects.
      selectZoneSlot(kind: 'logo' | 'tag' | 'quote' | 'swipe', i: number | null) {
        setSelectedZoneSlot(i === null ? null : { kind, index: i });
        if (i !== null) { setSelectedFreeEl(null); setSelectedImageBox(null); setSelectedTextBox(null); setRichEditTarget(null); }
      },
      // Enter/exit headline or sub-headline edit mode (their "selected" state). null exits.
      setRichEdit(t: 'headline' | 'sub' | null) {
        setRichEditTarget(t);
        if (t !== null) { setSelectedFreeEl(null); setSelectedImageBox(null); setSelectedTextBox(null); setSelectedZoneSlot(null); }
      },
      // Deselect everything — used when clicking the editor void around the slide. Blur any open text
      // editor first so its content commits (headline/sub save in onBlur); .blur() no-ops when nothing
      // is focused. Mirrors the slide's own empty-space mousedown so in/out-of-slide behave the same.
      deselectAll() {
        richEditRef.current?.blur();
        editTextRef.current?.blur();
        setSelectedTextBox(null);
        setSelectedImageBox(null);
        setSelectedFreeEl(null);
        setSelectedZoneSlot(null);
      },
      // Add a developer overlay texture: a full-canvas image box on Screen blend,
      // placed on the top layer and selected. It gets no canvas frame (isOverlay),
      // so it never blocks selecting elements beneath it — managed via the Layers panel.
      addOverlay(url: string) {
        const s = settingsRef.current;
        const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID() : `ov-${Math.floor(Math.random() * 1e9).toString(36)}`;
        const box: ImageBox = { id, url, x: 0, y: 0, width: W, height: H, opacity: 100, cornerRadius: 0, blend: 'screen', isOverlay: true };
        const fadeOn = !!(s.showFade || s.showTopFade);
        const order = orderedLayerIds(s.imageBoxes ?? [], s.textBoxes ?? [], s.freeElements ?? [], s.layerOrderIds, fadeOn, false, s.zoneLogoSlots, { tagSlots: s.tagSlots, quoteSlots: s.quoteSlots, tagZoneSlots: s.tagZoneSlots, quoteZoneSlots: s.quoteZoneSlots, swipeZoneSlots: s.swipeZoneSlots }).map(x => x.id);
        const imageBoxes = [...(s.imageBoxes ?? []), box];
        const layerOrderIds = [...order, id];
        settingsRef.current = { ...s, imageBoxes, layerOrderIds };
        onSettingsChangeRef.current?.({ imageBoxes, layerOrderIds });
        selectImageBoxOnly(imageBoxes.length - 1);
        const probe = new Image();
        probe.crossOrigin = 'anonymous';
        probe.onload = () => { imageBoxImgsRef.current.set(url, probe); redraw(cachedImgRef.current); };
        probe.onerror = () => console.warn('[overlay] failed to load:', url);
        probe.src = url;
        redraw(cachedImgRef.current);
      },
      async startDownload() {
        if (videoModeRef.current) {
          await startVideoExportRef.current();
          return;
        }
        // Slide with any video box → export an .mp4 (video boxes seeked frame-by-frame).
        if ((settingsRef.current.imageBoxes ?? []).some(b => b.videoUrl)) {
          await startVideoBoxExportRef.current();
          return;
        }
        const blob = await renderPngBlob();
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `carousel-${Date.now()}.png`; a.click();
        URL.revokeObjectURL(url);
      },
      // Same pixels as startDownload, but returns the blob for upload (e.g. Send to scheduler).
      async exportBlob() {
        return renderPngBlob();
      },
      zoomIn() {
        const n = Math.min(8, imgScaleRef.current * 1.25);
        imgScaleRef.current = n; setImgScale(n); onScaleChange?.(n); redraw(cachedImgRef.current);
      },
      zoomOut() {
        const n = Math.max(0.2, imgScaleRef.current / 1.25);
        imgScaleRef.current = n; setImgScale(n); onScaleChange?.(n); redraw(cachedImgRef.current);
      },
      setZoom(s: number) {
        const n = Math.max(0.2, Math.min(8, s));
        imgScaleRef.current = n; setImgScale(n); onScaleChange?.(n); redraw(cachedImgRef.current);
      },
      resetTransform() {
        imgOffsetRef.current  = { x: 0, y: 0 };
        imgScaleRef.current   = 1; setImgScale(1); onScaleChange?.(1);
        imgSrcCropRef.current = null;
        redraw(cachedImgRef.current);
      },
      cancelExport() { videoExportAbortRef.current?.abort(); },
      // Paste-to-canvas landing path: place uploaded media as a new box centred on the slide, via
      // the same aspect-probing creators the drag-drop path uses. Driven by the Grid's window
      // 'paste' listener — the upload has to happen there (the tray + storage buckets live in the
      // Grid), so the canvas only does the placement.
      addMediaBoxCentered(url: string, kind: 'image' | 'video') {
        if (kind === 'video') addVideoBox(url, W / 2, H / 2);
        else addImageBox(url, W / 2, H / 2);
      },
      enterCropMode() { startCropMode(); },
      toggleSplit() { runBgRemovalRef.current('split'); },
      toggleBlur()  { runBgRemovalRef.current('blur');  },
      play()  { videoRef.current?.play(); },
      pause() { videoRef.current?.pause(); },
      seekTo(t: number) { if (videoRef.current) videoRef.current.currentTime = t; },
      setTrimRange(start: number, end: number) {
        trimStartRef.current = start;
        trimEndRef.current   = end;
      },
      resetTrim() {
        trimStartRef.current = 0;
        trimEndRef.current   = Infinity;
      },
      resetBox() {
        imgOffsetRef.current = { x: 0, y: 0 };
        imgScaleRef.current  = 1; setImgScale(1); onScaleChange?.(1);
        redraw(null);
      },
      centerBox() {
        imgOffsetRef.current = { x: 0, y: 0 };
        redraw(null);
      },
      getVideoElement() { return videoRef.current; },
      getTrimState() {
        const dur = videoRef.current?.duration ?? 0;
        return {
          trimStart: trimStartRef.current,
          trimEnd:   trimEndRef.current === Infinity ? dur : trimEndRef.current,
          duration:  dur,
        };
      },
      setSelectionWeight(weight: number) { applyTextWeight(weight); },
      toggleSelectionItalic() { richTextCmd('italic'); },
      setSelectionColor(color: string) { richTextCmd('foreColor', color); },
      };
    }, [redraw, onScaleChange, drawCanvas, applyTextWeight, richTextCmd, addImageBox, addVideoBox]);

    function startCropMode() {
      const img = cachedImgRef.current;
      if (!img) return;
      const savedCrop = imgSrcCropRef.current;

      // Save current state so Escape can restore it
      cropEntryStateRef.current = {
        crop: imgSrcCropRef.current,
        ox: imgOffsetRef.current.x,
        oy: imgOffsetRef.current.y,
        sc: imgScaleRef.current,
      };

      // Show full original image while in crop mode
      imgSrcCropRef.current = null;
      imgOffsetRef.current  = { x: 0, y: 0 };
      imgScaleRef.current   = 1;
      setImgScale(1);
      onScaleChange?.(1);
      redraw(img);

      // Position handles at the committed crop, or full canvas if none
      if (savedCrop) {
        const baseScale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        const renderX   = (W - img.naturalWidth  * baseScale) / 2;
        const renderY   = (H - img.naturalHeight * baseScale) / 2;
        const px  = Math.max(0, (renderX + savedCrop.sx * baseScale) * DISPLAY_SCALE);
        const py  = Math.max(0, (renderY + savedCrop.sy * baseScale) * DISPLAY_SCALE);
        const pw  = Math.min(CAROUSEL_PREVIEW_W - px, savedCrop.sw * baseScale * DISPLAY_SCALE);
        const ph  = Math.min(CAROUSEL_PREVIEW_H - py, savedCrop.sh * baseScale * DISPLAY_SCALE);
        const nr  = { x: px, y: py, w: Math.max(10, pw), h: Math.max(10, ph) };
        cropRectRef.current = nr;
        setCropRect(nr);
      } else {
        const full = { x: 0, y: 0, w: CAROUSEL_PREVIEW_W, h: CAROUSEL_PREVIEW_H };
        cropRectRef.current = full;
        setCropRect(full);
      }
      setIsCropMode(true);
    }

    function applyCrop() {
      const img = cachedImgRef.current;
      if (!img) { setIsCropMode(false); return; }

      const r = cropRectRef.current;
      const cx = r.x / DISPLAY_SCALE;  // canvas pixels
      const cy = r.y / DISPLAY_SCALE;
      const cw = r.w / DISPLAY_SCALE;
      const ch = r.h / DISPLAY_SCALE;

      // Current image source region (natural px)
      const prev = imgSrcCropRef.current;
      const srcX = prev?.sx ?? 0;
      const srcY = prev?.sy ?? 0;
      const srcW = prev?.sw ?? img.naturalWidth;
      const srcH = prev?.sh ?? img.naturalHeight;

      // Current draw parameters
      const imgOx      = imgOffsetRef.current.x;
      const imgOy      = imgOffsetRef.current.y;
      const imgSc      = imgScaleRef.current;
      const coverBase  = Math.max(W / srcW, H / srcH);
      const effScale   = coverBase * imgSc;   // canvas-px per source-px
      const renderW    = srcW * effScale;
      const renderH    = srcH * effScale;
      const renderX    = (W - renderW) / 2 + imgOx;
      const renderY    = (H - renderH) / 2 + imgOy;

      // Map canvas crop rect → source image natural coords
      const rawL = srcX + (cx      - renderX) / renderW * srcW;
      const rawT = srcY + (cy      - renderY) / renderH * srcH;
      const rawR = srcX + (cx + cw - renderX) / renderW * srcW;
      const rawB = srcY + (cy + ch - renderY) / renderH * srcH;

      // Clamp to current source bounds
      const newSx = Math.max(srcX,        rawL);
      const newSy = Math.max(srcY,        rawT);
      const newSw = Math.max(1, Math.min(srcX + srcW, rawR) - newSx);
      const newSh = Math.max(1, Math.min(srcY + srcH, rawB) - newSy);

      // Adjust imgScale/imgOffset so the visual stays exactly the same
      // after the source dimensions change from (srcW×srcH) to (newSw×newSh).
      // New coverBase uses the new source dims; imgSc is scaled to compensate.
      const newCoverBase = Math.max(W / newSw, H / newSh);
      const newImgSc     = effScale / newCoverBase;
      // Offset shifts because the "center of the draw" moves when source dims change
      const newImgOx     = imgOx + effScale * ((newSw - srcW) / 2 + (newSx - srcX));
      const newImgOy     = imgOy + effScale * ((newSh - srcH) / 2 + (newSy - srcY));

      imgSrcCropRef.current     = { sx: newSx, sy: newSy, sw: newSw, sh: newSh };
      imgScaleRef.current       = newImgSc;
      imgOffsetRef.current      = { x: newImgOx, y: newImgOy };
      cropEntryStateRef.current = null;
      setImgScale(newImgSc);
      onScaleChange?.(newImgSc);

      const full = { x: 0, y: 0, w: CAROUSEL_PREVIEW_W, h: CAROUSEL_PREVIEW_H };
      cropRectRef.current = full;
      setCropRect(full);
      setCropLock('free');
      redraw(cachedImgRef.current);
      setIsCropMode(false);
    }

    // Dynamic overlay positions — mirror the canvas logo positions exactly
    const padXPv      = Math.round((32 + settings.contentPadding * 0.64) * DISPLAY_SCALE);
    const slotFwPv    = CAROUSEL_PREVIEW_W - 2 * padXPv;
    const aboveHLTop  = Math.max(0, blockTopPv - LOGO_PH - settings.aboveLogoGap);
    const subSlotTop  = CAROUSEL_PREVIEW_H - LOGO_PH - padXPv;
    const slotPosArr: React.CSSProperties[] = [
      { top: padXPv,     left: padXPv },
      { top: aboveHLTop, left: padXPv },
      { top: subSlotTop, left: padXPv },
    ];
    // Slot overlays: show during drag (so elements have visible drop targets like skeleton mode)
    // and when a slot has content (so the remove X is visible). Hidden otherwise.
    const hasTopSlotContent = !!(
      settings.dividerSlots?.[0] || settings.tagSlots?.[0] || settings.quoteSlots?.[0] ||
      settings.tagZoneSlots?.slice(0, 3).some(Boolean) ||
      settings.zoneLogoSlots?.slice(0, 3).some(Boolean) ||
      settings.quoteZoneSlots?.slice(0, 3).some(Boolean) ||
      settings.swipeZoneSlots?.slice(0, 3).some(Boolean)
    );
    const hasBottomSlotContent = !!(
      settings.dividerSlots?.[2] || settings.tagSlots?.[2] || settings.quoteSlots?.[2] ||
      settings.tagZoneSlots?.slice(6).some(Boolean) ||
      settings.zoneLogoSlots?.slice(6).some(Boolean) ||
      settings.quoteZoneSlots?.slice(6).some(Boolean) ||
      settings.swipeZoneSlots?.slice(6).some(Boolean)
    );
    const hasMiddleSlotContent = !!(
      settings.dividerSlots?.[1] || settings.tagSlots?.[1] || settings.quoteSlots?.[1] ||
      settings.tagZoneSlots?.slice(3, 6).some(Boolean) ||
      settings.zoneLogoSlots?.slice(3, 6).some(Boolean) ||
      settings.quoteZoneSlots?.slice(3, 6).some(Boolean) ||
      settings.swipeZoneSlots?.slice(3, 6).some(Boolean)
    );
    // Rows/slots that already hold something always show (position anchors).
    const showSlotOverlay = [
      elementDrag || hasTopSlotContent,
      elementDrag || hasMiddleSlotContent,
      elementDrag || hasBottomSlotContent,
    ];

    // Selected box (text or image) + Alt held → spacing-measurement overlay (purely visual, not drawn to canvas)
    const measBox: { x: number; y: number; width: number; height: number } | null = !altHeld
      ? null
      : selectedTextBox !== null
        ? (() => { const tb = (settings.textBoxes ?? [])[selectedTextBox]; return tb ? { x: tb.x, y: tb.y, width: tb.width ?? 540, height: tb.fitToWidth ? (tb.height ?? 200) : (textBoxHeights[tb.id] ?? tb.height ?? 200) } : null; })()
        : selectedImageBox !== null
          ? (() => { const b = (settings.imageBoxes ?? [])[selectedImageBox]; return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null; })()
          : null;

    const blurLayerActive = settings.bgBlurEnabled && !!fgMaskSrc;

    // Click priority follows the visual layer order (Layers panel) so clicking an overlap selects the
    // TOP-most layer — the SAME bottom→top stack used for the canvas draw order. Image/text/free element
    // frames get a z-index derived from their position in that stack; a selected frame jumps just above
    // the whole band so its handles stay grabbable. Legacy decorations (logo z=2, circle z=3,
    // headline/sub click targets z=4) stay below FRAME_Z_BASE, so a movable element always beats them.
    const _frameOrder = orderedLayerIds(
      settings.imageBoxes ?? [], settings.textBoxes ?? [], settings.freeElements ?? [],
      settings.layerOrderIds, !!(settings.showFade || settings.showTopFade), true, settings.zoneLogoSlots,
      { tagSlots: settings.tagSlots, quoteSlots: settings.quoteSlots, tagZoneSlots: settings.tagZoneSlots, quoteZoneSlots: settings.quoteZoneSlots, swipeZoneSlots: settings.swipeZoneSlots },
    );
    const FRAME_Z_BASE = 6;
    const _frameZ = new Map(_frameOrder.map((o, i) => [o.id, i] as const));
    const FRAME_Z_SELECTED = FRAME_Z_BASE + _frameOrder.length + 1;
    const frameZIndex = (id: string, selected: boolean) =>
      selected ? FRAME_Z_SELECTED : FRAME_Z_BASE + (_frameZ.get(id) ?? 0);

    return (
      <>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ position: 'relative', flexShrink: 0 }}>
      {/* Element layers panel — floats just left of the canvas */}
      {!staticMode && (() => {
        // Skeleton inventory: headline/sub text + everything snapped into boxes.
        const skel: { id: string; label: string; badge: string; selected?: boolean; onClick?: () => void }[] = [];
        if (headline.trim()) skel.push({ id: 'skel-head', label: headline.trim(), badge: 'H', selected: richEditTarget === 'headline', onClick: () => selectRichEditOnly('headline') });
        if (subheadline.trim()) skel.push({ id: 'skel-sub', label: subheadline.trim(), badge: 'S', selected: richEditTarget === 'sub', onClick: () => selectRichEditOnly('sub') });
        const zoneLogoCount = (settings.zoneLogoSlots ?? []).filter(Boolean).length;
        let zoneLogoNum = 0;
        const zSel = (kind: 'logo' | 'tag' | 'quote' | 'swipe', fi: number) => selectedZoneSlot?.kind === kind && selectedZoneSlot.index === fi;
        for (let fi = 0; fi < 9; fi++) {
          const t = settings.tagZoneSlots?.[fi];   if (t)  skel.push({ id: `skel-tag-${fi}`,   label: `Tag · ${t.text}`, badge: 'T', selected: zSel('tag', fi),   onClick: () => selectZone('tag', fi) });
          const l = settings.zoneLogoSlots?.[fi];  if (l)  { zoneLogoNum++; skel.push({ id: `skel-logo-${fi}`,  label: zoneLogoCount > 1 ? `Logo ${zoneLogoNum}` : 'Logo', badge: 'L', selected: zSel('logo', fi), onClick: () => selectZone('logo', fi) }); }
          const q = settings.quoteZoneSlots?.[fi]; if (q)  skel.push({ id: `skel-quote-${fi}`, label: 'Quote',           badge: 'Q', selected: zSel('quote', fi), onClick: () => selectZone('quote', fi) });
          const sw = settings.swipeZoneSlots?.[fi]; if (sw) skel.push({ id: `skel-swipe-${fi}`, label: sw.text ? `Swipe · ${sw.text}` : 'Swipe', badge: 'S', selected: zSel('swipe', fi), onClick: () => selectZone('swipe', fi) });
        }
        (settings.dividerSlots ?? []).forEach((d, i) => { if (d) skel.push({ id: `skel-div-${i}`, label: 'Divider', badge: 'D' }); });
        const anyLayers = (settings.imageBoxes?.length ?? 0) + (settings.textBoxes?.length ?? 0) + (settings.freeElements?.length ?? 0) + skel.length > 0
          || !!(settings.showFade || settings.showTopFade);
        // Floating layers panel removed — layers are now managed in the right settings panel.
        void anyLayers;
        return null;
      })()}
      <div
        ref={wrapperRef}
        style={{
          width: CAROUSEL_PREVIEW_W, height: CAROUSEL_PREVIEW_H,
          // overflow visible (not hidden): a box resized/dragged past the slide keeps its
          // selection outline + handles visible in the surrounding margin. The image itself
          // stays clipped because it is painted onto the fixed-size canvas bitmap, not the DOM.
          position: 'relative', flexShrink: 0, overflow: 'visible',
          cursor: (imageSrc || videoSrc) ? (isDragging ? 'grabbing' : 'grab') : 'default',
        }}
        onDragOver={e => {
          if (e.dataTransfer.types.includes('application/carousel-element')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={e => {
          if (!e.dataTransfer.types.includes('application/carousel-element')) return;
          // Skeleton boxes / sub-slots / element overlays / image-box frames (drag-replace) handle
          // their own drops.
          if ((e.target as Element).closest?.('[data-carousel-slot]')) return;
          e.preventDefault();
          try {
            const d = JSON.parse(e.dataTransfer.getData('application/carousel-element')) as SidebarElementData;
            const rect = wrapperRef.current?.getBoundingClientRect();
            if (!rect) return;
            const cx = (e.clientX - rect.left) / DISPLAY_SCALE;
            const cy = (e.clientY - rect.top)  / DISPLAY_SCALE;
            if (d.type === 'image' && d.url) { if (allowImages) addImageBox(d.url, cx, cy); }
            else if (d.type === 'video' && d.url) { if (allowImages) addVideoBox(d.url, cx, cy); }
            else if (d.type === 'text') {
              const preset = d.textPreset ?? {};
              const base = defaultTextBox();
              const tb: TextBoxStyle = {
                ...base, ...preset,
                id: base.id,
                text: d.text ?? preset.text ?? base.text,
                fillPlaceholder: false,
              };
              tb.x = Math.round(cx - tb.width / 2);
              tb.y = Math.round(cy - tb.height / 2);
              applyFreePatch({ textBoxes: [...(settingsRef.current.textBoxes ?? []), tb] });
            }
            else addFreeElementFromSidebar(d, cx, cy);   // dropped outside a box → freeform
          } catch { /* ignore malformed drops */ }
        }}
        onMouseDown={e => {
          const onEl = !!(e.target as Element).closest('[data-carousel-slot]') || !!(e.target as Element).closest('[data-crop-handle]');
          // Clicking empty space deselects EVERYTHING, uniformly across element types. Active text
          // editors are blurred first so their content still commits (headline/sub save in onBlur),
          // and we do it here rather than relying on the browser's own blur because the pan
          // preventDefault() below would otherwise suppress it.
          if (!onEl) {
            if (richEditTarget) richEditRef.current?.blur();   // headline/sub: saves spans + clears richEditTarget
            if (editingTextBox !== null) editTextRef.current?.blur();   // inline text-box editor: exits
            setSelectedTextBox(null);
            setSelectedImageBox(null);
            setSelectedFreeEl(null);
            setSelectedZoneSlot(null);
          }
          if (!imageSrc && !videoSrc) return;
          if (onEl) return;
          e.preventDefault();
          dragStartRef.current = { mx: e.clientX, my: e.clientY, ox: imgOffsetRef.current.x, oy: imgOffsetRef.current.y };
          setIsDragging(true);
        }}
      >
        {/* Layers panel — left of canvas, only in blur-layer mode */}
        {!staticMode && blurLayerActive && (
          <LayersPanel
            layers={settings.layerOrder ?? ['background', 'circle', 'circle2', 'subject']}
            onChange={layers => onSettingsChange?.({ layerOrder: layers })}
          />
        )}

        <canvas
          ref={canvasRef} width={W} height={H}
          style={{
            width: CAROUSEL_PREVIEW_W, height: CAROUSEL_PREVIEW_H, display: 'block', pointerEvents: 'none',
            // Transparent canvas: a checkerboard shows through the canvas's transparent pixels (editor only —
            // it's a CSS background, not part of the exported bitmap).
            ...(settings.canvasTransparent ? {
              backgroundColor: '#ffffff',
              backgroundImage: 'linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%), linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%)',
              backgroundSize: '20px 20px',
              backgroundPosition: '0 0, 10px 10px',
            } : {}),
          }}
        />

        {/* MP4 export progress / error overlay — the render takes several seconds with no other feedback,
            so without this the export button looks like it does nothing. Also surfaces swallowed errors. */}
        {(isVideoExporting || videoExportStatus.startsWith('Error')) && (
          <div
            style={{
              position: 'absolute', inset: 0, zIndex: 60,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
              background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(2px)',
            }}
          >
            {isVideoExporting ? (
              <>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" style={{ animation: 'spin 1s linear infinite' }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <div style={{ fontSize: 12, color: '#fff', fontWeight: 600 }}>{videoExportStatus || 'Exporting…'}</div>
                <div style={{ width: '60%', height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.18)', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.round(videoExportProgress * 100)}%`, height: '100%', background: '#fff', transition: 'width 0.15s' }} />
                </div>
                <button
                  onClick={() => videoExportAbortRef.current?.abort()}
                  style={{ marginTop: 4, fontSize: 11, color: 'rgba(255,255,255,0.75)', background: 'transparent', border: '1px solid var(--line-strong)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <div style={{ fontSize: 12, color: '#fca5a5', fontWeight: 600, maxWidth: '80%', textAlign: 'center' }}>{videoExportStatus}</div>
            )}
          </div>
        )}

        {/* Hidden video element — only mounted in video mode for frame capture */}
        {videoSrc && (
          <video key={videoSrc} ref={videoRef} src={videoSrc}
            style={{ display: 'none' }} autoPlay loop muted playsInline crossOrigin="anonymous"
            onLoadedData={() => redraw(null)}
          />
        )}

        {/* Interactive overlays — hidden in staticMode, and in cleanView (frames/guides/slots) for a clean preview */}
        {!staticMode && !cleanView && <>

        {/* Logo placeholder slots — overlay-only, not part of the canvas bitmap */}
        {Array.from({ length: 3 }, (_, i) => {
          if (!showSlotOverlay[i]) return null;
          const isOpen     = openSlot === i;
          const alignRight = false;
          const inputId    = `logo-${instanceId}-${i}`;

          const slotStyle: React.CSSProperties = {
            position: 'absolute',
            width:    slotFwPv,
            height:   LOGO_PH,
            // No numeric z when closed → this row container creates NO stacking context, so each filled
            // zone cell's own (layer-order-derived) z competes globally with the image/text/free frames.
            // Empty "add content" cells keep no z (auto), so they stay below the band and never steal a
            // click from a box drawn over an empty zone. When its add-dropdown is open it lifts to 50.
            zIndex:   isOpen ? 50 : undefined,
            ...slotPosArr[i],
          };

          return (
            <div
              key={i}
              ref={el => { slotContainerRefs.current[i] = el; }}
              style={slotStyle}
              data-carousel-slot=""
              onDragOver={e => {
                e.preventDefault();
                setDragOverSlot(i);
                const isDiv = e.dataTransfer.types.includes('application/carousel-element-type/divider');
                setIsDividerDrag(isDiv);
                if (!isDiv) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = e.clientX - rect.left;
                  const t = rect.width / 3;
                  setDragOverZone(x < t ? 'left' : x < t * 2 ? 'center' : 'right');
                }
              }}
              onDragEnter={e => {
                e.preventDefault();
                setDragOverSlot(i);
                setIsDividerDrag(e.dataTransfer.types.includes('application/carousel-element-type/divider'));
              }}
              onDragLeave={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOverSlot(null);
                  setDragOverZone(null);
                  setIsDividerDrag(false);
                }
              }}
              onDrop={e => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverSlot(null);
                setDragOverZone(null);
                setIsDividerDrag(false);
                try {
                  const d: SidebarElementData = JSON.parse(e.dataTransfer.getData('application/carousel-element'));
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = e.clientX - rect.left;
                  const t = rect.width / 3;
                  const zone: 'left' | 'center' | 'right' = x < t ? 'left' : x < t * 2 ? 'center' : 'right';
                  const zi = zone === 'left' ? 0 : zone === 'center' ? 1 : 2;
                  // A box holds at most one element. Occupied target (or an
                  // occupied row, for dividers) → the drop lands freeform instead.
                  const boxFree = d.type === 'divider' ? rowIsEmpty(i) : zoneIsEmpty(i, zi);
                  if (d.type !== 'image' && !boxFree) {
                    const wrapRect = wrapperRef.current?.getBoundingClientRect();
                    if (wrapRect) {
                      addFreeElementFromSidebar(d, (e.clientX - wrapRect.left) / DISPLAY_SCALE, (e.clientY - wrapRect.top) / DISPLAY_SCALE);
                    }
                    onSlotDrop?.(i, d);
                    return;
                  }
                  if (d.type === 'tag' && d.text && d.style) {
                    selectTagZone(i, zone, d.text, d.style);
                  } else if (d.type === 'logo') {
                    selectBrandLogoZone(i, zone, d.url);
                  }
                  else if (d.type === 'quote' && d.id) {
                    selectQuoteZone(i, zone, d.id);
                  } else if (d.type === 'swipe' && d.swipeStyle) {
                    selectSwipeZone(i, zone, d.swipeStyle);
                  }
                  else if (d.type === 'divider' && d.id) {
                    // Clear ALL slot content — divider overrides everything
                    const imgSlot = slotsRef.current[i];
                    if (imgSlot?.type === 'image') URL.revokeObjectURL(imgSlot.url);
                    logoImgsRef.current[i] = null;
                    subImgRefsArr.current[i] = null;
                    const nextSlots = [...slotsRef.current] as (SlotContent | null)[];
                    nextSlots[i] = null;
                    slotsRef.current = nextSlots;
                    setSlots(nextSlots);
                    const cur       = [...(settingsRef.current.dividerSlots   ?? Array(3).fill(null))];
                    const curSub    = [...(settingsRef.current.dividerSubSlots ?? Array(3).fill(null))] as (DividerSubSlotContent | null)[];
                    const curTag    = [...(settingsRef.current.tagSlots        ?? Array(6).fill(null))];
                    const curQuo    = [...(settingsRef.current.quoteSlots      ?? Array(6).fill(null))];
                    const curLogoRow = [...(settingsRef.current.logoRowSlots   ?? Array(3).fill(null))];
                    cur[i] = d.id; curSub[i] = null; curTag[i] = null; curQuo[i] = null; curLogoRow[i] = null;
                    settingsRef.current = { ...settingsRef.current, dividerSlots: cur, dividerSubSlots: curSub, tagSlots: curTag, quoteSlots: curQuo, logoRowSlots: curLogoRow };
                    onSettingsChange?.({ dividerSlots: cur, dividerSubSlots: curSub, tagSlots: curTag, quoteSlots: curQuo, logoRowSlots: curLogoRow });
                  }
                  onSlotDrop?.(i, d);
                } catch {}
              }}
            >
              {/* File input — always in DOM */}
              <input
                id={inputId}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={e => { handleLogoFile(i, e); setOpenSlot(null); }}
              />

              {/* Divider drag overlay — covers any existing content, always on top */}
              {((dragOverSlot === i && isDividerDrag) || (freeSnap?.row === i && freeSnap?.zi === -1)) && (
                <div className="absolute inset-0 rounded ring-2 ring-inset ring-white/70 bg-white/10 animate-pulse pointer-events-none z-20" />
              )}

              {/* Slot content — divider takes full row; uploaded image takes full row; otherwise per-zone independent cells */}
              {(() => {
                const imgSlot     = slots[i];
                const dividerSlot = settings.dividerSlots?.[i] ?? null;

                const RemoveBtn = ({ onRemove }: { onRemove: () => void }) => (
                  <button onClick={onRemove}
                    className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-black/80 border border-zinc-600 text-zinc-300 text-[9px] flex items-center justify-center hover:bg-red-900/90 hover:border-red-600 transition-colors leading-none z-10"
                  >×</button>
                );

                // Divider — occupies the entire row
                if (dividerSlot) {
                  const cbounds = getSubZoneCanvasBounds(dividerSlot, 0, 0, slotFwPv / DISPLAY_SCALE, LOGO_PH / DISPLAY_SCALE);
                  const szB = cbounds ? {
                    x: Math.round(cbounds.x * DISPLAY_SCALE),
                    y: Math.round(cbounds.y * DISPLAY_SCALE),
                    w: Math.round(cbounds.w * DISPLAY_SCALE),
                    h: Math.round(cbounds.h * DISPLAY_SCALE),
                  } : null;
                  const subContent  = settings.dividerSubSlots?.[i] ?? null;
                  const isSubFilled = !!subContent || subSlotFilled[i];
                  const isSubOpen   = openSubSlot === i;
                  const subInputId = `logo-sub-${instanceId}-${i}`;
                  return (
                    <div
                      className="relative w-full h-full overflow-visible cursor-grab active:cursor-grabbing"
                      onMouseDown={e => startZoneEscapeDrag(e, box => {
                        const s2 = settingsRef.current;
                        const divIdNow = s2.dividerSlots?.[i];
                        if (!divIdNow) return null;
                        const el: FreeElement = {
                          id: newElementId(), kind: 'divider', dividerId: divIdNow,
                          settings: s2.dividerSettings?.[i] ?? null, sub: s2.dividerSubSlots?.[i] ?? null,
                          x: box.x, y: box.y, width: box.w, height: box.h,
                        };
                        const cur    = [...(s2.dividerSlots    ?? Array(3).fill(null))];
                        const curSub = [...(s2.dividerSubSlots ?? Array(3).fill(null))] as (DividerSubSlotContent | null)[];
                        const curDs  = [...(s2.dividerSettings ?? Array(3).fill(null))] as (Partial<DividerStyleSettings> | null)[];
                        cur[i] = null; curSub[i] = null; curDs[i] = null;
                        return { el, clearPatch: { dividerSlots: cur, dividerSubSlots: curSub, dividerSettings: curDs } };
                      })}
                    >
                      <RemoveBtn onRemove={() => {
                        const cur = [...(settingsRef.current.dividerSlots ?? Array(3).fill(null))];
                        cur[i] = null;
                        const curSub = [...(settingsRef.current.dividerSubSlots ?? Array(3).fill(null))] as (DividerSubSlotContent | null)[];
                        curSub[i] = null;
                        onSettingsChange?.({ dividerSlots: cur, dividerSubSlots: curSub });
                      }} />
                      <input id={subInputId} type="file" accept="image/*" className="hidden"
                        onChange={e => { handleSubSlotFile(i, e); setOpenSubSlot(null); }} />
                      {szB && (
                        <button
                          ref={el => { subSlotBtnRefs.current[i] = el; }}
                          onMouseDown={e => startSubCropDrag(i, e)}
                          onClick={() => {
                            if (suppressSubClickRef.current) { suppressSubClickRef.current = false; return; }
                            setOpenSlot(null);
                            setShowSubCustom(false);
                            if (openSubSlot === i) {
                              setOpenSubSlot(null);
                              setSubDropdownPos(null);
                            } else {
                              const btn = subSlotBtnRefs.current[i];
                              if (btn) {
                                const r = btn.getBoundingClientRect();
                                setSubDropdownPos({ x: r.left, y: r.bottom + 4 });
                              }
                              setOpenSubSlot(i);
                            }
                          }}
                          onDragOver={e => { e.preventDefault(); e.stopPropagation(); setSubDragOverSlot(i); }}
                          onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setSubDragOverSlot(i); }}
                          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setSubDragOverSlot(null); }}
                          onDrop={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            setSubDragOverSlot(null);
                            try {
                              const d: SidebarElementData = JSON.parse(e.dataTransfer.getData('application/carousel-element'));
                              if (d.type === 'tag' && d.text && d.style) selectSubTag(i, d.text, d.style);
                              else if (d.type === 'logo') selectSubBrandLogo(i, d.url);
                              else if (d.type === 'swipe' && d.swipeStyle) selectSubSwipe(i, d.swipeStyle);
                            } catch {}
                          }}
                          title={settings.imageShape === 'circle' && subContent?.type === 'image' ? 'Drag to reposition · scroll to zoom' : undefined}
                          style={{ position: 'absolute', left: szB.x, top: szB.y, width: szB.w, height: szB.h, cursor: settings.imageShape === 'circle' && subContent?.type === 'image' ? 'grab' : undefined }}
                          className={`rounded transition-all ${
                            subDragOverSlot === i
                              ? 'ring-2 ring-inset ring-white/70 bg-white/15'
                              : isSubOpen
                              ? 'ring-2 ring-inset ring-white/60 bg-white/10'
                              : isSubFilled
                              ? 'hover:ring-1 hover:ring-inset hover:ring-white/35 hover:bg-white/8'
                              : 'ring-1 ring-inset ring-dashed ring-white/25 hover:ring-white/50 hover:bg-white/10'
                          }`}
                        />
                      )}
                    </div>
                  );
                }

                // Uploaded image — occupies the entire row
                if (imgSlot) {
                  const OBJ_POS    = ['top left','top center','top right','bottom left','bottom center','bottom right'] as const;
                  const FLEX_ALIGN = ['flex-start','center','flex-end','flex-start','center','flex-end'] as const;
                  const FLEX_JUST  = ['flex-start','center','flex-end','flex-start','center','flex-end'] as const;
                  return (
                    <div
                      className="relative w-full h-full flex"
                      style={{ alignItems: FLEX_ALIGN[i % 3], justifyContent: FLEX_JUST[i % 3], flexDirection: i < 3 ? 'column' : 'column-reverse' }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imgSlot.url} alt="" className="w-full h-full object-contain" style={{ objectPosition: OBJ_POS[i], opacity: (settings.logoOpacity ?? 100) / 100 }} />
                      <button
                        onClick={() => removeSlot(i)}
                        className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-black/80 border border-zinc-600 text-zinc-300 text-[9px] flex items-center justify-center hover:bg-red-900/90 hover:border-red-600 transition-colors leading-none z-10"
                      >×</button>
                    </div>
                  );
                }

                // Per-zone independent cells — each zone can hold a tag, logo, or quote independently
                return (
                  <>
                    <div className="absolute inset-0 flex gap-px">
                      {ZONES.map((zone, zi) => {
                        const fi          = i * 3 + zi;
                        const zoneTag     = settings.tagZoneSlots?.[fi]   ?? null;
                        const zoneLogo    = settings.zoneLogoSlots?.[fi]  ?? false;
                        const zoneQuote   = settings.quoteZoneSlots?.[fi] ?? null;
                        // Legacy slots — shown in the zone that matches their saved alignment
                        const legTagAlign  = (settings.tagSlotAligns?.[i]  ?? 'center') as 'left'|'center'|'right';
                        const legLogoAlign = (settings.logoSlotAligns?.[i] ?? 'center') as 'left'|'center'|'right';
                        const legTag       = settings.tagSlots?.[i]   ?? null;
                        const legQuote     = settings.quoteSlots?.[i]  ?? null;
                        const hasLegTag    = !!legTag   && legTagAlign  === zone;
                        const hasLegLogo   = !!(settingsRef.current.logoSlotAligns?.[i]) && legLogoAlign === zone && logoImgsRef.current[i] != null;
                        const hasLegQuote  = !!legQuote && legLogoAlign === zone;
                        const zoneSwipe    = settings.swipeZoneSlots?.[fi] ?? null;
                        const hasFilled    = !!zoneTag || zoneLogo || !!zoneQuote || !!zoneSwipe || hasLegTag || hasLegLogo || hasLegQuote;

                        if (hasFilled) {
                          const cellWCv = (slotFwPv / DISPLAY_SCALE) / 3;
                          const cellHCv = LOGO_PH / DISPLAY_SCALE;
                          const lvaCell = i === 0 ? 'top' as const : i === 2 ? 'bottom' as const : 'center' as const;
                          const crPayload: ContentPayload =
                            zoneTag ? { kind: 'tag', text: zoneTag.text, style: zoneTag.style } :
                            zoneLogo ? { kind: 'logo', img: zoneLogoImgsRef.current[fi] ?? null } :
                            zoneQuote ? { kind: 'quote', styleId: zoneQuote } :
                            zoneSwipe ? { kind: 'swipe', style: zoneSwipe } :
                            { kind: 'divider' };
                          const cr = contentRectInBox(crPayload, cellWCv, cellHCv, zone, lvaCell);
                          const xLeft = Math.max(0, Math.min(Math.round((cr.x + cr.w) * DISPLAY_SCALE) - 8, Math.round(cellWCv * DISPLAY_SCALE) - 16));
                          const xTop  = Math.max(-6, Math.round(cr.y * DISPLAY_SCALE) - 8);
                          // Click priority follows the Layers panel: give the filled cell a z from the
                          // unified layer order so it competes with image/text/free frames. (The row
                          // container drops its own stacking context above, so this z is global.)
                          const zoneLayerId =
                            zoneLogo    ? `zonelogo-${fi}`  :
                            zoneTag     ? `zonetag-${fi}`   :
                            zoneQuote   ? `zonequote-${fi}` :
                            zoneSwipe   ? `zoneswipe-${fi}` :
                            hasLegTag   ? `rowtag-${i}`     :
                            hasLegQuote ? `rowquote-${i}`   : null;
                          return (
                            <div
                              key={zone}
                              className="relative flex-1 h-full cursor-grab active:cursor-grabbing group/zonecell"
                              style={zoneLayerId ? { zIndex: frameZIndex(zoneLayerId, selectedZoneSlot?.index === fi) } : undefined}
                              onClick={() => {
                                if (zoneLogo) selectZone('logo', fi);
                                else if (zoneTag) selectZone('tag', fi);
                                else if (zoneQuote) selectZone('quote', fi);
                                else if (zoneSwipe) selectZone('swipe', fi);
                              }}
                              onMouseDown={e => startZoneEscapeDrag(e, box => {
                                const s2 = settingsRef.current;
                                const tagNow   = s2.tagZoneSlots?.[fi]   ?? null;
                                const logoNow  = s2.zoneLogoSlots?.[fi]  ?? null;
                                const quoteNow = s2.quoteZoneSlots?.[fi] ?? null;
                                const swipeNow = s2.swipeZoneSlots?.[fi] ?? null;
                                const id = newElementId();
                                const base = { id, x: box.x, y: box.y, width: box.w, height: box.h };
                                let el: FreeElement | null = null;
                                const clearPatch: Partial<CarouselSettings> = {};
                                if (tagNow) {
                                  el = { ...base, kind: 'tag', text: tagNow.text, style: tagNow.style };
                                  const cur = [...(s2.tagZoneSlots ?? Array(9).fill(null))]; cur[fi] = null;
                                  clearPatch.tagZoneSlots = cur;
                                } else if (logoNow) {
                                  el = { ...base, kind: 'logo', url: logoNow };
                                  const cur = [...(s2.zoneLogoSlots ?? Array(9).fill(null))]; cur[fi] = null;
                                  zoneLogoImgsRef.current[fi] = null;
                                  clearPatch.zoneLogoSlots = cur;
                                } else if (quoteNow) {
                                  el = { ...base, kind: 'quote', styleId: quoteNow };
                                  const cur = [...(s2.quoteZoneSlots ?? Array(9).fill(null))]; cur[fi] = null;
                                  clearPatch.quoteZoneSlots = cur;
                                } else if (swipeNow) {
                                  el = { ...base, kind: 'swipe', style: swipeNow };
                                  const cur = [...(s2.swipeZoneSlots ?? Array(9).fill(null))]; cur[fi] = null;
                                  clearPatch.swipeZoneSlots = cur;
                                }
                                return el ? { el, clearPatch } : null;   // legacy row slots stay put
                              })}
                            >
                              {selectedZoneSlot?.index === fi && (() => {
                                // Logos: match the drawn bounds (drawLogoFit fit+scale+anchor); other slots use the content rect.
                                const img = zoneLogoImgsRef.current[fi];
                                let rx = cr.x, ry = cr.y, rw = cr.w, rh = cr.h;
                                if (img && img.naturalWidth) {
                                  const fitS = Math.min(cellWCv / img.naturalWidth, cellHCv / img.naturalHeight);
                                  const sf = (settingsRef.current.zoneLogoStyles?.[fi]?.scale ?? settingsRef.current.logoScale ?? 100) / 100;
                                  rw = img.naturalWidth * fitS * sf;
                                  rh = img.naturalHeight * fitS * sf;
                                  rx = zone === 'left' ? 0 : zone === 'right' ? cellWCv - rw : (cellWCv - rw) / 2;
                                  ry = lvaCell === 'top' ? 0 : lvaCell === 'bottom' ? cellHCv - rh : (cellHCv - rh) / 2;
                                }
                                return (
                                  <div
                                    className="absolute pointer-events-none"
                                    style={{ left: rx * DISPLAY_SCALE, top: ry * DISPLAY_SCALE, width: rw * DISPLAY_SCALE, height: rh * DISPLAY_SCALE, background: 'rgba(255,255,255,0.05)', outline: '1px dashed rgba(255,255,255,0.35)', outlineOffset: '3px', borderRadius: 2, zIndex: 12 }}
                                  />
                                );
                              })()}
                              <button
                                onClick={() => {
                                  if (zoneTag || zoneLogo || zoneQuote || zoneSwipe) removeZoneSlot(i, zone);
                                  else removeSlot(i);
                                }}
                                style={{ left: xLeft, top: xTop }}
                                className="absolute w-4 h-4 rounded-full bg-black/80 border border-zinc-600 text-zinc-300 text-[9px] hidden group-hover/zonecell:flex items-center justify-center hover:bg-red-900/90 hover:border-red-600 transition-colors leading-none z-10"
                              >×</button>
                            </div>
                          );
                        }

                        return (
                          <button
                            key={zone}
                            onClick={() => {
                              pendingSlotZoneRef.current = zone;
                              if (openSlot === i) {
                                setOpenSlot(null);
                                setSlotDropdownPos(null);
                              } else {
                                const container = slotContainerRefs.current[i];
                                if (container) {
                                  const r = container.getBoundingClientRect();
                                  setSlotDropdownPos({ x: r.left, y: r.bottom + 4 });
                                }
                                setOpenSlot(i);
                              }
                            }}
                            className={`flex-1 h-full rounded-sm transition-colors ${
                              freeSnap && freeSnap.row === i && freeSnap.zi === zi
                                ? 'bg-white/25 ring-2 ring-inset ring-white/60'
                                : dragOverSlot === i && !isDividerDrag && dragOverZone === zone
                                ? 'bg-white/25 ring-2 ring-inset ring-white/60'
                                : dragOverSlot === i && !isDividerDrag
                                ? 'bg-white/8 ring-1 ring-inset ring-white/20'
                                : elementDrag
                                ? 'bg-white/5 ring-1 ring-inset ring-white/15 pointer-events-none'
                                : 'hover:bg-white/8 hover:ring-1 hover:ring-inset hover:ring-white/20'
                            }`}
                          />
                        );
                      })}
                    </div>

                  </>
                );
              })()}
            </div>
          );
        })}

        {/* ── Freeform element overlays — escaped skeleton-box content ── */}
        {(settings.freeElements ?? []).map((fe, idx) => {
          if (fe.hidden) return null;
          const isSel = selectedFreeEl === idx;
          const crPayload: ContentPayload =
            fe.kind === 'logo' ? { kind: 'logo', img: freeLogoImgsRef.current[fe.id] ?? null } :
            fe.kind === 'tag' ? { kind: 'tag', text: fe.text, style: fe.style } :
            fe.kind === 'quote' ? { kind: 'quote', styleId: fe.styleId } :
            fe.kind === 'swipe' ? { kind: 'swipe', style: fe.style } :
            { kind: 'divider' };
          const cr = contentRectInBox(crPayload, fe.width, fe.height, 'center', 'center');
          const FREE_HANDLES: { id: string; pos: React.CSSProperties; cur: string }[] = [
            { id: 'nw', pos: { top: -4, left: -4 },                       cur: 'nwse-resize' },
            { id: 'n',  pos: { top: -4, left: '50%', marginLeft: -4 },     cur: 'ns-resize'   },
            { id: 'ne', pos: { top: -4, right: -4 },                      cur: 'nesw-resize' },
            { id: 'e',  pos: { top: '50%', right: -4, marginTop: -4 },     cur: 'ew-resize'   },
            { id: 'se', pos: { bottom: -4, right: -4 },                   cur: 'nwse-resize' },
            { id: 's',  pos: { bottom: -4, left: '50%', marginLeft: -4 },  cur: 'ns-resize'   },
            { id: 'sw', pos: { bottom: -4, left: -4 },                    cur: 'nesw-resize' },
            { id: 'w',  pos: { top: '50%', left: -4, marginTop: -4 },      cur: 'ew-resize'   },
          ];
          return (
            <div
              key={fe.id}
              data-free-element=""
              onMouseDown={e => {
                if (e.button !== 0) return;
                if ((e.target as Element).closest('button')) return;
                e.stopPropagation();
                e.preventDefault();
                selectFreeElOnly(idx);
                bindFreeElementDrag(idx, e.clientX, e.clientY);
              }}
              className="absolute group cursor-grab active:cursor-grabbing"
              style={{
                left:   Math.round(fe.x * DISPLAY_SCALE),
                top:    Math.round(fe.y * DISPLAY_SCALE),
                width:  Math.max(14, Math.round(fe.width  * DISPLAY_SCALE)),
                height: Math.max(14, Math.round(fe.height * DISPLAY_SCALE)),
                zIndex: frameZIndex(fe.id, isSel),
                outline: isSel ? '1px solid rgba(96,165,250,0.95)' : 'none',
              }}
            >
              {/* No frame around the element — skeleton boxes are drop indicators, not part of the
                  element. Only the element's own × appears on hover; a selection outline + resize
                  handles appear once it's selected. */}
              <button
                onClick={e => { e.stopPropagation(); removeFreeElement(idx); }}
                aria-label="Remove element"
                title="Remove element"
                style={{
                  // Pushed further out (past the "ne" resize handle's ~8px footprint at this same
                  // corner) so the two don't overlap — the handle used to render on top of the ×.
                  left: Math.round((cr.x + cr.w) * DISPLAY_SCALE) + 4,
                  top:  Math.round(cr.y * DISPLAY_SCALE) - 20,
                }}
                className={`absolute size-4 rounded-full items-center justify-center bg-surface-overlay border border-line shadow-1 text-fg-3 hover:text-danger-text hover:bg-danger-tint hover:border-danger-border focus-ring transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] z-10 ${
                  isSel ? 'flex' : 'hidden group-hover:flex'
                }`}
              ><CloseIcon size={10} /></button>
              {isSel && FREE_HANDLES.map(h => (
                <div
                  key={h.id}
                  onMouseDown={e => {
                    e.stopPropagation();
                    e.preventDefault();
                    bindFreeElementResize(idx, h.id, e.clientX, e.clientY);
                  }}
                  style={{ position: 'absolute', ...h.pos, width: 8, height: 8, background: '#fff', border: '1px solid rgba(96,165,250,0.95)', borderRadius: 1, cursor: h.cur, zIndex: 10 }}
                />
              ))}
            </div>
          );
        })}

        {/* ── Rich text edit overlays ── */}
        {(() => {
          const headFontDef_ = resolveCarouselFont(settings.fontLabel);
          const subFontDef_  = resolveCarouselFont(settings.subFontLabel);
          const richW     = CAROUSEL_PREVIEW_W - 2 * padXPv;
          const headFsPv  = Math.round(settings.fontSize    * DISPLAY_SCALE);
          const subFsPv   = Math.round(settings.subFontSize * DISPLAY_SCALE);
          const headLhM   = 1.0 + (settings.lHeight    / 100) * 1.2;
          const subLhM    = 1.0 + (settings.subLHeight / 100) * 1.2;
          const headLsPv  = ((settings.lSpacing    / 100) * 20 * DISPLAY_SCALE).toFixed(2);
          const subLsPv   = ((settings.subLSpacing / 100) * 20 * DISPLAY_SCALE).toFixed(2);
          const headTopPv = blockTopPv;
          const subTopPv  = blockTopPv + headBlockHPv + gapPv;

          function saveSpans(el: HTMLElement, isHead: boolean) {
            const spans = htmlToSpans(el);
            const newText = spans.map(s => s.text).join('');
            const hasCustomStyle = spans.some(s => s.color || s.bold || s.italic);
            onSettingsChange?.(isHead
              ? { headlineSpans: hasCustomStyle ? spans : null }
              : { subSpans:      hasCustomStyle ? spans : null });
            if (isHead && newText !== headline)    onHeadlineChange?.(newText);
            if (!isHead && newText !== subheadline) onSubheadlineChange?.(newText);
          }

          const editStyle = (top: number, fs: number, fontFamily: string, fw: number | string, fi: boolean, lh: number, ls: string, align: CarouselTextAlign, minH: number): React.CSSProperties => ({
            position:     'absolute',
            top,
            left:         padXPv,
            width:        richW,
            minHeight:    Math.max(minH, headFsPv),
            fontSize:     fs,
            fontFamily,
            fontWeight:   fw,
            fontStyle:    fi ? 'italic' : 'normal',
            color:        '#ffffff',
            lineHeight:   lh,
            letterSpacing: `${ls}px`,
            textAlign:    align === 'justify' ? 'left' : align,
            background:   'rgba(255,255,255,0.05)',
            outline:      '1px dashed rgba(255,255,255,0.35)',
            outlineOffset: '3px',
            borderRadius: 2,
            whiteSpace:   'pre-wrap',
            wordBreak:    'break-word',
            caretColor:   '#fff',
            zIndex:       10,
            boxSizing:    'border-box',
            padding:      0,
          });

          return (
            <>
              {/* Click targets for entering rich text mode */}
              {!richEditTarget && headline.trim() && headBlockHPv > 0 && (
                <div
                  data-carousel-slot=""
                  title="Click to style — drag to pull out of the layout"
                  className="group"
                  onClick={() => { if (headlineRef.current.trim()) selectRichEditOnly('headline'); }}
                  onMouseDown={e => startSlotTextEscapeDrag(e, 'headline')}
                  style={{
                    position: 'absolute',
                    top: headTopPv, left: padXPv,
                    width: richW, height: headBlockHPv,
                    cursor: 'grab', zIndex: frameZIndex(HEADLINE_LAYER_ID, false),
                  }}
                >
                  <button
                    title="Remove headline"
                    aria-label="Remove headline"
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onHeadlineChange?.(''); setRichEditTarget(null); }}
                    className="absolute -top-2 -right-2 size-5 rounded-full bg-surface-overlay border border-line shadow-1 text-fg-3 hidden group-hover:flex items-center justify-center hover:text-danger-text hover:bg-danger-tint hover:border-danger-border focus-ring transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] z-10"
                  ><CloseIcon size={12} /></button>
                </div>
              )}
              {!richEditTarget && subheadline.trim() && subBlockHPv > 0 && (
                <div
                  data-carousel-slot=""
                  title="Click to style — drag to pull out of the layout"
                  className="group"
                  onClick={() => { if (subheadlineRef.current.trim()) selectRichEditOnly('sub'); }}
                  onMouseDown={e => startSlotTextEscapeDrag(e, 'sub')}
                  style={{
                    position: 'absolute',
                    top: subTopPv, left: padXPv,
                    width: richW, height: subBlockHPv,
                    cursor: 'grab', zIndex: frameZIndex(SUB_LAYER_ID, false),
                  }}
                >
                  <button
                    title="Remove sub-headline"
                    aria-label="Remove sub-headline"
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onSubheadlineChange?.(''); setRichEditTarget(null); }}
                    className="absolute -top-2 -right-2 size-5 rounded-full bg-surface-overlay border border-line shadow-1 text-fg-3 hidden group-hover:flex items-center justify-center hover:text-danger-text hover:bg-danger-tint hover:border-danger-border focus-ring transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] z-10"
                  ><CloseIcon size={12} /></button>
                </div>
              )}

              {/* Headline/sub slot indicators.
                  Text drag  → vacant slots are DROP TARGETS (labeled dashed bands);
                               occupied slots get a faint outline (position anchor).
                  Element drag → only occupied slots get the faint outline, so the
                               element rows never tangle with text drop bands. */}
              {(textDrag || elementDrag) && (() => {
                const bands = textSlotBands();
                const mk = (which: 'headline' | 'sub', band: { top: number; height: number }, occupied: boolean) => {
                  if (occupied) {
                    return (
                      <div
                        key={which}
                        className="absolute rounded ring-1 ring-inset ring-white/15 pointer-events-none"
                        style={{ top: band.top, left: padXPv, width: richW, height: band.height, zIndex: 3 }}
                      />
                    );
                  }
                  if (!textDrag) return null;
                  const hot = textSnap === which;
                  // Outer div = generous invisible hit area; inner div = the exact
                  // one-line visual band.
                  return (
                    <div
                      key={which}
                      data-carousel-slot=""
                      onDragOver={e => {
                        if (!e.dataTransfer.types.includes('application/carousel-element-type/text')) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setTextSnap(which);
                      }}
                      onDragLeave={() => { if (textSnapRef.current === which) setTextSnap(null); }}
                      onDrop={e => {
                        if (!e.dataTransfer.types.includes('application/carousel-element-type/text')) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setTextSnap(null);
                        try {
                          const d = JSON.parse(e.dataTransfer.getData('application/carousel-element')) as SidebarElementData;
                          if (d.type === 'text') applyTextPresetToSlot(which, d.textPreset ?? {}, d.text ?? 'Your text here');
                        } catch { /* ignore */ }
                      }}
                      style={{
                        position: 'absolute',
                        top: band.top - TEXT_SLOT_HIT_PAD, left: padXPv - 12,
                        width: richW + 24, height: band.height + TEXT_SLOT_HIT_PAD * 2,
                        zIndex: 6,
                        pointerEvents: draggingKind === 'text' ? 'auto' : 'none',
                      }}
                    >
                      <div
                        className={`absolute rounded transition-colors flex items-center justify-center ${
                          hot ? 'ring-2 ring-inset ring-white/70 bg-white/15' : 'ring-1 ring-inset ring-dashed ring-white/25 bg-white/5'
                        }`}
                        style={{ top: TEXT_SLOT_HIT_PAD, left: 12, width: richW, height: band.height }}
                      >
                        <span className="text-[9px] uppercase tracking-widest text-white/40 select-none">
                          {which === 'headline' ? 'Headline' : 'Sub-headline'}
                        </span>
                      </div>
                    </div>
                  );
                };
                return <>
                  {mk('headline', bands.head, bands.headOccupied)}
                  {mk('sub', bands.sub, bands.subOccupied)}
                </>;
              })()}

              {/* ContentEditable for headline */}
              {richEditTarget === 'headline' && (
                <div
                  ref={richEditRef}
                  key="rich-head"
                  contentEditable
                  suppressContentEditableWarning
                  spellCheck={false}
                  data-carousel-slot=""
                  style={editStyle(headTopPv, headFsPv, headFontDef_.css, settings.fontWeight, settings.italic, headLhM, headLsPv, settings.textAlign, headBlockHPv)}
                  onInput={e => highlightPlaceholders(e.currentTarget)}
                  onBlur={e => { saveSpans(e.currentTarget, true); setRichEditTarget(null); }}
                  onKeyDown={e => { if (e.key === 'Escape') setRichEditTarget(null); }}
                />
              )}

              {/* ContentEditable for subheadline */}
              {richEditTarget === 'sub' && (
                <div
                  ref={richEditRef}
                  key="rich-sub"
                  contentEditable
                  suppressContentEditableWarning
                  spellCheck={false}
                  data-carousel-slot=""
                  style={editStyle(subTopPv, subFsPv, subFontDef_.css, settings.subFontWeight, settings.subItalic, subLhM, subLsPv, settings.subTextAlign, subBlockHPv)}
                  onInput={e => highlightPlaceholders(e.currentTarget)}
                  onBlur={e => { saveSpans(e.currentTarget, false); setRichEditTarget(null); }}
                  onKeyDown={e => { if (e.key === 'Escape') setRichEditTarget(null); }}
                />
              )}

              {/* Floating toolbar — shows when text is selected in contentEditable */}
              {toolbarPos && richEditTarget && (
                <div
                  data-carousel-slot=""
                  onMouseDown={e => e.preventDefault()}
                  style={{
                    position:     'fixed',
                    top:          Math.max(8, toolbarPos.top),
                    left:         Math.max(8, toolbarPos.left),
                    zIndex:       9999,
                    display:      'flex',
                    alignItems:   'center',
                    gap:          3,
                    padding:      '5px 7px',
                    background:   'var(--surface-overlay)',
                    border:       '1px solid var(--line)',
                    borderRadius: 9,
                    backdropFilter: 'blur(10px)',
                    boxShadow:    'var(--shadow-2)',
                  }}
                >
                  {/* Colour swatches */}
                  {RICH_COLORS.map(c => (
                    <button
                      key={c}
                      onMouseDown={e => { e.preventDefault(); document.execCommand('foreColor', false, c); }}
                      style={{
                        width: 13, height: 13, borderRadius: '50%',
                        background: c, border: '1px solid var(--line-strong)',
                        cursor: 'pointer', flexShrink: 0, padding: 0,
                      }}
                      title={c}
                    />
                  ))}
                  {/* Custom colour */}
                  <label
                    style={{ position: 'relative', width: 13, height: 13, cursor: 'pointer', flexShrink: 0 }}
                    title="Custom colour"
                    onMouseDown={() => {
                      const sel = window.getSelection();
                      if (sel && sel.rangeCount > 0 && richEditRef.current?.contains(sel.anchorNode)) {
                        savedSelRef.current = sel.getRangeAt(0).cloneRange();
                      }
                    }}
                  >
                    <div style={{
                      width: 13, height: 13, borderRadius: '50%',
                      background: 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)',
                      border: '1px solid var(--line-strong)',
                      pointerEvents: 'none',
                    }} />
                    <input
                      type="color"
                      style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer', padding: 0, border: 'none' }}
                      onChange={e => {
                        const hex = (e.target as HTMLInputElement).value;
                        const savedRange = savedSelRef.current;
                        savedSelRef.current = null;
                        if (!richEditRef.current || !savedRange) return;
                        richEditRef.current.focus();
                        setTimeout(() => {
                          const sel = window.getSelection();
                          sel?.removeAllRanges();
                          sel?.addRange(savedRange);
                          document.execCommand('foreColor', false, hex);
                        }, 0);
                      }}
                    />
                  </label>

                  {/* Separator */}
                  <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.18)', margin: '0 2px' }} />

                  {/* Bold */}
                  <button
                    onMouseDown={e => { e.preventDefault(); document.execCommand('bold'); }}
                    style={{ width: 22, height: 22, background: 'none', border: 'none', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer', borderRadius: 4, padding: 0 }}
                    title="Bold"
                  >B</button>

                  {/* Italic */}
                  <button
                    onMouseDown={e => { e.preventDefault(); document.execCommand('italic'); }}
                    style={{ width: 22, height: 22, background: 'none', border: 'none', color: '#fff', fontStyle: 'italic', fontSize: 12, cursor: 'pointer', borderRadius: 4, padding: 0 }}
                    title="Italic"
                  >I</button>

                  {/* Separator */}
                  <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.18)', margin: '0 2px' }} />

                  {/* Clear formatting */}
                  <button
                    onMouseDown={e => { e.preventDefault(); document.execCommand('removeFormat'); }}
                    style={{ width: 22, height: 22, background: 'none', border: 'none', color: '#a1a1aa', fontSize: 10, cursor: 'pointer', borderRadius: 4, padding: 0 }}
                    title="Clear formatting"
                  >✕</button>
                </div>
              )}
            </>
          );
        })()}

        {/* ── Circle placeholder (rectMode) — sits between top-3 and bottom-3 tag slots ── */}
        {/* ── Circle placeholders — hidden in video mode, and gated by layerOrder so      ── */}
        {/*    removing 'circle'/'circle2' from layer order also removes the upload slot   ── */}
        {!videoSrc && (rectMode ? [0] : [0, 1])
          .filter(ci => (settings.layerOrder ?? ['background', 'subject']).includes(ci === 0 ? 'circle' : 'circle2'))
          .map(ci => {
          const RECT_GAP    = 8;
          const _bandTop    = padXPv + LOGO_PH + RECT_GAP;
          const _bandBottom = aboveHLTop - RECT_GAP;
          const _bandH      = Math.max(0, _bandBottom - _bandTop);
          if (rectMode) {
            // Keep band ref in sync for canvas drawRect
            rectBandRef.current = { top: _bandTop, bottom: _bandBottom, left: padXPv, right: CAROUSEL_PREVIEW_W - padXPv };
          }
          const circleSrc       = circleSrcs[ci];
          const circlePos       = circlePoses[ci];
          const circleRadius    = circleRadii[ci];
          const circleElRef     = ci === 0 ? circleEl0Ref : circleEl1Ref;
          const circleInputRef  = ci === 0 ? circleInput0Ref : circleInput1Ref;
          const editMode        = circleImgEditModes[ci];
          const isImgDragging   = activeImgDragCircle === ci;
          const defaultX        = rectMode ? Math.round(CAROUSEL_PREVIEW_W / 2 + 50) : (ci === 0 ? Math.round(CAROUSEL_PREVIEW_W / 4) : Math.round(CAROUSEL_PREVIEW_W * 3 / 4));
          const defaultCy       = rectMode ? Math.round((_bandTop + _bandBottom) / 2) : (padXPv + LOGO_PH + aboveHLTop) / 2;
          const circleCxPv      = circlePos?.x ?? defaultX;
          const circleCyPv      = circlePos?.y ?? defaultCy;
          const r               = circleRadius;
          const d               = r * 2;
          const bw              = ci === 0 ? settings.circleBorderWidth   : settings.circle2BorderWidth;
          const bo              = ci === 0 ? settings.circleBorderOpacity : settings.circle2BorderOpacity;
          const bc              = ci === 0 ? settings.circleBorderColor   : settings.circle2BorderColor;
          const cssBW           = Math.max(1, Math.round(bw * DISPLAY_SCALE));
          const boxShadowVal    = (!blurLayerActive && circleSrc && bw > 0 && bo > 0)
            ? `0 0 0 ${cssBW}px ${hexToRgba(bc, bo / 100)}`
            : '';
          const handleOffset    = r * 0.707;
          return (
            <React.Fragment key={ci}>
              {/* Circle element */}
              <div
                ref={circleElRef}
                data-carousel-slot=""
                onMouseDown={e => {
                  if (!circleSrc) return;
                  e.preventDefault();
                  if (editMode) {
                    circleImgDragStart.current = { mx: e.clientX, my: e.clientY, ox: circleImgOffsetsArr.current[ci].x, oy: circleImgOffsetsArr.current[ci].y };
                    setActiveImgDragCircle(ci);
                    // Bind synchronously so the release is always caught (see note above the resize effects).
                    const onMove = (ev: MouseEvent) => {
                      const dx = ev.clientX - circleImgDragStart.current.mx;
                      const dy = ev.clientY - circleImgDragStart.current.my;
                      circleImgOffsetsArr.current[ci] = {
                        x: circleImgDragStart.current.ox + dx / DISPLAY_SCALE,
                        y: circleImgDragStart.current.oy + dy / DISPLAY_SCALE,
                      };
                      redraw(cachedImgRef.current);
                    };
                    const onUp = () => { setActiveImgDragCircle(null); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                  } else {
                    const cx = circlePosRefsArr.current[ci]?.x ?? defaultX;
                    const cy = circlePosRefsArr.current[ci]?.y ?? defaultCy;
                    circleDragStart.current = { mx: e.clientX, my: e.clientY, cx, cy };
                    setActiveDragCircle(ci);
                    const onMove = (ev: MouseEvent) => {
                      const dx = ev.clientX - circleDragStart.current.mx;
                      const dy = ev.clientY - circleDragStart.current.my;
                      const r = circleRadsArr.current[ci];
                      const newX = Math.max(r, Math.min(CAROUSEL_PREVIEW_W - r, circleDragStart.current.cx + dx));
                      const newY = Math.max(r, Math.min(CAROUSEL_PREVIEW_H - r, circleDragStart.current.cy + dy));
                      circlePosRefsArr.current[ci] = { x: newX, y: newY };
                      setCirclePoses(prev => { const n = [...prev]; n[ci] = { x: newX, y: newY }; return n; });
                      redraw(cachedImgRef.current);
                    };
                    const onUp = () => { setActiveDragCircle(null); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                  }
                }}
                style={{
                  position: 'absolute',
                  left: circleCxPv - r, top: circleCyPv - r,
                  width: d, height: d,
                  borderRadius: '50%',
                  zIndex: 3,
                  cursor: circleSrc ? (editMode ? (isImgDragging ? 'grabbing' : 'grab') : 'move') : 'default',
                  outline: circleSrc && (editMode || blurLayerActive) ? '2px dashed rgba(255,255,255,0.5)' : undefined,
                  outlineOffset: '3px',
                  ...(boxShadowVal ? { boxShadow: boxShadowVal } : {}),
                }}
              >
                {circleSrc ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={circleSrc} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', borderRadius: '50%', pointerEvents: 'none', visibility: blurLayerActive ? 'hidden' : 'visible' }} />
                    {!editMode && (
                      <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={() => {
                          setCircleSrcs(prev => { const n = [...prev]; n[ci] = null; return n; });
                          circlePosRefsArr.current[ci]    = null;
                          setCirclePoses(prev => { const n = [...prev]; n[ci] = null; return n; });
                          circleRadsArr.current[ci]        = 90;
                          setCircleRadii(prev => { const n = [...prev]; n[ci] = 90; return n; });
                          circleImgOffsetsArr.current[ci]  = { x: 0, y: 0 };
                          circleImgScalesArr.current[ci]   = 1;
                        }}
                        className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-black/80 border border-zinc-600 text-zinc-300 text-[10px] flex items-center justify-center hover:bg-red-900/90 hover:border-red-600 transition-colors leading-none z-10"
                      >×</button>
                    )}
                  </>
                ) : (
                  <button
                    onMouseDown={e => e.stopPropagation()}
                    onClick={() => circleInputRef.current?.click()}
                    className="group w-full h-full flex items-center justify-center transition-colors text-white/40 hover:text-white/70 relative"
                  >
                    <svg width={d} height={d} className="absolute inset-0" style={{ pointerEvents: 'none' }}>
                      <circle
                        cx={r} cy={r} r={r - 0.5}
                        fill="rgba(255,255,255,0.10)" strokeWidth="1" strokeDasharray="3 3"
                        className="stroke-white/40 group-hover:stroke-white/70 transition-colors"
                      />
                    </svg>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                  </button>
                )}
              </div>

              {/* Edit / Done toolbar */}
              {circleSrc && (
                <div data-carousel-slot="" style={{ position: 'absolute', left: circleCxPv, top: circleCyPv + r + 5, transform: 'translateX(-50%)', display: 'flex', gap: 3, zIndex: 10 }}>
                  {editMode ? (
                    <button onMouseDown={e => e.stopPropagation()} onClick={() => setCircleImgEditModes(prev => { const n=[...prev]; n[ci]=false; return n; })}
                      style={{ padding: '2px 9px', background: '#fff', border: 'none', borderRadius: 4, color: '#000', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>Done</button>
                  ) : (
                    <button onMouseDown={e => e.stopPropagation()} onClick={() => setCircleImgEditModes(prev => { const n=[...prev]; n[ci]=true; return n; })}
                      style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 6px', background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.22)', borderRadius: 4, color: 'rgba(255,255,255,0.8)', fontSize: 9, cursor: 'pointer' }}>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/>
                        <line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>
                      </svg>
                      Edit
                    </button>
                  )}
                </div>
              )}

              {/* Resize handle SE */}
              {circleSrc && !editMode && (
                <div data-carousel-slot="" onMouseDown={e => {
                  e.stopPropagation(); e.preventDefault();
                  const cx = circlePosRefsArr.current[ci]?.x ?? defaultX;
                  const cy = circlePosRefsArr.current[ci]?.y ?? defaultCy;
                  circleResizeStart.current = { cx, cy };
                  setActiveResizeCircle(ci);
                  const onMove = (ev: MouseEvent) => {
                    const bounds = wrapperRef.current?.getBoundingClientRect();
                    if (!bounds) return;
                    const mx = ev.clientX - bounds.left;
                    const my = ev.clientY - bounds.top;
                    const s = circleResizeStart.current;
                    const dist = Math.sqrt((mx - s.cx) ** 2 + (my - s.cy) ** 2);
                    const maxR = Math.min(CAROUSEL_PREVIEW_W, CAROUSEL_PREVIEW_H) / 2;
                    const newR = Math.max(20, Math.min(maxR, Math.round(dist)));
                    circleRadsArr.current[ci] = newR;
                    setCircleRadii(prev => { const n = [...prev]; n[ci] = newR; return n; });
                    redraw(cachedImgRef.current);
                  };
                  const onUp = () => { setActiveResizeCircle(null); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
                  window.addEventListener('mousemove', onMove);
                  window.addEventListener('mouseup', onUp);
                }} title="Drag to resize"
                  style={{ position: 'absolute', left: circleCxPv + handleOffset - 5, top: circleCyPv + handleOffset - 5, width: 10, height: 10, background: '#fff', border: '1.5px solid rgba(0,0,0,0.4)', borderRadius: 3, cursor: 'nwse-resize', zIndex: 10 }}
                />
              )}

              {/* Zoom handle SW */}
              {circleSrc && !editMode && (
                <div data-carousel-slot="" onMouseDown={e => {
                  e.stopPropagation(); e.preventDefault();
                  circleZoomDragStart.current = { my: e.clientY, scale: circleImgScalesArr.current[ci] };
                  setActiveZoomDragCircle(ci);
                  const onMove = (ev: MouseEvent) => {
                    const dy = ev.clientY - circleZoomDragStart.current.my;
                    const newScale = Math.max(0.5, Math.min(10, circleZoomDragStart.current.scale * Math.exp(-dy / 80)));
                    circleImgScalesArr.current[ci] = newScale;
                    redraw(cachedImgRef.current);
                  };
                  const onUp = () => { setActiveZoomDragCircle(null); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
                  window.addEventListener('mousemove', onMove);
                  window.addEventListener('mouseup', onUp);
                }} title="Drag up to zoom in, down to zoom out"
                  style={{ position: 'absolute', left: circleCxPv - handleOffset - 5, top: circleCyPv + handleOffset - 5, width: 10, height: 10, background: '#a3e635', border: '1.5px solid rgba(0,0,0,0.4)', borderRadius: 3, cursor: 'ns-resize', zIndex: 10 }}
                />
              )}

              {/* Hidden file input */}
              <input ref={circleInputRef} type="file" accept="image/*" className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  // Lock circle to placeholder position on first upload so canvas and HTML overlay are in sync
                  if (!circlePosRefsArr.current[ci]) {
                    const pos = { x: defaultX, y: Math.round(defaultCy) };
                    circlePosRefsArr.current[ci] = pos;
                    setCirclePoses(prev => { const n=[...prev]; n[ci]=pos; return n; });
                  }
                  circleImgOffsetsArr.current[ci] = { x: 0, y: 0 };
                  circleImgScalesArr.current[ci]  = 1;
                  setCircleImgEditModes(prev => { const n=[...prev]; n[ci]=false; return n; });
                  setCircleSrcs(prev => { const n=[...prev]; n[ci]=URL.createObjectURL(f); return n; });
                  e.target.value = '';
                }}
              />
            </React.Fragment>
          );
        })}

        {/* ── Free text box frames (select to move/resize; the text itself is on the canvas) ── */}
        {(settings.textBoxes ?? []).map((tb, idx) => {
          const isActive   = activeDragTextBox === idx;
          const isSelected = selectedTextBox === idx;
          if (tb.hidden) return null;
          const locked = !!tb.locked;
          const bw = tb.width  ?? 540;
          // Auto-height (non-fit-to-width): the frame uses the measured wrapped-text height so the blue
          // box hugs the text vertically. fit-to-width boxes keep their fixed, fill-the-box height.
          const autoH = !tb.fitToWidth;
          const bh = autoH ? (textBoxHeights[tb.id] ?? tb.height ?? 200) : (tb.height ?? 200);
          const ALL_HANDLES: { id: string; pos: React.CSSProperties; cur: string }[] = [
            { id: 'nw', pos: { top: -4, left: -4 },                       cur: 'nwse-resize' },
            { id: 'n',  pos: { top: -4, left: '50%', marginLeft: -4 },     cur: 'ns-resize'   },
            { id: 'ne', pos: { top: -4, right: -4 },                      cur: 'nesw-resize' },
            { id: 'e',  pos: { top: '50%', right: -4, marginTop: -4 },     cur: 'ew-resize'   },
            { id: 'se', pos: { bottom: -4, right: -4 },                   cur: 'nwse-resize' },
            { id: 's',  pos: { bottom: -4, left: '50%', marginLeft: -4 },  cur: 'ns-resize'   },
            { id: 'sw', pos: { bottom: -4, left: -4 },                    cur: 'nesw-resize' },
            { id: 'w',  pos: { top: '50%', left: -4, marginTop: -4 },      cur: 'ew-resize'   },
          ];
          // Auto-height boxes resize WIDTH only — drop the pure-vertical (top/bottom-centre) handles.
          const HANDLES = autoH ? ALL_HANDLES.filter(h => h.id !== 'n' && h.id !== 's') : ALL_HANDLES;
          return (
            <div
              key={tb.id}
              data-carousel-slot=""
              onMouseDown={e => {
                e.stopPropagation();
                e.preventDefault();
                if (editingTextBox === idx) return;   // editing this box — let the editor handle clicks
                selectTextBoxOnly(idx);
                textBoxDragStart.current = { mx: e.clientX, my: e.clientY, x: tb.x, y: tb.y };
                setActiveDragTextBox(idx);
                setTextDragActive(true);
                // Bind synchronously so the box releases on mouse-up (see note above the image-box effects).
                const SNAP = 12, EDGE = 60;
                const onMove = (ev: MouseEvent) => {
                  const box = settingsRef.current.textBoxes?.[idx];
                  const bw2 = box?.width ?? 540, bh2 = tb.fitToWidth ? (box?.height ?? 200) : (textBoxHeights[tb.id] ?? box?.height ?? 200);
                  const dxPx = (ev.clientX - textBoxDragStart.current.mx) / DISPLAY_SCALE;
                  const dyPx = (ev.clientY - textBoxDragStart.current.my) / DISPLAY_SCALE;
                  let nx = Math.max(0, Math.min(W, Math.round(textBoxDragStart.current.x + dxPx)));
                  let ny = Math.max(0, Math.min(H, Math.round(textBoxDragStart.current.y + dyPx)));
                  const xT = [[0, 0], [EDGE, EDGE], [Math.round(W / 2 - bw2 / 2), Math.round(W / 2)], [W - EDGE - bw2, W - EDGE], [W - bw2, W]];
                  const yT = [[0, 0], [EDGE, EDGE], [Math.round(H / 2 - bh2 / 2), Math.round(H / 2)], [H - EDGE - bh2, H - EDGE], [H - bh2, H]];
                  let gx: number | null = null, gy: number | null = null;
                  for (const [tx, g] of xT) { if (Math.abs(nx - tx) <= SNAP) { nx = tx; gx = g; break; } }
                  for (const [ty, g] of yT) { if (Math.abs(ny - ty) <= SNAP) { ny = ty; gy = g; break; } }
                  setSnapGuideX(gx); setSnapGuideY(gy);
                  const cur = [...(settingsRef.current.textBoxes ?? [])];
                  if (!cur[idx]) return;
                  cur[idx] = { ...cur[idx], x: nx, y: ny };
                  settingsRef.current = { ...settingsRef.current, textBoxes: cur };
                  onSettingsChange?.({ textBoxes: cur });
                  setTextSnap(hitTextSlot(ev.clientX, ev.clientY));
                  redraw(cachedImgRef.current);
                };
                const onUp = () => {
                  setActiveDragTextBox(null); setSnapGuideX(null); setSnapGuideY(null);
                  window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
                  const snap = textSnapRef.current;
                  setTextDragActive(false);
                  setTextSnap(null);
                  if (snap) snapTextBoxIntoSlot(idx, snap);   // vacant headline/sub inherits this box's styling
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
              onDoubleClick={e => {
                e.stopPropagation();
                if (locked) return;
                selectTextBoxOnly(idx);
                setEditingTextBox(idx);
              }}
              style={{
                position: 'absolute',
                left:   tb.x * DISPLAY_SCALE,
                top:    tb.y * DISPLAY_SCALE,
                width:  bw * DISPLAY_SCALE,
                height: bh * DISPLAY_SCALE,
                cursor: isActive ? 'grabbing' : 'grab',
                userSelect: 'none',
                pointerEvents: locked ? 'none' : undefined,
                outline: isSelected ? `1px ${locked ? 'dashed' : 'solid'} rgba(96,165,250,0.95)` : `1px dashed rgba(255,255,255,${isActive ? 0.85 : 0.28})`,
                zIndex:  frameZIndex(tb.id, isSelected),
              }}
            >
              {isSelected && !locked && HANDLES.map(h => (
                <div
                  key={h.id}
                  onMouseDown={e => {
                    e.stopPropagation();
                    e.preventDefault();
                    textBoxResizeStart.current = { handle: h.id, mx: e.clientX, my: e.clientY, x: tb.x, y: tb.y, w: bw, h: bh };
                    setActiveResizeTextBox(idx);
                    const MIN = 30;
                    const onMove = (ev: MouseEvent) => {
                      const s0 = textBoxResizeStart.current;
                      const dx = Math.round((ev.clientX - s0.mx) / DISPLAY_SCALE);
                      const dy = Math.round((ev.clientY - s0.my) / DISPLAY_SCALE);
                      const hasE = s0.handle.includes('e'), hasW = s0.handle.includes('w');
                      const hasS = s0.handle.includes('s'), hasN = s0.handle.includes('n');
                      let w = s0.w + (hasE ? dx : hasW ? -dx : 0);
                      let h = s0.h + (hasS ? dy : hasN ? -dy : 0);
                      let gx: number | null = null, gy: number | null = null;
                      if (!autoH && ev.shiftKey && (hasE || hasW) && (hasS || hasN) && s0.w > 0 && s0.h > 0) {
                        let scale = Math.abs(w / s0.w - 1) >= Math.abs(h / s0.h - 1) ? w / s0.w : h / s0.h;
                        scale = Math.max(scale, MIN / s0.w, MIN / s0.h);
                        w = Math.round(s0.w * scale);
                        h = Math.round(s0.h * scale);
                      } else {
                        if (hasE)      { const g = nearestGuide(s0.x + w, X_GUIDES);          if (g !== null && g - s0.x >= MIN) { w = g - s0.x; gx = g; } }
                        else if (hasW) { const g = nearestGuide(s0.x + s0.w - w, X_GUIDES);   if (g !== null && s0.x + s0.w - g >= MIN) { w = s0.x + s0.w - g; gx = g; } }
                        if (!autoH) {
                          if (hasS)      { const g = nearestGuide(s0.y + h, Y_GUIDES);          if (g !== null && g - s0.y >= MIN) { h = g - s0.y; gy = g; } }
                          else if (hasN) { const g = nearestGuide(s0.y + s0.h - h, Y_GUIDES);   if (g !== null && s0.y + s0.h - g >= MIN) { h = s0.y + s0.h - g; gy = g; } }
                        }
                        w = Math.max(MIN, w);
                        h = Math.max(MIN, h);
                      }
                      // Auto-height boxes never change height/y from a resize — the content drives height.
                      if (autoH) h = s0.h;
                      // No top/left clamp: let x/y go negative so a box can extend past the
                      // top/left edges (clipped by the wrapper), symmetric with right/bottom.
                      const x = hasW ? s0.x + s0.w - w : s0.x;
                      const y = (!autoH && hasN) ? s0.y + s0.h - h : s0.y;
                      setSnapGuideX(gx); setSnapGuideY(gy);
                      const cur = [...(settingsRef.current.textBoxes ?? [])];
                      if (!cur[idx]) return;
                      cur[idx] = { ...cur[idx], x, y, width: w, height: h };
                      settingsRef.current = { ...settingsRef.current, textBoxes: cur };
                      onSettingsChange?.({ textBoxes: cur });
                      redraw(cachedImgRef.current);
                    };
                    const onUp = () => { setActiveResizeTextBox(null); setSnapGuideX(null); setSnapGuideY(null); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                  }}
                  style={{
                    position: 'absolute',
                    ...h.pos,
                    width: 8, height: 8,
                    background: '#fff',
                    border: '1px solid rgba(96,165,250,0.95)',
                    borderRadius: 1,
                    cursor: h.cur,
                    zIndex: 10,
                  }}
                />
              ))}
            </div>
          );
        })}

        {/* ── Inline text-box editor (double-click a text box to type into it) ── */}
        {editingTextBox != null && (settings.textBoxes ?? [])[editingTextBox] && (() => {
          const tb = (settings.textBoxes ?? [])[editingTextBox];
          const tbFont = resolveCarouselFont(tb.fontLabel);
          const va = tb.vAlign ?? 'top';
          const editAutoH = !tb.fitToWidth;   // auto-height boxes grow with typed content
          return (
            // Outer wrapper owns position + vertical alignment (flex column). The contentEditable itself
            // must stay a normal block so styled runs flow inline and wrap like the canvas render — a flex
            // contentEditable would make every <span> its own column item and stack each run on its own line.
            <div
              onMouseDown={e => { e.stopPropagation(); if (e.target === e.currentTarget) { e.preventDefault(); editTextRef.current?.focus(); } }}
              style={{
                position: 'absolute',
                left:   tb.x * DISPLAY_SCALE,
                top:    tb.y * DISPLAY_SCALE,
                width:  (tb.width  ?? 540) * DISPLAY_SCALE,
                height: editAutoH ? 'auto' : (tb.height ?? 200) * DISPLAY_SCALE,
                display: 'flex', flexDirection: 'column',
                justifyContent: editAutoH ? 'flex-start' : (va === 'middle' ? 'center' : va === 'bottom' ? 'flex-end' : 'flex-start'),
                overflow: editAutoH ? 'visible' : 'hidden',
                outline: '1px solid rgba(96,165,250,0.95)',
                cursor: 'text', zIndex: 30,
              }}
            >
              <div
                ref={editTextRef}
                contentEditable
                suppressContentEditableWarning
                data-carousel-slot=""
                onInput={e => { const el = e.currentTarget as HTMLDivElement; commitTextSpans(htmlToSpans(el)); highlightPlaceholders(el); }}
                onBlur={() => setEditingTextBox(null)}
                onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); (e.currentTarget as HTMLDivElement).blur(); } }}
                style={{
                  width: '100%',
                  fontFamily: tbFont.css,
                  fontSize:   tb.fontSize * DISPLAY_SCALE,
                  fontWeight: tb.fontWeight,
                  fontStyle:  tb.italic ? 'italic' : 'normal',
                  lineHeight: `${tb.fontSize * (1.0 + ((tb.lineHeight ?? 15) / 100) * 1.2) * DISPLAY_SCALE}px`,
                  letterSpacing: `${(tb.letterSpacing ?? 0) * DISPLAY_SCALE}px`,
                  color: tb.color ?? '#ffffff',
                  textAlign: tb.align,
                  textAlignLast: tb.align === 'justify' ? 'center' : 'auto',   // match canvas: justify's last line is centred
                  textTransform: tb.allCaps ? 'uppercase' : 'none',
                  opacity: (tb.opacity ?? 100) / 100,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  outline: 'none',
                }}
              />
            </div>
          );
        })()}

        {/* ── Image box frames (drag to move, handles to resize, × / Delete to remove) ── */}
        {(settings.imageBoxes ?? []).map((b, idx) => {
          const isActive   = activeDragImageBox === idx;
          const isSelected = selectedImageBox === idx;
          const isDropReplace = dropReplaceImageBox === idx;   // acceptable payload hovering → replace ring
          // Overlays are full-canvas; a clickable frame would cover the whole canvas and block selecting
          // anything beneath, so they get no canvas frame — select/configure them via the Layers panel.
          if (b.hidden || b.isOverlay) return null;
          const locked = !!b.locked;
          const perspEditing = isSelected && b.id === perspectiveBoxId && !locked;   // show the 4 corner handles
          const pp = b.perspective ?? IDENTITY_PERSPECTIVE;
          const isCircleBox = b.shape === 'circle';
          const inReframe = reframeImageBox === idx && isCircleBox && !locked;   // drag pans the photo, scroll zooms
          const HANDLES: { id: string; pos: React.CSSProperties; cur: string }[] = [
            { id: 'nw', pos: { top: -4, left: -4 },                       cur: 'nwse-resize' },
            { id: 'n',  pos: { top: -4, left: '50%', marginLeft: -4 },     cur: 'ns-resize'   },
            { id: 'ne', pos: { top: -4, right: -4 },                      cur: 'nesw-resize' },
            { id: 'e',  pos: { top: '50%', right: -4, marginTop: -4 },     cur: 'ew-resize'   },
            { id: 'se', pos: { bottom: -4, right: -4 },                   cur: 'nwse-resize' },
            { id: 's',  pos: { bottom: -4, left: '50%', marginLeft: -4 },  cur: 'ns-resize'   },
            { id: 'sw', pos: { bottom: -4, left: -4 },                    cur: 'nesw-resize' },
            { id: 'w',  pos: { top: '50%', left: -4, marginTop: -4 },      cur: 'ew-resize'   },
          ];
          return (
            <div
              key={b.id}
              ref={el => { imageBoxDivRefs.current[idx] = el; }}
              data-carousel-slot=""
              onDoubleClick={e => {
                if (locked || !isCircleBox) return;   // reframe is circle-only
                e.stopPropagation();
                selectImageBoxOnly(idx);
                setReframeImageBox(r => (r === idx ? null : idx));
              }}
              onMouseDown={e => {
                e.stopPropagation();
                e.preventDefault();
                if (inReframe) { startImageBoxReframe(idx, e); return; }   // drag pans the photo, not the box
                selectImageBoxOnly(idx);
                imageBoxDragStart.current = { mx: e.clientX, my: e.clientY, x: b.x, y: b.y };
                setActiveDragImageBox(idx);
                // Bind the drag listeners SYNCHRONOUSLY (not via a setActiveDragImageBox-keyed
                // effect, which would bind a render late and drop a quick release) so the box is
                // dragged only while the button is held and is released the instant it goes up.
                const SNAP = 12, EDGE = 60;
                let moved = false;
                const onMove = (ev: MouseEvent) => {
                  const box = settingsRef.current.imageBoxes?.[idx];
                  if (!box) return;
                  // Movement threshold: a plain click (incl. the two mousedowns of a reframe double-click)
                  // must not nudge the box or dirty history.
                  if (!moved && Math.hypot(ev.clientX - imageBoxDragStart.current.mx, ev.clientY - imageBoxDragStart.current.my) < 3) return;
                  moved = true;
                  const bw = box.width, bh = box.height;
                  const dxPx = (ev.clientX - imageBoxDragStart.current.mx) / DISPLAY_SCALE;
                  const dyPx = (ev.clientY - imageBoxDragStart.current.my) / DISPLAY_SCALE;
                  // Allow dragging off ANY edge: top-left may go to -boxSize (fully off left/top)
                  // just as it may reach W/H (fully off right/bottom).
                  let nx = Math.max(-bw, Math.min(W, Math.round(imageBoxDragStart.current.x + dxPx)));
                  let ny = Math.max(-bh, Math.min(H, Math.round(imageBoxDragStart.current.y + dyPx)));
                  // Snap targets per axis: canvas edge (0), margin inset, centre, far margin, far edge.
                  const xT = [[0, 0], [EDGE, EDGE], [Math.round(W / 2 - bw / 2), Math.round(W / 2)], [W - EDGE - bw, W - EDGE], [W - bw, W]];
                  const yT = [[0, 0], [EDGE, EDGE], [Math.round(H / 2 - bh / 2), Math.round(H / 2)], [H - EDGE - bh, H - EDGE], [H - bh, H]];
                  let gx: number | null = null, gy: number | null = null;
                  for (const [tx, g] of xT) { if (Math.abs(nx - tx) <= SNAP) { nx = tx; gx = g; break; } }
                  for (const [ty, g] of yT) { if (Math.abs(ny - ty) <= SNAP) { ny = ty; gy = g; break; } }
                  setSnapGuideX(gx); setSnapGuideY(gy);
                  const cur = [...(settingsRef.current.imageBoxes ?? [])];
                  if (!cur[idx]) return;
                  cur[idx] = { ...cur[idx], x: nx, y: ny };
                  settingsRef.current = { ...settingsRef.current, imageBoxes: cur };
                  onSettingsChange?.({ imageBoxes: cur });
                  redraw(cachedImgRef.current);
                };
                const onUp = () => {
                  setActiveDragImageBox(null);
                  setSnapGuideX(null);
                  setSnapGuideY(null);
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
              // Drag-replace: a tray payload of MATCHING kind (image → image box, video → video box)
              // dropped on the frame swaps this box's media in place. dragover can't read the payload,
              // only its types — the tray drag sets a kind-tagged type (application/carousel-element-
              // type/…) precisely so this gate can match by kind before the drop. On a NON-matching
              // carousel payload we stopPropagation WITHOUT preventDefault: the wrapper's dragover
              // then never allows the drop, so the cursor honestly shows no-drop over the frame
              // (the wrapper's onDrop would discard such a drop anyway — it ignores drops landing
              // inside [data-carousel-slot]). Locked boxes never get here (pointerEvents 'none'):
              // their drops fall through to the wrapper and add a new box, as before.
              onDragOver={e => {
                if (!e.dataTransfer.types.includes('application/carousel-element')) return;
                e.stopPropagation();
                const want = b.videoUrl ? 'video' : 'image';
                if (!allowImages || !e.dataTransfer.types.includes(`application/carousel-element-type/${want}`)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                setDropReplaceImageBox(idx);
              }}
              onDragLeave={e => {
                // Moving over the frame's own children (handles, play button) fires dragleave too — ignore those.
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setDropReplaceImageBox(prev => (prev === idx ? null : prev));
              }}
              onDrop={e => {
                if (!e.dataTransfer.types.includes('application/carousel-element')) return;
                e.stopPropagation();   // a drop that reached the frame must not also bubble to the wrapper and add a duplicate box
                setDropReplaceImageBox(prev => (prev === idx ? null : prev));
                try {
                  const d = JSON.parse(e.dataTransfer.getData('application/carousel-element')) as SidebarElementData;
                  const want = b.videoUrl ? 'video' : 'image';
                  if (!allowImages || d.type !== want || !d.url) return;
                  e.preventDefault();
                  replaceBoxMedia(idx, d.url, want);
                } catch { /* ignore malformed drops */ }
              }}
              style={{
                position: 'absolute',
                left:   b.x * DISPLAY_SCALE,
                top:    b.y * DISPLAY_SCALE,
                width:  b.width * DISPLAY_SCALE,
                height: b.height * DISPLAY_SCALE,
                cursor: inReframe ? (activeDragImageBox === idx ? 'grabbing' : 'grab') : isActive ? 'grabbing' : 'grab',
                userSelect: 'none',
                pointerEvents: locked ? 'none' : undefined,
                // Drop-hover replace ring outranks the other outline states: it's the live "release to
                // swap" affordance, styled on the editor's selection blue like the reframe indicator.
                outline: isDropReplace ? '2px solid rgba(96,165,250,0.95)'
                  : b.id === expandPreviewBoxId || inReframe ? 'none' : isSelected ? `1px ${locked ? 'dashed' : 'solid'} rgba(96,165,250,0.95)` : 'none',
                outlineOffset: isDropReplace ? 2 : undefined,
                background: isDropReplace ? 'rgba(96,165,250,0.14)' : undefined,
                zIndex:  frameZIndex(b.id, isSelected),
              }}
            >
              {/* Reframe indicator — the disc the photo is being panned/zoomed within */}
              {inReframe && (() => {
                const d = Math.min(b.width, b.height) * DISPLAY_SCALE;
                return <div style={{ position: 'absolute', left: '50%', top: '50%', width: d, height: d, transform: 'translate(-50%,-50%)', borderRadius: '9999px', border: '2px solid rgba(96,165,250,0.95)', pointerEvents: 'none', zIndex: 9 }} />;
              })()}
              {b.videoUrl && !locked && !inReframe && (
                <button
                  onMouseDown={e => { e.stopPropagation(); e.preventDefault(); }}
                  onClick={e => { e.stopPropagation(); toggleVideoPlay(b.videoUrl!); }}
                  title={playingVideoUrl === b.videoUrl ? 'Pause' : 'Play with sound'}
                  aria-label={playingVideoUrl === b.videoUrl ? 'Pause video' : 'Play video with sound'}
                  style={{
                    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
                    width: 44, height: 44, borderRadius: 9999, zIndex: 11, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.65)', color: '#fff',
                    backdropFilter: 'blur(2px)',
                  }}
                >
                  {playingVideoUrl === b.videoUrl ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
                  )}
                </button>
              )}
              {isSelected && !locked && !perspEditing && !inReframe && HANDLES
                .filter(h => !(isCircleBox && (h.id === 'n' || h.id === 's' || h.id === 'e' || h.id === 'w')))   // circles: drop edge-crop handles, keep corners
                .map(h => (
                <div
                  key={h.id}
                  onMouseDown={e => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (h.id === 'n' || h.id === 's' || h.id === 'e' || h.id === 'w') {
                      // Centre-edge handle → crop (hide/reveal source pixels; changes aspect)
                      const c = b.crop;
                      imageBoxCropStart.current = {
                        handle: h.id, mx: e.clientX, my: e.clientY,
                        x: b.x, y: b.y, w: b.width, h: b.height,
                        cropL: c?.left ?? 0, cropR: c?.right ?? 0, cropT: c?.top ?? 0, cropB: c?.bottom ?? 0,
                      };
                      setActiveCropImageBox(idx);
                      // Bind synchronously so the handle releases on mouse-up (see note above the image-box effects).
                      const MIN = 20;
                      const onMove = (ev: MouseEvent) => {
                        const s0 = imageBoxCropStart.current;
                        const dx = Math.round((ev.clientX - s0.mx) / DISPLAY_SCALE);
                        const dy = Math.round((ev.clientY - s0.my) / DISPLAY_SCALE);
                        const fullW = s0.w / Math.max(1e-6, 1 - s0.cropL - s0.cropR);
                        const fullH = s0.h / Math.max(1e-6, 1 - s0.cropT - s0.cropB);
                        const imgX0 = s0.x - s0.cropL * fullW, imgXe = imgX0 + fullW;
                        const imgY0 = s0.y - s0.cropT * fullH, imgYe = imgY0 + fullH;
                        let left = s0.x, top = s0.y, right = s0.x + s0.w, bottom = s0.y + s0.h;
                        if (s0.handle.includes('e')) right  = Math.min(imgXe, Math.max(left + MIN, right + dx));
                        if (s0.handle.includes('w')) left   = Math.max(imgX0, Math.min(right - MIN, left + dx));
                        if (s0.handle.includes('s')) bottom = Math.min(imgYe, Math.max(top + MIN, bottom + dy));
                        if (s0.handle.includes('n')) top    = Math.max(imgY0, Math.min(bottom - MIN, top + dy));
                        left = Math.round(left); right = Math.round(right);
                        top = Math.round(top);   bottom = Math.round(bottom);
                        const nx = left, ny = top, nw = Math.max(MIN, right - left), nh = Math.max(MIN, bottom - top);
                        const cl01 = (v: number) => Math.min(0.999, Math.max(0, v));
                        const crop = {
                          left:   cl01((nx - imgX0) / fullW),
                          right:  cl01((imgXe - (nx + nw)) / fullW),
                          top:    cl01((ny - imgY0) / fullH),
                          bottom: cl01((imgYe - (ny + nh)) / fullH),
                        };
                        const cur = [...(settingsRef.current.imageBoxes ?? [])];
                        if (!cur[idx]) return;
                        cur[idx] = { ...cur[idx], x: nx, y: ny, width: nw, height: nh, crop };
                        settingsRef.current = { ...settingsRef.current, imageBoxes: cur };
                        onSettingsChange?.({ imageBoxes: cur });
                        redraw(cachedImgRef.current);
                      };
                      const onUp = () => { setActiveCropImageBox(null); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
                      window.addEventListener('mousemove', onMove);
                      window.addEventListener('mouseup', onUp);
                    } else {
                      // Corner handle → scale. A cropped box locks to its current ratio (native aspect no longer applies).
                      imageBoxResizeStart.current = { handle: h.id, mx: e.clientX, my: e.clientY, x: b.x, y: b.y, w: b.width, h: b.height, aspect: (b.crop ? 0 : b.aspect) || (b.width / b.height) || 1 };
                      setActiveResizeImageBox(idx);
                      const MIN = 20;
                      const onMove = (ev: MouseEvent) => {
                        const s0 = imageBoxResizeStart.current;
                        const dx = Math.round((ev.clientX - s0.mx) / DISPLAY_SCALE);
                        const dy = Math.round((ev.clientY - s0.my) / DISPLAY_SCALE);
                        const hasE = s0.handle.includes('e'), hasW = s0.handle.includes('w');
                        const hasS = s0.handle.includes('s'), hasN = s0.handle.includes('n');
                        let w = s0.w + (hasE ? dx : hasW ? -dx : 0);
                        let h = s0.h + (hasS ? dy : hasN ? -dy : 0);
                        let gx: number | null = null, gy: number | null = null;
                        if ((lockImageAspectRef.current || ev.shiftKey) && s0.w > 0 && s0.h > 0) {
                          const aspect = s0.aspect || s0.w / s0.h || 1;
                          if (Math.abs(w / s0.w - 1) >= Math.abs(h / s0.h - 1)) {
                            if (hasE)      { const g = nearestGuide(s0.x + w, X_GUIDES);        if (g !== null && g - s0.x >= MIN) { w = g - s0.x; gx = g; } }
                            else if (hasW) { const g = nearestGuide(s0.x + s0.w - w, X_GUIDES); if (g !== null && s0.x + s0.w - g >= MIN) { w = s0.x + s0.w - g; gx = g; } }
                            h = w / aspect;
                          } else {
                            if (hasS)      { const g = nearestGuide(s0.y + h, Y_GUIDES);        if (g !== null && g - s0.y >= MIN) { h = g - s0.y; gy = g; } }
                            else if (hasN) { const g = nearestGuide(s0.y + s0.h - h, Y_GUIDES); if (g !== null && s0.y + s0.h - g >= MIN) { h = s0.y + s0.h - g; gy = g; } }
                            w = h * aspect;
                          }
                          if (w < MIN) { w = MIN; h = w / aspect; }
                          if (h < MIN) { h = MIN; w = h * aspect; }
                          w = Math.round(w * 100) / 100;
                          h = Math.round(h * 100) / 100;
                        } else {
                          if (hasE)      { const g = nearestGuide(s0.x + w, X_GUIDES);        if (g !== null && g - s0.x >= MIN) { w = g - s0.x; gx = g; } }
                          else if (hasW) { const g = nearestGuide(s0.x + s0.w - w, X_GUIDES); if (g !== null && s0.x + s0.w - g >= MIN) { w = s0.x + s0.w - g; gx = g; } }
                          if (hasS)      { const g = nearestGuide(s0.y + h, Y_GUIDES);        if (g !== null && g - s0.y >= MIN) { h = g - s0.y; gy = g; } }
                          else if (hasN) { const g = nearestGuide(s0.y + s0.h - h, Y_GUIDES); if (g !== null && s0.y + s0.h - g >= MIN) { h = s0.y + s0.h - g; gy = g; } }
                          w = Math.max(MIN, w);
                          h = Math.max(MIN, h);
                        }
                        // No top/left clamp: let x/y go negative so a box can extend past the
                        // top/left edges (clipped by the wrapper), symmetric with right/bottom.
                        const x = hasW ? s0.x + s0.w - w : s0.x;
                        const y = hasN ? s0.y + s0.h - h : s0.y;
                        setSnapGuideX(gx); setSnapGuideY(gy);
                        const cur = [...(settingsRef.current.imageBoxes ?? [])];
                        if (!cur[idx]) return;
                        cur[idx] = { ...cur[idx], x, y, width: w, height: h };
                        settingsRef.current = { ...settingsRef.current, imageBoxes: cur };
                        onSettingsChange?.({ imageBoxes: cur });
                        redraw(cachedImgRef.current);
                      };
                      const onUp = () => { setActiveResizeImageBox(null); setSnapGuideX(null); setSnapGuideY(null); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
                      window.addEventListener('mousemove', onMove);
                      window.addEventListener('mouseup', onUp);
                    }
                  }}
                  style={{ position: 'absolute', ...h.pos, width: 8, height: 8, background: '#fff', border: '1px solid rgba(96,165,250,0.95)', borderRadius: 1, cursor: h.cur, zIndex: 10 }}
                />
              ))}
              {perspEditing && (
                <>
                  {/* Quad outline — the destination shape the image is warped onto. */}
                  <svg style={{ position: 'absolute', left: 0, top: 0, width: b.width * DISPLAY_SCALE, height: b.height * DISPLAY_SCALE, overflow: 'visible', pointerEvents: 'none', zIndex: 9 }}>
                    <polygon
                      points={[
                        `${pp.tl.x * DISPLAY_SCALE},${pp.tl.y * DISPLAY_SCALE}`,
                        `${(b.width + pp.tr.x) * DISPLAY_SCALE},${pp.tr.y * DISPLAY_SCALE}`,
                        `${(b.width + pp.br.x) * DISPLAY_SCALE},${(b.height + pp.br.y) * DISPLAY_SCALE}`,
                        `${pp.bl.x * DISPLAY_SCALE},${(b.height + pp.bl.y) * DISPLAY_SCALE}`,
                      ].join(' ')}
                      fill="none" stroke="rgba(96,165,250,0.95)" strokeWidth={1} strokeDasharray="4 3"
                    />
                  </svg>
                  {/* Four corner handles — drag math depends on the active mode (Distort/Perspective/Skew). */}
                  {PCORNERS.map(c => {
                    const off = pp[c.id];
                    return (
                      <div
                        key={c.id}
                        onMouseDown={e => {
                          e.stopPropagation();
                          e.preventDefault();
                          const start = settingsRef.current.imageBoxes?.[idx]?.perspective ?? IDENTITY_PERSPECTIVE;
                          const sp: ImageBoxPerspective = { tl: { ...start.tl }, tr: { ...start.tr }, br: { ...start.br }, bl: { ...start.bl } };
                          const mx = e.clientX, my = e.clientY;
                          // Coalesce the React state commit + the (heavy WebGL) redraw to ONE per
                          // animation frame. Committing on every mousemove floods React with full
                          // re-renders faster than they settle — which trips "Maximum update depth
                          // exceeded" once the perspective warp makes each redraw expensive.
                          let raf = 0;
                          const flush = () => {
                            raf = 0;
                            redraw(cachedImgRef.current);
                            onSettingsChange?.({ imageBoxes: settingsRef.current.imageBoxes });
                          };
                          const onMove = (ev: MouseEvent) => {
                            const dpx = (ev.clientX - mx) / DISPLAY_SCALE;
                            const dpy = (ev.clientY - my) / DISPLAY_SCALE;
                            const np = updatePerspective(c.id, dpx, dpy, sp, perspectiveMode);
                            const cur = [...(settingsRef.current.imageBoxes ?? [])];
                            if (!cur[idx]) return;
                            cur[idx] = { ...cur[idx], perspective: np };
                            settingsRef.current = { ...settingsRef.current, imageBoxes: cur };
                            if (!raf) raf = requestAnimationFrame(flush);
                          };
                          const onUp = () => {
                            if (raf) cancelAnimationFrame(raf);
                            redraw(cachedImgRef.current);
                            onSettingsChange?.({ imageBoxes: settingsRef.current.imageBoxes });   // final commit
                            window.removeEventListener('mousemove', onMove);
                            window.removeEventListener('mouseup', onUp);
                          };
                          window.addEventListener('mousemove', onMove);
                          window.addEventListener('mouseup', onUp);
                        }}
                        style={{
                          position: 'absolute',
                          left: (c.fx * b.width + off.x) * DISPLAY_SCALE,
                          top:  (c.fy * b.height + off.y) * DISPLAY_SCALE,
                          width: 12, height: 12, marginLeft: -6, marginTop: -6,
                          background: '#60a5fa', border: '2px solid #fff', borderRadius: '50%',
                          boxShadow: '0 0 0 1px rgba(0,0,0,0.4)', cursor: 'move', zIndex: 11,
                        }}
                      />
                    );
                  })}
                </>
              )}
            </div>
          );
        })}

        {/* ── Text box snap guides (only while dragging) ── */}
        {snapGuideX !== null && (
          <div style={{ position: 'absolute', left: snapGuideX * DISPLAY_SCALE, top: 0, bottom: 0, width: 1, background: 'rgba(96,165,250,0.9)', pointerEvents: 'none', zIndex: 8 }} />
        )}
        {snapGuideY !== null && (
          <div style={{ position: 'absolute', top: snapGuideY * DISPLAY_SCALE, left: 0, right: 0, height: 1, background: 'rgba(96,165,250,0.9)', pointerEvents: 'none', zIndex: 8 }} />
        )}

        {/* ── Option/Alt: spacing measurements from the selected box to each canvas edge ── */}
        {measBox && (() => {
          const mb = measBox;
          const bw = mb.width, bh = mb.height;
          const lPx  = mb.x * DISPLAY_SCALE;
          const tPx  = mb.y * DISPLAY_SCALE;
          const rPx  = (mb.x + bw) * DISPLAY_SCALE;
          const bPx  = (mb.y + bh) * DISPLAY_SCALE;
          const cxPx = (mb.x + bw / 2) * DISPLAY_SCALE;
          const cyPx = (mb.y + bh / 2) * DISPLAY_SCALE;
          const C = '#e23ce8';
          const Pill = ({ v, left, top }: { v: number; left: number; top: number }) => (
            <div style={{ position: 'absolute', left, top, transform: 'translate(-50%, -50%)', background: C, color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: 1, padding: '3px 6px', borderRadius: 999, pointerEvents: 'none', zIndex: 9, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{Math.round(v)}</div>
          );
          return (
            <>
              {/* dashed gap lines: box centre-axis → each canvas edge */}
              <div style={{ position: 'absolute', left: cxPx, top: 0,   height: tPx,                     borderLeft: `1px dashed ${C}`, pointerEvents: 'none', zIndex: 8 }} />
              <div style={{ position: 'absolute', left: cxPx, top: bPx, height: CAROUSEL_PREVIEW_H - bPx, borderLeft: `1px dashed ${C}`, pointerEvents: 'none', zIndex: 8 }} />
              <div style={{ position: 'absolute', top: cyPx, left: 0,   width: lPx,                      borderTop:  `1px dashed ${C}`, pointerEvents: 'none', zIndex: 8 }} />
              <div style={{ position: 'absolute', top: cyPx, left: rPx, width: CAROUSEL_PREVIEW_W - rPx,  borderTop:  `1px dashed ${C}`, pointerEvents: 'none', zIndex: 8 }} />
              {/* end-cap ticks at the canvas edges */}
              <div style={{ position: 'absolute', left: cxPx - 4, top: 0,                          width: 8,  borderTop:  `1px solid ${C}`, pointerEvents: 'none', zIndex: 8 }} />
              <div style={{ position: 'absolute', left: cxPx - 4, top: CAROUSEL_PREVIEW_H - 1,      width: 8,  borderTop:  `1px solid ${C}`, pointerEvents: 'none', zIndex: 8 }} />
              <div style={{ position: 'absolute', top: cyPx - 4,  left: 0,                          height: 8, borderLeft: `1px solid ${C}`, pointerEvents: 'none', zIndex: 8 }} />
              <div style={{ position: 'absolute', top: cyPx - 4,  left: CAROUSEL_PREVIEW_W - 1,     height: 8, borderLeft: `1px solid ${C}`, pointerEvents: 'none', zIndex: 8 }} />
              {/* distance pills (canvas px) */}
              <Pill v={mb.y}            left={cxPx}                            top={tPx / 2} />
              <Pill v={H - (mb.y + bh)} left={cxPx}                            top={(bPx + CAROUSEL_PREVIEW_H) / 2} />
              <Pill v={mb.x}            left={lPx / 2}                         top={cyPx} />
              <Pill v={W - (mb.x + bw)} left={(rPx + CAROUSEL_PREVIEW_W) / 2}  top={cyPx} />
            </>
          );
        })()}

        {/* ── Image-expansion preview: the area BRIA will fill is shown as solid black, with a
              marching-ants dashed marquee around the canvas + the photo (Photoshop-style). ── */}
        {expandPreviewBoxId && (() => {
          const idx = (settings.imageBoxes ?? []).findIndex(b => b.id === expandPreviewBoxId);
          // Only while that box is the selected one, so its move/resize handles are live for adjusting.
          if (idx < 0 || idx !== selectedImageBox) return null;
          const b = (settings.imageBoxes ?? [])[idx];
          if (!b || b.hidden) return null;
          const L = Math.max(0, Math.min(CAROUSEL_PREVIEW_W, b.x * DISPLAY_SCALE));
          const T = Math.max(0, Math.min(CAROUSEL_PREVIEW_H, b.y * DISPLAY_SCALE));
          const R = Math.max(0, Math.min(CAROUSEL_PREVIEW_W, (b.x + b.width)  * DISPLAY_SCALE));
          const B = Math.max(0, Math.min(CAROUSEL_PREVIEW_H, (b.y + b.height) * DISPLAY_SCALE));
          // Opaque black fill over everything outside the photo = the region to be generated.
          const Strip = (s: React.CSSProperties) => <div style={{ position: 'absolute', background: '#000', pointerEvents: 'none', zIndex: 5, ...s }} />;
          return (
            <>
              {Strip({ left: 0, top: 0, width: CAROUSEL_PREVIEW_W, height: T })}
              {Strip({ left: 0, top: B, width: CAROUSEL_PREVIEW_W, height: Math.max(0, CAROUSEL_PREVIEW_H - B) })}
              {Strip({ left: 0, top: T, width: L, height: Math.max(0, B - T) })}
              {Strip({ left: R, top: T, width: Math.max(0, CAROUSEL_PREVIEW_W - R), height: Math.max(0, B - T) })}
              {/* marching-ants marquee around the whole output canvas + around the kept photo */}
              <div className="te-marching-ants" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 6 }} />
              <div className="te-marching-ants" style={{ position: 'absolute', left: L, top: T, width: Math.max(0, R - L), height: Math.max(0, B - T), pointerEvents: 'none', zIndex: 6 }} />
            </>
          );
        })()}

        {/* ── Crop overlay canvas (drawn on top of main canvas) ── */}
        <canvas
          ref={cropOverlayRef}
          width={CAROUSEL_PREVIEW_W}
          height={CAROUSEL_PREVIEW_H}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4, display: isCropMode ? 'block' : 'none' }}
        />

        {/* ── Crop handles ── */}
        {isCropMode && (() => {
          const HS = 8;
          const { x, y, w, h } = cropRect;
          const handles = [
            { id: 'nw', cx: x,     cy: y,     cur: 'nwse-resize' },
            { id: 'n',  cx: x+w/2, cy: y,     cur: 'ns-resize'   },
            { id: 'ne', cx: x+w,   cy: y,     cur: 'nesw-resize'  },
            { id: 'e',  cx: x+w,   cy: y+h/2, cur: 'ew-resize'    },
            { id: 'se', cx: x+w,   cy: y+h,   cur: 'nwse-resize'  },
            { id: 's',  cx: x+w/2, cy: y+h,   cur: 'ns-resize'    },
            { id: 'sw', cx: x,     cy: y+h,   cur: 'nesw-resize'  },
            { id: 'w',  cx: x,     cy: y+h/2, cur: 'ew-resize'    },
          ];
          return handles.map(hd => (
            <div
              key={hd.id}
              data-crop-handle=""
              onMouseDown={e => {
                e.stopPropagation(); e.preventDefault();
                cropActiveHandle.current = hd.id;
                cropDragStart.current = { mx: e.clientX, my: e.clientY, rect: { ...cropRectRef.current } };
              }}
              style={{
                position: 'absolute',
                left: hd.cx - HS / 2,
                top:  hd.cy - HS / 2,
                width: HS, height: HS,
                background: '#fff',
                border: '1px solid rgba(0,0,0,0.35)',
                borderRadius: 2,
                cursor: hd.cur,
                zIndex: 15,
              }}
            />
          ));
        })()}

        {/* ── Crop toolbar ── */}
        {isCropMode && (
          <div
            data-crop-handle=""
            style={{ position: 'absolute', bottom: 8, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 5, zIndex: 16 }}
          >
            {/* 4:5 snap + lock */}
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={() => {
                if (cropLock === '4:5') { setCropLock('free'); return; }
                const { x, y, w, h } = cropRectRef.current;
                const AR = 4 / 5;
                let nx = x, ny = y, nw = w, nh = w / AR;
                if (nh > CAROUSEL_PREVIEW_H) { nh = h; nw = h * AR; nx = x + (w - nw) / 2; }
                else { ny = y + (h - nh) / 2; }
                const nr = { x: Math.round(Math.max(0, nx)), y: Math.round(Math.max(0, ny)), w: Math.round(nw), h: Math.round(nh) };
                cropRectRef.current = nr; setCropRect(nr); drawCropOverlay(nr);
                setCropLock('4:5');
              }}
              style={{
                padding: '3px 9px',
                background: cropLock === '4:5' ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.65)',
                border: '1px solid rgba(255,255,255,0.35)',
                borderRadius: 5,
                color: cropLock === '4:5' ? '#000' : 'rgba(255,255,255,0.85)',
                fontSize: 10, fontWeight: 700, cursor: 'pointer', letterSpacing: 0.3,
              }}
            >4:5</button>
            {/* Reset */}
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={() => {
                // Clear committed crop — full original image will show
                imgSrcCropRef.current = null;
                imgOffsetRef.current  = { x: 0, y: 0 };
                imgScaleRef.current   = 1;
                setImgScale(1);
                onScaleChange?.(1);
                redraw(cachedImgRef.current);
                const full = { x: 0, y: 0, w: CAROUSEL_PREVIEW_W, h: CAROUSEL_PREVIEW_H };
                cropRectRef.current = full; setCropRect(full); drawCropOverlay(full);
              }}
              style={{
                padding: '3px 9px', background: 'rgba(0,0,0,0.65)',
                border: '1px solid var(--line-strong)', borderRadius: 5,
                color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: 500, cursor: 'pointer',
              }}
            >Reset</button>
            {/* Done */}
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={() => applyCrop()}
              style={{
                padding: '3px 12px', background: '#fff',
                border: 'none', borderRadius: 5,
                color: '#000', fontSize: 10, fontWeight: 700, cursor: 'pointer',
              }}
            >Done</button>
          </div>
        )}

        </>}

      </div>
      </div>

      {!staticMode && <>

      {/* Quote picker modal */}
      {showQuotePicker !== null && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70"
          onMouseDown={e => { if (e.target === e.currentTarget) setShowQuotePicker(null); }}
        >
          <div className="bg-surface-1 border border-line rounded-2xl shadow-2xl p-4" style={{ width: 380, maxHeight: '80vh', overflowY: 'auto' }}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-fg">Choose a quote mark</span>
              <button onClick={() => setShowQuotePicker(null)} className="text-fg-3 hover:text-fg-2 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>

            {/* Single marks */}
            <p className="text-[10px] font-semibold text-fg-4 uppercase tracking-wider mb-2">Single</p>
            <div className="grid grid-cols-5 gap-1.5 mb-4">
              {QUOTE_STYLES.map(qs => (
                <button
                  key={qs.id}
                  onClick={() => { selectQuoteZone(showQuotePicker!, pendingSlotZoneRef.current, qs.id); setShowQuotePicker(null); }}
                  className="flex flex-col items-center gap-1.5 p-2 rounded-xl bg-surface-2 border border-line hover:border-line-strong hover:bg-surface-3 transition-colors group"
                >
                  <svg viewBox={qs.viewBox.join(' ')} style={{ width: 30, height: 30, fill: 'var(--fg)' }}>
                    {qs.paths.map((d, pi) => <path key={pi} d={d} />)}
                  </svg>
                  <span className="text-[8px] text-fg-3 group-hover:text-fg-2 transition-colors text-center leading-tight">{qs.label}</span>
                </button>
              ))}
            </div>

            {/* Paired marks (open + close) */}
            <p className="text-[10px] font-semibold text-fg-4 uppercase tracking-wider mb-2">Paired open + close</p>
            <div className="grid grid-cols-5 gap-1.5">
              {QUOTE_STYLES_PAIRED.map(qs => {
                const [vbX, vbY, vbW, vbH] = qs.viewBox;
                const gapVB = vbW * 0.15;
                const closeTransform = `translate(${vbX + vbW + gapVB},${vbY}) rotate(180,${vbW / 2},${vbH / 2}) translate(${-vbX},${-vbY})`;
                return (
                  <button
                    key={qs.id}
                    onClick={() => { selectQuoteZone(showQuotePicker!, pendingSlotZoneRef.current, qs.id); setShowQuotePicker(null); }}
                    className="flex flex-col items-center gap-1.5 p-2 rounded-xl bg-surface-2 border border-line hover:border-line-strong hover:bg-surface-3 transition-colors group"
                  >
                    <svg viewBox={`${vbX} ${vbY} ${vbW * 2 + gapVB} ${vbH}`} style={{ width: 52, height: 26, fill: 'var(--fg)' }}>
                      {/* Opening */}
                      <g>
                        {qs.paths.map((d, pi) => <path key={pi} d={d} />)}
                      </g>
                      {/* Closing (180° flip) */}
                      <g transform={closeTransform}>
                        {qs.paths.map((d, pi) => <path key={'c' + pi} d={d} />)}
                      </g>
                    </svg>
                    <span className="text-[8px] text-fg-3 group-hover:text-fg-2 transition-colors text-center leading-tight">{qs.label.replace(' ❝…❞', '')}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Main slot dropdown — portalled to body so it is never clipped by canvas overflow */}
      {openSlot !== null && slotDropdownPos !== null && typeof document !== 'undefined' && createPortal(
        (() => {
          const si = openSlot;
          const slotInputId = `logo-${instanceId}-${si}`;
          return (
            <div
              data-slot-dropdown=""
              style={{ position: 'fixed', left: slotDropdownPos.x, top: slotDropdownPos.y, width: 220, zIndex: 9999 }}
              className="bg-surface-1 border border-line-strong rounded-xl shadow-2xl py-1"
              onMouseDown={e => e.stopPropagation()}
            >
              {brandLogoSrc && (
                <button
                  onClick={() => { selectBrandLogoZone(si, pendingSlotZoneRef.current); setOpenSlot(null); setSlotDropdownPos(null); setShowCustom(false); }}
                  className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-fg-2 hover:bg-surface-3 transition-colors"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={brandLogoSrc} alt="" className="w-5 h-5 object-contain rounded shrink-0" />
                  Brand Kit Logo
                </button>
              )}
              <label
                htmlFor={slotInputId}
                onClick={() => { setOpenSlot(null); setSlotDropdownPos(null); }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-fg-2 hover:bg-surface-3 transition-colors cursor-pointer"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                Upload image…
              </label>
              <div className="border-t border-line mt-1 pt-1">
                <span className="block px-3 py-1 text-[10px] font-semibold text-fg-4 uppercase tracking-wider">Tags</span>
                <div className="px-2 pb-1 flex flex-wrap gap-1">
                  {TAG_PRESETS.map(preset => {
                    const presetStyle = { ...defaultTagStyle(), ...preset.initStyle };
                    return (
                      <button
                        key={preset.id}
                        onClick={() => { selectTagZone(si, pendingSlotZoneRef.current, preset.label, presetStyle); setOpenSlot(null); setSlotDropdownPos(null); setShowCustom(false); }}
                        style={{
                          backgroundColor: presetStyle.bgOpacity > 0 ? presetStyle.bgColor : 'transparent',
                          border: presetStyle.borderWidth > 0 ? `${presetStyle.borderWidth}px solid ${presetStyle.borderColor}` : '1px solid #52525b',
                          color: presetStyle.textColor,
                          borderRadius: presetStyle.cornerRadius,
                        }}
                        className="px-2 py-0.5 text-[10px] font-bold transition-opacity hover:opacity-80"
                      >{preset.label}</button>
                    );
                  })}
                </div>
                {showCustom ? (
                  <div className="px-2 pb-2 flex gap-1.5">
                    <input
                      autoFocus type="text" value={customTagText}
                      onChange={e => setCustomTagText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && customTagText.trim()) {
                          selectTagZone(si, pendingSlotZoneRef.current, customTagText.trim(), defaultTagStyle());
                          setOpenSlot(null); setSlotDropdownPos(null); setShowCustom(false); setCustomTagText('');
                        }
                        if (e.key === 'Escape') { setShowCustom(false); setCustomTagText(''); }
                      }}
                      placeholder="Tag text…"
                      className="flex-1 bg-surface-3 border border-line-strong text-fg text-xs rounded px-2 py-1 outline-none focus:border-fg-3 min-w-0"
                    />
                    <button
                      onClick={() => {
                        if (!customTagText.trim()) return;
                        selectTagZone(si, pendingSlotZoneRef.current, customTagText.trim(), defaultTagStyle());
                        setOpenSlot(null); setSlotDropdownPos(null); setShowCustom(false); setCustomTagText('');
                      }}
                      className="px-2 py-1 rounded bg-action text-action-fg text-xs font-semibold hover:bg-action-hover transition-colors shrink-0"
                    >Add</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowCustom(true)}
                    className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-fg-2 hover:text-fg hover:bg-surface-3 transition-colors"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Custom tag…
                  </button>
                )}
              </div>
              <div className="border-t border-line mt-1 pt-1">
                <span className="block px-3 py-1 text-[10px] font-semibold text-fg-4 uppercase tracking-wider">Quotation</span>
                <button
                  onClick={() => { setShowQuotePicker(si); setOpenSlot(null); setSlotDropdownPos(null); setShowCustom(false); }}
                  className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-fg-2 hover:bg-surface-3 transition-colors"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M4.583 17.321C3.553 16.227 3 15 3 13.011c0-3.5 2.457-6.637 6.03-8.188l.893 1.378c-3.335 1.804-3.987 4.145-4.247 5.621.537-.278 1.24-.375 1.929-.311 1.804.167 3.226 1.648 3.226 3.489a3.5 3.5 0 0 1-3.5 3.5c-1.073 0-2.099-.49-2.748-1.179zm10 0C13.553 16.227 13 15 13 13.011c0-3.5 2.457-6.637 6.03-8.188l.893 1.378c-3.335 1.804-3.987 4.145-4.247 5.621.537-.278 1.24-.375 1.929-.311 1.804.167 3.226 1.648 3.226 3.489a3.5 3.5 0 0 1-3.5 3.5c-1.073 0-2.099-.49-2.748-1.179z"/>
                  </svg>
                  Add quote mark…
                </button>
              </div>
              <div className="border-t border-line mt-1 pt-1">
                <span className="block px-3 py-1 text-[10px] font-semibold text-fg-4 uppercase tracking-wider">Swipe</span>
                {SWIPE_PRESETS.map(preset => (
                  <button
                    key={preset.id}
                    onClick={() => { selectSwipeZone(si, pendingSlotZoneRef.current, preset.style); setOpenSlot(null); setSlotDropdownPos(null); setShowCustom(false); }}
                    className="flex items-center w-full px-3 py-1 text-xs text-fg-2 hover:bg-surface-3 transition-colors"
                  >
                    <div style={{ overflow: 'visible', width: '100%' }}>
                      <TemplateEditorSwipePreviewMini style={preset.style} />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })(),
        document.body
      )}

      {/* Sub-slot dropdown — portalled to body so it escapes all overflow/z-index constraints */}
      {openSubSlot !== null && subDropdownPos !== null && typeof document !== 'undefined' && createPortal(
        (() => {
          const si = openSubSlot;
          const subInputId = `logo-sub-${instanceId}-${si}`;
          const subContent = settings.dividerSubSlots?.[si] ?? null;
          return (
            <div
              style={{ position: 'fixed', left: subDropdownPos.x, top: subDropdownPos.y, minWidth: 196, zIndex: 9999 }}
              className="bg-surface-1 border border-line-strong rounded-xl shadow-2xl py-1"
              onMouseDown={e => e.stopPropagation()}
            >
              {brandLogoSrc && (
                <button
                  onClick={() => { selectSubBrandLogo(si); setOpenSubSlot(null); setSubDropdownPos(null); setShowSubCustom(false); }}
                  className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-fg-2 hover:bg-surface-3 transition-colors"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={brandLogoSrc} alt="" className="w-5 h-5 object-contain rounded shrink-0" />
                  Brand Kit Logo
                </button>
              )}
              <label
                htmlFor={subInputId}
                onClick={() => { setOpenSubSlot(null); setSubDropdownPos(null); }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-fg-2 hover:bg-surface-3 transition-colors cursor-pointer"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                Upload image…
              </label>
              <div className="border-t border-line mt-1 pt-1">
                <span className="block px-3 py-1 text-[10px] font-semibold text-fg-4 uppercase tracking-wider">Tags</span>
                <div className="px-2 pb-1 flex flex-wrap gap-1">
                  {TAG_PRESETS.map(preset => {
                    const ps = { ...defaultTagStyle(), ...preset.initStyle };
                    return (
                      <button
                        key={preset.id}
                        onClick={() => { selectSubTag(si, preset.label, ps); setOpenSubSlot(null); setSubDropdownPos(null); setShowSubCustom(false); }}
                        style={{
                          backgroundColor: ps.bgOpacity > 0 ? ps.bgColor : 'transparent',
                          border: ps.borderWidth > 0 ? `${ps.borderWidth}px solid ${ps.borderColor}` : '1px solid #52525b',
                          color: ps.textColor,
                          borderRadius: ps.cornerRadius,
                        }}
                        className="px-2 py-0.5 text-[10px] font-bold transition-opacity hover:opacity-80"
                      >{preset.label}</button>
                    );
                  })}
                </div>
                {showSubCustom ? (
                  <div className="px-2 pb-2 flex gap-1.5">
                    <input
                      autoFocus type="text" value={customTagText}
                      onChange={e => setCustomTagText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && customTagText.trim()) {
                          selectSubTag(si, customTagText.trim(), defaultTagStyle());
                          setOpenSubSlot(null); setSubDropdownPos(null); setShowSubCustom(false); setCustomTagText('');
                        }
                        if (e.key === 'Escape') { setShowSubCustom(false); setCustomTagText(''); }
                      }}
                      placeholder="Tag text…"
                      className="flex-1 bg-surface-3 border border-line-strong text-fg text-xs rounded px-2 py-1 outline-none focus:border-fg-3 min-w-0"
                    />
                    <button
                      onClick={() => {
                        if (!customTagText.trim()) return;
                        selectSubTag(si, customTagText.trim(), defaultTagStyle());
                        setOpenSubSlot(null); setSubDropdownPos(null); setShowSubCustom(false); setCustomTagText('');
                      }}
                      className="px-2 py-1 rounded bg-action text-action-fg text-xs font-semibold hover:bg-action-hover transition-colors shrink-0"
                    >Add</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowSubCustom(true)}
                    className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-fg-2 hover:text-fg hover:bg-surface-3 transition-colors"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Custom tag…
                  </button>
                )}
              </div>
              {subContent && (
                <div className="border-t border-line mt-1 pt-1">
                  <button
                    onClick={() => { clearSubSlot(si); setOpenSubSlot(null); setSubDropdownPos(null); }}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-fg-3 hover:text-danger-text hover:bg-surface-3 transition-colors"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    Remove content
                  </button>
                </div>
              )}
            </div>
          );
        })(),
        document.body
      )}

      </>}

      </>
    );
  }
);

export default TemplateEditorCanvas;
