'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { stableStringify } from '@/lib/stableStringify';
import { parseUpdatedAt, adoptOrdering, reconcileDue, keepAdoptedOverLoaded, RECONCILE_INTERVAL_MS, resubscribeDelayMs } from './useReelPersistence';
import type { SaveState } from '../components/AutosaveChip';

// The reels Content Sheet: the user's persistent backlog of links + captions + notes, upstream of
// the reels strip (see supabase/reel_sheets.sql). One jsonb row per (user, sheet): the user keeps
// several named sheet tabs — useSheetTabs manages the tab list, useReelSheet one sheet's rows —
// mirroring how video_reels stores the reels grid; autosaves on the same debounce cadence,
// surfaced through the same AutosaveChip.

export interface SheetRow {
  id: string;
  link: string;
  caption: string;
  description: string;            // carried to reels; posted as the Instagram caption when scheduled, and exported as a .txt on download
}

export interface SheetTab {
  sheetId: string;
  name: string;
  position: number;
}

// A foreign write to THIS sheet's rows adopted from another tab/device via Realtime. `rev` bumps per
// adoption so the consuming grid's apply effect re-runs even for equal-looking arrays.
export interface ExternalSheetRows { rows: SheetRow[]; rev: number }

export function makeSheetRow(id: string): SheetRow {
  return { id, link: '', caption: '', description: '' };
}

// Older saved rows may carry a `status` key from before it was removed — normalizeRow simply
// drops it (only the four fields above are read), so no migration is needed.
export function normalizeRow(raw: unknown): SheetRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SheetRow>;
  if (typeof r.id !== 'string' || !r.id) return null;
  return {
    id: r.id,
    link: typeof r.link === 'string' ? r.link : '',
    caption: typeof r.caption === 'string' ? r.caption : '',
    description: typeof r.description === 'string' ? r.description : '',
  };
}

const DEBOUNCE_MS = 800;

// Every user starts with this tab; its DB row is created lazily on the first write (the DB-side
// sheet_id/name defaults match it, so a pre-tabs client writing {user_id, rows} lands on the same
// row). It only appears virtually while the user has NO reel_sheets rows at all.
export const DEFAULT_TAB: SheetTab = { sheetId: 'sheet-1', name: 'Sheet 1', position: 0 };
export const MAX_SHEETS = 10;
export const MAX_SHEET_NAME_LEN = 60;

const rowsKey = (userId: string, sheetId: string) => `${userId}/${sheetId}`;

// Last-known rows per (user, sheet), surviving section switches and view/tab toggles. A remount
// seeds from here instead of re-SELECTing, which closes the flush-vs-refetch race (an in-flight
// unmount save can't be shadowed by a stale read) and makes returning to a sheet instant.
const sheetCache = new Map<string, SheetRow[]>();

// Canonical JSON of the row-array writes THIS TAB has recently dispatched, keyed like sheetCache
// (user/sheet). postgres_changes has no self-exclusion, so every upsert echoes back; a single "last
// synced" baseline only matches the NEWEST write, so with several writes in flight the echo of an earlier
// one looks foreign and gets destructively adopted (reverting rows + cancelling the pending save). A
// bounded SET recognises any recent self-write. Module-scoped so it survives a tab/section remount.
// Mirrors useReelPersistence.
export const RECENT_WRITES_CAP = 12;
const recentSheetWrites = new Map<string, Set<string>>();
// Exported for the sheet regression test. Own-echo recognition primitives, not app API.
export function rememberSheetWrite(key: string, json: string) {
  let set = recentSheetWrites.get(key);
  if (!set) { set = new Set(); recentSheetWrites.set(key, set); }
  // delete-then-add so a re-written json regains queue recency (Set.add of an existing member keeps its
  // old insertion position); mirrors rememberWrite in useReelPersistence.
  set.delete(json);
  set.add(json);
  while (set.size > RECENT_WRITES_CAP) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}
export function forgetSheetWrite(key: string, json: string) {
  recentSheetWrites.get(key)?.delete(json);
}
export function isOwnRecentSheetWrite(key: string, json: string) {
  return recentSheetWrites.get(key)?.has(json) ?? false;
}

// A per-subscription random suffix so a re-subscribe never reuses a torn-down channel's topic
// (supabase-js#1440: an un-awaited removeChannel can leak buffered echoes into a same-topic channel).
function sheetChannelNonce(): string {
  const c = globalThis.crypto;
  return c && 'randomUUID' in c ? c.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Monotonic per-(user,sheet) epoch-ms of the newest row-array `updated_at` we have loaded, written, or
// adopted; adopt() refuses anything not STRICTLY newer. See useReelPersistence's lastKnownUpdatedAt for
// the full rationale (the calendar-then-back stale-refetch data loss). Exported for the sheet tests.
export const sheetLastKnownUpdatedAt = new Map<string, number>();
export function advanceSheetWatermark(key: string, ms: number): number {
  const prev = sheetLastKnownUpdatedAt.get(key) ?? 0;
  if (ms > prev) sheetLastKnownUpdatedAt.set(key, ms);
  return prev;
}
export function rollbackSheetWatermark(key: string, ms: number, prev: number) {
  if (sheetLastKnownUpdatedAt.get(key) === ms) {
    if (prev > 0) sheetLastKnownUpdatedAt.set(key, prev);
    else sheetLastKnownUpdatedAt.delete(key);
  }
}
const sheetInFlightWrites = new Map<string, number>();
function trackSheetInFlight(key: string, delta: number) {
  sheetInFlightWrites.set(key, Math.max(0, (sheetInFlightWrites.get(key) ?? 0) + delta));
}
export function hasSheetInFlightWrite(key: string) { return (sheetInFlightWrites.get(key) ?? 0) > 0; }

// Tab lists per user, same rationale as sheetCache.
const tabsCache = new Map<string, SheetTab[]>();

// Sheets deleted this session, keyed like sheetCache. Deleting the active tab unmounts its grid,
// whose unmount flush (and any still-debounced save) would otherwise upsert the row right back —
// a zombie tab reappearing on the next load. Marked BEFORE the DELETE is issued; all write paths
// in useReelSheet consult it. Scope is this JS realm only: another browser tab or device that
// edits a sheet deleted here re-creates it (deliberate last-writer-wins, same as concurrent row
// edits) — the rows payload carries name/position so such a re-insert keeps the tab's identity.
const deadSheets = new Set<string>();

// The latest in-flight rows write per sheet key. deadSheets only stops saves that haven't been
// DISPATCHED yet — an upsert already on the wire has no ordering guarantee against the DELETE
// deleteSheet is about to issue, and a big payload on a slow uplink can land after it and
// resurrect the row. deleteSheet awaits this before deleting. Entries chain onto whatever was
// already pending for the key, so awaiting the map value means awaiting ALL dispatched saves.
const inflightSaves = new Map<string, Promise<void>>();

function trackSave(key: string, save: PromiseLike<unknown>): void {
  const prev = inflightSaves.get(key);
  const combined = Promise.allSettled([prev, Promise.resolve(save)]).then(() => {
    if (inflightSaves.get(key) === combined) inflightSaves.delete(key);
  });
  inflightSaves.set(key, combined);
}

// The tab's current name/position for a rows write. Included so that when a write's INSERT path
// re-creates the row (first write of the virtual default tab, or a last-writer-wins re-insert
// after a delete elsewhere), the tab keeps its identity instead of resetting to the column
// defaults ('Sheet 1', 0).
function tabMetaFor(userId: string, sheetId: string): { name?: string; position?: number } {
  const tab = tabsCache.get(userId)?.find(t => t.sheetId === sheetId);
  return tab ? { name: tab.name, position: tab.position } : {};
}

// Warm the rows cache for the sheet most likely to open first, in parallel with the tabs fetch —
// otherwise a cold load pays two strictly serial round trips (tab list, then rows). Fills a cold
// cache only: it never overwrites an entry, so pending edits can't be clobbered.
export function warmSheetRows(userId: string, sheetId: string): void {
  const key = rowsKey(userId, sheetId);
  if (sheetCache.has(key) || deadSheets.has(key)) return;
  supabase.from('reel_sheets').select('rows, updated_at')
    .eq('user_id', userId).eq('sheet_id', sheetId).maybeSingle()
    .then(({ data, error }) => {
      if (error || sheetCache.has(key)) return;
      const row = data as { rows?: unknown; updated_at?: string } | null;
      const rows = (Array.isArray(row?.rows) ? row.rows : []).map(normalizeRow).filter((r): r is SheetRow => r !== null);
      sheetCache.set(key, rows);
      // Seed the ordering watermark + own-state memory so a later refetch of this same (or older) state
      // can never be adopted destructively (mirrors useReelPersistence's load seeding).
      advanceSheetWatermark(key, Date.parse(row?.updated_at ?? '') || 0);
      rememberSheetWrite(key, stableStringify(rows));
    }, () => undefined);
}

export function useReelSheet(userId: string | null | undefined, sheetId: string) {
  const key = userId ? rowsKey(userId, sheetId) : null;
  const cached = key ? sheetCache.get(key) : undefined;
  const [fetched, setFetched] = useState(!!cached);
  const [initialRows, setInitialRows] = useState<SheetRow[]>(cached ?? []);
  // A failed load must NOT read as an empty sheet: the first edit would autosave a single starter
  // row over the user's whole persisted backlog. Surface it and let them retry instead.
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // A foreign write to this sheet (another tab/device) to adopt into the grid — set by the Realtime effect.
  const [external, setExternal] = useState<ExternalSheetRows | null>(null);
  const extRev = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revert = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRows = useRef<SheetRow[] | null>(null);   // latest pending rows, flushed on unmount
  // Canonical JSON of the rows we last KNOW are in the DB (last successful write or a Realtime-adopted
  // value). Skips no-op writes (save-storm dedup) and recognises our own Realtime echo. Order-invariant
  // (jsonb reorders keys) via stableStringify. Mirrors useReelPersistence.
  const lastSyncedJson = useRef<string | null>(null);

  // No user → nothing to fetch; loaded is simply derived so the grid renders its empty state.
  const loaded = fetched || !userId;
  // Readable from the reconcile closure (the sync effect's deps deliberately don't include `loaded`).
  const loadedRef = useRef(loaded);
  useEffect(() => { loadedRef.current = loaded; }, [loaded]);

  useEffect(() => {
    let cancelled = false;
    if (!userId || !key) return;
    (async () => {
      // Cache hit: adopt it — it's fresher than the DB (it includes pending edits). This must SET
      // state, not bare-return: warmSheetRows can fill the cache between the mount-time seed and
      // this effect running (or between a failed load and a retry), and skipping the setState
      // would leave `loaded` false forever with no error and no retry — a permanent "Loading…".
      const cached = sheetCache.get(key);
      if (cached) {
        setInitialRows(cached);
        setFetched(true);
        return;
      }
      const { data, error } = await supabase.from('reel_sheets').select('rows, updated_at')
        .eq('user_id', userId).eq('sheet_id', sheetId).maybeSingle();
      if (cancelled) return;
      if (error) { setLoadError(true); return; }
      const row = data as { rows?: unknown; updated_at?: string } | null;
      const rows = (Array.isArray(row?.rows) ? row.rows : []).map(normalizeRow).filter((r): r is SheetRow => r !== null);
      const loadedTs = parseUpdatedAt(row?.updated_at);
      // A newer state adopted while this SELECT was in flight must not be clobbered by the stale loaded
      // rows (see useReelPersistence's load continuation).
      if (keepAdoptedOverLoaded(sheetLastKnownUpdatedAt.get(key) ?? 0, loadedTs)) {
        setInitialRows(sheetCache.get(key) ?? rows);
        setFetched(true);
        return;
      }
      sheetCache.set(key, rows);
      // Seed the ordering watermark + own-state memory (see useReelPersistence's load seeding).
      advanceSheetWatermark(key, loadedTs);
      rememberSheetWrite(key, stableStringify(rows));
      setInitialRows(rows);
      setFetched(true);
    })();
    return () => { cancelled = true; };
  }, [userId, sheetId, key, loadAttempt]);

  const retryLoad = useCallback(() => {
    setLoadError(false);
    setLoadAttempt(a => a + 1);
  }, []);

  // NOTE: lastSyncedJson is deliberately NOT seeded from initialRows/sheetCache — the cache is advanced
  // optimistically by scheduleSave before any save confirms, so seeding from it could dedupe a transiently-
  // unsaved edit away on a remount. Left null, the first autosave re-persists the loaded rows, then dedup
  // kicks in. Mirrors useReelPersistence.

  const flush = useCallback(async (rows: SheetRow[]) => {
    if (!userId || !key || deadSheets.has(key)) return;
    const json = stableStringify(rows);
    if (json === lastSyncedJson.current) return;   // no-op write — kills the save storm
    // Advance the baseline BEFORE the await so our own Realtime echo is recognised as ours even if it lands
    // before this response resolves (see useReelPersistence.flush). Roll back on failure so it retries.
    const prevSynced = lastSyncedJson.current;
    lastSyncedJson.current = json;
    rememberSheetWrite(key, json);   // recognise this write's own echo even after a later write advances the baseline
    // Advance the ordering watermark pre-dispatch (echo-safe); rolled back on a real error response.
    const ts = new Date().toISOString();
    const tsMs = Date.parse(ts);
    const prevMark = advanceSheetWatermark(key, tsMs);
    trackSheetInFlight(key, 1);
    setSaveState('saving');
    // Materialize the lazy postgrest builder ONCE (a second await would re-send the request) so
    // the same promise can be both tracked for deleteSheet's ordering guarantee and awaited here.
    const save = Promise.resolve(
      supabase.from('reel_sheets')
        .upsert({ user_id: userId, sheet_id: sheetId, ...tabMetaFor(userId, sheetId), rows, updated_at: ts },
          { onConflict: 'user_id,sheet_id' }),
    );
    trackSave(key, save);
    const { error } = await save;
    trackSheetInFlight(key, -1);
    if (error) {
      if (lastSyncedJson.current === json) lastSyncedJson.current = prevSynced;   // failed save retries
      forgetSheetWrite(key, json);   // a failed write never echoes; don't wrongly suppress a later foreign write that matches
      rollbackSheetWatermark(key, tsMs, prevMark);
    }
    setSaveState(error ? 'error' : 'saved');
    if (revert.current) clearTimeout(revert.current);
    revert.current = setTimeout(() => setSaveState(prev => (prev === 'saved' ? 'idle' : prev)), 1500);
  }, [userId, sheetId, key]);

  // Debounced autosave — call on any change (typing, paste, add/delete row).
  const scheduleSave = useCallback((rows: SheetRow[]) => {
    if (!userId || !key || deadSheets.has(key)) return;
    sheetCache.set(key, rows);
    // A no-op save must not arm the debounce: an armed debounce blocks foreign adoption via the
    // pending-edit guard and then re-writes stale rows over the foreign edit (see useReelPersistence,
    // including why this is skipped while a write is in flight: the optimistic baseline may roll back).
    if (!hasSheetInFlightWrite(key) && stableStringify(rows) === lastSyncedJson.current) {
      if (debounce.current) { clearTimeout(debounce.current); debounce.current = null; }
      lastRows.current = null;
      return;
    }
    lastRows.current = rows;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { debounce.current = null; void flush(rows); }, DEBOUNCE_MS);
  }, [userId, key, flush]);

  // Fire-and-forget flush of a pending (still-debounced) save — no setState, safe outside React.
  const flushPending = useCallback(() => {
    if (!debounce.current) return;
    clearTimeout(debounce.current);
    debounce.current = null;
    const rows = lastRows.current;
    if (rows && userId && key && !deadSheets.has(key)) {
      const json = stableStringify(rows);
      if (json === lastSyncedJson.current) return;   // nothing new to flush
      // Set before dispatch (echo-safe) but roll back on failure so a dropped fire-and-forget write (no
      // keepalive on unmount/tab-hide) can't permanently dedupe the edit away.
      const prevSynced = lastSyncedJson.current;
      lastSyncedJson.current = json;
      rememberSheetWrite(key, json);   // same own-echo recognition as flush (echo-safe across a remount)
      const ts = new Date().toISOString();
      const tsMs = Date.parse(ts);
      const prevMark = advanceSheetWatermark(key, tsMs);
      trackSheetInFlight(key, 1);
      // .then() is what actually dispatches the request: postgrest-js builders are lazy PromiseLikes,
      // so a bare `void builder` never sends anything. postgrest-js NEVER rejects (every failure RESOLVES
      // with an `error` field), so failure handling lives in the fulfilled arm; a rejection-arm rollback
      // is dead code (see useReelPersistence.flushPending).
      const settle = (error: unknown) => {
        trackSheetInFlight(key, -1);
        if (!error) return;
        if (lastSyncedJson.current === json) lastSyncedJson.current = prevSynced;
        rollbackSheetWatermark(key, tsMs, prevMark);
        // Deliberately NOT forgetSheetWrite: a fire-and-forget unmount write's failure can be a lost
        // response on a COMMITTED request; forgetting it would make its own echo adoptable.
      };
      trackSave(key, supabase.from('reel_sheets')
        .upsert({ user_id: userId, sheet_id: sheetId, ...tabMetaFor(userId, sheetId), rows, updated_at: ts },
          { onConflict: 'user_id,sheet_id' })
        .then((res) => settle(res?.error), (err) => settle(err ?? new Error('rejected'))));
    }
  }, [userId, sheetId, key]);

  // Flush a pending save on unmount (e.g. leaving the reels section mid-debounce, or the per-tab
  // keyed grid remounting on a tab switch).
  useEffect(() => () => {
    if (revert.current) clearTimeout(revert.current);
    flushPending();
  }, [flushPending]);

  // Best-effort flush on tab-close / backgrounding, mirroring useReelPersistence: covers the
  // "pasted 50 rows then closed the tab inside the debounce window" case.
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushPending(); };
    window.addEventListener('pagehide', flushPending);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushPending);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushPending]);

  // ── Multi-tab live sync (this sheet's rows) ──────────────────────────────────────────────────────
  // Same last-writer-wins clobber as the reels grid: a stale second tab re-saves this sheet and
  // resurrects a row the first tab deleted. Adopt the other tab/device's write instead. postgres_changes
  // filters ONE column (user_id), so we filter this sheet's sheet_id in the callback. Focus refetch
  // backstops a throttled background tab. (Cross-tab TAB-list changes — rename/create/delete — are still
  // last-writer-wins by design, see the deadSheets note; this covers ROW edits, the data-loss case.)
  useEffect(() => {
    if (!userId || !key) return;
    const adopt = (raw: unknown, updatedAtRaw?: unknown, source: 'realtime' | 'refetch' = 'realtime') => {
      if (deadSheets.has(key)) return;
      const rows = (Array.isArray(raw) ? raw : []).map(normalizeRow).filter((r): r is SheetRow => r !== null);
      const json = stableStringify(rows);
      // Our own echo? Match against the whole recent-writes set (not just the latest baseline), so the echo
      // of an earlier in-flight write is recognised as ours and NOT destructively adopted. Membership-only:
      // we do NOT delete on match, so the check is idempotent under a doubly-delivered echo. A genuine
      // foreign write's rows were never in OUR set, so it is still adopted (multi-tab sync preserved).
      if (json === lastSyncedJson.current || isOwnRecentSheetWrite(key, json)) return;
      // ORDERING GUARD + benign short-circuit, mirroring useReelPersistence.adopt: never adopt state that
      // is not strictly newer than what we have loaded/written/adopted; identical-content payloads only
      // advance bookkeeping (no debounce cancel, no rebuild, no toast); no-timestamp + different content
      // is refused (fail closed against destructive adoption).
      const incoming = parseUpdatedAt(updatedAtRaw);
      const known = sheetLastKnownUpdatedAt.get(key) ?? 0;
      const ordering = adoptOrdering(incoming, known);
      if (ordering === 'refuse') return;
      if (json === stableStringify(sheetCache.get(key) ?? [])) {
        lastSyncedJson.current = json;
        rememberSheetWrite(key, json);
        if (incoming > known) advanceSheetWatermark(key, incoming);
        return;
      }
      if (ordering === 'no-timestamp') return;
      // LAST LINE OF DEFENSE: never let ANY adoption cancel unsaved local edits; local wins while a save
      // is armed or in flight (the pending autosave re-persists it, last-writer-wins). See
      // useReelPersistence.adopt for the full rationale.
      if (debounce.current || hasSheetInFlightWrite(key)) return;
      console.info('[sheet-sync] adopting foreign sheet rows', { source, incoming, known, rows: rows.length });
      advanceSheetWatermark(key, incoming);
      lastSyncedJson.current = json;
      rememberSheetWrite(key, json);   // an adopted state stays recognisable across remounts and re-deliveries
      // Cancel any pending local save: setEdited overwrites the local rows (foreign-wins), but the queued
      // debounce still holds PRE-adoption rows and would resurrect the row the other tab just deleted.
      if (debounce.current) { clearTimeout(debounce.current); debounce.current = null; }
      lastRows.current = null;
      sheetCache.set(key, rows);                      // a remount now restores the adopted rows
      extRev.current += 1;
      setExternal({ rows, rev: extRev.current });
    };
    // Guarded, throttled reconcile for missed Realtime events; focus is safe again because the watermark +
    // pending-edit guard make the refetch non-destructive (see useReelPersistence for the full rationale:
    // visibilitychange does not fire between two VISIBLE windows, so focus is what keeps a side-by-side
    // window fresh).
    let lastReconcileAt = 0;
    const reconcile = () => {
      // Never reconcile before the initial load has succeeded (see useReelPersistence.reconcile).
      if (!loadedRef.current) return;
      if (!reconcileDue(Date.now(), lastReconcileAt)) return;
      // Mid-save the local state is fresher than anything this SELECT can read; skip (see useReelPersistence).
      if (debounce.current || hasSheetInFlightWrite(key)) return;
      lastReconcileAt = Date.now();
      supabase.from('reel_sheets').select('rows, updated_at').eq('user_id', userId).eq('sheet_id', sheetId).maybeSingle()
        .then(({ data, error }) => {
          if (error) return;
          const row = data as { rows?: unknown; updated_at?: string } | null;
          adopt(row?.rows, row?.updated_at, 'refetch');
        }, () => undefined);
    };
    // Status-aware channel lifecycle with teardown + capped-backoff resubscribe and a catch-up reconcile
    // on every (re)subscribe; see useReelPersistence for the full rationale and the unique-topic note.
    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const subscribeChannel = () => {
      if (disposed) return;
      const ch = supabase
        .channel(`reel-sheet-${userId}-${sheetId}-${sheetChannelNonce()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'reel_sheets', filter: `user_id=eq.${userId}` },
          (payload) => {
            if (payload.eventType === 'DELETE') return;
            const row = payload.new as { sheet_id?: string; rows?: unknown; updated_at?: string } | null;
            if (!row || row.sheet_id !== sheetId) return;   // only THIS sheet
            adopt(row.rows, row.updated_at);
          });
      channel = ch;
      ch.subscribe((status) => {
        if (disposed || ch !== channel) return;   // stale callback from an already-torn-down channel
        if (status === 'SUBSCRIBED') {
          attempt = 0;
          lastReconcileAt = 0;   // events during any gap are lost; catch up now (guards still apply)
          reconcile();
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          channel = null;
          void supabase.removeChannel(ch);
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = setTimeout(subscribeChannel, resubscribeDelayMs(attempt++));
        }
      });
    };
    subscribeChannel();
    const onVisible = () => { if (document.visibilityState === 'visible') reconcile(); };
    const onFocus = () => reconcile();
    const interval = setInterval(() => { if (document.visibilityState === 'visible') reconcile(); }, RECONCILE_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(interval);
      const ch = channel;
      channel = null;
      if (ch) void supabase.removeChannel(ch);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [userId, key, sheetId]);

  return { loaded, loadError, retryLoad, initialRows, saveState, scheduleSave, flushPending, external };
}

let sheetIdCounter = 0;
function newSheetId(): string {
  sheetIdCounter += 1;
  // Random suffix so two devices creating tabs in the same millisecond can't collide on the PK.
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${sheetIdCounter}`;
}

// "Sheet N" for a new tab: one past the highest existing default-named tab (or the tab count,
// whichever is higher), so renamed tabs don't cause "Sheet 2" to appear twice.
function nextSheetName(tabs: SheetTab[]): string {
  const used = tabs
    .map(t => /^Sheet (\d+)$/.exec(t.name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return `Sheet ${Math.max(tabs.length, ...used, 0) + 1}`;
}

// The sheet tab list: load, create, rename, delete. Mutations are written straight through (no
// debounce — they're rare and destructive), optimistically for rename/delete, await-then-commit
// for create so a failed insert can't leave a phantom tab that eats the user's typing.
export function useSheetTabs(userId: string | null | undefined) {
  const cached = userId ? tabsCache.get(userId) : undefined;
  const [fetched, setFetched] = useState(!!cached);
  const [tabs, setTabs] = useState<SheetTab[]>(cached ?? [DEFAULT_TAB]);
  const [tabsError, setTabsError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  // Signed out → a single virtual tab, nothing to fetch (mutations are guarded off in the UI).
  const tabsLoaded = fetched || !userId;

  // Accepts an updater so failure reverts can be SURGICAL against current state: an async
  // mutation must never restore a whole pre-captured snapshot, which would clobber every other
  // mutation that committed while its request was in flight (e.g. re-inserting a tab that a
  // concurrent delete had already removed).
  const commitTabs = useCallback((next: SheetTab[] | ((cur: SheetTab[]) => SheetTab[])) => {
    const resolved = typeof next === 'function' ? next(tabsRef.current) : next;
    if (userId) tabsCache.set(userId, resolved);
    tabsRef.current = resolved;
    setTabs(resolved);
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    if (!userId || tabsCache.has(userId)) return;
    (async () => {
      const { data, error } = await supabase.from('reel_sheets')
        .select('sheet_id, name, position').eq('user_id', userId)
        .order('position', { ascending: true }).order('sheet_id', { ascending: true });
      if (cancelled) return;
      if (error) { setTabsError(true); return; }
      const loadedTabs = (data ?? [])
        .map(r => ({ sheetId: String(r.sheet_id), name: String(r.name), position: Number(r.position) || 0 }))
        .filter(t => !deadSheets.has(rowsKey(userId, t.sheetId)));
      // No rows yet → the virtual default tab; its DB row appears on the first write.
      const next = loadedTabs.length ? loadedTabs : [DEFAULT_TAB];
      tabsCache.set(userId, next);
      setTabs(next);
      setFetched(true);
    })();
    return () => { cancelled = true; };
  }, [userId, loadAttempt]);

  const retryTabs = useCallback(() => {
    setTabsError(false);
    setLoadAttempt(a => a + 1);
  }, []);

  // Returns the new tab's sheetId (so the caller can activate it), or null if it couldn't be made.
  const createSheet = useCallback(async (): Promise<string | null> => {
    if (!userId) return null;
    const cur = tabsRef.current;
    if (cur.length >= MAX_SHEETS) return null;
    const tab: SheetTab = {
      sheetId: newSheetId(),
      name: nextSheetName(cur),
      position: Math.max(...cur.map(t => t.position), -1) + 1,
    };
    setCreating(true);
    // Client-set updated_at keeps the ordering watermark single-clock (the column default would stamp
    // the SERVER's now()); the new sheet's echo carries rows=[] and is benign for a fresh key.
    const { error } = await supabase.from('reel_sheets')
      .upsert({ user_id: userId, sheet_id: tab.sheetId, name: tab.name, position: tab.position, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,sheet_id' });
    setCreating(false);
    if (error) return null;
    commitTabs([...tabsRef.current, tab]);
    return tab.sheetId;
  }, [userId, commitTabs]);

  const renameSheet = useCallback(async (sheetId: string, rawName: string) => {
    if (!userId) return;
    const name = rawName.trim().slice(0, MAX_SHEET_NAME_LEN);
    const cur = tabsRef.current;
    const tab = cur.find(t => t.sheetId === sheetId);
    if (!tab || !name || name === tab.name) return;
    commitTabs(ts => ts.map(t => (t.sheetId === sheetId ? { ...t, name } : t)));
    // Upsert, not update: the virtual default tab has no DB row until its first write — this
    // creates it (rows falls back to the '[]' column default); on an existing row only the
    // payload's columns are SET, so the sheet's rows are untouched. Tracked in inflightSaves like
    // the rows writes: it hits the same row, so deleteSheet's settle-before-DELETE ordering must
    // cover it too, or a slow rename could land after the DELETE and re-insert the row.
    // DELIBERATELY no updated_at here: a rename echo carries the sheet's OLD rows, and the row keeping its
    // previous timestamp is what makes the adopt ordering guard refuse that echo. Freshening it would make
    // the stale-rows echo adoptable and could clobber pending row edits (the exact bug class we fixed).
    const save = Promise.resolve(
      supabase.from('reel_sheets')
        .upsert({ user_id: userId, sheet_id: sheetId, name, position: tab.position },
          { onConflict: 'user_id,sheet_id' }),
    );
    trackSave(rowsKey(userId, sheetId), save);
    const { error } = await save;
    // Surgical revert: restore the old name only where the optimistic one still stands.
    if (error) commitTabs(ts => ts.map(t => (t.sheetId === sheetId && t.name === name ? { ...t, name: tab.name } : t)));
  }, [userId, commitTabs]);

  // Deleting a sheet permanently drops its rows — the UI confirms first and disables it for the
  // last remaining tab (tabs can never go to zero, so 'sheet-1' can't re-materialize virtually).
  const deleteSheet = useCallback(async (sheetId: string) => {
    if (!userId) return;
    const cur = tabsRef.current;
    const tab = cur.find(t => t.sheetId === sheetId);
    if (cur.length <= 1 || !tab) return;
    const key = rowsKey(userId, sheetId);
    // Mark dead BEFORE anything else: the tab's grid unmounts when it stops being active, and its
    // unmount flush (or an in-flight debounce) would otherwise resurrect the row post-delete.
    deadSheets.add(key);
    commitTabs(ts => ts.filter(t => t.sheetId !== sheetId));
    // deadSheets only stops saves not yet dispatched — let every save already on the wire settle
    // before deleting, or a slow big-payload upsert could land after the DELETE and re-insert the
    // row (invisible for the rest of the session, back as a zombie tab on the next load).
    await inflightSaves.get(key);
    const { error } = await supabase.from('reel_sheets').delete()
      .eq('user_id', userId).eq('sheet_id', sheetId);
    if (error) {
      // Revert surgically: un-dead the key, re-insert just this tab (unless something else
      // re-created it meanwhile). The rows cache was deliberately NOT purged yet, so edits that
      // only lived locally are still there when the grid remounts.
      deadSheets.delete(key);
      commitTabs(ts => (ts.some(t => t.sheetId === sheetId)
        ? ts
        : [...ts, tab].sort((a, b) => a.position - b.position || a.sheetId.localeCompare(b.sheetId))));
    } else {
      // Uploaded videos the sheet's Link cells referenced become orphans, deliberately: an eager GC
      // here raced the debounced reels autosave ("send all to reels, then delete the sheet" deleted
      // the videos those new reels reference — 2026-07-20 review). Orphans only cost storage;
      // deleting a live file breaks reels irreversibly.
      sheetCache.delete(key);
    }
  }, [userId, commitTabs]);

  return { tabs, tabsLoaded, tabsError, retryTabs, creating, createSheet, renameSheet, deleteSheet };
}
