'use client';

import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ReactNode } from 'react';
import { authedFetch } from '@/lib/authedFetch';
import TemplateEditorCanvas, { CAROUSEL_PREVIEW_W, CAROUSEL_PREVIEW_H, LOGO_PH, clipboardEventHasMediaFile } from './TemplateEditorCanvas';
import { CAROUSEL_W, CAROUSEL_H } from './TemplateEditorCanvas/constants';
import { TemplateEditorSettingsPanel } from './TemplateEditorSettingsPanel';
import { defaultCarouselSettings, TAG_PRESETS, defaultTagStyle, SWIPE_PRESETS, orderedLayerIds } from './templateEditorTypes';
import { TemplateEditorSwipePreviewMini } from './TemplateEditorSwipePreviewMini';
import type { TemplateEditorCanvasRef, CarouselSettings, CarouselBgLayerState, SidebarElementData, SwipeStyle, ImageBox, ImageBoxCrop, PerspectiveMode } from './templateEditorTypes';

import { ALL_QUOTE_STYLES } from './templateEditorQuoteStyles';
import type { RecordingState } from './TikTokCanvas/types';
import type { BrandProps } from '../types';
import { UploadsGallery } from './UploadsGallery';
import { OVERLAY_IDS, overlayUrl, overlayThumbUrl } from './overlayLibrary';
import { BTN_TEXT, NAME_MAX_LENGTH } from '@/lib/ui-constants';
import { bestVideoUrl } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { requestUpgrade, upgradeReasonForDbError } from '@/lib/upgradePrompt';
import { useTemplateEditor, TEMPLATE_TABLES, POST_TABLES, type TemplateRow, type SlideRow } from '../hooks/useTemplateEditor';
import { useEditorCopilot } from '../hooks/useEditorCopilot';
import { TemplatesEmptyState } from './TemplatesEmptyState';
import { CarouselHomeGrid } from './CarouselHomeGrid';
import { SlidesStrip , ConfirmDeleteDialog } from './SlidesStrip';
import { Button, IconButton, Modal, Switch, RIGHT_PANEL_VAR } from './ui';
import { AutosaveChip } from './AutosaveChip';
import { useExportGuard, ExportQuotaChip } from './ExportGuard';
import { ElementBuilderPanel, type ElementInsert } from './customElements/ElementBuilderPanel';
import { CustomElementsFlyout } from './customElements/CustomElementsFlyout';
import type { ElementRenderTheme } from '@/lib/customElements/runtime';

// Brand-ish theme handed to custom elements so they match the dark canvas. (Shared by the rail flyout,
// the Build-with-AI panel, and the on-canvas render.)
const ELEMENT_THEME: ElementRenderTheme = {
  fg: '#ffffff', bg: '#000000', accent: '#3b82f6', muted: 'rgba(255,255,255,0.45)',
  positive: '#22c55e', negative: '#ef4444', fontFamily: 'Inter, system-ui, sans-serif',
};
import { EditorScrollBar } from './EditorScrollBar';
import { ZoomControl } from './ZoomControl';
import { ElementRail, RailIcons, ELEMENT_RAIL_FOOTPRINT, type RailCategory } from './ElementRail';

const PINNED_DEFAULT_ZOOM = 0.75;   // the automations mapping panel keeps a smaller fit-relative default
// Height (px) of a spacer element at the end of the scroll content that reserves room so the canvas
// centres above the docked slides strip rather than behind it. Must be a spacer ELEMENT, not
// container padding: padding on this flex + overflow scroll area breaks safe-centre top-scrolling
// under CSS `zoom` (the canvas can't be panned up to its top). ≈ strip height + offset + a gap.
const SLIDES_DOCK_CLEARANCE = 120;
import { useObservedSize, fitScaleFor } from '@/app/hooks/useElementSize';
import { useEditorZoomPan, EDITOR_ZOOM_MIN as ZOOM_MIN, EDITOR_ZOOM_MAX as ZOOM_MAX } from '@/app/hooks/useEditorZoomPan';
import { RAIL_VAR, HEADER_H } from './ui/dimensions';
import {
  UploadIcon, DownloadIcon, PlusIcon, CloseIcon, ChevronDownIcon, SpinnerIcon,
} from '@/lib/icons';

// ── Editor view overlays (rail "Settings" gear) ───────────────────────────────
// Mirrors the reels editor's Settings flyout, minus the Instagram safe-zone toggle (a carousel isn't an
// IG-reel frame). A rule-of-thirds grid = alignment guidelines; a dashed square = element outlines.
const guidesIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </svg>
);
const outlineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" strokeDasharray="3.5 3" />
  </svg>
);
const settingsGearIcon = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

// Custom elements rail icon — a sparkle inside a chart/box, hinting "AI-built component".
const customElementsIcon = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M8 15l3-3 2 2 3-4" />
    <path d="M16.5 5.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6L14.3 7.7l1.6-.6z" fill="currentColor" stroke="none" />
  </svg>
);

function CarouselSettingsFlyout({ showGuides, onToggleGuides, showOutlines, onToggleOutlines }: {
  showGuides: boolean; onToggleGuides: (v: boolean) => void;
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
        <span className="shrink-0 text-fg-2">{outlineIcon}</span>
        <span className="flex-1 text-caption text-fg">Element outlines</span>
        <Switch label="Element outlines" checked={showOutlines} onChange={onToggleOutlines} />
      </div>
    </div>
  );
}

// SVG overlay over the carousel canvas (1080×1350): purple alignment guidelines (rule-of-thirds + centre
// axes) and dashed outlines around the draggable image/text boxes. pointer-events-none; never exported.
function CarouselGuidesOverlay({ showGuides, showOutlines, settings }: {
  showGuides: boolean; showOutlines: boolean; settings: CarouselSettings;
}) {
  if (!showGuides && !showOutlines) return null;
  const W = CAROUSEL_W, H = CAROUSEL_H;
  const boxes = [...(settings.imageBoxes ?? []), ...(settings.textBoxes ?? [])];
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      {showGuides && (
        <g stroke="#a855f7" fill="none">
          <g opacity={0.5}>
            <line x1={W / 3} y1={0} x2={W / 3} y2={H} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <line x1={(2 * W) / 3} y1={0} x2={(2 * W) / 3} y2={H} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <line x1={0} y1={H / 3} x2={W} y2={H / 3} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <line x1={0} y1={(2 * H) / 3} x2={W} y2={(2 * H) / 3} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          </g>
          <g opacity={0.95}>
            <line x1={W / 2} y1={0} x2={W / 2} y2={H} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            <line x1={0} y1={H / 2} x2={W} y2={H / 2} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </g>
        </g>
      )}
      {showOutlines && boxes.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.width} height={b.height} fill="none"
              stroke="rgba(56,189,248,0.95)" strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

// ── Divider library ───────────────────────────────────────────────────────────

const DIVIDER_LIBRARY = [
  { id: 'solid',             label: 'Solid' },
  { id: 'thick',             label: 'Thick' },
  { id: 'dashed',            label: 'Dashed' },
  { id: 'dotted',            label: 'Dotted' },
  { id: 'double',            label: 'Double' },
  { id: 'triple',            label: 'Triple' },
  { id: 'dot-center',        label: 'Dot center' },
  { id: 'dots-row',          label: 'Dots row' },
  { id: 'diamond-center',    label: 'Diamond' },
  { id: 'logo-center',       label: 'Logo center' },
  { id: 'logo-left',         label: 'Logo left' },
  { id: 'logo-right',        label: 'Logo right' },
  { id: 'fade',              label: 'Fade out' },
  { id: 'fade-left',         label: 'Fade left' },
  { id: 'taper',             label: 'Taper' },
  { id: 'taper-dashed',      label: 'Taper dash' },
  { id: 'double-fade',       label: 'Double fade' },
  { id: 'logo-center-fade',  label: 'Logo + fade' },
  { id: 'logo-left-fade',    label: 'Logo left fade' },
  { id: 'dashed-fade',       label: 'Dashed fade' },
  { id: 'thick-taper',       label: 'Thick taper' },
  { id: 'short-center',      label: 'Short center' },
  { id: 'wave',              label: 'Wave' },
  { id: 'brackets',          label: 'Brackets' },
  { id: 'tag-center',        label: 'Tag center' },
  { id: 'tag-left',          label: 'Tag left' },
  { id: 'tag-right',         label: 'Tag right' },
  { id: 'tag-center-fade',   label: 'Tag + fade' },
  { id: 'tag-left-fade',     label: 'Tag left fade' },
  { id: 'tag-logo',          label: 'Tag + logo' },
  { id: 'tag-double',        label: 'Tag double' },
  { id: 'tag-short',         label: 'Tag short' },
  // Wave + content
  { id: 'wave-logo-center', label: 'Wave logo ●' },
  { id: 'wave-logo-left',   label: 'Wave logo left' },
  { id: 'wave-logo-right',  label: 'Wave logo right' },
  { id: 'wave-tag-center',  label: 'Wave tag ●' },
  { id: 'wave-tag-left',    label: 'Wave tag left' },
  { id: 'wave-tag-right',   label: 'Wave tag right' },
  // Taper + content
  { id: 'taper-logo-center',     label: 'Taper logo ●' },
  { id: 'taper-logo-center-out', label: 'Taper logo ◁▷' },
  { id: 'taper-logo-left',       label: 'Taper logo left' },
  { id: 'taper-logo-right',      label: 'Taper logo right' },
  { id: 'taper-tag-center',      label: 'Taper tag ●' },
  { id: 'taper-tag-center-out',  label: 'Taper tag ◁▷' },
  { id: 'taper-tag-left',        label: 'Taper tag left' },
  { id: 'taper-tag-right',       label: 'Taper tag right' },
  // Dashed + content
  { id: 'dashed-logo-center', label: 'Dashed logo ●' },
  { id: 'dashed-logo-left',   label: 'Dashed logo left' },
  { id: 'dashed-logo-right',  label: 'Dashed logo right' },
  { id: 'dashed-tag-center',  label: 'Dashed tag ●' },
  { id: 'dashed-tag-left',    label: 'Dashed tag left' },
  { id: 'dashed-tag-right',   label: 'Dashed tag right' },
];

const LINE   = '#52525b';
const LINE_D = '#3f3f46';

// Logo placeholder used inside slot-scale divider previews
const LogoPlaceholder = ({ size = 14 }: { size?: number }) => (
  <div
    className="shrink-0 rounded-[2px] bg-zinc-700 flex items-center justify-center"
    style={{ width: size, height: size }}
  >
    <div className="rounded-[1px] bg-zinc-500" style={{ width: size * 0.55, height: size * 0.4 }} />
  </div>
);

// Tag placeholder — looks like a badge label
const TagPlaceholder = () => (
  <div
    className="shrink-0 rounded-[2px] border border-zinc-600 bg-zinc-800 flex items-center justify-center"
    style={{ padding: '2px 5px', gap: 3 }}
  >
    <div className="rounded-full bg-zinc-600" style={{ width: 12, height: 3 }} />
    <div className="rounded-full bg-zinc-500" style={{ width: 8, height: 3 }} />
  </div>
);

function DividerSlotElement({ id }: { id: string }) {
  const h = LOGO_PH; // slot height in px — exact match to canvas slot
  const line1 = <div className="flex-1 h-px" style={{ background: LINE }} />;
  const line1d = <div className="flex-1 h-px" style={{ background: LINE_D }} />;
  // Wave path — shared by all 6 wave-* variants
  const wavePath = `M0,${h/2} C8,${h*0.14} 17,${h*0.86} 25,${h/2} C33,${h*0.14} 42,${h*0.86} 50,${h/2} C58,${h*0.14} 67,${h*0.86} 75,${h/2} C83,${h*0.14} 92,${h*0.86} 100,${h/2}`;
  // Element constant (like line1/line1d) — a component defined here would get a
  // new identity every render and remount its subtree.
  const waveSvg = (
    <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 100 ${h}`}>
      <path d={wavePath} fill="none" stroke={LINE} strokeWidth="1.5" />
    </svg>
  );

  switch (id) {
    case 'solid':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>{line1}</div>;

    case 'thick':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <div className="flex-1 rounded-full" style={{ height: 2, background: LINE }} />
      </div>;

    case 'dashed':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <div className="flex-1" style={{ borderTop: `1px dashed ${LINE}` }} />
      </div>;

    case 'dotted':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <div className="flex-1" style={{ borderTop: `1px dotted ${LINE}` }} />
      </div>;

    case 'double':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <div className="flex-1 flex flex-col gap-[3px]">
          <div className="h-px" style={{ background: LINE_D }} />
          <div className="h-px" style={{ background: LINE_D }} />
        </div>
      </div>;

    case 'triple':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <div className="flex-1 flex flex-col gap-[2px]">
          <div className="h-px" style={{ background: LINE_D }} />
          <div style={{ height: 2, background: LINE }} />
          <div className="h-px" style={{ background: LINE_D }} />
        </div>
      </div>;

    case 'dot-center':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        {line1d}
        <div className="rounded-full shrink-0" style={{ width: 5, height: 5, background: LINE }} />
        {line1d}
      </div>;

    case 'dots-row':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', gap: 5 }}>
        {[0,1,2,3,4,5].map(i => (
          <div key={i} className="rounded-full shrink-0" style={{ width: 4, height: 4, background: LINE, opacity: i === 0 || i === 5 ? 0.3 : i === 1 || i === 4 ? 0.6 : 1 }} />
        ))}
      </div>;

    case 'diamond-center':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        {line1d}
        <svg width="8" height="8" viewBox="0 0 8 8" className="shrink-0"><polygon points="4,0 8,4 4,8 0,4" fill={LINE} /></svg>
        {line1d}
      </div>;

    case 'logo-center':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        {line1d}
        <LogoPlaceholder />
        {line1d}
      </div>;

    case 'logo-left':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <LogoPlaceholder />
        {line1d}
      </div>;

    case 'logo-right':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        {line1d}
        <LogoPlaceholder />
      </div>;

    case 'fade':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, transparent, ${LINE} 30%, ${LINE} 70%, transparent)` }} />
      </div>;

    case 'fade-left':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, ${LINE}, transparent)` }} />
      </div>;

    case 'taper':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 100 ${h}`}>
          <polygon points={`0,${h/2} 50,${h*0.15} 100,${h/2} 50,${h*0.85}`} fill={LINE} />
        </svg>
      </div>;

    case 'taper-dashed':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <svg className="flex-1" height={4} preserveAspectRatio="none" viewBox="0 0 100 4">
          <line x1="0" y1="2" x2="100" y2="2" stroke={LINE} strokeWidth="1.5" strokeDasharray="4 3"
            style={{ maskImage: 'linear-gradient(to right, transparent, black 20%, black 80%, transparent)', WebkitMaskImage: 'linear-gradient(to right, transparent, black 20%, black 80%, transparent)' }} />
        </svg>
      </div>;

    case 'double-fade':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <div className="flex-1 flex flex-col gap-[3px]">
          <div className="h-px" style={{ background: `linear-gradient(to right, transparent, ${LINE_D} 25%, ${LINE_D} 75%, transparent)` }} />
          <div className="h-px" style={{ background: `linear-gradient(to right, transparent, ${LINE_D} 25%, ${LINE_D} 75%, transparent)` }} />
        </div>
      </div>;

    case 'logo-center-fade':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, transparent, ${LINE_D})` }} />
        <LogoPlaceholder />
        <div className="flex-1 h-px" style={{ background: `linear-gradient(to left, transparent, ${LINE_D})` }} />
      </div>;

    case 'logo-left-fade':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <LogoPlaceholder />
        <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, ${LINE}, transparent)` }} />
      </div>;

    case 'dashed-fade':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <div className="flex-1 h-px" style={{
          background: `repeating-linear-gradient(to right, ${LINE} 0, ${LINE} 4px, transparent 4px, transparent 7px)`,
          maskImage: 'linear-gradient(to right, transparent, black 25%, black 75%, transparent)',
          WebkitMaskImage: 'linear-gradient(to right, transparent, black 25%, black 75%, transparent)',
        }} />
      </div>;

    case 'thick-taper':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 100 ${h}`}>
          <polygon points={`0,${h/2} 50,${h*0.08} 100,${h/2} 50,${h*0.92}`} fill={LINE} />
        </svg>
      </div>;

    case 'short-center':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
        <div className="h-px" style={{ width: '33%', background: LINE }} />
      </div>;

    case 'wave':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>
        <svg className="flex-1" height={10} preserveAspectRatio="none" viewBox="0 0 100 10">
          <path d="M0,5 C8,1 17,9 25,5 C33,1 42,9 50,5 C58,1 67,9 75,5 C83,1 92,9 100,5"
            fill="none" stroke={LINE} strokeWidth="1" />
        </svg>
      </div>;

    case 'brackets':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 3 }}>
        <svg width="7" height={h} viewBox={`0 0 7 ${h}`}>
          <path d={`M5,2 H2 Q1,2 1,4 V${h-4} Q1,${h-2} 2,${h-2} H5`} fill="none" stroke={LINE} strokeWidth="1" />
        </svg>
        {line1d}
        <svg width="7" height={h} viewBox={`0 0 7 ${h}`} style={{ transform: 'scaleX(-1)' }}>
          <path d={`M5,2 H2 Q1,2 1,4 V${h-4} Q1,${h-2} 2,${h-2} H5`} fill="none" stroke={LINE} strokeWidth="1" />
        </svg>
      </div>;

    case 'tag-center':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        {line1d}
        <TagPlaceholder />
        {line1d}
      </div>;

    case 'tag-left':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <TagPlaceholder />
        {line1d}
      </div>;

    case 'tag-right':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        {line1d}
        <TagPlaceholder />
      </div>;

    case 'tag-center-fade':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, transparent, ${LINE_D})` }} />
        <TagPlaceholder />
        <div className="flex-1 h-px" style={{ background: `linear-gradient(to left, transparent, ${LINE_D})` }} />
      </div>;

    case 'tag-left-fade':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <TagPlaceholder />
        <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, ${LINE}, transparent)` }} />
      </div>;

    case 'tag-logo':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        {line1d}
        <LogoPlaceholder />
        <TagPlaceholder />
        {line1d}
      </div>;

    case 'tag-double':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <div className="flex-1 flex flex-col gap-[2px]">
          <div className="h-px" style={{ background: LINE_D }} />
          <div className="h-px" style={{ background: LINE_D }} />
        </div>
        <TagPlaceholder />
        <div className="flex-1 flex flex-col gap-[2px]">
          <div className="h-px" style={{ background: LINE_D }} />
          <div className="h-px" style={{ background: LINE_D }} />
        </div>
      </div>;

    case 'tag-short':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', gap: 5 }}>
        <div className="h-px" style={{ width: 20, background: LINE }} />
        <TagPlaceholder />
        <div className="h-px" style={{ width: 20, background: LINE }} />
      </div>;

    // Wave + content variants — all share the same wavePath / WaveSvg
    case 'wave-logo-center':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        {waveSvg}<LogoPlaceholder />{waveSvg}
      </div>;

    case 'wave-logo-left':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <LogoPlaceholder />{waveSvg}
      </div>;

    case 'wave-logo-right':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        {waveSvg}<LogoPlaceholder />
      </div>;

    case 'wave-tag-center':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        {waveSvg}<TagPlaceholder />{waveSvg}
      </div>;

    case 'wave-tag-left':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <TagPlaceholder />{waveSvg}
      </div>;

    case 'wave-tag-right':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        {waveSvg}<TagPlaceholder />
      </div>;

    // Taper + content variants
    case 'taper-logo-center':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 50 ${h}`}>
          <polygon points={`0,2 50,${h/2} 0,${h-2}`} fill={LINE_D} />
        </svg>
        <LogoPlaceholder />
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 50 ${h}`} style={{ transform: 'scaleX(-1)' }}>
          <polygon points={`0,2 50,${h/2} 0,${h-2}`} fill={LINE_D} />
        </svg>
      </div>;

    case 'taper-logo-left':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <LogoPlaceholder />
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 100 ${h}`}>
          <polygon points={`0,${h*0.15} 100,${h/2} 0,${h*0.85}`} fill={LINE_D} />
        </svg>
      </div>;

    case 'taper-logo-right':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 100 ${h}`}>
          <polygon points={`100,${h*0.15} 0,${h/2} 100,${h*0.85}`} fill={LINE_D} />
        </svg>
        <LogoPlaceholder />
      </div>;

    case 'taper-tag-center':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 50 ${h}`}>
          <polygon points={`0,2 50,${h/2} 0,${h-2}`} fill={LINE_D} />
        </svg>
        <TagPlaceholder />
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 50 ${h}`} style={{ transform: 'scaleX(-1)' }}>
          <polygon points={`0,2 50,${h/2} 0,${h-2}`} fill={LINE_D} />
        </svg>
      </div>;

    case 'taper-tag-left':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <TagPlaceholder />
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 100 ${h}`}>
          <polygon points={`0,${h*0.15} 100,${h/2} 0,${h*0.85}`} fill={LINE_D} />
        </svg>
      </div>;

    case 'taper-tag-right':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 100 ${h}`}>
          <polygon points={`100,${h*0.15} 0,${h/2} 100,${h*0.85}`} fill={LINE_D} />
        </svg>
        <TagPlaceholder />
      </div>;

    // Inverse taper center — thick at element, tapers outward to points at edges
    case 'taper-tag-center-out':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 50 ${h}`}>
          <polygon points={`50,2 0,${h/2} 50,${h-2}`} fill={LINE_D} />
        </svg>
        <TagPlaceholder />
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 50 ${h}`}>
          <polygon points={`0,2 50,${h/2} 0,${h-2}`} fill={LINE_D} />
        </svg>
      </div>;

    case 'taper-logo-center-out':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 50 ${h}`}>
          <polygon points={`50,2 0,${h/2} 50,${h-2}`} fill={LINE_D} />
        </svg>
        <LogoPlaceholder />
        <svg className="flex-1" height={h} preserveAspectRatio="none" viewBox={`0 0 50 ${h}`}>
          <polygon points={`0,2 50,${h/2} 0,${h-2}`} fill={LINE_D} />
        </svg>
      </div>;

    // Dashed + content variants
    case 'dashed-logo-center':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <div className="flex-1" style={{ borderTop: `1px dashed ${LINE}` }} />
        <LogoPlaceholder />
        <div className="flex-1" style={{ borderTop: `1px dashed ${LINE}` }} />
      </div>;

    case 'dashed-logo-left':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <LogoPlaceholder />
        <div className="flex-1" style={{ borderTop: `1px dashed ${LINE}` }} />
      </div>;

    case 'dashed-logo-right':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <div className="flex-1" style={{ borderTop: `1px dashed ${LINE}` }} />
        <LogoPlaceholder />
      </div>;

    case 'dashed-tag-center':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <div className="flex-1" style={{ borderTop: `1px dashed ${LINE}` }} />
        <TagPlaceholder />
        <div className="flex-1" style={{ borderTop: `1px dashed ${LINE}` }} />
      </div>;

    case 'dashed-tag-left':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <TagPlaceholder />
        <div className="flex-1" style={{ borderTop: `1px dashed ${LINE}` }} />
      </div>;

    case 'dashed-tag-right':
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%', gap: 5 }}>
        <div className="flex-1" style={{ borderTop: `1px dashed ${LINE}` }} />
        <TagPlaceholder />
      </div>;

    default:
      return <div style={{ height: h, display: 'flex', alignItems: 'center', width: '100%' }}>{line1}</div>;
  }
}

// Per-slide ephemeral state (not persisted — refreshes every session).
// imageSrc is intentionally ephemeral: the Template editor defines styles, not
// per-post content. Users bring their own image when applying the template.
interface LocalSlideState {
  imageSrc: string;
  bgState: CarouselBgLayerState;
  scale: number;
  recordingState: RecordingState | null;
}

function makeLocal(): LocalSlideState {
  return {
    imageSrc: '',
    bgState: { fgMaskReady: false, isBgProcessing: false, bgProcessError: false },
    scale: 1,
    recordingState: null,
  };
}

// Public URL marker for the post-images bucket. Lets the tray re-derive itself
// from a reopened post's image_boxes (URLs that point at this bucket).
const POST_IMAGE_MARKER = '/post-images/';
// Same idea for uploaded videos (post-videos bucket). A video box's url/videoUrl points here.
const POST_VIDEO_MARKER = '/post-videos/';
const isVideoUrl = (url: string) => url.includes(POST_VIDEO_MARKER) || /\.mp4($|\?)/i.test(url);

function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('image load failed'));
    img.src = url;
  });
}

// Render only the visible (cropped) region of an image to a PNG blob, at native crop resolution.
// Used before BRIA expand so the model receives exactly what the box shows, not the full source.
async function renderCroppedBlob(url: string, crop: ImageBoxCrop): Promise<Blob | null> {
  const img = await loadImageEl(url);
  const sW = img.naturalWidth, sH = img.naturalHeight;
  const cL = crop.left ?? 0, cR = crop.right ?? 0, cT = crop.top ?? 0, cB = crop.bottom ?? 0;
  const sx = cL * sW, sy = cT * sH;
  const sw = Math.max(1, (1 - cL - cR) * sW), sh = Math.max(1, (1 - cT - cB) * sH);
  const cv = document.createElement('canvas');
  cv.width  = Math.max(1, Math.round(sw));
  cv.height = Math.max(1, Math.round(sh));
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  return new Promise(res => cv.toBlob(b => res(b), 'image/png'));
}

function makeDragHandlers(data: SidebarElementData, setDragging: (v: SidebarElementData['type'] | null) => void) {
  return {
    draggable: true as const,
    onDragStart: (e: React.DragEvent) => {
      setDragging(data.type);
      e.dataTransfer.setData('application/carousel-element', JSON.stringify(data));
      e.dataTransfer.setData('application/carousel-element-type/' + data.type, '');
      e.dataTransfer.effectAllowed = 'copy';
      // Use the thumbnail itself as the drag ghost. The default snapshot of the
      // dragged element gets blanked when an ancestor has backdrop-filter/
      // transform (true for the sidebar), so set it explicitly from the <img>.
      const thumb = (e.currentTarget as HTMLElement).querySelector('img');
      if (thumb && thumb.complete && thumb.naturalWidth > 0) {
        e.dataTransfer.setDragImage(thumb, thumb.clientWidth / 2, thumb.clientHeight / 2);
      }
    },
    onDragEnd: () => setDragging(null),
  };
}


export function TemplateEditorGrid({ brand, userId, mode = 'templates', topIsland, collapseMiddle, onGoToTemplateEditor, onCreate, pinnedTemplateId, onSlidesChange, displayValues, displayElementData }: {
  brand: BrandProps; userId: string | null; mode?: 'templates' | 'posts'; topIsland?: ReactNode; collapseMiddle?: boolean; onGoToTemplateEditor?: () => void; onCreate?: () => void;
  // Embedded mode (automations Edit-template overlay): lock the editor onto ONE template — the switcher
  // dropdown becomes a static name — and report the active template's slides so the host can derive
  // {placeholders}/chart inputs and render a data-filled preview.
  pinnedTemplateId?: string; onSlidesChange?: (slides: SlideRow[]) => void;
  // Display-time data fill forwarded to the canvas: mapped {tokens} draw as values, charts render with
  // the mapped data — while the stored template keeps the raw tokens.
  displayValues?: Record<string, string>; displayElementData?: Record<string, Record<string, unknown>>;
}) {
  const isPosts = mode === 'posts';
  // Free-tier export quota — spent when the header download actually runs (FREE_TIER_PLAN.md).
  const exportGuard = useExportGuard();
  // Media (upload/paste/tray/image placement) is a posts-mode capability, but the automations
  // Edit-template overlay (pinnedTemplateId) gets it too: there the user populates {placeholders}
  // with real data and may want to drop in photos/videos before the Template node turns the
  // template into a real carousel post. Placed media saves into the template's slides as usual.
  const allowMedia = isPosts || !!pinnedTemplateId;
  const editor = useTemplateEditor(userId, isPosts ? POST_TABLES : TEMPLATE_TABLES);
  // Fade the canvas in once this editor reveals (e.g. after the Carousel⇄Reels swap). State-driven
  // (not a CSS mount-animation) so it plays AFTER the CollapseGate commits, not while still hidden;
  // the rAF lets the opacity:0 frame paint before flipping, so the transition actually runs.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setRevealed(true)); return () => cancelAnimationFrame(id); }, []);
  // Embedded mode — lock onto the pinned template once the list loads (selectTemplate no-ops if active),
  // and stream the active slides up to the host for placeholder mapping / data preview.
  useEffect(() => {
    if (pinnedTemplateId && editor.templates.some(t => t.id === pinnedTemplateId)) void editor.selectTemplate(pinnedTemplateId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedTemplateId, editor.templates]);
  useEffect(() => { onSlidesChange?.(editor.slides); }, [editor.slides, onSlidesChange]);
  // Posts mode opens on a Canva-style grid of the user's posts ('grid'); clicking one (or making a new
  // one) reveals the editor. A Back button returns to the grid. Templates mode never uses this.
  const [postsView, setPostsView] = useState<'grid' | 'editor'>('grid');
  // Posts mode: a "new post" picks a template to clone. Fetch the user's templates for that picker.
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [pickerTemplates, setPickerTemplates] = useState<TemplateRow[]>([]);
  const [pickerLoaded, setPickerLoaded] = useState(false);
  const [showAddSlideModal, setShowAddSlideModal] = useState(false);   // "add slide" chooser: blank vs duplicate a page
  useEffect(() => {
    if (!isPosts || !userId) return;
    let cancelled = false;
    void supabase.from(TEMPLATE_TABLES.parent).select('id, name, position').eq('user_id', userId).order('position')
      .then(({ data }) => { if (!cancelled) { setPickerTemplates((data ?? []) as TemplateRow[]); setPickerLoaded(true); } });
    return () => { cancelled = true; };
  }, [isPosts, userId]);
  const [draggingKind, setDraggingKind] = useState<SidebarElementData['type'] | null>(null);
  const isDraggingElement = draggingKind != null;
  const [selectedImageBox, setSelectedImageBox] = useState<number | null>(null);
  const [selectedFreeEl, setSelectedFreeEl] = useState<number | null>(null);
  const [selectedTextBox, setSelectedTextBox] = useState<number | null>(null);
  const [selectedZoneSlot, setSelectedZoneSlot] = useState<{ kind: 'logo' | 'tag' | 'quote' | 'swipe'; index: number } | null>(null);
  const [richEditTarget, setRichEditTarget] = useState<'headline' | 'sub' | null>(null);
  const [textEdit, setTextEdit] = useState<{ boxIndex: number | null; hasSelection: boolean }>({ boxIndex: null, hasSelection: false });
  // Measured auto-heights for text boxes (canvas units), keyed by box id — merged across canvases (ids
  // are globally unique) so the settings panel can show the real height in the read-only Height field.
  const [textBoxAutoHeights, setTextBoxAutoHeights] = useState<Record<string, number>>({});
  const [lockImageAspect, setLockImageAspect] = useState(true);
  // Per-image-box subject-split bg-removal status (keyed by box id), reported up from the canvas.
  const [imageBoxBgState, setImageBoxBgState] = useState<Record<string, 'processing' | 'error'>>({});
  // Per-image-box BRIA expansion status (keyed by box id).
  const [imageBoxExpandState, setImageBoxExpandState] = useState<Record<string, 'processing' | 'error'>>({});
  // The box currently in expand-preview (its fill area is shaded on the canvas); null = not previewing.
  const [expandPreviewBoxId, setExpandPreviewBoxId] = useState<string | null>(null);
  // Perspective/distort: the box whose 4 corner handles are shown on the canvas, and the active mode.
  const [perspectiveBoxId, setPerspectiveBoxId] = useState<string | null>(null);
  const [perspectiveMode, setPerspectiveMode] = useState<PerspectiveMode>('distort');
  const cleanView = false;   // clean-view toggle removed — the editor always shows its outlines
  // Editor view overlays (rail Settings gear): alignment guidelines + element outlines. Persisted, and
  // namespaced de:carousel: so it can't collide with the reels editor's de:reels: keys. Default off.
  const [showGuides, setShowGuides] = useState<boolean>(() => { if (typeof window === 'undefined') return false; try { return localStorage.getItem('de:carousel:guides') === '1'; } catch { return false; } });
  const [showOutlines, setShowOutlines] = useState<boolean>(() => { if (typeof window === 'undefined') return false; try { return localStorage.getItem('de:carousel:outlines') === '1'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('de:carousel:guides', showGuides ? '1' : '0'); } catch { /* ignore */ } }, [showGuides]);
  useEffect(() => { try { localStorage.setItem('de:carousel:outlines', showOutlines ? '1' : '0'); } catch { /* ignore */ } }, [showOutlines]);
  const [showTemplateDropdown, setShowTemplateDropdown] = useState(false);
  const [renamingTemplateId, setRenamingTemplateId] = useState<string | null>(null);
  const [confirmDeleteTemplate, setConfirmDeleteTemplate] = useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dropdownAnchor, setDropdownAnchor] = useState<{ top: number; left: number } | null>(null);
  const templateDropdownRef = useRef<HTMLDivElement | null>(null);
  const templatePanelRef = useRef<HTMLDivElement | null>(null);
  const templateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const editorHeaderRef = useRef<HTMLDivElement | null>(null);
  const [aiOpen, setAiOpen] = useState(false);   // Build-with-AI element panel

  // A small JPEG screenshot of the active slide, for the AI element builder's vision grounding (§4.2) —
  // so the model sizes/places/themes a generated element to the real template. Downscaled to keep the
  // request light; best-effort (returns null if the canvas isn't ready).
  async function captureCanvas(): Promise<string | null> {
    try {
      const blob = await canvasRef.current?.exportBlob();
      if (!blob) return null;
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, 640 / bmp.width);
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close?.();
      return c.toDataURL('image/jpeg', 0.7);
    } catch { return null; }
  }

  // Drop an AI-generated custom element onto the active slide, centred, sized from its design box.
  function insertCustomElement(el: ElementInsert) {
    const slide = editor.activeSlide;
    if (!slide) return;
    const w = Math.min(el.size.w, CAROUSEL_W), h = Math.min(el.size.h, CAROUSEL_H);
    const x = Math.round((CAROUSEL_W - w) / 2), y = Math.round((CAROUSEL_H - h) / 2);
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `ce_${Date.now()}`;
    const free = [...(slide.settings.freeElements ?? []), {
      kind: 'custom' as const, id, x, y, width: w, height: h,
      elementId: el.elementId, name: el.name, code: el.code, inputSchema: el.inputSchema, data: el.data,
    }];
    editor.updateSlide(slide.id, { settings: { freeElements: free } });
  }
  const [localStates, setLocalStates] = useState<Record<string, LocalSlideState>>({});

  // ── Post images: temporary per-post uploads (posts mode only) ──────────────
  // Images uploaded/pasted while building a post. They are NOT brand assets —
  // they live in the 'post-images' bucket and never write a brand_kit_logos row,
  // so they never appear in Branding. Storage is durable (a saved post renders
  // after reload + exports CORS-safe, exactly like brand logos); "temporary"
  // means separated, not ephemeral. The tray below just lists them to drag onto
  // the canvas — the placed ImageBox.url persists in image_boxes JSONB.
  const activePostId = allowMedia ? editor.activeTemplateId : null;
  const [postImagesMap, setPostImagesMap] = useState<Record<string, string[]>>({});   // session uploads, per post
  const [trayRemoved, setTrayRemoved] = useState<Record<string, string[]>>({});        // tray-dismissed urls, per post
  const [postImgUploading, setPostImgUploading] = useState(false);
  const [postImgMsg, setPostImgMsg] = useState<string | null>(null);
  const [videoLinkInput, setVideoLinkInput] = useState('');
  const postImgMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const postImageInputRef = useRef<HTMLInputElement | null>(null);

  // Tray = post images already placed on the canvas (re-derived from the loaded
  // slides' image_boxes, so a reopened post shows them) ∪ this session's uploads,
  // minus any the user dismissed this session. Derived in render — no sync effect.
  // Dismissing an UNPLACED upload removes it for good (it's not in image_boxes);
  // dismissing a PLACED image only hides it until reload, since it's still on the
  // canvas and re-derives from the post — by design (the tray mirrors the post).
  const trayUrls: string[] = (() => {
    if (!activePostId) return [];
    const removed = new Set(trayRemoved[activePostId] ?? []);
    const out: string[] = [];
    const push = (u: string) => { if (u && !removed.has(u) && !out.includes(u)) out.push(u); };
    // Only read slides once they belong to the active post (avoid a mid-switch flash).
    if (allowMedia && editor.slides.every(s => s.templateId === activePostId)) {
      for (const s of editor.slides)
        for (const b of (s.settings.imageBoxes ?? []))
          if (b.url && b.url.includes(POST_IMAGE_MARKER)) push(b.url);
    }
    for (const u of (postImagesMap[activePostId] ?? [])) push(u);
    return out;
  })();

  const flashPostImgMsg = useCallback((text: string) => {
    setPostImgMsg(text);
    if (postImgMsgTimer.current) clearTimeout(postImgMsgTimer.current);
    postImgMsgTimer.current = setTimeout(() => setPostImgMsg(null), 3000);
  }, []);

  function addToTray(pid: string, url: string) {
    setTrayRemoved(prev => (prev[pid]?.includes(url) ? { ...prev, [pid]: prev[pid].filter(u => u !== url) } : prev));
    setPostImagesMap(prev => {
      const cur = prev[pid] ?? [];
      return cur.includes(url) ? prev : { ...prev, [pid]: [...cur, url] };
    });
  }

  function removeFromTray(pid: string, url: string) {
    setTrayRemoved(prev => {
      const cur = prev[pid] ?? [];
      return cur.includes(url) ? prev : { ...prev, [pid]: [...cur, url] };
    });
  }

  // Upload to the post-images bucket; returns the public URL (or null on error).
  const uploadPostImage = useCallback(async (file: File): Promise<string | null> => {
    if (!userId) return null;
    setPostImgUploading(true);
    // Sanitise the filename: keep it a single flat path segment (no '/' subfolders),
    // strip anything outside [A-Za-z0-9._-] so the storage key and its public URL agree.
    const safeName = (file.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'image').slice(0, 100);
    const path = `${userId}/${Date.now()}_${safeName}`;
    const { error: upErr } = await supabase.storage.from('post-images').upload(path, file);
    if (upErr) {
      setPostImgUploading(false);
      // Free-plan storage quota (DB trigger, supabase/free_tier.sql) → upgrade prompt.
      const upgrade = upgradeReasonForDbError(upErr.message);
      if (upgrade) { requestUpgrade(upgrade); return null; }
      flashPostImgMsg(`Upload failed: ${upErr.message}`);
      return null;
    }
    const { data: { publicUrl } } = supabase.storage.from('post-images').getPublicUrl(path);
    setPostImgUploading(false);
    return publicUrl;
  }, [userId, flashPostImgMsg]);

  // Upload an mp4 to the post-videos bucket; returns the public URL (or null on error).
  const uploadPostVideo = useCallback(async (file: File): Promise<string | null> => {
    if (!userId) return null;
    setPostImgUploading(true);
    const safeName = (file.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'video').slice(0, 100);
    const path = `${userId}/${Date.now()}_${safeName}`;
    const { error: upErr } = await supabase.storage.from('post-videos').upload(path, file, { contentType: 'video/mp4' });
    if (upErr) {
      setPostImgUploading(false);
      const upgrade = upgradeReasonForDbError(upErr.message);
      if (upgrade) { requestUpgrade(upgrade); return null; }
      flashPostImgMsg(`Upload failed: ${upErr.message}`);
      return null;
    }
    const { data: { publicUrl } } = supabase.storage.from('post-videos').getPublicUrl(path);
    setPostImgUploading(false);
    return publicUrl;
  }, [userId, flashPostImgMsg]);

  // File-picker upload (tray "Upload" button) — images → post-images, mp4 → post-videos; both join the tray.
  async function handlePostImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !activePostId) return;
    if (file.type.startsWith('video/')) {
      if (file.type !== 'video/mp4') { flashPostImgMsg('Only MP4 videos are supported.'); return; }
      const url = await uploadPostVideo(file);
      if (url) addToTray(activePostId, url);
      return;
    }
    const url = await uploadPostImage(file);
    if (url) addToTray(activePostId, url);
  }

  // Add a video by link (TikTok / Instagram / X): resolve via /api/download, then re-upload the
  // proxied stream to post-videos so it joins the tray like any uploaded video.
  async function addVideoFromLink() {
    const link = videoLinkInput.trim();
    if (!link || !activePostId) return;
    setPostImgUploading(true);
    flashPostImgMsg('Fetching video…');
    try {
      const res = await authedFetch('/api/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: link }),
      });
      const json = await res.json() as { error?: string; play?: string; hdplay?: string; wmplay?: string };
      if (!res.ok) { setPostImgUploading(false); flashPostImgMsg(typeof json.error === 'string' ? json.error : 'Could not fetch that link'); return; }
      const proxied = bestVideoUrl(json);
      if (!proxied) { setPostImgUploading(false); flashPostImgMsg('No video found at that link'); return; }
      const vr = await fetch(proxied);
      if (!vr.ok) { setPostImgUploading(false); flashPostImgMsg('Could not download the video'); return; }
      const blob = await vr.blob();
      const file = new File([blob], `link-${Date.now()}.mp4`, { type: 'video/mp4' });
      const url = await uploadPostVideo(file);   // toggles postImgUploading off internally
      if (url) { addToTray(activePostId, url); setVideoLinkInput(''); flashPostImgMsg('Video added — drag it onto the canvas.'); }
    } catch {
      setPostImgUploading(false);
      flashPostImgMsg('Network error — please try again');
    }
  }

  // Clipboard-read upload (tray "Paste" button) — mirrors BrandKitPanel.handlePaste.
  async function handlePostImagePasteButton() {
    if (!activePostId) return;
    if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
      flashPostImgMsg('Your browser doesn’t support reading the clipboard');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const ext  = imageType.split('/')[1] || 'png';
        const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: imageType });
        const url = await uploadPostImage(file);
        if (url) addToTray(activePostId, url);
        return;
      }
      flashPostImgMsg('No image in clipboard');
    } catch {
      flashPostImgMsg('Clipboard permission denied');
    }
  }

  const canvasRef = useRef<TemplateEditorCanvasRef | null>(null);
  // Copilot bridge for the Build-with-AI panel: exposes the template's compact state and applies
  // validated agent actions through editor.updateSlide, so AI edits autosave and undo like any
  // edit. Before a batch applies, commit/exit any inline text editor — its blur commits by index,
  // and the batch may mutate the arrays underneath it.
  // Bumped each time the AI applies a change → a keyed pulse overlay remounts and rings the canvas
  // once, so you SEE the copilot touched your work (the canvas itself is never remounted). It resets
  // to 0 on animationend so the overlay unmounts — otherwise, living inside the slide-id-keyed column,
  // it would remount and re-ring on every plain slide switch.
  const [aiPulseKey, setAiPulseKey] = useState(0);
  const copilot = useEditorCopilot(editor, {
    onBeforeApply: () => canvasRef.current?.deselectAll(),
    brand: { displayName: brand.displayName, colors: brand.colors, logoUrl: brand.logoSrc },
    onApplied: () => setAiPulseKey(k => k + 1),
  });
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lane = useObservedSize(scrollAreaRef);
  // Freeze the fit factor at the first real measure. The lane narrows whenever a side panel slides in
  // (Build-with-AI, the automations chat dock), and refitting on that made the canvas visibly zoom
  // out — the canvas should keep its size; panels just overlap the pannable area. The zoom control
  // stays relative to this one stable baseline; a remount (template/section switch) refits.
  const fitBaselineRef = useRef(0);
  const liveFit = fitScaleFor(lane, CAROUSEL_PREVIEW_W, CAROUSEL_PREVIEW_H);
  if (!fitBaselineRef.current && lane.width > 0) fitBaselineRef.current = liveFit;
  const fitFactor = fitBaselineRef.current || liveFit;

  // Focal-anchored pinch/Ctrl-scroll zoom with a one-shot absolute-100% default (shared editor
  // scaffolding). The pinned automations overlay keeps its own smaller fit-relative default instead.
  const { viewScale, setViewScale, captureFocal, attachScroll: attachScrollArea } = useEditorZoomPan({
    scrollRef: scrollAreaRef, contentRef, fitFactor, laneWidth: lane.width,
    initialViewScale: pinnedTemplateId ? PINNED_DEFAULT_ZOOM : 1,
    skipAutoInit: !!pinnedTemplateId,
  });

  // Dot-board origin (pinned/automations mode): the dotted background must scale around the SAME
  // point the canvas zooms around, or the slide drifts across the dots on every zoom. Measure the
  // content's origin inside the scrollable area (scroll-compensated, so panning needs no re-measure —
  // attachment:local moves the tiles with the content) and pin the grid's background-position to it.
  // Runs every render with an equality guard: layout can shift on zoom, slide changes, panel toggles.
  const [dotOrigin, setDotOrigin] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!pinnedTemplateId) return;
    const el = scrollAreaRef.current, content = contentRef.current;
    if (!el || !content) return;
    const vr = el.getBoundingClientRect();
    const cr = content.getBoundingClientRect();
    const x = Math.round((cr.left - vr.left + el.scrollLeft) * 100) / 100;
    const y = Math.round((cr.top - vr.top + el.scrollTop) * 100) / 100;
    setDotOrigin(prev => (prev.x === x && prev.y === y ? prev : { x, y }));
  });

  // ── Adapter: combine persistent slide (from hook) + local ephemeral state ─
  const activeSlideId = editor.activeSlideId;
  const activePersistent = editor.activeSlide;
  const activeHasVideo = (activePersistent?.settings.imageBoxes ?? []).some(b => !!b.videoUrl);
  const activeLocal = activeSlideId ? (localStates[activeSlideId] ?? makeLocal()) : makeLocal();

  function updateLocal(slideId: string, partial: Partial<LocalSlideState>) {
    setLocalStates(prev => {
      const current = prev[slideId] ?? makeLocal();
      return { ...prev, [slideId]: { ...current, ...partial } };
    });
  }

  function updateSettings(slideId: string, partial: Partial<CarouselSettings>) {
    editor.updateSlide(slideId, { settings: partial });
  }

  // Freshest active slide, so the async expand patches against current state (not a stale snapshot).
  const activeSlideRef = useRef(editor.activeSlide);
  useEffect(() => { activeSlideRef.current = editor.activeSlide; });

  // BRIA image expansion: outpaint the selected box's image so it fills the whole slide based on the
  // box's current placement, then replace the box in place (full-slide) with the result.
  async function handleExpandImageBox(boxId: string) {
    const slide = editor.activeSlide;
    if (!slide) return;
    const box = (slide.settings.imageBoxes ?? []).find(b => b.id === boxId);
    if (!box?.url) return;
    const slideId = slide.id;
    setImageBoxExpandState(prev => ({ ...prev, [boxId]: 'processing' }));
    try {
      // If the box is cropped, send BRIA exactly what's shown (the cropped region), not the full
      // source — otherwise the placement/size it's told wouldn't match the visible pixels.
      const cp = box.crop;
      const cropped = !!cp && ((cp.left ?? 0) + (cp.right ?? 0) > 0.0001 || (cp.top ?? 0) + (cp.bottom ?? 0) > 0.0001);
      let sourceUrl = box.url;
      if (cropped) {
        const croppedBlob = await renderCroppedBlob(box.url, cp!);
        const croppedUrl = croppedBlob && await uploadPostImage(new File([croppedBlob], `crop-${boxId}.png`, { type: 'image/png' }));
        if (!croppedUrl) throw new Error('failed to prepare cropped image');
        sourceUrl = croppedUrl;
      }
      const res = await authedFetch('/api/ai/expand-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: sourceUrl,
          canvasSize: [CAROUSEL_W, CAROUSEL_H],
          originalImageSize: [box.width, box.height],
          originalImageLocation: [box.x, box.y],
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error || `expand failed (${res.status})`);
      }
      // The route returns the expanded image bytes (server-proxied from BRIA, no client CORS).
      // Persist into our post-images bucket so it survives reload/export and is CORS-safe.
      const blob = await res.blob();
      const publicUrl = await uploadPostImage(new File([blob], `expand-${boxId}.png`, { type: blob.type || 'image/png' }));
      if (!publicUrl) throw new Error('upload failed');
      // Replace in place against the FRESHEST boxes (preserve concurrent edits; abort if the slide changed).
      const fresh = activeSlideRef.current;
      if (!fresh || fresh.id !== slideId) throw new Error('active slide changed during expand');
      const newBoxes = (fresh.settings.imageBoxes ?? []).map((b: ImageBox) =>
        b.id === boxId
          ? { ...b, url: publicUrl, x: 0, y: 0, width: CAROUSEL_W, height: CAROUSEL_H, aspect: CAROUSEL_W / CAROUSEL_H, crop: undefined, fgUrl: undefined }
          : b
      );
      if (!newBoxes.some((b: ImageBox) => b.id === boxId)) throw new Error('box removed during expand');
      // The expanded image now fills the slide, so send it to the BACK of the layer stack — a
      // full-bleed image shouldn't cover text/logos placed on top.
      const fs = fresh.settings;
      const fadeOn = !!(fs.showFade || fs.showTopFade);
      const order = orderedLayerIds(newBoxes, fs.textBoxes ?? [], fs.freeElements ?? [], fs.layerOrderIds, fadeOn, false, fs.zoneLogoSlots, { tagSlots: fs.tagSlots, quoteSlots: fs.quoteSlots, tagZoneSlots: fs.tagZoneSlots, quoteZoneSlots: fs.quoteZoneSlots, swipeZoneSlots: fs.swipeZoneSlots }).map(x => x.id);
      const layerOrderIds = [boxId, ...order.filter(id => id !== boxId)];
      updateSettings(slideId, { imageBoxes: newBoxes, layerOrderIds });
      setImageBoxExpandState(prev => { const n = { ...prev }; delete n[boxId]; return n; });
      setExpandPreviewBoxId(null);   // leave preview mode now the expand is applied
    } catch (err) {
      console.error('[expand] failed:', err);
      setImageBoxExpandState(prev => ({ ...prev, [boxId]: 'error' }));
    }
  }


  // (No auto-create. An empty editor shows a "Create your first template" CTA instead — see the early
  // return below — so a brand-new user or a post-wipe doesn't silently spawn a template row.)

  // Undo / redo keyboard shortcuts (⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z, Ctrl+Y).
  // Ignored while typing in a field so native text undo still works there.
  const { undo, redo } = editor;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'z')      { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Close template dropdown on outside click or Escape
  useEffect(() => {
    if (!showTemplateDropdown) return;
    // Commit an in-progress rename before the dropdown unmounts. onBlur is unreliable when the dropdown is
    // torn down by this same click, so clicking away would otherwise discard the rename (forcing Enter).
    const flushRename = () => {
      if (renamingTemplateId && renameValue.trim()) void editor.renameTemplate(renamingTemplateId, renameValue.trim());
      setRenamingTemplateId(null);
    };
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!templateDropdownRef.current?.contains(t) && !templatePanelRef.current?.contains(t)) {
        flushRename();
        setShowTemplateDropdown(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowTemplateDropdown(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showTemplateDropdown, renamingTemplateId, renameValue, editor.renameTemplate]);

  // Global media paste (posts mode / pinned overlay): ⌘/Ctrl+V an image or MP4 video from the
  // clipboard anywhere in the editor uploads it, joins the Post-uploads tray (so the asset stays
  // reusable/draggable later) AND places it directly on the active slide's canvas, centred.
  // Ignored while typing so text paste still works. Coordination with the canvas's layer paste is
  // per-EVENT (clipboardEventHasMediaFile): clipboard files win — the canvas layer-paste bails when
  // the event carries media files, and this handler no-ops when it doesn't — so one ⌘/Ctrl+V is
  // always exactly one action. Do NOT gate this on the layer clipboard being empty: it is never
  // cleared, so that gate would permanently kill media paste after the first ⌘/Ctrl+C of a layer.
  useEffect(() => {
    if (!allowMedia || !activePostId) return;
    function onPaste(e: ClipboardEvent) {
      if (!clipboardEventHasMediaFile(e)) return;   // no media file → the canvas layer-paste owns this ⌘/Ctrl+V
      const el = document.activeElement as HTMLElement | null;
      const typing = textEdit.boxIndex != null
        || (!!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
      if (typing) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const pid = activePostId!;
      // Pin the paste-time slide too: the upload below takes seconds and canvasRef always points at
      // whatever slide is ACTIVE when it resolves, so without this a slide/post switch mid-upload
      // would centre the box on a slide the user never pasted on (and in the cross-post case the
      // asset wouldn't even be in that post's tray — joinTray uses the paste-time pid).
      const pasteSlideId = activeSlideRef.current?.id ?? null;
      // Mirror addToTray with stable setters only, so the effect needn't depend on it.
      const joinTray = (url: string) => {
        setTrayRemoved(prev => (prev[pid]?.includes(url) ? { ...prev, [pid]: prev[pid].filter(u => u !== url) } : prev));
        setPostImagesMap(prev => {
          const cur = prev[pid] ?? [];
          return cur.includes(url) ? prev : { ...prev, [pid]: [...cur, url] };
        });
      };
      // After upload: tray + straight onto the canvas — but only while the pasted-on slide is still
      // the active one (canvasRef is null in the posts grid view, where the paste lands in the tray
      // for later; likewise if the user moved to another slide mid-upload the asset stays tray-only,
      // draggable onto a canvas whenever they want it).
      const placeOnCanvas = (url: string, kind: 'image' | 'video') => {
        joinTray(url);
        if ((activeSlideRef.current?.id ?? null) !== pasteSlideId) return;
        canvasRef.current?.addMediaBoxCentered(url, kind);
      };
      for (const it of Array.from(items)) {
        if (it.kind !== 'file') continue;
        const isImage = it.type.startsWith('image/');
        const isVideo = it.type.startsWith('video/');
        if (!isImage && !isVideo) continue;
        const file = it.getAsFile();
        if (!file) continue;
        e.preventDefault();
        if (isVideo) {
          // Only MP4 is supported (post-videos bucket), matching the Upload button.
          if (file.type !== 'video/mp4') { flashPostImgMsg('Only MP4 videos are supported.'); return; }
          void uploadPostVideo(file).then(url => { if (url) placeOnCanvas(url, 'video'); });
        } else {
          void uploadPostImage(file).then(url => { if (url) placeOnCanvas(url, 'image'); });
        }
        return;
      }
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [allowMedia, activePostId, textEdit.boxIndex, uploadPostImage, uploadPostVideo, flashPostImgMsg]);

  // The new-post template picker (posts mode), extracted so the empty-state "Create first post" CTA below
  // can open it too — an early return would otherwise skip the copy that lives in the main render.
  const templatePickerModal = isPosts ? (
    <Modal
      open={showTemplatePicker}
      onClose={() => setShowTemplatePicker(false)}
      title="New carousel from a template"
      size="sm"
      variant="auth"
    >
      {pickerTemplates.length === 0 ? (
        <p className="text-body text-fg-3 py-6 text-center leading-relaxed">No templates yet.<br />Create one in the Template editor first.</p>
      ) : (
        <div className="flex flex-col gap-1.5 pb-2">
          {pickerTemplates.map(t => (
            <button
              key={t.id}
              onClick={() => { setShowTemplatePicker(false); setPostsView('editor'); void editor.createFromTemplate(t.id); }}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-surface-2 border border-line hover:bg-hover hover:border-line-strong text-left text-body text-fg transition-colors focus-ring"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-fg-3">
                <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
              </svg>
              <span className="truncate">{t.name}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  ) : null;

  // ── First-run / empty states ───────────────────────────────────────────────
  // Carousel TEMPLATE editor with no templates → prompt to create the first one. (Navigation to the reels
  // editor stays available via the sidebar + the posting-page CTAs; the kind toggle returns once a
  // template exists.)
  if (!isPosts && editor.templates.length === 0) {
    // While the (uncached) template list loads, render blank so the editor never flashes before the
    // empty state resolves — mirrors the posting page below.
    if (editor.loading) return <div className="h-full w-full" />;
    return (
      <TemplatesEmptyState
        title="No carousel templates yet"
        description="Create your first template to start designing carousels."
        actionLabel="Create your first template"
        onAction={() => void editor.createTemplate()}
      />
    );
  }
  // Carousel POSTING page (posts mode): editor.templates here is the user's POSTS. While posts + the
  // template list load, render blank so the posting UI never flashes first.
  if (isPosts && editor.templates.length === 0) {
    if (!pickerLoaded || editor.loading) return <div className="h-full w-full" />;
    return pickerTemplates.length === 0 ? (
      // No posts AND no template to build from → send them to the template editor.
      <TemplatesEmptyState
        title="No templates yet"
        description="You need a carousel template before you can make a post. Create one in the template editor first."
        actionLabel="Go to template editor"
        onAction={() => onGoToTemplateEditor?.()}
      />
    ) : (
      // No posts yet, but templates exist → create the first post via a centered CTA (opens the picker), not
      // the toolbar.
      <>
        <TemplatesEmptyState
          title="No posts yet"
          description="Create your first post from one of your templates."
          actionLabel="Create first post"
          onAction={() => setShowTemplatePicker(true)}
        />
        {templatePickerModal}
      </>
    );
  }

  // Posts mode home: a Canva-style grid of every post. Clicking a tile (or "New carousel") reveals the
  // editor; the header Back button returns here. The template picker lives here too so "New" works.
  if (isPosts && postsView === 'grid') {
    return (
      <>
        <CarouselHomeGrid
          userId={userId}
          brand={brand}
          onOpen={id => { void editor.selectTemplate(id); setPostsView('editor'); }}
          onNew={() => setShowTemplatePicker(true)}
          onRename={(id, name) => { void editor.renameTemplate(id, name); }}
          onDelete={id => { void editor.deleteTemplate(id); }}
        />
        {templatePickerModal}
      </>
    );
  }

  return (
    <div className="relative w-full flex flex-col h-full overflow-hidden" style={{ ['--ai-panel-w' as string]: aiOpen ? '340px' : '0px' } as React.CSSProperties}>

      {/* Toolbar */}
      <div ref={editorHeaderRef} className="relative flex items-center justify-between gap-4 px-4 border-b border-line shrink-0 bg-surface-1 transition-[padding] duration-[var(--dur-spatial)] ease-[var(--ease-emphasized)]" style={{ height: HEADER_H, paddingLeft: `calc(1rem + var(--ai-panel-w, 0px))` }}>
        {/* Left slot — Back-to-grid (posts) / Build-with-AI element generator (template editor only). */}
        <div className="flex items-center gap-2">
          {isPosts ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPostsView('grid')}
              leadingIcon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
              }
            >
              All carousels
            </Button>
          ) : !pinnedTemplateId ? (
            <Button size="sm" variant="ghost" onClick={() => setAiOpen(v => !v)} leadingIcon={<span className="brightness-0 invert">✨</span>}>
              Build with AI
            </Button>
          ) : null /* pinned/embedded: the automations AI dock handles element edits */}
        </div>

        {/* Templates dropdown — absolutely centred over the canvas area (no CSS transform so fixed children use viewport coords) */}
        <div className="absolute inset-x-0 flex justify-center items-center pointer-events-none" style={{ left: 12 }}>
          <div ref={templateDropdownRef} className="pointer-events-auto relative flex items-center">
          {pinnedTemplateId ? (
            // Embedded/pinned: this overlay edits ONE template — no switcher, just its name.
            <span className="text-subheading text-fg max-w-[220px] truncate px-2.5 py-1" title={editor.activeTemplate?.name ?? undefined}>
              {editor.activeTemplate?.name ?? 'Template'}
            </span>
          ) : (
          <button
            ref={templateTriggerRef}
            onClick={() => {
              setRenamingTemplateId(null);
              setShowTemplateDropdown(v => {
                if (!v && templateTriggerRef.current) {
                  const r = templateTriggerRef.current.getBoundingClientRect();
                  // Drop below the full header bar (not just the trigger button) so it never overlaps it.
                  const headerBottom = editorHeaderRef.current?.getBoundingClientRect().bottom ?? r.bottom;
                  setDropdownAnchor({ top: headerBottom + 8, left: r.left + r.width / 2 });
                }
                return !v;
              });
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-fg hover:bg-hover transition-colors focus-ring"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-fg-3 shrink-0">
              <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
            </svg>
            <span className="text-subheading text-fg max-w-[160px] truncate" title={editor.activeTemplate?.name ?? undefined}>
              {editor.activeTemplate?.name ?? (isPosts ? 'Carousels' : 'Templates')}
            </span>
            <ChevronDownIcon size={12} className="text-fg-3 shrink-0" aria-hidden />
          </button>
          )}

          {showTemplateDropdown && dropdownAnchor && (
            <div
              ref={templatePanelRef}
              className="fixed w-[240px] bg-surface-2 border border-line rounded-xl shadow-3 z-modal py-1 overflow-hidden"
              style={{ top: dropdownAnchor.top, left: dropdownAnchor.left, transform: 'translateX(-50%)' }}
            >
              <div className="max-h-[320px] overflow-y-auto scrollbar-none">
                {editor.templates.length === 0 ? (
                  <p className="text-caption text-fg-3 px-3 py-4 text-center">No {isPosts ? 'carousels' : 'templates'} yet</p>
                ) : editor.templates.map(t => {
                  const isActive = t.id === editor.activeTemplateId;
                  const isRenaming = renamingTemplateId === t.id;
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
                            if (renameValue.trim()) void editor.renameTemplate(t.id, renameValue.trim());
                            setRenamingTemplateId(null);
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter') { e.currentTarget.blur(); }
                            if (e.key === 'Escape') { setRenamingTemplateId(null); }
                          }}
                          onClick={e => e.stopPropagation()}
                          className="flex-1 bg-surface-3 text-fg text-subheading px-2 py-1.5 rounded-md outline-none focus-ring my-1 min-w-0"
                        />
                      ) : (
                        <button
                          onClick={() => {
                            if (isActive) {
                              setRenameValue(t.name);
                              setRenamingTemplateId(t.id);
                            } else {
                              void editor.selectTemplate(t.id);
                              setShowTemplateDropdown(false);
                            }
                          }}
                          className={`flex-1 flex items-center gap-2 py-2 px-1 text-subheading text-left rounded-sm focus-ring transition-colors min-w-0 ${isActive ? 'text-fg' : 'text-fg-2 hover:text-fg'}`}
                        >
                          <span className="flex-1 truncate" title={t.name}>{t.name}</span>
                        </button>
                      )}
                      {/* Hide the row actions while renaming so the input spans the full width (reveals the whole name). */}
                      {!isRenaming && <>
                      <IconButton
                        size="sm"
                        onClick={e => {
                          e.stopPropagation();
                          void editor.duplicateTemplate(t.id);
                          setShowTemplateDropdown(false);
                        }}
                        label={`Duplicate ${isPosts ? 'carousel' : 'template'}`}
                        className="size-5"
                        icon={
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
                          </svg>
                        }
                      />
                      {/* Delete — allowed even for the last one (the editor falls back to its empty state). */}
                      <IconButton
                        size="sm"
                        variant="danger"
                        onClick={e => {
                          e.stopPropagation();
                          setConfirmDeleteTemplate({ id: t.id, name: t.name });
                        }}
                        label={`Delete ${isPosts ? 'carousel' : 'template'}`}
                        className="size-5"
                        icon={<CloseIcon size={13} aria-hidden />}
                      />
                      </>}
                    </div>
                  );
                })}
              </div>
              <div className="border-t border-line p-1">
                <button
                  onClick={() => {
                    setShowTemplateDropdown(false);
                    setRenamingTemplateId(null);
                    if (isPosts) setShowTemplatePicker(true);
                    else void editor.createTemplate();
                  }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-subheading text-fg-2 hover:text-fg hover:bg-hover rounded-lg transition-colors focus-ring"
                >
                  <PlusIcon size={12} aria-hidden />
                  New {isPosts ? 'carousel' : 'template'}
                </button>
              </div>
            </div>
          )}
          {confirmDeleteTemplate && (
            <ConfirmDeleteDialog
              slideName={confirmDeleteTemplate.name}
              kind={isPosts ? 'post' : 'template'}
              onCancel={() => setConfirmDeleteTemplate(null)}
              onConfirm={() => {
                void editor.deleteTemplate(confirmDeleteTemplate.id);
                setConfirmDeleteTemplate(null);
                setShowTemplateDropdown(false);
              }}
            />
          )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <AutosaveChip state={editor.saveState} />
          {/* In the template editor, the header CTA jumps to the Carousels create page; in posts mode
              (no onCreate) it stays a PNG/MP4 download of the active canvas. */}
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
            <>
              <ExportQuotaChip remaining={exportGuard.remaining} notice={exportGuard.notice} />
              <Button
                size="sm"
                variant="primary"
                onClick={() => void exportGuard.guard(`carousel:${editor.activeTemplateId ?? 'none'}`, () => canvasRef.current?.startDownload())}
                leadingIcon={<DownloadIcon size={12} aria-hidden />}
                className="rounded-full"
              >
                {activeHasVideo ? 'MP4' : 'PNG'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Element rail — Miro-style icon rail; each icon opens a flyout of draggable items.
          Replaces the old always-open Elements drawer. The draggable content lives here in the
          parent's scope so every drag/upload/paste handler keeps working unchanged; ElementRail
          owns only the rail + flyout chrome. */}
      <ElementRail
        topIsland={topIsland}
        collapseMiddle={collapseMiddle}
        onUndo={() => editor.undo()}
        onRedo={() => editor.redo()}
        canUndo={editor.canUndo}
        canRedo={editor.canRedo}
        categories={[

          // Post uploads — temporary per-carousel uploads (Carousels mode + the automations
          // pinned-template overlay). Paste lands straight on the canvas (and joins this tray);
          // uploads and video links land here to be dragged onto the canvas.
          allowMedia && activePostId && {
            id: 'images', label: 'Post uploads', icon: RailIcons.images,
            content: (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => postImageInputRef.current?.click()}
                    disabled={postImgUploading}
                    loading={postImgUploading}
                    leadingIcon={<UploadIcon size={12} aria-hidden />}
                    className="flex-1"
                  >
                    {postImgUploading ? 'Uploading…' : 'Upload'}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handlePostImagePasteButton}
                    disabled={postImgUploading}
                    leadingIcon={
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                      </svg>
                    }
                    className="flex-1"
                  >
                    Paste
                  </Button>
                  <input ref={postImageInputRef} type="file" accept="image/*,video/mp4" onChange={handlePostImageFile} className="hidden" />
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="url"
                    value={videoLinkInput}
                    onChange={e => setVideoLinkInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addVideoFromLink(); } }}
                    placeholder="Paste a TikTok / Instagram / X link"
                    disabled={postImgUploading}
                    className="flex-1 min-w-0 bg-surface-1 border border-line focus:border-line-strong rounded-md px-2 py-1 text-caption text-fg placeholder:text-fg-4 outline-none focus-ring transition-colors"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={addVideoFromLink}
                    disabled={postImgUploading || !videoLinkInput.trim()}
                  >
                    Add
                  </Button>
                </div>
                <p className="text-caption text-fg-3 leading-relaxed">
                  {postImgMsg ?? 'Paste (⌘/Ctrl+V) an image or MP4 to drop it straight onto the canvas, or upload / add a TikTok/IG/X video link — everything lands here too, ready to drag on again.'}
                </p>
                {trayUrls.length > 0 && (
                  <UploadsGallery
                    logos={trayUrls.map((u, i) => ({ id: u, url: u, position: i }))}
                    dragProps={(url) => makeDragHandlers({ type: isVideoUrl(url) ? 'video' : 'image', url }, setDraggingKind)}
                    onDelete={(id) => removeFromTray(activePostId, id)}
                  />
                )}
              </div>
            ),
          },

          // Brand logos — drag onto a logo slot (preset box), or onto the canvas as a movable logo
          brand.logos.length > 0 && {
            id: 'logos', label: 'Brand uploads', icon: RailIcons.logos,
            content: (
              <UploadsGallery
                logos={brand.logos}
                dragProps={(url) => makeDragHandlers({ type: 'logo', url }, setDraggingKind)}
              />
            ),
          },

          // Text presets — drag onto the canvas (freeform) or into a vacant headline/sub slot
          {
            id: 'text', label: 'Text', icon: RailIcons.text,
            content: (
            <div className="flex flex-col gap-1">
              {([
                { label: 'Heading',    text: 'Write a headline',        preview: { size: 17, weight: 800 }, preset: { fontSize: 68, fontWeight: 700, lineHeight: 15, width: 760, height: 170, align: 'left' } },
                { label: 'Subheading', text: 'Support it with context', preview: { size: 13, weight: 600 }, preset: { fontSize: 32, fontWeight: 400, lineHeight: 10, width: 700, height: 100, align: 'left' } },
                { label: 'Body 1',     text: 'Body copy goes here',     preview: { size: 11, weight: 400 }, preset: { fontSize: 24, fontWeight: 400, lineHeight: 15, width: 620, height: 120, align: 'left' } },
                { label: 'Body 2',     text: 'Smaller supporting copy', preview: { size: 10, weight: 400 }, preset: { fontSize: 18, fontWeight: 400, lineHeight: 15, width: 560, height: 100, align: 'left' } },
                { label: 'Caption',    text: 'CAPTION',                 preview: { size: 9,  weight: 600 }, preset: { fontSize: 14, fontWeight: 600, allCaps: true, letterSpacing: 2, lineHeight: 10, width: 400, height: 50, align: 'left' } },
              ] as const).map(p => (
                <div
                  key={p.label}
                  {...makeDragHandlers({ type: 'text', text: p.text, textPreset: { ...p.preset, label: p.label } }, setDraggingKind)}
                  className="flex items-center justify-between rounded-md bg-surface-1 border border-line hover:border-line-strong hover:bg-surface-2 transition-colors cursor-grab active:cursor-grabbing select-none px-2.5 py-2"
                >
                  <span className="text-fg truncate" style={{ fontSize: p.preview.size, fontWeight: p.preview.weight, letterSpacing: p.label === 'Caption' ? '0.12em' : undefined }}>
                    {p.text}
                  </span>
                  <span className="text-caption text-fg-3 shrink-0 ml-2">{p.label}</span>
                </div>
              ))}
            </div>
            ),
          },

          // Tags — 3-column grid matching slot subdivision width, draggable
          {
            id: 'tags', label: 'Tags', icon: RailIcons.tags,
            content: (
            <div className="grid grid-cols-3 gap-1">
              {TAG_PRESETS.map((preset, i) => {
                const s = preset.initStyle;
                const tagStyle = { ...defaultTagStyle(), ...s };
                const variants: { bg: string; border: string; color: string; font: string; size: number; tracking: string; radius: number }[] = [
                  { bg: '#3f3f46',    border: 'none',              color: '#f4f4f5', font: 'Inter, sans-serif',          size: 10, tracking: '0.04em', radius: 3  },
                  { bg: '#ffffff',    border: 'none',              color: '#18181b', font: 'Impact, sans-serif',          size: 11, tracking: '0.06em', radius: 2  },
                  { bg: 'transparent',border: '1px solid #a1a1aa', color: '#a1a1aa', font: 'Inter, sans-serif',          size: 9,  tracking: '0.08em', radius: 3  },
                  { bg: '#27272a',    border: '1px solid #52525b', color: '#d4d4d8', font: '"Georgia", serif',            size: 10, tracking: '0.02em', radius: 4  },
                  { bg: '#52525b',    border: 'none',              color: '#fafafa', font: 'Impact, sans-serif',          size: 12, tracking: '0.05em', radius: 2  },
                  { bg: 'transparent',border: '1px solid #ffffff', color: '#ffffff', font: 'Inter, sans-serif',          size: 9,  tracking: '0.1em',  radius: 20 },
                  { bg: '#18181b',    border: '1px solid #3f3f46', color: '#a1a1aa', font: '"Courier New", monospace',    size: 9,  tracking: '0.03em', radius: 3  },
                  { bg: '#71717a',    border: 'none',              color: '#fafafa', font: 'Impact, sans-serif',          size: 11, tracking: '0.07em', radius: 0  },
                  { bg: 'transparent',border: '1px solid #52525b', color: '#71717a', font: 'Inter, sans-serif',          size: 9,  tracking: '0.12em', radius: 3  },
                ];
                const v = variants[i % variants.length];
                const isLive = preset.id === 'live';
                const displayText = isLive ? 'LIVE' : preset.label;
                return (
                  <div
                    key={preset.id}
                    {...makeDragHandlers({ type: 'tag', text: displayText, style: tagStyle }, setDraggingKind)}
                    className="group flex items-center justify-center rounded-md bg-surface-1 border border-line hover:border-line-strong hover:bg-surface-2 transition-colors cursor-grab active:cursor-grabbing select-none overflow-hidden px-1"
                    style={{ height: LOGO_PH + 14 }}
                  >
                    <div className="flex items-center gap-1 shrink-0"
                      style={{ background: v.bg, border: v.border, borderRadius: v.radius, padding: '2px 6px' }}
                    >
                      {isLive && <div className="w-1 h-1 rounded-full shrink-0" style={{ background: v.color }} />}
                      <span className="truncate" style={{ fontSize: v.size, fontWeight: s.fontWeight ?? 700, color: v.color, letterSpacing: v.tracking, lineHeight: 1, fontFamily: v.font }}>
                        {displayText}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            ),
          },

          // Swipe elements
          {
            id: 'swipe', label: 'Swipe', icon: RailIcons.swipe,
            content: (
            <div className="flex flex-col gap-1">
              {SWIPE_PRESETS.map(preset => (
                <div
                  key={preset.id}
                  {...makeDragHandlers({ type: 'swipe', swipeStyle: preset.style }, setDraggingKind)}
                  title={preset.label}
                  className="group flex items-center gap-2 px-3 rounded-md bg-surface-1 border border-line hover:border-line-strong hover:bg-surface-2 transition-colors cursor-grab active:cursor-grabbing select-none"
                  style={{ height: LOGO_PH + 14, overflow: 'visible' }}
                >
                  <div className="flex-1" style={{ overflow: 'visible', minWidth: 0 }}>
                    <TemplateEditorSwipePreviewMini style={preset.style} />
                  </div>
                </div>
              ))}
            </div>
            ),
          },

          // Dividers — to-scale (LOGO_PH height) single column
          {
            id: 'dividers', label: 'Dividers', icon: RailIcons.dividers,
            content: (
            <div className="flex flex-col gap-1">
              {DIVIDER_LIBRARY.map(item => (
                <div
                  key={item.id}
                  {...makeDragHandlers({ type: 'divider', id: item.id }, setDraggingKind)}
                  title={item.label}
                  className="group flex items-center gap-2 px-2 rounded-md bg-surface-1 border border-line hover:border-line-strong hover:bg-surface-2 transition-colors cursor-grab active:cursor-grabbing select-none"
                  style={{ height: LOGO_PH + 14 }}
                >
                  <div className="flex-1 min-w-0">
                    <DividerSlotElement id={item.id} />
                  </div>
                </div>
              ))}
            </div>
            ),
          },

          // Quote marks
          {
            id: 'quotes', label: 'Quotes', icon: RailIcons.quotes,
            content: (
            <div className="flex flex-wrap gap-1.5">
              {ALL_QUOTE_STYLES.map(qs => {
                const [vbX, vbY, vbW, vbH] = qs.viewBox;
                const gapVB = vbW * 0.15;
                const closeTransform = `translate(${vbX + vbW + gapVB},${vbY}) rotate(180,${vbW / 2},${vbH / 2}) translate(${-vbX},${-vbY})`;
                const label = qs.paired ? qs.label.replace(/ ❝…❞$/, '') : qs.label;
                return (
                  <div
                    key={qs.id}
                    {...makeDragHandlers({ type: 'quote', id: qs.id }, setDraggingKind)}
                    className="group rounded-md border border-line flex flex-col items-center justify-center gap-1.5 bg-surface-2 hover:border-line-strong hover:bg-surface-3 transition-colors cursor-grab active:cursor-grabbing select-none"
                    style={{ width: 72, height: 72 }}
                    title={label}
                  >
                    {qs.paired ? (
                      <svg
                        viewBox={`${vbX} ${vbY} ${vbW * 2 + gapVB} ${vbH}`}
                        style={{ width: 44, height: 22 }}
                        fill="currentColor"
                        className="text-fg-3 group-hover:text-fg-2 transition-colors"
                      >
                        <g>{qs.paths.map((d, i) => <path key={i} d={d} />)}</g>
                        <g transform={closeTransform}>{qs.paths.map((d, i) => <path key={i} d={d} />)}</g>
                      </svg>
                    ) : (
                      <svg
                        viewBox={qs.viewBox.join(' ')}
                        style={{ width: 32, height: 32 }}
                        fill="currentColor"
                        className="text-fg-3 group-hover:text-fg-2 transition-colors"
                      >
                        {qs.paths.map((d, i) => <path key={i} d={d} />)}
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>
            ),
          },

          // Overlay textures — click to drop a full-canvas light-leak/texture (Screen blend) onto the active slide
          OVERLAY_IDS.length > 0 && {
            id: 'overlays', label: 'Overlay textures', icon: RailIcons.overlays,
            content: (
              <div className="grid grid-cols-3 gap-1.5 px-1 pb-1">
                {OVERLAY_IDS.map(id => (
                  <button
                    key={id}
                    onClick={() => canvasRef.current?.addOverlay(overlayUrl(id))}
                    title="Add overlay texture"
                    className="aspect-square rounded-md overflow-hidden border border-line hover:border-line-strong bg-surface-2 transition-colors focus-ring"
                  >
                    <img src={overlayThumbUrl(id)} alt="" loading="lazy" draggable={false} className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            ),
          },

          !isPosts && {
            id: 'custom', label: 'Custom elements', icon: customElementsIcon,
            content: (
              <CustomElementsFlyout
                userId={userId}
                theme={ELEMENT_THEME}
                onInsert={insertCustomElement}
                onBuildWithAI={() => setAiOpen(true)}
              />
            ),
          },

          {
            id: 'settings', label: 'Settings', icon: settingsGearIcon,
            content: (
              <CarouselSettingsFlyout
                showGuides={showGuides} onToggleGuides={setShowGuides}
                showOutlines={showOutlines} onToggleOutlines={setShowOutlines}
              />
            ),
          },

        ].filter(Boolean) as RailCategory[]}
      />

      {/* Scroll area. Native scroll (overflow-auto) so the browser handles EVERY trackpad gesture
          correctly — including pure-horizontal swipes, which a manual wheel handler never receives
          (Chrome holds those for back/forward nav). overscroll-contain suppresses that nav at the
          edges; no-native-scrollbar hides the bar (the canvas has its own EditorScrollBar pan bar). */}
      <div
        ref={attachScrollArea}
        className="flex-1 overflow-auto overscroll-contain no-native-scrollbar flex flex-col [align-items:safe_center] [justify-content:safe_center]"
        // Pinned/embedded (automations mapping panel): pad left by the element rail's true footprint so
        // the canvas centres EXACTLY between the rail buttons and the right settings column. The page
        // keeps its symmetric right-panel padding (canvas centred in the overall lane).
        // In that pinned mode the backdrop is the automations dotted board: attachment:local makes the
        // dots pan with the scrolled content, and sizing the tile (and dot radius) by the current zoom
        // keeps them stuck beneath the canvas while zooming — n8n-style.
        style={{
          paddingRight: RIGHT_PANEL_VAR,
          paddingLeft: pinnedTemplateId ? `calc(${ELEMENT_RAIL_FOOTPRINT}px + var(--ai-panel-w, 0px))` : `calc(${RIGHT_PANEL_VAR} + var(--ai-panel-w, 0px))`,
          opacity: revealed && !collapseMiddle ? 1 : 0,
          transition: collapseMiddle ? 'opacity var(--rail-dur, 360ms) var(--ease-standard)' : 'opacity 280ms var(--ease-standard)',
          ...(pinnedTemplateId ? {
            backgroundImage: `radial-gradient(var(--canvas-dot, rgba(255,255,255,0.16)) ${1.2 * fitFactor * viewScale}px, transparent ${1.2 * fitFactor * viewScale}px)`,
            backgroundSize: `${22 * fitFactor * viewScale}px ${22 * fitFactor * viewScale}px`,
            backgroundPosition: `${dotOrigin.x}px ${dotOrigin.y}px`,
            backgroundAttachment: 'local' as const,
          } : null),
        }}
        // Clicking the editor void (anywhere around the slide, not on a slide column) deselects
        // everything — same result as clicking empty space inside the slide.
        onMouseDown={e => { if (!(e.target as Element).closest('[data-slide-column]')) canvasRef.current?.deselectAll(); }}
      >
        {/* World wrapper — width = the visible lane scaled by how far you've zoomed in past the minimum
            (lane.width × viewScale/ZOOM_MIN). At min zoom it exactly fills the view (whole world visible,
            nothing to pan); any zoom above makes it overflow so you can pan within it. The pannable area
            is always just the min-zoom view scaled up — never an unbounded void. */}
        <div className="flex justify-center" style={{ minWidth: lane.width ? lane.width * viewScale / ZOOM_MIN : undefined }}>
        <div
          ref={contentRef}
          className="flex flex-col items-center gap-8 py-6 px-4"
          style={{ zoom: fitFactor * viewScale }}
        >
          {(() => {
            if (!activeSlideId || !activePersistent) return null;
            const id = activeSlideId;
            const index = editor.slides.findIndex(s => s.id === id);
            const slide = {
              imageSrc:       activeLocal.imageSrc,
              headline:       activePersistent.headline,
              subheadline:    activePersistent.subheadline,
              settings:       activePersistent.settings,
              bgState:        activeLocal.bgState,
              scale:          activeLocal.scale,
              recordingState: activeLocal.recordingState,
            };
            return (
              <div key={id} data-slide-column className="flex flex-col gap-3" style={{ width: CAROUSEL_PREVIEW_W }}>

                {/* Slide label */}
                <span className="text-caption text-fg-3 font-semibold uppercase tracking-wider">
                  {index === 0 ? 'Main' : `Supporting ${index}`}
                </span>

                {/* Controls bar */}
                {(() => {
                  const bgState = slide.bgState;
                  const settings = slide.settings;
                  const splitActive = settings.bgBlurEnabled && settings.bgBlurAmount === 0 && bgState.fgMaskReady;
                  const blurActive  = settings.bgBlurEnabled && settings.bgBlurAmount > 0 && bgState.fgMaskReady;
                  const activeRef   = canvasRef;
                  return (
                    <div className="flex items-center justify-end gap-4">
                      <div className="flex items-center gap-1.5">
                        {slide.imageSrc && (
                          <>
                            <button
                              onClick={() => activeRef.current?.toggleSplit()}
                              disabled={bgState.isBgProcessing}
                              title="Split layers"
                              className={`${BTN_TEXT} ${
                                splitActive
                                  ? 'bg-action text-action-fg border-transparent hover:bg-action-hover'
                                  : bgState.bgProcessError
                                    ? 'bg-danger-tint text-danger-text border-danger-border hover:bg-danger-tint-hover'
                                    : ''
                              }`}
                            >
                              {bgState.isBgProcessing ? (
                                <>
                                  <SpinnerIcon size={11} className="animate-spin motion-reduce:animate-none" aria-hidden />
                                  Processing…
                                </>
                              ) : bgState.bgProcessError ? 'Retry' : splitActive ? 'Split: On' : 'Split'}
                            </button>
                            {bgState.fgMaskReady && (
                              <button
                                onClick={() => activeRef.current?.toggleBlur()}
                                title="Blur background"
                                className={`${BTN_TEXT} ${
                                  blurActive
                                    ? 'bg-action text-action-fg border-transparent hover:bg-action-hover'
                                    : ''
                                }`}
                              >
                                {blurActive ? 'Blur: On' : 'BG Blur'}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Canvas */}
                <div className="relative mt-1 ring-1 ring-line-strong ring-offset-2 ring-offset-page">
                  {/* AI-applied pulse: a keyed overlay that remounts + rings once on each apply
                      (pointer-events-none, never touches the canvas below). */}
                  {aiPulseKey > 0 && <div key={aiPulseKey} onAnimationEnd={() => setAiPulseKey(0)} className="de-ai-pulse pointer-events-none absolute inset-0 z-10" aria-hidden />}
                  <TemplateEditorCanvas
                      ref={r => { canvasRef.current = r; }}
                      rectMode={true}
                      invertedSlots={index === 2}
                      imageSrc={slide.imageSrc}
                      headline={slide.headline}
                      subheadline={slide.subheadline}
                      settings={slide.settings}
                      displayValues={displayValues}
                      displayElementData={displayElementData}
                      onScaleChange={s => updateLocal(id, { scale: s })}
                      onSettingsChange={partial => updateSettings(id, partial)}
                      onBgLayerStateChange={s => updateLocal(id, { bgState: s })}
                      brandLogoSrc={brand.logoSrc || undefined}
                      onRecordingStateChange={state => updateLocal(id, { recordingState: state })}
                      onHeadlineChange={text => editor.updateSlide(id, { headline: text })}
                      onSubheadlineChange={text => editor.updateSlide(id, { subheadline: text })}
                      isDraggingElement={isDraggingElement}
                      allowImages={allowMedia}
                      draggingKind={draggingKind}
                      onSelectedImageBoxChange={setSelectedImageBox}
                      onSelectedFreeElChange={setSelectedFreeEl}
                      onSelectedTextBoxChange={setSelectedTextBox}
                      onSelectedZoneSlotChange={setSelectedZoneSlot}
                      onRichEditTargetChange={setRichEditTarget}
                      onTextEditStateChange={setTextEdit}
                      onTextBoxHeightsChange={h => setTextBoxAutoHeights(prev => ({ ...prev, ...h }))}
                      lockImageAspect={lockImageAspect}
                      cleanView={cleanView}
                      onUploadImage={(blob, filename) => uploadPostImage(new File([blob], filename, { type: blob.type || 'image/png' }))}
                      onImageBoxBgStateChange={setImageBoxBgState}
                      expandPreviewBoxId={expandPreviewBoxId}
                      perspectiveBoxId={perspectiveBoxId}
                      perspectiveMode={perspectiveMode}
                    />
                    <CarouselGuidesOverlay showGuides={showGuides} showOutlines={showOutlines} settings={slide.settings} />
                </div>

              </div>
            );
          })()}
        </div>
        </div>
        {/* Spacer reserving room for the docked slides strip — see SLIDES_DOCK_CLEARANCE. A flow
            element (not container padding) so safe-centre can still scroll the canvas to its top. */}
        <div aria-hidden className="shrink-0" style={{ height: SLIDES_DOCK_CLEARANCE }} />
      </div>

      {/* Slides strip — docked at the bottom of the lane, above the overview scrollbar. The outer
          layer is click-through and tracks the rail (so it follows the sidebar collapse); the centred
          cards capture pointer events and are capped to the canvas region via max-width so they never
          slide under the right panel or the zoom control. */}
      {/* Gated on !loading so the static "Add slide" card doesn't pop in before the slides + canvas
          on a (re)mount — it now appears together with them once the editor's data is ready. */}
      {!editor.loading && (
      <div style={{ opacity: revealed && !collapseMiddle ? 1 : 0, transition: collapseMiddle ? 'opacity var(--rail-dur, 360ms) var(--ease-standard)' : 'opacity 280ms var(--ease-standard)' }}>
      <div
        className="fixed bottom-4 z-30 flex justify-center pointer-events-none transition-[left] duration-[var(--dur-spatial)] ease-[var(--ease-emphasized)]"
        style={{ left: `calc(${RAIL_VAR} + var(--ai-panel-w, 0px))`, right: 0 }}
      >
        <div
          className="pointer-events-auto"
          style={{ maxWidth: 'calc(100% - 2 * var(--right-panel))' }}
        >
          <SlidesStrip
            slides={editor.slides}
            activeSlideId={editor.activeSlideId}
            onSelect={editor.selectSlide}
            onAdd={() => setShowAddSlideModal(true)}
            onRename={editor.renameSlide}
            onDelete={editor.deleteSlide}
            onReorder={editor.reorderSlides}
          />
        </div>
      </div>
      </div>
      )}

      {/* Miro-style horizontal scroll bar — fixed to the viewport, spanning the sidebar's right edge
          (--rail-w, the live width) to the screen's right edge so it can't overflow off-screen. Its width tracks the zoom
          level linearly across the whole range: full (edge-to-edge) only at min zoom (viewScale =
          ZOOM_MIN, the 1% readout), shrinking to a ball at max zoom-in (viewScale = ZOOM_MAX, 100%). */}
      <div style={{ opacity: revealed && !collapseMiddle ? 1 : 0, transition: collapseMiddle ? 'opacity var(--rail-dur, 360ms) var(--ease-standard)' : 'opacity 280ms var(--ease-standard)' }}>
      <EditorScrollBar
        targetRef={scrollAreaRef}
        zoom={fitFactor * viewScale}
        extent={Math.max(0, 1 - (viewScale - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN))}
        style={{ left: `calc(${RAIL_VAR} + var(--ai-panel-w, 0px))`, right: 0, transition: 'left var(--dur-spatial) var(--ease-emphasized)' }}
      />
      </div>

      {/* Bottom-left zoom readout + steppers — absolute: the control sees fit-adjusted values so the
          % is the true canvas scale (100% = native pixels) and matches across the template /
          carousel / automations editors. */}
      <ZoomControl value={fitFactor * viewScale} min={fitFactor * ZOOM_MIN} max={fitFactor * ZOOM_MAX} resetTo={pinnedTemplateId ? fitFactor * PINNED_DEFAULT_ZOOM : 1} onChange={v => { captureFocal(); setViewScale(v / fitFactor); }} />

      {/* Build-with-AI element panel — a full-height fixed left column (right of the app sidebar, above the
          editor header) that slides in like the automations chat, and pushes the header, element rail and
          floating controls right via --ai-panel-w (set on the root). */}
      {aiOpen && !isPosts && (
        <div className="fixed z-40 flex" style={{ top: 0, bottom: 0, left: RAIL_VAR }}>
          <ElementBuilderPanel
            userId={userId}
            canvas={{ width: CAROUSEL_W, height: CAROUSEL_H }}
            theme={ELEMENT_THEME}
            captureCanvas={captureCanvas}
            onInsert={insertCustomElement}
            onClose={() => setAiOpen(false)}
            onUndoEdit={() => { if (!editor.canUndo) return false; editor.undo(); return true; }}
            copilot={copilot}
          />
        </div>
      )}

      {/* Settings panel */}
      <div className="fixed right-0 z-20 bg-transparent flex flex-col" style={{ top: HEADER_H, width: RIGHT_PANEL_VAR, height: `calc(100vh - ${HEADER_H}px)`, opacity: revealed && !collapseMiddle ? 1 : 0, transition: collapseMiddle ? 'opacity var(--rail-dur, 360ms) var(--ease-standard)' : 'opacity 280ms var(--ease-standard)' }}>
        {activePersistent && (
          <TemplateEditorSettingsPanel
            settings={activePersistent.settings}
            onChange={partial => updateSettings(activePersistent.id, partial)}
            videoMode={false}
            isPosts={isPosts}
            headlineOccupied={!!activePersistent.headline?.trim()}
            subheadlineOccupied={!!activePersistent.subheadline?.trim()}
            selectedImageBox={selectedImageBox}
            selectedFreeEl={selectedFreeEl}
            selectedTextBox={selectedTextBox}
            onSelectFreeEl={i => canvasRef.current?.selectFreeEl(i)}
            onSelectImageBox={i => canvasRef.current?.selectImageBox(i)}
            onSelectZoneLogo={i => canvasRef.current?.selectZoneLogo(i)}
            onSelectTextBox={i => canvasRef.current?.selectTextBox(i)}
            onSelectZoneSlot={(kind, i) => canvasRef.current?.selectZoneSlot(kind, i)}
            onSetRichEditTarget={t => canvasRef.current?.setRichEdit(t)}
            selectedZoneSlot={selectedZoneSlot}
            richEditTarget={richEditTarget}
            textBoxAutoHeights={textBoxAutoHeights}
            lockImageAspect={lockImageAspect}
            onLockImageAspectChange={setLockImageAspect}
            imageBoxBgState={imageBoxBgState}
            imageBoxExpandState={imageBoxExpandState}
            onExpandImageBox={handleExpandImageBox}
            expandPreviewBoxId={expandPreviewBoxId}
            onExpandPreview={setExpandPreviewBoxId}
            perspectiveBoxId={perspectiveBoxId}
            onPerspectiveBox={setPerspectiveBoxId}
            perspectiveMode={perspectiveMode}
            onPerspectiveMode={setPerspectiveMode}
            richText={{
              activeBox: textEdit.boxIndex,
              hasSelection: textEdit.hasSelection,
              setWeight:    w => canvasRef.current?.setSelectionWeight(w),
              toggleItalic: () => canvasRef.current?.toggleSelectionItalic(),
              setColor:     c => canvasRef.current?.setSelectionColor(c),
            }}
          />
        )}
      </div>

      {/* New-post template picker (posts mode) — defined above so the empty-state CTA can open it too */}
      {templatePickerModal}

      {/* Add-slide chooser: start blank, or duplicate one of the existing pages */}
      <Modal open={showAddSlideModal} onClose={() => setShowAddSlideModal(false)} title="Add a slide" size="sm" variant="auth">
        <div className="flex flex-col gap-1.5 pb-2">
          <button
            onClick={() => { setShowAddSlideModal(false); void editor.addSlide(); }}
            className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-surface-2 border border-line hover:bg-hover hover:border-line-strong text-left text-body text-fg transition-colors focus-ring"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-fg-3">
              <rect x="4" y="3" width="16" height="18" rx="2"/><line x1="12" y1="9" x2="12" y2="15"/><line x1="9" y1="12" x2="15" y2="12"/>
            </svg>
            <span>Blank slide</span>
          </button>
          {editor.slides.length > 0 && (
            <>
              <p className="text-caption text-fg-3 px-1 pt-2">Or duplicate a page</p>
              {editor.slides.map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => { setShowAddSlideModal(false); void editor.duplicateSlide(s.id); }}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-surface-2 border border-line hover:bg-hover hover:border-line-strong text-left text-body text-fg transition-colors focus-ring"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-fg-3">
                    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                  <span className="truncate">{s.headline?.trim() ? s.headline.trim() : `Slide ${i + 1}`}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </Modal>

    </div>
  );
}
