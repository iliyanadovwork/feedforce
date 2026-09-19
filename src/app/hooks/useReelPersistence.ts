'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { stableStringify } from '@/lib/stableStringify';
import type { SaveState } from '../components/AutosaveChip';
import type { Framing } from '../components/TikTokCanvas/types';

// One saved reel = one grid row, persisted as plain numbers/strings (never the video). The whole grid is
// stored as a single jsonb array in `public.video_reels` (see production/supabase/video_reels.sql).
export interface SavedReel {
  id: string;
  name: string;                  // optional user label ('' = unnamed; absent on pre-name rows)
  mode: 'twitter' | 'caption';
  url: string;                    // pasted link (re-fetched on load unless stored below); empty for uploads
  videoUrl: string;              // durable post-videos bucket URL for a stored reel (upload OR link); else empty
  posterUrl: string;             // durable post-images bucket URL of the poster (else empty)
  caption: string;
  description: string;           // per-reel Instagram post caption (empty falls back to caption); see reelPostText
  templateId: string | null;     // inherited reel template (twitter_templates) → text boxes / pfp / positions
  framing: Framing;              // crop / pan / zoom / trim
  stickerEnabled: boolean;       // FeedForce rewards sticker baked into the render (raw toggle; only drawn while enrolled)
}

// A foreign write adopted from another tab/device via Realtime (or the focus refetch). `rev` bumps on every
// adoption so CanvasGrid's apply effect re-runs even for two adoptions that carry equal-looking arrays.
export interface ExternalReels { rows: SavedReel[]; rev: number }

const DEBOUNCE_MS = 800;
const MAX_LOAD_RETRIES = 3;
const RETRY_BASE_MS = 1500;

// Last-known rows per user, surviving section switches / canvas remounts. A remount seeds from here
// instead of re-SELECTing, which closes the flush-vs-refetch race (an in-flight unmount save can't be
// shadowed by a stale DB read) and makes returning to the reels canvas instant. Mirrors useReelSheet's
// sheetCache. Reset on a full page reload (module re-init), so a refresh always reads fresh from the DB.
export const reelCache = new Map<string, SavedReel[]>();

// Canonical JSON of the reel-array writes THIS TAB has recently dispatched, per user. postgres_changes
// has no self-exclusion, so every upsert echoes back to us and we must recognise that echo as our OWN.
// A single "last synced" baseline only ever equals the NEWEST write, so with several writes in flight the
// echo of an EARLIER one looks foreign and gets destructively adopted, reverting the grid and cancelling
// the pending save (the schedule round-trip data-loss bug). A bounded SET of recent writes fixes that.
// Module-scoped so a write from a just-unmounted grid is still recognised by the fresh instance after a
// section round-trip. Keyed by user; oldest evicted past the cap.
export const RECENT_WRITES_CAP = 12;
const recentWrites = new Map<string, Set<string>>();
// Exported for the persistence regression test. These are the own-echo recognition primitives, not app API.
export function rememberWrite(userId: string, json: string) {
  let set = recentWrites.get(userId);
  if (!set) { set = new Set(); recentWrites.set(userId, set); }
  // delete-then-add so a RE-written json regains queue recency: Set.add of an existing member keeps its
  // OLD insertion position, which let a burst of writes (a Schedule All run) evict the CURRENT DB tip
  // from the cap window while stale entries survived (incident 2026-07-19, second wave).
  set.delete(json);
  set.add(json);
  while (set.size > RECENT_WRITES_CAP) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}
export function forgetWrite(userId: string, json: string) {
  recentWrites.get(userId)?.delete(json);
}
export function isOwnRecentWrite(userId: string, json: string) {
  return recentWrites.get(userId)?.has(json) ?? false;
}

// A per-subscription random suffix so a re-subscribe never reuses a torn-down channel's topic.
function channelNonce(): string {
  const c = globalThis.crypto;
  return c && 'randomUUID' in c ? c.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ── Ordering watermark ───────────────────────────────────────────────────────────────────────────
// Monotonic per-user epoch-ms of the newest `updated_at` we have LOADED, WRITTEN, or ADOPTED. adopt()
// refuses anything not STRICTLY newer. This is the invariant own-write memory cannot express: recentWrites
// answers "did THIS session send it?", but a page reload wipes it and the 12-cap evicts it, so the
// focus/visibility refetch could hand adopt() a committed-but-OLDER DB state that looked foreign and
// destructively reverted local edits (incident 2026-07-19: calendar-then-back reset the grid with a
// "Reels updated in another tab" toast and no second tab). Module-scoped: survives remounts; a reload
// re-seeds it from the initial SELECT. Timestamps are client-set (same clock for same-machine tabs, the
// case this feature targets). Cross-device clock skew can delay adoption of a behind-clock device's write
// here, and the overall last-writer-wins semantics can still clobber it in the DB (pre-existing trade-off,
// unchanged by this guard); moving to server-authoritative timestamps is the known upgrade path.
// Exported for the persistence regression test.
export const lastKnownUpdatedAt = new Map<string, number>();
export function advanceWatermark(key: string, ms: number): number {
  const prev = lastKnownUpdatedAt.get(key) ?? 0;
  if (ms > prev) lastKnownUpdatedAt.set(key, ms);
  return prev;
}
export function rollbackWatermark(key: string, ms: number, prev: number) {
  // Only roll back if OUR advance is still the current value (a newer write/adopt may have superseded it).
  if (lastKnownUpdatedAt.get(key) === ms) {
    if (prev > 0) lastKnownUpdatedAt.set(key, prev);
    else lastKnownUpdatedAt.delete(key);
  }
}

// Our own upserts currently on the wire, per user. While one is in flight (or a debounce is armed), the
// local state is by definition fresher than anything a refetch could read, so the refetch is skipped.
const inFlightWrites = new Map<string, number>();
function trackInFlight(key: string, delta: number) {
  inFlightWrites.set(key, Math.max(0, (inFlightWrites.get(key) ?? 0) + delta));
}
export function hasInFlightWrite(key: string) { return (inFlightWrites.get(key) ?? 0) > 0; }

// Minimum gap between reconcile SELECTs (the focus/visibility backstop): focus can fire in quick bursts
// (window switching, DevTools), and the reconcile only exists to catch MISSED events, so once per few
// seconds is plenty. Exported for the sheet hook + tests.
export const RECONCILE_THROTTLE_MS = 5000;

/** Whether enough time has passed since the last reconcile to run another (the throttle both hooks use).
 *  lastMs = 0 means never reconciled, always due. Exported so tests exercise the REAL comparison. */
export function reconcileDue(nowMs: number, lastMs: number): boolean {
  return nowMs - lastMs >= RECONCILE_THROTTLE_MS;
}

/** Load-continuation decision: when the initial SELECT resolves, was a NEWER state adopted (Realtime echo
 *  or reconcile) while it was in flight? If so the loaded rows are stale and must not clobber the adopted
 *  cache/watermark: seed the grid from the adopted state instead. Exported so tests exercise the REAL
 *  comparison (both hooks call this). */
export function keepAdoptedOverLoaded(knownMs: number, loadedMs: number): boolean {
  return knownMs > 0 && loadedMs <= knownMs;
}

// Slow safety-net reconcile cadence: Supabase acknowledges postgres_changes can drop events silently
// even on a healthy-looking channel, so a visible tab re-checks the row once a minute. Every pass is
// fully guarded (loaded + pending-edit + watermark), so it can only ever fast-forward.
export const RECONCILE_INTERVAL_MS = 60_000;

/** Capped exponential backoff for Realtime channel resubscription (1s, 2s, 4s ... max 30s). Exported so
 *  tests exercise the REAL schedule. */
export function resubscribeDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
}

/** Parse an `updated_at` wire value to epoch ms; 0 when absent/unparseable. Normalizes the Postgres
 *  text form Realtime can deliver ("2026-07-19 19:00:00.123+00": space separator, offset without
 *  minutes), which spec-conformant Date.parse implementations (Safari) reject while V8 is lenient. */
export function parseUpdatedAt(raw: unknown): number {
  if (typeof raw !== 'string' || raw === '') return 0;
  let s = raw.replace(' ', 'T');
  if (/[+-]\d\d$/.test(s)) s = `${s}:00`;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

/** The adopt() ordering decision, extracted pure so tests exercise the REAL comparison:
 *  'refuse' = stale or same state (not strictly newer than the watermark), never adopt;
 *  'adoptable' = strictly newer, may rebuild the grid;
 *  'no-timestamp' = cannot order it, only the content-equality path may accept it (fail closed). */
export function adoptOrdering(incomingMs: number, knownMs: number): 'refuse' | 'adoptable' | 'no-timestamp' {
  if (incomingMs <= 0) return 'no-timestamp';
  return incomingMs > knownMs ? 'adoptable' : 'refuse';
}

export function useReelPersistence(userId: string | null | undefined) {
  const cached = userId ? reelCache.get(userId) : undefined;
  const [fetched, setFetched] = useState(!!cached);
  const [initialRows, setInitialRows] = useState<SavedReel[]>(cached ?? []);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // A failed load must NOT read as an empty grid: `loaded` stays false, so CanvasGrid's restore +
  // autosave (both gated on it) never run and the user's saved reels can't be overwritten with
  // nothing. Mirrors useReelSheet's loadError guard — video_reels never had it, so a transient
  // SELECT failure silently wiped the grid on the next autosave.
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // A foreign write (another tab/device) to adopt into the grid — set by the Realtime effect below.
  const [external, setExternal] = useState<ExternalReels | null>(null);
  const extRev = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revert = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRows = useRef<SavedReel[] | null>(null);   // latest pending rows, flushed on unmount
  // Canonical JSON of the rows we last KNOW are in the DB (last successful write, or a value adopted from
  // Realtime). Two jobs: (1) a write whose rows match this is a no-op — skip it, which kills the ~1/sec
  // save storm (auto-fetch mutates only non-persisted fields, so the saved rows are unchanged); (2) a
  // Realtime event whose rows match this is our OWN echo (postgres_changes has no self-exclusion) — ignore
  // it, so we never re-adopt what we just wrote. Order-invariant (jsonb reorders keys) via stableStringify.
  const lastSyncedJson = useRef<string | null>(null);

  // No user → nothing to restore; derived rather than set in the effect.
  const loaded = fetched || !userId;
  // Readable from the reconcile closure (the sync effect's deps deliberately don't include `loaded`).
  const loadedRef = useRef(loaded);
  useEffect(() => { loadedRef.current = loaded; }, [loaded]);

  const retryLoad = useCallback(() => {
    setLoadError(false);
    setLoadAttempt(a => a + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    (async () => {
      // Cache hit: ADOPT it into state, don't bare-return. The cache is fresher than the DB (it includes
      // pending edits), but it can also have been seeded by a Realtime/reconcile adoption that raced a
      // FAILED load; a bare return then left fetched=false forever (retryLoad hit the early-return and the
      // grid stayed stuck on Loading until a full reload; found in review). Mirrors useReelSheet's load.
      const cachedRows = reelCache.get(userId);
      if (cachedRows) {
        setLoadError(false);
        setInitialRows(cachedRows);
        setFetched(true);
        return;
      }
      const { data, error } = await supabase.from('video_reels').select('reels, updated_at').eq('user_id', userId).maybeSingle();
      if (cancelled) return;
      if (error) {
        // Keep the workspace un-restored (no save can fire) and auto-retry with backoff so a transient
        // blip self-heals; a hard failure stays safe and recovers on reload or retryLoad().
        setLoadError(true);
        if (loadAttempt < MAX_LOAD_RETRIES) {
          retryTimer.current = setTimeout(() => setLoadAttempt(a => a + 1), RETRY_BASE_MS * (loadAttempt + 1));
        }
        return;
      }
      setLoadError(false);
      const row = data as { reels?: unknown; updated_at?: string } | null;
      const rows = (Array.isArray(row?.reels) ? row.reels : []).map(normalizeReel).filter((r): r is SavedReel => r !== null);
      const loadedTs = parseUpdatedAt(row?.updated_at);
      // A Realtime echo (or reconcile) may have adopted a NEWER state while this SELECT was in flight; the
      // loaded rows are then STALE and must not clobber the adopted cache/watermark (that silently discarded
      // a genuinely newer foreign write and blocked its re-adoption; found in review). Seed from whichever
      // state is newer.
      if (keepAdoptedOverLoaded(lastKnownUpdatedAt.get(userId) ?? 0, loadedTs)) {
        setInitialRows(reelCache.get(userId) ?? rows);
        setFetched(true);
        return;
      }
      reelCache.set(userId, rows);
      // Seed the ordering watermark and own-state memory from the loaded row, so a later refetch that
      // returns this same (or any older) state can never be mistaken for a foreign write and adopted.
      advanceWatermark(userId, loadedTs);
      rememberWrite(userId, stableStringify(rows));
      setInitialRows(rows);
      setFetched(true);
    })();
    return () => { cancelled = true; };
  }, [userId, loadAttempt]);

  // NOTE: lastSyncedJson is deliberately NOT seeded from initialRows/the module cache. The cache is advanced
  // optimistically by scheduleSave on every edit (before any save confirms), so seeding from it could dedupe
  // a transiently-unsaved edit away on a remount. Left null, the first autosave re-persists the loaded rows
  // (one write), then the dedup kicks in — self-healing and storm-safe.

  // Clear a pending retry on unmount.
  useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current); }, []);

  const flush = useCallback(async (rows: SavedReel[]) => {
    if (!userId) return;
    const json = stableStringify(rows);
    if (json === lastSyncedJson.current) return;   // identical to the last synced state → no-op (kills the save storm)
    // Advance the baseline BEFORE the await: our own upsert echoes back over Realtime (postgres_changes has
    // no self-exclusion) and can reach this tab before the HTTP response resolves. If the baseline were still
    // the pre-write value then, adopt() would treat our OWN write as foreign and needlessly rebuild the grid
    // (dropping in-flight edits). JS is single-threaded, so setting it before the await closes that window.
    // Roll back on failure so a failed save isn't wrongly deduped away on the next autosave.
    const prevSynced = lastSyncedJson.current;
    lastSyncedJson.current = json;
    rememberWrite(userId, json);   // recognise this write's own echo even after a later write advances the baseline
    // Advance the ordering watermark to this write's timestamp BEFORE dispatch (same echo-safe pattern as
    // lastSyncedJson): a refetch racing this write then reads PRE-write rows with an older updated_at and
    // the adopt guard refuses them. Rolled back on a real error response.
    const ts = new Date().toISOString();
    const tsMs = Date.parse(ts);
    const prevMark = advanceWatermark(userId, tsMs);
    trackInFlight(userId, 1);
    setSaveState('saving');
    const { error } = await supabase.from('video_reels')
      .upsert({ user_id: userId, reels: rows, updated_at: ts });
    trackInFlight(userId, -1);
    if (error) {
      if (lastSyncedJson.current === json) lastSyncedJson.current = prevSynced;
      forgetWrite(userId, json);   // a failed write never echoes; don't wrongly suppress a later foreign write that matches
      rollbackWatermark(userId, tsMs, prevMark);
    }
    setSaveState(error ? 'error' : 'saved');
    if (revert.current) clearTimeout(revert.current);
    revert.current = setTimeout(() => setSaveState(prev => (prev === 'saved' ? 'idle' : prev)), 1500);
  }, [userId]);

  // Debounced autosave — call on any change (link/caption/mode/template/framing).
  const scheduleSave = useCallback((rows: SavedReel[]) => {
    if (!userId) return;
    reelCache.set(userId, rows);   // keep the cache current so a remount restores the latest, unsaved-yet edits
    // A NO-OP "save" (rows identical to the last synced state) must not arm the debounce at all: an armed
    // debounce reads as "user is editing" to the adoption guard, so churn-armed no-ops (video loads
    // re-running the autosave effect) blocked foreign adoption on IDLE tabs and then wrote stale rows over
    // the foreign edit (the 2026-07-21 localhost sync failure). Content-identical rows have nothing to
    // save, nothing to protect, and nothing to clobber; flush would have deduped them anyway. NOT applied
    // while a write is IN FLIGHT: the baseline was advanced optimistically at dispatch, so "identical"
    // could describe a write that is about to FAIL and roll back; keeping the debounce armed then
    // preserves the retry (review finding 2026-07-21).
    if (!hasInFlightWrite(userId) && stableStringify(rows) === lastSyncedJson.current) {
      if (debounce.current) { clearTimeout(debounce.current); debounce.current = null; }
      lastRows.current = null;
      return;
    }
    lastRows.current = rows;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { debounce.current = null; void flush(rows); }, DEBOUNCE_MS);
  }, [userId, flush]);

  // Fire-and-forget flush of a pending (still-debounced) save — no setState, safe outside React.
  const flushPending = useCallback(() => {
    if (!debounce.current) return;
    clearTimeout(debounce.current);
    debounce.current = null;
    const rows = lastRows.current;
    if (rows && userId) {
      const json = stableStringify(rows);
      if (json === lastSyncedJson.current) return;   // nothing new to flush
      // Set the baseline before dispatch (echo-safe, as in flush) but ROLL BACK if the write fails: this
      // runs on unmount / tab-hide with a non-keepalive fetch, so a dropped write must NOT permanently
      // dedupe the edit away. Guard the rollback so it can't clobber a newer baseline set meanwhile.
      const prevSynced = lastSyncedJson.current;
      lastSyncedJson.current = json;
      rememberWrite(userId, json);   // same own-echo recognition as flush (echo-safe across a remount)
      const ts = new Date().toISOString();
      const tsMs = Date.parse(ts);
      const prevMark = advanceWatermark(userId, tsMs);
      trackInFlight(userId, 1);
      // .then() is what actually dispatches the request — postgrest-js builders are lazy
      // PromiseLikes, so a bare `void builder` never sends anything. postgrest-js NEVER rejects: every
      // failure (network drop included) RESOLVES with an `error` field, so the failure handling must
      // live in the fulfilled arm; a rejection-arm rollback is dead code (found in review; the
      // pre-watermark version of this rollback had been dead since it shipped).
      const settle = (error: unknown) => {
        trackInFlight(userId, -1);
        if (!error) return;
        if (lastSyncedJson.current === json) lastSyncedJson.current = prevSynced;
        rollbackWatermark(userId, tsMs, prevMark);
        // Deliberately NOT forgetWrite: a fire-and-forget unmount/tab-hide failure can be a LOST
        // RESPONSE on a request the server actually committed. Forgetting it would make its own echo
        // look foreign and destructively adopt; keeping it remembered is safe (worst case a genuinely
        // failed write stays suppressed until the next autosave re-persists the same rows).
      };
      supabase.from('video_reels').upsert({ user_id: userId, reels: rows, updated_at: ts })
        .then((res) => settle(res?.error), (err) => settle(err ?? new Error('rejected')));
    }
  }, [userId]);

  // Flush a pending save on unmount (e.g. leaving the section mid-debounce).
  useEffect(() => () => {
    if (revert.current) clearTimeout(revert.current);
    flushPending();
  }, [flushPending]);

  // Best-effort flush on tab-close / backgrounding. supabase-js uses plain fetch (no keepalive), so delivery
  // isn't guaranteed on a hard tab-close, but this reliably covers backgrounding/switching-away within the
  // debounce window — the common "I tabbed away right after editing" case. In-app unmount is above.
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushPending(); };
    window.addEventListener('pagehide', flushPending);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushPending);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushPending]);

  // ── Multi-tab live sync ──────────────────────────────────────────────────────────────────────────
  // The grid is one jsonb array per user, saved by a last-writer-wins upsert. Without this, a second tab
  // holding a stale copy re-saves it and RESURRECTS a reel the first tab deleted (a real data-loss bug).
  // Realtime lets a tab ADOPT another tab/device's write instead of later clobbering it. A visibilitychange
  // refetch backstops it: a backgrounded tab has its socket + timers throttled and can miss events.
  // Delivery preconditions (both satisfied): video_reels is in the supabase_realtime publication (see
  // supabase/migrations/20260717000000_realtime_reels_publication.sql) and has an owner SELECT RLS policy.
  useEffect(() => {
    if (!userId) return;
    const adopt = (raw: unknown, updatedAtRaw?: unknown, source: 'realtime' | 'refetch' = 'realtime') => {
      const rows = (Array.isArray(raw) ? raw : []).map(normalizeReel).filter((r): r is SavedReel => r !== null);
      const json = stableStringify(rows);
      // Our own echo? Match against the whole recent-writes set (not just the latest baseline), so the echo
      // of an earlier in-flight write is recognised as ours and NOT destructively adopted. Membership-only:
      // we do NOT delete on match, so the check is idempotent and a doubly-delivered echo (e.g. a brief
      // old/new channel overlap on remount) is suppressed BOTH times rather than adopted the second time. A
      // genuine foreign write's rows were never in OUR set, so it is still adopted (multi-tab sync preserved).
      if (json === lastSyncedJson.current || isOwnRecentWrite(userId, json)) return;
      // ORDERING GUARD: never adopt state that is not STRICTLY newer than what we have loaded/written/
      // adopted. Own-write memory cannot recognise states from before a page reload or evicted past the
      // cap, and the visibility refetch reads committed state that can be OLDER than the local grid (e.g.
      // racing an in-flight save). Timestamp ordering is the invariant that covers every such path.
      const incoming = parseUpdatedAt(updatedAtRaw);
      const known = lastKnownUpdatedAt.get(userId) ?? 0;
      const ordering = adoptOrdering(incoming, known);
      if (ordering === 'refuse') return;
      // Content identical to the freshest local truth → nothing to rebuild. Advance bookkeeping only:
      // never cancel the pending debounce, never rebuild the grid, never toast. Also the only acceptance
      // path when a payload carries NO parseable updated_at (fail closed against destructive adoption).
      if (json === stableStringify(reelCache.get(userId) ?? [])) {
        lastSyncedJson.current = json;
        rememberWrite(userId, json);
        if (incoming > known) advanceWatermark(userId, incoming);
        return;
      }
      if (ordering === 'no-timestamp') return;   // cannot order it AND content differs: refuse rather than destroy
      // LAST LINE OF DEFENSE: adoption must NEVER take unsaved local edits with it. While a local save is
      // armed (debounce) or on the wire (in flight), local wins and we refuse the rebuild entirely: the
      // pending autosave re-persists the local rows (last-writer-wins), so a genuinely newer foreign write
      // would have been overwritten by that save moments later anyway; nothing is lost that LWW would have
      // kept. This holds regardless of the trigger (stale refetch, mis-recognised echo, dev HMR resetting
      // the module-scoped recognition state), so "my edits reset while I was working" is structurally
      // impossible. Idle tabs (no pending save) still adopt foreign writes normally.
      if (debounce.current || hasInFlightWrite(userId)) return;
      // Destructive adoption accepted: log the decision inputs so any future misfire is diagnosable from
      // the user's console instead of reconstructed by guesswork.
      console.info('[reels-sync] adopting foreign reels state', { source, incoming, known, rows: rows.length });
      advanceWatermark(userId, incoming);
      lastSyncedJson.current = json;
      rememberWrite(userId, json);   // an adopted state stays recognisable across remounts and re-deliveries
      // Cancel any pending local save: it captured PRE-adoption rows and would otherwise fire after this and
      // resurrect exactly what the other tab just changed/deleted. Foreign-wins is the chosen semantics.
      if (debounce.current) { clearTimeout(debounce.current); debounce.current = null; }
      lastRows.current = null;
      reelCache.set(userId, rows);                    // a remount now restores the adopted array
      extRev.current += 1;
      setExternal({ rows, rev: extRev.current });
    };
    // Reconcile = the guarded refetch backstop for MISSED Realtime events (socket blip, background
    // throttling). It is provably non-destructive: skipped while our own save is armed/in flight, refused
    // by the ordering watermark for stale state, and content-identical payloads are benign. That safety is
    // what re-permits a window `focus` trigger (removed while the refetch could destructively adopt, the
    // 2026-07-19 incident): visibilitychange does NOT fire when switching between two VISIBLE windows
    // (e.g. localhost next to production side by side), so without focus a missed event left such a tab
    // stale until its next write. Throttled so rapid focus churn cannot turn into SELECT chatter.
    let lastReconcileAt = 0;
    const reconcile = () => {
      // Never reconcile before the initial load has succeeded: a concurrent SELECT racing the load could
      // adopt into a pre-restore grid (clobbered by the load continuation) or seed the cache after a FAILED
      // load and wedge the retry path (both found in review). The load itself is the first reconcile.
      if (!loadedRef.current) return;
      if (!reconcileDue(Date.now(), lastReconcileAt)) return;
      // Mid-save the local state is by definition fresher than anything this SELECT can read; the refetch
      // exists to catch missed FOREIGN events, so skip it entirely while our own write is pending/in flight.
      if (debounce.current || hasInFlightWrite(userId)) return;
      lastReconcileAt = Date.now();
      supabase.from('video_reels').select('reels, updated_at').eq('user_id', userId).maybeSingle()
        .then(({ data, error }) => {
          if (error) return;
          const row = data as { reels?: unknown; updated_at?: string } | null;
          adopt(row?.reels, row?.updated_at, 'refetch');
        }, () => undefined);
    };
    // Channel lifecycle: a Realtime channel can die silently (CHANNEL_ERROR / TIMED_OUT / CLOSED after a
    // network blip or laptop sleep), and a socket auto-rejoin is documented to sometimes stop delivering
    // postgres_changes (supabase/realtime#1088, realtime-py#213: exactly "sync worked, then silently
    // stopped"). Production pattern per the Supabase docs: handle the subscribe STATUS, keep exactly ONE
    // live channel, tear down + resubscribe with capped exponential backoff, and force a reconcile on
    // every (re)subscribe because events during the gap are lost for good.
    // Unique topic per subscription: removeChannel() isn't awaited, and reusing a topic can inherit the
    // old channel's buffered echoes (supabase-js#1440); the postgres_changes filter scopes rows, not the topic.
    let disposed = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const subscribeChannel = () => {
      if (disposed) return;
      const ch = supabase
        .channel(`video-reels-${userId}-${channelNonce()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'video_reels', filter: `user_id=eq.${userId}` },
          (payload) => {
            if (payload.eventType === 'DELETE') return;   // one row per user; DELETE isn't part of normal flow
            const row = payload.new as { reels?: unknown; updated_at?: string } | null;
            adopt(row?.reels, row?.updated_at);
          });
      channel = ch;
      ch.subscribe((status) => {
        if (disposed || ch !== channel) return;   // stale callback from an already-torn-down channel
        if (status === 'SUBSCRIBED') {
          attempt = 0;
          // Anything sent while we were down is gone; catch up immediately (throttle bypassed, the
          // loaded/pending/watermark guards still apply, so this can only fast-forward).
          lastReconcileAt = 0;
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
    // Last-resort net for silently-dropped events on a healthy-looking channel (Supabase-acknowledged):
    // a visible tab re-checks once a minute; hidden tabs catch up via visibilitychange instead.
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
  }, [userId]);

  return { loaded, loadError, retryLoad, initialRows, saveState, scheduleSave, external };
}

export function normalizeReel(r: unknown): SavedReel | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  return {
    id: o.id,
    name: typeof o.name === 'string' ? o.name : '',   // rows saved before names existed → unnamed
    mode: o.mode === 'caption' ? 'caption' : 'twitter',
    url: typeof o.url === 'string' ? o.url : '',
    videoUrl: typeof o.videoUrl === 'string' ? o.videoUrl : '',
    posterUrl: typeof o.posterUrl === 'string' ? o.posterUrl : '',
    caption: typeof o.caption === 'string' ? o.caption : '',
    description: typeof o.description === 'string' ? o.description : '',   // legacy rows had none → ''
    templateId: typeof o.templateId === 'string' ? o.templateId : null,
    framing: (o.framing && typeof o.framing === 'object' ? o.framing : {}) as Framing,
    stickerEnabled: o.stickerEnabled === true,   // legacy/garbage values → off (never truthy-coerced)
  };
}
