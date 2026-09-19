import { describe, it, expect, vi } from 'vitest';

// GAP 2 — reel sheet data-loss semantics, module-level parts only. Everything inside the hook
// bodies (loadError gating, flushPending, deleteSheet's settle-before-DELETE ordering) needs a DOM
// renderer and is out of scope for the node test env.
//
// warmSheetRows IS module-level, and it exercises the exact trap the production comments warn
// about: postgrest-js builders are LAZY PromiseLikes — only .then() dispatches the request, a bare
// `void builder` never sends anything. The mock below models that: nothing counts as "sent" until
// .then() is invoked, so removing the .then in production makes `dispatched` stay false AND the
// resolution callback never run — the cache-fill assertions fail on both.

const h = vi.hoisted(() => {
  type Call = {
    table: string;
    select?: string;
    filters: Array<[string, unknown]>;
    maybeSingle: boolean;
    dispatched: boolean;
  };
  type Result = { data: unknown; error: unknown };
  const state: { calls: Call[]; result: Result } = {
    calls: [],
    result: { data: null, error: null },
  };
  const from = (table: string) => {
    const call: Call = { table, filters: [], maybeSingle: false, dispatched: false };
    state.calls.push(call);
    const builder = {
      select(cols: string) { call.select = cols; return builder; },
      eq(col: string, val: unknown) { call.filters.push([col, val]); return builder; },
      maybeSingle() { call.maybeSingle = true; return builder; },
      // Lazy PromiseLike, like postgrest-js: .then() is the send.
      then(onOk?: (v: Result) => unknown, onErr?: (e: unknown) => unknown) {
        call.dispatched = true;
        return Promise.resolve(state.result).then(onOk, onErr);
      },
    };
    return builder;
  };
  return { state, from };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from: h.from } }));

import {
  normalizeRow, makeSheetRow, warmSheetRows, DEFAULT_TAB, rememberSheetWrite, forgetSheetWrite, isOwnRecentSheetWrite, RECENT_WRITES_CAP,
  sheetLastKnownUpdatedAt, advanceSheetWatermark, rollbackSheetWatermark,
} from './useReelSheet';

// Let the mocked query's .then callback (a real microtask) run.
const settle = () => new Promise<void>(res => setTimeout(res, 0));

describe('own-echo recognition: sheet rows share the reel data-loss fix', () => {
  // Same bug as useReelPersistence: a single "last synced" baseline only matches the newest write, so the
  // echo of an earlier in-flight sheet write looked foreign and was destructively adopted (reverting/
  // resurrecting rows another tab thought were deleted). A bounded per-(user,sheet) set recognises any of
  // our recent writes. Keyed by the sheet's rowsKey, so writes to one sheet never suppress another's echo.
  it('recognises an earlier in-flight write, not just the latest', () => {
    const k = 'user-a/sheet-1';
    rememberSheetWrite(k, 'A');
    rememberSheetWrite(k, 'B');
    expect(isOwnRecentSheetWrite(k, 'A')).toBe(true);
    expect(isOwnRecentSheetWrite(k, 'B')).toBe(true);
    expect(isOwnRecentSheetWrite(k, 'FOREIGN')).toBe(false);
  });

  it('is isolated per (user, sheet) key', () => {
    rememberSheetWrite('user-a/sheet-1', 'ROWS');
    expect(isOwnRecentSheetWrite('user-a/sheet-1', 'ROWS')).toBe(true);
    expect(isOwnRecentSheetWrite('user-a/sheet-2', 'ROWS')).toBe(false);   // different sheet
    expect(isOwnRecentSheetWrite('user-b/sheet-1', 'ROWS')).toBe(false);   // different user
  });

  it('forgetSheetWrite drops a failed/consumed write; eviction bounds the set', () => {
    const k = 'user-c/sheet-1';
    rememberSheetWrite(k, 'X');
    forgetSheetWrite(k, 'X');
    expect(isOwnRecentSheetWrite(k, 'X')).toBe(false);
    for (let i = 0; i <= RECENT_WRITES_CAP; i++) rememberSheetWrite(k, `w${i}`);   // one past the cap
    expect(isOwnRecentSheetWrite(k, 'w0')).toBe(false);                            // oldest evicted
    expect(isOwnRecentSheetWrite(k, `w${RECENT_WRITES_CAP}`)).toBe(true);          // newest kept
  });

  it('re-remembering refreshes recency (mirrors the reel hook fix)', () => {
    const k = 'user-d/sheet-1';
    for (let i = 0; i < RECENT_WRITES_CAP; i++) rememberSheetWrite(k, `w${i}`);
    rememberSheetWrite(k, 'w0');            // moves to the back of the eviction queue
    rememberSheetWrite(k, 'burst');         // evicts w1, not w0
    expect(isOwnRecentSheetWrite(k, 'w0')).toBe(true);
    expect(isOwnRecentSheetWrite(k, 'w1')).toBe(false);
  });
});

describe('sheet ordering watermark: the stale-refetch adopt guard (mirrors useReelPersistence)', () => {
  it('advance is monotonic, returns prev; rollback restores only while ours is current', () => {
    const k = 'user-e/sheet-1';
    expect(advanceSheetWatermark(k, 1000)).toBe(0);
    const prev = advanceSheetWatermark(k, 2000);
    expect(prev).toBe(1000);
    expect(advanceSheetWatermark(k, 1500)).toBe(2000);   // older value never regresses it
    expect(sheetLastKnownUpdatedAt.get(k)).toBe(2000);
    rollbackSheetWatermark(k, 2000, prev);                // our failed write rolls back…
    expect(sheetLastKnownUpdatedAt.get(k)).toBe(1000);
    const prev2 = advanceSheetWatermark(k, 4000);
    advanceSheetWatermark(k, 5000);
    rollbackSheetWatermark(k, 4000, prev2);               // …but never past a newer superseding value
    expect(sheetLastKnownUpdatedAt.get(k)).toBe(5000);
  });

  it('is isolated per (user, sheet) key', () => {
    advanceSheetWatermark('user-f/sheet-1', 9000);
    expect(sheetLastKnownUpdatedAt.get('user-f/sheet-2') ?? 0).toBe(0);
  });
});

describe('normalizeRow — legacy sheet rows must load into the four-field shape', () => {
  it('returns null for non-object input', () => {
    expect(normalizeRow(null)).toBeNull();
    expect(normalizeRow(undefined)).toBeNull();
    expect(normalizeRow('row')).toBeNull();
    expect(normalizeRow(7)).toBeNull();
  });

  it('returns null for a missing, non-string, or EMPTY id (stricter than normalizeReel)', () => {
    expect(normalizeRow({})).toBeNull();
    expect(normalizeRow({ id: 3 })).toBeNull();
    expect(normalizeRow({ id: '', link: 'https://x' })).toBeNull();
  });

  it('drops the removed legacy `status` key and returns exactly the four fields', () => {
    expect(normalizeRow({ id: 'a', link: 'https://l', caption: 'c', description: 'd', status: 'posted' }))
      .toEqual({ id: 'a', link: 'https://l', caption: 'c', description: 'd' });
  });

  it('defaults missing or wrong-typed fields to empty strings', () => {
    expect(normalizeRow({ id: 'a' })).toEqual({ id: 'a', link: '', caption: '', description: '' });
    expect(normalizeRow({ id: 'a', link: 9, caption: null, description: ['x'] }))
      .toEqual({ id: 'a', link: '', caption: '', description: '' });
  });
});

describe('makeSheetRow', () => {
  it('creates a blank row for the given id', () => {
    expect(makeSheetRow('row-1')).toEqual({ id: 'row-1', link: '', caption: '', description: '' });
  });
});

describe('DEFAULT_TAB', () => {
  it('pins the DB column defaults — a pre-tabs client writing {user_id, rows} must land on this exact row', () => {
    expect(DEFAULT_TAB).toEqual({ sheetId: 'sheet-1', name: 'Sheet 1', position: 0 });
  });
});

describe('warmSheetRows — lazy-builder dispatch + cache-fill semantics', () => {
  // Distinct userIds per test: the module cache is shared across tests in this file (deliberately —
  // that per-module-instance persistence is exactly what the last test characterizes).

  it('DISPATCHES the SELECT (.then is the send) with the right table, columns and filters', async () => {
    h.state.result = { data: { rows: [{ id: 'row-1', link: 'https://x' }] }, error: null };
    warmSheetRows('u-dispatch', 'sheet-1');

    const call = h.state.calls.at(-1)!;
    expect(call.table).toBe('reel_sheets');
    expect(call.select).toBe('rows, updated_at');   // updated_at seeds the ordering watermark
    expect(call.filters).toEqual([['user_id', 'u-dispatch'], ['sheet_id', 'sheet-1']]);
    expect(call.maybeSingle).toBe(true);
    // The load-bearing bit: without .then() the builder is inert and nothing ever reaches the DB.
    expect(call.dispatched).toBe(true);
    await settle();
  });

  it('a successful load fills the cache: warming the same sheet again does not re-fetch', async () => {
    h.state.result = { data: { rows: [{ id: 'r1' }] }, error: null };
    warmSheetRows('u-cache', 'sheet-1');
    await settle();

    const n = h.state.calls.length;
    warmSheetRows('u-cache', 'sheet-1');
    expect(h.state.calls.length).toBe(n); // cache hit → no new builder, no new request
  });

  it('a FAILED load is NOT cached: the next warm re-fetches (a failed load must never read as an empty sheet)', async () => {
    // This is the sheet-side sibling of the failed-load grid wipe: caching an error as [] would
    // make the first edit autosave a starter row over the user's whole persisted backlog.
    h.state.result = { data: null, error: { message: 'transient blip' } };
    warmSheetRows('u-err', 'sheet-1');
    await settle();

    const n = h.state.calls.length;
    h.state.result = { data: { rows: [] }, error: null };
    warmSheetRows('u-err', 'sheet-1');
    expect(h.state.calls.length).toBe(n + 1); // error was not cached → fetches again
    await settle();
  });

  it('a MISSING row (new user, no error) IS cached as genuinely empty — distinct from the error case', async () => {
    h.state.result = { data: null, error: null };
    warmSheetRows('u-new', 'sheet-1');
    await settle();

    const n = h.state.calls.length;
    warmSheetRows('u-new', 'sheet-1');
    expect(h.state.calls.length).toBe(n); // [] is a legitimate answer here, so it is cached
  });

  it('characterization: the cache is per module instance (per browser tab) — a fresh instance re-fetches', async () => {
    // Same staleness that produced the multi-tab clobber on the reels grid: each tab's module
    // instance trusts its own cache over the DB. Pinned deliberately; a Realtime cross-tab
    // invalidation fix is planned — update this test on purpose when it lands.
    h.state.result = { data: { rows: [{ id: 'r1' }] }, error: null };
    warmSheetRows('u-iso', 'sheet-1');
    await settle();

    vi.resetModules();
    const fresh = await import('./useReelSheet');

    const n = h.state.calls.length;
    fresh.warmSheetRows('u-iso', 'sheet-1');
    expect(h.state.calls.length).toBe(n + 1); // fresh instance: cold cache → fetches again
    await settle();

    const n2 = h.state.calls.length;
    warmSheetRows('u-iso', 'sheet-1'); // original instance still trusts its own copy
    expect(h.state.calls.length).toBe(n2);
  });
});
