'use client';

import { useEffect, useRef } from 'react';
import type { MenuItem } from '@/app/hooks/useCommandMenu';

// The "/" command + "@" slide autocomplete dropdown, rendered just above the copilot input. Keyboard
// nav lives in the panel (arrows/enter/esc); this is purely presentational + mouse selection.
export function CommandMenu({ items, index, onSelect, onHover }: {
  items: MenuItem[];
  index: number;
  onSelect: (item: MenuItem) => void;
  onHover: (index: number) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  // Keep the keyboard-highlighted row visible when arrowing past the scroll fold (long @slide lists).
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [index]);
  if (items.length === 0) return null;
  return (
    <div className="mb-1.5 max-h-56 overflow-y-auto rounded-lg border border-line bg-surface-1 py-1 shadow-lg">
      {items.map((it, i) => (
        <button
          key={it.key}
          ref={i === index ? activeRef : null}
          type="button"
          // onMouseDown (not click) so selecting doesn't blur the textarea first and close the menu.
          onMouseDown={e => { e.preventDefault(); onSelect(it); }}
          onMouseEnter={() => onHover(i)}
          className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[12px] ${i === index ? 'bg-hover text-fg' : 'text-fg-2'}`}
        >
          <span className="font-medium">{it.label}</span>
          {it.hint && <span className="truncate text-[11px] text-fg-4">{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}
