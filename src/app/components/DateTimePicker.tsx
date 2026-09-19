'use client';

import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@/lib/icons';

// App-native date + time picker. Replaces <input type="datetime-local"> and its OS-drawn calendar button
// with a control that matches the design system. `value` stays the same datetime-local string every caller
// already uses (new Date(value) in / toLocalInput out), so submit + validation are unchanged. 24-hour, like
// the calendar views. The popover renders in a PORTAL with fixed positioning, so it never clips inside a
// scroll container or modal. A past time can never be produced: past days are disabled, past hour/minute
// options are disabled on the min day, and every emit snaps up to `min`.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');
function toLocalInput(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const POPOVER_W = 300;
const POPOVER_H = 360;   // estimate used only to choose up/down placement

function CalendarGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

export function DateTimePicker({
  value, onChange, min, timezone, disabled = false, invalid = false, size = 'md', placeholder = 'Pick date and time', ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  min: Date;
  timezone?: string;
  disabled?: boolean;
  invalid?: boolean;
  size?: 'sm' | 'md';
  placeholder?: string;
  ariaLabel?: string;   // accessible name for the trigger (the visible text can be a placeholder/date, so callers should pass one)
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const parsed = useMemo(() => { const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; }, [value]);
  const hasValue = value !== '' && parsed !== null;
  const selected = parsed ?? min;   // calendar reference when the value is unset
  const [cursor, setCursor] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));

  // Position the portaled popover relative to the trigger; re-run on scroll (capture, to catch ancestor
  // scroll containers) and resize so it follows the trigger.
  useEffect(() => {
    if (!open) return;
    function place() {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight, gap = 4, margin = 8;
      const below = vh - r.bottom;
      const openDown = below >= POPOVER_H + gap || below >= r.top;
      const top = openDown ? r.bottom + gap : Math.max(margin, r.top - gap - POPOVER_H);
      const left = Math.max(margin, Math.min(r.left, vw - POPOVER_W - margin));
      setPos({ top, left });
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    // Clear the position on close so a reopen (after the trigger moved, e.g. the list was scrolled) never
    // paints the popover at a stale spot for a frame; it re-renders only once place() sets a fresh position.
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); setPos(null); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (containerRef.current?.contains(t) || popoverRef.current?.contains(t)) return;   // the popover is portaled, so check it too
      setOpen(false);
    }
    // Escape must dismiss THIS popover, not a surrounding Modal. A Modal listens for Escape in the capture
    // phase on `document` and stopPropagation()s it, so listen on `window` in CAPTURE (window is outermost,
    // fires before document-capture) and stop the event so it never reaches the Modal's handler.
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey, true); };
  }, [open]);

  function toggle() {
    if (disabled) return;
    if (!open) setCursor(new Date(selected.getFullYear(), selected.getMonth(), 1));   // recenter on the selected (or min) month
    setOpen((o) => !o);
  }

  const grid = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [cursor]);

  const minDay = new Date(min.getFullYear(), min.getMonth(), min.getDate());
  const atMinMonth = cursor.getFullYear() === min.getFullYear() && cursor.getMonth() === min.getMonth();
  const selIsMinDay = sameDay(selected, min);

  // Emit a value, snapping up to `min` so a past time can never be produced by any interaction.
  function emit(next: Date) {
    onChange(toLocalInput(next.getTime() < min.getTime() ? new Date(min) : next));
  }
  function pickDay(d: Date) {
    if (d.getMonth() !== cursor.getMonth()) setCursor(new Date(d.getFullYear(), d.getMonth(), 1));   // spill-over day → follow it
    emit(new Date(d.getFullYear(), d.getMonth(), d.getDate(), selected.getHours(), selected.getMinutes()));
  }
  function setTime(h: number, m: number) {
    emit(new Date(selected.getFullYear(), selected.getMonth(), selected.getDate(), h, m));
  }

  const sm = size === 'sm';
  const label = hasValue
    ? selected.toLocaleString([], sm
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
      : { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : placeholder;

  return (
    <div ref={containerRef} className="relative">
      <button type="button" onClick={toggle} disabled={disabled} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open}
        className={`flex items-center gap-2 rounded-md border text-left focus-ring disabled:opacity-50 disabled:cursor-not-allowed ${
          sm ? 'h-8 px-2 text-caption bg-surface-2' : 'h-9 w-full px-2.5 text-body bg-surface-1'
        } ${invalid ? 'border-danger-border' : 'border-line hover:border-line-strong'}`}>
        <span className="shrink-0 text-fg-3"><CalendarGlyph size={sm ? 13 : 15} /></span>
        <span className={`flex-1 min-w-0 truncate tabular-nums ${hasValue ? 'text-fg' : 'text-fg-3'}`}>{label}</span>
        <ChevronDownIcon size={sm ? 12 : 14} className={`shrink-0 text-fg-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && pos && createPortal(
        <div ref={popoverRef} role="dialog" aria-label="Choose date and time"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPOVER_W }}
          className="z-toast rounded-lg border border-line bg-surface-3 shadow-3 p-3">
          <div className="flex items-center justify-between mb-2">
            <button type="button" aria-label="Previous month" disabled={atMinMonth}
              onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
              className="grid place-items-center size-7 rounded-md text-fg-3 hover:text-fg hover:bg-hover focus-ring disabled:opacity-30 disabled:cursor-not-allowed">
              <ChevronRightIcon size={15} className="rotate-180" aria-hidden />
            </button>
            <span className="text-body font-medium text-fg tabular-nums">{cursor.toLocaleString([], { month: 'long', year: 'numeric' })}</span>
            <button type="button" aria-label="Next month"
              onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
              className="grid place-items-center size-7 rounded-md text-fg-3 hover:text-fg hover:bg-hover focus-ring">
              <ChevronRightIcon size={15} aria-hidden />
            </button>
          </div>
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAYS.map((d) => <div key={d} className="grid place-items-center h-6 text-caption font-medium text-fg-3 select-none">{d[0]}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {grid.map((d) => {
              const inMonth = d.getMonth() === cursor.getMonth();
              const isPast = d.getTime() < minDay.getTime();
              const isSel = hasValue && sameDay(d, selected);
              const isToday = sameDay(d, min);
              return (
                <button key={d.toISOString()} type="button" disabled={isPast} onClick={() => pickDay(d)}
                  className={`grid place-items-center h-9 rounded-md text-body tabular-nums transition-colors focus-ring ${
                    isSel ? 'bg-action text-action-fg font-medium'
                      : isPast ? 'text-fg-4 opacity-40 cursor-not-allowed'
                        : isToday ? 'text-fg font-semibold hover:bg-hover'
                          : inMonth ? 'text-fg-2 hover:bg-hover' : 'text-fg-4 hover:bg-hover'
                  }`}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="mt-3 pt-3 border-t border-line flex items-center gap-2">
            <span className="text-caption text-fg-3">Time</span>
            <div className="ml-auto flex items-center gap-1">
              <TimeSelect ariaLabel="Hour" value={selected.getHours()} count={24}
                onChange={(h) => setTime(h, selected.getMinutes())}
                disabledBelow={selIsMinDay ? min.getHours() : -1} />
              <span className="text-fg-3">:</span>
              <TimeSelect ariaLabel="Minute" value={selected.getMinutes()} count={60}
                onChange={(m) => setTime(selected.getHours(), m)}
                disabledBelow={selIsMinDay && selected.getHours() === min.getHours() ? min.getMinutes() : -1} />
            </div>
          </div>
          {timezone && <p className="mt-2 text-caption text-fg-3">Your timezone: {timezone}</p>}
        </div>,
        document.body,
      )}
    </div>
  );
}

// Styled numeric select (hour 00-23 / minute 00-59). appearance-none + a drawn chevron so it matches the
// app instead of the OS control. Options before `disabledBelow` are disabled (past times on the min day).
function TimeSelect({ ariaLabel, value, count, onChange, disabledBelow }: {
  ariaLabel: string; value: number; count: number; onChange: (n: number) => void; disabledBelow: number;
}) {
  return (
    <div className="relative">
      <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="appearance-none h-8 rounded-md border border-line bg-surface-1 pl-2.5 pr-6 text-body text-fg tabular-nums focus-ring hover:border-line-strong cursor-pointer">
        {Array.from({ length: count }, (_, n) => <option key={n} value={n} disabled={n < disabledBelow}>{pad(n)}</option>)}
      </select>
      <ChevronDownIcon size={12} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-3" aria-hidden />
    </div>
  );
}
