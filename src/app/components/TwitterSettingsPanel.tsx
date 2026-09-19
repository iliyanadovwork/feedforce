'use client';

import { useState, createContext, useContext, type ReactNode } from 'react';
import type { TwitterTemplateSettings, TwitterAvatarShape, BannerStyle, TextStyle, ImageStyle, ImageFit, ReelsCell, ReelsCellType, FreeElement } from './twitterTemplateTypes';
import { reelCellOf, reelLayout, reelCellRegionRects, DEFAULT_TEXT_FONT, defaultBannerStyle, defaultTextStyle, defaultImageStyle, REELS_CELLS_ENABLED } from './TikTokCanvas/drawing/drawReelCell';
import type { ReelCellKey } from './TikTokCanvas/drawing/drawReelCell';
import { CANVAS_H } from './TikTokCanvas/constants';
import { CollapsibleSection } from '@/app/components/ui/CollapsibleSection';
import { AvatarAdjustModal } from './AvatarAdjustModal';
import { CropModal } from './CropModal';
import { FontDropdown, WeightPicker, StyleRow, ShadowEditor, LayerSectionList, LayerEye } from './TemplateEditorSettingsPanel';
import { ChevronDownIcon } from '@/lib/icons';
import {
  SettingRow,
  ColorField,
  Switch,
  SegmentedControl,
  TextField,
  Textarea,
  Slider,
  Button,
} from '@/app/components/ui';

// Accordion shared by the CollapsibleGroups inside one cell island: a single "open group", so only one
// group is expanded at a time, and it resets to none when the island is closed + reopened (CellEditor).
const GroupAccordion = createContext<{ open: string | null; toggle: (title: string) => void }>({ open: null, toggle: () => {} });

// A flush, borderless collapsible that groups the many banner sub-controls inside a cell island so the
// island stays scannable. No card chrome since it lives INSIDE a card; its open state comes from the
// island's GroupAccordion (one open at a time). Collapsed content is marked `inert` so it leaves the tab
// order + accessibility tree — keyboard/AT users skip hidden controls instead of tabbing through them.
function CollapsibleGroup({ title, children }: { title: string; children: ReactNode }) {
  const acc = useContext(GroupAccordion);
  const open = acc.open === title;
  return (
    <div className="border-t border-line">
      <button
        type="button"
        onClick={() => acc.toggle(title)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 py-2 text-left focus-ring rounded"
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-4">{title}</span>
        <ChevronDownIcon size={11} className={`text-fg-4 transition-transform duration-[var(--dur-base)] ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows 200ms ease' }}>
        <div style={{ overflow: 'hidden' }} inert={!open}>
          <div className="flex flex-col gap-2.5 pb-2.5">{children}</div>
        </div>
      </div>
    </div>
  );
}

// Editor for one reel cell's content: the type picker, plus the controls for that type. A 'banner'
// cell exposes the FULL banner styling (avatar, name, handle, verified, identity, layout) right here,
// stored per-cell on cell.banner so each banner styles independently — drawReelCell merges these over
// the template defaults, so any control left untouched inherits the template-level value `s`.
function CellEditor({ cell, defaultType, onChange, s, logoSrc, cellKey, rect, islandOpen }: {
  cell: ReelsCell | undefined;
  defaultType: ReelsCellType;
  onChange: (c: ReelsCell) => void;
  s: TwitterTemplateSettings;
  logoSrc: string;
  cellKey: string;
  rect?: { w: number; h: number };   // explicit rect (free elements); else derived from the cell key
  islandOpen: boolean;               // is this cell's island expanded? closing it collapses all groups
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  // Accordion: only one sub-group open at a time; reset to none when the island closes so reopening it
  // shows everything collapsed. (Adjust state during render on the islandOpen edge — no effect needed.)
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [wasIslandOpen, setWasIslandOpen] = useState(islandOpen);
  if (islandOpen !== wasIslandOpen) { setWasIslandOpen(islandOpen); if (!islandOpen) setOpenGroup(null); }
  const accordion = { open: openGroup, toggle: (t: string) => setOpenGroup(g => (g === t ? null : t)) };
  const c = cell ?? { type: defaultType };
  const isCaption = c.isCaption ?? true;   // text element: shows the post caption (default) vs its own typed text
  const b = c.banner ?? {};
  const ts = c.textStyle ?? {};
  const is = c.imageStyle ?? {};
  const setBanner = (p: Partial<BannerStyle>) => onChange({ ...c, banner: { ...b, ...p } });
  const setText = (p: Partial<TextStyle>) => onChange({ ...c, textStyle: { ...ts, ...p } });
  const setImg = (p: Partial<ImageStyle>) => onChange({ ...c, imageStyle: { ...is, ...p } });
  // Reset stamps the canonical per-cell defaults onto the cell (deterministic regardless of any
  // template-level values), keeping the cell's content + type.
  const resetStyle = () => {
    if (c.type === 'banner') onChange({ ...c, banner: defaultBannerStyle() });
    else if (c.type === 'text') onChange({ ...c, textStyle: defaultTextStyle() });
    else if (c.type === 'bannerText') onChange({ ...c, banner: defaultBannerStyle(), textStyle: defaultTextStyle() });
    else if (c.type === 'image') onChange({ ...c, imageStyle: defaultImageStyle() });
  };
  const strokeOn = b.avatarStroke ?? s.avatarStroke ?? false;
  // Crop-frame geometry for the image 'Adjust' cropper: match the actual cell's aspect ratio so the
  // preview equals the rendered cell, fit inside a max display box, and scale the corner radius to it.
  const cellRect = rect ?? reelCellRegionRects(reelLayout(s)).find(r => r.key === cellKey);
  const cellAspect = cellRect && cellRect.h > 0 ? cellRect.w / cellRect.h : 1;
  const CROP_MAX_W = 360, CROP_MAX_H = 260;
  let cropW = CROP_MAX_W, cropH = CROP_MAX_W / cellAspect;
  if (cropH > CROP_MAX_H) { cropH = CROP_MAX_H; cropW = CROP_MAX_H * cellAspect; }
  const cropRadiusPx = (is.cornerRadius ?? 24) * (cellRect && cellRect.w ? cropW / cellRect.w : 1);
  return (
    <GroupAccordion.Provider value={accordion}>
      {(c.type === 'text' || c.type === 'bannerText') && (
        <>
          <SettingRow label="Use as caption">
            <Switch label="Use as caption" checked={isCaption} onChange={v => onChange({ ...c, isCaption: v })} />
          </SettingRow>
          {isCaption ? (
            <p className="text-caption text-fg-3 -mt-1">Shows each post&apos;s caption (only one text can be the caption).</p>
          ) : (
            <Textarea
              rows={3}
              value={c.text ?? ''}
              placeholder="Type your text…"
              onChange={e => onChange({ ...c, text: e.target.value })}
            />
          )}
          {c.type === 'bannerText' && (
            <Slider label="Banner gap" value={c.bannerTextGap ?? 0} min={-60} max={300} unit="px" onChange={v => onChange({ ...c, bannerTextGap: v })} />
          )}
          <CollapsibleGroup title="Font">
            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-2">Font</span>
              <FontDropdown value={ts.fontLabel ?? DEFAULT_TEXT_FONT} onChange={v => setText({ fontLabel: v })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-2">Weight</span>
              <WeightPicker fontLabel={ts.fontLabel ?? DEFAULT_TEXT_FONT} value={ts.fontWeight ?? 600} onChange={wt => setText({ fontWeight: wt })} />
            </div>
            <Slider label="Size" value={ts.fontSize ?? ts.captionFontSize ?? 42} min={8} max={200} unit="px" onChange={v => setText({ fontSize: v })} />
            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-2">Style</span>
              <StyleRow
                italic={!!ts.italic} onItalic={() => setText({ italic: !ts.italic })}
                allCaps={!!ts.allCaps} onAllCaps={() => setText({ allCaps: !ts.allCaps })}
                align={ts.align ?? 'center'} onAlign={v => setText({ align: v })}
              />
            </div>
            <SettingRow label="Color">
              <ColorField label="Text color" value={ts.color ?? ts.captionColor ?? '#ffffff'} onChange={v => setText({ color: v })} />
            </SettingRow>
          </CollapsibleGroup>

          <CollapsibleGroup title="Spacing">
            {/* A text box auto-fits its height (hugs its content), so there's no vertical alignment to set.
                "Grows" instead picks which edge stays anchored when the content height changes (e.g. a
                per-post caption longer or shorter than the sample): top fixed → grow down, bottom fixed → grow up. */}
            <SettingRow label="Grows">
              <SegmentedControl<'down' | 'up'>
                ariaLabel="Text grow direction"
                value={ts.growDir ?? 'down'}
                onChange={val => setText({ growDir: val })}
                items={[
                  { value: 'down', label: 'Top-down' },
                  { value: 'up', label: 'Bottom-up' },
                ]}
              />
            </SettingRow>
            <p className="text-caption text-fg-3 -mt-1">A taller caption grows the box downward (top fixed) or upward (bottom fixed).</p>
            <Slider label="Letter spacing" value={ts.letterSpacing ?? 0} min={-20} max={60} unit="px" onChange={v => setText({ letterSpacing: v })} />
            <Slider label="Line spacing" value={ts.lineHeight ?? 15} min={0} max={100} onChange={v => setText({ lineHeight: v })} />
            <Slider label="Opacity" value={ts.opacity ?? 100} min={0} max={100} unit="%" onChange={v => setText({ opacity: v })} />
          </CollapsibleGroup>

          <CollapsibleGroup title="Shadow">
            <ShadowEditor value={ts.shadow} onChange={v => setText({ shadow: v })} showLift={false} />
          </CollapsibleGroup>
        </>
      )}
      {c.type === 'image' && (
        <>
          {/* Free image elements get their image by dragging a Brand upload onto the canvas, so the raw
              URL field is hidden for them; cells (rect undefined) still expose it. */}
          {!rect && (
            <TextField
              type="text"
              value={c.imageUrl ?? ''}
              placeholder="Image URL"
              onChange={e => onChange({ ...c, imageUrl: e.target.value || undefined })}
            />
          )}
          <CollapsibleGroup title="Fit & frame">
            <SettingRow label="Fit">
              <SegmentedControl<ImageFit>
                ariaLabel="Image fit"
                value={is.fit ?? 'cover'}
                onChange={val => setImg({ fit: val })}
                items={[
                  { value: 'cover', label: 'Cover' },
                  { value: 'contain', label: 'Contain' },
                ]}
              />
            </SettingRow>
            <SettingRow label="Background">
              <ColorField label="Image background" value={is.bgColor ?? s.headerBgColor} onChange={v => setImg({ bgColor: v })} />
            </SettingRow>
            {(is.fit ?? 'cover') === 'cover' && c.imageUrl && (
              <SettingRow label="Crop">
                <Button variant="secondary" size="sm" onClick={() => setCropOpen(true)}>Adjust…</Button>
              </SettingRow>
            )}
            <Slider label="Corner radius" value={is.cornerRadius ?? 24} min={0} max={120} unit="px" onChange={v => setImg({ cornerRadius: v })} />
          </CollapsibleGroup>

          <CollapsibleGroup title="Border">
            <SettingRow label="Show border">
              <Switch label="Image border" checked={is.border ?? false} onChange={v => setImg({ border: v })} />
            </SettingRow>
            {is.border && (
              <>
                <SettingRow label="Colour">
                  <ColorField label="Border colour" value={is.borderColor ?? '#ffffff'} onChange={v => setImg({ borderColor: v })} />
                </SettingRow>
                <Slider label="Width" value={is.borderWidth ?? 8} min={1} max={40} unit="px" onChange={v => setImg({ borderWidth: v })} />
              </>
            )}
          </CollapsibleGroup>

          {cropOpen && c.imageUrl && (
            <CropModal
              onClose={() => setCropOpen(false)}
              imageSrc={c.imageUrl}
              frameW={cropW}
              frameH={cropH}
              radiusPx={cropRadiusPx}
              bgColor={is.bgColor ?? s.headerBgColor}
              scale={is.imageScale ?? 1}
              offsetX={is.offsetX ?? 0}
              offsetY={is.offsetY ?? 0}
              onChange={v => setImg({ imageScale: v.scale, offsetX: v.offsetX, offsetY: v.offsetY })}
            />
          )}
        </>
      )}

      {(c.type === 'banner' || c.type === 'bannerText') && (
        <>
          <CollapsibleGroup title="Avatar">
            <SettingRow label="Show avatar">
              <Switch label="Show avatar" checked={b.showAvatar ?? s.showAvatar} onChange={v => setBanner({ showAvatar: v })} />
            </SettingRow>
            <SettingRow label="Shape">
              <SegmentedControl<TwitterAvatarShape>
                ariaLabel="Avatar shape"
                value={b.avatarShape ?? s.avatarShape}
                onChange={val => setBanner({ avatarShape: val })}
                items={[
                  { value: 'roundedSquare', label: 'Rounded' },
                  { value: 'circle', label: 'Circle' },
                ]}
              />
            </SettingRow>
            <SettingRow label="Image">
              <Button variant="secondary" size="sm" onClick={() => setAdjustOpen(true)}>Adjust…</Button>
            </SettingRow>
            <Slider label="Avatar size" value={b.avatarSize ?? s.avatarSize ?? 108} min={48} max={200} unit="px" onChange={v => setBanner({ avatarSize: v })} />
            <SettingRow label="Stroke">
              <Switch label="Avatar stroke" checked={strokeOn} onChange={v => setBanner({ avatarStroke: v })} />
            </SettingRow>
            {strokeOn && (
              <>
                <SettingRow label="Stroke colour">
                  <ColorField label="Avatar stroke colour" value={b.avatarStrokeColor ?? s.avatarStrokeColor ?? '#00CD40'} onChange={v => setBanner({ avatarStrokeColor: v })} />
                </SettingRow>
                <Slider label="Stroke width" value={b.avatarStrokeWidth ?? s.avatarStrokeWidth ?? 3} min={1} max={40} unit="px" onChange={v => setBanner({ avatarStrokeWidth: v })} />
              </>
            )}
          </CollapsibleGroup>

          <CollapsibleGroup title="Display name">
            <SettingRow label="Show name">
              <Switch label="Show display name" checked={b.showName ?? s.showName} onChange={v => setBanner({ showName: v })} />
            </SettingRow>
            <SettingRow label="Color">
              <ColorField label="Display name color" value={b.nameColor ?? s.nameColor} onChange={v => setBanner({ nameColor: v })} />
            </SettingRow>
            <Slider label="Font size" value={b.nameFontSize ?? s.nameFontSize ?? 42} min={24} max={72} unit="px" onChange={v => setBanner({ nameFontSize: v })} />
          </CollapsibleGroup>

          <CollapsibleGroup title="@handle">
            <SettingRow label="Show handle">
              <Switch label="Show handle" checked={b.showHandle ?? s.showHandle} onChange={v => setBanner({ showHandle: v })} />
            </SettingRow>
            <SettingRow label="Color">
              <ColorField label="Handle color" value={b.handleColor ?? s.handleColor} onChange={v => setBanner({ handleColor: v })} />
            </SettingRow>
            <Slider label="Font size" value={b.handleFontSize ?? s.handleFontSize ?? 40} min={24} max={64} unit="px" onChange={v => setBanner({ handleFontSize: v })} />
          </CollapsibleGroup>

          <CollapsibleGroup title="Verified badge">
            <SettingRow label="Show badge">
              <Switch label="Show badge" checked={b.showVerified ?? s.showVerified} onChange={v => setBanner({ showVerified: v })} />
            </SettingRow>
          </CollapsibleGroup>

          <CollapsibleGroup title="Identity">
            <p className="text-caption text-fg-3">Leave blank to use your Branding name &amp; handle.</p>
            <TextField type="text" value={b.defaultDisplayName ?? ''} placeholder="Display name override" onChange={e => setBanner({ defaultDisplayName: e.target.value || null })} />
            <TextField type="text" value={b.defaultHandle ?? ''} placeholder="@handle override" onChange={e => setBanner({ defaultHandle: e.target.value || null })} />
          </CollapsibleGroup>

          <CollapsibleGroup title="Layout">
            <Slider label="Horizontal padding" value={b.headerPaddingX ?? s.headerPaddingX ?? 40} min={0} max={160} unit="px" onChange={v => setBanner({ headerPaddingX: v })} />
            {/* "Top padding" (headerPaddingTop) slider removed — the box now hugs the avatar + stroke, so it
                had no visible effect; the field falls back to its default in the header geometry. */}
            <Slider label="Name / handle gap" value={b.nameHandleGap ?? s.nameHandleGap ?? 10} min={0} max={80} unit="px" onChange={v => setBanner({ nameHandleGap: v })} />
            <Slider label="Name / handle X" value={b.nameHandleOffsetX ?? s.nameHandleOffsetX ?? 0} min={-120} max={200} unit="px" onChange={v => setBanner({ nameHandleOffsetX: v })} />
            <Slider label="Name / handle Y" value={b.nameHandleOffsetY ?? s.nameHandleOffsetY ?? -5} min={-100} max={100} unit="px" onChange={v => setBanner({ nameHandleOffsetY: v })} />
          </CollapsibleGroup>

          {adjustOpen && (
            <AvatarAdjustModal
              onClose={() => setAdjustOpen(false)}
              imageSrc={b.avatarUrl ?? logoSrc}
              shape={b.avatarShape ?? s.avatarShape}
              bgColor={s.headerBgColor}
              scale={b.avatarImageScale ?? s.avatarImageScale ?? 1}
              offsetX={b.avatarOffsetX ?? s.avatarOffsetX ?? 0}
              offsetY={b.avatarOffsetY ?? s.avatarOffsetY ?? 0}
              onChange={v => setBanner({ avatarImageScale: v.scale, avatarOffsetX: v.offsetX, avatarOffsetY: v.offsetY })}
            />
          )}
        </>
      )}

      {c.type !== 'empty' && (
        <div className="flex justify-end pt-1">
          <Button variant="ghost" size="sm" onClick={resetStyle}>Reset to defaults</Button>
        </div>
      )}
    </GroupAccordion.Provider>
  );
}

interface Props {
  settings: TwitterTemplateSettings;
  onChange: (partial: Partial<TwitterTemplateSettings>) => void;
  logoSrc: string;   // resolved avatar source (brand logo or fallback), for the per-banner Adjust cropper
  selectedCell: ReelCellKey | null;                    // which cell's island is expanded (two-way w/ canvas)
  onSelectCell: (cell: ReelCellKey | null) => void;    // expand a cell's island → selects that cell
  selectedFreeId?: string | null;                      // selected free-form element → shows its settings island
  onSelectFree?: (id: string | null) => void;
}

// The four cells, in panel order. Each gets its OWN settings island in the right panel — but only
// once it has content (dropped from the rail), so adding an item makes its island pop up.
const CELL_SECTIONS: { key: ReelCellKey; field: 'cellTop' | 'cellTop2' | 'cellBottom' | 'cellBottom2'; label: string }[] = [
  { key: 'top',     field: 'cellTop',     label: 'Top cell (upper)' },
  { key: 'top2',    field: 'cellTop2',    label: 'Top cell (lower)' },
  { key: 'bottom',  field: 'cellBottom',  label: 'Bottom cell (upper)' },
  { key: 'bottom2', field: 'cellBottom2', label: 'Bottom cell (lower)' },
];
const CELL_TYPE_LABEL: Record<ReelsCellType, string> = { empty: 'Empty', banner: 'Banner', text: 'Text', image: 'Image', bannerText: 'Banner + text' };

// Sentinel layer id for the video band in the Layers list. The band is a draggable z-layer (its position
// among the free elements is the `videoLayer` index) but has no settings → no chevron, and can't be hidden.
const VIDEO_LAYER_ID = '__video__';

export function TwitterSettingsPanel({ settings: s, onChange, logoSrc, selectedCell, onSelectCell, selectedFreeId, onSelectFree }: Props) {
  // Accordion: at most one island open at a time. Selecting a layer/cell opens its island (handled by the
  // layer list / cell sections) and closes the globals; the manual globals below open one-at-a-time and
  // collapse whenever something is selected. Default to NOTHING open (null) — matching the carousel panel —
  // so Canvas colour / Layout aren't auto-expanded on mount (they only open when the user clicks them).
  const [openManual, setOpenManual] = useState<string | null>(null);
  const selectionActive = selectedFreeId != null || selectedCell != null;
  return (
    <div className="flex-1 overflow-y-auto min-h-0 flex flex-col gap-2 p-3 [justify-content:safe_center]">
      {/* One contextual island per filled cell — appears when you drop an item onto that cell. A banner
          cell's island holds the full per-cell banner styling; text/image hold their own field.
          Gated off while cells are disabled (REELS_CELLS_ENABLED) — only the free-element island shows. */}
      {REELS_CELLS_ENABLED && CELL_SECTIONS.map(({ key, field, label }) => {
        const cell = reelCellOf(s, key);
        if (!cell || cell.type === 'empty') return null;
        return (
          <CollapsibleSection
            key={key}
            title={`${CELL_TYPE_LABEL[cell.type]} · ${label}`}
            open={selectedCell === key}
            onToggle={next => onSelectCell(next ? key : null)}
          >
            <CellEditor
              cell={s[field]}
              defaultType={cell.type}
              onChange={c => onChange({ [field]: c } as Partial<TwitterTemplateSettings>)}
              s={s}
              logoSrc={logoSrc}
              cellKey={key}
              islandOpen={selectedCell === key}
            />
          </CollapsibleSection>
        );
      })}

      {/* Element layers — the SAME draggable layer list as the carousel (LayerSectionList): drag the grip
          to reorder (top row = front / drawn last), the eye to hide, the header to edit. The free-element
          array order IS the z-order, and the Video band is itself a draggable layer: where it sits among
          the elements is the `videoLayer` index (how many elements draw behind it). The Video row has no
          settings (no chevron) and can't be hidden — it's only reorderable. */}
      {(() => {
        const free = s.freeElements ?? [];
        const vl = Math.min(Math.max(s.videoLayer ?? 0, 0), free.length);
        // front→back: the elements in front of the band (reversed), then the Video band, then the elements
        // behind it (reversed). videoLayer = 0 puts the band at the very back (behind every element).
        const order = [
          ...free.slice(vl).reverse().map(e => e.id),
          VIDEO_LAYER_ID,
          ...free.slice(0, vl).reverse().map(e => e.id),
        ];
        const freeItems = free.map(fe => {
          const isOpen = selectedFreeId === fe.id;
          return {
            key: fe.id,
            layerId: fe.id,
            title: `${CELL_TYPE_LABEL[fe.type]} · Free`,
            open: isOpen,
            onToggle: (next: boolean) => onSelectFree?.(next ? fe.id : null),
            hidden: !!fe.hidden,
            leftIcons: <LayerEye hidden={!!fe.hidden} onToggle={() => onChange({ freeElements: free.map(e => e.id === fe.id ? { ...e, hidden: !e.hidden } : e) })} />,
            content: (
              <>
                <CellEditor
                  cell={fe}
                  defaultType={fe.type}
                  onChange={c => {
                    let next = free.map(e => e.id === fe.id ? { ...e, ...c } : e);
                    // Only one element can be the caption — turn it off on every other text / bannerText element.
                    if (c.isCaption) next = next.map(e => (e.id === fe.id || (e.type !== 'text' && e.type !== 'bannerText')) ? e : { ...e, isCaption: false });
                    onChange({ freeElements: next });
                  }}
                  s={s}
                  logoSrc={logoSrc}
                  cellKey={fe.id}
                  rect={{ w: fe.width, h: fe.height }}
                  islandOpen={isOpen}
                />
              </>
            ),
          };
        });
        return (
          <LayerSectionList
            order={order}
            onOrderChange={frontToBack => {
              const byId = new Map(free.map(e => [e.id, e] as const));
              const b2t = [...frontToBack].reverse();   // bottom→top, includes the Video sentinel
              const vIdx = b2t.indexOf(VIDEO_LAYER_ID);
              const newFree = b2t.filter(id => id !== VIDEO_LAYER_ID).map(id => byId.get(id)).filter((e): e is FreeElement => !!e);
              // Elements before the sentinel (bottom→top) draw behind the band → that count is videoLayer.
              onChange({ freeElements: newFree, videoLayer: vIdx < 0 ? vl : vIdx });
            }}
            items={[...freeItems, {
              key: VIDEO_LAYER_ID, layerId: VIDEO_LAYER_ID, title: 'Video',
              open: openManual === 'video',
              onToggle: (next: boolean) => setOpenManual(next ? 'video' : null),
              content: (
                <Slider label="Corner radius" value={s.videoCornerRadius ?? 24} min={0} max={120} unit="px" onChange={v => onChange({ videoCornerRadius: v })} />
              ),
            }]}
          />
        );
      })()}

      {/* Divider — below it sit the template-wide settings that aren't layers (mirrors the carousel). The
          Video layer is always present, so the divider always shows. */}
      <div className="h-px bg-line-strong mt-1 mb-0.5" />

      {/* Template-wide settings (apply to the whole reel, not a single cell). */}
      <CollapsibleSection title="Canvas colour" open={!selectionActive && openManual === 'canvas'} onToggle={next => setOpenManual(next ? 'canvas' : null)}>
        <SettingRow label="Canvas colour">
          <ColorField label="Canvas colour" value={s.headerBgColor} onChange={v => onChange({ headerBgColor: v })} />
        </SettingRow>
      </CollapsibleSection>

      <CollapsibleSection title="Layout" open={!selectionActive && openManual === 'layout'} onToggle={next => setOpenManual(next ? 'layout' : null)}>
        <Slider label="Video band height" value={s.videoBandHeight ?? 900} min={300} max={CANVAS_H} unit="px" onChange={v => onChange({ videoBandHeight: v })} />
        <Slider label="Padding" value={s.cellMargin ?? 60} min={0} max={120} unit="px" onChange={v => onChange({ cellMargin: v })} />
      </CollapsibleSection>
    </div>
  );
}
