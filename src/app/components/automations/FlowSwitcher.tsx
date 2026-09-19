'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, Modal, Switch } from '@/app/components/ui';
import { ChevronDownIcon, CloseIcon, PlusIcon } from '@/lib/icons';
import { NAME_MAX_LENGTH } from '@/lib/ui-constants';
import type { AutomationMeta } from '@/app/hooks/useAutomationFlow';

// Centered name dropdown for the automations header — switch / create / rename / delete, mirroring the
// template-editor dropdown's structure. Click the active flow's row to rename it inline.
export function FlowSwitcher({ flows, activeId, onSelect, onCreate, onRename, onDelete, onToggleEnabled }: {
  flows: AutomationMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onToggleEnabled: (id: string, next: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<AutomationMeta | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  const active = flows.find(f => f.id === activeId);

  function commitRename() {
    if (renamingId && renameValue.trim()) onRename(renamingId, renameValue.trim());
    setRenamingId(null);
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) { commitRename(); setOpen(false); }
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { setOpen(false); setRenamingId(null); } }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, renamingId, renameValue]);

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={() => { setRenamingId(null); setOpen(o => !o); }}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-fg hover:bg-hover focus-ring"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-fg-3" aria-hidden>
          <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
        <span className="max-w-[160px] truncate text-subheading text-fg" title={active?.name ?? undefined}>{active?.name ?? 'Untitled automation'}</span>
        <ChevronDownIcon size={12} className="shrink-0 text-fg-3" aria-hidden />
      </button>

      {open && (
        <div className="absolute left-1/2 top-full z-modal mt-2 w-[260px] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface-2 py-1 shadow-3">
          <div className="max-h-[320px] overflow-y-auto scrollbar-none">
            {flows.map(f => {
              const isActive = f.id === activeId;
              const isRenaming = renamingId === f.id;
              return (
                <div key={f.id} className={`flex items-center gap-1 px-2 ${isActive ? 'bg-active' : ''}`}>
                  {isRenaming ? (
                    <input
                      autoFocus
                      maxLength={NAME_MAX_LENGTH}
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onFocus={e => e.currentTarget.select()}
                      onBlur={commitRename}
                      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenamingId(null); }}
                      onClick={e => e.stopPropagation()}
                      className="my-1 min-w-0 flex-1 rounded-md bg-surface-3 px-2 py-1.5 text-subheading text-fg outline-none focus-ring"
                    />
                  ) : (
                    <button
                      onClick={() => {
                        if (isActive) { setRenameValue(f.name); setRenamingId(f.id); }
                        else { onSelect(f.id); setOpen(false); }
                      }}
                      title={f.name}
                      className={`min-w-0 flex-1 truncate rounded-sm px-1 py-2 text-left text-subheading ${isActive ? 'text-fg' : 'text-fg-2 hover:text-fg'}`}
                    >
                      {f.name}
                    </button>
                  )}
                  {/* Hide the toggle + delete while renaming so the input spans the full width (reveals the whole name). */}
                  {!isRenaming && <>
                  <Switch
                    checked={f.enabled}
                    onChange={next => onToggleEnabled(f.id, next)}
                    label={`${f.enabled ? 'Disable' : 'Enable'} scheduled runs for ${f.name}`}
                  />
                  <IconButton size="sm" variant="danger" label={`Delete ${f.name}`} className="size-5"
                    onClick={e => { e.stopPropagation(); setConfirmDelete(f); }} icon={<CloseIcon size={13} aria-hidden />} />
                  </>}
                </div>
              );
            })}
          </div>
          <div className="border-t border-line p-1">
            <button
              onClick={() => { setOpen(false); onCreate(); }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-subheading text-fg-2 hover:bg-hover hover:text-fg focus-ring"
            >
              <PlusIcon size={12} aria-hidden /> New automation
            </button>
          </div>
        </div>
      )}

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete automation"
        size="sm"
        variant="auth"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => { if (confirmDelete) onDelete(confirmDelete.id); setConfirmDelete(null); setOpen(false); }}>Delete</Button>
          </>
        }
      >
        <p className="text-body text-fg-2">Delete <span className="font-semibold text-fg">{confirmDelete?.name}</span>? This can’t be undone.</p>
      </Modal>
    </div>
  );
}
