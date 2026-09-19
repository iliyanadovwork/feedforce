'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/app/components/ui';
import { flattenKeys, autoMatch, extractPlaceholders, getAtPath } from '@/lib/automations';
import { JsonPathPicker } from './JsonPathPicker';
import { TemplateEditorGrid } from '../TemplateEditorGrid';
import { useBrandKit } from '@/app/hooks/useBrandKit';
import type { SlideRow } from '../templateEditorRows';

// Template editor overlay for the automations Template node. Embeds the REAL template builder
// (element rail with drag-and-drop, layer settings panel, undo/redo, fonts, autosave straight to
// template_editor_slides) pinned to this one template, plus a mapping rail (left) that binds run data
// into {placeholders} and chart/table inputs. The canvas is ALWAYS live-previewed with the mapped data:
// mapped tokens draw as their values and charts render the mapped data, while the stored template — and
// any text you click into — keeps the raw {tokens}, so it stays fully editable.

export function TemplateEditModal({ templateValue, userId, data, bindings, onBindingsChange, onClose, leftInset = 0, refreshKey, chatOpen, onOpenChat }: {
  templateValue: string;
  userId: string | null;
  data: unknown;
  bindings: Record<string, string>;
  onBindingsChange: (b: Record<string, string>) => void;
  /** Called with the editor's LIVE slides (the freshest truth, including edits whose debounced
   *  autosave hasn't landed yet) — the parent uses them instead of refetching, which would race the
   *  save and show stale placeholders until a page refresh. */
  onClose: (latestSlides?: SlideRow[]) => void;
  leftInset?: number;    // viewport px left of this overlay (the AI dock width)
  refreshKey?: number;   // bumping remounts the embedded editor (refetch after out-of-band slide edits)
  chatOpen?: boolean;    // whether the automations AI dock is open (it lives left of this overlay)
  onOpenChat?: () => void; // reopen the AI dock — its toolbar button is covered while this overlay is up
}) {
  const [kind, templateId] = templateValue.split(':');
  const isCarousel = kind === 'carousel' && !!templateId;
  const { brand } = useBrandKit(userId);

  // The embedded editor streams the active template's slides up — the source of truth for the
  // placeholder list and the chart inputs, live as the user edits (typing {curly} adds a rail row).
  const [slides, setSlides] = useState<SlideRow[]>([]);
  const onSlidesChange = useCallback((s: SlideRow[]) => setSlides(s), []);

  // The builder's element rail is fixed-positioned (viewport coords) off --rail-w — measure where this
  // overlay actually starts (app sidebar + AI dock can both sit to our left) so the rail lands just
  // right of the mapping column, inside the canvas area.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [railLeft, setRailLeft] = useState(300);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setRailLeft(Math.round(el.getBoundingClientRect().left) + 300);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  // Placeholders across the whole template (reactive to edits → new tokens appear in the mapping rail).
  const placeholders = useMemo(() => {
    const set = new Set<string>();
    for (const s of slides) {
      for (const t of [s.headline, s.subheadline, ...s.settings.textBoxes.map(tb => tb.text)]) {
        for (const ph of extractPlaceholders(t || '')) set.add(ph);
      }
    }
    return [...set];
  }, [slides]);

  // Mappable data inputs of the custom elements (charts/tables/…) placed across the template — shown in
  // the rail as placeholder-style chips, keyed `el:<feId>:<input>` (same convention the Apply-template
  // node and the server-side Template run consume, so mapping here IS the node's binding).
  const elementInputs = useMemo(() => {
    const out: Array<{ key: string; feId: string; inputKey: string; elName: string }> = [];
    for (const s of slides) {
      for (const fe of (s.settings.freeElements ?? [])) {
        if (fe.kind !== 'custom') continue;
        for (const inp of (fe.inputSchema ?? [])) {
          out.push({ key: `el:${fe.id}:${inp.key}`, feId: fe.id, inputKey: inp.key, elName: fe.name || 'Element' });
        }
      }
    }
    return out;
  }, [slides]);

  const hasData = data !== undefined;
  const keyPaths = hasData ? flattenKeys(data, { maxEntries: 300 }).map(k => k.path) : [];
  const effective = useMemo(
    () => ({ ...autoMatch(placeholders, keyPaths), ...bindings }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [placeholders, bindings, JSON.stringify(keyPaths)],
  );

  // Display-time fill maps for the canvas: mapped {tokens} → stringified values; mapped chart inputs →
  // raw values (arrays/objects) keyed by placed-element id. Memoised so the canvas only redraws on
  // actual changes.
  const asString = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const displayValues = useMemo(() => {
    if (!hasData) return undefined;
    const out: Record<string, string> = {};
    for (const ph of placeholders) { const p = effective[ph]; if (p) out[ph] = asString(getAtPath(data, p)); }
    return out;
  }, [hasData, data, placeholders, effective]);
  const displayElementData = useMemo(() => {
    if (!hasData) return undefined;
    const out: Record<string, Record<string, unknown>> = {};
    for (const ei of elementInputs) { const p = effective[ei.key]; if (p) (out[ei.feId] ??= {})[ei.inputKey] = getAtPath(data, p); }
    return out;
  }, [hasData, data, elementInputs, effective]);

  return (
    // Fills everything right of the AI dock (absolute in the section's relative root) so the chat stays
    // visible + usable, and the overlay covers the canvas AND the right-side config panel.
    <div ref={rootRef} className="de-overlay-in absolute inset-y-0 right-0 z-modal flex flex-col bg-page" style={{ left: leftInset, ['--rail-w' as string]: `${railLeft}px`, ['--ai-panel-w' as string]: '0px' }}>
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-surface-1 px-4" style={{ height: 52 }}>
        {/* The canvas toolbar's chat button is covered by this overlay — reopen the AI dock from here. */}
        {!chatOpen && onOpenChat && (
          <Button size="sm" variant="ghost" onClick={onOpenChat} leadingIcon={<span className="brightness-0 invert">✨</span>}>
            Build with AI
          </Button>
        )}
        <span className="text-label font-semibold text-fg">Edit template</span>
        <span className="hidden text-caption text-fg-3 lg:inline">Type <code className="rounded bg-surface-2 px-1 text-fg-2">{'{placeholders}'}</code> in any text — mapped ones show their run data on the canvas; edits save to the template</span>
        <Button size="sm" variant="primary" onClick={() => onClose(slides.length ? slides : undefined)} className="ml-auto">Done</Button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Mapping rail (left) — bind run data into each {placeholder} and chart input; the canvas
            reflects every mapping immediately. */}
        <div className="w-[300px] shrink-0 overflow-y-auto border-r border-line bg-surface-1 p-4">
          <span className="text-label text-fg-2">Field mapping</span>
          {placeholders.length === 0 ? (
            <p className="mt-2 text-caption text-fg-3">Add <code className="text-fg-2">{'{placeholders}'}</code> in the text boxes — they’ll appear here to map.</p>
          ) : !hasData ? (
            <p className="mt-2 text-caption text-fg-3">Run the connected node to get fields to map.</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {placeholders.map(ph => (
                <div key={ph} className="flex items-center gap-2">
                  <code className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-fg-2">{`{${ph}}`}</code>
                  <span className="text-fg-4">←</span>
                  <JsonPathPicker data={data} value={effective[ph] ?? ''} onChange={p => onBindingsChange({ ...bindings, [ph]: p })} />
                </div>
              ))}
            </div>
          )}

          {/* Chart/table data inputs — placeholder-style chips so they read as mappable slots. */}
          {elementInputs.length > 0 && (
            <div className="mt-6">
              <span className="text-label text-fg-2">Chart data</span>
              <p className="mt-1 text-caption text-fg-4">Feeds the charts on the canvas — map a field and the chart redraws with it.</p>
              {!hasData ? (
                <p className="mt-2 text-caption text-fg-3">Run the connected node to get fields to map.</p>
              ) : (
                <div className="mt-3 flex flex-col gap-3">
                  {elementInputs.map(ei => (
                    <div key={ei.key} className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-4">{ei.elName}</span>
                      <div className="flex items-center gap-2">
                        <code className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${effective[ei.key] ? 'bg-surface-2 text-fg-2' : 'border border-dashed border-line-strong bg-surface-2 text-fg-3'}`}>{`{${ei.inputKey}}`}</code>
                        <span className="text-fg-4">←</span>
                        <JsonPathPicker data={data} value={effective[ei.key] ?? ''} onChange={p => onBindingsChange({ ...bindings, [ei.key]: p })} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {!isCarousel ? (
          <div className="grid flex-1 place-items-center text-caption text-fg-3">Only carousel templates can be edited here for now.</div>
        ) : (
          // The real template builder, pinned to this template, always drawing with the mapped data.
          <div className="flex min-w-0 flex-1 flex-col">
            <TemplateEditorGrid
              key={refreshKey}
              brand={brand}
              userId={userId}
              pinnedTemplateId={templateId}
              onSlidesChange={onSlidesChange}
              displayValues={displayValues}
              displayElementData={displayElementData}
            />
          </div>
        )}
      </div>
    </div>
  );
}
