'use client';

import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/app/components/ui';
import { ChevronDownIcon } from '@/lib/icons';

// Custom account dropdown (not the native <select>, which can't show avatars): each row is the
// account's profile picture + @username. Shared by the Post page composer and the Automations post node.
export interface PickerAccount { _id: string; username: string; displayName?: string; profilePicture?: string | null }

export function AccountPicker({ accounts, value, onChange, label = 'Account' }: {
  accounts: PickerAccount[]; value: string; onChange: (id: string) => void; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = accounts.find((a) => a._id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="flex flex-col gap-1.5">
      {label && <span className="text-label text-fg-2">{label}</span>}
      <div ref={ref} className="relative">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
          className="w-full h-9 flex items-center gap-2 px-2.5 rounded-md border border-line bg-surface-1 text-left focus-ring hover:border-line-strong">
          {selected ? (
            <>
              <Avatar src={selected.profilePicture} fallback={(selected.username || '?').charAt(0)} size={20} />
              <span className="flex-1 min-w-0 truncate text-body text-fg">@{selected.username}</span>
            </>
          ) : <span className="flex-1 text-body text-fg-3">Select account</span>}
          <ChevronDownIcon size={14} className={`shrink-0 text-fg-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </button>
        {open && accounts.length > 0 && (
          <div role="listbox" className="absolute z-dropdown mt-1 w-full max-h-56 overflow-y-auto rounded-md border border-line bg-surface-3 shadow-2 p-1">
            {accounts.map((a) => {
              const isSel = a._id === value;
              return (
                <button key={a._id} type="button" role="option" aria-selected={isSel}
                  onClick={() => { onChange(a._id); setOpen(false); }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left focus-ring ${isSel ? 'bg-active' : 'hover:bg-hover'}`}>
                  <Avatar src={a.profilePicture} fallback={(a.username || '?').charAt(0)} size={24} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-body text-fg truncate">@{a.username}</span>
                    {a.displayName && <span className="block text-caption text-fg-3 truncate">{a.displayName}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
