'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { requestUpgrade, upgradeReasonForDbError } from '@/lib/upgradePrompt';
import { collectMediaRefs, cleanupMediaRefs } from '@/lib/mediaCleanup';
import type { TwitterTemplateSettings } from '../components/twitterTemplateTypes';
import { defaultTwitterTemplateSettings, resolveTwitterTemplateSettings } from '../components/twitterTemplateTypes';
import type { SaveState } from '../components/AutosaveChip';

export interface TwitterTemplate {
  id: string;
  name: string;
  position: number;
  settings: TwitterTemplateSettings;
}

interface History { past: TwitterTemplateSettings[]; future: TwitterTemplateSettings[]; }
const HISTORY_LIMIT = 100;

// Owner-scoped list of named Twitter/X overlay templates. The style blob lives in a single jsonb column
// (`settings`); edits autosave on a 500ms debounce, mirroring the carousel editor's save cadence, and
// the same debounce coalesces an edit "burst" (e.g. a slider drag) into a single undo step.
// Module-level cache (per user) so re-mounting the editor — e.g. toggling Carousel⇄Reels — starts
// from the last-loaded templates instead of an empty list + loading spinner; the fetch below still
// runs to refresh in the background.
const twitterTemplatesCache = new Map<string, TwitterTemplate[]>();

// Drop the cached list for a user (or everyone). Call after an out-of-band delete — e.g. the Account
// debug wipe deletes rows straight from the DB — so a later re-mount doesn't briefly render stale
// templates (the posting animation) before the background refetch returns an empty list.
export function clearTwitterTemplatesCache(userId?: string) {
  if (userId) twitterTemplatesCache.delete(userId);
  else twitterTemplatesCache.clear();
}

// Warm the cache ahead of time (e.g. while the user is still on the Carousel editor) so the FIRST
// open of the Reels editor after a refresh skips the loading spinner too. No-op if already cached.
export async function prefetchTwitterTemplates(userId: string | null) {
  if (!userId || twitterTemplatesCache.has(userId)) return;
  const { data, error } = await supabase
    .from('twitter_templates')
    .select('*')
    .eq('user_id', userId)
    .order('position');
  if (error || !data) return;
  twitterTemplatesCache.set(userId, data.map(r => ({
    id: r.id, name: r.name, position: r.position,
    settings: resolveTwitterTemplateSettings(r.settings),
  })));
}

export function useTwitterTemplates(userId: string | null) {
  const [templates, setTemplates] = useState<TwitterTemplate[]>(() => (userId ? twitterTemplatesCache.get(userId) ?? [] : []));
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);   // true once the first fetch resolves — gates empty states so they don't flash
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [, setHistTick] = useState(0);   // force a re-render when undo/redo availability changes

  // Latest snapshot for the debounced writer (avoids stale closures inside the timer).
  const templatesRef = useRef<TwitterTemplate[]>([]);
  useEffect(() => { templatesRef.current = templates; if (userId) twitterTemplatesCache.set(userId, templates); }, [templates, userId]);

  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const savedRevertRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-template undo history + the pre-edit snapshot captured at the start of the current edit burst.
  const historyRef = useRef<Map<string, History>>(new Map());
  const pendingBaseRef = useRef<Map<string, TwitterTemplateSettings>>(new Map());

  useEffect(() => {
    historyRef.current.clear();
    pendingBaseRef.current.clear();
    if (!userId) {
      const t = setTimeout(() => { setTemplates([]); setLoaded(true); }, 0);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      const { data, error: loadErr } = await supabase
        .from('twitter_templates')
        .select('*')
        .eq('user_id', userId)
        .order('position');
      if (cancelled) return;
      if (loadErr) setError(loadErr.message);
      else setTemplates((data ?? []).map(r => ({
        id: r.id, name: r.name, position: r.position,
        settings: resolveTwitterTemplateSettings(r.settings),
      })));
      setLoading(false);
      setLoaded(true);
    }, 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [userId]);

  // Persist a settings blob for one template, driving the autosave chip ('saving' → 'saved' → 'idle').
  const persist = useCallback(async (id: string, settings: TwitterTemplateSettings) => {
    setSaveState('saving');
    const { error: saveErr } = await supabase.from('twitter_templates').update({ settings }).eq('id', id);
    if (saveErr) { setError(saveErr.message); setSaveState('error'); return; }
    setSaveState('saved');
    if (savedRevertRef.current) clearTimeout(savedRevertRef.current);
    savedRevertRef.current = setTimeout(() => setSaveState(prev => (prev === 'saved' ? 'idle' : prev)), 1500);
  }, []);

  // Flush (not just cancel) pending autosaves on unmount so the last debounced edit isn't lost when the
  // editor unmounts within the 500ms window — e.g. the Carousel<->Reels toggle or a sidebar nav.
  // Fire-and-forget is fine for in-app navigation (the JS context survives); tab-close/backgrounding is
  // handled best-effort by the pagehide/visibilitychange effect below. Mirrors useTemplateEditor.
  useEffect(() => {
    const timers = saveTimers.current;
    return () => {
      for (const [id, t] of timers) {
        clearTimeout(t);
        const current = templatesRef.current.find(tp => tp.id === id);
        // .then() is what actually FIRES the request — a bare `void builder` never executes
        // (PostgrestBuilder is lazy: the fetch happens inside then/await only).
        if (current) void supabase.from('twitter_templates').update({ settings: current.settings }).eq('id', id).then(() => {}, () => {});
      }
      timers.clear();
      if (savedRevertRef.current) clearTimeout(savedRevertRef.current);
    };
  }, []);

  // Best-effort flush on tab-close / backgrounding. supabase-js uses plain fetch (no keepalive), so delivery
  // isn't guaranteed on a hard tab-close, but this reliably covers backgrounding/switching-away within the
  // 500ms autosave debounce — the common "I tabbed away right after editing" case. In-app unmount is above.
  useEffect(() => {
    const flushAll = () => {
      const timers = saveTimers.current;
      for (const [id, t] of timers) {
        clearTimeout(t);
        const current = templatesRef.current.find(tp => tp.id === id);
        // .then() fires the lazy builder — see the unmount flush above.
        if (current) void supabase.from('twitter_templates').update({ settings: current.settings }).eq('id', id).then(() => {}, () => {});
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
  }, []);

  const createTemplate = useCallback(async (): Promise<TwitterTemplate | null> => {
    if (!userId) return null;
    const n = templatesRef.current.length;
    // "Reels Template N" = one above the highest existing number (renaming N→N+1 won't free N for reuse).
    let max = 0;
    for (const t of templatesRef.current) {
      const m = /^Reels Template (\d+)$/.exec(t.name.trim());
      if (m) max = Math.max(max, Number(m[1]));
    }
    const name = `Reels Template ${max + 1}`;
    const settings = defaultTwitterTemplateSettings();
    const { data, error: insErr } = await supabase
      .from('twitter_templates')
      .insert({ user_id: userId, name, position: n, settings })
      .select('*')
      .single();
    if (insErr || !data) {
      // Free-plan template cap (DB trigger, supabase/free_tier.sql) → upgrade prompt, not an error.
      const upgrade = upgradeReasonForDbError(insErr?.message);
      if (upgrade) { requestUpgrade(upgrade); return null; }
      setError(insErr?.message ?? 'Failed to create template'); return null;
    }
    const created: TwitterTemplate = {
      id: data.id, name: data.name, position: data.position,
      settings: resolveTwitterTemplateSettings(data.settings),
    };
    setTemplates(prev => [...prev, created]);
    return created;
  }, [userId]);

  // Duplicate a template in place ("<name> copy"), cloning its style blob, then return the new row.
  const duplicateTemplate = useCallback(async (id: string): Promise<TwitterTemplate | null> => {
    if (!userId) return null;
    const src = templatesRef.current.find(t => t.id === id);
    if (!src) return null;
    const n = templatesRef.current.length;
    const { data, error: insErr } = await supabase
      .from('twitter_templates')
      .insert({ user_id: userId, name: `${src.name} copy`, position: n, settings: src.settings })
      .select('*')
      .single();
    if (insErr || !data) {
      const upgrade = upgradeReasonForDbError(insErr?.message);
      if (upgrade) { requestUpgrade(upgrade); return null; }
      setError(insErr?.message ?? 'Failed to duplicate template'); return null;
    }
    const created: TwitterTemplate = {
      id: data.id, name: data.name, position: data.position,
      settings: resolveTwitterTemplateSettings(data.settings),
    };
    setTemplates(prev => [...prev, created]);
    return created;
  }, [userId]);

  const renameTemplate = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (templatesRef.current.some(t => t.id !== id && t.name.trim().toLowerCase() === trimmed.toLowerCase())) {
      setError('That name is already taken.');
      return;
    }
    setTemplates(prev => prev.map(t => (t.id === id ? { ...t, name: trimmed } : t)));
    const { error: upErr } = await supabase.from('twitter_templates').update({ name: trimmed }).eq('id', id);
    if (upErr) setError(upErr.message);
  }, []);

  const deleteTemplate = useCallback(async (id: string) => {
    const timer = saveTimers.current.get(id);
    if (timer) { clearTimeout(timer); saveTimers.current.delete(id); }
    historyRef.current.delete(id);
    pendingBaseRef.current.delete(id);
    const doomed = templatesRef.current.find(t => t.id === id); // settings hold any uploaded-media URLs
    setTemplates(prev => prev.filter(t => t.id !== id));
    const { error: delErr } = await supabase.from('twitter_templates').delete().eq('id', id);
    if (delErr) setError(delErr.message);
    else if (doomed) void cleanupMediaRefs(collectMediaRefs(doomed.settings)); // GC media nothing else references
  }, []);

  const updateSettings = useCallback((id: string, partial: Partial<TwitterTemplateSettings>) => {
    // Start an undo burst: snapshot the pre-edit settings once, until the debounce commits it.
    if (!pendingBaseRef.current.has(id)) {
      const cur = templatesRef.current.find(t => t.id === id);
      if (cur) { pendingBaseRef.current.set(id, cur.settings); setHistTick(x => x + 1); }
    }
    // Raw partial merge (no re-normalize): safe because t.settings was already resolved on load
    // (resolveTwitterTemplateSettings degrades legacy cell types) and the UI can't emit removed types.
    setTemplates(prev => prev.map(t => (t.id === id ? { ...t, settings: { ...t.settings, ...partial } } : t)));
    const timers = saveTimers.current;
    const existing = timers.get(id);
    if (existing) clearTimeout(existing);
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      // Commit the burst into history (the base captured at burst start) and clear the redo stack.
      const base = pendingBaseRef.current.get(id);
      pendingBaseRef.current.delete(id);
      const current = templatesRef.current.find(t => t.id === id);
      if (base && current) {
        const h = historyRef.current.get(id) ?? { past: [], future: [] };
        h.past.push(base);
        if (h.past.length > HISTORY_LIMIT) h.past.shift();
        h.future = [];
        historyRef.current.set(id, h);
      }
      if (current) void persist(id, current.settings);
    }, 500));
  }, [persist]);

  const applySettings = useCallback((id: string, settings: TwitterTemplateSettings) => {
    setTemplates(prev => prev.map(t => (t.id === id ? { ...t, settings } : t)));
    void persist(id, settings);
  }, [persist]);

  const undo = useCallback((id: string | null) => {
    if (!id) return;
    // Flush any in-flight burst timer so history stays consistent.
    const timer = saveTimers.current.get(id);
    if (timer) { clearTimeout(timer); saveTimers.current.delete(id); }
    const current = templatesRef.current.find(t => t.id === id);
    if (!current) return;
    const h = historyRef.current.get(id) ?? { past: [], future: [] };
    const pendingBase = pendingBaseRef.current.get(id);
    if (pendingBase !== undefined) {
      // An uncommitted edit burst → revert to its base in a single step.
      pendingBaseRef.current.delete(id);
      h.future.push(current.settings);
      historyRef.current.set(id, h);
      applySettings(id, pendingBase);
      setHistTick(x => x + 1);
      return;
    }
    if (h.past.length === 0) return;
    const base = h.past.pop()!;
    h.future.push(current.settings);
    historyRef.current.set(id, h);
    applySettings(id, base);
    setHistTick(x => x + 1);
  }, [applySettings]);

  const redo = useCallback((id: string | null) => {
    if (!id) return;
    const current = templatesRef.current.find(t => t.id === id);
    if (!current) return;
    const h = historyRef.current.get(id);
    if (!h || h.future.length === 0) return;
    const next = h.future.pop()!;
    h.past.push(current.settings);
    historyRef.current.set(id, h);
    applySettings(id, next);
    setHistTick(x => x + 1);
  }, [applySettings]);

  const canUndo = useCallback((id: string | null) => {
    if (!id) return false;
    if (pendingBaseRef.current.has(id)) return true;
    return (historyRef.current.get(id)?.past.length ?? 0) > 0;
  }, []);
  const canRedo = useCallback((id: string | null) => {
    if (!id) return false;
    return (historyRef.current.get(id)?.future.length ?? 0) > 0;
  }, []);

  return {
    templates, loading, loaded, error, setError, saveState,
    createTemplate, duplicateTemplate, renameTemplate, deleteTemplate, updateSettings,
    undo, redo, canUndo, canRedo,
  };
}
