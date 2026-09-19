'use client';

import { useCallback, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { ElementInput } from '@/lib/customElements/runtime';
import type { NewCustomElement } from './useCustomElements';

// The shared, curated element library (public_elements table) — readable by any authenticated user,
// distinct from a user's own custom_elements. Browsed in the "New element" flyout's "Browse library"
// tab; "adding" one copies it into the current user's custom_elements via saveElement.
export interface PublicElementRecord {
  id: string;
  authorName: string;
  name: string;
  description: string;
  code: string;
  inputSchema: ElementInput[];
  defaultData: unknown;
  size: { w: number; h: number; aspect: number };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRecord(row: Record<string, any>): PublicElementRecord {
  return {
    id: row.id,
    authorName: row.author_name ?? 'Digital Estate',
    name: row.name ?? 'Untitled element',
    description: row.description ?? '',
    code: row.code ?? '',
    inputSchema: Array.isArray(row.input_schema) ? (row.input_schema as ElementInput[]) : [],
    defaultData: row.default_data ?? null,
    size: row.size && typeof row.size === 'object' ? row.size : { w: 720, h: 460, aspect: 720 / 460 },
  };
}

export function toNewCustomElement(el: PublicElementRecord): NewCustomElement {
  return {
    name: el.name, description: el.description, code: el.code,
    inputSchema: el.inputSchema, defaultData: el.defaultData, size: el.size,
  };
}

export function usePublicElements() {
  const [elements, setElements] = useState<PublicElementRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Caller-driven fetch (e.g. on first open of the "Browse library" tab) rather than on mount — this
  // hook lives inside the always-mounted element rail, and the library rarely gets opened.
  const ensureLoaded = useCallback(async () => {
    if (loaded || loading) return;
    setLoading(true);
    const { data } = await supabase
      .from('public_elements')
      .select('id,author_name,name,description,code,input_schema,default_data,size')
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setElements(((data ?? []) as Record<string, any>[]).map(toRecord));
    setLoading(false);
    setLoaded(true);
  }, [loaded, loading]);

  return { elements, loading, ensureLoaded };
}
