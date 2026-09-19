'use client';

import { useEffect, useReducer, useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode, RefObject, CSSProperties, PointerEvent as ReactPointerEvent, DragEvent as ReactDragEvent } from 'react';
import type { BrandProps } from '../types';
import { CANVAS_W, CANVAS_H, DISPLAY_SCALE, VERIFIED_TICK_SVG } from './TikTokCanvas/constants';
import { drawReelCells, drawFreeElements, reelLayout, reelCellRegionRects, reelCellOf, DEFAULT_TEXT_FONT, REELS_CELLS_ENABLED, defaultBannerStyle, defaultTextStyle, defaultImageStyle, defaultBannerTextBannerStyle, defaultBannerTextTextStyle, DEFAULT_BANNER_TEXT_GAP, measureReelTextBoxHeight, measureReelBannerTextHeight, reelBannerHeight, reelTextContent, effectiveFreeElementHeight } from './TikTokCanvas/drawing/drawReelCell';
import { bannerAvatarRectInCell, sonotradeBannerBox } from './TikTokCanvas/drawing/drawHeader';
import type { ReelCellKey } from './TikTokCanvas/drawing/drawReelCell';
import type { TwitterTemplateSettings, ReelsCellType, FreeElement } from './twitterTemplateTypes';
import { TwitterSettingsPanel } from './TwitterSettingsPanel';
import { useTwitterTemplates } from '../hooks/useTwitterTemplates';
import { TemplatesEmptyState } from './TemplatesEmptyState';
import { Button, IconButton, Switch, EmptyState, BrandLoader, RIGHT_PANEL_VAR, RAIL_VAR, HEADER_H } from '@/app/components/ui';
import { ConfirmDeleteDialog } from './SlidesStrip';
import { ElementRail, RailIcons } from './ElementRail';
import { ReelCopilotPanel } from './ReelCopilotPanel';
import { useReelCopilot } from '../hooks/useReelCopilot';
import { UploadsGallery } from './UploadsGallery';
import { EditorScrollBar } from './EditorScrollBar';
import { ZoomControl } from './ZoomControl';
import { useObservedSize, fitScaleFor } from '@/app/hooks/useElementSize';
import { useEditorZoomPan, EDITOR_ZOOM_MIN as ZOOM_MIN, EDITOR_ZOOM_MAX as ZOOM_MAX } from '@/app/hooks/useEditorZoomPan';
import { VideoIcon, PlusIcon, ChevronDownIcon, CloseIcon, DownloadIcon } from '@/lib/icons';
import { NAME_MAX_LENGTH } from '@/lib/ui-constants';
import { AutosaveChip } from './AutosaveChip';
import { resolveCarouselFont, useCustomFonts } from './customFonts';
import { ensureFontLoaded } from './TemplateEditorCanvas/drawing/helpers';

const CELL_DND_MIME = 'application/reel-cell-type';
const CELL_IMAGE_DND_MIME = 'application/reel-cell-image';   // payload: an image URL (brand logo → image cell)

// Two stacked cells with the video band between them.
const cellsIcon = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="4" y="3.5" width="16" height="5.5" rx="1.5" />
    <path d="M7.5 12h9" />
    <rect x="4" y="15" width="16" height="5.5" rx="1.5" />
  </svg>
);

// View-toggle icons (toolbar): a rule-of-thirds grid for the alignment guidelines, a nested frame for
// the Instagram safe zone.
const guidesIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </svg>
);
const safeZoneIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <rect x="7" y="7" width="10" height="10" rx="1.5" strokeDasharray="2.4 2.4" />
  </svg>
);
// Gear — the rail's Settings category (houses the editor-overlay toggles).
const settingsIcon = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

// Instagram Reels safe content area inside the 1080×1920 frame: margins top 108 / bottom 320 / left 60 /
// right 120 (Buffer/Later/etc. consensus). Content kept inside this rect clears IG's chrome — the top
// bar, the right action-button column, and the bottom caption/profile/audio block.
const IG_SAFE = { x: 60, y: 108, w: 900, h: 1492 };

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const PREVIEW_W = CANVAS_W * DISPLAY_SCALE;   // ~410 — base display size the lane fits to
const PREVIEW_H = CANVAS_H * DISPLAY_SCALE;   // ~730
// Supersample the preview canvas buffer so it stays crisp when zoomed in (CSS-zoom past the buffer
// size would otherwise upsample the 1080px canvas and soften thin lines like the avatar stroke).
const PREVIEW_SS = 2;

// ── Rail drag items + canvas drop zones for cell content ─────────────────────
const CELL_ITEMS: { type: ReelsCellType; label: string }[] = [
  { type: 'banner', label: 'Banner' },
  { type: 'bannerText', label: 'Banner + text' },
  { type: 'text', label: 'Text' },
  { type: 'image', label: 'Image' },
];

// A mini wireframe of what each cell item will look like once dropped.
function CellSkeleton({ type }: { type: ReelsCellType }) {
  const banner = (
    <div className="flex items-center gap-2">
      <div className="size-6 rounded-full bg-fg/20 shrink-0" />
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <div className="h-1.5 w-2/3 rounded-full bg-fg/25" />
        <div className="h-1.5 w-1/2 rounded-full bg-fg/15" />
      </div>
    </div>
  );
  if (type === 'bannerText') {
    return (
      <div className="flex flex-col gap-1.5">
        {banner}
        <div className="flex flex-col gap-1 py-0.5">
          <div className="h-1.5 w-full rounded-full bg-fg/20" />
          <div className="h-1.5 w-5/6 rounded-full bg-fg/20" />
        </div>
      </div>
    );
  }
  if (type === 'banner') return banner;
  if (type === 'text') {
    return (
      <div className="flex flex-col gap-1.5 py-0.5">
        <div className="h-1.5 w-full rounded-full bg-fg/20" />
        <div className="h-1.5 w-5/6 rounded-full bg-fg/20" />
        <div className="h-1.5 w-2/3 rounded-full bg-fg/20" />
      </div>
    );
  }
  // image
  return (
    <div className="h-10 rounded-md bg-fg/10 flex items-center justify-center">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-fg/30" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="M21 16l-5-5L5 20" />
      </svg>
    </div>
  );
}

// One draggable chip: the skeleton + a hover pill tooltip portalled to <body> so it isn't clipped
// by the flyout's overflow. Drop it onto a cell to set that cell's content.
function CellChip({ type, label }: { type: ReelsCellType; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <div
        ref={ref}
        draggable
        onDragStart={e => {
          e.dataTransfer.setData(CELL_DND_MIME, type);
          e.dataTransfer.setData('text/plain', label);
          e.dataTransfer.effectAllowed = 'copy';
          setTip(null);
        }}
        onMouseEnter={() => {
          const el = ref.current;
          if (!el) return;
          const r = el.getBoundingClientRect();
          // Anchor to the flyout's right edge (not the chip's) so the pill sits clear of the box.
          const flyout = el.closest('.overflow-y-auto');
          setTip({ x: (flyout ?? el).getBoundingClientRect().right, y: r.top + r.height / 2 });
        }}
        onMouseLeave={() => setTip(null)}
        className="rounded-lg border border-line bg-surface-2 hover:border-line-strong cursor-grab active:cursor-grabbing select-none p-2.5"
      >
        <CellSkeleton type={type} />
      </div>
      {tip && createPortal(
        <span
          role="tooltip"
          className="pointer-events-none fixed z-[100] -translate-y-1/2 whitespace-nowrap rounded-lg bg-surface-overlay border border-line shadow-2 px-2.5 py-1 text-caption text-fg"
          style={{ left: tip.x + 12, top: tip.y }}
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  );
}

// Dashed rounded square — the "Element outlines" toggle.
const outlineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" strokeDasharray="3.5 3" />
  </svg>
);

// Settings flyout in the element rail — editor-only view overlays (guidelines, IG safe zone, element outlines).
// These used to live in the toolbar; the rail's gear icon now houses them.
function SettingsFlyout({ showGuides, onToggleGuides, showSafeZone, onToggleSafeZone, showOutlines, onToggleOutlines }: {
  showGuides: boolean; onToggleGuides: (v: boolean) => void;
  showSafeZone: boolean; onToggleSafeZone: (v: boolean) => void;
  showOutlines: boolean; onToggleOutlines: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-caption text-fg-3 px-0.5 pb-1">Editor overlays</p>
      <div className="flex items-center gap-2.5 px-0.5 py-1">
        <span className="shrink-0 text-fg-2">{guidesIcon}</span>
        <span className="flex-1 text-caption text-fg">Guidelines</span>
        <Switch label="Alignment guidelines" checked={showGuides} onChange={onToggleGuides} />
      </div>
      <div className="flex items-center gap-2.5 px-0.5 py-1">
        <span className="shrink-0 text-fg-2">{safeZoneIcon}</span>
        <span className="flex-1 text-caption text-fg">Instagram safe zone</span>
        <Switch label="Instagram safe zone" checked={showSafeZone} onChange={onToggleSafeZone} />
      </div>
      <div className="flex items-center gap-2.5 px-0.5 py-1">
        <span className="shrink-0 text-fg-2">{outlineIcon}</span>
        <span className="flex-1 text-caption text-fg">Element outlines</span>
        <Switch label="Element outlines" checked={showOutlines} onChange={onToggleOutlines} />
      </div>
    </div>
  );
}

// Draggable chips in the rail flyout — each shows a skeleton of its layout (name on hover).
function CellItemsFlyout() {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-fg-3 px-0.5 pb-0.5">{REELS_CELLS_ENABLED ? 'Drag onto a cell, or anywhere on the canvas to place it freely.' : 'Drag onto the canvas to place an item anywhere.'}</p>
      {CELL_ITEMS.map(it => <CellChip key={it.type} type={it.type} label={it.label} />)}
    </div>
  );
}

// Transparent overlay over one cell: accepts a dropped rail item, and (when filled) shows a hover ✕
// to clear the cell.
function CellDropZone({ style, regW, regH, cellType, selected, avatarRect, onDropType, onDropImage, onClear, onSelect, onFreeDrop }: {
  style: CSSProperties; regW: number; regH: number; cellType: ReelsCellType; selected?: boolean;
  avatarRect?: { left: number; top: number; width: number; height: number };   // banner: confine the drop highlight to the avatar
  onDropType: (t: ReelsCellType) => void; onDropImage?: (url: string) => void; onClear?: () => void; onSelect?: () => void;
  onFreeDrop?: (e: ReactDragEvent) => void;   // fallback: a drop this cell can't accept becomes a free element here
}) {
  const [over, setOver] = useState(false);
  const filled = cellType !== 'empty';
  const canDropImage = cellType === 'empty' || cellType === 'image' || cellType === 'banner';   // brand logo → image cell, or a banner avatar
  // The hover outline + ✕ stay visible while the cell is selected (click-to-select). `shown` keeps the
  // same opacity classes for hover and selected so the selected state IS the persisted hover effect.
  const shown = selected ? 'opacity-100' : 'opacity-0 group-hover/cell:opacity-100';
  return (
    <div
      style={style}
      onClick={() => onSelect?.()}
      onDragOver={e => {
        // A brand-logo image drops onto an empty OR image cell; a cell-type chip only onto an empty cell.
        // Anything this cell can't accept falls through to onFreeDrop (a free element at the drop point), so
        // dropping onto a filled cell isn't a dead zone. Not-our-drag → leave preventDefault uncalled.
        const types = e.dataTransfer.types;
        const imageDrag = types.includes(CELL_IMAGE_DND_MIME);
        if (!imageDrag && !types.includes(CELL_DND_MIME)) return;
        const acceptsAsCell = imageDrag ? canDropImage : !filled;
        if (!acceptsAsCell && !onFreeDrop) return;   // nothing would happen → mark as a non-target
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (acceptsAsCell !== over) setOver(acceptsAsCell);   // highlight only when it'll fill the cell
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        const url = e.dataTransfer.getData(CELL_IMAGE_DND_MIME);
        if (url) {                                            // brand-logo image
          if (canDropImage) onDropImage?.(url); else onFreeDrop?.(e);
          return;
        }
        const t = e.dataTransfer.getData(CELL_DND_MIME) as ReelsCellType;
        if (!filled) { if (t) onDropType(t); return; }        // cell-type chip onto an empty cell
        onFreeDrop?.(e);                                      // chip onto a filled cell → free element
      }}
      className={`group/cell absolute rounded-[6%] transition-colors ${filled ? 'cursor-pointer' : ''} ${over && !avatarRect ? 'bg-white/10 outline-dashed outline-2 outline-white/50' : ''}`}
    >
      {/* Banner: while dragging an image over, highlight just the avatar (where it lands), not the whole cell. */}
      {over && avatarRect && (
        <div
          aria-hidden
          className="pointer-events-none absolute bg-white/15 outline-dashed outline-2 outline-white/60 rounded-full"
          style={{ left: `${avatarRect.left}%`, top: `${avatarRect.top}%`, width: `${avatarRect.width}%`, height: `${avatarRect.height}%` }}
        />
      )}
      {/* The SAME dashed box an empty cell draws (matched via an SVG in the cell's canvas units —
          #3f3f46, 3px, dash 14/12, radius 24 — so it scales identically). Shown on hover, and kept
          on while the cell is selected. */}
      {filled && (
        <svg
          aria-hidden
          viewBox={`0 0 ${regW} ${regH}`}
          preserveAspectRatio="none"
          className={`pointer-events-none absolute inset-0 h-full w-full transition-opacity ${shown}`}
        >
          <rect x="1.5" y="1.5" width={regW - 3} height={regH - 3} rx="24" ry="24" fill="none" stroke="#3f3f46" strokeWidth="3" strokeDasharray="14 12" />
        </svg>
      )}
      {filled && onClear && (
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onClear(); }}
          aria-label="Remove cell content"
          title="Remove"
          className={`absolute top-2 right-2 flex items-center justify-center size-7 rounded-full bg-black/55 text-white transition-opacity hover:bg-black/80 focus-ring ${shown}`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      )}
    </div>
  );
}

// ── Free-form overlay elements (drag onto the canvas; move / resize / select / delete) ──────────
const FREE_DEFAULT_SIZE: Record<'banner' | 'text' | 'image' | 'bannerText', { w: number; h: number }> = {
  banner:     { w: 760, h: 108 },   // height auto-fits the avatar square (= the default avatarSize); just a seed
  bannerText: { w: 760, h: 320 },   // height auto-fits banner + text; this is just the initial seed
  text:       { w: 700, h: 180 },
  image:      { w: 520, h: 520 },
};

// Build a new free element of `type`, centred at canvas point (cx, cy). Seed it with the canonical per-type
// default style — the SAME defaults a cell gets (defaultBannerStyle/defaultTextStyle/defaultImageStyle, what
// a cell's "Reset to defaults" stamps) — so a free element is styled identically to the cell version of it,
// explicitly and independent of any template-level drift.
function makeFreeElement(type: 'banner' | 'text' | 'image' | 'bannerText', cx: number, cy: number, imageUrl?: string): FreeElement {
  const { w, h } = FREE_DEFAULT_SIZE[type];
  const id = 'fe-' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
  const el: FreeElement = { id, type, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h };
  if (type === 'banner') el.banner = defaultBannerStyle();
  else if (type === 'text') el.textStyle = defaultTextStyle();
  else if (type === 'bannerText') { el.banner = defaultBannerTextBannerStyle(); el.textStyle = defaultBannerTextTextStyle(); el.bannerTextGap = DEFAULT_BANNER_TEXT_GAP; }
  else { el.imageStyle = defaultImageStyle(); if (imageUrl) el.imageUrl = imageUrl; }
  return el;
}

// Screen point → canvas (1080×1920) coords via the canvas's on-screen rect (which already reflects the
// editor's CSS zoom + display scale), so it stays correct at any zoom level.
function screenToCanvasPt(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left) / r.width * CANVAS_W, y: (clientY - r.top) / r.height * CANVAS_H };
}

const FREE_MIN = 80;   // min free-element size, canvas px (large enough that the resize handles don't overlap)
// Keep at least half the element on-canvas so its overlay (and its move/resize/delete controls) is always
// reachable — you can never drag an element fully off the canvas and lose it. Mirrors the carousel canvas.
const clampFreeX = (x: number, w: number) => Math.max(-w / 2, Math.min(CANVAS_W - w / 2, x));
const clampFreeY = (y: number, h: number) => Math.max(-h / 2, Math.min(CANVAS_H - h / 2, y));

// ── Snap to guidelines ─────────────────────────────────────────────────────────
// Nudge a dragged/resized free element so its nearest edge or centre lands on a guideline: the centre
// cross (x=540, y=960) or the padding box (inset by `pad` on every side). Always-on, like the carousel.
const SNAP_THR = 12;   // canvas-px threshold (matches the carousel's SNAP_PX)
const reelGuidesV = (pad: number) => [pad, CANVAS_W / 2, CANVAS_W - pad];   // vertical guide lines (x)
const reelGuidesH = (pad: number) => [pad, CANVAS_H / 2, CANVAS_H - pad];   // horizontal guide lines (y)
function nearestGuide(v: number, guides: number[]): number | null {
  let best: number | null = null, bd = SNAP_THR + 1;
  for (const g of guides) { const d = Math.abs(v - g); if (d <= SNAP_THR && d < bd) { bd = d; best = g; } }
  return best;
}
// Snap a size-long box (top-left = lo) along one axis: try its near edge, centre, and far edge against
// the guides; return the new top-left + the guide it landed on (closest of the three), or null.
function snapAxis(lo: number, size: number, guides: number[]): { pos: number; g: number } | null {
  let best: { pos: number; g: number; d: number } | null = null;
  for (const off of [0, size / 2, size]) {
    const g = nearestGuide(lo + off, guides);
    if (g != null) { const d = Math.abs((lo + off) - g); if (!best || d < best.d) best = { pos: g - off, g, d }; }
  }
  return best;
}
const FREE_HANDLES: { id: string; style: CSSProperties; cursor: string }[] = [
  { id: 'nw', style: { top: -5, left: -5 },                       cursor: 'nwse-resize' },
  { id: 'ne', style: { top: -5, right: -5 },                      cursor: 'nesw-resize' },
  { id: 'sw', style: { bottom: -5, left: -5 },                    cursor: 'nesw-resize' },
  { id: 'se', style: { bottom: -5, right: -5 },                   cursor: 'nwse-resize' },
  { id: 'n',  style: { top: -5, left: '50%', marginLeft: -5 },    cursor: 'ns-resize' },
  { id: 's',  style: { bottom: -5, left: '50%', marginLeft: -5 }, cursor: 'ns-resize' },
  { id: 'w',  style: { left: -5, top: '50%', marginTop: -5 },     cursor: 'ew-resize' },
  { id: 'e',  style: { right: -5, top: '50%', marginTop: -5 },    cursor: 'ew-resize' },
];

// Interaction overlays for free elements: one absolute div per element (positioned as % of the canvas),
// handling click-to-select, drag-to-move, resize handles, and delete. The canvas underneath does the draw.
function FreeElementLayer({ elements, canvasRef, settings, selectedId, onSelect, onChange, onFreeDrop, pad, showOutlines }: {
  elements: FreeElement[];
  canvasRef: RefObject<HTMLCanvasElement | null>;
  settings: TwitterTemplateSettings;   // template settings → resolve a banner element's avatar rect for the drop hint
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (els: FreeElement[]) => void;
  onFreeDrop?: (e: ReactDragEvent) => void;   // dropping a chip onto an existing element creates a new one here
  pad: number;   // padding-box inset (settings.cellMargin) → snap targets + flash lines
  showOutlines?: boolean;   // false → hide the dashed outline on UNSELECTED elements (selected stays visible)
}) {
  // Guide(s) the current drag/resize is snapped to (canvas coords), shown as flash lines; null = none.
  const [snap, setSnap] = useState<{ gx: number | null; gy: number | null }>({ gx: null, gy: null });
  // The banner element currently under an image drag (→ show the avatar drop hint on it).
  const [avatarDragId, setAvatarDragId] = useState<string | null>(null);
  const [imageDropId, setImageDropId] = useState<string | null>(null);   // image element being hovered with a brand upload
  const scale = () => { const c = canvasRef.current; return c ? c.getBoundingClientRect().width / CANVAS_W : 1; };
  // Text / banner / bannerText boxes auto-fit their content height, so the overlay (selection box, handles,
  // drag/snap bounds) must use the SAME measured height the canvas draws with — never the stored el.height —
  // so the blue box HUGS the content. Delegates to the shared effectiveFreeElementHeight (the single source
  // of truth, also used by the crop-shift) so the overlay and the canvas draw can't drift apart.
  const effHeight = (el: FreeElement): number => effectiveFreeElementHeight(el, settings);

  // Window pointermove handlers are bound once at pointerdown, so they'd close over a stale `elements`
  // snapshot. Read the latest array from a ref instead, so a concurrent edit to ANOTHER element during a
  // drag (e.g. an undo, or a settings-panel change) isn't reverted on the next move. Only the dragged
  // element's rect is overwritten — its rect comes from the captured pointerdown start, not the array.
  const elementsRef = useRef(elements);
  useEffect(() => { elementsRef.current = elements; }, [elements]);

  // Set a banner element's custom avatar image (dropped from Brand uploads onto the avatar), mirroring the
  // old banner-cell behavior. Reads the latest array via the ref so it doesn't clobber a concurrent edit.
  const setAvatar = (id: string, url: string) =>
    onChange(elementsRef.current.map(it => it.id === id ? { ...it, banner: { ...(it.banner ?? {}), avatarUrl: url } } : it));
  // Set an image element's picture (dropped from Brand uploads onto the image), mirroring setAvatar.
  const setImage = (id: string, url: string) =>
    onChange(elementsRef.current.map(it => it.id === id ? { ...it, imageUrl: url } : it));

  const startMove = (e: ReactPointerEvent, el: FreeElement) => {
    e.stopPropagation();
    onSelect(el.id);
    const sc = scale();
    const elH = effHeight(el);   // text auto-height — fixed for this drag (width/text don't change while moving)
    const start = { mx: e.clientX, my: e.clientY, x: el.x, y: el.y };
    const move = (ev: PointerEvent) => {
      const rx = Math.round(start.x + (ev.clientX - start.mx) / sc);
      const ry = Math.round(start.y + (ev.clientY - start.my) / sc);
      const sx = snapAxis(rx, el.width, reelGuidesV(pad));
      const sy = snapAxis(ry, elH, reelGuidesH(pad));
      const nx = clampFreeX(sx ? sx.pos : rx, el.width);
      const ny = clampFreeY(sy ? sy.pos : ry, elH);
      // Flash a guide only if the snap survived the clamp (else the line wouldn't match the element).
      const gx = sx && nx === sx.pos ? sx.g : null, gy = sy && ny === sy.pos ? sy.g : null;
      setSnap(prev => (prev.gx === gx && prev.gy === gy ? prev : { gx, gy }));
      onChange(elementsRef.current.map(it => it.id === el.id ? { ...it, x: nx, y: ny } : it));
    };
    const up = () => { setSnap({ gx: null, gy: null }); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startResize = (e: ReactPointerEvent, el: FreeElement, handle: string) => {
    e.stopPropagation();
    onSelect(el.id);
    const sc = scale();
    const s0 = { mx: e.clientX, my: e.clientY, x: el.x, y: el.y, w: el.width, h: el.height };
    const hasE = handle.includes('e'), hasW = handle.includes('w'), hasS = handle.includes('s'), hasN = handle.includes('n');
    // Auto-height elements (text, banner, bannerText) only resize their width (e/w handles) — height auto-fits
    // the content. Keep the stored height in sync with the box so el.height is never a stale value (the draw
    // re-derives it, but other readers shouldn't see a misleading number).
    const isTextEl = el.type === 'text';
    const isBannerTextEl = el.type === 'bannerText';
    const isBannerEl = el.type === 'banner';
    const textContent = isTextEl ? reelTextContent(el, { placeholder: true }).text : '';
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - s0.mx) / sc, dy = (ev.clientY - s0.my) / sc;
      let x = s0.x, y = s0.y, w = s0.w, h = s0.h;
      if (hasE) w = Math.max(FREE_MIN, s0.w + dx);
      if (hasS) h = Math.max(FREE_MIN, s0.h + dy);
      if (hasW) { w = Math.max(FREE_MIN, s0.w - dx); x = s0.x + (s0.w - w); }
      if (hasN) { h = Math.max(FREE_MIN, s0.h - dy); y = s0.y + (s0.h - h); }
      // Snap the dragged edge(s) to the nearest guide (centre cross / padding box), keeping size ≥ FREE_MIN.
      const vG = reelGuidesV(pad), hG = reelGuidesH(pad);
      let gx: number | null = null, gy: number | null = null;
      if (hasE) { const g = nearestGuide(x + w, vG); if (g != null && g - x >= FREE_MIN) { w = g - x; gx = g; } }
      if (hasW) { const g = nearestGuide(x, vG); if (g != null && (x + w) - g >= FREE_MIN) { w = (x + w) - g; x = g; gx = g; } }
      if (hasS) { const g = nearestGuide(y + h, hG); if (g != null && g - y >= FREE_MIN) { h = g - y; gy = g; } }
      if (hasN) { const g = nearestGuide(y, hG); if (g != null && (y + h) - g >= FREE_MIN) { h = (y + h) - g; y = g; gy = g; } }
      setSnap(prev => (prev.gx === gx && prev.gy === gy ? prev : { gx, gy }));
      // No position clamp needed: a w/n resize keeps the opposite (e/s) edge anchored on-canvas, so the
      // element can never be resized fully off-screen once moves are clamped.
      const nh = isTextEl ? measureReelTextBoxHeight(textContent, Math.round(w), el.textStyle)
               : isBannerTextEl ? measureReelBannerTextHeight(el, Math.round(w), settings)
               : isBannerEl ? effectiveFreeElementHeight(el, settings)   // tight banner height (width-independent)
               : Math.round(h);
      onChange(elementsRef.current.map(it => it.id === el.id ? { ...it, x: Math.round(x), y: Math.round(y), width: Math.round(w), height: nh } : it));
    };
    const up = () => { setSnap({ gx: null, gy: null }); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      {elements.map(el => {
        if (el.hidden) return null;   // hidden via the Layers panel → no interaction overlay (and not drawn)
        const sel = el.id === selectedId;
        const isAutoH = el.type === 'text' || el.type === 'bannerText' || el.type === 'banner';   // auto-height → width-only resize
        const elH = effHeight(el);   // text/banner/bannerText → auto-fit content height; others → stored height
        return (
          <div
            key={el.id}
            onPointerDown={e => startMove(e, el)}
            onClick={e => e.stopPropagation()}   // keep a click on the element from bubbling to the canvas/void deselect
            onDragOver={onFreeDrop ? (e => {
              const types = e.dataTransfer.types;
              const imageDrag = types.includes(CELL_IMAGE_DND_MIME);
              if (!imageDrag && !types.includes(CELL_DND_MIME)) return;
              e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
              // An image dragged over a banner element will set its avatar → hint the avatar; anything else
              // (a type chip, or an image over a non-banner element) will create a new element on drop.
              setAvatarDragId(imageDrag && (el.type === 'banner' || el.type === 'bannerText') ? el.id : null);
              setImageDropId(imageDrag && el.type === 'image' ? el.id : null);
            }) : undefined}
            onDragLeave={onFreeDrop ? (() => { setAvatarDragId(prev => (prev === el.id ? null : prev)); setImageDropId(prev => (prev === el.id ? null : prev)); }) : undefined}
            onDrop={onFreeDrop ? (e => {
              setAvatarDragId(null); setImageDropId(null);
              const url = e.dataTransfer.getData(CELL_IMAGE_DND_MIME);
              if (url && (el.type === 'banner' || el.type === 'bannerText')) {   // image → set THIS banner's avatar
                e.preventDefault(); e.stopPropagation();
                setAvatar(el.id, url);
                return;
              }
              if (url && el.type === 'image') {   // image → set THIS image element's picture (mirrors the banner)
                e.preventDefault(); e.stopPropagation();
                setImage(el.id, url);
                return;
              }
              onFreeDrop(e);   // type chip, or image on a text element → create a new free element
            }) : undefined}
            className="absolute"
            style={{
              left: `${(el.x / CANVAS_W) * 100}%`,
              top: `${(el.y / CANVAS_H) * 100}%`,
              width: `${(el.width / CANVAS_W) * 100}%`,
              height: `${(elH / CANVAS_H) * 100}%`,
              cursor: 'move',
              outline: sel ? '2px solid rgba(96,165,250,0.95)' : ((showOutlines ?? true) ? '1px dashed rgba(255,255,255,0.4)' : 'none'),
              outlineOffset: '-1px',
              touchAction: 'none',
            }}
          >
            {/* Avatar drop hint — while an image is dragged over a banner element, highlight just the avatar
                (where the dropped image lands), matching the old banner-cell drop. */}
            {(el.type === 'banner' || el.type === 'bannerText') && avatarDragId === el.id && (() => {
              const bs = { ...settings, ...(el.banner ?? {}) };
              // Place the highlight on the avatar. Both 'banner' and 'bannerText' draw the header shifted so the
              // avatar's stroke ring lands on the box's top-left edge — shift the cell origin up by topInset (and
              // right by leftInset for a wide ring) so the rect matches where the draw puts the avatar.
              const bbox = sonotradeBannerBox(bs);
              const ar = bannerAvatarRectInCell(el.x + bbox.leftInset, el.y - bbox.topInset, reelBannerHeight(bs), bs);
              return (
                <div
                  aria-hidden
                  className="pointer-events-none absolute bg-white/15 outline-dashed outline-2 outline-white/60 rounded-full"
                  style={{
                    left: `${((ar.x - el.x) / el.width) * 100}%`,
                    top: `${((ar.y - el.y) / elH) * 100}%`,
                    width: `${(ar.size / el.width) * 100}%`,
                    height: `${(ar.size / elH) * 100}%`,
                  }}
                />
              );
            })()}
            {/* Image drop hint — while a brand upload is dragged over an image element, highlight the whole
                element (where the dropped picture lands), mirroring the banner's avatar hint. */}
            {el.type === 'image' && imageDropId === el.id && (
              <div aria-hidden className="pointer-events-none absolute inset-0 bg-white/15 outline-dashed outline-2 outline-white/60 rounded-lg" />
            )}
            {/* A text box auto-fits its height, so it only resizes horizontally (the left/right handles);
                every other element keeps all eight handles. */}
            {sel && (isAutoH ? FREE_HANDLES.filter(hh => hh.id === 'e' || hh.id === 'w') : FREE_HANDLES).map(hh => (
              <div
                key={hh.id}
                onPointerDown={e => startResize(e, el, hh.id)}
                className="absolute bg-white border border-[#60a5fa] rounded-[2px]"
                style={{ ...hh.style, width: 10, height: 10, cursor: hh.cursor, touchAction: 'none' }}
              />
            ))}
          </div>
        );
      })}
      {/* Snap flash — the guide line(s) the current drag/resize landed on (cleared on release). */}
      {(snap.gx != null || snap.gy != null) && (
        <svg className="pointer-events-none absolute" viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} preserveAspectRatio="none" aria-hidden
             style={{ pointerEvents: 'none', top: 1, left: 1, width: 'calc(100% - 2px)', height: 'calc(100% - 2px)' }}>
          {snap.gx != null && <line x1={snap.gx} y1={0} x2={snap.gx} y2={CANVAS_H} stroke="#c084fc" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
          {snap.gy != null && <line x1={0} y1={snap.gy} x2={CANVAS_W} y2={snap.gy} stroke="#c084fc" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
        </svg>
      )}
    </>
  );
}

// Editor-only overlays drawn OVER the reels preview canvas (pointer-events-none; never exported — the
// export path renders a SEPARATE OffscreenCanvas). Coordinates use the canvas's own 1080×1920 space via a
// matching SVG viewBox, so guides stay pixel-aligned at every zoom; non-scaling strokes keep lines crisp.
function ReelGuidesOverlay({ showGuides, showSafeZone, pad }: { showGuides: boolean; showSafeZone: boolean; pad: number }) {
  if (!showGuides && !showSafeZone) return null;
  const W = CANVAS_W, H = CANVAS_H, S = IG_SAFE;
  // Inset 1px to sit on the canvas's bitmap: the <canvas> has a 1px border + box-sizing:border-box, so its
  // drawing surface is inset 1px. preserveAspectRatio="none" matches the canvas's own stretch of the
  // 1080×1920 bitmap into that bordered box, so guides land exactly on the rendered content.
  return (
    <svg className="pointer-events-none absolute" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden
         style={{ pointerEvents: 'none', top: 1, left: 1, width: 'calc(100% - 2px)', height: 'calc(100% - 2px)' }}>
      {showSafeZone && (
        <>
          {/* Shade everything OUTSIDE the safe rect (one even-odd path → no doubled corners). */}
          <path d={`M0 0H${W}V${H}H0Z M${S.x} ${S.y}H${S.x + S.w}V${S.y + S.h}H${S.x}Z`}
                fillRule="evenodd" fill="rgba(244,63,94,0.16)" />
          {/* Safe-area boundary. */}
          <rect x={S.x} y={S.y} width={S.w} height={S.h} fill="none" stroke="rgba(255,255,255,0.9)"
                strokeWidth={1.5} strokeDasharray="7 5" vectorEffect="non-scaling-stroke" />
          {/* Region labels (haloed so they read on any background). */}
          <g fill="#fff" stroke="rgba(0,0,0,0.55)" strokeWidth={5} paintOrder="stroke"
             fontFamily="-apple-system, BlinkMacSystemFont, sans-serif" fontWeight={700} textAnchor="middle">
            <text x={W / 2} y={78} fontSize={42}>Top bar</text>
            <text x={W / 2} y={1776} fontSize={42}>Caption · profile · audio</text>
            <text x={1018} y={1080} fontSize={40} transform="rotate(90 1018 1080)">Actions</text>
          </g>
        </>
      )}
      {showGuides && (
        <g stroke="#a855f7" fill="none">
          {/* Layout-padding box — tracks the "Padding" slider (cellMargin), inset on all four sides to
              match reelLayout. Dashed so it reads as a margin guide, distinct from the centre axes. */}
          <rect x={pad} y={pad} width={Math.max(0, W - 2 * pad)} height={Math.max(0, H - 2 * pad)}
                strokeWidth={1.5} strokeDasharray="8 6" opacity={0.85} vectorEffect="non-scaling-stroke" />
          {/* Centre axes — one vertical, one horizontal. */}
          <line x1={W / 2} y1={0} x2={W / 2} y2={H} strokeWidth={1.5} opacity={0.9} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={H / 2} x2={W} y2={H / 2} strokeWidth={1.5} opacity={0.9} vectorEffect="non-scaling-stroke" />
        </g>
      )}
    </svg>
  );
}

// Live header preview: draws the real overlay (via drawHeaderOnContext) over a placeholder video block,
// so the user sees exactly how a reel will look as they tweak the style. The canvas is full-res
// (1080×1920) internally, so `canvasRef` can be exported straight to a PNG.
function Preview({ settings, brand, canvasRef, onCellDrop, onCellImage, selectedCell, onSelectCell, freeElements, selectedFreeId, onSelectFree, onFreeChange, showGuides, showSafeZone, showOutlines, pulseKey, onPulseEnd }: {
  settings: TwitterTemplateSettings; brand: BrandProps; canvasRef: RefObject<HTMLCanvasElement | null>;
  onCellDrop?: (cell: ReelCellKey, type: ReelsCellType) => void;
  onCellImage?: (cell: ReelCellKey, url: string) => void;
  selectedCell?: ReelCellKey | null;
  onSelectCell?: (cell: ReelCellKey | null) => void;
  freeElements?: FreeElement[];
  selectedFreeId?: string | null;
  onSelectFree?: (id: string | null) => void;
  onFreeChange?: (els: FreeElement[]) => void;
  showGuides?: boolean;
  showSafeZone?: boolean;
  showOutlines?: boolean;
  pulseKey?: number;   // bumped when the AI applies an edit → flashes a pulse ring over the canvas
  onPulseEnd?: () => void;   // fired at animationend so the parent can drop the node (no lingering overlay)
}) {
  const logoRef = useRef<HTMLImageElement | null>(null);
  const verifiedRef = useRef<HTMLImageElement | null>(null);
  const cellImgRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const [tick, force] = useReducer(x => x + 1, 0);

  // Editor preview always renders the avatar as an image skeleton (template placeholder) — the real
  // reel + the Adjust-avatar cropper still use the brand logo.
  const logoSrc = '';
  const name = settings.defaultDisplayName || brand.displayName || 'Your name';
  const handle = settings.defaultHandle || brand.handle || '@yourhandle';

  // Preload the avatar + verified-badge images; redraw when they arrive.
  useEffect(() => {
    if (!logoSrc) { logoRef.current = null; force(); return; }   // no logo → skeleton
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = force;
    img.src = logoSrc;
    logoRef.current = img;
  }, [logoSrc]);

  useEffect(() => {
    const img = new Image();
    img.onload = force;
    img.src = `data:image/svg+xml;utf8,${encodeURIComponent(VERIFIED_TICK_SVG)}`;
    verifiedRef.current = img;
  }, []);

  // Load any cell / free-element images; redraw when they arrive.
  useEffect(() => {
    for (const cell of [settings.cellTop, settings.cellTop2, settings.cellBottom, settings.cellBottom2, ...(settings.freeElements ?? [])]) {
      const url = cell?.type === 'image' ? cell.imageUrl : (cell?.type === 'banner' || cell?.type === 'bannerText') ? cell.banner?.avatarUrl : undefined;
      if (!url || cellImgRef.current.has(url)) continue;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = force;
      img.src = url;
      cellImgRef.current.set(url, img);
    }
  }, [settings.cellTop, settings.cellTop2, settings.cellBottom, settings.cellBottom2, settings.freeElements]);

  // Load any custom/Google fonts used by text cells / free elements (canvas won't lazy-load a font); redraw on arrival.
  useEffect(() => {
    let cancelled = false;
    for (const cell of [settings.cellTop, settings.cellTop2, settings.cellBottom, settings.cellBottom2, ...(settings.freeElements ?? [])]) {
      if (cell?.type !== 'text' && cell?.type !== 'bannerText') continue;
      const tstyle = cell.textStyle ?? {};
      ensureFontLoaded(resolveCarouselFont(tstyle.fontLabel ?? DEFAULT_TEXT_FONT), tstyle.fontWeight ?? 600, !!tstyle.italic)
        .then(() => { if (!cancelled) force(); });
    }
    return () => { cancelled = true; };
  }, [settings.cellTop, settings.cellTop2, settings.cellBottom, settings.cellBottom2, settings.freeElements]);

  // The reel header (name/handle/caption) always renders in Libre Franklin. A canvas won't lazy-load an
  // @font-face by itself, so explicitly load the self-hosted face on mount and redraw once it's ready —
  // otherwise a header-only reel (no text cells) would paint the header in the fallback on first paint.
  useEffect(() => {
    let cancelled = false;
    document.fonts.load('700 40px "Libre Franklin"').then(() => { if (!cancelled) force(); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // An uploaded (custom) font's FontFace is added to document.fonts asynchronously after it loads, so the
  // effect above can resolve before it's ready; subscribe to the font registry and redraw when it changes
  // so a custom-font text cell repaints once the face is available (mirrors the carousel canvas).
  const customFonts = useCustomFonts();
  useEffect(() => { force(); }, [customFonts]);

  // useLayoutEffect: draw before the browser paints, so a freshly-mounted canvas (e.g. Reels right
  // after the editor swap) shows the rendered reel on its very first frame instead of flashing blank.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    // Map 1080-space drawing onto the supersampled buffer (everything below stays in 1080 coords).
    ctx.setTransform(PREVIEW_SS, 0, 0, PREVIEW_SS, 0, 0);

    const L = reelLayout(settings);
    // Only hand back a fully-loaded image (match the live canvas) — drawReelCell falls back to the
    // placeholder otherwise, so a just-dropped logo shows the placeholder until its onload redraws.
    const getCellImg = (url?: string) => {
      const img = url ? cellImgRef.current.get(url) : undefined;
      return img && img.complete && img.naturalWidth > 0 ? img : null;
    };

    // Background
    ctx.fillStyle = settings.headerBgColor;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Cells — top·top2 above, bottom·bottom2 below
    drawReelCells({ ctx, s: settings, L, logoSrc, name, handle, logoImgRef: logoRef, verifiedImgRef: verifiedRef, getCellImg, placeholder: true });

    // The video band is a reorderable z-layer: free elements before `videoLayer` draw BEHIND the band.
    const videoLayer = settings.videoLayer ?? 0;
    drawFreeElements({ ctx, s: settings, logoSrc, name, handle, logoImgRef: logoRef, verifiedImgRef: verifiedRef, getCellImg, placeholder: true, to: videoLayer });

    // Centred video band placeholder
    ctx.fillStyle = '#18181b';
    ctx.beginPath();
    ctx.roundRect(L.bandX, L.bandY, L.bandW, L.bandH, settings.videoCornerRadius ?? 24);
    ctx.fill();
    ctx.fillStyle = '#52525b';
    ctx.font = `500 40px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.fillText('▶  Your video', CANVAS_W / 2, L.bandY + L.bandH / 2);
    ctx.textAlign = 'left';

    // Free-form overlay elements IN FRONT of the band, in array order.
    drawFreeElements({ ctx, s: settings, logoSrc, name, handle, logoImgRef: logoRef, verifiedImgRef: verifiedRef, getCellImg, placeholder: true, from: videoLayer });
  }, [settings, name, handle, logoSrc, tick, canvasRef]);

  const L = reelLayout(settings);
  const free = freeElements ?? [];
  const onCanvasFreeDrop = (e: ReactDragEvent) => {
    if (!onFreeChange) return;
    e.preventDefault();
    const canvas = canvasRef.current; if (!canvas) return;
    const pt = screenToCanvasPt(canvas, e.clientX, e.clientY);
    const imageUrl = e.dataTransfer.getData(CELL_IMAGE_DND_MIME);
    const cellType = e.dataTransfer.getData(CELL_DND_MIME);
    const type = cellType || (imageUrl ? 'image' : '');
    if (type !== 'banner' && type !== 'text' && type !== 'image' && type !== 'bannerText') return;
    const el = makeFreeElement(type, pt.x, pt.y, imageUrl || undefined);
    // A text / bannerText element is the caption by default — but only one may be, so if a caption already
    // exists (on any text or bannerText element) the new one starts as custom text instead.
    if ((type === 'text' || type === 'bannerText') && free.some(e => (e.type === 'text' || e.type === 'bannerText') && (e.isCaption ?? true))) el.isCaption = false;
    onFreeChange([...free, el]);
    onSelectFree?.(el.id);
  };

  return (
    <div className="relative" style={{ width: PREVIEW_W, height: PREVIEW_H }}>
      {pulseKey ? <div key={pulseKey} onAnimationEnd={onPulseEnd} className="de-ai-pulse pointer-events-none absolute inset-0 z-10" aria-hidden /> : null}
      <canvas
        ref={canvasRef}
        width={CANVAS_W * PREVIEW_SS}
        height={CANVAS_H * PREVIEW_SS}
        style={{ width: PREVIEW_W, height: PREVIEW_H }}
        className="block border border-line shadow-2"
      />
      <ReelGuidesOverlay showGuides={!!showGuides} showSafeZone={!!showSafeZone} pad={settings.cellMargin ?? 60} />
      {/* Free-drop layer (under the element overlays; covers the whole canvas while cells are disabled):
          a drop in open space creates a free element; a click on empty space deselects. */}
      {onFreeChange && (
        <div
          className="absolute inset-0"
          // Deselect on pointerdown (NOT click): under the canvas's CSS `zoom`, WebKit fires pointer/mouse
          // events reliably but drops synthesized `click`s — which is why selection (pointerdown) worked but
          // a click-to-deselect didn't. Element/handle pointerdowns stopPropagation, so this only fires on
          // empty canvas. Matches the carousel's onMouseDown background-deselect.
          onPointerDown={() => { onSelectFree?.(null); onSelectCell?.(null); }}
          onDragOver={e => {
            const t = e.dataTransfer.types;
            if (!t.includes(CELL_DND_MIME) && !t.includes(CELL_IMAGE_DND_MIME)) return;
            e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={onCanvasFreeDrop}
        />
      )}
      {REELS_CELLS_ENABLED && onCellDrop && reelCellRegionRects(L).map(reg => {
        const cellObj = reelCellOf(settings, reg.key);
        const cellType = cellObj?.type ?? 'empty';
        const isFilled = cellType !== 'empty';
        // For a banner, confine the image-drop highlight to the rendered avatar rect (as % of the cell).
        let avatarRect: { left: number; top: number; width: number; height: number } | undefined;
        if (cellType === 'banner') {
          const bs = { ...settings, ...(cellObj?.banner ?? {}) };
          const ar = bannerAvatarRectInCell(reg.x, reg.y, reg.h, bs);
          avatarRect = {
            left: ((ar.x - reg.x) / reg.w) * 100,
            top: ((ar.y - reg.y) / reg.h) * 100,
            width: (ar.size / reg.w) * 100,
            height: (ar.size / reg.h) * 100,
          };
        }
        return (
          <CellDropZone
            key={reg.key}
            style={{
              left: `${(reg.x / CANVAS_W) * 100}%`,
              width: `${(reg.w / CANVAS_W) * 100}%`,
              top: `${(reg.y / CANVAS_H) * 100}%`,
              height: `${(reg.h / CANVAS_H) * 100}%`,
            }}
            regW={reg.w}
            regH={reg.h}
            cellType={cellType}
            avatarRect={avatarRect}
            selected={selectedCell === reg.key}
            onSelect={() => onSelectCell?.(isFilled ? reg.key : null)}
            onDropType={t => onCellDrop(reg.key, t)}
            onDropImage={url => onCellImage?.(reg.key, url)}
            onClear={() => onCellDrop(reg.key, 'empty')}
            onFreeDrop={onFreeChange ? onCanvasFreeDrop : undefined}
          />
        );
      })}
      {onFreeChange && (
        <FreeElementLayer
          elements={free}
          canvasRef={canvasRef}
          settings={settings}
          pad={settings.cellMargin ?? 60}
          selectedId={selectedFreeId ?? null}
          onSelect={id => onSelectFree?.(id)}
          onChange={onFreeChange}
          onFreeDrop={onCanvasFreeDrop}
          showOutlines={showOutlines}
        />
      )}
    </div>
  );
}


export function TwitterTemplateEditor({ brand, userId, topIsland, collapseMiddle, onCreate }: { brand: BrandProps; userId: string | null; topIsland?: ReactNode; collapseMiddle?: boolean; onCreate?: () => void }) {
  const {
    templates, loading, loaded, saveState,
    createTemplate, duplicateTemplate, renameTemplate, deleteTemplate, updateSettings,
    undo, redo, canUndo, canRedo,
  } = useTwitterTemplates(userId);

  // Remember the open Reels template across reloads (keyed per user).
  const reelsTplKey = userId ? `de:reels-template:${userId}` : '';
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (typeof window === 'undefined' || !reelsTplKey) return null;
    try { return localStorage.getItem(reelsTplKey); } catch { return null; }
  });
  // Derive the active id (never setState in an effect): fall back to the first template when the
  // selection is empty or stale — e.g. on initial load or right after a delete.
  const activeId = selectedId && templates.some(t => t.id === selectedId) ? selectedId : (templates[0]?.id ?? null);
  const active = templates.find(t => t.id === activeId) ?? null;
  // Build-with-AI copilot for the reel overlay: exposes the active template's compact settings and
  // applies a validated patch through updateSettings (autosave + one ⌘Z step).
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPulseKey, setAiPulseKey] = useState(0);   // bumped on each applied AI edit → pulses the preview
  const reelCopilot = useReelCopilot(active, updateSettings, { displayName: brand.displayName, colors: brand.colors, logoUrl: brand.logoSrc }, () => setAiPulseKey(k => k + 1));
  // Persist the open template so a reload reopens it (paired with the selectedId restore above).
  useEffect(() => {
    if (reelsTplKey && activeId) { try { localStorage.setItem(reelsTplKey, activeId); } catch { /* ignore */ } }
  }, [reelsTplKey, activeId]);

  // ── Selected cell ↔ its settings island (two-way, like the carousel's element selection) ──────
  // Stored with the template id so it auto-clears on a template switch, and only "active" while that
  // cell is still filled (clearing a cell deselects it). selectedCell drives BOTH the cell's persistent
  // canvas outline and the controlled open state of its right-panel island.
  const [selRaw, setSelRaw] = useState<{ id: string; cell: ReelCellKey } | null>(null);
  const selectedCell: ReelCellKey | null =
    selRaw && active && selRaw.id === active.id && (reelCellOf(active.settings, selRaw.cell)?.type ?? 'empty') !== 'empty'
      ? selRaw.cell : null;

  // ── Free-form element selection (scoped to the active template; valid only while the element exists) ──
  const [selFreeRaw, setSelFreeRaw] = useState<{ id: string; freeId: string } | null>(null);
  const selectedFreeId: string | null =
    selFreeRaw && active && selFreeRaw.id === active.id && (active.settings.freeElements ?? []).some(e => e.id === selFreeRaw.freeId)
      ? selFreeRaw.freeId : null;
  const selectFree = (freeId: string | null) => {
    setSelFreeRaw(freeId && activeId ? { id: activeId, freeId } : null);
    if (freeId) setSelRaw(null);   // selecting a free element clears any cell selection
  };
  const updateFreeElements = (els: FreeElement[]) => { if (active) updateSettings(active.id, { freeElements: els }); };

  const selectCell = (cell: ReelCellKey | null) => {
    setSelRaw(cell && activeId ? { id: activeId, cell } : null);
    if (cell) setSelFreeRaw(null);   // selecting a cell clears any free-element selection
  };

  // ── Template dropdown (mirrors the carousel header picker) ───────────────
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownAnchor, setDropdownAnchor] = useState<{ top: number; left: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const editorHeaderRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // ── Zoom + pan (identical to the carousel editor) ────────────────────────
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  // Fade the canvas in once this editor reveals (e.g. after the Carousel⇄Reels swap). State-driven
  // (not a CSS mount-animation) so it plays AFTER the CollapseGate commits, not while still hidden;
  // the rAF lets the opacity:0 frame paint before flipping, so the transition actually runs.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setRevealed(true)); return () => cancelAnimationFrame(id); }, []);
  // Editor view overlays (purple alignment guidelines + the Instagram Reels safe zone). Persisted so the
  // preference survives reloads; namespaced de:reels: to avoid colliding with the carousel editor.
  const [showGuides, setShowGuides] = useState<boolean>(() => { if (typeof window === 'undefined') return false; try { return localStorage.getItem('de:reels:guides') === '1'; } catch { return false; } });
  const [showSafeZone, setShowSafeZone] = useState<boolean>(() => { if (typeof window === 'undefined') return false; try { return localStorage.getItem('de:reels:safe') === '1'; } catch { return false; } });
  // Element outlines default ON (shown); only an explicit '0' hides the dashed outline around free elements.
  const [showOutlines, setShowOutlines] = useState<boolean>(() => { if (typeof window === 'undefined') return true; try { return localStorage.getItem('de:reels:outlines') !== '0'; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem('de:reels:guides', showGuides ? '1' : '0'); } catch { /* ignore */ } }, [showGuides]);
  useEffect(() => { try { localStorage.setItem('de:reels:safe', showSafeZone ? '1' : '0'); } catch { /* ignore */ } }, [showSafeZone]);
  useEffect(() => { try { localStorage.setItem('de:reels:outlines', showOutlines ? '1' : '0'); } catch { /* ignore */ } }, [showOutlines]);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lane = useObservedSize(scrollAreaRef);
  const fitFactor = fitScaleFor(lane, PREVIEW_W, PREVIEW_H);
  // Focal-anchored pinch/Ctrl-scroll zoom with a one-shot absolute-100% default (shared editor
  // scaffolding). activeId as refocusKey so a freshly-selected template's canvas centres on mount.
  const { viewScale, setViewScale, captureFocal, attachScroll: attachScrollArea } = useEditorZoomPan({
    scrollRef: scrollAreaRef, contentRef, fitFactor, laneWidth: lane.width, refocusKey: activeId,
  });
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  async function handleNew() {
    const created = await createTemplate();
    if (created) setSelectedId(created.id);
    setShowDropdown(false);
  }

  async function handleDuplicate(id: string) {
    const created = await duplicateTemplate(id);
    if (created) setSelectedId(created.id);
    setShowDropdown(false);
  }

  async function handleDelete(id: string) {
    await deleteTemplate(id);
    if (selectedId === id) setSelectedId(null);
  }

  function handleDownload() {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reel-template-${(active?.name ?? 'template').replace(/\s+/g, '-').toLowerCase()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  // Latest "delete the selected free element" action, read by the keydown handler below. Held in a ref
  // (updated each render) so the global listener never needs to re-bind as the selection changes.
  // Returns true if an element was actually deleted.
  const deleteSelectedFreeRef = useRef<() => boolean>(() => false);
  useEffect(() => {
    deleteSelectedFreeRef.current = () => {
      if (!selectedFreeId || !active) return false;
      updateFreeElements((active.settings.freeElements ?? []).filter(e => e.id !== selectedFreeId));
      selectFree(null);
      return true;
    };
  });

  // Keyboard: ⌘/Ctrl+Z undo, ⌘/Ctrl+Shift+Z or Ctrl+Y redo, and Backspace/Delete to remove the selected
  // free element. All ignored while typing in a field so they don't fire mid-edit.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      // Backspace / Delete (no modifier) → delete the selected free element.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'Backspace' || e.key === 'Delete')) {
        if (deleteSelectedFreeRef.current()) e.preventDefault();
        return;
      }

      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z')      { e.preventDefault(); if (e.shiftKey) redo(activeId); else undo(activeId); }
      else if (k === 'y') { e.preventDefault(); redo(activeId); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, activeId]);

  // Close the template dropdown on outside click.
  useEffect(() => {
    if (!showDropdown) return;
    // Commit an in-progress rename before the dropdown unmounts (onBlur is unreliable on unmount, so
    // clicking away would otherwise discard the rename and force the user to press Enter).
    const flushRename = () => {
      if (renamingId && renameValue.trim()) void renameTemplate(renamingId, renameValue.trim());
      setRenamingId(null);
    };
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!dropdownRef.current?.contains(t) && !panelRef.current?.contains(t)) { flushRename(); setShowDropdown(false); }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showDropdown, renamingId, renameValue, renameTemplate]);

  // First-run / empty state: reels TEMPLATE editor with no templates → prompt to create the first one.
  // Blank (not the editor chrome) while templates load, so the editor doesn't flash for a frame.
  if (templates.length === 0) {
    return loaded ? (
      <TemplatesEmptyState
        title="No reel templates yet"
        description="Create your first template to start designing reels."
        actionLabel="Create your first template"
        onAction={handleNew}
      />
    ) : <div className="h-full w-full" />;
  }

  return (
    <div className="relative w-full flex flex-col h-full overflow-hidden" style={{ ['--ai-panel-w' as string]: aiOpen ? '340px' : '0px' } as React.CSSProperties}>

      {/* Build-with-AI copilot — a full-height left column that slides in and pushes the header +
          canvas right via --ai-panel-w. Mounts only with an active template to edit. */}
      {aiOpen && active && (
        <div className="fixed z-40 flex" style={{ top: 0, bottom: 0, left: RAIL_VAR }}>
          {/* key by template id → switching reels remounts the panel onto that template's own thread
              (the storage key + greeting are captured at mount). */}
          <ReelCopilotPanel key={active.id} userId={userId} copilot={reelCopilot} onClose={() => setAiOpen(false)} onUndoEdit={() => { if (!canUndo(active.id)) return false; undo(active.id); return true; }} />
        </div>
      )}

      {/* Toolbar */}
      <div ref={editorHeaderRef} className="relative flex items-center justify-between gap-4 px-4 border-b border-line shrink-0 bg-surface-1 transition-[padding] duration-[var(--dur-spatial)] ease-[var(--ease-emphasized)]" style={{ height: HEADER_H, paddingLeft: `calc(1rem + var(--ai-panel-w, 0px))` }}>
        {/* Left slot — the Build-with-AI toggle. */}
        {active ? (
          <Button size="sm" variant="ghost" onClick={() => setAiOpen(v => !v)} leadingIcon={<span className="brightness-0 invert">✨</span>}>
            Build with AI
          </Button>
        ) : <div />}

        {/* Templates dropdown — absolutely centred over the canvas area */}
        <div className="absolute inset-x-0 flex justify-center items-center pointer-events-none" style={{ left: 12 }}>
          <div ref={dropdownRef} className="pointer-events-auto relative flex items-center">
            <button
              ref={triggerRef}
              onClick={() => {
                setRenamingId(null);
                setShowDropdown(v => {
                  if (!v && triggerRef.current) {
                    const r = triggerRef.current.getBoundingClientRect();
                    const headerBottom = editorHeaderRef.current?.getBoundingClientRect().bottom ?? r.bottom;
                    setDropdownAnchor({ top: headerBottom + 8, left: r.left + r.width / 2 });
                  }
                  return !v;
                });
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-fg hover:bg-hover transition-colors focus-ring"
            >
              <VideoIcon size={14} className="text-fg-3 shrink-0" aria-hidden />
              <span className="text-subheading text-fg max-w-[160px] truncate" title={active?.name ?? undefined}>
                {active?.name ?? 'Reels templates'}
              </span>
              <ChevronDownIcon size={12} className="text-fg-3 shrink-0" aria-hidden />
            </button>

            {showDropdown && dropdownAnchor && (
              <div
                ref={panelRef}
                className="fixed w-[240px] bg-surface-2 border border-line rounded-xl shadow-3 z-modal py-1 overflow-hidden"
                style={{ top: dropdownAnchor.top, left: dropdownAnchor.left, transform: 'translateX(-50%)' }}
              >
                <div className="max-h-[320px] overflow-y-auto scrollbar-none">
                  {templates.length === 0 ? (
                    <p className="text-caption text-fg-3 px-3 py-4 text-center">No templates yet</p>
                  ) : templates.map(t => {
                    const isActive = t.id === activeId;
                    const isRenaming = renamingId === t.id;
                    return (
                      <div key={t.id} className={`flex items-center gap-1 px-2 ${isActive ? 'bg-active' : ''}`}>
                        {isRenaming ? (
                          <input
                            autoFocus
                            maxLength={NAME_MAX_LENGTH}
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onFocus={e => e.currentTarget.select()}
                            onBlur={() => {
                              if (renameValue.trim()) void renameTemplate(t.id, renameValue.trim());
                              setRenamingId(null);
                            }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.currentTarget.blur(); }
                              if (e.key === 'Escape') { setRenamingId(null); }
                            }}
                            onClick={e => e.stopPropagation()}
                            className="flex-1 bg-surface-3 text-fg text-subheading px-2 py-1.5 rounded-md outline-none focus-ring my-1 min-w-0"
                          />
                        ) : (
                          <button
                            onClick={() => {
                              if (isActive) {
                                setRenameValue(t.name);
                                setRenamingId(t.id);
                              } else {
                                setSelectedId(t.id);
                                setShowDropdown(false);
                              }
                            }}
                            className={`flex-1 flex items-center gap-2 py-2 px-1 text-subheading text-left rounded-sm focus-ring transition-colors min-w-0 ${isActive ? 'text-fg' : 'text-fg-2 hover:text-fg'}`}
                          >
                            <span className="flex-1 truncate" title={t.name}>{t.name}</span>
                          </button>
                        )}
                        {/* Hide row actions while renaming so the input spans the full width (reveals the whole name). */}
                        {!isRenaming && <>
                        <IconButton
                          size="sm"
                          onClick={e => { e.stopPropagation(); void handleDuplicate(t.id); }}
                          label="Duplicate template"
                          className="size-5"
                          icon={
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
                            </svg>
                          }
                        />
                        {/* Delete — hidden for the last one so there's always at least one */}
                        {templates.length > 1 && (
                          <IconButton
                            size="sm"
                            variant="danger"
                            onClick={e => { e.stopPropagation(); setConfirmDelete({ id: t.id, name: t.name }); }}
                            label="Delete template"
                            className="size-5"
                            icon={<CloseIcon size={13} aria-hidden />}
                          />
                        )}
                        </>}
                      </div>
                    );
                  })}
                </div>
                <div className="border-t border-line p-1">
                  <button
                    onClick={() => { setRenamingId(null); void handleNew(); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-subheading text-fg-2 hover:text-fg hover:bg-hover rounded-lg transition-colors focus-ring"
                  >
                    <PlusIcon size={12} aria-hidden />
                    New template
                  </button>
                </div>
              </div>
            )}
            {confirmDelete && (
              <ConfirmDeleteDialog
                slideName={confirmDelete.name}
                kind="template"
                onCancel={() => setConfirmDelete(null)}
                onConfirm={() => {
                  void handleDelete(confirmDelete.id);
                  setConfirmDelete(null);
                  setShowDropdown(false);
                }}
              />
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <AutosaveChip state={saveState} />
          {/* Header CTA jumps to the Reels create page; without onCreate it stays a PNG download. */}
          {onCreate ? (
            <Button
              size="sm"
              variant="primary"
              onClick={onCreate}
              leadingIcon={<PlusIcon size={12} aria-hidden />}
              className="rounded-full"
            >
              Create
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={handleDownload}
              disabled={!active}
              leadingIcon={<DownloadIcon size={12} aria-hidden />}
              className="rounded-full"
            >
              PNG
            </Button>
          )}
        </div>
      </div>

      {/* Element rail (Miro-style) — same component as the carousel editor; the Carousel/Reels
          toggle stacks on top via topIsland. Flyout contents are placeholders until canvas
          interactivity lands. */}
      <ElementRail
        topIsland={topIsland}
        collapseMiddle={collapseMiddle}
        onUndo={() => undo(activeId)}
        onRedo={() => redo(activeId)}
        canUndo={canUndo(activeId)}
        canRedo={canRedo(activeId)}
        categories={[
          ...(brand.logos.length > 0
            ? [{ id: 'logos', label: 'Brand uploads', icon: RailIcons.logos, content: (
                <UploadsGallery
                  logos={brand.logos}
                  dragProps={url => ({
                    draggable: true,
                    onDragStart: e => { e.dataTransfer.setData(CELL_IMAGE_DND_MIME, url); e.dataTransfer.effectAllowed = 'copy'; },
                    onDragEnd: () => {},
                  })}
                />
              ) }]
            : []),
          { id: 'cells', label: REELS_CELLS_ENABLED ? 'Cell items' : 'Elements', icon: cellsIcon, content: <CellItemsFlyout /> },
          { id: 'settings', label: 'Settings', icon: settingsIcon, content: (
            <SettingsFlyout
              showGuides={showGuides} onToggleGuides={setShowGuides}
              showSafeZone={showSafeZone} onToggleSafeZone={setShowSafeZone}
              showOutlines={showOutlines} onToggleOutlines={setShowOutlines}
            />
          ) },
        ]}
      />

      {/* Scroll area — native scroll so the browser handles every trackpad gesture; the canvas has
          its own EditorScrollBar pan bar. Symmetric right-panel padding keeps the preview centred. */}
      <div
        ref={attachScrollArea}
        // Pointerdown in the void around the canvas deselects any selected element/cell. Pointerdown (not
        // click) because the canvas's CSS `zoom` makes WebKit drop synthesized `click`s; an element/handle
        // pointerdown stopPropagation, so only empty-space + void presses reach here.
        onPointerDown={() => { selectFree(null); selectCell(null); }}
        className="flex-1 overflow-auto overscroll-contain no-native-scrollbar flex flex-col [align-items:safe_center] [justify-content:safe_center]"
        style={{ paddingRight: RIGHT_PANEL_VAR, paddingLeft: `calc(${RIGHT_PANEL_VAR} + var(--ai-panel-w, 0px))`, opacity: revealed && !collapseMiddle ? 1 : 0, transition: collapseMiddle ? 'opacity var(--rail-dur, 360ms) var(--ease-standard)' : 'opacity 280ms var(--ease-standard)' }}
      >
        {active ? (
          // World wrapper — width = the visible lane scaled by how far you've zoomed in past the minimum
          // (lane.width × viewScale/ZOOM_MIN). At min zoom it exactly fills the view (whole world visible,
          // nothing to pan); any zoom above makes it overflow so you can pan within it.
          <div className="flex justify-center" style={{ minWidth: lane.width ? lane.width * viewScale / ZOOM_MIN : undefined }}>
            <div ref={contentRef} className="flex flex-col items-center py-6 px-4" style={{ zoom: fitFactor * viewScale }}>
              <Preview
                settings={active.settings}
                brand={brand}
                canvasRef={previewCanvasRef}
                pulseKey={aiPulseKey}
                onPulseEnd={() => setAiPulseKey(0)}
                showGuides={showGuides}
                showSafeZone={showSafeZone}
                showOutlines={showOutlines}
                selectedCell={selectedCell}
                onSelectCell={selectCell}
                freeElements={active.settings.freeElements ?? []}
                selectedFreeId={selectedFreeId}
                onSelectFree={selectFree}
                onFreeChange={updateFreeElements}
                onCellDrop={(cell, type) => {
                  const field = ({ top: 'cellTop', top2: 'cellTop2', bottom: 'cellBottom', bottom2: 'cellBottom2' } as const)[cell];
                  // Clearing (✕ → 'empty') wipes the cell; switching type keeps any text/image.
                  const next = type === 'empty' ? { type: 'empty' as const } : { ...active.settings[field], type };
                  updateSettings(active.id, { [field]: next });
                  if (type !== 'empty') selectCell(cell);   // dropping selects the cell → its island opens
                }}
                onCellImage={(cell, url) => {
                  const field = ({ top: 'cellTop', top2: 'cellTop2', bottom: 'cellBottom', bottom2: 'cellBottom2' } as const)[cell];
                  const existing = active.settings[field];
                  // Dropping on a banner sets its avatar image; on an empty/image cell it becomes an image cell.
                  if (existing?.type === 'banner' || existing?.type === 'bannerText') {
                    updateSettings(active.id, { [field]: { ...existing, banner: { ...existing.banner, avatarUrl: url } } });
                  } else {
                    updateSettings(active.id, { [field]: { type: 'image' as const, imageUrl: url } });
                  }
                  selectCell(cell);
                }}
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            {loading && templates.length === 0 ? (
              <BrandLoader size={40} label="Loading templates" />
            ) : (
              <EmptyState
                icon={<VideoIcon size={22} />}
                title="No Reels template yet"
                action={
                  <Button variant="primary" leadingIcon={<PlusIcon size={14} />} onClick={handleNew}>
                    Create your first template
                  </Button>
                }
              />
            )}
          </div>
        )}
      </div>

      {/* Miro-style horizontal overview bar — spans the sidebar's right edge to the screen edge. */}
      <div style={{ opacity: revealed && !collapseMiddle ? 1 : 0, transition: collapseMiddle ? 'opacity var(--rail-dur, 360ms) var(--ease-standard)' : 'opacity 280ms var(--ease-standard)' }}>
      <EditorScrollBar
        targetRef={scrollAreaRef}
        zoom={fitFactor * viewScale}
        extent={Math.max(0, 1 - (viewScale - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN))}
        style={{ left: RAIL_VAR, right: 0, transition: 'left var(--dur-spatial) var(--ease-emphasized)' }}
      />
      </div>

      {/* Bottom-left zoom readout + steppers — absolute % (100% = native pixels), consistent across editors */}
      <ZoomControl value={fitFactor * viewScale} min={fitFactor * ZOOM_MIN} max={fitFactor * ZOOM_MAX} resetTo={1} onChange={v => { captureFocal(); setViewScale(v / fitFactor); }} />

      {/* Settings panel */}
      <div className="fixed right-0 z-20 bg-transparent flex flex-col" style={{ top: HEADER_H, width: RIGHT_PANEL_VAR, height: `calc(100vh - ${HEADER_H}px)`, opacity: revealed && !collapseMiddle ? 1 : 0, transition: collapseMiddle ? 'opacity var(--rail-dur, 360ms) var(--ease-standard)' : 'opacity 280ms var(--ease-standard)' }}>
        {active && (
          <TwitterSettingsPanel
            settings={active.settings}
            onChange={partial => updateSettings(active.id, partial)}
            logoSrc={brand.logoSrc || '/templatelogo.png'}
            selectedCell={selectedCell}
            onSelectCell={selectCell}
            selectedFreeId={selectedFreeId}
            onSelectFree={selectFree}
          />
        )}
      </div>
    </div>
  );
}
