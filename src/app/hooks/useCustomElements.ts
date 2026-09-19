'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { ElementInput } from '@/lib/customElements/runtime';

// A user's saved AI-generated elements (custom_elements table). The element's render code is stored as a
// string; the on-canvas instance snapshots it (see FreeElement 'custom').
export interface CustomElementRecord {
  id: string;
  name: string;
  description: string;
  code: string;
  inputSchema: ElementInput[];
  defaultData: unknown;
  size: { w: number; h: number; aspect: number };
}

// What the generator returns (no id yet) — also the shape `saveElement` persists.
export type NewCustomElement = Omit<CustomElementRecord, 'id'>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRecord(row: Record<string, any>): CustomElementRecord {
  return {
    id: row.id,
    name: row.name ?? 'Untitled element',
    description: row.description ?? '',
    code: row.code ?? '',
    inputSchema: Array.isArray(row.input_schema) ? (row.input_schema as ElementInput[]) : [],
    defaultData: row.default_data ?? null,
    size: row.size && typeof row.size === 'object' ? row.size : { w: 720, h: 460, aspect: 720 / 460 },
  };
}

export function useCustomElements(userId: string | null | undefined) {
  const [elements, setElements] = useState<CustomElementRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!userId) { setElements([]); setLoading(false); return; }
    const { data } = await supabase
      .from('custom_elements')
      .select('id,name,description,code,input_schema,default_data,size')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setElements(((data ?? []) as Record<string, any>[]).map(toRecord));
    setLoading(false);
  }, [userId]);

  // Load on mount / user change — inline async IIFE so setState happens after the await (not synchronously
  // in the effect body). Mirrors the other data hooks.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!userId) { if (!cancelled) { setElements([]); setLoading(false); } return; }
      const { data } = await supabase
        .from('custom_elements')
        .select('id,name,description,code,input_schema,default_data,size')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });
      if (cancelled) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setElements(((data ?? []) as Record<string, any>[]).map(toRecord));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // Persist a generated element; returns the saved record (with its new id) or null on failure.
  const saveElement = useCallback(async (el: NewCustomElement): Promise<CustomElementRecord | null> => {
    if (!userId) return null;
    const { data, error } = await supabase
      .from('custom_elements')
      .insert({
        user_id: userId,
        name: el.name, description: el.description, code: el.code,
        input_schema: el.inputSchema, default_data: el.defaultData ?? null, size: el.size,
      })
      .select('id,name,description,code,input_schema,default_data,size')
      .single();
    if (error || !data) return null;
    const rec = toRecord(data);
    setElements(prev => [rec, ...prev]);
    return rec;
  }, [userId]);

  const removeElement = useCallback(async (id: string) => {
    setElements(prev => prev.filter(e => e.id !== id));
    await supabase.from('custom_elements').delete().eq('id', id);
  }, []);

  const renameElement = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setElements(prev => prev.map(e => (e.id === id ? { ...e, name: trimmed } : e)));
    await supabase.from('custom_elements').update({ name: trimmed, updated_at: new Date().toISOString() }).eq('id', id);
  }, []);

  const duplicateElement = useCallback(async (id: string): Promise<CustomElementRecord | null> => {
    const src = elements.find(e => e.id === id);
    if (!src) return null;
    return saveElement({
      name: `${src.name} copy`, description: src.description, code: src.code,
      inputSchema: src.inputSchema, defaultData: src.defaultData, size: src.size,
    });
  }, [elements, saveElement]);

  return { elements, loading, saveElement, removeElement, renameElement, duplicateElement, reload };
}
