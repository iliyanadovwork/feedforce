'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Graph } from '@/lib/automations';

// Manages a user's automations (multiple flows), mirroring the template editor's model: a list you can
// switch between, create, rename and delete, plus per-flow graph autosave. Source of truth is the
// `automations` table (production/supabase/automations.sql).

export interface FlowRecord {
  id: string;
  name: string;
  graph: Graph;
  enabled: boolean;
  /** The stored row's updated_at — the optimistic-lock token for saves. */
  updatedAt: string | null;
}
export interface AutomationMeta { id: string; name: string; enabled: boolean }
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRecord(row: Record<string, any>): FlowRecord {
  return { id: row.id, name: row.name ?? 'Untitled automation', graph: (row.graph as Graph) ?? EMPTY_GRAPH, enabled: Boolean(row.enabled), updatedAt: row.updated_at ?? null };
}

async function insertFlow(userId: string, name: string): Promise<FlowRecord | null> {
  const { data, error } = await supabase
    .from('automations')
    .insert({ user_id: userId, name, graph: EMPTY_GRAPH, enabled: false })
    .select('id,name,graph,enabled,updated_at')
    .single();
  if (error || !data) return null;
  return toRecord(data);
}

// Module-level cache (per user) so re-entering the automations section renders the last-known flows
// instantly (no loader flash) while the fetch below refreshes in the background. Also remembers which
// flow was active so returning lands on the same one.
const flowsCache = new Map<string, { flows: FlowRecord[]; activeId: string | null }>();

export function useAutomations(userId: string | null | undefined) {
  const cached = userId ? flowsCache.get(userId) : undefined;
  const [flows, setFlows] = useState<FlowRecord[]>(cached?.flows ?? []);
  const [activeId, setActiveId] = useState<string | null>(cached?.activeId ?? null);
  const [loading, setLoading] = useState(!cached);
  const [status, setStatus] = useState<SaveStatus>('idle');

  // Keep the cache mirroring the live state (flows + active selection).
  useEffect(() => { if (userId) flowsCache.set(userId, { flows, activeId }); }, [userId, flows, activeId]);

  // Load all flows; ensure the user always has at least one so the canvas is never empty.
  useEffect(() => {
    let cancelled = false;
    if (!userId) { Promise.resolve().then(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }
    (async () => {
      const { data } = await supabase
        .from('automations')
        .select('id,name,graph,enabled,updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });
      if (cancelled) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let list = ((data ?? []) as Record<string, any>[]).map(toRecord);
      if (list.length === 0) {
        const created = await insertFlow(userId, 'Untitled automation');
        if (cancelled) return;
        if (created) list = [created];
      }
      setFlows(list);
      // Keep the previously-active flow selected if it still exists (cache restore); else the newest.
      setActiveId(prev => (prev && list.some(f => f.id === prev) ? prev : (list[0]?.id ?? null)));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const active = flows.find(f => f.id === activeId) ?? null;

  // Save the active flow's graph + enabled flag (name is managed via rename). Optimistic lock: the
  // update only applies when the row's updated_at still equals the one we loaded — another session
  // (or tab) saving in between makes THIS save a no-op and surfaces a 'conflict' instead of silently
  // clobbering their graph with ours.
  const saveActive = useCallback(async (graph: Graph, enabled: boolean): Promise<string | null> => {
    if (!userId || !activeId) return null;
    const current = flows.find(f => f.id === activeId);
    setStatus('saving');
    let query = supabase
      .from('automations')
      .update({ graph, enabled, updated_at: new Date().toISOString() })
      .eq('id', activeId);
    if (current?.updatedAt) query = query.eq('updated_at', current.updatedAt);
    const { data, error } = await query.select('updated_at');
    const row = (data as Array<{ updated_at: string }> | null)?.[0];
    if (!error && !row) {
      // Zero rows matched → the stored row moved under us. Refresh the lock token so a deliberate
      // re-save ("Retry") wins with last-write, but the user has been told first.
      const { data: fresh } = await supabase.from('automations').select('updated_at').eq('id', activeId).maybeSingle();
      const freshAt = (fresh as { updated_at?: string } | null)?.updated_at ?? null;
      setFlows(prev => prev.map(f => (f.id === activeId ? { ...f, updatedAt: freshAt } : f)));
      setStatus('conflict');
      return null;
    }
    // Only mirror into local state on success — a failed save must keep showing "Retry save", not
    // pretend the in-memory graph is what's stored.
    if (!error) setFlows(prev => prev.map(f => (f.id === activeId ? { ...f, graph, enabled, updatedAt: row?.updated_at ?? f.updatedAt } : f)));
    setStatus(error ? 'error' : 'saved');
    return error ? null : activeId;
  }, [userId, activeId, flows]);

  const select = useCallback((id: string) => setActiveId(id), []);

  const create = useCallback(async () => {
    if (!userId) return;
    const rec = await insertFlow(userId, 'Untitled automation');
    if (rec) { setFlows(prev => [rec, ...prev]); setActiveId(rec.id); }
  }, [userId]);

  // Toggle a flow's scheduled-runs flag on/off and persist immediately (used by both the header switch
  // and the per-automation toggle in the dropdown). Optimistic; the flows list is the source of truth.
  const toggleEnabled = useCallback(async (id: string, next: boolean) => {
    setFlows(prev => prev.map(f => (f.id === id ? { ...f, enabled: next } : f)));
    const { data, error } = await supabase.from('automations').update({ enabled: next, updated_at: new Date().toISOString() }).eq('id', id).select('updated_at');
    // Failed persist → revert the optimistic flip so the switch reflects what's actually stored
    // (an "enabled" that didn't save means scheduled runs silently never happen).
    if (error) { setFlows(prev => prev.map(f => (f.id === id ? { ...f, enabled: !next } : f))); setStatus('error'); return; }
    // Mirror the new updated_at so the next graph save's optimistic lock doesn't false-conflict.
    const at = (data as Array<{ updated_at: string }> | null)?.[0]?.updated_at;
    if (at) setFlows(prev => prev.map(f => (f.id === id ? { ...f, updatedAt: at } : f)));
  }, []);

  const rename = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    let prevName: string | undefined;
    setFlows(prev => prev.map(f => { if (f.id === id) { prevName = f.name; return { ...f, name: trimmed }; } return f; }));
    const { error } = await supabase.from('automations').update({ name: trimmed }).eq('id', id);
    if (error) setFlows(prev => prev.map(f => (f.id === id && prevName !== undefined ? { ...f, name: prevName } : f)));
  }, []);

  const remove = useCallback(async (id: string) => {
    const { error } = await supabase.from('automations').delete().eq('id', id);
    if (error) { setStatus('error'); return; } // row still exists — keep it in the list
    const remaining = flows.filter(f => f.id !== id);
    if (remaining.length === 0 && userId) {
      const rec = await insertFlow(userId, 'Untitled automation');
      setFlows(rec ? [rec] : []);
      setActiveId(rec?.id ?? null);
      return;
    }
    setFlows(remaining);
    if (id === activeId) setActiveId(remaining[0]?.id ?? null);
  }, [flows, activeId, userId]);

  const metas: AutomationMeta[] = flows.map(f => ({ id: f.id, name: f.name, enabled: f.enabled }));

  return { flows: metas, activeId, active, loading, status, select, create, rename, remove, saveActive, toggleEnabled };
}
