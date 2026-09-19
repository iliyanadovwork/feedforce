import { describe, it, expect, vi } from 'vitest';

// GAP 2 — reel persistence data-loss semantics, module-level parts only. The hook body itself
// (loadError gating of autosave, retry backoff, unmount/pagehide flush) needs a DOM renderer and
// is out of scope for the node test env.
//
// Two real data-loss incidents live in this module's blast radius:
//  1. failed-load grid wipe — a transient SELECT error used to read as an empty grid and the next
//     autosave persisted the emptiness (now guarded by loadError inside the hook);
//  2. multi-tab delete clobber — per-tab module caches going stale against each other (see the
//     characterization test at the bottom).

// The hook module imports the shared supabase client at module scope — stub it so importing (and
// re-importing in the cache-isolation test) never constructs a real client.
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }));

import {
  normalizeReel, reelCache, rememberWrite, forgetWrite, isOwnRecentWrite, RECENT_WRITES_CAP,
  lastKnownUpdatedAt, advanceWatermark, rollbackWatermark, parseUpdatedAt, adoptOrdering,
  reconcileDue, RECONCILE_THROTTLE_MS, keepAdoptedOverLoaded, resubscribeDelayMs,
} from './useReelPersistence';

describe('normalizeReel — legacy jsonb rows must load into a safe shape', () => {
  it('returns null for non-object input (corrupt jsonb entries are dropped, not crashed on)', () => {
    expect(normalizeReel(null)).toBeNull();
    expect(normalizeReel(undefined)).toBeNull();
    expect(normalizeReel('reel')).toBeNull();
    expect(normalizeReel(42)).toBeNull();
    expect(normalizeReel(true)).toBeNull();
  });

  it('returns null when id is missing or not a string', () => {
    expect(normalizeReel({})).toBeNull();
    expect(normalizeReel({ id: 7 })).toBeNull();
    expect(normalizeReel({ id: null, url: 'https://x' })).toBeNull();
    // Arrays are typeof 'object' but have no string id — dropped, not exploded field-by-index.
    expect(normalizeReel(['r1'])).toBeNull();
  });

  it('fills every missing field on a legacy pre-name row with safe defaults (exact shape)', () => {
    expect(normalizeReel({ id: 'r1', url: 'https://t.co/x', caption: 'hi' })).toEqual({
      id: 'r1',
      name: '',            // rows saved before names existed → unnamed
      mode: 'twitter',
      url: 'https://t.co/x',
      videoUrl: '',        // pre-storage rows: link is re-fetched on load
      posterUrl: '',
      caption: 'hi',
      description: '',     // rows saved before descriptions existed → empty
      templateId: null,
      framing: {},
      stickerEnabled: false,   // rows saved before the rewards sticker existed → off
    });
  });

  it('defaults description to "" for a legacy row that has none', () => {
    // A row persisted before the DESCRIPTION field existed loads with an empty description, never undefined.
    expect(normalizeReel({ id: 'r1', caption: 'hi' })?.description).toBe('');
  });

  it('preserves a provided string description', () => {
    expect(normalizeReel({ id: 'r1', description: 'Becomes the IG caption' })?.description).toBe('Becomes the IG caption');
  });

  it('coerces mode: only the literal "caption" survives, everything else → "twitter"', () => {
    expect(normalizeReel({ id: 'r', mode: 'caption' })?.mode).toBe('caption');
    expect(normalizeReel({ id: 'r', mode: 'twitter' })?.mode).toBe('twitter');
    expect(normalizeReel({ id: 'r', mode: 'CAPTION' })?.mode).toBe('twitter');
    expect(normalizeReel({ id: 'r', mode: 3 })?.mode).toBe('twitter');
    expect(normalizeReel({ id: 'r' })?.mode).toBe('twitter');
  });

  it('replaces wrong-typed field values with defaults instead of leaking them through', () => {
    const out = normalizeReel({
      id: 'r', name: 9, url: {}, videoUrl: ['x'], posterUrl: null, caption: false, description: 5, templateId: 4, framing: 'zoomed', stickerEnabled: 'yes',
    });
    expect(out).toEqual({
      id: 'r', name: '', mode: 'twitter', url: '', videoUrl: '', posterUrl: '', caption: '',
      description: '', templateId: null, framing: {}, stickerEnabled: false,
    });
  });

  it('framing: non-object values collapse to {}, an object passes through by reference', () => {
    expect(normalizeReel({ id: 'r', framing: 0 })?.framing).toEqual({});
    expect(normalizeReel({ id: 'r', framing: null })?.framing).toEqual({});
    const framing = { zoom: 1.5, panX: 10 };
    expect(normalizeReel({ id: 'r', framing })?.framing).toBe(framing);
  });

  it('keeps a fully-populated row intact and drops unknown keys', () => {
    const full = {
      id: 'r9', name: 'Promo', mode: 'caption', url: 'https://x.com/s/1',
      videoUrl: 'https://cdn/post-videos/v.mp4', posterUrl: 'https://cdn/post-images/p.jpg',
      caption: 'cap', description: 'the IG caption', templateId: 'tpl-1', framing: { trimStart: 2 },
      stickerEnabled: true,
    };
    // e.g. a key from an abandoned schema iteration must not survive into the app model
    expect(normalizeReel({ ...full, legacyStatus: 'posted' })).toEqual(full);
  });

  it('characterization: an empty-string id is ACCEPTED (only non-strings are rejected) — the sheet normalizer is stricter', () => {
    expect(normalizeReel({ id: '' })?.id).toBe('');
  });

  // FeedForce rewards sticker flag: it gates a BAKED render (and the schedule request's rewards
  // recording), so anything but a literal saved `true` must read as off — never truthy-coerced.
  it('stickerEnabled defaults to false for rows saved before the field existed', () => {
    expect(normalizeReel({ id: 'r1' })?.stickerEnabled).toBe(false);
  });

  it('stickerEnabled: a saved true survives the round-trip', () => {
    expect(normalizeReel({ id: 'r1', stickerEnabled: true })?.stickerEnabled).toBe(true);
  });

  it('stickerEnabled: truthy garbage ("yes", 1, {}, "true") reads as false', () => {
    expect(normalizeReel({ id: 'r1', stickerEnabled: 'yes' })?.stickerEnabled).toBe(false);
    expect(normalizeReel({ id: 'r1', stickerEnabled: 1 })?.stickerEnabled).toBe(false);
    expect(normalizeReel({ id: 'r1', stickerEnabled: {} })?.stickerEnabled).toBe(false);
    expect(normalizeReel({ id: 'r1', stickerEnabled: 'true' })?.stickerEnabled).toBe(false);
    expect(normalizeReel({ id: 'r1', stickerEnabled: false })?.stickerEnabled).toBe(false);
    expect(normalizeReel({ id: 'r1', stickerEnabled: null })?.stickerEnabled).toBe(false);
  });
});

describe('own-echo recognition: the schedule round-trip data-loss fix', () => {
  // ROOT CAUSE this guards: postgres_changes echoes our OWN upserts back, and adopt() must recognise them.
  // The old code compared an echo against a SINGLE "last synced" baseline, which only ever equals the NEWEST
  // write. With several writes in flight, the echo of an EARLIER one looked foreign and was destructively
  // adopted, reverting the grid AND cancelling the pending description save (schedule then X then back wiped
  // every reel's description + reset the last reel). A bounded SET of recent writes recognises any of them.

  it('recognises an EARLIER in-flight write, not just the latest (the actual regression)', () => {
    const u = 'echo-user-1';
    rememberWrite(u, 'A');   // write #1 (e.g. a description save)
    rememberWrite(u, 'B');   // write #2 advances the baseline
    rememberWrite(u, 'C');   // write #3
    // The echo of write #1 still arrives; it MUST be seen as our own, or adopt() reverts to A's snapshot.
    expect(isOwnRecentWrite(u, 'A')).toBe(true);
    expect(isOwnRecentWrite(u, 'B')).toBe(true);
    expect(isOwnRecentWrite(u, 'C')).toBe(true);
    // A genuine foreign write (another tab) was never in OUR set → still adopted.
    expect(isOwnRecentWrite(u, 'FOREIGN')).toBe(false);
  });

  it('forgetWrite drops a failed/never-echoed write so it cannot suppress a later foreign match', () => {
    const u = 'echo-user-2';
    rememberWrite(u, 'X');
    expect(isOwnRecentWrite(u, 'X')).toBe(true);
    forgetWrite(u, 'X');   // a failed write never echoes, so it is dropped from the set (adopt no longer consumes on match)
    expect(isOwnRecentWrite(u, 'X')).toBe(false);
  });

  it('is isolated per user (a write by one user never suppresses another user’s foreign echo)', () => {
    rememberWrite('echo-user-3', 'SHARED');
    expect(isOwnRecentWrite('echo-user-3', 'SHARED')).toBe(true);
    expect(isOwnRecentWrite('echo-user-4', 'SHARED')).toBe(false);
  });

  it('evicts the OLDEST past the cap (bounded memory) while keeping recent writes recognisable', () => {
    const u = 'echo-user-5';
    for (let i = 0; i < RECENT_WRITES_CAP; i++) rememberWrite(u, `w${i}`);
    expect(isOwnRecentWrite(u, 'w0')).toBe(true);              // still within the window
    rememberWrite(u, 'overflow');                              // pushes past the cap → oldest (w0) evicted
    expect(isOwnRecentWrite(u, 'w0')).toBe(false);            // oldest gone
    expect(isOwnRecentWrite(u, `w${RECENT_WRITES_CAP - 1}`)).toBe(true);   // newest kept
    expect(isOwnRecentWrite(u, 'overflow')).toBe(true);
  });

  it('RE-remembering a json refreshes its recency so the current DB tip survives a write burst', () => {
    // Set.add of an existing member keeps its OLD insertion position; without delete-then-add, a Schedule
    // All burst evicted the CURRENT DB state from the window while stale entries survived (the second-wave
    // adopt data loss). Re-remembering must move the entry to the back of the eviction queue.
    const u = 'echo-user-6';
    for (let i = 0; i < RECENT_WRITES_CAP; i++) rememberWrite(u, `w${i}`);
    rememberWrite(u, 'w0');                                    // re-write of the oldest → back of the queue
    rememberWrite(u, 'burst-1');                               // evicts w1 (now the oldest), NOT w0
    rememberWrite(u, 'burst-2');                               // evicts w2
    expect(isOwnRecentWrite(u, 'w0')).toBe(true);              // refreshed entry survived the burst
    expect(isOwnRecentWrite(u, 'w1')).toBe(false);
    expect(isOwnRecentWrite(u, 'w2')).toBe(false);
  });
});

describe('ordering watermark: the stale-refetch adopt guard', () => {
  // ROOT CAUSE this guards: the focus/visibility refetch SELECTs committed DB state and adopt() used to
  // accept anything own-write memory could not recognise. That memory resets on page reload and is capped,
  // so a refetch returning committed-but-OLDER state (pre-reload, or racing an in-flight save) was adopted
  // destructively: edits and descriptions reverted with a phantom "updated in another tab" toast. adopt()
  // now requires STRICTLY newer `updated_at` than this watermark, which is seeded on load and advanced on
  // every write/adoption.

  it('advance is monotonic and returns the previous value for rollback', () => {
    const u = 'wm-user-1';
    expect(advanceWatermark(u, 1000)).toBe(0);       // first advance from unset
    expect(lastKnownUpdatedAt.get(u)).toBe(1000);
    expect(advanceWatermark(u, 2000)).toBe(1000);
    expect(advanceWatermark(u, 1500)).toBe(2000);    // OLDER value must not regress the watermark…
    expect(lastKnownUpdatedAt.get(u)).toBe(2000);    // …it stays at the newest
  });

  it('rollback restores the previous value only while OUR advance is still current', () => {
    const u = 'wm-user-2';
    advanceWatermark(u, 1000);
    const prev = advanceWatermark(u, 2000);          // our write W advances to 2000
    rollbackWatermark(u, 2000, prev);                // W failed → back to 1000
    expect(lastKnownUpdatedAt.get(u)).toBe(1000);
  });

  it('rollback is a no-op when a newer write superseded ours (never clobbers later progress)', () => {
    const u = 'wm-user-3';
    advanceWatermark(u, 1000);
    const prev = advanceWatermark(u, 2000);          // our write W
    advanceWatermark(u, 3000);                       // a newer write/adoption lands meanwhile
    rollbackWatermark(u, 2000, prev);                // W's late failure must NOT regress to 1000
    expect(lastKnownUpdatedAt.get(u)).toBe(3000);
  });

  it('adoptOrdering (the REAL guard adopt() calls): stale and equal refuse, newer adopts, unparseable cannot order', () => {
    // Exercises the actual exported function, not a re-implementation of the comparison: flipping the
    // strictly-newer `>` to `>=` (or dropping the guard) fails these assertions.
    expect(adoptOrdering(4000, 5000)).toBe('refuse');         // stale refetch → refused
    expect(adoptOrdering(5000, 5000)).toBe('refuse');         // same state re-delivered → refused
    expect(adoptOrdering(6000, 5000)).toBe('adoptable');      // genuine foreign newer write → adopted
    expect(adoptOrdering(0, 5000)).toBe('no-timestamp');      // unparseable → content-equality path only
    expect(adoptOrdering(1, 0)).toBe('adoptable');            // fresh watermark: anything parseable adopts
  });

  it('reconcileDue (the focus/visibility backstop throttle both hooks call): due on first call, throttled inside the window, due again at the boundary', () => {
    // Exercises the REAL predicate the reconcile closure uses, not a re-implementation: dropping the
    // throttle or flipping the comparison fails these.
    const t0 = 1_000_000;
    expect(reconcileDue(t0, 0)).toBe(true);                                  // never reconciled → due
    expect(reconcileDue(t0 + 1, t0)).toBe(false);                            // immediately after → throttled
    expect(reconcileDue(t0 + RECONCILE_THROTTLE_MS - 1, t0)).toBe(false);    // just inside the window
    expect(reconcileDue(t0 + RECONCILE_THROTTLE_MS, t0)).toBe(true);         // boundary → due again
  });

  it('keepAdoptedOverLoaded (the load-continuation decision both hooks call): stale loaded rows never clobber a newer adoption', () => {
    // A Realtime echo/reconcile adopting DURING the initial SELECT used to be silently overwritten by the
    // (older) load response, discarding a genuinely newer foreign write (confirmed in review). The load
    // must keep the adopted state whenever it is at least as new as the loaded row.
    expect(keepAdoptedOverLoaded(0, 5000)).toBe(false);      // nothing adopted → use the loaded rows
    expect(keepAdoptedOverLoaded(0, 0)).toBe(false);         // fresh empty state → use the (empty) load
    expect(keepAdoptedOverLoaded(6000, 5000)).toBe(true);    // adoption newer than the loaded row → keep it
    expect(keepAdoptedOverLoaded(5000, 5000)).toBe(true);    // same row adopted mid-load → keep (identical)
    expect(keepAdoptedOverLoaded(5000, 6000)).toBe(false);   // loaded row genuinely newer → use it
    expect(keepAdoptedOverLoaded(5000, 0)).toBe(true);       // adopted state exists, loaded row unparseable → keep
  });

  it('resubscribeDelayMs (the channel-recovery backoff): exponential from 1s, capped at 30s, no overflow', () => {
    // A dead Realtime channel (CHANNEL_ERROR/TIMED_OUT/CLOSED) resubscribes on this schedule; dropping the
    // cap would hammer the server on an outage, dropping the exponent would retry too aggressively.
    expect(resubscribeDelayMs(0)).toBe(1000);
    expect(resubscribeDelayMs(1)).toBe(2000);
    expect(resubscribeDelayMs(2)).toBe(4000);
    expect(resubscribeDelayMs(4)).toBe(16000);
    expect(resubscribeDelayMs(5)).toBe(30000);     // 32s capped to 30s
    expect(resubscribeDelayMs(50)).toBe(30000);    // exponent clamped, no Infinity/overflow
  });

  it('parseUpdatedAt handles both wire formats and fails to 0 (never a bogus epoch)', () => {
    const iso = parseUpdatedAt('2026-07-19T19:00:00.123+00:00');            // PostgREST ISO-T form
    expect(iso).toBeGreaterThan(0);
    // Realtime can deliver the Postgres TEXT form: space separator + offset without minutes. Safari's
    // spec-conformant Date.parse rejects it un-normalized; the helper must parse it to the SAME instant.
    expect(parseUpdatedAt('2026-07-19 19:00:00.123+00')).toBe(iso);
    expect(parseUpdatedAt('2026-07-19T19:00:00.123456+00:00')).toBe(iso);   // microseconds truncate to ms
    expect(parseUpdatedAt(undefined)).toBe(0);
    expect(parseUpdatedAt(null)).toBe(0);
    expect(parseUpdatedAt('')).toBe(0);
    expect(parseUpdatedAt('not a date')).toBe(0);
    expect(parseUpdatedAt(12345)).toBe(0);                                  // non-string wire junk
  });
});

describe('reelCache — per-module-instance cache (characterization)', () => {
  // Each browser tab evaluates this module once, so each tab has its OWN reelCache, and a remount
  // seeds from the cache instead of re-SELECTing. That means tab B keeps serving (and re-saving)
  // rows tab A already changed or deleted — the multi-tab delete clobber a live user hit. This
  // test pins the CURRENT semantics deliberately; a Realtime-based cross-tab invalidation fix is
  // planned, and when it lands this characterization should be updated on purpose, not by accident.
  it('two module instances have fully independent caches', async () => {
    const row = normalizeReel({ id: 'r1', caption: 'kept' });
    expect(row).not.toBeNull();
    reelCache.set('user-a', [row!]);

    vi.resetModules();
    const fresh = await import('./useReelPersistence');

    expect(fresh.reelCache).not.toBe(reelCache);
    expect(fresh.reelCache.has('user-a')).toBe(false); // a fresh tab knows nothing of this tab's state…
    expect(reelCache.get('user-a')).toEqual([row]);    // …and this tab still trusts its own copy

    reelCache.delete('user-a');
  });
});
