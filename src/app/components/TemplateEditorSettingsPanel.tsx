'use client';

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  CarouselSettings, CarouselFontLabel, CarouselFontWeight, CarouselTextAlign,
  TagStyle, LayerId, TemplateEditorSettingsPanelProps, DividerStyleSettings,
  SwipeStyle, SwipeArrowType, SwipeLayout, SwipeDirection, ShadowStyle,
  DividerSubSlotContent, TextBoxStyle, ImageBox, ImageBoxFade, ImageEffects, TextBoxRichTextControls, PerspectiveMode,
} from './templateEditorTypes';
import { CAROUSEL_FONTS, CAROUSEL_WEIGHTS, MAX_FONT, SUB_MAX, defaultTagStyle, defaultDividerSettings, defaultSwipeStyle, defaultShadowStyle, FADE_LAYER_ID, HEADLINE_LAYER_ID, SUB_LAYER_ID, orderedLayerIds } from './templateEditorTypes';
import { CAROUSEL_W, CAROUSEL_H } from './TemplateEditorCanvas/constants';
import { TemplateEditorSwipePreviewMini } from './TemplateEditorSwipePreviewMini';
import { FadeGradientEditor } from './FadeGradientEditor';
import { useCustomFonts, resolveCarouselFont } from './customFonts';
import { Switch, ColorField, SegmentedControl, Button, IconButton } from '@/app/components/ui';
import { CollapsibleSection } from '@/app/components/ui/CollapsibleSection';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, LinkIcon, EyeIcon, EyeOffIcon, LockIcon, UnlockIcon } from '@/lib/icons';
import { EXPAND_IMAGE_ENABLED } from '@/lib/featureFlags';

// Swatch palette for per-run text colour (mirrors the canvas inline editor)
const RICH_COLORS = [
  '#ffffff', '#000000', '#9ca3af',
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e',
];

// ── Shared settings UI components ────────────────────────────────────────────

function Slider({ label, value, min = 0, max = 100, unit = '%', onChange }: {
  label: string; value: number; min?: number; max?: number; unit?: string; onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-caption text-fg-2">{label}</span>
        <span className="text-mono tabular-nums text-fg-3">{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={e => onChange(Number(e.target.value))}
        aria-label={label} aria-valuetext={`${value}${unit}`}
        className="w-full cursor-pointer" />
    </div>
  );
}

function PillBtn({ active, onClick, children, compact }: { active: boolean; onClick: () => void; children: ReactNode; compact?: boolean }) {
  return (
    <button onClick={onClick} className={`px-2 flex items-center rounded-md text-caption focus-ring transition-colors duration-[var(--dur-fast)] ${
      compact ? 'py-2' : 'h-9'
    } ${
      active ? 'bg-action text-action-fg' : 'bg-surface-1 border border-line text-fg-3 hover:text-fg hover:border-line-strong'
    }`}>{children}</button>
  );
}

// Per-edge fade controls (toggle + fade-to + 4 edge sliders + gradient editor). Reused for the
// foreground and the background layers of an image box.
function ImageFadeControls({ fade, onChange }: { fade?: ImageBoxFade; onChange: (next: ImageBoxFade) => void }) {
  const f: ImageBoxFade = fade ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const hasColor = f.color != null && f.color !== '';
  const anyEdge = (f.top ?? 0) > 0 || (f.bottom ?? 0) > 0 || (f.left ?? 0) > 0 || (f.right ?? 0) > 0;
  const enabled = f.enabled ?? anyEdge;
  const set = (p: Partial<ImageBoxFade>) => onChange({ ...f, ...p });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-caption text-fg-2">Edge fade</span>
        <Switch checked={enabled} onChange={() => set({ enabled: !enabled })} label="Edge fade" />
      </div>
      {enabled && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-caption text-fg-2">Fade to</span>
            <div className="flex items-center gap-1">
              <PillBtn compact active={!hasColor} onClick={() => set({ color: undefined })}>Transparent</PillBtn>
              <PillBtn compact active={hasColor} onClick={() => set({ color: f.color || '#000000' })}>Colour</PillBtn>
              {hasColor && (
                <ColorField value={f.color || '#000000'} onChange={v => set({ color: v })} label="Fade colour" />
              )}
            </div>
          </div>
          <Slider label="Top"    value={f.top ?? 0}    onChange={v => set({ top: v })} />
          <Slider label="Bottom" value={f.bottom ?? 0} onChange={v => set({ bottom: v })} />
          <Slider label="Left"   value={f.left ?? 0}   onChange={v => set({ left: v })} />
          <Slider label="Right"  value={f.right ?? 0}  onChange={v => set({ right: v })} />
          <FadeGradientEditor fade={f} onChange={onChange} />
        </>
      )}
    </div>
  );
}

const ALIGN_ICONS: { value: CarouselTextAlign; icon: ReactNode }[] = [
  { value: 'left',    icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="14" height="1.5" rx="0.75"/><rect x="1" y="5.5" width="10" height="1.5" rx="0.75"/><rect x="1" y="9" width="14" height="1.5" rx="0.75"/><rect x="1" y="12.5" width="8" height="1.5" rx="0.75"/></svg> },
  { value: 'center',  icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="14" height="1.5" rx="0.75"/><rect x="3" y="5.5" width="10" height="1.5" rx="0.75"/><rect x="1" y="9" width="14" height="1.5" rx="0.75"/><rect x="4" y="12.5" width="8" height="1.5" rx="0.75"/></svg> },
  { value: 'right',   icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="14" height="1.5" rx="0.75"/><rect x="5" y="5.5" width="10" height="1.5" rx="0.75"/><rect x="1" y="9" width="14" height="1.5" rx="0.75"/><rect x="7" y="12.5" width="8" height="1.5" rx="0.75"/></svg> },
  { value: 'justify', icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="14" height="1.5" rx="0.75"/><rect x="1" y="5.5" width="14" height="1.5" rx="0.75"/><rect x="1" y="9" width="14" height="1.5" rx="0.75"/><rect x="1" y="12.5" width="14" height="1.5" rx="0.75"/></svg> },
];

export function FontDropdown({ value, onChange }: { value: CarouselFontLabel; onChange: (v: CarouselFontLabel) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const btnRef  = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const customFonts = useCustomFonts();
  const fonts = [...customFonts, ...CAROUSEL_FONTS];   // uploaded fonts first
  const q = query.trim().toLowerCase();
  const filtered = q ? fonts.filter(f => f.label.toLowerCase().includes(q)) : fonts;

  useEffect(() => {
    if (!open) return;
    CAROUSEL_FONTS.forEach(f => {
      if (!f.google) return;
      const id = `gfont-${f.label.replace(/\s+/g, '-')}`;
      if (!document.getElementById(id)) {
        const link = document.createElement('link');
        link.id = id; link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
        document.head.appendChild(link);
      }
    });
    searchRef.current?.focus();
    activeRef.current?.scrollIntoView({ block: 'nearest' });
    function handle(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); }
    }
    window.addEventListener('mousedown', handle);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handle);
      window.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  function openDropdown() {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + window.scrollY + 2, left: r.left + window.scrollX, width: r.width });
    setQuery('');
    setOpen(true);
  }

  const selectedFont = resolveCarouselFont(value);

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => open ? setOpen(false) : openDropdown()}
        className="w-full h-9 bg-surface-1 border border-line hover:border-line-strong rounded-md px-3 focus-ring flex items-center justify-between transition-colors text-fg"
      >
        <span style={{ fontFamily: selectedFont.css, fontSize: 13 }}>{value}</span>
        <ChevronDownIcon size={14} className="text-fg-3 shrink-0 ml-1.5" aria-hidden />
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={listRef}
          className="bg-surface-overlay border border-line-strong rounded-md shadow-3"
          style={{
            position: 'absolute',
            top: pos.top, left: pos.left, width: pos.width,
            zIndex: 9999,
            maxHeight: 280,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
        >
          <div className="p-1.5 border-b border-line">
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') setOpen(false);
                else if (e.key === 'Enter' && filtered.length) { onChange(filtered[0].label); setOpen(false); }
              }}
              placeholder="Search fonts…"
              className="w-full box-border bg-surface-1 border border-line-strong rounded-sm px-2 py-1.5 text-caption text-fg focus-ring placeholder:text-fg-3"
            />
          </div>
          <div style={{ overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div className="px-3 py-2.5 text-caption text-fg-3">No matching fonts</div>
            ) : filtered.map(f => {
              const isActive = f.label === value;
              return (
                <button
                  key={f.label}
                  ref={isActive ? activeRef : undefined}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => { onChange(f.label); setOpen(false); }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '7px 12px', fontSize: 13,
                    fontFamily: f.css,
                    // Tokens, not literals, so the rows follow the theme (dark values unchanged:
                    // fg=white, fg-2=zinc-400/#a1a1aa, surface-3=zinc-800/#27272a).
                    color: isActive ? 'var(--fg)' : 'var(--fg-2)',
                    background: isActive ? 'var(--surface-3)' : 'transparent',
                    cursor: 'pointer', border: 'none', outline: 'none',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-3)';
                    (e.currentTarget as HTMLButtonElement).style.color = 'var(--fg)';
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.background = isActive ? 'var(--surface-3)' : 'transparent';
                    (e.currentTarget as HTMLButtonElement).style.color = isActive ? 'var(--fg)' : 'var(--fg-2)';
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

const WEIGHT_LABEL: Record<number, string> = {
  100: 'Thin', 200: 'XLight', 300: 'Light', 400: 'Regular',
  500: 'Medium', 600: 'Semi', 700: 'Bold', 800: 'XBold', 900: 'Black',
};

// Weight buttons that adapt to the selected font: a custom family shows the weights it actually
// ships; built-in fonts show the standard six. Highlights the nearest weight if there's no exact match.
export function WeightPicker({ fontLabel, value, onChange, className = 'flex gap-1 flex-wrap' }: {
  fontLabel: CarouselFontLabel;
  value: CarouselFontWeight;
  onChange: (w: CarouselFontWeight) => void;
  className?: string;
}) {
  const custom = useCustomFonts();
  const fam = custom.find(f => f.label === fontLabel);
  const opts: { value: CarouselFontWeight; label: string }[] =
    fam && fam.weights.length
      ? fam.weights.map(w => ({ value: w as CarouselFontWeight, label: fam.weightLabels[w] ?? WEIGHT_LABEL[w] ?? String(w) }))
      : CAROUSEL_WEIGHTS;
  const activeVal = opts.some(o => o.value === value)
    ? value
    : opts.reduce((best, o) => (Math.abs(o.value - value) < Math.abs(best - value) ? o.value : best), opts[0].value);
  return (
    <div className={className}>
      {opts.map(w => (
        <PillBtn key={w.value} active={activeVal === w.value} onClick={() => onChange(w.value)}>
          <span style={{ fontWeight: w.value }}>{w.label}</span>
        </PillBtn>
      ))}
    </div>
  );
}

// The two blend modes that matter for these light/texture overlays.
const BLEND_MODES: { label: string; value: string }[] = [
  { label: 'Screen',  value: 'screen' },
  { label: 'Lighten', value: 'lighten' },
];

function BlendModePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption text-fg-2">Blend mode</span>
      <SegmentedControl
        ariaLabel="Blend mode"
        size="md"
        className="w-full"
        items={BLEND_MODES.map(m => ({ value: m.value, label: m.label }))}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

export function StyleRow({ italic, onItalic, allCaps, onAllCaps, align, onAlign }: {
  italic: boolean; onItalic: () => void; allCaps: boolean; onAllCaps: () => void;
  align: CarouselTextAlign; onAlign: (v: CarouselTextAlign) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {ALIGN_ICONS.map(({ value, icon }) => (
        <button key={value} onClick={() => onAlign(value)}
          className={`flex-1 flex items-center justify-center h-9 rounded-md focus-ring transition-colors ${
            align === value ? 'bg-action text-action-fg' : 'bg-surface-1 border border-line text-fg-3 hover:text-fg hover:border-line-strong'
          }`}>{icon}</button>
      ))}
      <button onClick={onItalic} className={`h-9 px-2.5 flex items-center rounded-md text-caption italic focus-ring transition-colors ${
        italic ? 'bg-action text-action-fg' : 'bg-surface-1 border border-line text-fg-3 hover:text-fg hover:border-line-strong'
      }`}>I</button>
      <button onClick={onAllCaps} className={`h-9 px-2.5 flex items-center rounded-md text-caption font-bold tracking-wider focus-ring transition-colors ${
        allCaps ? 'bg-action text-action-fg' : 'bg-surface-1 border border-line text-fg-3 hover:text-fg hover:border-line-strong'
      }`}>AA</button>
    </div>
  );
}

function TextSettingsBox({
  title, maxFontSize,
  fontSize, letterSpacing, lineSpacing, fontLabel, fontWeight, italic, allCaps, align,
  onChange,
}: {
  title: string; maxFontSize: number;
  fontSize: number; letterSpacing: number; lineSpacing: number;
  fontLabel: CarouselFontLabel; fontWeight: CarouselFontWeight;
  italic: boolean; allCaps: boolean; align: CarouselTextAlign;
  onChange: (p: Partial<CarouselSettings>) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface-1 border border-line p-3">
      <span className="text-caption font-semibold text-fg-2 uppercase tracking-wider">{title}</span>
      <Slider label="Size"           value={fontSize}       min={1}  max={maxFontSize} unit="px" onChange={v => onChange({ [title === 'Headline' ? 'fontSize' : 'subFontSize']: v })} />
      <Slider label="Letter spacing" value={letterSpacing}  onChange={v => onChange({ [title === 'Headline' ? 'lSpacing' : 'subLSpacing']: v })} />
      <Slider label="Line spacing"   value={lineSpacing}    onChange={v => onChange({ [title === 'Headline' ? 'lHeight'  : 'subLHeight']: v })} />
      <div className="flex flex-col gap-1.5">
        <span className="text-caption text-fg-2">Font</span>
        <FontDropdown value={fontLabel} onChange={v => onChange({ [title === 'Headline' ? 'fontLabel' : 'subFontLabel']: v })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-caption text-fg-2">Weight</span>
        <WeightPicker
          fontLabel={fontLabel}
          value={fontWeight}
          onChange={w => onChange({ [title === 'Headline' ? 'fontWeight' : 'subFontWeight']: w })}
          className="flex gap-1 flex-wrap"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-caption text-fg-2">Style</span>
        <StyleRow
          italic={italic}   onItalic={() => onChange({ [title === 'Headline' ? 'italic' : 'subItalic']: !italic })}
          allCaps={allCaps} onAllCaps={() => onChange({ [title === 'Headline' ? 'allCaps' : 'subAllCaps']: !allCaps })}
          align={align}     onAlign={v => onChange({ [title === 'Headline' ? 'textAlign' : 'subTextAlign']: v })}
        />
      </div>
    </div>
  );
}

// ── Tag UI helpers ────────────────────────────────────────────────────────────

const SLOT_LABELS = ['Top Left', 'Top Center', 'Top Right', 'Bottom Left', 'Bottom Center', 'Bottom Right'] as const;

function TagPillPreview({ ts, text }: { ts: TagStyle; text: string }) {
  const tc = ts.textCase ?? 'none';
  const displayText = tc === 'upper' ? text.toUpperCase() : text;
  return (
    <span style={{
      display: 'inline-block',
      backgroundColor: ts.bgOpacity > 0 ? `${ts.bgColor}${Math.round(ts.bgOpacity * 2.55).toString(16).padStart(2, '0')}` : 'transparent',
      border: ts.borderWidth > 0 ? `${ts.borderWidth}px solid ${ts.borderColor}${Math.round(ts.borderOpacity * 2.55).toString(16).padStart(2, '0')}` : 'none',
      borderRadius: ts.cornerRadius,
      padding: `${ts.paddingY}px ${ts.paddingX}px`,
      color: ts.textColor,
      fontSize: ts.fontSize,
      fontWeight: ts.fontWeight,
      fontStyle: ts.italic ? 'italic' : 'normal',
      fontVariant: tc === 'smallcaps' ? 'small-caps' : 'normal',
      letterSpacing: ts.letterSpacing ? `${ts.letterSpacing}px` : undefined,
      lineHeight: 1.2,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: '100%',
    }}>{displayText}</span>
  );
}

function TagStyleControls({ ts, onChange }: { ts: TagStyle; onChange: (ts: TagStyle) => void }) {
  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex items-center justify-between">
        <span className="text-caption text-fg-2">BG Color</span>
        <ColorField value={ts.bgColor} onChange={v => onChange({ ...ts, bgColor: v })} label="BG color" />
      </div>
      <Slider label="BG Opacity"     value={ts.bgOpacity}     onChange={v => onChange({ ...ts, bgOpacity: v })} />
      <div className="flex items-center justify-between">
        <span className="text-caption text-fg-2">Border Color</span>
        <ColorField value={ts.borderColor} onChange={v => onChange({ ...ts, borderColor: v })} label="Border color" />
      </div>
      <Slider label="Border Width"   value={ts.borderWidth}   min={0} max={8}  unit="px" onChange={v => onChange({ ...ts, borderWidth: v })} />
      <Slider label="Border Opacity" value={ts.borderOpacity}                  onChange={v => onChange({ ...ts, borderOpacity: v })} />
      <Slider label="Corner Radius"  value={ts.cornerRadius}  min={0} max={40} unit="px" onChange={v => onChange({ ...ts, cornerRadius: v })} />
      <div className="flex items-center justify-between">
        <span className="text-caption text-fg-2">Text Color</span>
        <ColorField value={ts.textColor} onChange={v => onChange({ ...ts, textColor: v })} label="Text color" />
      </div>
      <Slider label="Font Size"      value={ts.fontSize}      min={8}  max={36} unit="px" onChange={v => onChange({ ...ts, fontSize: v })} />
      <Slider label="Letter Spacing" value={ts.letterSpacing ?? 0} min={0} max={20} unit="px" onChange={v => onChange({ ...ts, letterSpacing: v })} />
      <WeightPicker fontLabel={ts.fontLabel} value={ts.fontWeight} onChange={w => onChange({ ...ts, fontWeight: w })} className="flex flex-wrap gap-1" />
      <div className="flex gap-1.5">
        <PillBtn active={ts.italic} onClick={() => onChange({ ...ts, italic: !ts.italic })}>
          <span className="italic">I</span>
        </PillBtn>
        <PillBtn active={(ts.textCase ?? 'none') === 'upper'}     onClick={() => onChange({ ...ts, textCase: ts.textCase === 'upper'    ? 'none' : 'upper' })}>
          <span className="text-caption font-bold tracking-wide">AA</span>
        </PillBtn>
        <PillBtn active={(ts.textCase ?? 'none') === 'smallcaps'} onClick={() => onChange({ ...ts, textCase: ts.textCase === 'smallcaps' ? 'none' : 'smallcaps' })}>
          <span style={{ fontVariant: 'small-caps', fontSize: 13 }}>Aa</span>
        </PillBtn>
      </div>
      <FontDropdown value={ts.fontLabel} onChange={v => onChange({ ...ts, fontLabel: v })} />
      <Slider label="Pad X" value={ts.paddingX} min={0} max={32} unit="px" onChange={v => onChange({ ...ts, paddingX: v })} />
      <Slider label="Pad Y" value={ts.paddingY} min={0} max={20} unit="px" onChange={v => onChange({ ...ts, paddingY: v })} />
      <ShadowEditor value={ts.shadow} onChange={v => onChange({ ...ts, shadow: v })} showLift={false} />
    </div>
  );
}

// Numeric field that keeps a local draft while focused so you can clear/retype
// freely; commits valid numbers live and shows up to 2 decimals when idle.
function DimInput({ value, min, max, onCommit, className }: {
  value: number; min?: number; max?: number; onCommit: (v: number) => void; className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value * 100) / 100);
  return (
    <input
      type="number" min={min} max={max} step="any" value={shown}
      onChange={e => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onCommit(n);
      }}
      onBlur={() => setDraft(null)}
      className={className}
    />
  );
}

export function ShadowEditor({ value, onChange, showLift = true }: { value?: ShadowStyle; onChange: (s: ShadowStyle) => void; showLift?: boolean }) {
  const s = { ...defaultShadowStyle(), ...value };
  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex items-center justify-between">
        <span className="text-caption text-fg-2">Shadow</span>
        <Switch checked={s.enabled} onChange={() => onChange({ ...s, enabled: !s.enabled })} label="Shadow" />
      </div>
      {s.enabled && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-caption text-fg-2">Shadow Color</span>
            <ColorField value={s.color} onChange={v => onChange({ ...s, color: v })} label="Shadow color" />
          </div>
          <Slider label="Blur"     value={s.blur}    min={0}   max={80}  unit="px" onChange={v => onChange({ ...s, blur: v })} />
          <Slider label="Offset X" value={s.offsetX} min={-60} max={60}  unit="px" onChange={v => onChange({ ...s, offsetX: v })} />
          <Slider label="Offset Y" value={s.offsetY} min={-60} max={60}  unit="px" onChange={v => onChange({ ...s, offsetY: v })} />
          <Slider label="Opacity"  value={s.opacity} min={0}   max={100}            onChange={v => onChange({ ...s, opacity: v })} />
        </>
      )}
      {showLift && <Slider label="Lift" value={s.lift} min={-200} max={400} unit="px" onChange={v => onChange({ ...s, lift: v })} />}
    </div>
  );
}

function TagSlotEditor({
  idx, tagSlot, onChange, onRemove, label, embedded,
}: {
  idx: number;
  tagSlot: { text: string; style: TagStyle };
  onChange: (slot: { text: string; style: TagStyle }) => void;
  onRemove: () => void;
  label?: string;
  embedded?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // As a draggable layer-row body: no card / header / own chevron — just the text + style controls + remove.
  if (embedded) {
    return (
      <div className="flex flex-col gap-2 pt-1">
        <input
          type="text"
          value={tagSlot.text}
          onChange={e => onChange({ ...tagSlot, text: e.target.value })}
          placeholder="Tag text…"
          className="w-full bg-surface-1 border border-line focus-visible:border-line-strong rounded-md px-2 py-1 text-caption text-fg focus-ring placeholder:text-fg-3"
        />
        <TagStyleControls ts={tagSlot.style} onChange={newStyle => onChange({ ...tagSlot, style: newStyle })} />
        <Button variant="danger" size="sm" fullWidth onClick={onRemove} className="mt-1">Remove tag</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-surface-1 border border-line p-2">
      {/* Header row: label + preview + expand + remove */}
      <div className="flex items-center gap-1.5">
        <span className="text-caption text-fg-3 shrink-0 w-16">{label ?? SLOT_LABELS[idx]}</span>
        <div className="flex-1 overflow-hidden min-w-0">
          <TagPillPreview ts={tagSlot.style} text={tagSlot.text} />
        </div>
        <IconButton
          size="sm"
          onClick={() => setExpanded(e => !e)}
          label={expanded ? 'Collapse' : 'Edit style'}
          icon={expanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
        />
        <IconButton
          size="sm"
          variant="danger"
          onClick={onRemove}
          label="Remove tag"
          icon={<CloseIcon size={13} />}
        />
      </div>
      {expanded && (
        <>
          {/* Editable text */}
          <input
            type="text"
            value={tagSlot.text}
            onChange={e => onChange({ ...tagSlot, text: e.target.value })}
            placeholder="Tag text…"
            className="w-full bg-surface-1 border border-line focus-visible:border-line-strong rounded-md px-2 py-1 text-caption text-fg focus-ring placeholder:text-fg-3"
          />
          <TagStyleControls
            ts={tagSlot.style}
            onChange={newStyle => onChange({ ...tagSlot, style: newStyle })}
          />
        </>
      )}
    </div>
  );
}

// ── Divider settings ──────────────────────────────────────────────────────────

const DIVIDER_TYPE_LABEL: Record<string, string> = {
  solid: 'Solid', thick: 'Thick', dashed: 'Dashed', dotted: 'Dotted',
  double: 'Double', 'double-fade': 'Double Fade', triple: 'Triple',
  'dot-center': 'Dot Center', 'dots-row': 'Dots Row', 'diamond-center': 'Diamond',
  'dashed-fade': 'Dashed Fade', 'taper-dashed': 'Taper Dash',
  fade: 'Fade', 'fade-left': 'Fade Left',
  taper: 'Taper', 'thick-taper': 'Thick Taper', 'short-center': 'Short Center',
  wave: 'Wave', brackets: 'Brackets',
  'tag-center': 'Tag Center', 'tag-center-fade': 'Tag Center Fade',
  'tag-double': 'Tag Double', 'tag-short': 'Tag Short',
  'tag-left': 'Tag Left', 'tag-left-fade': 'Tag Left Fade', 'tag-right': 'Tag Right',
  'tag-logo': 'Tag + Logo',
  'logo-center': 'Logo Center', 'logo-center-fade': 'Logo Center Fade',
  'logo-left': 'Logo Left', 'logo-left-fade': 'Logo Left Fade', 'logo-right': 'Logo Right',
};

type DivField = 'lineColor' | 'lineOpacity' | 'lineWeight' | 'dashLen' | 'dashGap' |
  'dotSize' | 'dotSpacing' | 'doubleSpacing' | 'tripleSpacing' | 'centerWeight' |
  'dotRadius' | 'dotGap' | 'taperHeight' | 'shortLength' | 'waveAmplitude' |
  'bracketWidth' | 'bracketMargin' | 'contentGap' | 'fadeSpread';

const DIVIDER_FIELDS: Record<string, DivField[]> = {
  solid:             ['lineColor', 'lineOpacity', 'lineWeight'],
  thick:             ['lineColor', 'lineOpacity', 'lineWeight'],
  dashed:            ['lineColor', 'lineOpacity', 'lineWeight', 'dashLen', 'dashGap'],
  dotted:            ['lineColor', 'lineOpacity', 'dotSize', 'dotSpacing'],
  double:            ['lineColor', 'lineOpacity', 'lineWeight', 'doubleSpacing'],
  'double-fade':     ['lineColor', 'lineOpacity', 'lineWeight', 'doubleSpacing', 'fadeSpread'],
  triple:            ['lineColor', 'lineOpacity', 'lineWeight', 'centerWeight', 'tripleSpacing'],
  'dot-center':      ['lineColor', 'lineOpacity', 'lineWeight', 'dotRadius', 'dotGap'],
  'dashed-fade':     ['lineColor', 'lineOpacity', 'lineWeight', 'dashLen', 'dashGap', 'fadeSpread'],
  'taper-dashed':    ['lineColor', 'lineOpacity', 'lineWeight', 'dashLen', 'dashGap', 'fadeSpread'],
  'dots-row':        ['lineColor', 'lineOpacity', 'dotRadius', 'dotSpacing'],
  'diamond-center':  ['lineColor', 'lineOpacity', 'lineWeight', 'dotRadius', 'dotGap'],
  fade:              ['lineColor', 'lineOpacity', 'lineWeight', 'fadeSpread'],
  'fade-left':       ['lineColor', 'lineOpacity', 'lineWeight', 'fadeSpread'],
  taper:             ['lineColor', 'lineOpacity', 'taperHeight'],
  'thick-taper':     ['lineColor', 'lineOpacity', 'taperHeight'],
  'short-center':    ['lineColor', 'lineOpacity', 'lineWeight', 'shortLength'],
  wave:              ['lineColor', 'lineOpacity', 'lineWeight', 'waveAmplitude'],
  brackets:          ['lineColor', 'lineOpacity', 'lineWeight', 'bracketWidth', 'bracketMargin'],
  'tag-center':      ['lineColor', 'lineOpacity', 'lineWeight', 'contentGap'],
  'tag-center-fade': ['lineColor', 'lineOpacity', 'lineWeight', 'contentGap', 'fadeSpread'],
  'tag-double':      ['lineColor', 'lineOpacity', 'lineWeight', 'doubleSpacing', 'contentGap'],
  'tag-short':       ['lineColor', 'lineOpacity', 'lineWeight', 'contentGap'],
  'tag-left':        ['lineColor', 'lineOpacity', 'lineWeight', 'contentGap'],
  'tag-left-fade':   ['lineColor', 'lineOpacity', 'lineWeight', 'contentGap', 'fadeSpread'],
  'tag-right':       ['lineColor', 'lineOpacity', 'lineWeight', 'contentGap'],
  'tag-logo':        ['lineColor', 'lineOpacity', 'lineWeight', 'contentGap'],
  'logo-center':     ['lineColor', 'lineOpacity', 'lineWeight', 'contentGap'],
  'logo-center-fade':['lineColor', 'lineOpacity', 'lineWeight', 'contentGap', 'fadeSpread'],
  'logo-left':       ['lineColor', 'lineOpacity', 'lineWeight', 'contentGap'],
  'logo-left-fade':  ['lineColor', 'lineOpacity', 'lineWeight', 'contentGap', 'fadeSpread'],
  'logo-right':      ['lineColor', 'lineOpacity', 'lineWeight', 'contentGap'],
};

const SLOT_NAMES_3 = ['Top', 'Center', 'Bottom'] as const;

function DividerSlotEditor({
  idx, divId, ds, onChange, onRemove, subSlot, onSubChange, embedded,
}: {
  idx: number;
  divId: string;
  ds: Partial<DividerStyleSettings> | null;
  onChange: (ds: Partial<DividerStyleSettings>) => void;
  onRemove: () => void;
  subSlot?: DividerSubSlotContent | null;
  onSubChange?: (c: DividerSubSlotContent | null) => void;
  embedded?: boolean;
}) {
  const [expanded, setExpanded] = useState(!!subSlot);
  const [prevSubSlot, setPrevSubSlot] = useState(subSlot);
  if (subSlot !== prevSubSlot) {   // render-phase: auto-expand when content lands in the slot
    setPrevSubSlot(subSlot);
    if (subSlot) setExpanded(true);
  }
  const resolved: DividerStyleSettings = { ...defaultDividerSettings(divId), ...(ds ?? {}) };
  const fields = DIVIDER_FIELDS[divId] ?? ['lineColor', 'lineOpacity', 'lineWeight'];

  function upd(patch: Partial<DividerStyleSettings>) {
    onChange({ ...(ds ?? {}), ...patch });
  }

  const has = (f: DivField) => fields.includes(f);

  return (
    <div className={embedded ? 'flex flex-col gap-2 pt-1' : 'flex flex-col gap-1.5 rounded-lg bg-surface-1 border border-line p-2'}>
      {!embedded && (
      <div className="flex items-center gap-1.5">
        <span className="text-caption text-fg-3 shrink-0 w-12">{SLOT_NAMES_3[idx] ?? `#${idx + 1}`}</span>
        <span className="flex-1 text-caption text-fg-2 font-medium truncate">{DIVIDER_TYPE_LABEL[divId] ?? divId}</span>
        <IconButton
          size="sm"
          onClick={() => setExpanded(e => !e)}
          label={expanded ? 'Collapse' : 'Expand'}
          icon={expanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
        />
        <IconButton
          size="sm"
          variant="danger"
          onClick={onRemove}
          label="Remove divider"
          icon={<CloseIcon size={13} />}
        />
      </div>
      )}
      {(embedded || expanded) && (
        <div className="flex flex-col gap-2 pt-1">
          {has('lineColor') && (
            <div className="flex items-center justify-between">
              <span className="text-caption text-fg-2">Color</span>
              <ColorField value={resolved.lineColor} onChange={v => upd({ lineColor: v })} label="Line color" />
            </div>
          )}
          {has('lineOpacity') && (
            <Slider label="Opacity" value={resolved.lineOpacity} onChange={v => upd({ lineOpacity: v })} />
          )}
          {has('lineWeight') && (
            <Slider label="Line Weight" value={resolved.lineWeight} min={1} max={20} unit="px" onChange={v => upd({ lineWeight: v })} />
          )}
          {has('dashLen') && (
            <Slider label="Dash Length" value={resolved.dashLen} min={4} max={120} unit="px" onChange={v => upd({ dashLen: v })} />
          )}
          {has('dashGap') && (
            <Slider label="Dash Gap" value={resolved.dashGap} min={4} max={120} unit="px" onChange={v => upd({ dashGap: v })} />
          )}
          {has('dotSize') && (
            <Slider label="Dot Size" value={resolved.dotSize} min={1} max={20} unit="px" onChange={v => upd({ dotSize: v })} />
          )}
          {has('dotSpacing') && (
            <Slider label="Dot Spacing" value={resolved.dotSpacing} min={4} max={80} unit="px" onChange={v => upd({ dotSpacing: v })} />
          )}
          {has('doubleSpacing') && (
            <Slider label="Line Offset" value={resolved.doubleSpacing} min={2} max={40} unit="px" onChange={v => upd({ doubleSpacing: v })} />
          )}
          {has('tripleSpacing') && (
            <Slider label="Outer Offset" value={resolved.tripleSpacing} min={2} max={40} unit="px" onChange={v => upd({ tripleSpacing: v })} />
          )}
          {has('centerWeight') && (
            <Slider label="Center Weight" value={resolved.centerWeight} min={1} max={20} unit="px" onChange={v => upd({ centerWeight: v })} />
          )}
          {has('dotRadius') && (
            <Slider label="Dot Radius" value={resolved.dotRadius} min={2} max={30} unit="px" onChange={v => upd({ dotRadius: v })} />
          )}
          {has('dotGap') && (
            <Slider label="Dot Gap" value={resolved.dotGap} min={0} max={80} unit="px" onChange={v => upd({ dotGap: v })} />
          )}
          {has('taperHeight') && (
            <Slider label="Taper Height" value={resolved.taperHeight} min={5} max={60} unit="%" onChange={v => upd({ taperHeight: v })} />
          )}
          {has('shortLength') && (
            <Slider label="Line Length" value={resolved.shortLength} min={10} max={90} unit="%" onChange={v => upd({ shortLength: v })} />
          )}
          {has('waveAmplitude') && (
            <Slider label="Amplitude" value={resolved.waveAmplitude} min={2} max={50} unit="%" onChange={v => upd({ waveAmplitude: v })} />
          )}
          {has('bracketWidth') && (
            <Slider label="Bracket Width" value={resolved.bracketWidth} min={5} max={80} unit="px" onChange={v => upd({ bracketWidth: v })} />
          )}
          {has('bracketMargin') && (
            <Slider label="Side Margin" value={resolved.bracketMargin} min={0} max={120} unit="px" onChange={v => upd({ bracketMargin: v })} />
          )}
          {has('contentGap') && (
            <Slider label="Content Gap" value={resolved.contentGap} min={0} max={80} unit="px" onChange={v => upd({ contentGap: v })} />
          )}
          {has('fadeSpread') && (
            <Slider
              label="Fade Spread"
              value={resolved.fadeSpread}
              min={0}
              max={['fade-left', 'logo-left-fade', 'tag-left-fade'].includes(divId) ? 100 : 50}
              unit="%"
              onChange={v => upd({ fadeSpread: v })}
            />
          )}
          <ShadowEditor
            value={(ds as Partial<DividerStyleSettings> & { shadow?: ShadowStyle } | null)?.shadow}
            onChange={v => onChange({ ...(ds ?? {}), shadow: v })}
          />
          {subSlot?.type === 'tag' && onSubChange && (
            <div className="flex flex-col gap-2 pt-2 border-t border-line">
              <div className="flex items-center justify-between">
                <span className="text-caption font-semibold text-fg-3 uppercase tracking-wider">Box Tag</span>
                <button onClick={() => onSubChange(null)} className="text-caption text-fg-3 hover:text-danger-text focus-ring rounded-sm transition-colors">Remove</button>
              </div>
              <TagPillPreview ts={subSlot.style} text={subSlot.text} />
              <input
                type="text"
                value={subSlot.text}
                onChange={e => onSubChange({ ...subSlot, text: e.target.value })}
                placeholder="Tag text…"
                className="w-full bg-surface-1 border border-line focus-visible:border-line-strong rounded-md px-2 py-1 text-caption text-fg focus-ring placeholder:text-fg-3"
              />
              <TagStyleControls ts={subSlot.style} onChange={ts => onSubChange({ ...subSlot, style: ts })} />
            </div>
          )}
          {subSlot?.type === 'swipe' && onSubChange && (
            <div className="flex flex-col gap-2 pt-2 border-t border-line">
              <div className="flex items-center justify-between">
                <span className="text-caption font-semibold text-fg-3 uppercase tracking-wider">Box Swipe</span>
                <button onClick={() => onSubChange(null)} className="text-caption text-fg-3 hover:text-danger-text focus-ring rounded-sm transition-colors">Remove</button>
              </div>
              <TemplateEditorSwipePreviewMini style={subSlot.style} />
              <SwipeStyleControls style={subSlot.style} onChange={s => onSubChange({ ...subSlot, style: s })} />
            </div>
          )}
          {embedded && (
            <Button variant="danger" size="sm" fullWidth onClick={onRemove} className="mt-1">Remove divider</Button>
          )}
        </div>
      )}
    </div>
  );
}

// ── LayersPanel ──────────────────────────────────────────────────────────────

const LAYER_META: Record<LayerId, { label: string; icon: ReactNode }> = {
  background: {
    label: 'BG Blur',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <path d="M21 15l-5-5L5 21"/>
      </svg>
    ),
  },
  circle: {
    label: 'Circle 1',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="12" cy="12" r="9"/>
        <text x="12" y="16" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor" stroke="none">1</text>
      </svg>
    ),
  },
  circle2: {
    label: 'Circle 2',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="12" cy="12" r="9"/>
        <text x="12" y="16" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor" stroke="none">2</text>
      </svg>
    ),
  },
  subject: {
    label: 'Subject',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>
    ),
  },
};

const LAYER_COLORS: Record<LayerId, string> = {
  background: '#3b82f6',
  circle:     '#a855f7',
  circle2:    '#c084fc',
  subject:    '#22c55e',
};

export function LayersPanel({ layers, onChange }: {
  layers: LayerId[];
  onChange: (layers: LayerId[]) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  // Display reversed: top of list = visually on top (last drawn)
  const displayOrder = [...layers].reverse();

  return (
    <div
      onMouseDown={e => e.stopPropagation()}
      className="flex flex-col rounded-lg bg-surface-overlay border border-line shadow-2"
      style={{
        position: 'absolute',
        right: '100%',
        top: 0,
        marginRight: 24,
        width: 'max-content',
        padding: '8px 6px',
        gap: 3,
        zIndex: 20,
        backdropFilter: 'blur(8px)',
      }}>
      <div className="text-caption font-bold text-fg-3 uppercase tracking-wider text-center border-b border-line-faint" style={{ paddingBottom: 5, marginBottom: 2 }}>
        Layers
      </div>
      {displayOrder.map((layer) => {
        const realIdx  = layers.indexOf(layer);
        const isDragging = dragIdx === realIdx;
        const isOver   = overIdx === realIdx;
        return (
          <div
            key={layer}
            draggable
            onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDragIdx(realIdx); }}
            onDragOver={e => { e.preventDefault(); setOverIdx(realIdx); }}
            onDrop={e => {
              e.preventDefault();
              if (dragIdx === null || dragIdx === realIdx) { setDragIdx(null); setOverIdx(null); return; }
              const next = [...layers];
              const [removed] = next.splice(dragIdx, 1);
              next.splice(realIdx, 0, removed);
              onChange(next);
              setDragIdx(null); setOverIdx(null);
            }}
            onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              height: 36,
              padding: '0 8px',
              borderRadius: 6,
              border: `1px solid ${isOver ? 'var(--line-strong)' : 'var(--line-faint)'}`,
              background: isOver ? 'var(--surface-hover)' : isDragging ? 'var(--surface-active)' : 'transparent',
              cursor: 'grab',
              userSelect: 'none',
              opacity: isDragging ? 0.4 : 1,
              transition: 'background 0.1s, border-color 0.1s, opacity 0.1s',
            }}
          >
            {/* Grip dots */}
            <svg width="7" height="11" viewBox="0 0 7 11" fill="var(--fg-4)" style={{ flexShrink: 0 }}>
              <circle cx="1.5" cy="1.5" r="1.2"/><circle cx="5.5" cy="1.5" r="1.2"/>
              <circle cx="1.5" cy="5.5" r="1.2"/><circle cx="5.5" cy="5.5" r="1.2"/>
              <circle cx="1.5" cy="9.5" r="1.2"/><circle cx="5.5" cy="9.5" r="1.2"/>
            </svg>
            {/* Icon + label inline */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
              <div className="text-fg-2 shrink-0">
                {LAYER_META[layer].icon}
              </div>
              <span className="text-caption text-fg-2 font-medium whitespace-nowrap overflow-hidden text-ellipsis tracking-wide">
                {LAYER_META[layer].label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── SwipeZoneEditor ──────────────────────────────────────────────────────────

const SWIPE_ARROW_TYPES: { value: SwipeArrowType; label: string }[] = [
  { value: 'line',          label: 'Line' },
  { value: 'triangle',      label: 'Triangle' },
  { value: 'chevron',       label: 'Chevron' },
  { value: 'double-chevron',label: '>>' },
  { value: 'curved',        label: 'Curved' },
];

const SWIPE_LAYOUTS: { value: SwipeLayout; label: string }[] = [
  { value: 'text-arrow', label: 'Text → Arrow' },
  { value: 'arrow-text', label: 'Arrow ← Text' },
  { value: 'stacked',    label: 'Stacked' },
  { value: 'arrow-only', label: 'Arrow only' },
  { value: 'text-only',  label: 'Text only' },
];

const ZONE_LABELS_9 = [
  'Top-L','Top-C','Top-R',
  'Mid-L','Mid-C','Mid-R',
  'Bot-L','Bot-C','Bot-R',
];

function SwipeStyleControls({ style, onChange }: { style: SwipeStyle; onChange: (s: SwipeStyle) => void }) {
  function upd(patch: Partial<SwipeStyle>) { onChange({ ...style, ...patch }); }
  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex flex-col gap-1">
        <span className="text-caption text-fg-2">Text</span>
        <input type="text" value={style.text} onChange={e => upd({ text: e.target.value })}
          className="w-full bg-surface-1 border border-line text-fg text-caption rounded-md px-2 py-1 focus-ring focus-visible:border-line-strong placeholder:text-fg-3" />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-caption text-fg-2">All Caps</span>
        <Switch checked={style.allCaps} onChange={() => upd({ allCaps: !style.allCaps })} label="All Caps" />
      </div>
      <FontDropdown value={style.fontLabel} onChange={v => upd({ fontLabel: v })} />
      <WeightPicker fontLabel={style.fontLabel} value={style.fontWeight} onChange={w => upd({ fontWeight: w })} className="flex gap-1 flex-wrap" />
      <Slider label="Font Size" value={style.fontSize} min={8} max={80} unit="px" onChange={v => upd({ fontSize: v })} />
      <Slider label="Letter Spacing" value={style.letterSpacing} min={0} max={20} unit="px" onChange={v => upd({ letterSpacing: v })} />
      <div className="flex items-center justify-between">
        <span className="text-caption text-fg-2">Text Color</span>
        <ColorField value={style.textColor} onChange={v => upd({ textColor: v })} label="Text color" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-caption text-fg-2">Arrow Type</span>
        <div className="flex gap-1 flex-wrap">
          {SWIPE_ARROW_TYPES.map(at => (
            <PillBtn key={at.value} active={style.arrowType === at.value} onClick={() => upd({ arrowType: at.value })}>
              {at.label}
            </PillBtn>
          ))}
        </div>
      </div>
      {style.arrowType !== 'chevron' && style.arrowType !== 'double-chevron' && (
        <Slider label="Arrow Length" value={style.arrowLength} min={0} max={200} unit="px" onChange={v => upd({ arrowLength: v })} />
      )}
      <div className="flex items-center justify-between">
        <span className="text-caption text-fg-2">Arrow Color</span>
        <ColorField value={style.arrowColor} onChange={v => upd({ arrowColor: v })} label="Arrow color" />
      </div>
      <Slider label="Arrow Weight" value={style.arrowWeight} min={0.5} max={10} unit="px" onChange={v => upd({ arrowWeight: v })} />
      <Slider label="Head Size" value={style.arrowHeadSize} min={2} max={40} unit="px" onChange={v => upd({ arrowHeadSize: v })} />
      <div className="flex items-center justify-between">
        <span className="text-caption text-fg-2">Direction</span>
        <div className="flex gap-1">
          <PillBtn active={style.direction === 'left'} onClick={() => upd({ direction: 'left' })}>← Left</PillBtn>
          <PillBtn active={style.direction === 'right'} onClick={() => upd({ direction: 'right' })}>Right →</PillBtn>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-caption text-fg-2">Layout</span>
        <div className="flex gap-1 flex-wrap">
          {SWIPE_LAYOUTS.map(l => (
            <PillBtn key={l.value} active={style.layout === l.value} onClick={() => upd({ layout: l.value })}>
              {l.label}
            </PillBtn>
          ))}
        </div>
      </div>
      <Slider label="Gap" value={style.gap} min={0} max={60} unit="px" onChange={v => upd({ gap: v })} />
      <Slider label="Opacity" value={style.opacity} min={0} max={100} onChange={v => upd({ opacity: v })} />
      <ShadowEditor value={style.shadow} onChange={v => upd({ shadow: v })} />
    </div>
  );
}

function SwipeZoneEditor({
  fi, style, onChange, onRemove, embedded,
}: {
  fi: number;
  style: SwipeStyle;
  onChange: (s: SwipeStyle) => void;
  onRemove: () => void;
  embedded?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  // As a draggable layer-row body: no card / header / zone-label / own chevron — just the controls + remove.
  if (embedded) {
    return (
      <div className="flex flex-col gap-2 pt-1">
        <SwipeStyleControls style={style} onChange={onChange} />
        <Button variant="danger" size="sm" fullWidth onClick={onRemove} className="mt-1">Remove swipe</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-surface-1 border border-line p-2">
      <div className="flex items-center gap-1.5">
        <span className="text-caption text-fg-3 shrink-0 w-12">{ZONE_LABELS_9[fi] ?? `#${fi}`}</span>
        <div className="flex-1 min-w-0" style={{ overflow: 'visible' }}>
          <TemplateEditorSwipePreviewMini style={style} />
        </div>
        <IconButton
          size="sm"
          onClick={() => setExpanded(e => !e)}
          label={expanded ? 'Collapse' : 'Expand'}
          icon={expanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
        />
        <IconButton
          size="sm"
          variant="danger"
          onClick={onRemove}
          label="Remove swipe"
          icon={<CloseIcon size={13} />}
        />
      </div>
      {expanded && <SwipeStyleControls style={style} onChange={onChange} />}
    </div>
  );
}

// ── TemplateEditorSettingsPanel (right column) ─────────────────────────────────────

function TextBoxEditor({ idx, tb, onChange, onRemove, rich, autoHeight }: {
  idx: number;
  tb: TextBoxStyle;
  onChange: (next: TextBoxStyle) => void;
  onRemove: () => void;
  rich?: TextBoxRichTextControls;
  autoHeight?: number;   // measured wrapped-text height (canvas units) for the read-only Height field
}) {
  const upd = (patch: Partial<TextBoxStyle>) => onChange({ ...tb, ...patch });

  // Weights the box's font actually ships (a static custom family only renders its uploaded weights;
  // built-ins use the standard set). A variable font exposes the whole range.
  const customFams = useCustomFonts();
  const famWeights: number[] = (() => {
    const fam = customFams.find(f => f.label === tb.fontLabel);
    return fam && fam.weights.length ? fam.weights : CAROUSEL_WEIGHTS.map(w => w.value);
  })();
  // Default secondary (highlight) weight: a REAL available weight that contrasts with the primary, so the
  // canvas can actually render it differently (a hardcoded 400/700 may not exist in a static family).
  const pickSecondaryWeight = (): number => {
    const diff = (w: number) => Math.abs(w - tb.fontWeight);
    const prefer = tb.fontWeight >= 600 ? [400, 300, 500, 600] : [700, 800, 900, 600];
    for (const w of prefer) if (famWeights.includes(w) && w !== tb.fontWeight) return w;
    const others = famWeights.filter(w => w !== tb.fontWeight);
    return others.length ? others.reduce((b, w) => (diff(w) > diff(b) ? w : b), others[0]) : tb.fontWeight;
  };
  // Rendered as the CONTENT of a draggable layer row (the row provides the grip / title / eye / collapse),
  // so this is just the body controls + a Remove button — no card wrapper or own header.
  return (
        <div className="flex flex-col gap-2 pt-1">
          {/* Placeholder: insert a chosen number of lorem words; turns off the moment you type your own text */}
          <div className="flex items-center justify-between">
            <span className="text-caption text-fg-2">Fill with placeholder</span>
            <Switch
              // Turning it off clears the placeholder text so the box is empty for your own content
              // (the filler lives in `text`/`spans`, so we must wipe it, not just stop regenerating).
              checked={!!tb.fillPlaceholder}
              onChange={() => upd(tb.fillPlaceholder ? { fillPlaceholder: false, text: '', spans: undefined } : { fillPlaceholder: true })}
              label="Insert lorem-ipsum placeholder words"
            />
          </div>
          {tb.fillPlaceholder ? (
            <div className="flex items-center justify-between">
              <span className="text-caption text-fg-3">Words</span>
              <input
                type="number" min={1} max={200} step={1}
                value={tb.placeholderWords ?? 8}
                onChange={e => upd({ placeholderWords: Math.max(1, Math.min(200, Number(e.target.value) || 1)) })}
                className="w-20 bg-surface-1 border border-line focus-visible:border-line-strong rounded-md px-1.5 py-1 text-caption text-fg focus-ring" />
            </div>
          ) : (
            <>
              <textarea
                value={tb.text}
                onChange={e => upd({ text: e.target.value })}
                placeholder="Text… (Enter for a new line)"
                rows={2}
                className="w-full bg-surface-1 border border-line focus-visible:border-line-strong rounded-md px-2 py-1 text-caption text-fg focus-ring resize-none leading-relaxed placeholder:text-fg-3"
              />
              {/* Per-run styling — shown while this box is being inline-edited; applies to the selected text */}
              {rich && (
                // mousedown-preventDefault keeps the canvas editor's selection alive when clicking in here
                <div onMouseDown={e => e.preventDefault()}
                  className="flex flex-col gap-1.5 rounded-md bg-surface-2 border border-line p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-caption font-semibold text-accent-text uppercase tracking-wider">Selected text</span>
                    {!rich.hasSelection && <span className="text-caption text-fg-3">select part of the text first</span>}
                  </div>
                  <div className="flex items-center gap-1 flex-wrap transition-opacity"
                    style={{ opacity: rich.hasSelection ? 1 : 0.4, pointerEvents: rich.hasSelection ? 'auto' : 'none' }}>
                    {([['Reg', 400], ['Med', 500], ['Semi', 600], ['Bold', 700]] as const).map(([label, w]) => (
                      <button key={w} onClick={() => rich.setWeight(w)} title={`Weight ${w}`}
                        className="h-8 px-2 rounded-md text-caption bg-surface-1 border border-line text-fg-2 hover:text-fg hover:border-line-strong focus-ring transition-colors"
                        style={{ fontWeight: w }}>{label}</button>
                    ))}
                    <button onClick={() => rich.toggleItalic()} title="Italic"
                      className="h-8 px-2.5 rounded-md text-caption italic bg-surface-1 border border-line text-fg-2 hover:text-fg hover:border-line-strong focus-ring transition-colors">I</button>
                  </div>
                  <div className="flex items-center gap-1 flex-wrap transition-opacity"
                    style={{ opacity: rich.hasSelection ? 1 : 0.4, pointerEvents: rich.hasSelection ? 'auto' : 'none' }}>
                    {RICH_COLORS.map(c => (
                      <button key={c} onClick={() => rich.setColor(c)} title={c}
                        className="w-5 h-5 rounded-full border border-line-strong hover:scale-110 focus-ring transition-transform"
                        style={{ background: c }} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          <div className="flex items-center gap-2">
            <span className="text-caption text-fg-2 shrink-0">Position</span>
            <label className="flex items-center gap-1 text-caption text-fg-3">
              X
              <input type="number" min={0} max={CAROUSEL_W} step={1}
                value={Math.round(tb.x)}
                onChange={e => upd({ x: Math.max(0, Math.min(CAROUSEL_W, Number(e.target.value) || 0)) })}
                className="w-16 bg-surface-1 border border-line focus-visible:border-line-strong rounded-md px-1.5 py-1 text-caption text-fg focus-ring" />
            </label>
            <label className="flex items-center gap-1 text-caption text-fg-3">
              Y
              <input type="number" min={0} max={CAROUSEL_H} step={1}
                value={Math.round(tb.y)}
                onChange={e => upd({ y: Math.max(0, Math.min(CAROUSEL_H, Number(e.target.value) || 0)) })}
                className="w-16 bg-surface-1 border border-line focus-visible:border-line-strong rounded-md px-1.5 py-1 text-caption text-fg focus-ring" />
            </label>
            <span className="text-caption text-fg-3">px</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-caption text-fg-2 shrink-0">Size</span>
            <label className="flex items-center gap-1 text-caption text-fg-3">
              W
              <input type="number" min={20} max={CAROUSEL_W} step={1}
                value={Math.round(tb.width ?? 540)}
                onChange={e => upd({ width: Math.max(20, Math.min(CAROUSEL_W, Number(e.target.value) || 0)) })}
                className="w-16 bg-surface-1 border border-line focus-visible:border-line-strong rounded-md px-1.5 py-1 text-caption text-fg focus-ring" />
            </label>
            <label className="flex items-center gap-1 text-caption text-fg-3">
              H
              {/* Auto-height text boxes hug their text: Height is derived (measured) and read-only. */}
              <input type="number" min={20} max={CAROUSEL_H} step={1}
                value={Math.round(tb.fitToWidth ? (tb.height ?? 200) : (autoHeight ?? tb.height ?? 200))}
                disabled={!tb.fitToWidth}
                readOnly={!tb.fitToWidth}
                title={tb.fitToWidth ? undefined : 'Height auto-fits the text'}
                onChange={tb.fitToWidth ? (e => upd({ height: Math.max(20, Math.min(CAROUSEL_H, Number(e.target.value) || 0)) })) : undefined}
                className={`w-16 border rounded-md px-1.5 py-1 text-caption ${tb.fitToWidth ? 'bg-surface-1 border-line focus-visible:border-line-strong text-fg focus-ring' : 'bg-surface-2 border-line text-fg-3 opacity-60 cursor-not-allowed'}`} />
            </label>
            <span className="text-caption text-fg-3">px</span>
          </div>
          {/* Snap grid · nudge pad · centre */}
          {(() => {
            const bw   = tb.width  ?? 540;
            const bh   = tb.fitToWidth ? (tb.height ?? 200) : (autoHeight ?? tb.height ?? 200);
            const EDGE = 60;
            const snapTo = (col: number, row: number) => {
              const align:  'left' | 'center' | 'right'  = col === 0 ? 'left' : col === 1 ? 'center' : 'right';
              const vAlign: 'top'  | 'middle' | 'bottom' = row === 0 ? 'top'  : row === 1 ? 'middle' : 'bottom';
              const x = col === 0 ? EDGE : col === 1 ? Math.round((CAROUSEL_W - bw) / 2) : CAROUSEL_W - EDGE - bw;
              const y = row === 0 ? EDGE : row === 1 ? Math.round((CAROUSEL_H - bh) / 2) : CAROUSEL_H - EDGE - bh;
              upd({ align, vAlign, x: Math.max(0, x), y: Math.max(0, y) });
            };
            const nudge = (dx: number, dy: number) => upd({
              x: Math.max(0, Math.min(CAROUSEL_W, tb.x + dx)),
              y: Math.max(0, Math.min(CAROUSEL_H, tb.y + dy)),
            });
            const nudgeBtn = "flex items-center justify-center w-6 h-6 rounded-md bg-surface-2 border border-line text-fg-2 hover:text-fg hover:border-line-strong focus-ring transition-colors text-caption leading-none";
            const ctrBtn   = "px-2 h-6 rounded-md bg-surface-2 border border-line text-caption text-fg-2 hover:text-fg hover:border-line-strong focus-ring transition-colors";
            return (
              <div className="flex items-start gap-3 pt-0.5">
                <div className="flex flex-col gap-1">
                  <span className="text-caption text-fg-3">Snap</span>
                  <div className="grid grid-cols-3 gap-0.5" style={{ width: 54 }}>
                    {[0, 1, 2].map(row => [0, 1, 2].map(col => (
                      <button key={`${row}-${col}`} title="Snap to this region" onClick={() => snapTo(col, row)}
                        className="h-4 w-full rounded-sm bg-surface-3 hover:bg-accent focus-ring transition-colors" />
                    )))}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-caption text-fg-3">Nudge</span>
                  <div className="flex flex-col items-center gap-0.5">
                    <button className={nudgeBtn} title="Up (1px)" onClick={() => nudge(0, -1)}>↑</button>
                    <div className="flex gap-0.5">
                      <button className={nudgeBtn} title="Left (1px)"  onClick={() => nudge(-1, 0)}>←</button>
                      <button className={nudgeBtn} title="Down (1px)"  onClick={() => nudge(0, 1)}>↓</button>
                      <button className={nudgeBtn} title="Right (1px)" onClick={() => nudge(1, 0)}>→</button>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-caption text-fg-3">Centre</span>
                  <div className="flex flex-col gap-0.5">
                    <button className={ctrBtn} title="Centre horizontally" onClick={() => upd({ align: 'center', x: Math.max(0, Math.round((CAROUSEL_W - bw) / 2)) })}>H</button>
                    <button className={ctrBtn} title="Centre vertically"   onClick={() => upd({ vAlign: 'middle', y: Math.max(0, Math.round((CAROUSEL_H - bh) / 2)) })}>V</button>
                  </div>
                </div>
              </div>
            );
          })()}
          <div className="flex items-center justify-between">
            <span className="text-caption text-fg-2">Colour</span>
            <ColorField value={tb.color} onChange={v => upd({ color: v })} label="Text colour" />
          </div>
          {/* Font size is automatic in fit-to-width mode (each line is scaled to fill the box) */}
          {!tb.fitToWidth && <Slider label="Font size" value={tb.fontSize} min={8} max={200} unit="px" onChange={v => upd({ fontSize: v })} />}
          <Slider label="Letter spacing" value={tb.letterSpacing} min={0} max={20}  unit="px" onChange={v => upd({ letterSpacing: v })} />
          <Slider label="Line spacing"   value={tb.lineHeight}    min={0} max={100}           onChange={v => upd({ lineHeight: v })} />
          <Slider label="Opacity"        value={tb.opacity}       min={0} max={100}           onChange={v => upd({ opacity: v })} />
          <FontDropdown value={tb.fontLabel} onChange={v => upd({ fontLabel: v })} />
          {/* Primary + optional secondary weight (same family). Secondary is used to highlight — the
              placeholder filler alternates primary/secondary weight word-by-word to preview it. */}
          <div className="flex flex-col gap-1">
            <span className="text-caption text-fg-3">Primary style</span>
            <WeightPicker fontLabel={tb.fontLabel} value={tb.fontWeight} onChange={w => upd({ fontWeight: w })} className="flex gap-1 flex-wrap" />
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-caption text-fg-3">Secondary style <span className="text-fg-4">· highlight</span></span>
              <Switch
                checked={tb.secondaryWeight != null}
                onChange={() => upd({ secondaryWeight: tb.secondaryWeight == null ? (pickSecondaryWeight() as CarouselFontWeight) : undefined })}
                label="A second weight for highlighting; the placeholder alternates primary/secondary per word"
              />
            </div>
            {tb.secondaryWeight != null && (
              <WeightPicker fontLabel={tb.fontLabel} value={tb.secondaryWeight} onChange={w => upd({ secondaryWeight: w })} className="flex gap-1 flex-wrap" />
            )}
          </div>
          <div className="flex gap-1.5">
            <button onClick={() => upd({ italic: !tb.italic })} className={`h-9 px-2.5 flex items-center rounded-md text-caption italic focus-ring transition-colors ${
              tb.italic ? 'bg-action text-action-fg' : 'bg-surface-1 border border-line text-fg-3 hover:text-fg hover:border-line-strong'
            }`}>I</button>
            <button onClick={() => upd({ allCaps: !tb.allCaps })} title="All caps" className={`h-9 px-2.5 flex items-center rounded-md text-caption font-bold tracking-wider focus-ring transition-colors ${
              tb.allCaps ? 'bg-action text-action-fg' : 'bg-surface-1 border border-line text-fg-3 hover:text-fg hover:border-line-strong'
            }`}>AA</button>
            {ALIGN_ICONS.map(({ value, icon }) => (
              <button key={value} onClick={() => upd({ align: value, fitToWidth: false })}
                className={`flex-1 flex items-center justify-center h-9 rounded-md focus-ring transition-colors ${
                  !tb.fitToWidth && tb.align === value ? 'bg-action text-action-fg' : 'bg-surface-1 border border-line text-fg-3 hover:text-fg hover:border-line-strong'
                }`}>{icon}</button>
            ))}
            {/* Fit-to-width (poster) mode — auto-breaks + scales each line to fill the box */}
            <button onClick={() => upd({ fitToWidth: true })} title="Fit each line to the box width"
              className={`flex-1 flex items-center justify-center h-9 rounded-md focus-ring transition-colors ${
                tb.fitToWidth ? 'bg-action text-action-fg' : 'bg-surface-1 border border-line text-fg-3 hover:text-fg hover:border-line-strong'
              }`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="4" x2="3" y2="20"/><line x1="21" y1="4" x2="21" y2="20"/>
                <line x1="7" y1="12" x2="17" y2="12"/><polyline points="9 9 6 12 9 15"/><polyline points="15 9 18 12 15 15"/>
              </svg>
            </button>
          </div>
          <div className="flex gap-1.5">
            {(['top', 'middle', 'bottom'] as const).map(v => (
              <button key={v} onClick={() => upd({ vAlign: v })}
                className={`flex-1 flex items-center justify-center h-9 rounded-md text-caption capitalize focus-ring transition-colors ${
                  (tb.vAlign ?? 'top') === v ? 'bg-action text-action-fg' : 'bg-surface-1 border border-line text-fg-3 hover:text-fg hover:border-line-strong'
                }`}>{v}</button>
            ))}
          </div>
          <ShadowEditor value={tb.shadow} onChange={v => upd({ shadow: v })} showLift={false} />
          <Button variant="danger" size="sm" fullWidth onClick={onRemove} className="mt-1">Remove text box</Button>
        </div>
  );
}

// Show/hide (eye) toggle — a plain icon button living inside the section header, left of the chevron.
export function LayerEye({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={hidden ? 'Show layer' : 'Hide layer'}
      className="shrink-0 flex items-center justify-center size-4 rounded text-fg-3 hover:text-fg transition-colors focus-ring"
    >
      {hidden ? <EyeOffIcon size={11} aria-hidden /> : <EyeIcon size={11} aria-hidden />}
    </button>
  );
}

// Floating lock toggle for a layer section's left gutter.
function LayerLock({ locked, onToggle }: { locked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={locked ? 'Unlock layer' : 'Lock layer'}
      className={`flex items-center justify-center size-4 rounded-md transition-colors focus-ring ${locked ? 'text-accent-text' : 'text-fg-3 hover:text-fg'}`}
    >
      {locked ? <LockIcon size={10} aria-hidden /> : <UnlockIcon size={10} aria-hidden />}
    </button>
  );
}

interface LayerItem { key: string; title: string; open?: boolean; onToggle?: (next: boolean) => void; hidden?: boolean; layerId?: string; leftIcons?: ReactNode; content?: ReactNode; noToggle?: boolean; }

// Human label for a 3×3 zone slot index (0..8): its grid position, shown in the layer panel like the
// skeleton text labels (e.g. "Center · Skeleton", "Top Left · Skeleton"). Free-floating logos keep
// plain "Logo", so the label also distinguishes a grid logo from a free one.
function zoneLabel(fi: number): string {
  const rows = ['Top', 'Middle', 'Bottom'];
  const cols = ['Left', 'Center', 'Right'];
  const row = rows[Math.floor(fi / 3)] ?? '';
  const col = cols[fi % 3] ?? '';
  if (row === 'Middle' && col === 'Center') return 'Center';
  if (col === 'Center') return row;          // Top / Bottom (centre column)
  if (row === 'Middle') return col;          // Left / Right (middle row)
  return `${row} ${col}`;                    // Top Left, Bottom Right, …
}

// Draggable list of layer sections with lift-on-pickup (a shadowed clone of the row follows the
// cursor) and live FLIP shifting (the other cards slide to make room as you drag, and settle on
// drop). Native HTML5 drag; the grip is the handle. Reorder is panel-display order.
export function LayerSectionList({ items, order, onOrderChange }: { items: LayerItem[]; order: string[]; onOrderChange?: (frontToBackLayerIds: string[]) => void }) {
  // `order` is front→back layer ids, derived from the saved layerOrderIds (single source of truth) —
  // so the panel always reflects the saved z-order and a reorder can't clobber it.
  const [dragKey, setDragKey] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const firstTops = useRef<Map<string, number>>(new Map());   // FLIP "First": row tops captured before a reorder

  // Pointer-based drag (no native HTML5 drag, whose setDragImage snapshots blank on some setups).
  // A real floating clone follows the cursor (lift); window pointermove reorders live (FLIP).
  const dragState = useRef<{ key: string; offX: number; offY: number; overlay: HTMLElement } | null>(null);
  // Stable listener identities; their bodies live in refs (assigned in an effect below) so they always
  // see the latest state without re-binding — and we never read/assign a ref during render.
  const handleMoveImpl = useRef<(e: PointerEvent) => void>(() => {});
  const handleUpImpl = useRef<() => void>(() => {});
  const handleMove = useCallback((e: PointerEvent) => handleMoveImpl.current(e), []);
  const handleUp = useCallback(() => handleUpImpl.current(), []);
  useEffect(() => () => {   // cleanup on unmount
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    dragState.current?.overlay.remove();
  }, [handleMove, handleUp]);

  const ordered = (() => {
    // Sort items by their layer id's position in `order` (front→back). Items whose layer isn't in
    // the order keep their natural position at the end.
    const pos = new Map(order.map((id, i) => [id, i] as const));
    return [...items].sort((a, b) =>
      (pos.get(a.layerId ?? ' ') ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.layerId ?? ' ') ?? Number.MAX_SAFE_INTEGER));
  })();

  // FLIP "Last + Invert + Play": after a reorder, slide each row from its old top to its new one.
  useLayoutEffect(() => {
    if (firstTops.current.size === 0) return;
    const rows = rowRefs.current;
    // Clear any in-flight transforms first so we measure pure layout (handles rapid re-targets).
    rows.forEach(el => { el.style.transition = 'none'; el.style.transform = ''; });
    const deltas: { el: HTMLElement; dy: number }[] = [];
    rows.forEach((el, key) => {
      const prev = firstTops.current.get(key);
      if (prev == null) return;
      const dy = prev - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) deltas.push({ el, dy });
    });
    for (const { el, dy } of deltas) el.style.transform = `translateY(${dy}px)`;
    void document.body.offsetHeight;   // force reflow so the inverted start is committed before animating
    for (const { el } of deltas) {
      el.style.transition = 'transform 190ms cubic-bezier(0.2,0,0,1)';
      el.style.transform = '';
    }
    firstTops.current.clear();
  }, [order]);

  const captureFirst = () => {
    const m = new Map<string, number>();
    rowRefs.current.forEach((el, key) => m.set(key, el.getBoundingClientRect().top));
    firstTops.current = m;
  };

  const moveRelative = (from: string, overKey: string, after: boolean) => {
    const keys = ordered.map(it => it.key);
    const next = keys.filter(k => k !== from);
    let idx = next.indexOf(overKey);
    if (idx < 0) return;
    if (after) idx += 1;
    next.splice(idx, 0, from);
    if (next.join('|') === keys.join('|')) return;   // no positional change → skip (avoids thrash)
    captureFirst();
    // Report the new z-order (panel top→bottom = front→back). The parent writes it to layerOrderIds,
    // which flows back as the `order` prop → re-render → FLIP plays. No local order state.
    const byKey = new Map(items.map(it => [it.key, it] as const));
    const ftb = next.map(k => byKey.get(k)?.layerId).filter((x): x is string => !!x);
    onOrderChange?.([...new Set(ftb)]);
  };
  // Keep the pointer-handler bodies current (assigned in an effect, never during render) so the stable
  // handleMove/handleUp listeners always run against the latest moveRelative/state.
  useEffect(() => {
    handleMoveImpl.current = (e: PointerEvent) => {
      const d = dragState.current;
      if (!d) return;
      d.overlay.style.transform = `translate(${e.clientX - d.offX}px, ${e.clientY - d.offY}px)`;
      let target: string | null = null, after = false;
      rowRefs.current.forEach((el, k) => {
        if (target || k === d.key) return;
        const rect = el.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) { target = k; after = e.clientY > rect.top + rect.height / 2; }
      });
      if (target) moveRelative(d.key, target, after);
    };
    handleUpImpl.current = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      document.body.style.removeProperty('user-select');
      dragState.current?.overlay.remove();
      dragState.current = null;
      setDragKey(null);
    };
  });

  const startDrag = (key: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;          // left button / primary touch only
    e.preventDefault();
    const row = rowRefs.current.get(key);
    if (!row) return;
    const r = row.getBoundingClientRect();
    // A real floating clone of the row follows the cursor — the "lifted" card.
    const el = row.cloneNode(true) as HTMLElement;
    Object.assign(el.style, {
      position: 'fixed', top: '0px', left: '0px', boxSizing: 'border-box',
      width: `${r.width}px`, height: `${r.height}px`, margin: '0',
      pointerEvents: 'none', opacity: '0.97', zIndex: '99999',
      borderRadius: '8px', boxShadow: '0 16px 34px rgba(0,0,0,0.6)',
      transform: `translate(${r.left}px, ${r.top}px)`, transition: 'none', willChange: 'transform',
    });
    document.body.appendChild(el);
    dragState.current = { key, offX: e.clientX - r.left, offY: e.clientY - r.top, overlay: el };
    document.body.style.setProperty('user-select', 'none');
    setDragKey(key);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  return (
    <>
      {ordered.map(it => (
        <CollapsibleSection
          key={it.key}
          rowRef={el => { if (el) rowRefs.current.set(it.key, el); else rowRefs.current.delete(it.key); }}
          title={it.title}
          open={it.open}
          onToggle={it.onToggle}
          dimmed={it.hidden}
          noToggle={it.noToggle}
          grip
          leftIcons={it.leftIcons}
          drag={{
            onGripPointerDown: e => startDrag(it.key, e),
            isDragging: dragKey === it.key,
          }}
        >
          {it.content}
        </CollapsibleSection>
      ))}
    </>
  );
}

export function TemplateEditorSettingsPanel({ settings, onChange, videoMode, isPosts, headlineOccupied, subheadlineOccupied, selectedImageBox, selectedFreeEl, selectedTextBox, onSelectFreeEl, onSelectImageBox, onSelectZoneLogo, onSelectTextBox, onSelectZoneSlot, onSetRichEditTarget, selectedZoneSlot, richEditTarget, textBoxAutoHeights, lockImageAspect = true, onLockImageAspectChange, richText, imageBoxBgState, imageBoxExpandState, onExpandImageBox, expandPreviewBoxId, onExpandPreview, perspectiveBoxId, onPerspectiveBox, perspectiveMode = 'distort', onPerspectiveMode }: TemplateEditorSettingsPanelProps) {
  const s = settings;
  const selectedZoneLogo = selectedZoneSlot?.kind === 'logo' ? selectedZoneSlot.index : null;
  // Every *element* island opens ⟺ its element is selected on the canvas (and toggling the island
  // drives that selection) — see the per-island open/onToggle below. This flag is true whenever any
  // element is selected, so the manual canvas-level accordion below collapses and only the selected
  // element's island stays open.
  const anyElementSelected =
    selectedImageBox != null || selectedFreeEl != null || selectedTextBox != null
    || selectedZoneSlot != null || richEditTarget != null;
  // Accordion for the manual canvas-level sections (Layout/Background/Fade/Canvas Colour/Dividers/
  // shared Quotation styles + row tag/quote slots, which have no canvas selection): at most one open
  // at a time. While an element is selected these all close, so the selection owns what's open.
  const [openManual, setOpenManual] = useState<string | null>(null);
  const openId = anyElementSelected ? null : openManual;
  const canvasColorInputRef = useRef<HTMLInputElement>(null);   // hidden native picker for the canvas colour swatch
  // Base sections (Logo / Layout / Fade / Background / Headline / Sub-headline) +
  // Tags: the full skeleton-era settings, shown in the merged editor.
  const SHOW_BASE_SECTIONS: boolean = true;

  // "Enable fade" reflects whether a fade is ACTUALLY rendering: un-hidden AND at least one of
  // bottom/top is on (the canvas draws the fade only when both hold). Mapping the master to just the
  // layer-hide left it claiming "on" while nothing showed.
  const fadeShowing = !s.fadeHidden && !!(s.showFade || s.showTopFade);

  // ── Draggable layer sections (fade + skeleton text) — rendered by <LayerSectionList>,
  //    which owns the order, lift-on-pickup and live FLIP shifting. ──────────────────────
  const baseLayerItems: LayerItem[] = [
    // Headline / sub-headline sections show ONLY when that text exists on the slide — i.e. there's a
    // real element on the canvas. An empty slide doesn't surface their settings here.
    ...(SHOW_BASE_SECTIONS && headlineOccupied ? [{
      key: 'headline', title: 'Headline · Skeleton', open: richEditTarget === 'headline', onToggle: (next: boolean) => onSetRichEditTarget?.(next ? 'headline' : null), hidden: !!s.headlineHidden, layerId: HEADLINE_LAYER_ID,
      leftIcons: <LayerEye hidden={!!s.headlineHidden} onToggle={() => onChange({ headlineHidden: !s.headlineHidden })} />,
      content: (
        <>
          <div className="flex items-center justify-between">
            <span className="text-caption text-fg-3">Color</span>
            <ColorField value={s.headlineColor ?? '#ffffff'} onChange={v => onChange({ headlineColor: v })} label="Headline color" />
          </div>
          <Slider label="Size"   value={s.fontSize}  min={1} max={MAX_FONT} unit="px" onChange={v => onChange({ fontSize: v })} />
          <Slider label="Letter spacing" value={s.lSpacing}  onChange={v => onChange({ lSpacing: v })} />
          <Slider label="Line spacing"   value={s.lHeight}   onChange={v => onChange({ lHeight: v })} />
          <FontDropdown value={s.fontLabel} onChange={v => onChange({ fontLabel: v })} />
          <WeightPicker fontLabel={s.fontLabel} value={s.fontWeight} onChange={w => onChange({ fontWeight: w })} className="flex gap-1 flex-wrap" />
          <StyleRow italic={s.italic} onItalic={() => onChange({ italic: !s.italic })} allCaps={s.allCaps} onAllCaps={() => onChange({ allCaps: !s.allCaps })} align={s.textAlign} onAlign={v => onChange({ textAlign: v })} />
          {s.headlineSpans && s.headlineSpans.length > 0 && (
            <button onClick={() => onChange({ headlineSpans: null })} className="w-full flex items-center gap-1.5 text-left text-caption text-fg-2 hover:text-fg focus-ring rounded-sm transition-colors py-0.5">
              <CloseIcon size={12} aria-hidden /> Clear custom text styles
            </button>
          )}
          <ShadowEditor value={s.headlineShadow} onChange={v => onChange({ headlineShadow: v })} />
        </>
      ),
    }] : []),
    ...(SHOW_BASE_SECTIONS && subheadlineOccupied ? [{
      key: 'sub', title: 'Sub-headline · Skeleton', open: richEditTarget === 'sub', onToggle: (next: boolean) => onSetRichEditTarget?.(next ? 'sub' : null), hidden: !!s.subHidden, layerId: SUB_LAYER_ID,
      leftIcons: <LayerEye hidden={!!s.subHidden} onToggle={() => onChange({ subHidden: !s.subHidden })} />,
      content: (
        <>
          <div className="flex items-center justify-between">
            <span className="text-caption text-fg-3">Color</span>
            <ColorField value={s.subheadlineColor ?? '#ffffff'} onChange={v => onChange({ subheadlineColor: v })} label="Sub-headline color" />
          </div>
          <Slider label="Size"   value={s.subFontSize}  min={1} max={SUB_MAX} unit="px" onChange={v => onChange({ subFontSize: v })} />
          <Slider label="Letter spacing" value={s.subLSpacing}  onChange={v => onChange({ subLSpacing: v })} />
          <Slider label="Line spacing"   value={s.subLHeight}   onChange={v => onChange({ subLHeight: v })} />
          <FontDropdown value={s.subFontLabel} onChange={v => onChange({ subFontLabel: v })} />
          <WeightPicker fontLabel={s.subFontLabel} value={s.subFontWeight} onChange={w => onChange({ subFontWeight: w })} className="flex gap-1 flex-wrap" />
          <StyleRow italic={s.subItalic} onItalic={() => onChange({ subItalic: !s.subItalic })} allCaps={s.subAllCaps} onAllCaps={() => onChange({ subAllCaps: !s.subAllCaps })} align={s.subTextAlign} onAlign={v => onChange({ subTextAlign: v })} />
          {s.subSpans && s.subSpans.length > 0 && (
            <button onClick={() => onChange({ subSpans: null })} className="w-full flex items-center gap-1.5 text-left text-caption text-fg-2 hover:text-fg focus-ring rounded-sm transition-colors py-0.5">
              <CloseIcon size={12} aria-hidden /> Clear custom text styles
            </button>
          )}
          <ShadowEditor value={s.subShadow} onChange={v => onChange({ subShadow: v })} />
        </>
      ),
    }] : []),
    {
      key: 'fade', title: 'Fade', open: openId === 'fade', onToggle: (next: boolean) => setOpenManual(next ? 'fade' : null), hidden: !!s.fadeHidden, layerId: FADE_LAYER_ID,
      leftIcons: <LayerEye hidden={!!s.fadeHidden} onToggle={() => onChange({ fadeHidden: !s.fadeHidden })} />,
      content: (
        <>
          {/* Master enable — drives ACTUAL fade visibility, not just the layer-hide: turning it on
              un-hides the fade AND switches on the bottom fade if neither bottom nor top is active, so
              it always produces a visible result; turning it off hides the fade but keeps the
              bottom/top values for next time. */}
          <div className="flex items-center justify-between">
            <span className="text-caption text-fg-2">Enable fade</span>
            <Switch
              checked={fadeShowing}
              onChange={() => {
                if (fadeShowing) onChange({ fadeHidden: true });
                else if (!s.showFade && !s.showTopFade) onChange({ fadeHidden: false, showFade: true });
                else onChange({ fadeHidden: false });
              }}
              label="Enable fade"
            />
          </div>
          {fadeShowing && (
          <>
          {/* Bottom fade */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-caption text-fg-2">Bottom fade</span>
              <Switch checked={s.showFade} onChange={() => onChange({ showFade: !s.showFade })} label="Bottom fade" />
            </div>
            {s.showFade && (
              <>
                <Slider label="Floor"     value={s.fadeFloor}     onChange={v => onChange({ fadeFloor: v })} />
                <Slider label="Reach"     value={s.fadeReach}     onChange={v => onChange({ fadeReach: v })} />
                <Slider label="Intensity" value={s.fadeIntensity} onChange={v => onChange({ fadeIntensity: v })} />
              </>
            )}
          </div>
          <div className="h-px bg-line my-1" />
          {/* Top fade */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-caption text-fg-2">Top fade</span>
              <Switch checked={s.showTopFade} onChange={() => onChange({ showTopFade: !s.showTopFade })} label="Top fade" />
            </div>
            {s.showTopFade && (
              <>
                <Slider label="Floor"     value={s.topFadeFloor     ?? 20} onChange={v => onChange({ topFadeFloor: v })} />
                <Slider label="Reach"     value={s.topFadeReach     ?? 40} onChange={v => onChange({ topFadeReach: v })} />
                <Slider label="Intensity" value={s.topFadeIntensity ?? 85} onChange={v => onChange({ topFadeIntensity: v })} />
              </>
            )}
          </div>
          </>
          )}
        </>
      ),
    },
    // Logo (free elements) — one draggable + hideable layer island per logo on the canvas.
    // Lives in the layer list so it reorders (z-order) and hides like the other layers; selection
    // just focuses/opens it.
    ...(s.freeElements ?? []).flatMap((el, i): LayerItem[] => {
      // Every free element (tag / quote / swipe / logo / divider / custom) is a draggable + hideable layer row.
      // Shared row plumbing (id/hidden live on the FreeElement base, so these are kind-agnostic):
      const removeEl = () => {
        const arr = [...(s.freeElements ?? [])];
        arr.splice(i, 1);
        onChange({ freeElements: arr });
      };
      const toggleHidden = () => {
        const arr = [...(s.freeElements ?? [])];
        const cur = arr[i];
        if (!cur) return;
        arr[i] = { ...cur, hidden: !cur.hidden };
        onChange({ freeElements: arr });
      };
      // open ⟺ selected on the canvas: clicking the header selects/deselects the element.
      const open = selectedFreeEl === i;
      const onToggle = (next: boolean) => onSelectFreeEl?.(next ? i : null);
      const eye = <LayerEye hidden={!!el.hidden} onToggle={toggleHidden} />;
      const base = { layerId: el.id, hidden: !!el.hidden, open, onToggle, leftIcons: eye };

      if (el.kind === 'logo') {
        const patchLogo = (p: { opacity?: number; scale?: number; cornerRadius?: number; shape?: 'rect' | 'circle'; shadow?: ShadowStyle }) => {
          const arr = [...(s.freeElements ?? [])];
          const cur = arr[i];
          if (cur?.kind !== 'logo') return;
          arr[i] = { ...cur, ...p };
          onChange({ freeElements: arr });
        };
        const logos = (s.freeElements ?? []).filter(e => e.kind === 'logo');
        const isCircle = (el.shape ?? s.logoShape) === 'circle';
        return [{
          key: `logo-free-${el.id}`, title: logos.length > 1 ? `Logo ${logos.indexOf(el) + 1}` : 'Logo', ...base,
          content: (
            <>
              <Slider label="Opacity"       value={el.opacity ?? s.logoOpacity ?? 100}        min={0}  max={100} unit="%" onChange={v => patchLogo({ opacity: v })} />
              <Slider label="Scale"         value={el.scale ?? s.logoScale ?? 100}            min={10} max={200} unit="%" onChange={v => patchLogo({ scale: v })} />
              <div className="flex items-center justify-between">
                <span className="text-caption text-fg-2">Crop to circle</span>
                <Switch label="Crop logo to circle" checked={isCircle} onChange={v => patchLogo({ shape: v ? 'circle' : 'rect' })} />
              </div>
              {!isCircle && (
                <Slider label="Corner Radius" value={el.cornerRadius ?? s.logoCornerRadius ?? 0} min={0}  max={200} unit="px" onChange={v => patchLogo({ cornerRadius: v })} />
              )}
              <ShadowEditor value={el.shadow ?? s.logoShadow} onChange={v => patchLogo({ shadow: v })} showLift={false} />
            </>
          ),
        }];
      }
      if (el.kind === 'tag') {
        const title = (el.text || 'Tag').split('\n')[0].slice(0, 22) || 'Tag';
        return [{
          key: `tag-free-${el.id}`, title, ...base,
          content: (
            <TagSlotEditor embedded idx={i} label="Freeform" tagSlot={{ text: el.text, style: el.style }}
              onChange={ns => { const arr = [...(s.freeElements ?? [])]; const c = arr[i]; if (c?.kind !== 'tag') return; arr[i] = { ...c, text: ns.text, style: ns.style }; onChange({ freeElements: arr }); }}
              onRemove={removeEl} />
          ),
        }];
      }
      if (el.kind === 'divider') {
        return [{
          key: `divider-free-${el.id}`, title: 'Divider', ...base,
          content: (
            <DividerSlotEditor embedded idx={i} divId={el.dividerId} ds={el.settings ?? null} subSlot={el.sub ?? null}
              onChange={ds => { const arr = [...(s.freeElements ?? [])]; const c = arr[i]; if (c?.kind !== 'divider') return; arr[i] = { ...c, settings: ds }; onChange({ freeElements: arr }); }}
              onSubChange={sub => { const arr = [...(s.freeElements ?? [])]; const c = arr[i]; if (c?.kind !== 'divider') return; arr[i] = { ...c, sub }; onChange({ freeElements: arr }); }}
              onRemove={removeEl} />
          ),
        }];
      }
      if (el.kind === 'swipe') {
        return [{
          key: `swipe-free-${el.id}`, title: 'Swipe', ...base,
          content: (
            <SwipeZoneEditor embedded fi={0} style={el.style}
              onChange={st => { const arr = [...(s.freeElements ?? [])]; const c = arr[i]; if (c?.kind !== 'swipe') return; arr[i] = { ...c, style: st }; onChange({ freeElements: arr }); }}
              onRemove={removeEl} />
          ),
        }];
      }
      if (el.kind === 'custom') {
        return [{
          key: `custom-free-${el.id}`, title: el.name || 'Element', ...base,
          content: (
            <div className="flex flex-col gap-2">
              <p className="text-caption text-fg-3">Position &amp; size this element directly on the canvas.</p>
              <Button variant="danger" size="sm" fullWidth onClick={removeEl}>Remove element</Button>
            </div>
          ),
        }];
      }
      // quote — just a style reference; position/size live on the canvas, so the row is drag + hide + remove.
      return [{
        key: `quote-free-${el.id}`, title: 'Quotation Mark', ...base,
        content: (
          <div className="flex flex-col gap-2">
            <p className="text-caption text-fg-3">Position &amp; size this quotation mark directly on the canvas.</p>
            <Button variant="danger" size="sm" fullWidth onClick={removeEl}>Remove quote</Button>
          </div>
        ),
      }];
    }),
    // Zone/grid logos — one draggable + hideable layer per filled slot. The grid still fixes WHERE
    // the logo sits; the layer list controls its stacking (z-order) + hide, like every other layer.
    ...(s.zoneLogoSlots ?? []).flatMap((slot, fi): LayerItem[] => {
      if (!slot) return [];
      const cur: { opacity?: number; scale?: number; cornerRadius?: number; shape?: 'rect' | 'circle'; shadow?: ShadowStyle; hidden?: boolean } = (s.zoneLogoStyles ?? [])[fi] ?? {};
      const patchLogo = (p: { opacity?: number; scale?: number; cornerRadius?: number; shape?: 'rect' | 'circle'; shadow?: ShadowStyle }) => {
        const arr = [...(s.zoneLogoStyles ?? Array(9).fill(null))];
        arr[fi] = { ...(arr[fi] ?? {}), ...p };
        onChange({ zoneLogoStyles: arr });
      };
      const title = `${zoneLabel(fi)} · Skeleton`;
      return [{
        key: `logo-zone-${fi}`,
        title,
        layerId: `zonelogo-${fi}`,
        hidden: !!cur.hidden,
        open: selectedZoneLogo === fi,
        onToggle: (next: boolean) => onSelectZoneLogo?.(next ? fi : null),
        leftIcons: (
          <LayerEye hidden={!!cur.hidden} onToggle={() => {
            const arr = [...(s.zoneLogoStyles ?? Array(9).fill(null))];
            arr[fi] = { ...(arr[fi] ?? {}), hidden: !(arr[fi]?.hidden) };
            onChange({ zoneLogoStyles: arr });
          }} />
        ),
        content: (
          <>
            <Slider label="Opacity"       value={cur.opacity ?? s.logoOpacity ?? 100}        min={0}  max={100} unit="%" onChange={v => patchLogo({ opacity: v })} />
            <Slider label="Scale"         value={cur.scale ?? s.logoScale ?? 100}            min={10} max={200} unit="%" onChange={v => patchLogo({ scale: v })} />
            <div className="flex items-center justify-between">
              <span className="text-caption text-fg-2">Crop to circle</span>
              <Switch label="Crop logo to circle" checked={(cur.shape ?? s.logoShape) === 'circle'} onChange={v => patchLogo({ shape: v ? 'circle' : 'rect' })} />
            </div>
            {(cur.shape ?? s.logoShape) !== 'circle' && (
              <Slider label="Corner Radius" value={cur.cornerRadius ?? s.logoCornerRadius ?? 0} min={0}  max={200} unit="px" onChange={v => patchLogo({ cornerRadius: v })} />
            )}
            <ShadowEditor value={cur.shadow ?? s.logoShadow} onChange={v => patchLogo({ shadow: v })} showLift={false} />
          </>
        ),
      }];
    }),
  ];

  // Image / Video / Overlay boxes — draggable layer rows in the shared list (z-order via the grip),
  // hoisted out of the standalone islands below. Content is the same image card, just wrapped as a
  // LayerItem so it sorts/reorders with every other layer. Closes over the panel scope (no prop drilling).
  const imageBoxLayerItems: LayerItem[] = (s.imageBoxes ?? []).flatMap((b, i): LayerItem[] => {
    const patchBox = (p: Partial<ImageBox>) => {
      const boxes = [...(s.imageBoxes ?? [])];
      if (!boxes[i]) return;
      boxes[i] = { ...boxes[i], ...p };
      onChange({ imageBoxes: boxes });
    };
    const removeBox = () => {
      const boxes = [...(s.imageBoxes ?? [])];
      boxes.splice(i, 1);
      onChange({ imageBoxes: boxes });
    };
    const open = selectedImageBox === i;
    const onToggle = (next: boolean) => onSelectImageBox?.(next ? i : null);
    if (b.isOverlay) {
      return [{
        key: `imgbox-${i}`, layerId: b.id, title: 'Overlay', open, onToggle,
        hidden: !!b.hidden,
        leftIcons: <LayerEye hidden={!!b.hidden} onToggle={() => patchBox({ hidden: !b.hidden })} />,
        content: (
          <Slider label="Opacity" value={b.opacity ?? 100} min={0} max={100} unit="%" onChange={v => patchBox({ opacity: v })} />
        ),
      }];
    }
    const maxRadius = Math.max(1, Math.round(Math.min(b.width, b.height) / 2));
    return [{
      key: `imgbox-${i}`, layerId: b.id, title: b.videoUrl ? 'Video' : 'Image', open, onToggle,
      hidden: !!b.hidden,
      leftIcons: <LayerEye hidden={!!b.hidden} onToggle={() => patchBox({ hidden: !b.hidden })} />,
      content: (
        <>
          {(() => {
            const aspect = (b.crop ? (b.width / b.height) : b.aspect) || (b.width / b.height) || 1;
            const IN = "w-16 bg-surface-1 border border-line focus-visible:border-line-strong rounded-md px-1.5 py-1 text-caption text-fg focus-ring";
            const commitW = (n: number) => lockImageAspect
              ? (w => patchBox({ width: w, height: w / aspect }))(Math.max(1, Math.min(CAROUSEL_W, CAROUSEL_H * aspect, n)))
              : patchBox({ width: Math.max(1, Math.min(CAROUSEL_W, n)) });
            const commitH = (n: number) => lockImageAspect
              ? (h => patchBox({ height: h, width: h * aspect }))(Math.max(1, Math.min(CAROUSEL_H, CAROUSEL_W / aspect, n)))
              : patchBox({ height: Math.max(1, Math.min(CAROUSEL_H, n)) });
            return (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-caption text-fg-2 shrink-0 w-12">Size</span>
                  <label className="flex items-center gap-1 text-caption text-fg-3">
                    W
                    <DimInput key={`w-${b.id}`} value={b.width} min={1} max={CAROUSEL_W} onCommit={commitW} className={IN} />
                  </label>
                  <label className="flex items-center gap-1 text-caption text-fg-3">
                    H
                    <DimInput key={`h-${b.id}`} value={b.height} min={1} max={CAROUSEL_H} onCommit={commitH} className={IN} />
                  </label>
                  <span className="text-caption text-fg-3">px</span>
                  <button
                    onClick={() => onLockImageAspectChange?.(!lockImageAspect)}
                    title={lockImageAspect ? 'Aspect ratio locked — click to unlock' : 'Aspect ratio unlocked — click to lock'}
                    className={`ml-auto shrink-0 w-6 h-6 rounded-md flex items-center justify-center focus-ring transition-colors ${
                      lockImageAspect ? 'bg-action text-action-fg' : 'bg-surface-2 border border-line text-fg-3 hover:text-fg'
                    }`}
                  >
                    <LinkIcon size={13} aria-hidden />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-caption text-fg-2 shrink-0 w-12">Position</span>
                  <label className="flex items-center gap-1 text-caption text-fg-3">
                    X
                    <DimInput key={`x-${b.id}`} value={b.x} min={0} max={CAROUSEL_W} onCommit={n => patchBox({ x: Math.max(0, Math.min(CAROUSEL_W, n)) })} className={IN} />
                  </label>
                  <label className="flex items-center gap-1 text-caption text-fg-3">
                    Y
                    <DimInput key={`y-${b.id}`} value={b.y} min={0} max={CAROUSEL_H} onCommit={n => patchBox({ y: Math.max(0, Math.min(CAROUSEL_H, n)) })} className={IN} />
                  </label>
                  <span className="text-caption text-fg-3">px</span>
                </div>
              </>
            );
          })()}
          <Slider label="Opacity"       value={b.opacity ?? 100} min={0} max={100} unit="%" onChange={v => patchBox({ opacity: v })} />
          <div className="flex items-center justify-between">
            <span className="text-caption text-fg-2">Crop to circle</span>
            <Switch label="Crop image to circle" checked={b.shape === 'circle'} onChange={v => patchBox({ shape: v ? 'circle' : 'rect' })} />
          </div>
          {b.shape === 'circle' ? (
            <div className="flex items-center justify-between gap-2">
              <p className="text-caption text-fg-4 leading-snug">Double-click the image on the canvas to reframe — drag to reposition, scroll to zoom.</p>
              {b.circleCrop && <button type="button" className="shrink-0 text-caption text-accent hover:underline" onClick={() => patchBox({ circleCrop: undefined })}>Reset</button>}
            </div>
          ) : (
            <Slider label="Corner Radius" value={Math.min(b.cornerRadius ?? 0, maxRadius)} min={0} max={maxRadius} unit="px" onChange={v => patchBox({ cornerRadius: v })} />
          )}
          {isPosts && !videoMode && !b.videoUrl && (
            <>
              <Slider label="Darken" value={s.bgDarkenAmount} min={0} max={100} onChange={v => onChange({ bgDarkenAmount: v })} />
              {s.bgBlurEnabled && (
                <Slider label="Blur Amount" value={s.bgBlurAmount} min={1} max={30} unit="px" onChange={v => onChange({ bgBlurAmount: v })} />
              )}
            </>
          )}
          {/* Expand image (BRIA) — gated off via EXPAND_IMAGE_ENABLED (shared paid key, kept hidden). */}
          {EXPAND_IMAGE_ENABLED && onExpandImageBox && (() => {
            const status = imageBoxExpandState?.[b.id];
            const busy = status === 'processing';
            const previewing = expandPreviewBoxId === b.id;
            return (
              <div className="flex flex-col gap-2 pt-1">
                <div className="flex items-center justify-between">
                  <span className="text-caption text-fg-2">Expand to fill slide</span>
                  {!previewing ? (
                    <Button size="sm" variant="secondary" onClick={() => onExpandPreview?.(b.id)} disabled={busy} title="Preview & adjust the area BRIA will fill, then generate">
                      Expand…
                    </Button>
                  ) : (
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => onExpandPreview?.(null)} disabled={busy}>Cancel</Button>
                      <Button size="sm" variant="primary" onClick={() => onExpandImageBox(b.id)} disabled={busy}>{busy ? 'Generating…' : 'Generate'}</Button>
                    </div>
                  )}
                </div>
                {status === 'error' && (<span className="text-caption text-danger-text">Couldn’t expand the image — try again.</span>)}
                {previewing && status !== 'error' && (<span className="text-caption text-fg-3 leading-relaxed">Drag/resize the image on the canvas — the shaded area is what AI (BRIA) will generate. Then Generate.</span>)}
                {!previewing && status !== 'error' && (<span className="text-caption text-fg-3 leading-relaxed">Fills the canvas around the image using AI (BRIA), based on where you place it.</span>)}
              </div>
            );
          })()}
          {onPerspectiveBox && (() => {
            const editing = perspectiveBoxId === b.id;
            const p = b.perspective;
            const hasPersp = !!p && [p.tl, p.tr, p.br, p.bl].some(c => (c.x || 0) !== 0 || (c.y || 0) !== 0);
            const MODES: { id: PerspectiveMode; label: string; hint: string }[] = [
              { id: 'distort',     label: 'Distort',     hint: 'Each corner moves freely.' },
              { id: 'perspective', label: 'Perspective', hint: 'The same-edge corner mirrors — symmetric trapezoid.' },
              { id: 'skew',        label: 'Skew',        hint: 'The edge slides — parallelogram.' },
            ];
            return (
              <div className="flex flex-col gap-2 pt-1">
                <div className="flex items-center justify-between">
                  <span className="text-caption text-fg-2">Perspective</span>
                  <button
                    onClick={() => onPerspectiveBox(editing ? null : b.id)}
                    title="Drag the four corners on the canvas to warp the image"
                    className={`px-2 h-6 rounded-md text-caption focus-ring transition-colors ${editing ? 'bg-action text-action-fg' : 'bg-surface-2 border border-line text-fg-2 hover:text-fg hover:border-line-strong'}`}
                  >
                    {editing ? 'Done' : 'Edit corners…'}
                  </button>
                </div>
                {editing && (
                  <>
                    <div className="flex items-center gap-1">
                      {MODES.map(m => (
                        <button
                          key={m.id}
                          onClick={() => onPerspectiveMode?.(m.id)}
                          className={`flex-1 px-1 h-6 rounded-md text-caption focus-ring transition-colors ${perspectiveMode === m.id ? 'bg-action text-action-fg' : 'bg-surface-2 border border-line text-fg-3 hover:text-fg'}`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                    <span className="text-caption text-fg-3 leading-relaxed">
                      Drag the four corner dots on the canvas. {MODES.find(m => m.id === perspectiveMode)?.hint}
                    </span>
                  </>
                )}
                {hasPersp && (
                  <button onClick={() => patchBox({ perspective: undefined })} className="self-start px-2 h-6 rounded-md text-caption bg-surface-2 border border-line text-fg-3 hover:text-fg focus-ring transition-colors">
                    Reset perspective
                  </button>
                )}
              </div>
            );
          })()}
          {(() => {
            const fg = b.fgEffects ?? {};
            const bg = b.bgEffects ?? {};
            const setFg = (p: Partial<ImageEffects>) => patchBox({ fgEffects: { ...fg, ...p } });
            const setBg = (p: Partial<ImageEffects>) => patchBox({ bgEffects: { ...bg, ...p } });
            const status  = imageBoxBgState?.[b.id];
            const enabled = !!b.splitEnabled;
            return (
              <div className="flex flex-col gap-2 pt-1">
                <span className="text-caption font-semibold text-fg-3 uppercase tracking-wider">{enabled ? 'Foreground' : 'Adjust'}</span>
                <Slider label="Brightness" value={fg.brightness ?? 0} min={-100} max={100} unit="%"  onChange={v => setFg({ brightness: v })} />
                <Slider label="Blur"       value={fg.blur ?? 0}       min={0}    max={40}  unit="px" onChange={v => setFg({ blur: v })} />
                <div className="flex items-center justify-between">
                  <span className="text-caption text-fg-2">Fade blurred edges</span>
                  <Switch checked={!!fg.blurEdgeFade} onChange={() => setFg({ blurEdgeFade: !fg.blurEdgeFade })} label="Fade blurred edges (foreground)" />
                </div>
                <Slider label="Noise"      value={fg.noise ?? 0}      min={0}    max={100} unit="%"  onChange={v => setFg({ noise: v })} />
                <ImageFadeControls fade={b.fade} onChange={next => patchBox({ fade: next })} />
                <div className="flex items-center justify-between pt-1">
                  <span className="text-caption text-fg-2">Detect background</span>
                  <Switch checked={enabled} onChange={() => patchBox({ splitEnabled: !enabled })} label="Separate the subject from the background so each can be adjusted independently" />
                </div>
                {enabled && status === 'processing' && (<span className="text-caption text-fg-3">Separating subject…</span>)}
                {enabled && status === 'error' && (<span className="text-caption text-danger-text">Couldn’t separate the subject — try a different image.</span>)}
                {enabled && status !== 'processing' && status !== 'error' && (
                  <>
                    <span className="text-caption font-semibold text-fg-3 uppercase tracking-wider pt-1">Background</span>
                    <Slider label="Brightness" value={bg.brightness ?? 0} min={-100} max={100} unit="%"  onChange={v => setBg({ brightness: v })} />
                    <Slider label="Blur"       value={bg.blur ?? 0}       min={0}    max={40}  unit="px" onChange={v => setBg({ blur: v })} />
                    <div className="flex items-center justify-between">
                      <span className="text-caption text-fg-2">Fade blurred edges</span>
                      <Switch checked={!!bg.blurEdgeFade} onChange={() => setBg({ blurEdgeFade: !bg.blurEdgeFade })} label="Fade blurred edges (background)" />
                    </div>
                    <Slider label="Noise"      value={bg.noise ?? 0}      min={0}    max={100} unit="%"  onChange={v => setBg({ noise: v })} />
                    <ImageFadeControls fade={b.bgFade} onChange={next => patchBox({ bgFade: next })} />
                  </>
                )}
              </div>
            );
          })()}
          <ShadowEditor value={b.shadow} onChange={v => patchBox({ shadow: v })} showLift={false} />
          <Button variant="danger" size="sm" fullWidth onClick={removeBox} className="mt-1">Remove image</Button>
        </>
      ),
    }];
  });

  // Text boxes as draggable, hideable layer rows (the row owns grip/title/eye/collapse; TextBoxEditor is the body).
  const textBoxLayerItems: LayerItem[] = (s.textBoxes ?? []).map((tb, idx): LayerItem => {
    const updateTb = (next: TextBoxStyle) => {
      const arr = [...(s.textBoxes ?? [])];
      arr[idx] = next;
      onChange({ textBoxes: arr });
    };
    const removeTb = () => {
      const arr = [...(s.textBoxes ?? [])];
      arr.splice(idx, 1);
      onChange({ textBoxes: arr });
    };
    const preview = (tb.text || 'Text').split('\n')[0] || 'Text';
    return {
      key: tb.id, layerId: tb.id, title: tb.label ?? preview,
      hidden: !!tb.hidden,
      open: selectedTextBox === idx || richText?.activeBox === idx,   // open ⟺ box selected (or being rich-edited) on canvas
      onToggle: (next: boolean) => onSelectTextBox?.(next ? idx : null),
      leftIcons: <LayerEye hidden={!!tb.hidden} onToggle={() => updateTb({ ...tb, hidden: !tb.hidden })} />,
      content: <TextBoxEditor idx={idx} tb={tb} rich={richText && richText.activeBox === idx ? richText : undefined} onChange={updateTb} onRemove={removeTb} autoHeight={textBoxAutoHeights?.[tb.id]} />,
    };
  });

  // Skeleton tag / quote / swipe slots as draggable + hideable layer rows — parity with zone logos and
  // free elements. The grip drives z-order (via layerId → layerOrderIds); the eye toggles the per-slot
  // hidden flag; the body is the same editor used elsewhere. Row-aligned slots (3) and 3×3 zone slots (9).
  const rowName = (i: number) => (['Top', 'Middle', 'Bottom'][i] ?? `Row ${i + 1}`);
  const toggleSlotHidden = (arr: (boolean | null)[] | undefined, i: number, write: (next: (boolean | null)[]) => void, len: number) => {
    const cur = [...(arr ?? Array(len).fill(null))];
    while (cur.length <= i) cur.push(null);
    cur[i] = !cur[i];
    write(cur);
  };
  const tagSlotItems = (slots: ({ text: string; style: TagStyle } | null)[] | undefined, hidden: (boolean | null)[] | undefined, zone: boolean): LayerItem[] =>
    (slots ?? []).flatMap((slot, i): LayerItem[] => {
      if (!slot) return [];
      const id = zone ? `zonetag-${i}` : `rowtag-${i}`;
      const isHidden = !!hidden?.[i];
      const writeSlots  = (next: ({ text: string; style: TagStyle } | null)[]) => onChange(zone ? { tagZoneSlots: next } : { tagSlots: next });
      const writeHidden = (next: (boolean | null)[]) => onChange(zone ? { tagZoneHidden: next } : { tagSlotsHidden: next });
      return [{
        key: id, layerId: id, title: `${zone ? zoneLabel(i) : rowName(i)} · Tag`,
        hidden: isHidden, open: zone ? (selectedZoneSlot?.kind === 'tag' && selectedZoneSlot.index === i) : openId === id, onToggle: zone ? (next: boolean) => onSelectZoneSlot?.('tag', next ? i : null) : (next: boolean) => setOpenManual(next ? id : null),
        leftIcons: <LayerEye hidden={isHidden} onToggle={() => toggleSlotHidden(hidden, i, writeHidden, zone ? 9 : 3)} />,
        content: (
          <TagSlotEditor embedded idx={i} label={zone ? 'Zone' : 'Row'} tagSlot={slot}
            onChange={ns => { const arr = [...(slots ?? [])]; arr[i] = { text: ns.text, style: ns.style }; writeSlots(arr); }}
            onRemove={() => {
              const arr = [...(slots ?? [])]; arr[i] = null;
              const h = [...(hidden ?? [])]; if (h.length > i) h[i] = null;
              onChange(zone ? { tagZoneSlots: arr, tagZoneHidden: h } : { tagSlots: arr, tagSlotsHidden: h });
            }} />
        ),
      }];
    });
  const quoteSlotItems = (slots: (string | null)[] | undefined, hidden: (boolean | null)[] | undefined, zone: boolean): LayerItem[] =>
    (slots ?? []).flatMap((slot, i): LayerItem[] => {
      if (!slot) return [];
      const id = zone ? `zonequote-${i}` : `rowquote-${i}`;
      const isHidden = !!hidden?.[i];
      const writeHidden = (next: (boolean | null)[]) => onChange(zone ? { quoteZoneHidden: next } : { quoteSlotsHidden: next });
      const removeSlot = () => {
        const arr = [...(slots ?? [])]; arr[i] = null;
        const h = [...(hidden ?? [])]; if (h.length > i) h[i] = null;
        onChange(zone ? { quoteZoneSlots: arr, quoteZoneHidden: h } : { quoteSlots: arr, quoteSlotsHidden: h });
      };
      return [{
        key: id, layerId: id, title: `${zone ? zoneLabel(i) : rowName(i)} · Quote`,
        hidden: isHidden, open: zone ? (selectedZoneSlot?.kind === 'quote' && selectedZoneSlot.index === i) : openId === id, onToggle: zone ? (next: boolean) => onSelectZoneSlot?.('quote', next ? i : null) : (next: boolean) => setOpenManual(next ? id : null),
        leftIcons: <LayerEye hidden={isHidden} onToggle={() => toggleSlotHidden(hidden, i, writeHidden, zone ? 9 : 3)} />,
        content: (
          <div className="flex flex-col gap-2">
            <p className="text-caption text-fg-3">Pick this quotation mark&apos;s style in the Quotation panel; it stays in its skeleton slot.</p>
            <Button variant="danger" size="sm" fullWidth onClick={removeSlot}>Remove quote</Button>
          </div>
        ),
      }];
    });
  const swipeSlotItems: LayerItem[] = (s.swipeZoneSlots ?? []).flatMap((slot, i): LayerItem[] => {
    if (!slot) return [];
    const id = `zoneswipe-${i}`;
    const isHidden = !!s.swipeZoneHidden?.[i];
    return [{
      key: id, layerId: id, title: `${zoneLabel(i)} · Swipe`,
      hidden: isHidden, open: selectedZoneSlot?.kind === 'swipe' && selectedZoneSlot.index === i, onToggle: (next: boolean) => onSelectZoneSlot?.('swipe', next ? i : null),
      leftIcons: <LayerEye hidden={isHidden} onToggle={() => toggleSlotHidden(s.swipeZoneHidden, i, next => onChange({ swipeZoneHidden: next }), 9)} />,
      content: (
        <SwipeZoneEditor embedded fi={i} style={slot}
          onChange={st => { const arr = [...(s.swipeZoneSlots ?? [])]; arr[i] = st; onChange({ swipeZoneSlots: arr }); }}
          onRemove={() => {
            const arr = [...(s.swipeZoneSlots ?? [])]; arr[i] = null;
            const h = [...(s.swipeZoneHidden ?? [])]; if (h.length > i) h[i] = null;
            onChange({ swipeZoneSlots: arr, swipeZoneHidden: h });
          }} />
      ),
    }];
  });
  const skeletonSlotLayerItems: LayerItem[] = [
    ...tagSlotItems(s.tagSlots, s.tagSlotsHidden, false),
    ...tagSlotItems(s.tagZoneSlots, s.tagZoneHidden, true),
    ...quoteSlotItems(s.quoteSlots, s.quoteSlotsHidden, false),
    ...quoteSlotItems(s.quoteZoneSlots, s.quoteZoneHidden, true),
    ...swipeSlotItems,
  ];

  return (
    <div className="flex flex-col h-full bg-transparent">

      {/* Scrollable sections — vertically centred when they fit; scroll from the top if taller */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col [justify-content:safe_center]">
      <div className="flex flex-col gap-3 px-3 py-3">

      {/* Draggable layer sections. Lift to pick up; the rest shift live. Reordering drives the canvas
          z-order: panel top = front. Headline / Sub / Fade are each their own layer now, so the panel
          order maps straight to layerOrderIds (reversed = bottom→top). Any other layers already in the
          order (element boxes, the skeleton's boxed overlays) keep their relative order, tucked just
          in front of the fade. */}
      <LayerSectionList
        items={[...baseLayerItems, ...skeletonSlotLayerItems, ...imageBoxLayerItems, ...textBoxLayerItems]}
        order={[...orderedLayerIds(s.imageBoxes ?? [], s.textBoxes ?? [], s.freeElements ?? [], s.layerOrderIds, !!(s.showFade || s.showTopFade), true, s.zoneLogoSlots, { tagSlots: s.tagSlots, quoteSlots: s.quoteSlots, tagZoneSlots: s.tagZoneSlots, quoteZoneSlots: s.quoteZoneSlots, swipeZoneSlots: s.swipeZoneSlots })].reverse().map(l => l.id)}
        onOrderChange={ftb => {
          const reversed = [...ftb].reverse();   // panel front→back → layerOrderIds bottom→top
          const others = (s.layerOrderIds ?? []).filter(id => !ftb.includes(id));
          const fi = reversed.indexOf(FADE_LAYER_ID);
          onChange({
            layerOrderIds: fi >= 0
              ? [...reversed.slice(0, fi + 1), ...others, ...reversed.slice(fi + 1)]
              : [...others, ...reversed],
          });
        }}
      />

      {/* Slide-background Darken/Blur moved into the per-image "Image" card below (no longer a standalone island). */}

      {/* Zone/grid logos now render in the draggable layer group above (baseLayerItems). */}

      {/* Image / Video boxes now render as draggable rows in the LayerSectionList above (imageBoxLayerItems).
          The old per-box island map is kept but disabled (empty source) until the new rows are verified;
          it will be removed in the cleanup step. */}
      {([] as ImageBox[]).map((b, i) => {
        const patchBox = (p: Partial<ImageBox>) => {
          const boxes = [...(s.imageBoxes ?? [])];
          if (!boxes[i]) return;
          boxes[i] = { ...boxes[i], ...p };
          onChange({ imageBoxes: boxes });
        };
        const removeBox = () => {
          const boxes = [...(s.imageBoxes ?? [])];
          boxes.splice(i, 1);
          onChange({ imageBoxes: boxes });
        };
        // Overlay textures are full-canvas Screen-blend layers — only expose Opacity
        // (blend stays 'screen' in code, no blend picker). Manage/delete via the Layers panel.
        if (b.isOverlay) {
          return (
            <CollapsibleSection key={`imgbox-${i}`} title="Overlay" open={selectedImageBox === i} onToggle={next => onSelectImageBox?.(next ? i : null)}>
              <Slider label="Opacity" value={b.opacity ?? 100} min={0} max={100} unit="%" onChange={v => patchBox({ opacity: v })} />
            </CollapsibleSection>
          );
        }
        const maxRadius = Math.max(1, Math.round(Math.min(b.width, b.height) / 2));
        return (
          <CollapsibleSection key={`imgbox-${i}`} title={b.videoUrl ? 'Video' : 'Image'} open={selectedImageBox === i} onToggle={next => onSelectImageBox?.(next ? i : null)}>
            {(() => {
              const aspect = (b.crop ? (b.width / b.height) : b.aspect) || (b.width / b.height) || 1;
              const IN = "w-16 bg-surface-1 border border-line focus-visible:border-line-strong rounded-md px-1.5 py-1 text-caption text-fg focus-ring";
              // Locked: clamp the typed dimension to the joint canvas bounds, then derive
              // the other at FULL precision (no rounding, no min-floor) so the ratio holds exactly.
              const commitW = (n: number) => lockImageAspect
                ? (w => patchBox({ width: w, height: w / aspect }))(Math.max(1, Math.min(CAROUSEL_W, CAROUSEL_H * aspect, n)))
                : patchBox({ width: Math.max(1, Math.min(CAROUSEL_W, n)) });
              const commitH = (n: number) => lockImageAspect
                ? (h => patchBox({ height: h, width: h * aspect }))(Math.max(1, Math.min(CAROUSEL_H, CAROUSEL_W / aspect, n)))
                : patchBox({ height: Math.max(1, Math.min(CAROUSEL_H, n)) });
              return (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-caption text-fg-2 shrink-0 w-12">Size</span>
                    <label className="flex items-center gap-1 text-caption text-fg-3">
                      W
                      <DimInput key={`w-${b.id}`} value={b.width} min={1} max={CAROUSEL_W} onCommit={commitW} className={IN} />
                    </label>
                    <label className="flex items-center gap-1 text-caption text-fg-3">
                      H
                      <DimInput key={`h-${b.id}`} value={b.height} min={1} max={CAROUSEL_H} onCommit={commitH} className={IN} />
                    </label>
                    <span className="text-caption text-fg-3">px</span>
                    <button
                      onClick={() => onLockImageAspectChange?.(!lockImageAspect)}
                      title={lockImageAspect ? 'Aspect ratio locked — click to unlock' : 'Aspect ratio unlocked — click to lock'}
                      className={`ml-auto shrink-0 w-6 h-6 rounded-md flex items-center justify-center focus-ring transition-colors ${
                        lockImageAspect ? 'bg-action text-action-fg' : 'bg-surface-2 border border-line text-fg-3 hover:text-fg'
                      }`}
                    >
                      <LinkIcon size={13} aria-hidden />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-caption text-fg-2 shrink-0 w-12">Position</span>
                    <label className="flex items-center gap-1 text-caption text-fg-3">
                      X
                      <DimInput key={`x-${b.id}`} value={b.x} min={0} max={CAROUSEL_W} onCommit={n => patchBox({ x: Math.max(0, Math.min(CAROUSEL_W, n)) })} className={IN} />
                    </label>
                    <label className="flex items-center gap-1 text-caption text-fg-3">
                      Y
                      <DimInput key={`y-${b.id}`} value={b.y} min={0} max={CAROUSEL_H} onCommit={n => patchBox({ y: Math.max(0, Math.min(CAROUSEL_H, n)) })} className={IN} />
                    </label>
                    <span className="text-caption text-fg-3">px</span>
                  </div>
                </>
              );
            })()}
            <Slider label="Opacity"       value={b.opacity ?? 100} min={0} max={100} unit="%" onChange={v => patchBox({ opacity: v })} />
            <div className="flex items-center justify-between">
              <span className="text-caption text-fg-2">Crop to circle</span>
              <Switch label="Crop image to circle" checked={b.shape === 'circle'} onChange={v => patchBox({ shape: v ? 'circle' : 'rect' })} />
            </div>
            {b.shape === 'circle' ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-caption text-fg-4 leading-snug">Double-click the image on the canvas to reframe — drag to reposition, scroll to zoom.</p>
                {b.circleCrop && <button type="button" className="shrink-0 text-caption text-accent hover:underline" onClick={() => patchBox({ circleCrop: undefined })}>Reset</button>}
              </div>
            ) : (
              <Slider label="Corner Radius" value={Math.min(b.cornerRadius ?? 0, maxRadius)} min={0} max={maxRadius} unit="px" onChange={v => patchBox({ cornerRadius: v })} />
            )}
            {/* Darken / Blur — slide-level background-photo treatment (the value Split & BG Blur act on),
                surfaced here in the image card rather than its own island. Posts only, non-video boxes. */}
            {isPosts && !videoMode && !b.videoUrl && (
              <>
                <Slider label="Darken" value={s.bgDarkenAmount} min={0} max={100} onChange={v => onChange({ bgDarkenAmount: v })} />
                {s.bgBlurEnabled && (
                  <Slider label="Blur Amount" value={s.bgBlurAmount} min={1} max={30} unit="px" onChange={v => onChange({ bgBlurAmount: v })} />
                )}
              </>
            )}
            {/* Expand image — BRIA outpaints the image to fill the whole slide. Gated off via
                EXPAND_IMAGE_ENABLED (BRIA runs on a shared paid/trial key — kept hidden for now). */}
            {EXPAND_IMAGE_ENABLED && onExpandImageBox && (() => {
              const status = imageBoxExpandState?.[b.id];
              const busy = status === 'processing';
              const previewing = expandPreviewBoxId === b.id;
              return (
                <div className="flex flex-col gap-2 pt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-caption text-fg-2">Expand to fill slide</span>
                    {!previewing ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onExpandPreview?.(b.id)}
                        disabled={busy}
                        title="Preview & adjust the area BRIA will fill, then generate"
                      >
                        Expand…
                      </Button>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onExpandPreview?.(null)}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => onExpandImageBox(b.id)}
                          disabled={busy}
                        >
                          {busy ? 'Generating…' : 'Generate'}
                        </Button>
                      </div>
                    )}
                  </div>
                  {status === 'error' && (
                    <span className="text-caption text-danger-text">Couldn’t expand the image — try again.</span>
                  )}
                  {previewing && status !== 'error' && (
                    <span className="text-caption text-fg-3 leading-relaxed">
                      Drag/resize the image on the canvas — the shaded area is what AI (BRIA) will generate. Then Generate.
                    </span>
                  )}
                  {!previewing && status !== 'error' && (
                    <span className="text-caption text-fg-3 leading-relaxed">Fills the canvas around the image using AI (BRIA), based on where you place it.</span>
                  )}
                </div>
              );
            })()}

            {/* Perspective / distort — drag the 4 corner handles on the canvas. Distort = free
                corners; Perspective = symmetric trapezoid; Skew = parallelogram. */}
            {onPerspectiveBox && (() => {
              const editing = perspectiveBoxId === b.id;
              const p = b.perspective;
              const hasPersp = !!p && [p.tl, p.tr, p.br, p.bl].some(c => (c.x || 0) !== 0 || (c.y || 0) !== 0);
              const MODES: { id: PerspectiveMode; label: string; hint: string }[] = [
                { id: 'distort',     label: 'Distort',     hint: 'Each corner moves freely.' },
                { id: 'perspective', label: 'Perspective', hint: 'The same-edge corner mirrors — symmetric trapezoid.' },
                { id: 'skew',        label: 'Skew',        hint: 'The edge slides — parallelogram.' },
              ];
              return (
                <div className="flex flex-col gap-2 pt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-caption text-fg-2">Perspective</span>
                    <button
                      onClick={() => onPerspectiveBox(editing ? null : b.id)}
                      title="Drag the four corners on the canvas to warp the image"
                      className={`px-2 h-6 rounded-md text-caption focus-ring transition-colors ${editing ? 'bg-action text-action-fg' : 'bg-surface-2 border border-line text-fg-2 hover:text-fg hover:border-line-strong'}`}
                    >
                      {editing ? 'Done' : 'Edit corners…'}
                    </button>
                  </div>
                  {editing && (
                    <>
                      <div className="flex items-center gap-1">
                        {MODES.map(m => (
                          <button
                            key={m.id}
                            onClick={() => onPerspectiveMode?.(m.id)}
                            className={`flex-1 px-1 h-6 rounded-md text-caption focus-ring transition-colors ${perspectiveMode === m.id ? 'bg-action text-action-fg' : 'bg-surface-2 border border-line text-fg-3 hover:text-fg'}`}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                      <span className="text-caption text-fg-3 leading-relaxed">
                        Drag the four corner dots on the canvas. {MODES.find(m => m.id === perspectiveMode)?.hint}
                      </span>
                    </>
                  )}
                  {hasPersp && (
                    <button
                      onClick={() => patchBox({ perspective: undefined })}
                      className="self-start px-2 h-6 rounded-md text-caption bg-surface-2 border border-line text-fg-3 hover:text-fg focus-ring transition-colors"
                    >
                      Reset perspective
                    </button>
                  )}
                </div>
              );
            })()}

            {/* Brightness / blur / noise. By default they adjust the whole image. Turn on
                "Detect background" to separate the subject (AI cut-out) — then these controls
                adjust the foreground (subject) and a Background group appears for the rest. */}
            {(() => {
              const fg = b.fgEffects ?? {};
              const bg = b.bgEffects ?? {};
              const setFg = (p: Partial<ImageEffects>) => patchBox({ fgEffects: { ...fg, ...p } });
              const setBg = (p: Partial<ImageEffects>) => patchBox({ bgEffects: { ...bg, ...p } });
              const status  = imageBoxBgState?.[b.id];
              const enabled = !!b.splitEnabled;
              return (
                <div className="flex flex-col gap-2 pt-1">
                  <span className="text-caption font-semibold text-fg-3 uppercase tracking-wider">{enabled ? 'Foreground' : 'Adjust'}</span>
                  <Slider label="Brightness" value={fg.brightness ?? 0} min={-100} max={100} unit="%"  onChange={v => setFg({ brightness: v })} />
                  <Slider label="Blur"       value={fg.blur ?? 0}       min={0}    max={40}  unit="px" onChange={v => setFg({ blur: v })} />
                  <div className="flex items-center justify-between">
                    <span className="text-caption text-fg-2">Fade blurred edges</span>
                    <Switch
                      checked={!!fg.blurEdgeFade}
                      onChange={() => setFg({ blurEdgeFade: !fg.blurEdgeFade })}
                      label="Fade blurred edges (foreground)"
                    />
                  </div>
                  <Slider label="Noise"      value={fg.noise ?? 0}      min={0}    max={100} unit="%"  onChange={v => setFg({ noise: v })} />
                  <ImageFadeControls fade={b.fade} onChange={next => patchBox({ fade: next })} />

                  <div className="flex items-center justify-between pt-1">
                    <span className="text-caption text-fg-2">Detect background</span>
                    <Switch
                      checked={enabled}
                      onChange={() => patchBox({ splitEnabled: !enabled })}
                      label="Separate the subject from the background so each can be adjusted independently"
                    />
                  </div>
                  {enabled && status === 'processing' && (
                    <span className="text-caption text-fg-3">Separating subject…</span>
                  )}
                  {enabled && status === 'error' && (
                    <span className="text-caption text-danger-text">Couldn’t separate the subject — try a different image.</span>
                  )}
                  {enabled && status !== 'processing' && status !== 'error' && (
                    <>
                      <span className="text-caption font-semibold text-fg-3 uppercase tracking-wider pt-1">Background</span>
                      <Slider label="Brightness" value={bg.brightness ?? 0} min={-100} max={100} unit="%"  onChange={v => setBg({ brightness: v })} />
                      <Slider label="Blur"       value={bg.blur ?? 0}       min={0}    max={40}  unit="px" onChange={v => setBg({ blur: v })} />
                      <div className="flex items-center justify-between">
                        <span className="text-caption text-fg-2">Fade blurred edges</span>
                        <Switch
                          checked={!!bg.blurEdgeFade}
                          onChange={() => setBg({ blurEdgeFade: !bg.blurEdgeFade })}
                          label="Fade blurred edges (background)"
                        />
                      </div>
                      <Slider label="Noise"      value={bg.noise ?? 0}      min={0}    max={100} unit="%"  onChange={v => setBg({ noise: v })} />
                      <ImageFadeControls fade={b.bgFade} onChange={next => patchBox({ bgFade: next })} />
                    </>
                  )}
                </div>
              );
            })()}
            <ShadowEditor value={b.shadow} onChange={v => patchBox({ shadow: v })} showLift={false} />
            <Button
              variant="danger"
              size="sm"
              fullWidth
              onClick={removeBox}
              className="mt-1"
            >Remove image</Button>
          </CollapsibleSection>
        );
      })}

      {/* Headline · Skeleton + Sub-headline · Skeleton now render in the draggable layer group above. */}

      {/* Text boxes now render as draggable rows in the LayerSectionList above (textBoxLayerItems). */}
      {([] as TextBoxStyle[]).map((tb, idx) => (
        <TextBoxEditor
          key={tb.id}
          idx={idx}
          tb={tb}
          rich={richText && richText.activeBox === idx ? richText : undefined}
          onChange={next => {
            const arr = [...(s.textBoxes ?? [])];
            arr[idx] = next;
            onChange({ textBoxes: arr });
          }}
          onRemove={() => {
            const arr = [...(s.textBoxes ?? [])];
            arr.splice(idx, 1);
            onChange({ textBoxes: arr });
          }}
        />
      ))}

      {/* Tags now render exclusively as draggable + hideable layer rows in the LayerSectionList above
          (this was a duplicate global "Tags" section). Add tags from the + button on the canvas. */}

      {/* Dividers */}
      {(s.dividerSlots ?? []).some(d => d !== null) && (
        <CollapsibleSection title="Dividers" open={openId === 'dividers'} onToggle={next => setOpenManual(next ? 'dividers' : null)}>
          <div className="flex flex-col gap-1.5">
            {(s.dividerSlots ?? []).map((divId, idx) => {
              if (!divId) return null;
              const ds = s.dividerSettings?.[idx] ?? null;
              return (
                <DividerSlotEditor
                  key={idx}
                  idx={idx}
                  divId={divId}
                  ds={ds}
                  subSlot={s.dividerSubSlots?.[idx] ?? null}
                  onSubChange={c => {
                    const next = [...(s.dividerSubSlots ?? Array(3).fill(null))];
                    next[idx] = c;
                    onChange({ dividerSubSlots: next });
                  }}
                  onChange={newDs => {
                    const next = [...(s.dividerSettings ?? Array(3).fill(null))];
                    next[idx] = newDs;
                    onChange({ dividerSettings: next });
                  }}
                  onRemove={() => {
                    const nextSlots = [...(s.dividerSlots ?? Array(3).fill(null))];
                    const nextSubs  = [...(s.dividerSubSlots ?? Array(3).fill(null))];
                    const nextSets  = [...(s.dividerSettings ?? Array(3).fill(null))];
                    nextSlots[idx] = null;
                    nextSubs[idx]  = null;
                    nextSets[idx]  = null;
                    onChange({ dividerSlots: nextSlots, dividerSubSlots: nextSubs, dividerSettings: nextSets });
                  }}
                />
              );
            })}
          </div>
        </CollapsibleSection>
      )}

      {/* Quotation Marks */}
      {((s.quoteSlots ?? []).some(q => q !== null) || (s.quoteZoneSlots ?? []).some(q => q !== null)) && (
        <CollapsibleSection title="Quotation Marks" open={openId === 'quote'} onToggle={next => setOpenManual(next ? 'quote' : null)}>
          <div className="flex flex-col gap-3">
            {/* Per-quote entries now live as draggable + hideable layer rows above (was a duplicate
                per-slot list). Below are the SHARED quote styles — they apply to every quotation mark. */}
            {/* Shared color / size / opacity */}
            <div className="flex items-center justify-between">
              <span className="text-caption text-fg-2">Color</span>
              <ColorField value={s.quoteColor ?? '#ffffff'} onChange={v => onChange({ quoteColor: v })} label="Quote color" />
            </div>
            <Slider label="Size" value={s.quoteSize ?? 120} min={20} max={400} unit="px"
              onChange={v => onChange({ quoteSize: v })} />
            <Slider label="Opacity" value={s.quoteOpacity ?? 100}
              onChange={v => onChange({ quoteOpacity: v })} />
            {((s.quoteSlots ?? []).some(id => id?.endsWith('-pair')) || (s.quoteZoneSlots ?? []).some(id => id?.endsWith('-pair'))) && (
              <Slider label="Pair Gap" value={s.quoteGap ?? 8} min={0} max={80} unit="px"
                onChange={v => onChange({ quoteGap: v })} />
            )}
            <ShadowEditor value={s.quoteShadow} onChange={v => onChange({ quoteShadow: v })} />
          </div>
        </CollapsibleSection>
      )}

      {/* Swipe elements now render exclusively as draggable + hideable layer rows in the LayerSectionList
          above (this was a duplicate global "Swipe" section). */}

      {/* ── Canvas-level settings — pinned at the bottom, not draggable ─────────── */}
      <div className="h-px bg-line-strong mt-1 mb-0.5" />

      {/* Canvas Colour */}
      <CollapsibleSection title="Canvas Colour" open={openId === 'canvas'} onToggle={next => setOpenManual(next ? 'canvas' : null)}>
        <div className="flex items-center justify-between">
          <span className="text-caption text-fg-2">Colour</span>
          <div className="relative flex items-center gap-2">
            {/* Solid-colour swatch (a plain button, so clicking never opens the picker on its own):
                while transparent → flick back to the colour; while already on the colour → open the picker. */}
            <button
              onClick={() => { if (s.canvasTransparent) onChange({ canvasTransparent: false }); else canvasColorInputRef.current?.click(); }}
              title={s.canvasTransparent ? 'Use the solid colour' : 'Change colour'}
              className={`w-7 h-7 rounded-md border focus-ring ${!s.canvasTransparent ? 'border-fg' : 'border-line hover:border-line-strong'}`}
              style={{ backgroundColor: s.canvasColor ?? '#000000' }}
            />
            {/* Transparent (checkerboard) — keeps the chosen colour so you can flick on/off losslessly */}
            <button
              onClick={() => onChange({ canvasTransparent: true })}
              title="Transparent background"
              className={`w-7 h-7 rounded-md border focus-ring ${s.canvasTransparent ? 'border-fg' : 'border-line hover:border-line-strong'}`}
              style={{
                backgroundColor: '#ffffff',
                backgroundImage: 'linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%)',
                backgroundSize: '8px 8px', backgroundPosition: '0 0,4px 4px',
              }}
            />
            {/* Hidden native picker, anchored under the colour swatch; only opens via the button above */}
            <input
              ref={canvasColorInputRef}
              type="color"
              value={s.canvasColor ?? '#000000'}
              onChange={e => onChange({ canvasColor: e.target.value, canvasTransparent: false })}
              tabIndex={-1}
              aria-hidden
              style={{ position: 'absolute', left: 0, top: 0, width: 28, height: 28, opacity: 0, pointerEvents: 'none' }}
            />
          </div>
        </div>
      </CollapsibleSection>

      {/* Layout */}
      <CollapsibleSection title="Layout" open={openId === 'layout'} onToggle={next => setOpenManual(next ? 'layout' : null)}>
        <Slider label="Head / Sub Gap" value={s.headSubGap}     min={0} max={100} onChange={v => onChange({ headSubGap: v })} />
        <Slider label="Heading top padding" value={s.aboveLogoGap} min={0} max={50} unit="px" onChange={v => onChange({ aboveLogoGap: v })} />
        <Slider label="Content padding" value={s.contentPadding} min={0} max={100} onChange={v => onChange({ contentPadding: v })} />
      </CollapsibleSection>

      </div>
      </div>
    </div>
  );
}
