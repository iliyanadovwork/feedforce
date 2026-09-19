'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getAtPath } from '@/lib/automations';

// A drill-down picker for a path into a JSON object (replaces a huge flat dropdown). You navigate one
// level at a time: containers show {N}/[N] and drill in; leaves show a value preview and are pickable.
// Breadcrumbs jump back up; arrays get an index box for deep/long lists. Not a native <select>.

function entriesOf(val: unknown): { key: string; child: unknown }[] {
  if (Array.isArray(val)) return val.map((child, i) => ({ key: String(i), child }));
  if (val && typeof val === 'object') return Object.entries(val as Record<string, unknown>).map(([key, child]) => ({ key, child }));
  return [];
}
const isContainer = (v: unknown) => v !== null && typeof v === 'object';
function preview(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return `"${v.length > 18 ? v.slice(0, 18) + '…' : v}"`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

export function JsonPathPicker({ data, value, onChange, placeholder = 'Choose field…' }: {
  data: unknown; value: string; onChange: (path: string) => void; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState('');
  const [indexInput, setIndexInput] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Anchor the (portalled) panel under the trigger. Fixed coords = viewport-relative, matching the rect.
  function openAt() {
    const r = ref.current?.getBoundingClientRect();
    if (r) {
      const width = Math.max(r.width, 288);
      const left = Math.min(r.left, window.innerWidth - width - 8);
      setPos({ top: r.bottom + 4, left: Math.max(8, left), width });
    }
    setCursor(''); setIndexInput(''); setOpen(o => !o);
  }

  useEffect(() => {
    if (!open) return;
    // The panel is portalled outside `ref`, so check it too before treating a click as "outside".
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const current = getAtPath(data, cursor);
  const entries = entriesOf(current);
  const crumbs = cursor ? cursor.split('.') : [];
  const isArr = Array.isArray(current);
  const childPath = (key: string) => (cursor ? `${cursor}.${key}` : key);
  const pick = (path: string) => { onChange(path); setOpen(false); };

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <button type="button" onClick={openAt}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-line bg-surface-1 px-2.5 text-left text-caption focus-ring">
        <span className={`truncate font-mono text-[11px] ${value ? 'text-fg' : 'text-fg-3'}`}>{value || placeholder}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-fg-3" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          className="fixed overflow-hidden rounded-lg border border-line bg-surface-overlay shadow-3 backdrop-blur-sm"
          style={{ top: pos.top, left: pos.left, width: pos.width, zIndex: 2147483000 }}
        >
          {/* Breadcrumbs */}
          <div className="flex flex-wrap items-center gap-1 border-b border-line px-2.5 py-2 text-[11px] text-fg-3">
            <button className="hover:text-fg" onClick={() => { setCursor(''); setIndexInput(''); }}>root</button>
            {crumbs.map((c, i) => {
              const path = crumbs.slice(0, i + 1).join('.');
              return <span key={path} className="flex items-center gap-1"><span className="text-fg-4">/</span><button className="hover:text-fg" onClick={() => setCursor(path)}>{c}</button></span>;
            })}
            <span className="ml-auto flex items-center gap-2">
              {/* Select the whole current object/array (not just a leaf) — needed for chart/list inputs. */}
              {cursor && isContainer(current) && (
                <button className="rounded bg-accent-tint px-1.5 py-0.5 text-accent-text hover:brightness-110" onClick={() => pick(cursor)}>use this</button>
              )}
              <button className="text-fg-4 hover:text-fg" onClick={() => pick('')}>clear</button>
            </span>
          </div>

          {/* Array index jump */}
          {isArr && (
            <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5 text-[11px] text-fg-3">
              <span>{(current as unknown[]).length} items · jump to</span>
              <input
                value={indexInput}
                onChange={e => setIndexInput(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={e => {
                  if (e.key !== 'Enter' || indexInput === '') return;
                  const i = Number(indexInput);
                  if (i < (current as unknown[]).length) {
                    const cp = childPath(String(i));
                    if (isContainer((current as unknown[])[i])) { setCursor(cp); setIndexInput(''); } else pick(cp);
                  }
                }}
                placeholder="0"
                className="h-6 w-16 rounded border border-line bg-surface-1 px-1.5 text-[11px] text-fg focus-ring"
              />
            </div>
          )}

          {/* Entries at the current level */}
          <div className="max-h-64 overflow-y-auto py-1">
            {entries.length === 0 && <p className="px-3 py-2 text-[11px] text-fg-3">No fields here.</p>}
            {entries.slice(0, 100).map(({ key, child }) => {
              const cp = childPath(key);
              const container = isContainer(child);
              return (
                <div key={key} className="flex w-full items-center hover:bg-hover">
                  {/* Click drills into a container (or picks a leaf); the "use" button picks the container itself. */}
                  <button onClick={() => { if (container) { setCursor(cp); setIndexInput(''); } else pick(cp); }}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-caption focus-ring">
                    <span className="truncate font-mono text-[11px] text-fg-2">{isArr ? `[${key}]` : key}</span>
                    {container ? (
                      <span className="ml-auto flex items-center gap-1 text-fg-4">
                        <span className="text-[10px]">{Array.isArray(child) ? `[ ${(child as unknown[]).length} ]` : `{ ${Object.keys(child as object).length} }`}</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m9 6 6 6-6 6" /></svg>
                      </span>
                    ) : (
                      <span className="ml-auto truncate text-[11px] text-fg-4">{preview(child)}</span>
                    )}
                  </button>
                  {container && (
                    <button onClick={() => pick(cp)} title={`Use ${isArr ? `[${key}]` : key} as the value`}
                      className="mr-1.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] text-accent-text hover:bg-accent-tint focus-ring">use</button>
                  )}
                </div>
              );
            })}
            {entries.length > 100 && <p className="px-3 py-1 text-[10px] text-fg-4">+{entries.length - 100} more — use the index box.</p>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
