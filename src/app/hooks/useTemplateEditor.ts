'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { requestUpgrade, upgradeReasonForDbError } from '@/lib/upgradePrompt';
import { collectMediaRefs, cleanupMediaRefs } from '@/lib/mediaCleanup';
import type { CarouselSettings } from '../components/templateEditorTypes';
import { rowToSlide, slideToRow, type TemplateRow, type SlideRow } from '../components/templateEditorRows';

// ── Public types ─────────────────────────────────────────────────────────────
// Row ↔ domain mapping now lives in components/templateEditorRows (framework-neutral, shared with
// server-side automations code). Re-exported here so existing importers keep working.
export type { TemplateRow, SlideRow };

export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

// ── Table config ──────────────────────────────────────────────────────────────
// Lets the SAME hook drive either the template tables or the post tables. Pass a
// STABLE (module-level) config so the hook's callbacks/effects don't churn.
export interface TableConfig {
  parent:  string;   // parent table: templates or posts
  slides:  string;   // child slides table
  slideFk: string;   // FK column on the slides table that points at the parent id
}
export const TEMPLATE_TABLES: TableConfig = {
  parent:  'template_editor_templates',
  slides:  'template_editor_slides',
  slideFk: 'template_id',
};
export const POST_TABLES: TableConfig = {
  parent:  'template_editor_posts',
  slides:  'template_editor_post_slides',
  slideFk: 'post_id',
};

// ── Tuning ───────────────────────────────────────────────────────────────────

const AUTOSAVE_DEBOUNCE_MS = 500;
const SAVED_FLASH_MS = 1500;
const HISTORY_DEBOUNCE_MS = 400;   // rapid edits within this window coalesce into one undo step
const HISTORY_LIMIT = 100;

// Undo/redo snapshot of a slide's editable state
type HistorySnap = { headline: string; subheadline: string; settings: CarouselSettings };
function cloneSettings(s: CarouselSettings): CarouselSettings {
  return JSON.parse(JSON.stringify(s)) as CarouselSettings;
}
function snapOfSlide(slide: SlideRow | undefined): HistorySnap | null {
  return slide
    ? { headline: slide.headline, subheadline: slide.subheadline, settings: cloneSettings(slide.settings) }
    : null;
}


// ── Hook ─────────────────────────────────────────────────────────────────────

// Module-level cache (per user + parent table) so re-mounting the editor — e.g. toggling
// Reels→Carousel — starts from the last-loaded templates/slides instead of an empty list + a fetch
// (which is what made the carousel take a beat to fill in). The load effect still refreshes silently.
type TemplateEditorSnapshot = { templates: TemplateRow[]; slides: SlideRow[]; activeTemplateId: string | null; activeSlideId: string | null };
const templateEditorCache = new Map<string, TemplateEditorSnapshot>();

// Drop the cached snapshot(s) for a user (both the template and post tables) plus the reload-persisted
// active id. Call after an out-of-band delete — e.g. the Account debug wipe deletes rows straight from
// the DB — so a later re-mount doesn't briefly render stale templates/posts before the refetch returns
// an empty list, and the persisted id can't point at a now-deleted row.
export function clearTemplateEditorCache(userId?: string) {
  if (!userId) { templateEditorCache.clear(); return; }
  for (const parent of [TEMPLATE_TABLES.parent, POST_TABLES.parent]) {
    templateEditorCache.delete(`${userId}:${parent}`);
    try { localStorage.removeItem(`de:tpl:${userId}:${parent}`); } catch { /* ignore */ }
  }
}

export function useTemplateEditor(userId: string | null, tables: TableConfig = TEMPLATE_TABLES) {
  // Stable primitive copies so callback/effect deps compare by value, not object identity.
  const { parent: PARENT_TABLE, slides: SLIDES_TABLE, slideFk: SLIDE_FK } = tables;

  const cacheKey = userId ? `${userId}:${PARENT_TABLE}` : '';
  const cachedSnapshot = cacheKey ? templateEditorCache.get(cacheKey) : undefined;
  const [templates, setTemplates]               = useState<TemplateRow[]>(() => cachedSnapshot?.templates ?? []);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(() => cachedSnapshot?.activeTemplateId ?? null);
  const [slides, setSlides]                     = useState<SlideRow[]>(() => cachedSnapshot?.slides ?? []);
  const [activeSlideId, setActiveSlideId]       = useState<string | null>(() => cachedSnapshot?.activeSlideId ?? null);
  const [loading, setLoading]                   = useState(() => (userId ? !cachedSnapshot : false));
  const [saveState, setSaveState]               = useState<SaveState>('idle');
  const [error, setError]                       = useState<string | null>(null);

  // Per-slide debounce timers
  const saveTimersRef  = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const savedFlashRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slidesRef      = useRef<SlideRow[]>([]);
  slidesRef.current    = slides;
  // Monotonic token so a slow loadSlidesFor() can't clobber the state of a newer one (rapid template switch).
  const loadTokenRef   = useRef(0);
  // Per-slide optimistic-lock tokens: the updated_at we last saw for each slide row (populated wherever
  // slides are loaded/inserted). persistSlide only writes while the stored row still carries this value.
  const slideUpdatedAtRef = useRef<Map<string, string | null>>(new Map());

  // ── Undo / redo state (per slide; rapid edits coalesce into one step) ───────
  const historyRef       = useRef<Map<string, { past: HistorySnap[]; future: HistorySnap[] }>>(new Map());
  const pendingBaseRef   = useRef<Map<string, HistorySnap>>(new Map());
  const histTimerRef     = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const activeSlideIdRef = useRef<string | null>(activeSlideId);
  activeSlideIdRef.current = activeSlideId;
  const [histTick, setHistTick] = useState(0);

  // Load a parent's slides (a template's or a post's) and reset undo history.
  // A plain function (recreated per render) that captures the stable table config — wrapping it in
  // useCallback makes the React-compiler lint surface ref-during-render violations elsewhere, so we keep
  // it plain and accept the (harmless) exhaustive-deps notes on its callers.
  async function loadSlidesFor(templateId: string) {
    // Claim this load. If the user switches templates again while our awaits are in flight, a newer call
    // bumps the token and the stale call below bails out instead of overwriting the newer template's slides.
    const token = ++loadTokenRef.current;
    // Flush any pending autosave for the OUTGOING slides before we replace them — otherwise the debounced
    // timer fires after slidesRef has changed, finds nothing, and the last edit to the previous template is
    // silently lost. Mirrors scheduleSave's guarded write; best-effort (a conflict is surfaced, other
    // errors fall through to normal save state).
    for (const sid of Array.from(saveTimersRef.current.keys())) {
      const t = saveTimersRef.current.get(sid);
      if (t) clearTimeout(t);
      saveTimersRef.current.delete(sid);
      const sl = slidesRef.current.find(s => s.id === sid);
      if (sl && (await persistSlide(sl)) === 'conflict') setSaveState('conflict');
    }
    historyRef.current.clear();
    pendingBaseRef.current.clear();
    histTimerRef.current.forEach(t => clearTimeout(t));
    histTimerRef.current.clear();
    setHistTick(t => t + 1);
    // The slides and the parent's active_slide_id are independent reads — fetch them together instead of
    // paying two serial round-trips on every template/post switch (this is an interactive hot path).
    const [{ data, error: err }, { data: prow }] = await Promise.all([
      supabase.from(SLIDES_TABLE).select('*').eq(SLIDE_FK, templateId).order('position'),
      supabase.from(PARENT_TABLE).select('active_slide_id').eq('id', templateId).maybeSingle(),
    ]);
    if (token !== loadTokenRef.current) return;   // a newer template selection superseded this load
    if (err) { setError(err.message); return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawRows = (data ?? []) as Record<string, any>[];
    const list = rawRows.map(rowToSlide);
    // select('*') includes updated_at — record each row's optimistic-lock token (see persistSlide).
    for (const r of rawRows) slideUpdatedAtRef.current.set(r.id, r.updated_at ?? null);
    setSlides(list);
    // Restore the saved active slide if it still exists, else fall back to the first.
    let activeId = list[0]?.id ?? null;
    const saved = (prow as { active_slide_id?: string | null } | null)?.active_slide_id;
    if (saved && list.some(sl => sl.id === saved)) activeId = saved;
    setActiveSlideId(activeId);
  }

  // ── Load on userId change ─────────────────────────────────────────────────
  useEffect(() => {
    if (!userId) {
      setTemplates([]);
      setSlides([]);
      setActiveTemplateId(null);
      setActiveSlideId(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    async function load(uid: string) {
      const key = `${uid}:${PARENT_TABLE}`;
      // Only show the loading state when there's nothing cached to display; otherwise refresh silently.
      if (!templateEditorCache.has(key)) setLoading(true);
      const { data, error: err } = await supabase
        .from(PARENT_TABLE)
        .select('id, name, position')
        .eq('user_id', uid)
        .order('position');
      if (cancelled) return;
      if (err) { setError(err.message); setLoading(false); return; }

      const list = (data ?? []) as TemplateRow[];
      setTemplates(list);
      if (list.length > 0) {
        // Reopen the template the user was editing: prefer the reload-persisted id (survives a full
        // refresh), then the in-memory cache (fast re-mount), else the first.
        const snap = templateEditorCache.get(key);
        let savedId: string | null = null;
        try { savedId = localStorage.getItem(`de:tpl:${key}`); } catch { /* ignore */ }
        const targetId =
          (savedId && list.some(t => t.id === savedId)) ? savedId
          : (snap && list.some(t => t.id === snap.activeTemplateId)) ? snap.activeTemplateId!
          : list[0].id;
        await loadSlidesFor(targetId);
        if (cancelled) return;
        setActiveTemplateId(targetId);
      } else {
        setSlides([]);
        setActiveSlideId(null);
      }
      setLoading(false);
    }
    void load(userId);
    return () => { cancelled = true; };
    // loadSlidesFor is a stable-by-value plain fn; intentionally not a dep (would re-run every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, PARENT_TABLE]);

  // Keep the module-level cache in sync with the live data so the next (re)mount restores it instantly.
  useEffect(() => {
    if (cacheKey) templateEditorCache.set(cacheKey, { templates, slides, activeTemplateId, activeSlideId });
  }, [cacheKey, templates, slides, activeTemplateId, activeSlideId]);

  // Also persist the active template id to localStorage so a full page reload (which clears the
  // in-memory cache above) still reopens the template the user was editing.
  useEffect(() => {
    if (cacheKey && activeTemplateId) { try { localStorage.setItem(`de:tpl:${cacheKey}`, activeTemplateId); } catch { /* ignore */ } }
  }, [cacheKey, activeTemplateId]);

  // ── Debounced autosave ────────────────────────────────────────────────────
  // Persist a slide's full row under an optimistic lock (mirrors useAutomationFlow's saveActive): the
  // UPDATE only applies while the stored row's updated_at still equals the one we last loaded, so another
  // tab/session saving in between turns THIS save into a zero-row no-op instead of silently clobbering
  // their JSONB-heavy row with ours. Returns 'ok' | 'conflict' | an error message. On conflict the lock
  // token is refreshed, so the NEXT save (the user editing again) deliberately wins with last-write.
  const persistSlide = useCallback(async (slide: SlideRow): Promise<'ok' | 'conflict' | string> => {
    const lastSeen = slideUpdatedAtRef.current.get(slide.id);
    let query = supabase.from(SLIDES_TABLE).update(slideToRow(slide)).eq('id', slide.id);
    if (lastSeen) query = query.eq('updated_at', lastSeen);
    const { data, error: err } = await query.select('updated_at');
    if (err) return err.message;
    const row = (data as Array<{ updated_at: string }> | null)?.[0];
    if (!row) {
      // Zero rows matched → the stored row moved (or vanished) under us. Don't clobber; refresh the token.
      const { data: fresh } = await supabase.from(SLIDES_TABLE).select('updated_at').eq('id', slide.id).maybeSingle();
      const freshAt = (fresh as { updated_at?: string } | null)?.updated_at;
      if (freshAt) slideUpdatedAtRef.current.set(slide.id, freshAt);
      return 'conflict';
    }
    slideUpdatedAtRef.current.set(slide.id, row.updated_at);
    return 'ok';
  }, [SLIDES_TABLE]);

  // Exit-flush variant: the user's LAST action before leaving was this edit — dropping it silently on a
  // lock conflict is worse than winning. persistSlide refreshes the token on conflict, so one retry is a
  // DELIBERATE last-write (the same "save again to overwrite" a mounted conflict asks the user for —
  // here the unmount answers it, because there is no UI left to ask).
  const flushSlide = useCallback(async (sl: SlideRow): Promise<void> => {
    if ((await persistSlide(sl)) === 'conflict') await persistSlide(sl);
  }, [persistSlide]);

  const scheduleSave = useCallback((slideId: string) => {
    const existing = saveTimersRef.current.get(slideId);
    if (existing) clearTimeout(existing);

    setSaveState('saving');
    if (savedFlashRef.current) {
      clearTimeout(savedFlashRef.current);
      savedFlashRef.current = null;
    }

    const timer = setTimeout(async () => {
      saveTimersRef.current.delete(slideId);
      const slide = slidesRef.current.find(s => s.id === slideId);
      if (!slide) return;
      const result = await persistSlide(slide);
      if (result === 'conflict') {
        setSaveState('conflict');
        return;
      }
      if (result !== 'ok') {
        setSaveState('error');
        setError(result);
        return;
      }
      // Only flash 'saved' if no other saves are still pending
      if (saveTimersRef.current.size === 0) {
        setSaveState('saved');
        savedFlashRef.current = setTimeout(() => {
          setSaveState(prev => (prev === 'saved' ? 'idle' : prev));
          savedFlashRef.current = null;
        }, SAVED_FLASH_MS);
      }
    }, AUTOSAVE_DEBOUNCE_MS);

    saveTimersRef.current.set(slideId, timer);
  }, [persistSlide]);

  // ── History (undo/redo) helpers ─────────────────────────────────────────────
  const recordHistory = useCallback((id: string, beforeSlide: SlideRow) => {
    // First edit of a burst captures the pre-edit state as the undo point
    if (!pendingBaseRef.current.has(id)) {
      const snap = snapOfSlide(beforeSlide);
      if (snap) { pendingBaseRef.current.set(id, snap); setHistTick(t => t + 1); }
    }
    const existing = histTimerRef.current.get(id);
    if (existing) clearTimeout(existing);
    histTimerRef.current.set(id, setTimeout(() => {
      histTimerRef.current.delete(id);
      const base = pendingBaseRef.current.get(id);
      pendingBaseRef.current.delete(id);
      if (!base) return;
      const h = historyRef.current.get(id) ?? { past: [], future: [] };
      h.past.push(base);
      if (h.past.length > HISTORY_LIMIT) h.past.shift();
      h.future = [];
      historyRef.current.set(id, h);
      setHistTick(t => t + 1);
    }, HISTORY_DEBOUNCE_MS));
  }, []);

  // Commit any in-progress burst immediately (so undo right after an edit works)
  const flushPending = useCallback((id: string) => {
    const timer = histTimerRef.current.get(id);
    if (timer) { clearTimeout(timer); histTimerRef.current.delete(id); }
    const base = pendingBaseRef.current.get(id);
    if (!base) return;
    pendingBaseRef.current.delete(id);
    const h = historyRef.current.get(id) ?? { past: [], future: [] };
    h.past.push(base);
    if (h.past.length > HISTORY_LIMIT) h.past.shift();
    h.future = [];
    historyRef.current.set(id, h);
  }, []);

  // Restore a snapshot without recording it as a new edit
  const applySnap = useCallback((id: string, snap: HistorySnap) => {
    setSlides(prev => prev.map(sl => sl.id === id
      ? { ...sl, headline: snap.headline, subheadline: snap.subheadline, settings: cloneSettings(snap.settings) }
      : sl));
    scheduleSave(id);
  }, [scheduleSave]);

  const undo = useCallback(() => {
    const id = activeSlideIdRef.current;
    if (!id) return;
    flushPending(id);
    const h = historyRef.current.get(id);
    if (!h || h.past.length === 0) return;
    const cur = snapOfSlide(slidesRef.current.find(s => s.id === id));
    const prev = h.past.pop();
    if (!cur || !prev) return;
    h.future.push(cur);
    applySnap(id, prev);
    setHistTick(t => t + 1);
  }, [flushPending, applySnap]);

  const redo = useCallback(() => {
    const id = activeSlideIdRef.current;
    if (!id) return;
    flushPending(id);
    const h = historyRef.current.get(id);
    if (!h || h.future.length === 0) return;
    const cur = snapOfSlide(slidesRef.current.find(s => s.id === id));
    const next = h.future.pop();
    if (!cur || !next) return;
    h.past.push(cur);
    applySnap(id, next);
    setHistTick(t => t + 1);
  }, [flushPending, applySnap]);

  // Cancel pending timers on unmount
  useEffect(() => {
    const timers = saveTimersRef.current;
    const histTimers = histTimerRef.current;
    return () => {
      // Flush (not just cancel) pending autosaves so the last debounced edit isn't lost when the editor
      // unmounts within the 500ms window — e.g. the Carousel<->Reels toggle or a sidebar nav. Fire-and-forget
      // is fine for in-app navigation (the JS context survives); tab-close/backgrounding is handled
      // best-effort by the pagehide/visibilitychange effect below.
      for (const [slideId, t] of timers) {
        clearTimeout(t);
        const sl = slidesRef.current.find(s => s.id === slideId);
        if (sl) void flushSlide(sl); // retries once past a lock conflict — see flushSlide
      }
      timers.clear();
      histTimers.forEach(t => clearTimeout(t));
      histTimers.clear();
      if (savedFlashRef.current) clearTimeout(savedFlashRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Best-effort flush on tab-close / backgrounding. supabase-js uses plain fetch (no keepalive), so delivery
  // isn't guaranteed on a hard tab-close, but this reliably covers backgrounding/switching-away within the
  // 500ms autosave debounce — the common "I tabbed away right after editing" case. In-app unmount is above.
  useEffect(() => {
    const flushAll = () => {
      const timers = saveTimersRef.current;
      for (const [slideId, t] of timers) {
        clearTimeout(t);
        const sl = slidesRef.current.find(s => s.id === slideId);
        if (sl) void flushSlide(sl); // retries once past a lock conflict — see flushSlide
      }
      timers.clear();
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushAll(); };
    window.addEventListener('pagehide', flushAll);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushAll);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Template ops ──────────────────────────────────────────────────────────
  const createTemplate = useCallback(async (name?: string): Promise<string | null> => {
    if (!userId) return null;
    const position = templates.length;
    // Auto-name "Carousel Template N" as ONE ABOVE the highest existing number — so renaming e.g. 3→4
    // doesn't free "3" for reuse; the next is always above the max. Guarantees a non-duplicate name.
    let finalName = name;
    if (!finalName) {
      let max = 0;
      for (const t of templates) {
        const m = /^Carousel Template (\d+)$/.exec(t.name.trim());
        if (m) max = Math.max(max, Number(m[1]));
      }
      finalName = `Carousel Template ${max + 1}`;
    }
    const { data, error: err } = await supabase
      .from(PARENT_TABLE)
      .insert({ user_id: userId, name: finalName, position })
      .select('id, name, position')
      .single();
    if (err || !data) {
      // Free-plan template cap (DB trigger, supabase/free_tier.sql) → upgrade prompt, not an error.
      const upgrade = upgradeReasonForDbError(err?.message);
      if (upgrade) { requestUpgrade(upgrade); return null; }
      setError(err?.message ?? 'Failed to create template'); return null;
    }

    const t = data as TemplateRow;
    setTemplates(prev => [...prev, t]);
    setActiveTemplateId(t.id);

    // Auto-create the initial blank 'main' slide (no placeholder copy, no circle layers — a clean start).
    const { data: slideData, error: slideErr } = await supabase
      .from(SLIDES_TABLE)
      .insert({
        [SLIDE_FK]: t.id, name: 'main', position: 0, layer_order: ['background', 'subject'],
        // Seed the first (main) slide with starter headline + sub text so a brand-new template isn't a
        // bare canvas. Only this slide gets them — slides added later start blank.
        headline: 'Your headline here', subheadline: 'Your subheadline here',
      })
      .select('*')
      .single();
    if (slideErr || !slideData) {
      setError(slideErr?.message ?? 'Failed to create initial slide');
      return t.id;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawSlide = slideData as Record<string, any>;
    const newSlide = rowToSlide(rawSlide);
    slideUpdatedAtRef.current.set(newSlide.id, rawSlide.updated_at ?? null);
    setSlides([newSlide]);
    setActiveSlideId(newSlide.id);
    return t.id;
  }, [userId, templates, PARENT_TABLE, SLIDES_TABLE, SLIDE_FK]);

  // Duplicate a template (or post) in place: deep-clone its slides into a new parent named "<name> copy",
  // then switch to it. Reads + writes THIS hook's own tables (templates→templates, posts→posts).
  const duplicateTemplate = useCallback(async (id: string): Promise<string | null> => {
    if (!userId) return null;
    const { data: srcRows, error: srcErr } = await supabase
      .from(SLIDES_TABLE).select('*').eq(SLIDE_FK, id).order('position');
    if (srcErr) { setError(srcErr.message); return null; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srcSlides = ((srcRows ?? []) as Record<string, any>[]).map(rowToSlide);
    if (srcSlides.length === 0) { setError('That template could not be found, or has no slides to copy.'); return null; }

    const srcName = templates.find(t => t.id === id)?.name ?? 'Template';
    const position = templates.length;
    const { data: parent, error: pErr } = await supabase
      .from(PARENT_TABLE)
      .insert({ user_id: userId, name: `${srcName} copy`, position })
      .select('id, name, position')
      .single();
    if (pErr || !parent) {
      const upgrade = upgradeReasonForDbError(pErr?.message);
      if (upgrade) { requestUpgrade(upgrade); return null; }
      setError(pErr?.message ?? 'Failed to duplicate'); return null;
    }
    const p = parent as TemplateRow;

    const rows = srcSlides.map((sl, i) => ({ ...slideToRow({ ...sl, position: i }), [SLIDE_FK]: p.id }));
    const { data: insRows, error: sErr } = await supabase.from(SLIDES_TABLE).insert(rows).select('*');
    if (sErr || (insRows?.length ?? 0) === 0) {
      await supabase.from(PARENT_TABLE).delete().eq('id', p.id);   // no client transactions — roll back the orphan parent
      setError(sErr?.message ?? 'Failed to copy the slides.');
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawRows = (insRows ?? []) as Record<string, any>[];
    const newSlides = rawRows.map(rowToSlide).sort((a, b) => a.position - b.position);
    for (const r of rawRows) slideUpdatedAtRef.current.set(r.id, r.updated_at ?? null);   // lock tokens (persistSlide)

    historyRef.current.clear();
    pendingBaseRef.current.clear();
    histTimerRef.current.forEach(t => clearTimeout(t));
    histTimerRef.current.clear();
    setHistTick(t => t + 1);
    setTemplates(prev => [...prev, p]);
    setActiveTemplateId(p.id);
    setSlides(newSlides);
    setActiveSlideId(newSlides[0]?.id ?? null);
    return p.id;
  }, [userId, templates, PARENT_TABLE, SLIDES_TABLE, SLIDE_FK]);

  // Create a POST by deep-cloning a template's slides (snapshot). Reads the source slides from the
  // template tables and writes the clones into THIS hook's parent (post) tables, recording provenance in
  // source_template_id. Only meaningful when the hook is configured for posts (POST_TABLES). RLS on the
  // source template tables already restricts the read to templates the user owns.
  const createFromTemplate = useCallback(async (sourceTemplateId: string, name?: string): Promise<string | null> => {
    if (!userId) return null;
    const source = TEMPLATE_TABLES;
    // 1. Fetch the source template's slides in order.
    const { data: srcRows, error: srcErr } = await supabase
      .from(source.slides)
      .select('*')
      .eq(source.slideFk, sourceTemplateId)
      .order('position');
    if (srcErr) { setError(srcErr.message); return null; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srcSlides = ((srcRows ?? []) as Record<string, any>[]).map(rowToSlide);
    // A real template always has ≥1 slide; 0 rows means a missing/not-owned id (RLS blocks the read) —
    // fail fast instead of creating an empty post.
    if (srcSlides.length === 0) { setError('That template could not be found, or has no slides to copy.'); return null; }

    // 2. Create the post (parent), recording which template it came from.
    const position = templates.length;
    const finalName = name ?? `Post ${position + 1}`;
    const { data: parent, error: pErr } = await supabase
      .from(PARENT_TABLE)
      .insert({ user_id: userId, name: finalName, position, source_template_id: sourceTemplateId })
      .select('id, name, position')
      .single();
    if (pErr || !parent) { setError(pErr?.message ?? 'Failed to create post'); return null; }
    const p = parent as TemplateRow;

    // 3. Deep-clone the slides into the post (fresh ids; preserve order). slideToRow omits id/FK/timestamps
    //    and drops image-type divider sub-slots (ephemeral blob URLs) — matching template save behaviour.
    const rows = srcSlides.map((sl, i) => ({ ...slideToRow({ ...sl, position: i }), [SLIDE_FK]: p.id }));
    const { data: insRows, error: sErr } = await supabase.from(SLIDES_TABLE).insert(rows).select('*');
    if (sErr || (insRows?.length ?? 0) === 0) {
      // No client-side transactions — roll back the just-created post so we don't leave a slide-less orphan.
      await supabase.from(PARENT_TABLE).delete().eq('id', p.id);
      setError(sErr?.message ?? 'Failed to copy the template slides into the post.');
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawRows = (insRows ?? []) as Record<string, any>[];
    const newSlides = rawRows.map(rowToSlide).sort((a, b) => a.position - b.position);
    for (const r of rawRows) slideUpdatedAtRef.current.set(r.id, r.updated_at ?? null);   // lock tokens (persistSlide)

    // 4. Reset undo history and switch the editor to the new post.
    historyRef.current.clear();
    pendingBaseRef.current.clear();
    histTimerRef.current.forEach(t => clearTimeout(t));
    histTimerRef.current.clear();
    setHistTick(t => t + 1);
    setTemplates(prev => [...prev, p]);
    setActiveTemplateId(p.id);
    setSlides(newSlides);
    setActiveSlideId(newSlides[0]?.id ?? null);
    return p.id;
  }, [userId, templates.length, PARENT_TABLE, SLIDES_TABLE, SLIDE_FK]);

  const selectTemplate = useCallback(async (id: string) => {
    if (id === activeTemplateId) return;
    setActiveTemplateId(id);
    await loadSlidesFor(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTemplateId]);

  const renameTemplate = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Block duplicate names (case-insensitive) against the user's OTHER templates.
    if (templates.some(t => t.id !== id && t.name.trim().toLowerCase() === trimmed.toLowerCase())) {
      setError('That name is already taken.');
      return;
    }
    setTemplates(prev => prev.map(t => (t.id === id ? { ...t, name: trimmed } : t)));
    const { error: err } = await supabase
      .from(PARENT_TABLE)
      .update({ name: trimmed })
      .eq('id', id);
    if (err) setError(err.message);
  }, [PARENT_TABLE, templates]);

  const deleteTemplate = useCallback(async (id: string) => {
    // Snapshot the pasted-media refs the doomed slides hold BEFORE the cascade wipes them, so the GC
    // can delete the files afterwards (unless a duplicate/post still shares them).
    const { data: doomedSlides } = await supabase.from(SLIDES_TABLE).select('image_boxes,free_elements').eq(SLIDE_FK, id);
    const remaining = templates.filter(t => t.id !== id);
    setTemplates(remaining);
    if (activeTemplateId === id) {
      if (remaining.length > 0) {
        setActiveTemplateId(remaining[0].id);
        await loadSlidesFor(remaining[0].id);
      } else {
        setActiveTemplateId(null);
        setSlides([]);
        setActiveSlideId(null);
      }
    }
    const { error: err } = await supabase
      .from(PARENT_TABLE)
      .delete()
      .eq('id', id);
    if (err) setError(err.message);
    else void cleanupMediaRefs(collectMediaRefs(doomedSlides));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTemplateId, templates, PARENT_TABLE, SLIDES_TABLE, SLIDE_FK]);

  const reorderTemplates = useCallback(async (orderedIds: string[]) => {
    if (!userId) return;
    const positionById = new Map(orderedIds.map((id, i) => [id, i]));
    const reordered = [...templates]
      .sort((a, b) => (positionById.get(a.id) ?? 0) - (positionById.get(b.id) ?? 0))
      .map((t, i) => ({ ...t, position: i }));
    setTemplates(reordered);
    // Sequential per-row UPDATEs, abort on first failure. NOT an upsert: the INSERT arm re-creates rows
    // another session deleted (ghost "Untitled template") and — worse — the free-tier BEFORE INSERT cap
    // trigger fires on the tuple before conflict resolution, failing the whole reorder for lapsed
    // subscribers. Position-only updates are no-ops on deleted rows and never touch insert triggers.
    for (const t of reordered) {
      const { error: err } = await supabase.from(PARENT_TABLE).update({ position: t.position }).eq('id', t.id);
      if (err) { setError(`Failed to save the new order: ${err.message}`); return; }
    }
  }, [userId, templates, PARENT_TABLE]);

  // ── Slide ops ─────────────────────────────────────────────────────────────
  // Add a BLANK slide — no placeholder copy (headline/subheadline default to ''). layer_order is still
  // overridden to drop the dormant circle layers for a clean start.
  const addSlide = useCallback(async (name?: string): Promise<string | null> => {
    if (!activeTemplateId) return null;
    const position = slides.length;
    const finalName = name ?? (position === 0 ? 'main' : `supporting_${position}`);
    const { data, error: err } = await supabase
      .from(SLIDES_TABLE)
      .insert({
        [SLIDE_FK]: activeTemplateId,
        name: finalName,
        position,
        layer_order: ['background', 'subject'],
      })
      .select('*')
      .single();
    if (err || !data) { setError(err?.message ?? 'Failed to add slide'); return null; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawSlide = data as Record<string, any>;
    const newSlide = rowToSlide(rawSlide);
    slideUpdatedAtRef.current.set(newSlide.id, rawSlide.updated_at ?? null);
    setSlides(prev => [...prev, newSlide]);
    setActiveSlideId(newSlide.id);
    return newSlide.id;
  }, [activeTemplateId, slides.length, SLIDES_TABLE, SLIDE_FK]);

  // Duplicate an existing slide ("page") within the current template/post — deep-clones all of its settings
  // into a new slide appended at the end, then selects it.
  const duplicateSlide = useCallback(async (id: string): Promise<string | null> => {
    if (!activeTemplateId) return null;
    const src = slides.find(s => s.id === id);
    if (!src) return null;
    const position = slides.length;
    const { data, error: err } = await supabase
      .from(SLIDES_TABLE)
      .insert({ ...slideToRow(src), [SLIDE_FK]: activeTemplateId, name: `${src.name} copy`, position })
      .select('*')
      .single();
    if (err || !data) { setError(err?.message ?? 'Failed to duplicate slide'); return null; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawSlide = data as Record<string, any>;
    const newSlide = rowToSlide(rawSlide);
    slideUpdatedAtRef.current.set(newSlide.id, rawSlide.updated_at ?? null);
    setSlides(prev => [...prev, newSlide]);
    setActiveSlideId(newSlide.id);
    return newSlide.id;
  }, [activeTemplateId, slides, SLIDES_TABLE, SLIDE_FK]);

  const selectSlide = useCallback((id: string) => {
    setActiveSlideId(id);
    if (activeTemplateId) void supabase.from(PARENT_TABLE).update({ active_slide_id: id }).eq('id', activeTemplateId);
  }, [activeTemplateId, PARENT_TABLE]);

  const renameSlide = useCallback(async (id: string, name: string) => {
    setSlides(prev => prev.map(s => (s.id === id ? { ...s, name } : s)));
    // Name changes go through the same debounced save; the next slideToRow
    // upsert will include the new name.
    scheduleSave(id);
  }, [scheduleSave]);

  const deleteSlide = useCallback(async (id: string) => {
    historyRef.current.delete(id);
    pendingBaseRef.current.delete(id);
    slideUpdatedAtRef.current.delete(id);
    const ht = histTimerRef.current.get(id);
    if (ht) { clearTimeout(ht); histTimerRef.current.delete(id); }
    const doomed = slides.find(s => s.id === id);   // in-memory row still holds the media URLs
    const remaining = slides.filter(s => s.id !== id);
    setSlides(remaining);
    if (activeSlideId === id) setActiveSlideId(remaining[0]?.id ?? null);
    const { error: err } = await supabase
      .from(SLIDES_TABLE)
      .delete()
      .eq('id', id);
    if (err) setError(err.message);
    else void cleanupMediaRefs(collectMediaRefs(doomed)); // GC pasted media nothing else references
  }, [activeSlideId, slides, SLIDES_TABLE]);

  const reorderSlides = useCallback(async (orderedIds: string[]) => {
    const positionById = new Map(orderedIds.map((id, i) => [id, i]));
    const reordered = [...slides]
      .sort((a, b) => (positionById.get(a.id) ?? 0) - (positionById.get(b.id) ?? 0))
      .map((s, i) => ({ ...s, position: i }));
    setSlides(reordered);
    // Sequential per-row UPDATEs, abort on first failure — see reorderTemplates for why an upsert is
    // wrong (it re-INSERTS rows another session deleted, resurrecting ghost blank slides). Each update
    // returns the trigger-bumped updated_at, refreshing the optimistic-lock token so the next autosave
    // doesn't false-conflict (persistSlide).
    for (const s of reordered) {
      const { data, error: err } = await supabase
        .from(SLIDES_TABLE)
        .update({ position: s.position })
        .eq('id', s.id)
        .select('updated_at');
      if (err) { setError(`Failed to save the new slide order: ${err.message}`); return; }
      const at = (data as Array<{ updated_at: string }> | null)?.[0]?.updated_at;
      if (at) slideUpdatedAtRef.current.set(s.id, at);
    }
  }, [slides, SLIDES_TABLE]);

  // ── Settings update with debounced autosave ───────────────────────────────
  const updateSlide = useCallback((
    id: string,
    partial: { headline?: string; subheadline?: string; settings?: Partial<CarouselSettings> },
  ) => {
    const before = slidesRef.current.find(s => s.id === id);
    if (before) recordHistory(id, before);
    setSlides(prev => prev.map(s => {
      if (s.id !== id) return s;
      return {
        ...s,
        headline:    partial.headline    ?? s.headline,
        subheadline: partial.subheadline ?? s.subheadline,
        settings:    partial.settings ? { ...s.settings, ...partial.settings } : s.settings,
      };
    }));
    scheduleSave(id);
  }, [scheduleSave, recordHistory]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const activeTemplate = templates.find(t => t.id === activeTemplateId) ?? null;
  const activeSlide    = slides.find(s => s.id === activeSlideId)       ?? null;

  const canUndo = useMemo(() => {
    if (!activeSlideId) return false;
    const h = historyRef.current.get(activeSlideId);
    return (h?.past.length ?? 0) > 0 || pendingBaseRef.current.has(activeSlideId);
  }, [histTick, activeSlideId]);
  const canRedo = useMemo(() => {
    if (!activeSlideId) return false;
    return (historyRef.current.get(activeSlideId)?.future.length ?? 0) > 0;
  }, [histTick, activeSlideId]);

  return {
    templates,
    activeTemplate,
    activeTemplateId,
    slides,
    activeSlide,
    activeSlideId,
    loading,
    saveState,
    error,
    setError,
    createTemplate,
    createFromTemplate,
    duplicateTemplate,
    selectTemplate,
    renameTemplate,
    deleteTemplate,
    reorderTemplates,
    addSlide,
    duplicateSlide,
    selectSlide,
    renameSlide,
    deleteSlide,
    reorderSlides,
    updateSlide,
    undo,
    redo,
    canUndo,
    canRedo,
  };
}
