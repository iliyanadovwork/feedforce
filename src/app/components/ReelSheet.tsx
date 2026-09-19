'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Modal, HEADER_H } from './ui';
import { AutosaveChip } from './AutosaveChip';
import { uploadSheetVideo, isUploadedVideoUrl, uploadedVideoDisplayName } from '@/lib/sheetVideoUpload';
import { layoutRect } from '@/lib/appZoom';
import { authedFetch } from '@/lib/authedFetch';
import { bestVideoUrl } from '@/lib/utils';
import { captureVideoFrames } from '@/lib/videoFrames';
import {
  useReelSheet, useSheetTabs, makeSheetRow, warmSheetRows,
  MAX_SHEETS, DEFAULT_TAB,
  type SheetRow, type SheetTab,
} from '../hooks/useReelSheet';

// The reels Content Sheet — the user's persistent backlog, upstream of the reels strip. A
// deliberately small spreadsheet: three fixed columns (Link, Caption, Description) with a real
// two-state cell model copied from Google Sheets — single click SELECTS a cell (arrow-key nav,
// type-to-replace, Enter/Tab to move, copy, clear); double-click / F2 / typing enters EDIT mode
// (caret inside, arrows move the caret, Enter/Tab/Escape/blur commit). Block paste from
// Sheets/Excel fans a TSV table out across rows. The user keeps several named sheets as a bottom
// tab strip (also Google Sheets style); each sheet persists via useReelSheet (one jsonb row per
// user+sheet), the tab list via useSheetTabs. The grid is keyed per sheet, so switching tabs
// remounts it — cursor state resets and the unmount flush commits any pending autosave.

const COLS = ['link', 'caption', 'description'] as const;
type Col = (typeof COLS)[number];

const COL_META: Record<Col, { label: string; placeholder: string }> = {
  link: { label: 'Link', placeholder: 'tiktok.com / x.com… or upload a video' },
  caption: { label: 'Caption', placeholder: 'Caption for the reel' },
  description: { label: 'Description', placeholder: 'Description (posted as the Instagram caption)' },
};

// Rows that look like a copied header line ("link  caption  description") are dropped on paste.
// Two filled cells minimum: a one-column paste that happens to start with "Video" is data, not a header.
const HEADER_WORDS = /^(link|url|video|reel|caption|text|title|description|notes?)$/i;

function looksLikeHeader(cells: string[]): boolean {
  const filled = cells.map(c => c.trim()).filter(Boolean);
  return filled.length >= 2 && filled.every(c => HEADER_WORDS.test(c));
}

// Unvirtualized grid — a paste bigger than this would lock the tab, and nobody's backlog needs it.
const MAX_PASTE_ROWS = 500;

// Walk `text` into a table, splitting cells on `delim` (a tab for clipboard paste, a comma for CSV) and
// honoring RFC-4180-style quoting: a cell wrapped in double quotes may contain the delimiter, newlines,
// and doubled quotes — so a naive split shreds multi-line captions into phantom rows. Walk with a quote
// state instead. Returns every row; the caller decides on header / blank-row handling.
function parseDelimited(text: string, delim: string): string[][] {
  const src = text.replace(/\r\n?/g, '\n');
  const table: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delim) {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell); table.push(row); row = []; cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  table.push(row);
  return table;
}

// Clipboard paste: TSV from Sheets/Excel. Returns null for a single-cell paste (the caller sets the
// active cell instead), else a table with a trailing blank row and a detected header row dropped.
function parseClipboardTable(text: string): string[][] | null {
  if (!text.includes('\t') && !text.includes('\n')) return null;
  const table = parseDelimited(text, '\t');
  while (table.length && table[table.length - 1].every(c => c.trim() === '')) table.pop(); // trailing newline
  if (table.length && looksLikeHeader(table[0])) table.shift();
  return table.length ? table.slice(0, MAX_PASTE_ROWS) : null;
}

const looksLikeUrl = (s: string) => /^(https?:\/\/|www\.)/i.test(s.trim());
const linkLooksValid = (link: string) => link.trim() === '' || looksLikeUrl(link);

// TSV-quote a cell value only when it contains a tab or newline — the two things that would make
// the paste parser fan it across rows/columns. Wrapping also doubles embedded quotes. A value with
// only a bare quote is left as-is: it doesn't fan out, and the parser (which engages solely on
// tab/newline) would otherwise never unwrap it, corrupting the in-app copy→paste round-trip.
function tsvEscape(v: string): string {
  return /[\t\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const isBlankRow = (r: SheetRow) => !r.link.trim() && !r.caption.trim() && !r.description.trim();

// RFC-4180 CSV: wrap a cell in quotes if it holds a comma, quote, or newline; double embedded quotes.
function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Serialize the sheet to CSV with a Link,Caption,Description header, skipping fully-blank rows.
function rowsToCsv(rows: SheetRow[]): string {
  const body = rows.filter(r => !isBlankRow(r)).map(r => [r.link, r.caption, r.description].map(csvEscape).join(','));
  return ['Link,Caption,Description', ...body].join('\r\n');
}

function downloadCsv(csv: string, filename: string): void {
  // Prepend a UTF-8 BOM so Excel opens emoji / non-ASCII captions in the right encoding.
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// The exported file carries the tab's name so two sheets don't download as identical files.
function csvFilename(sheetName: string): string {
  const slug = sheetName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `content-sheet-${slug}.csv` : 'content-sheet.csv';
}

interface ActiveCell { rowId: string; col: Col }

// Which sheet tab is open, restored across reloads like the reels view itself.
const SHEET_TAB_KEY = 'de:reels-sheet-tab';

export function ReelSheet({
  userId,
  viewToggle,
  onSendToReels,
  sendReady = true,
}: {
  userId: string | null;
  viewToggle: React.ReactNode;
  // Receives the rows to turn into reel entries; the sheet marks them 'sent' itself.
  onSendToReels: (rows: SheetRow[]) => void;
  // False until the reels strip has restored its saved rows — sending before that would let the
  // canvas restore clobber the freshly-appended entries.
  sendReady?: boolean;
}) {
  const { tabs, tabsLoaded, tabsError, retryTabs, creating, createSheet, renameSheet, deleteSheet } = useSheetTabs(userId);
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(SHEET_TAB_KEY);
  });
  // A stored id that no longer exists (deleted on another device, cleared storage) falls back to
  // the first tab; the effect below then repairs the stored value. Persisting is gated on a
  // successfully loaded tab list: while it loads (or on error) `tabs` is only the placeholder,
  // and stamping its fallback id would permanently overwrite the user's real stored tab.
  const active = tabs.find(t => t.sheetId === activeId) ?? tabs[0] ?? DEFAULT_TAB;
  useEffect(() => {
    if (!tabsLoaded || tabsError || !userId) return;
    try { localStorage.setItem(SHEET_TAB_KEY, active.sheetId); } catch { /* ignore */ }
  }, [active.sheetId, tabsLoaded, tabsError, userId]);

  // Start fetching the likely-active sheet's rows in parallel with the tab list, so a cold load
  // doesn't pay two serial round trips before the grid can render.
  const warmed = useRef(false);
  useEffect(() => {
    if (!userId || warmed.current) return;
    warmed.current = true;
    warmSheetRows(userId, activeId ?? DEFAULT_TAB.sheetId);
  }, [userId, activeId]);

  const addSheet = useCallback(async () => {
    const id = await createSheet();
    if (id) setActiveId(id);
  }, [createSheet]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-1">
      {!tabsLoaded || tabsError ? (
        // The grid is gated on the tab list: rendering a guessed sheet while it loads risks
        // autosaving into a tab that turns out not to exist. The toolbar shell still renders so
        // the canvas/sheet view toggle stays reachable.
        <>
          <Toolbar viewToggle={viewToggle} />
          <div className="flex-1 min-h-0 overflow-y-auto">
            {tabsError ? (
              <div className="px-4 py-10 text-center">
                <p className="text-caption text-fg-3">Couldn&apos;t load your sheets — editing is paused so nothing gets overwritten.</p>
                <button type="button" onClick={retryTabs} className="mt-2 text-caption underline underline-offset-2 text-fg-2 hover:text-fg focus-ring rounded-xs">
                  Try again
                </button>
              </div>
            ) : (
              <p className="px-4 py-10 text-center text-caption text-fg-3">Loading your sheets…</p>
            )}
          </div>
        </>
      ) : (
        // display:contents so the toolbar/body keep their flex-column placement; the div exists
        // only to give the tab strip's role=tab elements a tabpanel to point at.
        <div role="tabpanel" id="reel-sheet-panel" aria-label={active.name} className="contents">
          <SheetGrid
            key={`${userId ?? 'anon'}/${active.sheetId}`}
            userId={userId}
            sheetId={active.sheetId}
            sheetName={active.name}
            viewToggle={viewToggle}
            onSendToReels={onSendToReels}
            sendReady={sendReady}
          />
        </div>
      )}
      {tabsLoaded && !tabsError && (
        <TabStrip
          tabs={tabs}
          activeSheetId={active.sheetId}
          canMutate={!!userId}
          creating={creating}
          onSelect={setActiveId}
          onCreate={addSheet}
          onRename={renameSheet}
          onDelete={deleteSheet}
        />
      )}
    </div>
  );
}

// The sheet toolbar shell — also rendered bare while the tab list loads, so the view toggle
// (canvas ↔ sheet) never disappears.
function Toolbar({ viewToggle, right }: { viewToggle: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="relative flex items-center justify-between gap-4 px-4 border-b border-line shrink-0 bg-surface-1" style={{ height: HEADER_H }}>
      <div className="flex items-center">{viewToggle}</div>
      <div className="absolute inset-x-0 flex justify-center items-center pointer-events-none">
        <span className="text-subheading text-fg">Content sheet</span>
      </div>
      <div className="flex items-center gap-3">{right}</div>
    </div>
  );
}

// ── Sheet tab strip (bottom, Google Sheets style) ────────────────────────────────────────────────
// Click or Enter/Space selects; arrows move between tabs (roving tabindex, selection follows
// focus); double-click or F2 renames inline; × / Delete key deletes (confirmed — rows go with the
// sheet). Signed-out users get the single virtual tab with mutations hidden.
function TabStrip({
  tabs,
  activeSheetId,
  canMutate,
  creating,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  tabs: SheetTab[];
  activeSheetId: string;
  canMutate: boolean;
  creating: boolean;
  onSelect: (sheetId: string) => void;
  onCreate: () => void;
  onRename: (sheetId: string, name: string) => void;
  onDelete: (sheetId: string) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<SheetTab | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const startRename = useCallback((tab: SheetTab) => {
    setRenamingId(tab.sheetId);
    setDraft(tab.name);
  }, []);

  const commitRename = useCallback(() => {
    if (renamingId !== null) onRename(renamingId, draft);
    setRenamingId(null);
  }, [renamingId, draft, onRename]);

  // Arrow-key move: select the neighbor and put DOM focus on it (selection follows focus, per the
  // ARIA tabs pattern — the roving tabIndex alone only takes effect on the NEXT Tab press).
  const moveTo = useCallback((idx: number) => {
    const target = tabs[idx];
    if (!target) return;
    onSelect(target.sheetId);
    stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${target.sheetId}"]`)?.focus();
  }, [tabs, onSelect]);

  const onTabKeyDown = useCallback((e: React.KeyboardEvent, tab: SheetTab, idx: number) => {
    // Only keys pressed ON the tab itself: keydowns bubbling from the nested delete button (or
    // the rename input) must not select the tab / cancel the button's native Enter activation.
    if (e.target !== e.currentTarget) return;
    const k = e.key;
    if (k === 'Enter' || k === ' ') { e.preventDefault(); onSelect(tab.sheetId); }
    else if (k === 'ArrowLeft') { e.preventDefault(); moveTo(idx - 1); }
    else if (k === 'ArrowRight') { e.preventDefault(); moveTo(idx + 1); }
    else if (k === 'F2' && canMutate) { e.preventDefault(); startRename(tab); }
    else if ((k === 'Delete' || k === 'Backspace') && canMutate && tabs.length > 1) {
      e.preventDefault();
      setConfirmDelete(tab);
    }
  }, [onSelect, moveTo, canMutate, tabs.length, startRename]);

  return (
    <div ref={stripRef} role="tablist" aria-label="Sheets" className="flex items-center gap-1 px-3 py-1.5 border-t border-line bg-surface-1 shrink-0 overflow-x-auto">
      {tabs.map((tab, idx) => {
        const isActive = tab.sheetId === activeSheetId;
        const isRenaming = renamingId === tab.sheetId;
        return (
          <div
            key={tab.sheetId}
            data-tab-id={tab.sheetId}
            role="tab"
            aria-selected={isActive}
            aria-controls="reel-sheet-panel"
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(tab.sheetId)}
            onDoubleClick={canMutate ? () => startRename(tab) : undefined}
            onKeyDown={e => onTabKeyDown(e, tab, idx)}
            title={canMutate && !isRenaming ? 'Double-click or F2 to rename · Delete key to remove' : undefined}
            className={`group/tab flex items-center gap-1.5 rounded-md px-2.5 h-7 text-caption cursor-pointer select-none whitespace-nowrap focus-ring transition-colors ${
              isActive ? 'bg-active text-fg' : 'text-fg-3 hover:text-fg hover:bg-hover'
            }`}
          >
            {isRenaming ? (
              <input
                autoFocus
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onFocus={e => e.target.select()}
                onBlur={commitRename}
                onKeyDown={e => {
                  e.stopPropagation();
                  // Confirming/cancelling an IME candidate fires Enter/Escape with isComposing —
                  // same trap the cell editor guards; stealing it would commit half-composed text.
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') commitRename();
                  else if (e.key === 'Escape') setRenamingId(null);
                }}
                onClick={e => e.stopPropagation()}
                onDoubleClick={e => e.stopPropagation()}
                aria-label="Sheet name"
                className="w-28 bg-transparent text-caption text-fg outline-none"
              />
            ) : (
              <span className="truncate max-w-40">{tab.name}</span>
            )}
            {canMutate && tabs.length > 1 && !isRenaming && (
              // Mouse-only affordance (tabIndex -1, pointer-events off while invisible so touch
              // taps can't hit it); the keyboard path is the Delete key on the tab itself.
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                onClick={e => { e.stopPropagation(); setConfirmDelete(tab); }}
                className="grid size-4 place-items-center rounded-xs text-fg-4 opacity-0 pointer-events-none group-hover/tab:opacity-100 group-hover/tab:pointer-events-auto hover:text-danger-text transition-opacity"
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            )}
          </div>
        );
      })}
      {canMutate && (
        <button
          type="button"
          aria-label="New sheet"
          disabled={creating || tabs.length >= MAX_SHEETS}
          title={tabs.length >= MAX_SHEETS ? `Sheet limit reached (${MAX_SHEETS})` : 'New sheet'}
          onClick={onCreate}
          className="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 hover:text-fg hover:bg-hover disabled:opacity-40 transition-colors focus-ring"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
        </button>
      )}
      {confirmDelete && (
        <ConfirmDeleteSheet
          tab={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => { onDelete(confirmDelete.sheetId); setConfirmDelete(null); }}
        />
      )}
    </div>
  );
}

// Deleting a sheet permanently drops its rows, so it gets the shared Modal (dialog semantics,
// focus trap, Escape) rather than a bare portal. Mounted only while open (skips Modal's exit
// fade, same as ImportPreview) so the tab prop can stay non-null.
function ConfirmDeleteSheet({ tab, onCancel, onConfirm }: {
  tab: SheetTab;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open
      onClose={onCancel}
      title={`Delete “${tab.name}”?`}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>Delete sheet</Button>
        </>
      }
    >
      <p className="text-caption text-fg-3">
        Its rows are deleted with it — this can&apos;t be undone. Export CSV first if you want a copy.
      </p>
    </Modal>
  );
}

// ── One sheet's toolbar + grid ───────────────────────────────────────────────────────────────────
// Keyed per (user, sheet) by the parent: a tab switch remounts it, so cursor/selection state resets
// and useReelSheet's unmount flush commits a mid-debounce autosave before the next sheet loads.
function SheetGrid({
  userId,
  sheetId,
  sheetName,
  viewToggle,
  onSendToReels,
  sendReady,
}: {
  userId: string | null;
  sheetId: string;
  sheetName: string;
  viewToggle: React.ReactNode;
  onSendToReels: (rows: SheetRow[]) => void;
  sendReady: boolean;
}) {
  const { loaded, loadError, retryLoad, initialRows, saveState, scheduleSave, external } = useReelSheet(userId, sheetId);
  // Rows are DERIVED until the first edit: persisted rows (or one starter row) render as soon as
  // they load, with no seeding effect; the first mutation snapshots them into `edited` and every
  // change after that flows through commit(). rowsRef gives event handlers the current value
  // without stale closures.
  const [edited, setEdited] = useState<SheetRow[] | null>(null);
  const starterRow = useMemo(() => makeSheetRow(newId()), []);
  const rows = edited ?? (loaded ? (initialRows.length ? initialRows : [starterRow]) : []);
  // Always-current snapshot for event handlers (same pattern as useVideoEntries' entriesRef).
  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; }, [rows]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);

  // The two-state cursor: `active` is the selected cell, `editing` whether it's in edit mode.
  const [active, setActive] = useState<ActiveCell | null>(null);
  const [editing, setEditing] = useState(false);
  const activeRef = useRef<ActiveCell | null>(active);
  useEffect(() => { activeRef.current = active; }, [active]);

  // Adopt a foreign write to this sheet (another tab/device, via Realtime — already echo-suppressed by the
  // hook). Overwrite local rows so a row THEY deleted isn't resurrected by our next autosave. setEdited
  // does NOT autosave (only commit() does), so there's no echo write. Drop selection/cursor refs to rows
  // that no longer exist. Fall back to a starter row if they cleared the sheet, matching the initial load.
  const externalApplied = useRef(0);
  useEffect(() => {
    if (!external || external.rev === externalApplied.current) return;
    externalApplied.current = external.rev;
    const next = external.rows.length ? external.rows : [starterRow];
    const ids = new Set(next.map(r => r.id));
    // Adopt the foreign write into local state. `external` originates from a Realtime handler in
    // useReelSheet, so this is external-subscription→state sync (what effects are FOR); the rule can't see
    // across the hook boundary, and the overwrite is intentional (a foreign delete must win over stale rows).
    setEdited(next);
    setSelected(prev => {
      const kept = new Set([...prev].filter(id => ids.has(id)));
      return kept.size === prev.size ? prev : kept;
    });
    setActive(prev => (prev && ids.has(prev.rowId) ? prev : null));
  }, [external, starterRow]);

  const commit = useCallback((next: SheetRow[]) => {
    setEdited(next);
    scheduleSave(next);
  }, [scheduleSave]);

  const setCell = useCallback((rowId: string, col: Col, value: string) => {
    commit(rowsRef.current.map(r => (r.id === rowId ? { ...r, [col]: value } : r)));
  }, [commit]);

  const selectAt = useCallback((rowId: string, col: Col) => { setActive({ rowId, col }); setEditing(false); }, []);
  const editAt = useCallback((rowId: string, col: Col) => { setActive({ rowId, col }); setEditing(true); }, []);

  // Move the cursor by grid coordinates. `create` appends a row when stepping past the end (Enter /
  // Tab wrap); otherwise it clamps (plain arrows stay put at the edge).
  const goTo = useCallback((rowIdx: number, colIdx: number, opts: { create?: boolean; edit?: boolean } = {}) => {
    const { create = false, edit = false } = opts;
    const clampedCol = Math.max(0, Math.min(COLS.length - 1, colIdx));
    let arr = rowsRef.current;
    let targetIdx = Math.max(0, rowIdx);
    if (targetIdx >= arr.length) {
      if (create) { arr = [...arr, makeSheetRow(newId())]; commit(arr); targetIdx = arr.length - 1; }
      else targetIdx = arr.length - 1;
    }
    const target = arr[targetIdx];
    if (!target) return;
    setActive({ rowId: target.id, col: COLS[clampedCol] });
    setEditing(edit);
  }, [commit]);

  const addRow = useCallback(() => {
    const row = makeSheetRow(newId());
    commit([...rowsRef.current, row]);
    editAt(row.id, 'link');
  }, [commit, editAt]);

  const removeRow = useCallback((rowId: string) => {
    // An uploaded video the row referenced becomes an orphan, deliberately — an eager GC here races
    // the debounced autosaves (this sheet's AND the reels grid's), and deleting a still-referenced
    // file breaks reels irreversibly while an orphan only costs storage (2026-07-20 review).
    commit(rowsRef.current.filter(r => r.id !== rowId));
    setSelected(prev => { if (!prev.has(rowId)) return prev; const n = new Set(prev); n.delete(rowId); return n; });
    setActive(prev => (prev?.rowId === rowId ? null : prev));
  }, [commit]);

  // ── Per-row video upload — the Link cell's alternative to pasting a link ─────────────────────────
  // One hidden file input shared by every row; `uploadRowRef` remembers which row opened the picker.
  // The file lands in the durable post-videos bucket and its public URL becomes the Link cell, so the
  // row persists/syncs/exports like any other and send-to-reels plays it straight from our bucket.
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadRowRef = useRef<string | null>(null);
  const [uploadingRows, setUploadingRows] = useState<Set<string>>(new Set());
  const [uploadError, setUploadError] = useState<string | null>(null);

  // The grid is keyed per (user, sheet), so a tab switch UNMOUNTS this instance mid-upload (and
  // mid-AI-generation). Async continuations must then drop their result: rowsRef is frozen at the
  // pre-switch snapshot, and committing it would overwrite the mounted grid's newer rows in
  // sheetCache + the DB (own-echo suppression means the live grid would never even see the
  // clobber). The upload orphans; fine.
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const openUploadFor = useCallback((rowId: string) => {
    uploadRowRef.current = rowId;
    uploadInputRef.current?.click();
  }, []);

  const handleUploadFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';   // re-picking the same file re-fires onChange
    const rowId = uploadRowRef.current;
    uploadRowRef.current = null;
    if (!file || !rowId || !userId) return;
    setUploadError(null);
    setUploadingRows(prev => new Set(prev).add(rowId));
    const linkAtStart = (rowsRef.current.find(r => r.id === rowId)?.link ?? '').trim();
    const result = await uploadSheetVideo(userId, file);
    if (!aliveRef.current) return;   // unmounted mid-upload — never commit a stale snapshot
    setUploadingRows(prev => { const n = new Set(prev); n.delete(rowId); return n; });
    if (!result.ok) { setUploadError(result.message); return; }
    // Row deleted while the upload ran → nothing to attach to; the file stays as an orphan (same
    // deliberate trade as removeRow above — never delete media on a racy liveness guess).
    const row = rowsRef.current.find(r => r.id === rowId);
    if (!row) return;
    // The user typed/pasted a DIFFERENT link into this cell while the upload ran — their edit wins;
    // silently replacing it with the bucket URL would send the wrong video to reels.
    if (row.link.trim() !== linkAtStart) {
      setUploadError('The Link cell changed while the video uploaded, so it wasn’t attached — use the upload button again if you still want it.');
      return;
    }
    commit(rowsRef.current.map(r => (r.id === rowId ? { ...r, link: result.url } : r)));
  }, [userId, commit]);

  // ── Per-row AI generation — Caption (on-template overlay) + Description (IG caption) ────────────
  // From the row's link: resolve the source via /api/download (playable URL + the post's own
  // description), grab two frames client-side (proxy stream is same-origin, uploads are CORS-open),
  // and let /api/sheet/caption read the overlay caption off the frames and write a grounded
  // description from the source text. Frames are best-effort: a video that won't load/seek still
  // generates the description.
  const [aiRows, setAiRows] = useState<Set<string>>(new Set());
  const [aiError, setAiError] = useState<string | null>(null);

  const generateForRow = useCallback(async (rowId: string) => {
    if (!userId) return;
    const link = (rowsRef.current.find(r => r.id === rowId)?.link ?? '').trim();
    if (!link || !looksLikeUrl(link)) return;
    setAiError(null);
    setAiRows(prev => new Set(prev).add(rowId));
    try {
      let topic = '';
      let videoSrc: string | null = null;
      // The download API needs a protocol; sheets are full of bare www. links (same normalization
      // as HomeClient's sendSheetRowsToReels).
      const url = /^www\./i.test(link) ? `https://${link}` : link;
      if (isUploadedVideoUrl(url)) {
        videoSrc = url;
      } else {
        const res = await authedFetch('/api/download', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Could not fetch that link');
        topic = typeof json.title === 'string' ? json.title : '';
        if (json.hdplay || json.play || json.wmplay) videoSrc = bestVideoUrl(json);
      }
      let frames: string[] = [];
      let framesFailed = false;
      if (videoSrc) {
        try { frames = await captureVideoFrames(videoSrc); } catch { framesFailed = true; }
      }
      const res = await authedFetch('/api/sheet/caption', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frames: frames.length ? frames : undefined, topic: topic || undefined, link: url }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Generation failed');
      if (!aliveRef.current) return;   // unmounted mid-generation — never commit a stale snapshot
      const row = rowsRef.current.find(r => r.id === rowId);
      if (!row) return;   // row deleted while generating
      // The link changed under the generation — the result describes the OLD video; drop it.
      if (row.link.trim() !== link) {
        setAiError('The Link cell changed while AI was generating, so nothing was filled in — press generate again.');
        return;
      }
      commit(rowsRef.current.map(r => (r.id === rowId ? {
        ...r,
        caption: typeof json.caption === 'string' && json.caption ? json.caption : r.caption,
        description: typeof json.description === 'string' && json.description ? json.description : r.description,
      } : r)));
      // A caption that legitimately isn't there (video with no creator overlay) stays silent — but a
      // failed frame capture must not masquerade as that; tell the user the caption arm was skipped.
      if (framesFailed && !json.caption) {
        setAiError('The description was generated, but the video frames couldn’t be read, so the caption was skipped — try generating again.');
      }
    } catch (e) {
      if (aliveRef.current) setAiError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      if (aliveRef.current) setAiRows(prev => { const n = new Set(prev); n.delete(rowId); return n; });
    }
  }, [userId, commit]);

  // Fan a copied TSV table out across the grid starting at (rowId, col), appending rows as needed.
  const applyTable = useCallback((rowId: string, col: Col, table: string[][]) => {
    const startCol = COLS.indexOf(col);
    const next = [...rowsRef.current];
    let idx = next.findIndex(r => r.id === rowId);
    if (idx < 0) return;
    for (const cells of table) {
      if (idx >= next.length) next.push(makeSheetRow(newId()));
      const row = { ...next[idx] };
      cells.forEach((value, j) => {
        const target = COLS[startCol + j];
        if (target) row[target] = value.trim();
      });
      next[idx] = row;
      idx += 1;
    }
    commit(next);
  }, [commit]);

  // Focus the active cell's display div in SELECT mode. In edit mode the floating CellEditor
  // self-focuses (it's portalled out of this tree), so we deliberately skip it here.
  useEffect(() => {
    if (!active || editing) return;
    bodyRef.current?.querySelector<HTMLElement>(`[data-cell="${active.rowId}:${active.col}"]`)?.focus();
  }, [active, editing]);

  // Select-mode paste: no input is focused, so catch it at the document level (guarded to when a
  // sheet cell actually holds focus). A table fans out; a single value replaces the active cell.
  useEffect(() => {
    if (!active || editing) return;
    const onPaste = (e: ClipboardEvent) => {
      if (!bodyRef.current?.contains(document.activeElement)) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      const table = parseClipboardTable(text);
      if (table) { e.preventDefault(); applyTable(active.rowId, active.col, table); }
      // Only overwrite when there's actual text — an image/empty clipboard must NOT wipe the cell.
      else if (text.trim() !== '') { e.preventDefault(); setCell(active.rowId, active.col, text.trim()); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [active, editing, applyTable, setCell]);

  // Clicking outside the grid clears the cursor so no stray selection border lingers. The floating
  // editor is portalled to <body> (outside the grid), so exclude it or clicking into it would close.
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (bodyRef.current?.contains(t) || t.closest?.('[data-sheet-editor]')) return;
      setActive(null); setEditing(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [active]);

  const tabStep = useCallback((idx: number, colIdx: number, shift: boolean) => {
    if (shift) {
      if (colIdx > 0) goTo(idx, colIdx - 1);
      else if (idx > 0) goTo(idx - 1, COLS.length - 1);
    } else if (colIdx < COLS.length - 1) {
      goTo(idx, colIdx + 1);
    } else {
      goTo(idx + 1, 0, { create: true }); // wrap to the next row's first column
    }
  }, [goTo]);

  const onSelectKeyDown = useCallback((e: React.KeyboardEvent, rowId: string, col: Col) => {
    const colIdx = COLS.indexOf(col);
    const idx = rowsRef.current.findIndex(r => r.id === rowId);
    const k = e.key;
    if (k === 'ArrowUp') { e.preventDefault(); if (idx > 0) goTo(idx - 1, colIdx); }
    else if (k === 'ArrowDown') { e.preventDefault(); if (idx + 1 < rowsRef.current.length) goTo(idx + 1, colIdx); }
    else if (k === 'ArrowLeft') { e.preventDefault(); if (colIdx > 0) goTo(idx, colIdx - 1); }
    else if (k === 'ArrowRight') { e.preventDefault(); if (colIdx < COLS.length - 1) goTo(idx, colIdx + 1); }
    else if (k === 'Enter') { e.preventDefault(); goTo(idx + 1, colIdx, { create: true }); }
    else if (k === 'Tab') { e.preventDefault(); tabStep(idx, colIdx, e.shiftKey); }
    else if (k === 'F2') { e.preventDefault(); setEditing(true); }
    else if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); setCell(rowId, col, ''); }
    else if ((e.metaKey || e.ctrlKey) && (k === 'c' || k === 'C')) {
      e.preventDefault();
      // TSV-quote so a multi-line / tabbed cell round-trips back into ONE cell on paste (and pastes
      // correctly into a real spreadsheet) instead of the paste parser fanning it across rows.
      void navigator.clipboard?.writeText(tsvEscape(rowsRef.current.find(r => r.id === rowId)?.[col] ?? ''));
    }
    // Cmd/Ctrl+V is deliberately NOT intercepted — the document paste listener handles it.
    // Printable key → type-to-replace. Block Cmd and pure-Ctrl shortcuts, but allow AltGr
    // (Ctrl+Alt) and macOS Option, which produce real characters on international layouts.
    else if (k.length === 1 && !e.metaKey && !(e.ctrlKey && !e.altKey)) {
      e.preventDefault();
      setCell(rowId, col, k);   // type-to-replace
      setEditing(true);
    }
  }, [goTo, tabStep, setCell]);

  const onEditKeyDown = useCallback((e: React.KeyboardEvent, rowId: string, col: Col) => {
    // The editor textarea is portalled to <body> but is a React CHILD of the cell div, so synthetic
    // events bubble up the fiber tree to the div's onSelectKeyDown. Stop here or every keystroke
    // double-fires the select-mode handler (type-to-replace, Backspace-clears, arrows-exit).
    e.stopPropagation();
    // Never steal the keydown that confirms an IME candidate (CJK input): during composition the
    // browser fires key:'Enter'/'Tab' with isComposing, and preventDefault would cancel the commit.
    if (e.nativeEvent.isComposing) return;
    const colIdx = COLS.indexOf(col);
    const idx = rowsRef.current.findIndex(r => r.id === rowId);
    const k = e.key;
    if (k === 'Enter') {
      if (e.shiftKey || e.altKey) return; // Shift/Alt+Enter inserts a newline (native textarea)
      e.preventDefault(); goTo(idx + 1, colIdx, { create: true });
    }
    else if (k === 'Tab') { e.preventDefault(); tabStep(idx, colIdx, e.shiftKey); }
    else if (k === 'Escape') { e.preventDefault(); setEditing(false); } // back to select, same cell
    // Arrow keys fall through to the textarea → native caret movement.
  }, [goTo, tabStep]);

  // Anchor for shift-click range selection: the last checkbox clicked without Shift.
  const selectAnchor = useRef<string | null>(null);

  // Checkbox click. Plain click toggles the row and re-anchors. Shift+click selects the whole
  // contiguous range from the anchor to this row (Gmail/Finder style) — how you grab rows
  // 206–304 in two clicks instead of ninety-nine.
  const onRowCheckbox = useCallback((rowId: string, e: React.MouseEvent) => {
    const arr = rowsRef.current;
    if (e.shiftKey && selectAnchor.current) {
      const a = arr.findIndex(r => r.id === selectAnchor.current);
      const b = arr.findIndex(r => r.id === rowId);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(prev => {
          const n = new Set(prev);
          for (let i = lo; i <= hi; i++) n.add(arr[i].id);
          return n;
        });
        return; // keep the anchor so the range can be re-extended
      }
    }
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(rowId)) n.delete(rowId); else n.add(rowId);
      return n;
    });
    selectAnchor.current = rowId;
  }, []);

  // Sendable = rows with a link. With a selection, only the selected ones; otherwise all of them.
  const sendable = useMemo(() => {
    const withLink = rows.filter(r => r.link.trim() !== '');
    return selected.size === 0 ? withLink : withLink.filter(r => selected.has(r.id));
  }, [rows, selected]);

  const send = useCallback(() => {
    if (sendable.length === 0) return;
    onSendToReels(sendable);
    setSelected(new Set());
  }, [sendable, onSendToReels]);

  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id));

  // ── CSV import / export ──────────────────────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importTable, setImportTable] = useState<string[][] | null>(null);

  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';   // reset so re-picking the same file re-fires onChange
    if (!file) return;
    const text = (await file.text()).replace(/^\uFEFF/, '');   // strip a leading BOM
    setImportTable(parseDelimited(text, ','));
  }, []);

  // Append the previewed rows; if the sheet is only blank starter rows, replace them so a first
  // import doesn't leave an empty row sitting on top.
  const appendImported = useCallback((imported: { link: string; caption: string; description: string }[]) => {
    const withIds = imported.map(r => ({ ...makeSheetRow(newId()), ...r }));
    const existing = rowsRef.current;
    const base = existing.every(isBlankRow) ? [] : existing;
    const next = [...base, ...withIds];
    commit(next.length ? next : [makeSheetRow(newId())]);
    setImportTable(null);
  }, [commit]);

  const exportCsv = useCallback(() => downloadCsv(rowsToCsv(rowsRef.current), csvFilename(sheetName)), [sheetName]);

  return (
    <>
      {/* ── Toolbar — mirrors the reels canvas toolbar (view toggle · centred title · autosave + send) ── */}
      <Toolbar
        viewToggle={viewToggle}
        right={
          <>
            <AutosaveChip state={saveState} />
            <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleImportFile} className="hidden" />
            <Button variant="secondary" size="sm" className="rounded-full" disabled={!loaded || loadError} title={!loaded || loadError ? 'Loading your sheet…' : undefined} onClick={() => fileInputRef.current?.click()}>Import CSV</Button>
            <Button variant="secondary" size="sm" className="rounded-full" disabled={rows.every(isBlankRow)} onClick={exportCsv}>Export CSV</Button>
            <Button variant="primary" size="sm" className="rounded-full" disabled={sendable.length === 0 || !sendReady} title={sendReady ? undefined : 'Loading your reels…'} onClick={send}>
              {selected.size > 0 ? `Send ${sendable.length} selected to Reels` : `Send ${sendable.length} to Reels`}
            </Button>
          </>
        }
      />

      {/* ── Grid ── */}
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <input ref={uploadInputRef} type="file" accept="video/*" onChange={handleUploadFile} className="hidden" />
          {uploadError && <p className="mb-3 text-caption text-danger-text" role="alert">{uploadError}</p>}
          {aiError && <p className="mb-3 text-caption text-danger-text" role="alert">{aiError}</p>}
          <div className="rounded-xl border border-line overflow-hidden bg-surface-1">
            {/* Header row */}
            <div className="grid grid-cols-[64px_40px_1.5fr_1.2fr_1.2fr_40px] items-center border-b border-line bg-surface-2/60">
              <span />
              <div className="flex items-center justify-center py-2">
                <SelectBox
                  checked={allSelected}
                  onToggle={() => setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)))}
                  label={allSelected ? 'Deselect all rows' : 'Select all rows'}
                />
              </div>
              {COLS.map(c => (
                <span key={c} className="px-3 py-2 text-caption font-medium uppercase tracking-wider text-fg-3">{COL_META[c].label}</span>
              ))}
              <span />
            </div>

            {loadError ? (
              <div className="px-4 py-10 text-center">
                <p className="text-caption text-fg-3">Couldn&apos;t load your sheet — editing is paused so nothing gets overwritten.</p>
                <button type="button" onClick={retryLoad} className="mt-2 text-caption underline underline-offset-2 text-fg-2 hover:text-fg focus-ring rounded-xs">
                  Try again
                </button>
              </div>
            ) : !loaded ? (
              <p className="px-4 py-10 text-center text-caption text-fg-3">Loading your sheet…</p>
            ) : (
              rows.map((row, index) => {
                const linkInvalid = !linkLooksValid(row.link);
                const rowUploading = uploadingRows.has(row.id);
                const rowGenerating = aiRows.has(row.id);
                const canGenerate = !!userId && row.link.trim() !== '' && !linkInvalid;
                return (
                <div key={row.id} className="group grid grid-cols-[64px_40px_1.5fr_1.2fr_1.2fr_40px] items-center border-b border-line/60 last:border-b-0 hover:bg-hover/40 transition-colors">
                  {/* Action gutter (far left): AI-generate + upload for this row. */}
                  <div className="flex items-center justify-center gap-1 self-stretch">
                    {canGenerate && (rowGenerating ? (
                      <span className="grid size-6 place-items-center" aria-label="Generating caption and description">
                        <span className="size-3.5 rounded-full border-2 border-fg-4 border-t-transparent animate-spin" />
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label="Generate the caption and description with AI"
                        title="Generate the Caption and Description from this link with AI"
                        onClick={() => void generateForRow(row.id)}
                        className="grid size-6 place-items-center rounded-md bg-[#0A0A0A] hover:bg-hover transition-all focus-ring"
                      >
                        <span className="text-[11px] leading-none brightness-0 invert" aria-hidden>✨</span>
                      </button>
                    ))}
                    {!!userId && (rowUploading ? (
                      <span className="grid size-6 place-items-center" aria-label="Uploading video">
                        <span className="size-3.5 rounded-full border-2 border-fg-4 border-t-transparent animate-spin" />
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label="Upload a video for this row"
                        title="Upload a video instead of a link"
                        onClick={() => openUploadFor(row.id)}
                        className="grid size-6 place-items-center rounded-md bg-surface-2 text-fg-4 hover:text-fg hover:bg-hover transition-all focus-ring"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 16V4m0 0 4 4m-4-4-4 4M4 20h16" /></svg>
                      </button>
                    ))}
                  </div>
                  {/* Row-number gutter that swaps to the select checkbox on hover / when selected. */}
                  <div className="relative flex items-center justify-center self-stretch">
                    <span className={`text-caption tabular-nums text-fg-4 select-none transition-opacity ${selected.has(row.id) ? 'opacity-0' : 'opacity-100 group-hover:opacity-0'}`}>
                      {index + 1}
                    </span>
                    <span className={`absolute inset-0 flex items-center justify-center transition-opacity ${selected.has(row.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}>
                      <SelectBox checked={selected.has(row.id)} onToggle={e => onRowCheckbox(row.id, e)} label={`Select row ${index + 1} (Shift-click to select a range)`} />
                    </span>
                  </div>
                  {COLS.map(col => {
                    const isActive = active?.rowId === row.id && active.col === col;
                    const isEditing = isActive && editing;
                    const invalid = col === 'link' && !linkLooksValid(row.link);
                    const isUpload = col === 'link' && isUploadedVideoUrl(row.link);
                    const uploading = col === 'link' && uploadingRows.has(row.id);
                    return (
                      <div
                        key={col}
                        data-cell={`${row.id}:${col}`}
                        tabIndex={isActive && !editing ? 0 : -1}
                        title={isUpload ? row.link : invalid ? 'This does not look like a link' : undefined}
                        onMouseDown={() => selectAt(row.id, col)}
                        onDoubleClick={() => editAt(row.id, col)}
                        onKeyDown={e => onSelectKeyDown(e, row.id, col)}
                        className={`sheet-cell relative w-full min-w-0 truncate cursor-default select-none px-3 py-2.5 text-body outline-none border-l border-line/60 ${isActive && !editing ? 'shadow-[inset_0_0_0_1px_var(--focus)]' : ''} ${invalid ? 'text-danger-text' : 'text-fg'}`}
                      >
                        {isUpload ? (
                          // An uploaded video shows as its filename, not the raw bucket URL (which is
                          // still the cell's value — edit/copy/CSV all see the URL; hover shows it).
                          <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-fg-3" aria-hidden><path d="m22 8-6 4 6 4V8Z" /><rect x="2" y="6" width="14" height="12" rx="2" /></svg>
                            <span className="truncate">{uploadedVideoDisplayName(row.link)}</span>
                          </span>
                        ) : (
                          row[col] || <span className="text-fg-4">{uploading ? 'Uploading…' : COL_META[col].placeholder}</span>
                        )}
                        {isEditing && (
                          <CellEditor
                            anchorRef={bodyRef}
                            rowId={row.id}
                            col={col}
                            value={row[col]}
                            invalid={invalid}
                            onChange={v => setCell(row.id, col, v)}
                            onKeyDown={e => onEditKeyDown(e, row.id, col)}
                            onCommit={() => setEditing(false)}
                          />
                        )}
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    aria-label="Delete row"
                    onClick={() => removeRow(row.id)}
                    className="mx-auto grid size-6 place-items-center rounded-md text-fg-4 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger-text hover:bg-hover transition-all focus-ring"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                </div>
                );
              })
            )}

            {/* Ghost add-row, mirroring the strip's add card */}
            {loaded && !loadError && (
              <button
                type="button"
                onClick={addRow}
                className="w-full px-4 py-2.5 text-left text-caption text-fg-3 hover:text-fg hover:bg-hover/40 transition-colors focus-ring"
              >
                + Add row
              </button>
            )}
          </div>

          <p className="mt-3 text-caption text-fg-4">
            Click a cell to select it, double-click (or just start typing) to edit. A Link cell can
            hold a pasted TikTok / Instagram / X link — or hover it and hit the upload button to use
            your own video file instead. Copy your Link, Caption and Description columns straight
            from Google Sheets or Excel, then paste — rows fan out automatically and a header row is
            skipped for you. Or use Import / Export CSV (columns map by position: Link, Caption,
            Description). Double-click a sheet tab below to rename it.
          </p>
        </div>
      </div>

      {importTable && (
        <ImportPreview table={importTable} onCancel={() => setImportTable(null)} onAppend={appendImported} />
      )}
    </>
  );
}

// CSV import preview: rows drop into our fixed Link/Caption/Description columns BY POSITION (no header-
// name matching). A "first row is a header" toggle — auto-guessed from whether row 1's first cell is a
// URL — drops the header; fully-blank rows are skipped; a Link cell that doesn't look like a URL is
// tinted so a misaligned file (columns in the wrong order) is visible before it's committed.
function ImportPreview({ table, onCancel, onAppend }: {
  table: string[][];
  onCancel: () => void;
  onAppend: (rows: { link: string; caption: string; description: string }[]) => void;
}) {
  const autoHeader = table.length > 1 && !looksLikeUrl(table[0]?.[0] ?? '') && looksLikeUrl(table[1]?.[0] ?? '');
  const [skipHeader, setSkipHeader] = useState(autoHeader);

  const body = skipHeader ? table.slice(1) : table;
  const nonBlank = body.filter(r => r.some(c => c.trim() !== ''));
  const blankSkipped = body.length - nonBlank.length;
  const capped = nonBlank.slice(0, MAX_PASTE_ROWS);
  const truncated = nonBlank.length - capped.length;
  const mapped = capped.map(cells => ({
    link: (cells[0] ?? '').trim(),
    caption: cells[1] ?? '',
    description: cells[2] ?? '',
  }));

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4" onMouseDown={onCancel}>
      <div className="w-full max-w-2xl rounded-xl border border-line bg-surface-1 shadow-2 p-5" onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 mb-3">
          <h2 className="text-subheading text-fg">Import CSV</h2>
          <label className="flex items-center gap-2 text-caption text-fg-3 cursor-pointer select-none">
            <input type="checkbox" className="accent-[var(--accent)]" checked={skipHeader} onChange={e => setSkipHeader(e.target.checked)} />
            First row is a header
          </label>
        </div>
        <p className="text-caption text-fg-3 mb-3">
          Columns map by position — <span className="text-fg">1 → Link, 2 → Caption, 3 → Description</span>.{' '}
          {mapped.length} row{mapped.length === 1 ? '' : 's'} will be appended
          {blankSkipped > 0 ? ` · ${blankSkipped} blank skipped` : ''}
          {truncated > 0 ? ` · ${truncated} over the ${MAX_PASTE_ROWS}-row limit dropped` : ''}.
        </p>
        {mapped.some(r => !linkLooksValid(r.link)) && (
          <p className="text-caption text-danger-text mb-3">⚠ Some Link cells don’t look like links — is your Link column first?</p>
        )}
        <div className="rounded-lg border border-line overflow-hidden">
          <div className="grid grid-cols-[2fr_2fr_1.4fr] bg-surface-2 text-caption font-medium uppercase tracking-wider text-fg-3">
            <span className="px-3 py-2">Link</span>
            <span className="px-3 py-2 border-l border-line/60">Caption</span>
            <span className="px-3 py-2 border-l border-line/60">Description</span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {mapped.length === 0 ? (
              <p className="px-3 py-6 text-center text-caption text-fg-4">No rows to import.</p>
            ) : mapped.slice(0, 8).map((r, i) => (
              <div key={i} className="grid grid-cols-[2fr_2fr_1.4fr] border-t border-line/60 text-body">
                <span className={`px-3 py-2 truncate ${r.link && !linkLooksValid(r.link) ? 'text-danger-text' : 'text-fg'}`}>{r.link || <span className="text-fg-4">—</span>}</span>
                <span className="px-3 py-2 truncate text-fg border-l border-line/60">{r.caption || <span className="text-fg-4">—</span>}</span>
                <span className="px-3 py-2 truncate text-fg border-l border-line/60">{r.description || <span className="text-fg-4">—</span>}</span>
              </div>
            ))}
            {mapped.length > 8 && <div className="px-3 py-2 text-caption text-fg-4 border-t border-line/60">… {mapped.length - 8} more</div>}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={mapped.length === 0} onClick={() => onAppend(mapped)}>
            Append{mapped.length ? ` ${mapped.length}` : ''}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// House-token checkbox (the app has no shared one): bordered square, accent fill when on.
function SelectBox({ checked, onToggle, label }: { checked: boolean; onToggle: (e: React.MouseEvent) => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={`grid size-4 place-items-center rounded-[4px] border transition-colors focus-ring ${
        checked ? 'bg-accent border-accent text-accent-fg' : 'border-line-strong bg-transparent text-transparent hover:border-fg-3'
      }`}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 8.5 6.5 12 13 4.5" /></svg>
    </button>
  );
}

// Floating cell editor (Google-Sheets style): a textarea anchored over the cell that grows DOWN to
// reveal the full value when the cell would otherwise clip it — without reflowing the grid. Starts
// at the cell's exact size, wraps as it fills, and caps at MAX_EDITOR_H with an internal scroll.
// Portalled to <body> so the grid's overflow never clips it; repositions on scroll / resize.
const MAX_EDITOR_H = 260;

function autoGrow(ta: HTMLTextAreaElement, minH: number) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(Math.max(ta.scrollHeight, minH), MAX_EDITOR_H)}px`;
}

function CellEditor({
  anchorRef,
  rowId,
  col,
  value,
  invalid,
  onChange,
  onKeyDown,
  onCommit,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  rowId: string;
  col: Col;
  value: string;
  invalid: boolean;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onCommit: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const didFocus = useRef(false);

  useLayoutEffect(() => {
    const measure = () => {
      const cell = anchorRef.current?.querySelector<HTMLElement>(`[data-cell="${rowId}:${col}"]`);
      if (!cell) return;
      // layoutRect, not getBoundingClientRect: this editor is portalled to <body> and positioned
      // `fixed` INSIDE the globally-zoomed page, so raw visual-px rect values would land it at
      // zoom × the intended position (up-left of the cell). See lib/appZoom.
      setRect(layoutRect(cell));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true); // capture: catch the grid's own scroll container
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchorRef, rowId, col]);

  // Focus + caret at end, once, as soon as the box has a measured position.
  useEffect(() => {
    if (!rect || !taRef.current || didFocus.current) return;
    didFocus.current = true;
    const ta = taRef.current;
    ta.focus();
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
    autoGrow(ta, rect.height);
  }, [rect]);

  // Grow to fit as the value (or the anchor's size) changes.
  useLayoutEffect(() => {
    if (taRef.current && rect) autoGrow(taRef.current, rect.height);
  }, [value, rect]);

  if (typeof document === 'undefined' || !rect) return null;

  return createPortal(
    <textarea
      ref={taRef}
      data-sheet-editor=""
      rows={1}
      value={value}
      spellCheck={col !== 'link'}
      onChange={e => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      // Portal child: stop mouse events reaching the cell div's onMouseDown/onDoubleClick, or a
      // click inside the editor would run selectAt and close it.
      onMouseDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onBlur={onCommit}
      className={`sheet-cell fixed z-dropdown resize-none overflow-y-auto rounded-[3px] bg-surface-1 px-3 py-2.5 text-body outline-none shadow-[inset_0_0_0_1px_var(--focus),0_10px_28px_-8px_rgba(0,0,0,0.6)] ${invalid ? 'text-danger-text' : 'text-fg'}`}
      style={{ top: rect.top, left: rect.left, width: rect.width, minHeight: rect.height, maxHeight: MAX_EDITOR_H }}
    />,
    document.body,
  );
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter}`;
}
