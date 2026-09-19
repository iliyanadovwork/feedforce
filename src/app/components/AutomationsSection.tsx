'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Alert, Badge, BrandLoader, Button, SegmentedControl, Spinner, Switch, TextField, Textarea } from './ui';
import { AccountPicker, type PickerAccount } from './SocialAccountPicker';
import { authedFetch } from '@/lib/authedFetch';
import { supabase } from '@/lib/supabase';
import {
  canConnect, flattenKeys, autoMatch, extractPlaceholders, collectStrings, getAtPath, fillText,
  type Edge, type FlowNode, type Port, type ParamOption, type RunOutputs, type DataType,
} from '@/lib/automations';
import { NODE_DESCRIPTORS, DESCRIPTOR_LIST, instantiate, type NodeDescriptor } from '@/lib/automations/descriptors';
import { lastRunFromLog } from '@/lib/automations/runLog';
import { useAutomations, type FlowRecord, type AutomationMeta, type SaveStatus } from '@/app/hooks/useAutomationFlow';
import { useCustomElements } from '@/app/hooks/useCustomElements';
import { ElementPreview } from './customElements/ElementPreview';
import type { ElementRenderTheme } from '@/lib/customElements/runtime';

// Theme handed to custom-element previews so charts match the dark canvas (mirrors the template editor's).
const ELEMENT_THEME: ElementRenderTheme = {
  fg: '#ffffff', bg: '#000000', accent: '#3b82f6', muted: 'rgba(255,255,255,0.45)',
  positive: '#22c55e', negative: '#ef4444', fontFamily: 'Inter, system-ui, sans-serif',
};

// Map an AI element's input dataType → the automations port DataType so upstream nodes can connect.
function elementDataType(t: string): DataType {
  switch (t) {
    case 'number': return 'number';
    case 'string': return 'string';
    case 'series': return 'series';
    case 'object': return 'object';
    case 'array': case 'ohlc': return 'array';
    default: return 'any';
  }
}
import { rowToSlide, type SlideRow } from './templateEditorRows';
import { NodeIcon, dataTypeColor } from './automations/nodeIcons';
import { ImageIcon } from '@/lib/icons';
import { ConfigPanel } from './automations/ConfigPanel';
import { ChatPanel } from './automations/ChatPanel';
import { FlowSwitcher } from './automations/FlowSwitcher';
import { TemplateEditModal } from './automations/TemplateEditModal';
import { JsonPathPicker } from './automations/JsonPathPicker';
import TemplateEditorCanvas, { CAROUSEL_PREVIEW_W, CAROUSEL_PREVIEW_H } from './TemplateEditorCanvas';
import type { CarouselSettings, TextBoxStyle, TemplateEditorCanvasRef } from './templateEditorTypes';

// ── Automations — canvas v2 (Phase 1) ────────────────────────────────────────────────────────────
// Field-level ports (left inputs / right outputs, typed dots) + port→port edges, right-click to add a
// node, drag to reposition, click a node → config dock (parameter-driven, §4), and load/save the flow
// graph to the `automations` table. Execution wiring is Phase 5.

const NODE_W = 168;
const HEAD_H = 40;
const PORT_H = 26;
const DOT = 13;

const portIndex = (ports: Port[], id: string) => Math.max(0, ports.findIndex(p => p.id === id));
const nodeHeight = (n: FlowNode) => HEAD_H + Math.max(n.inputs.length, n.outputs.length, 1) * PORT_H + 10;
// The node renders as a square; its connection dots sit centred on each side. With multiple ports on a
// side they spread out evenly around that centre, so a single-port side lands exactly in the middle.
const nodeSquare = (n: FlowNode) => Math.max(nodeHeight(n), NODE_W);
const portCenterY = (n: FlowNode, ports: Port[], id: string) =>
  nodeSquare(n) / 2 + (portIndex(ports, id) - (ports.length - 1) / 2) * PORT_H;

export function AutomationsSection({ userId }: { userId: string | null }) {
  const { flows, activeId, active, loading, status, select, create, rename, remove, saveActive, toggleEnabled } = useAutomations(userId);
  // Sweep leftover ephemeral posts — throwaway run snapshots from interrupted runs, closed tabs, or cron
  // runs that the post-publish delete never reached. Best-effort; a no-op until the
  // automation_ephemeral_posts.sql migration is applied.
  useEffect(() => {
    if (!userId) return;
    void supabase.from('template_editor_posts').delete().eq('user_id', userId).eq('ephemeral', true);
  }, [userId]);
  if (loading || !active) {
    return <div className="grid h-screen place-items-center bg-page text-fg"><BrandLoader size={64} /></div>;
  }
  // Keyed by the active flow id so the editor re-initialises from `active` on switch (no effect-setState).
  return (
    <FlowEditor
      key={activeId} initial={active} userId={userId} onSave={saveActive} saveStatus={status}
      flows={flows} activeId={activeId} onSelect={select} onCreate={create} onRename={rename} onDelete={remove}
      onToggleEnabled={toggleEnabled}
    />
  );
}

// Dynamic options for the Template node: the user's carousel + reel templates, by name.
function useTemplateOptions(userId: string | null): ParamOption[] {
  const [options, setOptions] = useState<ParamOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    (async () => {
      const [carousel, reels] = await Promise.all([
        supabase.from('template_editor_templates').select('id,name').eq('user_id', userId).order('position', { ascending: true }),
        supabase.from('twitter_templates').select('id,name').eq('user_id', userId).order('position', { ascending: true }),
      ]);
      if (cancelled) return;
      const rows = (data: unknown) => (data as Array<{ id: string; name: string }> | null) ?? [];
      setOptions([
        ...rows(carousel.data).map(t => ({ name: `Carousel · ${t.name}`, value: `carousel:${t.id}` })),
        ...rows(reels.data).map(t => ({ name: `Reel · ${t.name}`, value: `twitter:${t.id}` })),
      ]);
    })();
    return () => { cancelled = true; };
  }, [userId]);
  return options;
}

// Stored credentials (id/label/kind only — secrets never reach the browser). `create` posts a new
// encrypted credential and returns its id so the picker can select it immediately.
export interface CredentialMeta { id: string; label: string; kind: string }
function useCredentials(userId: string | null): { credentials: CredentialMeta[]; create: (label: string, secret: string, kind?: string) => Promise<string> } {
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    (async () => {
      const res = await authedFetch('/api/automations/credentials');
      const data = await res.json().catch(() => ({}));
      if (!cancelled && res.ok && Array.isArray(data.credentials)) setCredentials(data.credentials);
    })();
    return () => { cancelled = true; };
  }, [userId]);
  const create = useCallback(async (label: string, secret: string, kind = 'apiKey'): Promise<string> => {
    const res = await authedFetch('/api/automations/credentials', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, kind, secret }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.credential) throw new Error(data.error || 'Failed to save credential');
    setCredentials(prev => [data.credential, ...prev]);
    return data.credential.id as string;
  }, []);
  return { credentials, create };
}

// One previewable slide: its display name, the strings to scan for {placeholders}, and — for carousel
// templates — the full SlideRow so we can render the real static canvas with the data filled in.
interface TemplatePreviewSlide { name: string; texts: string[]; carousel?: SlideRow }

// A bindable data input contributed by a custom (chart/table/…) element placed in a template — so the
// Apply-template node can detect charts and let a node map data into them. Keyed `el:<freeElementId>:<input>`.
interface ElementField { key: string; label: string; feId: string; inputKey: string }
function customElementFields(slides: TemplatePreviewSlide[]): ElementField[] {
  const out: ElementField[] = [];
  for (const sl of slides) {
    for (const fe of (sl.carousel?.settings.freeElements ?? [])) {
      if (fe.kind !== 'custom') continue;
      for (const inp of (fe.inputSchema ?? [])) {
        out.push({ key: `el:${fe.id}:${inp.key}`, label: `${fe.name || 'Element'} · ${inp.label || inp.key}`, feId: fe.id, inputKey: inp.key });
      }
    }
  }
  return out;
}
// The unique custom (chart/table/…) elements placed in a template's slides — for the node's preview.
interface TemplateCustomEl { id: string; elementId: string; name: string; code: string; data: unknown; w: number; h: number }
function templateCustomElements(slides: TemplatePreviewSlide[]): TemplateCustomEl[] {
  const seen = new Set<string>();
  const out: TemplateCustomEl[] = [];
  for (const sl of slides) for (const fe of (sl.carousel?.settings.freeElements ?? [])) {
    if (fe.kind === 'custom' && !seen.has(fe.id)) {
      seen.add(fe.id);
      out.push({ id: fe.id, elementId: fe.elementId, name: fe.name, code: fe.code, data: fe.data, w: fe.width, h: fe.height });
    }
  }
  return out;
}

// Rewrite the code of every placed copy of a library element — across ALL templates, not just the one
// being edited — matched by the shared `elementId` (placed elements snapshot their code, so each copy
// must be rewritten in place). Optionally re-points matches at a new library id (after a library-row
// create). Throws on the first failed write so the caller can surface it.
async function propagateElementCode(matchElementId: string, newCode: string, relinkTo?: string): Promise<void> {
  if (!matchElementId) return;
  const { data: rows, error: readErr } = await supabase
    .from('template_editor_slides')
    .select('id,free_elements')
    .contains('free_elements', JSON.stringify([{ kind: 'custom', elementId: matchElementId }]));
  if (readErr) throw new Error(readErr.message);
  // Rows are independent — write them concurrently instead of one round-trip per slide.
  const settled = await Promise.all(((rows ?? []) as Array<{ id: string; free_elements?: Array<Record<string, unknown>> }>).map(row => {
    const fes = Array.isArray(row.free_elements) ? row.free_elements : [];
    const updated = fes.map(fe => (fe.kind === 'custom' && fe.elementId === matchElementId
      ? { ...fe, code: newCode, ...(relinkTo ? { elementId: relinkTo } : {}) }
      : fe));
    return supabase.from('template_editor_slides').update({ free_elements: updated }).eq('id', row.id);
  }));
  const failed = settled.find(r => r.error);
  if (failed?.error) throw new Error(failed.error.message);
}

// Write a modified element's code back into every slide of `templateValue` that contains it (placed
// elements snapshot their code) AND into the reusable library row — so an AI edit from the automations
// panel actually persists. The edit then propagates to every OTHER template containing a copy of the
// same library element, so all templates render the updated element, not just this flow's. Queries the
// slides fresh; preserves all other element/slide data. If the placed element has no real library row
// (a `local_…` id from a failed save, pasted code, or an element created before the migration), we
// CREATE one from its snapshot and re-link every copy, so the edit is genuinely saved as a reusable
// element instead of silently vanishing from the library.
async function applyElementCode(templateValue: string | undefined, feId: string, elementId: string, newCode: string): Promise<void> {
  const [kind, id] = (templateValue ?? '').split(':');
  if (kind !== 'carousel' || !id) throw new Error('This element isn’t in an editable carousel template.');

  const { data: rows, error: readErr } = await supabase.from('template_editor_slides').select('id,free_elements').eq('template_id', id);
  if (readErr) throw new Error(readErr.message);

  // Find the placed element's full snapshot (for a possible library create) while updating its code.
  // Slide writes are independent → run them concurrently.
  let snapshot: Record<string, unknown> | null = null;
  const slideWrites: Array<PromiseLike<{ error: { message: string } | null }>> = [];
  for (const row of (rows ?? []) as Array<{ id: string; free_elements?: Array<Record<string, unknown>> }>) {
    const fes = Array.isArray(row.free_elements) ? row.free_elements : [];
    const match = fes.find(fe => fe.kind === 'custom' && fe.id === feId);
    if (!match) continue;
    snapshot ??= match;
    const updated = fes.map(fe => (fe.kind === 'custom' && fe.id === feId ? { ...fe, code: newCode } : fe));
    slideWrites.push(supabase.from('template_editor_slides').update({ free_elements: updated }).eq('id', row.id));
  }
  if (!slideWrites.length) throw new Error('Couldn’t find the element in the template to update.');
  const written = await Promise.all(slideWrites);
  const writeErr = written.find(r => r.error);
  if (writeErr?.error) throw new Error(writeErr.error.message);

  // Update the reusable library element. A real row id is a uuid; `local_…`/empty means there isn't one yet.
  const hasLibraryRow = !!elementId && !elementId.startsWith('local_');
  if (hasLibraryRow) {
    const { data: upd, error } = await supabase
      .from('custom_elements')
      .update({ code: newCode, updated_at: new Date().toISOString() })
      .eq('id', elementId)
      .select('id');
    if (error) throw new Error(error.message);
    if (upd && upd.length) {
      await propagateElementCode(elementId, newCode);   // update every template that uses this element
      return;
    }
  }

  // No library row exists for this element — create one from the snapshot and re-link every slide that
  // references it, so this element (and future edits) live in the library like any other.
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId || !snapshot) return;  // template slide is already saved; library link is best-effort
  const fe = snapshot;
  const { data: created } = await supabase
    .from('custom_elements')
    .insert({
      user_id: userId,
      name: typeof fe.name === 'string' ? fe.name : 'Element',
      description: '',
      code: newCode,
      input_schema: Array.isArray(fe.inputSchema) ? fe.inputSchema : [],
      default_data: fe.data ?? null,
      size: { w: Number(fe.width) || 720, h: Number(fe.height) || 460, aspect: (Number(fe.width) || 720) / (Number(fe.height) || 460) },
    })
    .select('id')
    .single();
  const newId = created?.id;
  if (!newId) return;
  // Point the placed instances at the new library id so they stay in sync from now on (concurrent,
  // best-effort — the code itself is already saved above).
  await Promise.all(((rows ?? []) as Array<{ id: string; free_elements?: Array<Record<string, unknown>> }>).flatMap(row => {
    const fes = Array.isArray(row.free_elements) ? row.free_elements : [];
    if (!fes.some(f => f.kind === 'custom' && f.id === feId)) return [];
    const relinked = fes.map(f => (f.kind === 'custom' && f.id === feId ? { ...f, code: newCode, elementId: newId } : f));
    return [supabase.from('template_editor_slides').update({ free_elements: relinked }).eq('id', row.id)];
  }));
  // Copies of this element in OTHER templates share the old local id — update their code and re-link
  // them to the new library row too (best-effort: the primary template is already saved).
  await propagateElementCode(elementId, newCode, newId).catch(() => {});
}

// Resolve element-field bindings → per-element data objects, e.g. { "<feId>": { values: [...] } }, pulling
// the RAW upstream value (arrays/objects, not stringified like text placeholders) so charts get real data.
function resolveElementData(fields: ElementField[], bindings: Record<string, string>, data: unknown): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const f of fields) {
    const path = bindings[f.key];
    if (!path) continue;
    (out[f.feId] ??= {})[f.inputKey] = getAtPath(data, path);
  }
  return out;
}

// Loads the selected template's slides + the {placeholders} found across them. Carousel slides carry
// their complete settings (via rowToSlide) so the preview can draw the real canvas; reels stay text-only.
// Slides handed back by the template edit modal on close, keyed by templateValue. They're the
// editor's LIVE state — fresher than the DB while its debounced autosave is still in flight — so
// useTemplateContent prefers them over a refetch (which used to race the save: a just-added
// {placeholder} wouldn't appear in the mapping panel until a full page refresh). Short-lived by
// design: once the autosave has certainly landed, the DB is authoritative again (so edits made in
// the MAIN template editor aren't shadowed by a stale snapshot for the rest of the session).
const EDITED_SLIDES_TTL_MS = 30_000;
const editedSlidesCache = new Map<string, { slides: SlideRow[]; at: number }>();

function contentFromCarouselSlides(rows: SlideRow[]): { placeholders: string[]; slides: TemplatePreviewSlide[]; elementFields: ElementField[] } {
  const slides: TemplatePreviewSlide[] = rows.map(slide => ({
    name: slide.name || 'slide',
    texts: [slide.headline, slide.subheadline, ...slide.settings.textBoxes.map(tb => tb.text)].filter(Boolean),
    carousel: slide,
  }));
  const set = new Set<string>();
  for (const sl of slides) for (const t of sl.texts) for (const ph of extractPlaceholders(t)) set.add(ph);
  return { placeholders: [...set], slides, elementFields: customElementFields(slides) };
}

function useTemplateContent(value: string | undefined, reloadKey = 0): { placeholders: string[]; slides: TemplatePreviewSlide[]; elementFields: ElementField[] } {
  const [content, setContent] = useState<{ placeholders: string[]; slides: TemplatePreviewSlide[]; elementFields: ElementField[] }>({ placeholders: [], slides: [], elementFields: [] });
  useEffect(() => {
    let cancelled = false;
    // Fresh-from-the-editor slides win over a DB fetch (see editedSlidesCache). Deferred a tick —
    // the react-compiler lint forbids synchronous setState in an effect body.
    const edited = value ? editedSlidesCache.get(value) : undefined;
    if (edited && Date.now() - edited.at < EDITED_SLIDES_TTL_MS && edited.slides.length) {
      const fresh = edited.slides;
      Promise.resolve().then(() => { if (!cancelled) setContent(contentFromCarouselSlides(fresh)); });
      return () => { cancelled = true; };
    }
    (async () => {
      const [kind, id] = (value ?? '').split(':');
      const slides: TemplatePreviewSlide[] = [];
      if (id && kind === 'carousel') {
        const { data } = await supabase.from('template_editor_slides').select('*').eq('template_id', id).order('position', { ascending: true });
        for (const row of (data ?? []) as Array<Record<string, unknown>>) {
          const slide = rowToSlide(row);
          const texts = [slide.headline, slide.subheadline, ...slide.settings.textBoxes.map(tb => tb.text)].filter(Boolean);
          slides.push({ name: slide.name || 'slide', texts, carousel: slide });
        }
      } else if (id && kind === 'twitter') {
        const { data } = await supabase.from('twitter_templates').select('settings').eq('id', id).maybeSingle();
        slides.push({ name: 'Reel', texts: collectStrings((data as { settings?: unknown } | null)?.settings).filter(Boolean) });
      } else {
        await Promise.resolve();
      }
      if (cancelled) return;
      const set = new Set<string>();
      for (const sl of slides) for (const t of sl.texts) for (const ph of extractPlaceholders(t)) set.add(ph);
      setContent({ placeholders: [...set], slides, elementFields: customElementFields(slides) });
    })();
    return () => { cancelled = true; };
  }, [value, reloadKey]);
  return content;
}

// The custom (chart/table/…) elements across the flow's in-use carousel templates, WITH their code — so the
// unified AI panel can see and modify them. Keyed by the placed element id (feId).
interface FlowElement { feId: string; elementId: string; name: string; inputs: Array<{ key: string }>; code: string; templateValue: string }
function useFlowElements(values: string[], reloadKey = 0): FlowElement[] {
  const key = [...new Set(values)].sort().join('|');
  const [els, setEls] = useState<FlowElement[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const distinct = key ? key.split('|') : [];
      const out: FlowElement[] = [];
      const seen = new Set<string>();
      // ONE batched query for every carousel template in the flow (was one query per template).
      const ids = distinct.map(v => v.split(':')).filter(([k, id]) => k === 'carousel' && id).map(([, id]) => id);
      if (ids.length) {
        const { data } = await supabase.from('template_editor_slides').select('template_id,free_elements').in('template_id', ids);
        if (cancelled) return;
        for (const s of (data ?? []) as Array<{ template_id: string; free_elements?: Array<Record<string, unknown>> }>) {
          for (const fe of (Array.isArray(s.free_elements) ? s.free_elements : [])) {
            if (fe.kind === 'custom' && typeof fe.id === 'string' && !seen.has(fe.id)) {
              seen.add(fe.id);
              out.push({
                feId: fe.id, elementId: String(fe.elementId ?? ''), name: String(fe.name ?? 'Element'),
                inputs: ((fe.inputSchema as Array<{ key?: string }> | undefined) ?? []).filter(i => i?.key).map(i => ({ key: i.key as string })),
                code: String(fe.code ?? ''), templateValue: `carousel:${s.template_id}`,
              });
            }
          }
        }
      }
      if (!cancelled) setEls(out);
    })();
    return () => { cancelled = true; };
  }, [key, reloadKey]);
  return els;
}

// Placeholders ({…}) for EVERY template-id in use, so the canvas can validate all template nodes (not
// just the open one). Keyed by the node's templateId value (e.g. "carousel:<id>"). Fetched once per
// distinct value; an entry of [] means "loaded, no placeholders".
function useTemplatePlaceholders(values: string[], reloadKey = 0): Record<string, string[]> {
  const key = [...new Set(values)].sort().join('|');
  const [map, setMap] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    const distinct = key ? key.split('|') : [];
    (async () => {
      if (distinct.length === 0) { if (!cancelled) setMap({}); return; }
      // ONE batched query per table (was one query per template — N+1 on flows with many templates).
      const parts = distinct.map(v => v.split(':'));
      const carouselIds = parts.filter(([k, id]) => k === 'carousel' && id).map(([, id]) => id);
      const twitterIds = parts.filter(([k, id]) => k === 'twitter' && id).map(([, id]) => id);
      const [carousel, twitter] = await Promise.all([
        carouselIds.length ? supabase.from('template_editor_slides').select('template_id,headline,subheadline,text_boxes,free_elements').in('template_id', carouselIds) : Promise.resolve({ data: [] }),
        twitterIds.length ? supabase.from('twitter_templates').select('id,settings').in('id', twitterIds) : Promise.resolve({ data: [] }),
      ]);
      if (cancelled) return;
      const result: Record<string, string[]> = {};
      const sets = new Map<string, Set<string>>();
      const setFor = (value: string) => { let s = sets.get(value); if (!s) { s = new Set<string>(); sets.set(value, s); } return s; };
      for (const v of distinct) result[v] = []; // [] = "loaded, no placeholders"
      for (const s of (carousel.data ?? []) as Array<{ template_id: string; headline?: string; subheadline?: string; text_boxes?: Array<{ text?: string }>; free_elements?: Array<Record<string, unknown>> }>) {
        const set = setFor(`carousel:${s.template_id}`);
        const texts = [String(s.headline ?? ''), String(s.subheadline ?? ''), ...(s.text_boxes ?? []).map(tb => String(tb?.text ?? ''))];
        for (const t of texts) for (const ph of extractPlaceholders(t)) set.add(ph);
        // Custom (chart/table/…) elements contribute bindable data inputs the node must map too.
        for (const fe of (s.free_elements ?? [])) {
          if (fe.kind !== 'custom') continue;
          for (const inp of ((fe.inputSchema as Array<{ key?: string }> | undefined) ?? [])) {
            if (inp?.key) set.add(`el:${String(fe.id)}:${inp.key}`);
          }
        }
      }
      for (const row of (twitter.data ?? []) as Array<{ id: string; settings?: unknown }>) {
        const set = setFor(`twitter:${row.id}`);
        for (const t of collectStrings(row.settings)) for (const ph of extractPlaceholders(t)) set.add(ph);
      }
      for (const [value, s] of sets) result[value] = [...s];
      if (!cancelled) setMap(result);
    })();
    return () => { cancelled = true; };
  }, [key, reloadKey]);
  return map;
}

// What a template node still needs. 'no-template' (must pick one) is the only thing that blocks Run.
// 'unmapped' is a non-blocking warning shown ONLY once the node has incoming data — you can't map a
// placeholder until the upstream node has run and produced fields, so we don't nag before then.
// `undefined` placeholders = still loading; a template with no {…} placeholders is complete once chosen.
type TemplateIssue = { kind: 'no-template' } | { kind: 'unmapped'; fields: string[] };
function templateIssue(node: FlowNode, placeholdersByValue: Record<string, string[]>, hasData: boolean): TemplateIssue | null {
  if (node.type !== 'template') return null;
  const value = typeof node.config?.templateId === 'string' ? node.config.templateId : '';
  if (!value) return { kind: 'no-template' };
  if (!hasData) return null; // can't map without upstream data yet — don't warn about unmapped fields
  const phs = placeholdersByValue[value];
  if (!phs || phs.length === 0) return null;
  const bindings = (node.config?.bindings as Record<string, string> | undefined) ?? {};
  const unmapped = phs.filter(ph => !bindings[ph] || !String(bindings[ph]).trim());
  return unmapped.length ? { kind: 'unmapped', fields: unmapped } : null;
}
function issueMessage(issue: TemplateIssue): string {
  if (issue.kind === 'no-template') return 'Select a template for this node.';
  const labels = issue.fields.map(f => f.startsWith('el:') ? `chart "${f.split(':').pop()}"` : `{${f}}`);
  return `Map these first: ${labels.join(', ')}.`;
}

// A real carousel slide rendered statically, scaled into the config dock, with {placeholders}
// substituted by the run data. Reuses TemplateEditorCanvas (staticMode) — the same static-preview
// path the template picker uses — so the dock shows the actual composited slide, not just text.
const PREVIEW_W = 376;
const PREVIEW_SCALE = PREVIEW_W / CAROUSEL_PREVIEW_W;
function CarouselSlidePreview({ slide, index, values, elementData, bgUrl, canvasRef }: { slide: SlideRow; index: number; values: Record<string, string>; elementData?: Record<string, Record<string, unknown>>; bgUrl?: string; canvasRef?: (el: TemplateEditorCanvasRef | null) => void }) {
  const filledBoxes: TextBoxStyle[] = slide.settings.textBoxes.map(tb => ({ ...tb, text: fillText(tb.text, values) }));
  // Inject mapped data into custom (chart/table/…) elements so they render with the upstream data.
  const freeElements = elementData
    ? (slide.settings.freeElements ?? []).map(fe =>
        fe.kind === 'custom' && elementData[fe.id]
          ? { ...fe, data: { ...(fe.data && typeof fe.data === 'object' ? fe.data as Record<string, unknown> : {}), ...elementData[fe.id] } }
          : fe)
    : slide.settings.freeElements;
  // A mapped bg:<slideId> binding — same full-canvas bottom-layer image box the run injects
  // (serverNodes runTemplate), so the live preview matches the generated post exactly.
  const bgBox = bgUrl
    ? [{ id: `autobg_${slide.id}`, url: bgUrl, x: 0, y: 0, width: 1080, height: 1350, opacity: 100, cornerRadius: 0, objectFit: 'cover' as const }]
    : [];
  const settings: CarouselSettings = {
    ...slide.settings,
    textBoxes: filledBoxes,
    freeElements,
    ...(bgUrl ? {
      imageBoxes: [...bgBox, ...slide.settings.imageBoxes],
      layerOrderIds: [`autobg_${slide.id}`, ...(slide.settings.layerOrderIds ?? [])],
    } : {}),
  };
  return (
    <div className="shrink-0 overflow-hidden ring-1 ring-line" style={{ width: PREVIEW_W, height: CAROUSEL_PREVIEW_H * PREVIEW_SCALE }}>
      <div style={{ width: CAROUSEL_PREVIEW_W, height: CAROUSEL_PREVIEW_H, transform: `scale(${PREVIEW_SCALE})`, transformOrigin: 'top left' }}>
        <TemplateEditorCanvas
          ref={canvasRef}
          imageSrc=""
          headline={fillText(slide.headline, values)}
          subheadline={fillText(slide.subheadline, values)}
          settings={settings}
          rectMode
          invertedSlots={index === 2}
          staticMode
          cleanView
        />
      </div>
    </div>
  );
}

// ── Run-time rendering helpers ──────────────────────────────────────────────────────────────────
// Load a generated post's slides — the Template node creates a real post (with placeholders already
// filled from the mapped run data) on every run; we render those to images for the Post node.
async function loadPostSlides(postId: string): Promise<SlideRow[]> {
  const { data } = await supabase.from('template_editor_post_slides').select('*').eq('post_id', postId).order('position', { ascending: true });
  return ((data ?? []) as Record<string, unknown>[]).map(rowToSlide);
}
// Upload a rendered slide under the user's `_renders/` folder — throwaway media that only exists so
// Zernio/Instagram can fetch it at publish time. Returns the public URL + the exact storage path
// (recorded in the cleanup ledger so the render is deleted once the post publishes).
async function uploadSlideBlob(uid: string, blob: Blob, filename: string): Promise<{ url: string; path: string } | null> {
  const path = `${uid}/_renders/${filename}`; // first segment must be the uid (post-images RLS)
  const { error } = await supabase.storage.from('post-images').upload(path, blob, { contentType: 'image/png' });
  if (error) return null;
  return { url: supabase.storage.from('post-images').getPublicUrl(path).data.publicUrl, path };
}
// Record uploaded renders in the cleanup ledger (scheduled_render_media): kept until the post publishes
// (publish-now ≈ minutes; scheduled = its time) plus a buffer, then the cleanup cron deletes the storage
// objects; cancelling a scheduled post deletes them immediately. Best-effort — the post is already
// scheduled, so a ledger hiccup must not fail it (worst case the render lingers until a manual sweep).
async function recordRenders(userId: string, postId: string, paths: string[], expiresAtMs: number): Promise<void> {
  if (!paths.length) return;
  try {
    await supabase.from('scheduled_render_media').insert(paths.map(path => ({
      user_id: userId, post_id: postId, bucket: 'post-images', path, expires_at: new Date(expiresAtMs).toISOString(),
    })));
  } catch { /* best-effort */ }
}
// Ledger expiry for a post's renders. Instagram fetches the URL at publish time and then hosts its own
// copy, so a publish-now render only needs a short fetch buffer (30min); a scheduled one must survive
// until its publish time + buffer. The hourly cleanup cron sweeps whatever is past expiry.
function renderExpiry(publishNow: boolean, scheduledForISO?: string): number {
  if (publishNow) return Date.now() + 30 * 60_000;
  const t = scheduledForISO ? Date.parse(scheduledForISO) : NaN;
  return (Number.isNaN(t) ? Date.now() : t) + 6 * 3600_000;
}
// Drop ledger rows for these renders (owner RLS) — used when swapping pending rows for final ones.
async function unledgerRenders(paths: string[]): Promise<void> {
  if (!paths.length) return;
  await supabase.from('scheduled_render_media').delete().in('path', paths);
}
// A publish failed or was abandoned — delete the uploaded renders RIGHT NOW (storage objects + their
// ledger rows) instead of waiting for the cron sweep. Best-effort: anything a network hiccup leaves
// behind is still covered by its pending ledger row's expiry.
async function deleteRenders(paths: string[]): Promise<void> {
  if (!paths.length) return;
  await supabase.storage.from('post-images').remove(paths);
  await unledgerRenders(paths);
}
// The postId(s) a Template node emitted on its last run (one per input item).
function postIdsOf(outputs: Record<string, RunOutputs> | undefined, tplNodeId: string): string[] {
  const items = (outputs?.[tplNodeId] as { out?: Array<{ json?: { postId?: unknown } }> } | undefined)?.out ?? [];
  return items.map((it) => it?.json?.postId).filter((x): x is string => typeof x === 'string');
}

// Config dock for the Post node — mirrors the Post page composer (account · type · caption · when +
// slide preview), except the slides come from the "Apply template" node wired into this Post node.
type IgType = 'feed' | 'reels' | 'story';
function PostNodeConfig({ node, nodes, edges, userId, runOutputs, onChange }: {
  node: FlowNode; nodes: FlowNode[]; edges: Edge[]; userId: string | null; runOutputs: Record<string, RunOutputs>; onChange: (name: string, value: unknown) => void;
}) {
  // The "Apply template" node feeding this Post node decides what gets posted.
  const templateNode = useMemo(() => {
    const sources = edges.filter((e) => e.to.node === node.id).map((e) => nodes.find((n) => n.id === e.from.node));
    return sources.find((n) => n?.type === 'template') ?? null;
  }, [edges, nodes, node.id]);
  const templateId = typeof templateNode?.config?.templateId === 'string' ? (templateNode.config.templateId as string) : undefined;
  const { placeholders, slides } = useTemplateContent(templateId);
  const sourceCarousel = slides.filter((s) => !!s.carousel).map((s) => s.carousel as SlideRow);

  // The Post node must not publish while any of the template's placeholders are unmapped.
  const tplBindings = (templateNode?.config?.bindings && typeof templateNode.config.bindings === 'object' ? templateNode.config.bindings : {}) as Record<string, string>;
  const unmappedPh = placeholders.filter((ph) => !tplBindings[ph] || !String(tplBindings[ph]).trim());

  // After a run, the Template node created a real post with the {placeholders} filled in from the mapped
  // data — prefer THAT (the exact thing we publish) for the preview; before any run, show the source
  // template. The source (with placeholders) always stays the Apply-template node's working template.
  const generatedPostId = templateNode ? postIdsOf(runOutputs, templateNode.id)[0] : undefined;
  const [genSlides, setGenSlides] = useState<SlideRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!generatedPostId) { setGenSlides(null); return; }
    (async () => { const s = await loadPostSlides(generatedPostId); if (!cancelled) setGenSlides(s); })();
    return () => { cancelled = true; };
  }, [generatedPostId]);

  // Generated posts are deleted right after the publish step, so an empty load falls back to the source.
  const postCarousel = genSlides?.length ? genSlides : sourceCarousel;   // the slides we preview AND post
  const usingGenerated = !!genSlides?.length;
  const hasPost = postCarousel.length > 0;            // a postable (carousel) preview is present
  const slideRefs = useRef<(TemplateEditorCanvasRef | null)[]>([]);

  // Connected Instagram accounts — same source as the Post page composer.
  const [accounts, setAccounts] = useState<PickerAccount[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch('/api/schedule/accounts');
        const json = await res.json();
        if (cancelled) return;
        setAccounts(res.ok ? (json.accounts ?? []).filter((a: { platform: string }) => a.platform === 'instagram') : []);
      } catch { if (!cancelled) setAccounts([]); }
    })();
    return () => { cancelled = true; };
  }, []);

  const cfg = node.config ?? {};
  const accountId = typeof cfg.accountId === 'string' ? cfg.accountId : '';
  // One account → preselect it; many → leave blank so the dropdown shows "Select account".
  useEffect(() => {
    if (accounts && accounts.length === 1 && !accountId) onChange('accountId', accounts[0]._id);
  }, [accounts, accountId, onChange]);
  const contentType = (typeof cfg.contentType === 'string' ? cfg.contentType : 'feed') as IgType;
  const caption = typeof cfg.caption === 'string' ? cfg.caption : '';
  const when = (typeof cfg.when === 'string' ? cfg.when : 'now') as 'now' | 'schedule';
  const scheduledFor = typeof cfg.scheduledFor === 'string' ? cfg.scheduledFor : '';

  const account = accounts?.find((a) => a._id === accountId) ?? null;
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [postResult, setPostResult] = useState<string | null>(null);

  // Manually publish/schedule the previewed slides right now (renders → uploads → /api/schedule/post).
  // Renders go to `_renders/` and are ledgered for cleanup, same as the run-time publish step.
  async function postNow() {
    if (!account || !hasPost || !userId) return;
    setPostError(null); setPostResult(null);
    if (unmappedPh.length) { setPostError(`Map these placeholders first: ${unmappedPh.map((f) => `{${f}}`).join(', ')}.`); return; }
    if (when === 'schedule') {
      const t = Date.parse(scheduledFor);
      if (Number.isNaN(t)) { setPostError('Pick a date & time first.'); return; }
      if (t <= Date.now()) { setPostError('Schedule time must be in the future.'); return; }
    }
    setPosting(true);
    try {
      const stamp = Date.now();
      const urls: string[] = [], paths: string[] = [];
      for (let i = 0; i < postCarousel.length; i++) {
        const blob = await slideRefs.current[i]?.exportBlob();
        if (!blob) continue;
        const up = await uploadSlideBlob(userId, blob, `node_${node.id}_${stamp}_${i}.png`);
        if (up) { urls.push(up.url); paths.push(up.path); }
      }
      // Safety net first (a closed tab still gets swept); a failed post deletes instantly below.
      await recordRenders(userId, `pending_node_${node.id}`, paths, Date.now() + 3600_000);
      if (urls.length === 0) throw new Error('Could not render the slides — reopen the node and retry.');
      const scheduledISO = when === 'now' ? undefined : new Date(scheduledFor).toISOString();
      let zid: string;
      try {
        const res = await authedFetch('/api/schedule/post', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: account._id,
            content: caption,
            mediaItems: urls.map((url) => ({ type: 'image' as const, url })),
            contentType,
            publishNow: when === 'now',
            scheduledFor: scheduledISO,
            timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })(),
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error((json as { error?: string }).error ?? 'Failed to post');
        zid = ((json as { post?: { _id?: string } }).post?._id) ?? `node_${node.id}_${stamp}`;
      } catch (e) {
        await deleteRenders(paths); // never posted → delete the images immediately, not on the sweep
        throw e;
      }
      await unledgerRenders(paths);
      await recordRenders(userId, zid, paths, renderExpiry(when === 'now', scheduledISO));
      setPostResult(when === 'now' ? `Posting to @${account.username} now.` : `Scheduled to @${account.username}.`);
    } catch (e) {
      setPostError(e instanceof Error ? e.message : 'Failed to post');
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!templateNode && <Alert tone="warning">Wire an “Apply template” node into this Post node to choose what gets posted.</Alert>}

      {accounts === null ? <div className="grid h-9 place-items-start"><Spinner size="sm" /></div>
        : accounts.length === 0 ? <Alert tone="info">No Instagram account connected. Connect one on the Post page first.</Alert>
        : <AccountPicker accounts={accounts} value={accountId} onChange={(id) => onChange('accountId', id)} />}

      <div className="flex flex-col gap-1.5">
        <span className="text-label text-fg-2">Type</span>
        <SegmentedControl<IgType>
          ariaLabel="Post type" emphasis="fill"
          items={[{ value: 'feed', label: 'Feed' }, { value: 'reels', label: 'Reel' }, { value: 'story', label: 'Story' }]}
          value={contentType} onChange={(v) => onChange('contentType', v)}
        />
      </div>

      <Textarea label="Caption" rows={3} value={caption} onChange={(e) => onChange('caption', e.target.value)}
        placeholder="Write a caption… you can use {placeholders} from upstream data" />

      <div className="flex flex-col gap-2">
        <span className="text-label text-fg-2">When</span>
        <SegmentedControl<'now' | 'schedule'>
          ariaLabel="When to post" emphasis="fill"
          items={[{ value: 'now', label: 'Now' }, { value: 'schedule', label: 'Date & time' }]}
          value={when} onChange={(v) => onChange('when', v)}
        />
        {when === 'schedule' && (
          <TextField type="datetime-local" value={scheduledFor} onChange={(e) => {
            onChange('scheduledFor', e.target.value);
            // datetime-local is an offset-less wall-clock string — persist the browser's timezone with
            // it so the SERVER publish paths (manual run + cron) interpret it as the user meant it.
            try { onChange('tz', Intl.DateTimeFormat().resolvedOptions().timeZone); } catch { /* tz optional */ }
          }} />
        )}
      </div>

      {/* Slide preview — same centered, stacked layout as the Apply-template node's output preview.
          After a run it shows the generated post (placeholders filled); otherwise the source template. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-label text-fg-2">Preview{usingGenerated && <span className="font-normal text-fg-4"> · latest run</span>}</span>
        {!templateId ? (
          <p className="text-caption text-fg-3">No template connected yet.</p>
        ) : postCarousel.length === 0 && slides.length === 0 ? (
          <p className="text-caption text-fg-3 flex items-center gap-2"><Spinner size="sm" /> Loading slides…</p>
        ) : postCarousel.length > 0 ? (
          <div className="mt-1 flex flex-col items-center gap-3">
            {postCarousel.map((s, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <CarouselSlidePreview slide={s} index={i} values={{}} canvasRef={(el) => { slideRefs.current[i] = el; }} />
                <div className="text-center text-[10px] uppercase tracking-wide text-fg-4">Slide {i + 1}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-1 flex flex-col items-center gap-3">
            {slides.map((s, i) => (
              <div key={i} className="w-full rounded-lg border border-line bg-page p-3">
                <div className="text-[10px] uppercase tracking-wide text-fg-4">{s.name}</div>
                {s.texts.map((t, j) => (
                  <p key={j} className={`mt-1 leading-snug ${j === 0 ? 'text-[13px] font-semibold text-fg' : 'text-[12px] text-fg-2'}`}>{t}</p>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Manual publish — appears when a postable preview is present in the node. */}
      {hasPost && (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          {unmappedPh.length > 0 && (
            <Alert tone="warning">Map every placeholder in the template first: {unmappedPh.map((f) => `{${f}}`).join(', ')}.</Alert>
          )}
          {postError && <Alert tone="danger">{postError}</Alert>}
          {postResult && <Alert tone="success">{postResult}</Alert>}
          <Button variant="primary" fullWidth loading={posting} disabled={!account || posting || unmappedPh.length > 0} onClick={postNow}>
            {when === 'now' ? 'Post now' : 'Schedule post'}
          </Button>
          <p className="text-caption text-fg-3 text-center">Posts the slides above to {account ? `@${account.username}` : 'the selected account'}.</p>
        </div>
      )}
    </div>
  );
}

// Maps a connected node's response fields → the template's {placeholders}. Auto-matched by name;
// each row uses the drill-down JsonPathPicker so deep JSON stays navigable.
function TemplateBindings({ templateValue, data, bindings, onChange, reloadKey, onEdit, onEditElement }: {
  templateValue?: string; data: unknown; bindings: Record<string, string>; onChange: (b: Record<string, string>) => void;
  reloadKey: number; onEdit: () => void; onEditElement: (el: TemplateCustomEl) => void;
}) {
  const { placeholders, slides, elementFields } = useTemplateContent(templateValue, reloadKey);
  const hasData = data !== undefined;
  // Every carousel slide's BACKGROUND is a bindable image field by default — map an image URL from
  // upstream data and the run injects it as a full-canvas bottom layer (serverNodes bg:<slideId>).
  const bgFields = slides
    .map((s, i) => (s.carousel ? { key: `bg:${s.carousel.id}`, label: `Slide ${i + 1} background` } : null))
    .filter((f): f is { key: string; label: string } => !!f);
  const keyPaths = hasData ? flattenKeys(data, { maxEntries: 300 }).map(k => k.path) : [];
  // Auto-match chart inputs by their input key (e.g. an upstream "values" field → the chart's `values`).
  const elAuto: Record<string, string> = {};
  if (elementFields.length) {
    const byInputKey = autoMatch(elementFields.map(f => f.inputKey), keyPaths);
    for (const f of elementFields) if (byInputKey[f.inputKey]) elAuto[f.key] = byInputKey[f.inputKey];
  }
  const effective = { ...autoMatch(placeholders, keyPaths), ...elAuto, ...bindings };
  // Resolve each mapped placeholder → its current value from the run data (for the live preview).
  const resolved: Record<string, string> = {};
  if (hasData) for (const ph of placeholders) if (effective[ph]) { const v = getAtPath(data, effective[ph]); resolved[ph] = v == null ? '' : String(v); }
  // Resolve chart inputs → raw per-element data for the preview.
  const elementData = hasData ? resolveElementData(elementFields, effective, data) : undefined;
  // Resolve mapped slide backgrounds → URL per slide id (same http(s)-only rule the run applies).
  const bgResolved: Record<string, string> = {};
  if (hasData) for (const s of slides) {
    if (!s.carousel) continue;
    const path = effective[`bg:${s.carousel.id}`];
    const v = path ? getAtPath(data, path) : undefined;
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) bgResolved[s.carousel.id] = v.trim();
  }
  const dynamicEls = templateCustomElements(slides);

  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-label text-fg-2">Field mapping</span>
        {templateValue && <Button size="sm" variant="secondary" onClick={onEdit}>Add/remove placeholders</Button>}
      </div>

      {/* Dynamic components in the selected template — a live preview of each chart/table/etc., drawn with
          the mapped data when available (else its sample data). */}
      {dynamicEls.length > 0 && (
        <div className="mt-3 rounded-lg border border-accent-border bg-accent-tint/30 p-2.5">
          <span className="text-caption text-accent-text">▦ {dynamicEls.length} dynamic component{dynamicEls.length > 1 ? 's' : ''} in this template, map data into {dynamicEls.length > 1 ? 'them' : 'it'} below.</span>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {dynamicEls.map(el => {
              const d = elementData?.[el.id]
                ? { ...(el.data && typeof el.data === 'object' ? el.data as Record<string, unknown> : {}), ...elementData[el.id] }
                : el.data;
              return (
                <div key={el.id} className="flex flex-col items-center gap-1 rounded-md border border-line bg-surface-1 p-2">
                  <ElementPreview code={el.code} data={d} size={{ w: el.w, h: el.h }} theme={ELEMENT_THEME} displayW={120} />
                  <span className="w-full truncate text-center text-[11px] text-fg-3">{el.name}</span>
                  <button onClick={() => onEditElement(el)}
                    className="text-[11px] text-accent-text hover:underline focus-ring">Edit with AI</button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {!templateValue ? (
        <p className="mt-2 text-caption text-fg-3">Pick a template above first.</p>
      ) : placeholders.length === 0 && elementFields.length === 0 && bgFields.length === 0 ? (
        <p className="mt-2 text-caption text-fg-3">Add <code className="text-fg-2">{'{placeholders}'}</code> in the template’s text boxes (or a chart/data element) — they’ll appear here.</p>
      ) : !hasData ? (
        <p className="mt-2 text-caption text-fg-3">Connect a node and Run it (or test-run it) to get fields to map.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {placeholders.map(ph => (
            <div key={ph} className="flex items-center gap-2">
              <code className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-fg-2">{`{${ph}}`}</code>
              <span className="text-fg-4">←</span>
              <JsonPathPicker data={data} value={effective[ph] ?? ''} onChange={p => onChange({ ...bindings, [ph]: p })} />
            </div>
          ))}
          {/* Chart/data elements detected in the template — map a data source into each input. */}
          {elementFields.map(f => (
            <div key={f.key} className="flex items-center gap-2">
              <span className="shrink-0 rounded bg-accent-tint px-1.5 py-0.5 text-[11px] text-accent-text" title="Chart/data element input">▦ {f.label}</span>
              <span className="text-fg-4">←</span>
              <JsonPathPicker data={data} value={effective[f.key] ?? ''} onChange={p => onChange({ ...bindings, [f.key]: p })} />
            </div>
          ))}
          {/* Slide backgrounds — always bindable: map an image URL and the generated post gets it as a
              full-canvas bottom layer. Optional; unmapped slides keep the template's own design. */}
          {bgFields.map(f => (
            <div key={f.key} className="flex items-center gap-2">
              <span className="inline-flex shrink-0 items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-fg-2" title="Slide background image (map an image URL — optional)"><ImageIcon size={12} /> {f.label}</span>
              <span className="text-fg-4">←</span>
              <JsonPathPicker data={data} value={effective[f.key] ?? ''} onChange={p => onChange({ ...bindings, [f.key]: p })} />
            </div>
          ))}
        </div>
      )}

      {/* Live preview with the run data filled into the {placeholders}. Carousel slides render the real
          static canvas; reels fall back to a text card. */}
      {hasData && slides.length > 0 && (
        <div className="mt-5">
          <span className="text-label text-fg-2">Output <span className="font-normal text-fg-4">· slides with data filled in</span></span>
          <div className="mt-2 flex flex-col items-center gap-3">
            {slides.map((s, i) =>
              s.carousel ? (
                <div key={i} className="flex flex-col gap-1.5">
                  <CarouselSlidePreview slide={s.carousel} index={i} values={resolved} elementData={elementData} bgUrl={bgResolved[s.carousel.id]} />
                  <div className="text-center text-[10px] uppercase tracking-wide text-fg-4">{s.name}</div>
                </div>
              ) : (
                <div key={i} className="w-full rounded-lg border border-line bg-page p-3">
                  <div className="text-[10px] uppercase tracking-wide text-fg-4">{s.name}</div>
                  {s.texts.map((t, j) => (
                    <p key={j} className={`mt-1 leading-snug ${j === 0 ? 'text-[13px] font-semibold text-fg' : 'text-[12px] text-fg-2'}`}>{fillText(t, resolved)}</p>
                  ))}
                </div>
              ),
            )}
          </div>
        </div>
      )}

    </div>
  );
}

// HTTP node: paste docs / a cURL command / OpenAPI → /api/automations/parse-docs (Gemini) → a list of
// endpoints; "Use" fills the node's method/url/auth from the chosen one (§5).
interface ParsedParam { in?: string; name?: string; required?: boolean }
interface ParsedEndpoint { name?: string; method?: string; path?: string; params?: ParsedParam[] }
interface ParsedSpec { baseUrl?: string; auth?: { type?: string }; endpoints?: ParsedEndpoint[] }
function HttpDocsImport({ onApply }: { onApply: (patch: Record<string, unknown>) => void }) {
  const [docs, setDocs] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [spec, setSpec] = useState<ParsedSpec | null>(null);

  async function generate() {
    setBusy(true); setErr(null);
    try {
      const res = await authedFetch('/api/automations/parse-docs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not parse those docs');
      setSpec(data.spec as ParsedSpec);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }

  function use(ep: ParsedEndpoint) {
    const base = (spec?.baseUrl ?? '').replace(/\/$/, '');
    const path = (ep.path ?? '').replace(/^(?!\/)/, '/');
    const method = (ep.method ?? 'GET').toUpperCase();
    // Carry the parsed params into the node instead of dropping them: query params append to the URL
    // (values left blank for the user to fill), path params stay as {tokens} in the path, and body
    // params seed a JSON body. Previously only method/url/auth were applied, so the resulting node
    // 400'd on any endpoint that needed params.
    const params = ep.params ?? [];
    const query = params.filter(p => p.in === 'query' && p.name).map(p => `${encodeURIComponent(p.name!)}=`).join('&');
    let url = base + path;
    if (query) url += (url.includes('?') ? '&' : '?') + query;
    const bodyParams = params.filter(p => p.in === 'body' && p.name);
    const patch: Record<string, unknown> = {
      method,
      url,
      authentication: spec?.auth?.type && spec.auth.type !== 'none' ? 'apiKey' : 'none',
    };
    if (bodyParams.length && method !== 'GET') {
      patch.sendBody = true;
      patch.body = JSON.stringify(Object.fromEntries(bodyParams.map(p => [p.name!, ''])), null, 2);
    }
    onApply(patch);
  }

  return (
    <div className="mt-5 border-t border-line pt-4">
      <span className="text-label text-fg-2">Import from docs <span className="font-normal text-fg-4">· AI-generated</span></span>
      <Textarea className="mt-2 font-mono text-[12px]" rows={4} placeholder="Paste API docs, a cURL command, or an OpenAPI snippet…" value={docs} onChange={e => setDocs(e.target.value)} />
      <div className="mt-2"><Button size="sm" variant="secondary" loading={busy} onClick={generate} disabled={!docs.trim()}>Generate</Button></div>
      {err && <Alert tone="danger" className="mt-2">{err}</Alert>}
      {spec && (
        <div className="mt-3 flex flex-col gap-1.5">
          {(spec.endpoints ?? []).length === 0 ? (
            <p className="text-caption text-fg-3">No endpoints found — try pasting more detail.</p>
          ) : (spec.endpoints ?? []).map((ep, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-line bg-page px-2.5 py-1.5">
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-fg-2">{(ep.method ?? 'GET').toUpperCase()}</span>
              <span className="min-w-0 flex-1 truncate text-caption text-fg-2">{ep.name || ep.path}</span>
              <Button size="sm" variant="ghost" onClick={() => use(ep)}>Use</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Per-flow run-state cache — the automations section unmounts when you switch pages, which used to
// wipe the last run's outputs, publish statuses and viewport. Keyed by flow id and restored when the
// editor remounts, so coming back shows the exact same state and data. In-memory only by design (a
// browser refresh starts clean; the DB's automation_runs log is the durable record).
interface FlowRunState {
  lastRun: Record<string, RunOutputs>;
  postStatus: Record<string, 'posting' | 'posted' | 'scheduled' | 'failed'>;
  ranOk: boolean;
  view: { x: number; y: number; scale: number };
}
const flowRunStateCache = new Map<string, FlowRunState>();

function FlowEditor({ initial, userId, onSave, saveStatus, flows, activeId, onSelect, onCreate, onRename, onDelete, onToggleEnabled }: {
  initial: FlowRecord; userId: string | null;
  onSave: (graph: { nodes: FlowNode[]; edges: Edge[] }, enabled: boolean) => Promise<string | null>;
  saveStatus: SaveStatus;
  flows: AutomationMeta[]; activeId: string | null;
  onSelect: (id: string) => void; onCreate: () => void; onRename: (id: string, name: string) => void; onDelete: (id: string) => void;
  onToggleEnabled: (id: string, next: boolean) => void;
}) {
  const templateOptions = useTemplateOptions(userId);
  // Saved AI elements that accept data (inputSchema.length > 0) → options for the Element node; picking one
  // sets that node's input ports from the element's schema so upstream data can be mapped in.
  const { elements: customElements } = useCustomElements(userId);
  const elementOptions: ParamOption[] = useMemo(
    () => customElements.filter(e => e.inputSchema.length > 0).map(e => ({ name: e.name, value: e.id })),
    [customElements],
  );
  const { credentials, create: createCredential } = useCredentials(userId);
  // Scheduled-runs flag is owned by the flows list (so the header switch and the dropdown's per-flow
  // toggles stay in sync); fall back to the initial record before the meta is available.
  const enabled = flows.find(f => f.id === activeId)?.enabled ?? initial.enabled;
  const setEnabled = (next: boolean) => { if (activeId) onToggleEnabled(activeId, next); };
  const [nodes, setNodes] = useState<FlowNode[]>(initial.graph.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.graph.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [connect, setConnect] = useState<{ node: string; port: string } | null>(null);
  const [running, setRunning] = useState(false);
  // Run state initialises from the per-flow cache (FlowEditor is keyed by flow id, so `initial.id` is
  // stable for this mount) — switching sections and coming back restores outputs/statuses/viewport.
  const [ranOk, setRanOk] = useState(() => flowRunStateCache.get(initial.id)?.ranOk ?? false);
  const [runError, setRunError] = useState<{ message: string; nodeId?: string } | null>(null);
  // Per Post-node publish status, shown on the node square (posting → posted / scheduled / failed).
  const [postStatus, setPostStatus] = useState<Record<string, 'posting' | 'posted' | 'scheduled' | 'failed'>>(() => flowRunStateCache.get(initial.id)?.postStatus ?? {});
  const [chatOpen, setChatOpen] = useState(true);
  // A dynamic component being edited with AI — shown in the left panel (replacing the chat) while open.
  // Pre-fill prompt for the unified AI panel when "Edit with AI" is clicked on a dynamic component.
  const [chatSeed, setChatSeed] = useState<{ text: string; nonce: number } | null>(null);
  const chatSeedNonce = useRef(1);
  const [editTemplate, setEditTemplate] = useState<{ value: string; nodeId: string } | null>(null); // template being edited
  const [reloadKey, setReloadKey] = useState(0);                          // bumped after editing → refetch placeholders
  const [nodeRun, setNodeRun] = useState<{ id: string; loading: boolean; output?: unknown; error?: string } | null>(null);
  const [lastRun, setLastRun] = useState<Record<string, RunOutputs>>(() => flowRunStateCache.get(initial.id)?.lastRun ?? {}); // last outputs per node (test or flow run)

  // After a refresh the in-memory cache is empty — hydrate the last run's per-node output samples from
  // the persisted run log (automation_runs.log.nodes, written by the run/cron routes) so the canvas
  // still shows what flowed and the AI copilot keeps its grounding. Best-effort; live runs overwrite it.
  useEffect(() => {
    if (flowRunStateCache.has(initial.id) || !userId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('automation_runs')
        .select('log,status')
        .eq('automation_id', initial.id)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled || !data) return;
      const hydrated = lastRunFromLog((data.log as { nodes?: unknown } | null)?.nodes);
      if (Object.keys(hydrated).length) {
        setLastRun(prev => (Object.keys(prev).length ? prev : hydrated));
      }
    })();
    return () => { cancelled = true; };
     
  }, [initial.id, userId]);

  const canvasRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(1);
  const newId = () => `n${idRef.current++}_${nodes.length}`;
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);

  // ── Pan / zoom — the nodes + edges live in a transformed "world" layer; the dotted background pans &
  // zooms with it (via background-position/size) so nodes stay pinned to the dots, n8n-style.
  const [view, setView] = useState(() => flowRunStateCache.get(initial.id)?.view ?? { x: 0, y: 0, scale: 1 });
  // Mirror the run state into the cache as it changes (cheap Map.set; survives section switches).
  useEffect(() => {
    flowRunStateCache.set(initial.id, { lastRun, postStatus, ranOk, view });
  }, [initial.id, lastRun, postStatus, ranOk, view]);
  const pan = useRef<{ x0: number; y0: number; vx: number; vy: number } | null>(null);
  const panMoved = useRef(false);
  const screenToWorld = (sx: number, sy: number) => ({ x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale });
  const clampScale = (s: number) => Math.min(2, Math.max(0.35, s));
  // Zoom around a screen-space point (defaults to the viewport centre), keeping that point fixed.
  const zoomAt = useCallback((factor: number, center?: { x: number; y: number }) => {
    setView(v => {
      const scale = clampScale(v.scale * factor);
      if (scale === v.scale) return v;
      const rect = canvasRef.current?.getBoundingClientRect();
      const cx = center?.x ?? (rect ? rect.width / 2 : 0);
      const cy = center?.y ?? (rect ? rect.height / 2 : 0);
      const wx = (cx - v.x) / v.scale, wy = (cy - v.y) / v.scale;
      return { scale, x: cx - wx * scale, y: cy - wy * scale };
    });
  }, []);
  const resetView = () => setView({ x: 0, y: 0, scale: 1 });

  // Wheel: ctrl/⌘ zooms toward the cursor; otherwise pan. Attached non-passive so we can preventDefault.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el!.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.0015), { x: e.clientX - rect.left, y: e.clientY - rect.top });
      } else {
        setView(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const byId = new Map(nodes.map(n => [n.id, n]));
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const selectedDesc: NodeDescriptor | undefined = selected ? NODE_DESCRIPTORS[selected.type] : undefined;

  // Validate template nodes (select a template, then map its {placeholders}) — surfaced as an "i" badge
  // above the node and as a hard block on Run.
  const templateValues = nodes
    .filter(n => n.type === 'template')
    .map(n => (typeof n.config?.templateId === 'string' ? n.config.templateId : ''))
    .filter(Boolean);
  const placeholdersByValue = useTemplatePlaceholders(templateValues, reloadKey);
  const flowElements = useFlowElements(templateValues, reloadKey);   // dynamic components the AI can edit
  const issues = new Map<string, TemplateIssue>();
  // incomingData (declared below) is hoisted; a node "has data" once an upstream node has run.
  for (const n of nodes) { const iss = templateIssue(n, placeholdersByValue, incomingData(n.id) !== undefined); if (iss) issues.set(n.id, iss); }

  function pointInCanvas(clientX: number, clientY: number) {
    const r = canvasRef.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  }

  function onNodePointerDown(e: ReactPointerEvent, node: FlowNode) {
    e.stopPropagation();
    const p = pointInCanvas(e.clientX, e.clientY);
    const w = screenToWorld(p.x, p.y);
    drag.current = { id: node.id, dx: w.x - (node.x ?? 0), dy: w.y - (node.y ?? 0), moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  // Empty-canvas drag pans the whole world. Nodes/ports stop propagation on pointer-down, so reaching
  // here means the background was grabbed.
  function onCanvasPointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    panMoved.current = false;
    pan.current = { x0: e.clientX, y0: e.clientY, vx: view.x, vy: view.y };
    canvasRef.current?.setPointerCapture?.(e.pointerId);
  }
  function onCanvasPointerMove(e: ReactPointerEvent) {
    if (pan.current) {
      const { x0, y0, vx, vy } = pan.current;
      if (Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) > 2) panMoved.current = true;
      setView(v => ({ ...v, x: vx + (e.clientX - x0), y: vy + (e.clientY - y0) }));
      return;
    }
    if (!drag.current) return;
    drag.current.moved = true;
    const p = pointInCanvas(e.clientX, e.clientY);
    const w = screenToWorld(p.x, p.y);
    const { id, dx, dy } = drag.current;
    setNodes(ns => ns.map(n => (n.id === id ? { ...n, x: w.x - dx, y: w.y - dy } : n)));
  }
  function onCanvasPointerUp() { drag.current = null; pan.current = null; }
  function onNodeClick(node: FlowNode) {
    if (drag.current?.moved) return; // ignore the click that ends a drag
    setSelectedId(node.id);
  }

  function addNode(type: string, at: { x: number; y: number }) {
    const w = screenToWorld(at.x, at.y);   // `at` is the menu's screen position; place the node in world space
    setNodes(ns => [...ns, instantiate(type, newId(), w.x - NODE_W / 2, w.y - HEAD_H) as FlowNode]);
    setMenu(null);
  }
  function deleteNode(id: string) {
    setNodes(ns => ns.filter(n => n.id !== id));
    setEdges(es => es.filter(e => e.from.node !== id && e.to.node !== id));
    if (selectedId === id) setSelectedId(null);
  }
  function setConfig(id: string, key: string, value: unknown) {
    setNodes(ns => ns.map(n => {
      if (n.id !== id) return n;
      const next: FlowNode = { ...n, config: { ...(n.config ?? {}), [key]: value } };
      // Picking the Element node's element → derive its input ports from that element's data schema.
      if (n.type === 'element' && key === 'elementId') {
        const el = customElements.find(e => e.id === value);
        next.inputs = (el?.inputSchema ?? []).map(i => ({ id: i.key, name: i.label, dataType: elementDataType(i.dataType) }));
      }
      return next;
    }));
  }

  function startConnect(node: string, port: string) {
    // Pressing the armed dot again cancels; pressing a dot that already has an arrow unplugs it (that's
    // the only way to remove an edge). Otherwise arm this output as the start of a new connection.
    if (connect?.node === node && connect.port === port) { setConnect(null); return; }
    if (edges.some(e => e.from.node === node && e.from.port === port)) {
      setEdges(es => es.filter(e => !(e.from.node === node && e.from.port === port)));
      setConnect(null);
      return;
    }
    setConnect({ node, port });
  }
  function finishConnect(toNode: string, toPort: string) {
    if (!connect || connect.node === toNode) {
      // No pending connection → pressing a connected input dot unplugs its arrow(s).
      if (!connect) setEdges(es => es.filter(e => !(e.to.node === toNode && e.to.port === toPort)));
      setConnect(null);
      return;
    }
    const from = byId.get(connect.node);
    const to = byId.get(toNode);
    const outType = from?.outputs.find(p => p.id === connect.port)?.dataType;
    const inType = to?.inputs.find(p => p.id === toPort)?.dataType;
    if (outType && inType && canConnect(outType, inType)) {
      setEdges(es => {
        const id = `${connect.node}.${connect.port}->${toNode}.${toPort}`;
        return es.some(e => e.id === id) ? es : [...es, { id, from: { node: connect.node, port: connect.port }, to: { node: toNode, port: toPort } }];
      });
    }
    setConnect(null);
  }

  // The JSON response of nodes connected INTO `nodeId` that have a (test or flow) run. One source →
  // its data; multiple → an object keyed by source-node label. Undefined if nothing has run yet.
  function incomingData(nodeId: string): unknown {
    // Labels are deduped ("HTTP request", "HTTP request 2") per source in edge order, EXACTLY like
    // the engine (graph.ts sourceLabels + serverNodes mergedInput) — binding paths picked from this
    // tree must resolve identically at run time.
    const parts: { label: string; data: unknown }[] = [];
    const used = new Map<string, number>();
    const seenSources = new Set<string>();
    for (const e of edges) {
      if (e.to.node !== nodeId || seenSources.has(e.from.node)) continue;
      seenSources.add(e.from.node);
      // Count the label for EVERY distinct source (run or not) so numbering matches the engine,
      // where all upstreams have always run by the time labels are assigned.
      const src = byId.get(e.from.node);
      const base = src?.label || (src ? NODE_DESCRIPTORS[src.type]?.label : undefined) || e.from.node;
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      const out = lastRun[e.from.node];
      if (!out) continue;
      const firstPort = out.out ?? out[Object.keys(out)[0]];
      const json = firstPort?.[0]?.json;
      const data = json && typeof json === 'object' && 'data' in json ? (json as Record<string, unknown>).data : json;
      parts.push({ label: n === 1 ? base : `${base} ${n}`, data });
    }
    if (parts.length === 0) return undefined;
    if (parts.length === 1) return parts[0].data;
    const root: Record<string, unknown> = {};
    for (const p of parts) root[p.label] = p.data;
    return root;
  }

  // ALL items arriving on a node's input from a SINGLE upstream — for the node modal's input column.
  // incomingData (above) deliberately mirrors the per-item runtime view (first item = what one
  // execution's ctx.input/bindings see); this is the "whole stream" view so a fan-out (e.g. a code
  // node returning an array of candles) is visible as N items instead of silently showing item 1.
  // Fan-in (2+ sources) keeps the merged single view — undefined here.
  function incomingItems(nodeId: string): unknown[] | undefined {
    const sources = [...new Set(edges.filter(e => e.to.node === nodeId).map(e => e.from.node))];
    if (sources.length !== 1) return undefined;
    const out = lastRun[sources[0]];
    if (!out) return undefined;
    const firstPort = out.out ?? out[Object.keys(out)[0]];
    if (!firstPort?.length) return undefined;
    return firstPort.map(it => {
      const json = it?.json;
      return json && typeof json === 'object' && 'data' in json ? (json as Record<string, unknown>).data : json;
    });
  }

  // Apply a graph the AI chat panel produced (replaces the canvas, clears stale run state).
  function applyGenerated(g: { nodes: FlowNode[]; edges: Edge[] }) {
    setNodes(g.nodes); setEdges(g.edges);
    // Keep the node popup open when its node survived the AI edit (ids are preserved server-side) —
    // the whole point of the side-by-side layout is prompting the AI ABOUT the open node.
    setSelectedId(prev => (prev && g.nodes.some(n => n.id === prev) ? prev : null));
    setLastRun({}); setRunError(null); setRanOk(false);
  }

  // The last run's real per-node data rides along to the AI chat so it grounds diagnoses/fixes in what
  // actually happened instead of guessing shapes: per node, what it RECEIVED (incomingData — exactly what
  // ctx.input / bindings see, engine-identical) and what it EMITTED (raw output), or the run error.
  // Applying an AI graph clears lastRun, which used to leave every follow-up "still broken" turn blind —
  // so the previous report is kept and sent marked stale until a fresh run replaces it.
  const staleChatReportRef = useRef<Array<{ id: string; label: string; received?: unknown; output?: unknown; outputItems?: number; error?: string; stale?: boolean }>>([]);
  function chatRunOutputs(): Array<{ id: string; label: string; received?: unknown; output?: unknown; outputItems?: number; error?: string; stale?: boolean }> {
    const rows: Array<{ id: string; label: string; received?: unknown; output?: unknown; outputItems?: number; error?: string; stale?: boolean }> = [];
    for (const n of nodes) {
      const label = n.label ?? n.type;
      const received = incomingData(n.id);
      if (runError?.nodeId === n.id) { rows.push({ id: n.id, label, received, error: runError.message }); continue; }
      const out = lastRun[n.id];
      if (!out && received === undefined) continue;   // nothing ran anywhere near this node — nothing to report
      const firstPort = out ? (out.out ?? out[Object.keys(out)[0]]) : undefined;
      // `id` lets the server join a row to its node exactly (labels are fuzzy — unlabeled nodes collide).
      // `outputItems` (count) rides along so the copilot knows a fan-out happened — the sample is item
      // 1 of N, and downstream nodes run once per item (the "why is my chart one point" class of bug).
      rows.push({ id: n.id, label, received, ...(out ? { output: firstPort?.[0]?.json, outputItems: firstPort?.length ?? 0 } : {}) });
    }
    if (rows.length > 0) { staleChatReportRef.current = rows.map(r => ({ ...r, stale: true })); return rows; }
    return staleChatReportRef.current;
  }

  async function handleSave() { await onSave({ nodes, edges }, enabled); }

  async function runFlow() {
    // Only a missing template blocks the run (you must run to GET the data needed to map placeholders).
    const blocked = nodes.find(n => issues.get(n.id)?.kind === 'no-template');
    if (blocked) {
      setSelectedId(blocked.id);
      setRunError({ message: issueMessage(issues.get(blocked.id)!), nodeId: blocked.id });
      return;
    }
    setRunning(true); setRunError(null); setRanOk(false); setPostStatus({});
    // Persist first so the run log can reference this flow (and we run the just-saved graph). A refused
    // save (optimistic-lock conflict with another tab/session, or a plain failure) must ABORT the run:
    // running-and-publishing an unsaved graph while the stored one diverges is exactly the confusion
    // the lock exists to prevent. The Save button explains the conflict; a deliberate re-save overrides.
    const id = await onSave({ nodes, edges }, enabled);
    if (!id) {
      setRunError({ message: 'This flow couldn’t be saved (it may have been changed in another tab) — resolve the save first, then run.' });
      setRunning(false);
      return;
    }
    try {
      const res = await authedFetch('/api/automations/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          graph: { nodes, edges }, automationId: id ?? activeId ?? undefined,
          // runToken: fresh per click — the server refuses to publish the same token twice, so a retry
          // after a lost response can't double-post. tz: interprets legacy Post configs' offset-less
          // scheduledFor in THIS browser's zone (configs saved before tz-capture carry no cfg.tz).
          runToken: crypto.randomUUID(),
          tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })(),
        }),
      });
      const data = await res.json();
      // Merge whatever completed (full success, or the partial outputs before a failure) → those nodes
      // turn green; the failing node (data.nodeId) goes red.
      if (data.outputs) setLastRun(prev => ({ ...prev, ...data.outputs }));
      if (!res.ok) { setRunError({ message: data.error || 'Run failed', nodeId: data.nodeId }); return; }
      // Publishing happened SERVER-side (same headless path as scheduled runs — serverPublish), so the
      // run completes even if this tab closes. We just paint the per-node outcomes it reported.
      const publish = data.publish as { published: number; errors: string[]; statusByNode: Record<string, 'posted' | 'scheduled' | 'failed'> } | undefined;
      if (publish) {
        setPostStatus(publish.statusByNode ?? {});
        if (publish.errors?.length) { setRunError({ message: publish.errors.join(' · ') }); return; }
      }
      setRanOk(true);
    } catch (e) {
      setRunError({ message: e instanceof Error ? e.message : 'Run failed' });
    } finally {
      setRunning(false);
    }
  }

  // Partial run for the node modal ("execute step" / "execute previous nodes"): the server runs ONLY
  // the target and its transitive upstreams (engine runGraphUpTo) — real grounded data lands in
  // lastRun for the modal's input/output columns, and nothing downstream (esp. no publishing) fires.
  const [runningTo, setRunningTo] = useState<string | null>(null);
  async function runUpTo(targetId: string) {
    setRunningTo(targetId); setRunError(null);
    const id = await onSave({ nodes, edges }, enabled);
    if (!id) {
      setRunError({ message: 'This flow couldn’t be saved (it may have been changed in another tab) — resolve the save first, then run.' });
      setRunningTo(null);
      return;
    }
    try {
      const res = await authedFetch('/api/automations/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph: { nodes, edges }, automationId: id, targetId }),
      });
      const data = await res.json();
      if (data.outputs) setLastRun(prev => ({ ...prev, ...data.outputs }));
      if (!res.ok) setRunError({ message: data.error || 'Run failed', nodeId: data.nodeId });
    } catch (e) {
      setRunError({ message: e instanceof Error ? e.message : 'Run failed' });
    } finally {
      setRunningTo(null);
    }
  }

  async function runNode(node: FlowNode) {
    setNodeRun({ id: node.id, loading: true });
    try {
      const res = await authedFetch('/api/automations/run-node', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: node.type, config: node.config ?? {} }),
      });
      const data = await res.json();
      if (res.ok) { setNodeRun({ id: node.id, loading: false, output: data.outputs }); setLastRun(prev => ({ ...prev, [node.id]: data.outputs })); }
      else setNodeRun({ id: node.id, loading: false, error: data.error || 'Run failed' });
    } catch (e) {
      setNodeRun({ id: node.id, loading: false, error: e instanceof Error ? e.message : 'Run failed' });
    }
  }

  // 'conflict' = another session/tab saved this flow since we loaded it; the first save is refused and
  // the lock token refreshed, so clicking again is a deliberate overwrite.
  const saveLabel = saveStatus === 'saving' ? 'Saving…'
    : saveStatus === 'saved' ? 'Saved'
    : saveStatus === 'error' ? 'Retry save'
    : saveStatus === 'conflict' ? 'Changed elsewhere — save again to overwrite'
    : 'Save';

  return (
    <div className="relative flex h-screen bg-page text-fg">
      {/* AI chat dock (left) — Lovable/v0-style conversational flow builder. */}
      {chatOpen && (
        <ChatPanel
          graph={{ nodes, edges }}
          elements={flowElements.map(e => ({ feId: e.feId, name: e.name, inputs: e.inputs, code: e.code }))}
          runOutputs={chatRunOutputs()}
          // The agentic builder finds the data source itself; it only needs the credential creator so a
          // mid-build API-key request can be stored encrypted and the build resumed.
          onCreateCredential={createCredential}
          onApply={applyGenerated}
          onApplyElement={async (feId, code) => {
            const el = flowElements.find(e => e.feId === feId);
            if (!el) throw new Error('That element is no longer in the flow’s templates.');
            await applyElementCode(el.templateValue, feId, el.elementId, code);   // throws on save failure
            setReloadKey(k => k + 1);
          }}
          seed={chatSeed}
          onClose={() => setChatOpen(false)}
        />
      )}

      {/* Template editor overlay — covers the nodes canvas AND the right config dock, but NOT the AI
          dock (left), so the chat stays usable for element/node edits while editing the template. On
          close, refresh placeholders/preview. refreshKey remounts its embedded editor after an AI
          element edit so it refetches the updated slides instead of overwriting them with stale state. */}
      {editTemplate && (
        <TemplateEditModal
          templateValue={editTemplate.value}
          userId={userId}
          leftInset={chatOpen ? 340 : 0}
          refreshKey={reloadKey}
          chatOpen={chatOpen}
          onOpenChat={() => setChatOpen(true)}
          data={incomingData(editTemplate.nodeId)}
          bindings={(byId.get(editTemplate.nodeId)?.config?.bindings as Record<string, string> | undefined) ?? {}}
          onBindingsChange={b => setConfig(editTemplate.nodeId, 'bindings', b)}
          onClose={(latestSlides) => {
            // Seed the fresh slides so the mapping panel updates instantly — a refetch would race
            // the editor's debounced autosave and show the pre-edit template (until a page refresh).
            if (latestSlides?.length && editTemplate) editedSlidesCache.set(editTemplate.value, { slides: latestSlides, at: Date.now() });
            setEditTemplate(null);
            setReloadKey(k => k + 1);
          }}
        />
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="relative flex items-center gap-3 border-b border-line px-4" style={{ height: 52 }}>
          <span className="text-caption text-fg-3">{nodes.length} nodes</span>
          {!chatOpen && (
            <Button size="sm" variant="ghost" onClick={() => setChatOpen(true)} leadingIcon={<span className="brightness-0 invert">✨</span>}>
              Build with AI
            </Button>
          )}
          {/* Centered name dropdown — switch / new / rename / delete (matches the template editor). */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto">
              <FlowSwitcher flows={flows} activeId={activeId} onSelect={onSelect} onCreate={onCreate} onRename={onRename} onDelete={onDelete} onToggleEnabled={onToggleEnabled} />
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-1.5" title="Run automatically on the trigger's schedule (hourly cron sweep).">
              <span className="text-caption text-fg-3">{enabled ? 'On' : 'Off'}</span>
              <Switch checked={enabled} onChange={setEnabled} label="Enable scheduled runs" />
            </div>
            <Button size="sm" variant="secondary" loading={saveStatus === 'saving'} onClick={handleSave}>{saveLabel}</Button>
            <Button size="sm" variant="primary" loading={running} onClick={runFlow}>Run</Button>
          </div>
        </div>

        {runError && (
          <div className="flex items-center gap-2 border-b border-danger-border bg-danger-tint px-4 py-2 text-caption text-danger-text">
            <span className="font-semibold">Run failed:</span> {runError.message}
          </div>
        )}
        {ranOk && !runError && (
          <div className="flex items-center gap-2 border-b border-success-border bg-success-tint px-4 py-2 text-caption text-success-text">
            <span className="font-semibold">Run complete.</span> Template nodes wrote posts you can open in the editor.
          </div>
        )}

        {/* Canvas */}
        <div
          ref={canvasRef}
          className="relative flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
          style={{
            backgroundImage: `radial-gradient(var(--canvas-dot, rgba(255,255,255,0.16)) ${1.1 * view.scale}px, transparent ${1.1 * view.scale}px)`,
            backgroundSize: `${28 * view.scale}px ${28 * view.scale}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onContextMenu={e => { e.preventDefault(); const r = canvasRef.current?.getBoundingClientRect(); const x = e.clientX - (r?.left ?? 0); const y = e.clientY - (r?.top ?? 0); setMenu({ x: Math.min(x, (r?.width ?? 9999) - 210), y }); }}
          onClick={() => { if (panMoved.current) { panMoved.current = false; return; } setMenu(null); setConnect(null); setSelectedId(null); }}
        >
          {/* World layer — nodes + edges pan/zoom together. */}
          <div className="absolute inset-0 origin-top-left will-change-transform" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          {/* Edges */}
          <svg className="pointer-events-none absolute inset-0 h-full w-full" style={{ overflow: 'visible' }}>
            {edges.map(edge => {
              const a = byId.get(edge.from.node); const b = byId.get(edge.to.node);
              if (!a || !b) return null;
              const ax = a.x ?? 0, ay = a.y ?? 0, bx = b.x ?? 0, by = b.y ?? 0;
              const x1 = ax + NODE_W, y1 = ay + portCenterY(a, a.outputs, edge.from.port);
              const x2 = bx, y2 = by + portCenterY(b, b.inputs, edge.to.port);
              // Orthogonal, sharp-cornered route, dashed + flowing like the landing-page connectors, taking
              // the shortest path that never runs under a node square. Whenever the target is even slightly
              // to the right there's a gap, so a simple elbow (right → down/up → right) sits in it. Only
              // when the target is left of / overlapping the source do we detour: loop out, run along a
              // channel clear of BOTH squares heading toward the target's side (down if it's lower, up if
              // higher — so it never doubles back the wrong way), then come in. Arrowhead stays solid.
              const S = 22;
              let d: string;
              if (x2 - x1 >= 14) {
                const midX = (x1 + x2) / 2;
                d = `M${x1},${y1} H${midX} V${y2} H${x2}`;
              } else {
                const margin = 22;
                const aTop = ay, aBot = ay + nodeSquare(a);
                const bTop = by, bBot = by + nodeSquare(b);
                // Prefer threading the clear vertical gap between the squares (approach straight from the
                // source's side); only wrap fully above/below when they actually overlap vertically.
                const channelY =
                  bTop - aBot >= margin ? (aBot + bTop) / 2 :                      // target below, gap → thread it
                  aTop - bBot >= margin ? (bBot + aTop) / 2 :                      // target above, gap → thread it
                  y2 >= y1 ? Math.max(aBot, bBot) + margin : Math.min(aTop, bTop) - margin;  // overlap → wrap clear
                d = `M${x1},${y1} H${x1 + S} V${channelY} H${x2 - S} V${y2} H${x2}`;
              }
              return (
                <g key={edge.id} className="text-fg-4">
                  <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 3" strokeLinecap="round" strokeLinejoin="round" className="de-dash-flow" />
                </g>
              );
            })}
          </svg>

          {/* Nodes */}
          {nodes.map(node => {
            const desc = NODE_DESCRIPTORS[node.type];
            if (!desc) return null;
            const isSel = node.id === selectedId;
            return (
              <div
                key={node.id}
                onPointerDown={e => onNodePointerDown(e, node)}
                onClick={e => { e.stopPropagation(); onNodeClick(node); }}
                className={`group absolute flex cursor-grab flex-col rounded-xl border p-3.5 shadow-1 active:cursor-grabbing ${
                  issues.has(node.id)
                    ? 'border-warning-border bg-warning-tint'
                    : `bg-surface-2 ${runError?.nodeId === node.id ? 'border-danger-border' : lastRun[node.id] ? 'border-success-border' : isSel ? 'border-fg-3' : 'border-line'}`
                }`}
                style={{ left: node.x ?? 0, top: node.y ?? 0, width: NODE_W, height: Math.max(nodeHeight(node), NODE_W) }}
              >
                {/* Needs-setup warning — select a template / map its placeholders before the flow can run.
                    Clears automatically once the issue is resolved (the node leaves the issues map). */}
                {issues.has(node.id) && (
                  <button
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); setSelectedId(node.id); }}
                    title={issueMessage(issues.get(node.id)!)}
                    aria-label={issueMessage(issues.get(node.id)!)}
                    className="absolute -top-3 left-1/2 z-10 -translate-x-1/2 text-warning hover:brightness-110"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" aria-hidden>
                      <path d="M12 3 22.5 21H1.5L12 3Z" strokeWidth="1.5" strokeLinejoin="round" />
                      <path d="M12 10v4.2" stroke="#000" strokeWidth="2" strokeLinecap="round" fill="none" />
                      <circle cx="12" cy="17.6" r="1.15" fill="#000" stroke="none" />
                    </svg>
                  </button>
                )}
                {/* Top row: icon left · status dot / hover-delete right (the whole square is draggable) */}
                <div className="flex items-start justify-between">
                  <span className="text-fg-2"><NodeIcon name={desc.icon} /></span>
                  <span className="relative grid size-6 place-items-center">
                    <span className={`size-1.5 rounded-full transition-opacity group-hover:opacity-0 ${runError?.nodeId === node.id ? 'bg-danger' : lastRun[node.id] ? 'bg-success' : 'bg-fg-4'}`} title="Status" />
                    <button aria-label="Delete node"
                      onPointerDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); deleteNode(node.id); }}
                      className="absolute inset-0 grid place-items-center rounded-md text-fg-4 opacity-0 transition-opacity hover:bg-hover hover:text-fg group-hover:opacity-100 focus-ring">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
                    </button>
                  </span>
                </div>

                {/* Bottom block: group · title · description (or live publish status for a Post node) */}
                <div className="mt-auto min-w-0">
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-4">{desc.group}</span>
                  <div className="mt-0.5 truncate text-[13px] font-semibold leading-tight text-fg">{node.label ?? desc.label}</div>
                  {node.type === 'post' && postStatus[node.id] ? (
                    <div className="mt-1.5">
                      {postStatus[node.id] === 'posting' && <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-fg-2"><Spinner size="sm" /> Posting…</span>}
                      {postStatus[node.id] === 'posted' && <Badge tone="success">Posted</Badge>}
                      {postStatus[node.id] === 'scheduled' && <Badge tone="accent">Scheduled</Badge>}
                      {postStatus[node.id] === 'failed' && <Badge tone="danger">Failed</Badge>}
                    </div>
                  ) : (
                    desc.description && <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-fg-3">{desc.description}</div>
                  )}
                </div>

                {/* Input dots */}
                {node.inputs.map(p => (
                  <button key={p.id} aria-label={`Input ${p.name}`} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); finishConnect(node.id, p.id); }}
                    className="absolute rounded-full border-2 border-line bg-surface-1 hover:scale-110"
                    style={{ width: DOT, height: DOT, left: -DOT / 2, top: portCenterY(node, node.inputs, p.id) - DOT / 2, borderColor: dataTypeColor(p.dataType) }} />
                ))}
                {/* Output dots */}
                {node.outputs.map(p => {
                  const armed = connect?.node === node.id && connect?.port === p.id;
                  return (
                    <button key={p.id} aria-label={`Output ${p.name}`} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); startConnect(node.id, p.id); }}
                      className="absolute rounded-full border-2 hover:scale-110"
                      style={{ width: DOT, height: DOT, left: NODE_W - DOT / 2, top: portCenterY(node, node.outputs, p.id) - DOT / 2, borderColor: dataTypeColor(p.dataType), background: armed ? dataTypeColor(p.dataType) : 'var(--surface-1)' }} />
                  );
                })}
              </div>
            );
          })}

          {/* Arrowheads — drawn after the nodes so each solid triangle sits ABOVE the receiving node's
              input circle in z-order (otherwise the circle paints over the arrow tip). */}
          <svg className="pointer-events-none absolute inset-0 h-full w-full text-fg-4" style={{ overflow: 'visible' }}>
            {edges.map(edge => {
              const b = byId.get(edge.to.node);
              if (!byId.get(edge.from.node) || !b) return null;
              const x2 = b.x ?? 0, y2 = (b.y ?? 0) + portCenterY(b, b.inputs, edge.to.port);
              return <path key={edge.id} d={`M${x2 - 7},${y2 - 4.5} L${x2},${y2} L${x2 - 7},${y2 + 4.5} Z`} fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />;
            })}
          </svg>
          </div>{/* end world layer */}

          {/* Add-node context menu */}
          {menu && (
            <div className="absolute z-10 w-52 overflow-hidden rounded-lg border border-line bg-surface-overlay shadow-3 backdrop-blur-sm" style={{ left: menu.x, top: menu.y }} onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
              <div className="border-b border-line px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-fg-4">Add node</div>
              <div className="max-h-80 overflow-y-auto py-1">
                {DESCRIPTOR_LIST.map(d => (
                  <button key={d.type} onClick={() => addNode(d.type, menu)} className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-caption text-fg-2 hover:bg-hover hover:text-fg">
                    <span className="text-fg-3"><NodeIcon name={d.icon} size={15} /></span>
                    <span className="flex-1 truncate">{d.label}</span>
                    <span className="text-[9px] uppercase tracking-wide text-fg-4">{d.group}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <p className="text-body text-fg-3">Right-click to add your first node.</p>
            </div>
          )}
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-line bg-surface-overlay px-3 py-1 text-caption text-fg-3 backdrop-blur-sm">
            Right-click to add · drag a right dot then click a left dot to connect · click a node to configure
          </div>

          {/* Zoom controls — matches the editors' bottom-left ZoomControl theme */}
          <div
            className="absolute bottom-4 left-4 z-10 flex items-center gap-0.5 rounded-xl border border-line bg-surface-1 p-1 shadow-2 select-none"
            onPointerDown={e => e.stopPropagation()}
          >
            <button onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out" className="flex size-7 items-center justify-center rounded-lg text-fg-2 transition-colors focus-ring hover:bg-hover hover:text-fg">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M5 12h14" /></svg>
            </button>
            <button onClick={resetView} aria-label="Reset zoom" title="Reset zoom" className="h-7 min-w-[3.25rem] rounded-lg px-1 text-label tabular-nums text-fg-2 transition-colors focus-ring hover:bg-hover hover:text-fg">
              {Math.round(view.scale * 100)}%
            </button>
            <button onClick={() => zoomAt(1.2)} aria-label="Zoom in" className="flex size-7 items-center justify-center rounded-lg text-fg-2 transition-colors focus-ring hover:bg-hover hover:text-fg">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>
        </div>
      </div>

      {/* Node detail modal — n8n-style: input (left) · parameters (centre) · output (right). Opens
          centred over the canvas when a node is clicked; both data columns ground on the same lastRun
          map the canvas uses, and "execute" runs the flow up to this node (runGraphUpTo server-side —
          real upstream data, never a publish). */}
      {selected && selectedDesc && (
        <NodeDetailModal
          node={selected}
          descriptor={selectedDesc}
          input={incomingData(selected.id)}
          inputItems={incomingItems(selected.id)}
          output={lastRun[selected.id]}
          running={runningTo === selected.id}
          nodeRun={nodeRun?.id === selected.id ? nodeRun : null}
          postStatus={postStatus[selected.id]}
          runError={runError?.nodeId === selected.id ? runError.message : null}
          leftInset={chatOpen ? 340 : 0}
          onExecute={() => runUpTo(selected.id)}
          onTestIsolated={selected.type !== 'template' && selected.type !== 'post' ? () => runNode(selected) : undefined}
          onClose={() => setSelectedId(null)}
        >
          {selectedDesc.description && <p className="mb-4 text-caption text-fg-3">{selectedDesc.description}</p>}
          {selected.type !== 'post' && (
            <ConfigPanel descriptor={selectedDesc} config={selected.config ?? {}} onChange={(k, v) => setConfig(selected.id, k, v)} dynamicOptions={{ templates: templateOptions, elements: elementOptions }} credentials={credentials} onCreateCredential={createCredential} />
          )}
          {selected.type === 'post' && (
            <PostNodeConfig node={selected} nodes={nodes} edges={edges} userId={userId} runOutputs={lastRun} onChange={(k, v) => setConfig(selected.id, k, v)} />
          )}
          {selected.type === 'http' && (
            <HttpDocsImport onApply={patch => { for (const [k, v] of Object.entries(patch)) setConfig(selected.id, k, v); }} />
          )}
          {selected.type === 'template' && (
            <TemplateBindings
              templateValue={typeof selected.config?.templateId === 'string' ? (selected.config.templateId as string) : undefined}
              data={incomingData(selected.id)}
              bindings={(selected.config?.bindings as Record<string, string> | undefined) ?? {}}
              onChange={b => setConfig(selected.id, 'bindings', b)}
              reloadKey={reloadKey}
              onEdit={() => { const v = selected.config?.templateId; if (typeof v === 'string' && v) setEditTemplate({ value: v, nodeId: selected.id }); }}
              onEditElement={(el) => { setChatOpen(true); setChatSeed({ text: `Edit the "${el.name}" element: `, nonce: chatSeedNonce.current++ }); }}
            />
          )}
        </NodeDetailModal>
      )}
    </div>
  );
}

// ── Node detail modal ─────────────────────────────────────────────────────────
// n8n-style three-column node view: INPUT (what arrives on the node's input ports — exactly what a
// code node's ctx.input / a template's bindings see), PARAMETERS (the node's config — the children
// slot, i.e. everything the old right dock rendered), OUTPUT (what the node emitted on its last run).
// "Execute step" runs the flow UP TO this node server-side, so both columns fill with real data.

function DataColumnEmpty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-fg-4" aria-hidden>
        <path d="M4 12h12M12 6l6 6-6 6" /><path d="M20 4v16" />
      </svg>
      <p className="text-body font-medium text-fg-2">{title}</p>
      {action}
      {hint && <p className="text-caption text-fg-4">{hint}</p>}
    </div>
  );
}

function DataJson({ value }: { value: unknown }) {
  return (
    <pre className="min-h-0 flex-1 overflow-auto p-4 text-[11px] leading-relaxed text-fg-2">{JSON.stringify(value, null, 2)}</pre>
  );
}

function NodeDetailModal({ node, descriptor, input, inputItems, output, running, nodeRun, postStatus, runError, leftInset = 0, onExecute, onTestIsolated, onClose, children }: {
  node: FlowNode;
  descriptor: NodeDescriptor;
  /** Viewport px left of the modal (the AI chat dock when open) — the modal shifts right and leaves
   *  that strip uncovered + interactive, so the user can prompt the AI with the node popup open. */
  leftInset?: number;
  input: unknown;                       // merged upstream data (incomingData) — undefined until upstreams ran
  /** The FULL incoming item stream (single-upstream only) — when >1, the node runs once per item. */
  inputItems?: unknown[];
  output: RunOutputs | undefined;       // this node's lastRun entry
  running: boolean;                     // an execute-up-to-here is in flight
  nodeRun: { loading: boolean; error?: string } | null; // transient isolated-test state for THIS node
  postStatus?: 'posting' | 'posted' | 'scheduled' | 'failed';
  runError: string | null;              // last flow-run error attributed to this node
  onExecute: () => void;
  onTestIsolated?: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  // Fade out before unmount, mirroring the shared ui/Modal: closing swaps to the -out animation
  // classes, and the parent's onClose fires once the exit has played. 170ms matches Modal's EXIT_MS.
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestClose = useCallback(() => {
    if (closeTimer.current) return; // already closing
    setClosing(true);
    closeTimer.current = setTimeout(onClose, 170);
  }, [onClose]);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  // Escape closes (listener on the window so focus anywhere in the modal counts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  const hasInputPorts = node.inputs.length > 0;
  const hasOutputPorts = node.outputs.length > 0;
  const testError = nodeRun && !nodeRun.loading ? nodeRun.error : undefined;
  const busy = running || !!nodeRun?.loading;

  return (
    // pointer-events-none on the wrapper + auto on backdrop/card: with the AI dock open the wrapper
    // starts to its right (style.left), and the uncovered strip stays fully interactive — prompt the
    // AI while the popup is up. left transitions so toggling the dock slides the modal over smoothly.
    <div
      className={`fixed inset-y-0 right-0 z-[900] flex items-center justify-center p-4 transition-[left] duration-200 ease-out sm:p-8 ${closing ? 'de-overlay-out' : 'de-overlay-in'} pointer-events-none`}
      style={{ left: leftInset }}
      role="dialog" aria-modal="true" aria-label={`${node.label ?? descriptor.label} node`}
    >
      {/* Backdrop — click to close. Plain scrim, deliberately NO backdrop-blur: backdrop-filter
          re-composites the whole canvas beneath on every repaint (e.g. scrolling the code editor),
          which showed up as page-wide flicker. Same scrim token as the shared ui/Modal. */}
      <button aria-label="Close" onClick={requestClose} className="pointer-events-auto absolute inset-0 cursor-default bg-[var(--scrim)]" />
      <div className={`pointer-events-auto relative flex h-full max-h-[860px] w-full max-w-[1280px] flex-col overflow-hidden rounded-2xl border border-line bg-surface-1 shadow-3 ${closing ? 'de-dialog-out' : 'de-dialog-in'}`}>
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4" style={{ height: 52 }}>
          <span className="text-fg-2"><NodeIcon name={descriptor.icon} /></span>
          <span className="text-label font-semibold text-fg">{node.label ?? descriptor.label}</span>
          <Badge tone="neutral">{descriptor.group}</Badge>
          <button aria-label="Close" onClick={requestClose} className="ml-auto grid size-7 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg focus-ring">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* INPUT column */}
          <div className="hidden w-[360px] shrink-0 flex-col border-r border-line bg-page/50 md:flex">
            <div className="shrink-0 border-b border-line px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-3">Input</div>
            {!hasInputPorts ? (
              <DataColumnEmpty title="This node starts the flow" hint="Triggers have no input data." />
            ) : inputItems && inputItems.length > 1 ? (
              <>
                <div className="shrink-0 border-b border-line bg-warning-tint px-4 py-2 text-caption leading-snug text-warning-text">
                  {inputItems.length} items — this node runs once PER item ({node.type === 'template' ? 'one generated post per item' : 'ctx.input sees one item at a time'}).
                  Want everything in one pass (e.g. a whole chart series)? Have the upstream return an object holding the array instead of a bare array.
                </div>
                <DataJson value={inputItems} />
              </>
            ) : input !== undefined ? (
              <DataJson value={input} />
            ) : (
              <DataColumnEmpty
                title="No input data yet"
                hint="Runs the flow up to this node so you can see the real data it receives."
                action={<Button size="sm" variant="secondary" loading={running} onClick={onExecute}>Execute previous nodes</Button>}
              />
            )}
          </div>

          {/* PARAMETERS column (the old dock content rides in via children) */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-3">Parameters</span>
              <Button size="sm" loading={busy} onClick={onExecute}>Execute step</Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {runError && <Alert tone="danger" className="mb-4">{runError}</Alert>}
              {children}
            </div>
          </div>

          {/* OUTPUT column */}
          <div className="hidden w-[360px] shrink-0 flex-col border-l border-line bg-page/50 lg:flex">
            <div className="shrink-0 border-b border-line px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-3">Output</div>
            {node.type === 'post' ? (
              <DataColumnEmpty
                title={postStatus === 'posted' ? 'Posted' : postStatus === 'scheduled' ? 'Scheduled' : postStatus === 'failed' ? 'Publish failed' : 'Publishes on run'}
                hint="The Post node publishes the connected template's slides — it emits no data."
              />
            ) : testError ? (
              <div className="flex-1 overflow-y-auto p-4"><Alert tone="danger">{testError}</Alert></div>
            ) : output !== undefined ? (
              <DataJson value={output} />
            ) : !hasOutputPorts ? (
              <DataColumnEmpty title="No output ports" hint="This node renders/acts — it emits no data downstream." />
            ) : (
              <DataColumnEmpty
                title="No output data yet"
                action={<Button size="sm" variant="secondary" loading={busy} onClick={onExecute}>Execute step</Button>}
                hint={onTestIsolated ? 'Execute runs the real upstream chain. You can also test this node alone, with empty input.' : undefined}
              />
            )}
            {/* Isolated test (the old dock's "Test this node") — runs with EMPTY input via run-node */}
            {onTestIsolated && (
              <div className="shrink-0 border-t border-line p-3">
                <Button size="sm" variant="ghost" className="w-full" loading={!!nodeRun?.loading} onClick={onTestIsolated}>Test node alone (empty input)</Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
