'use client';

import { useState, type RefObject } from 'react';
import { findTrigger, filterCommands, applyInsertion, type SlashCommand } from '@/lib/editorTools/slashCommands';

export interface MenuItem { key: string; label: string; hint?: string; insert: string }
interface MenuState { items: MenuItem[]; index: number; start: number; caret: number }

// Drives the "/" command and "@" slide-mention autocomplete for a copilot textarea. The panel owns the
// textarea + keyboard wiring and renders `menu` (via <CommandMenu>); this hook computes the suggestions
// from the caret position and applies a selection (expanding a command's prompt / inserting a slide ref).
export function useCommandMenu(opts: {
  commands: SlashCommand[];
  getSlides?: () => { id: string; name: string; position: number }[];   // omit for reels (no slides → no "@")
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setValue: (v: string) => void;
}) {
  const { commands, getSlides, inputRef, setValue } = opts;
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Recompute from the current value + caret (call on change and on caret moves).
  const sync = (value: string, caret: number) => {
    const trig = findTrigger(value, caret);
    if (!trig || (trig.type === '@' && !getSlides)) { setMenu(null); return; }
    let items: MenuItem[];
    if (trig.type === '/') {
      items = filterCommands(commands, trig.query).map(c => ({ key: c.cmd, label: c.cmd, hint: c.label, insert: c.prompt }));
    } else {
      const q = trig.query.toLowerCase();
      items = (getSlides?.() ?? [])
        .filter(s => !q || String(s.position).startsWith(q) || s.name.toLowerCase().includes(q))
        .map(s => ({ key: s.id, label: `slide ${s.position}`, hint: s.name, insert: `slide ${s.position}` }));
    }
    setMenu(items.length ? { items, index: 0, start: trig.start, caret } : null);
  };

  const move = (dir: 1 | -1) => setMenu(m => (m ? { ...m, index: (m.index + dir + m.items.length) % m.items.length } : null));
  const setIndex = (index: number) => setMenu(m => (m ? { ...m, index } : null));
  const close = () => setMenu(null);

  const select = (item: MenuItem) => {
    const el = inputRef.current;
    const value = el?.value ?? '';
    setMenu(cur => {
      if (!cur) return null;
      const { text, caret } = applyInsertion(value, cur.start, cur.caret, item.insert);
      setValue(text);
      // Restore focus + caret after React commits the new value.
      requestAnimationFrame(() => { const e = inputRef.current; if (e) { e.focus(); e.setSelectionRange(caret, caret); } });
      return null;
    });
  };

  return { menu, sync, move, setIndex, close, select };
}
