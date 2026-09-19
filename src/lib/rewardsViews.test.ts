import { describe, it, expect } from 'vitest';
import { indexAnalyticsViews, decidePostAction, buildSyncPatch } from './rewardsViews';

describe('indexAnalyticsViews', () => {
  it('indexes by latePostId, not just _id (the 2026-07-25 sync bug)', () => {
    // rewards_posts stores the latePostId; the analytics listing is keyed by _id. Matching only on
    // _id missed every tracked post → 0 views synced + false removals. Both ids must resolve.
    const m = indexAnalyticsViews([{ _id: 'zid1', latePostId: 'late1', analytics: { views: 12851 } }]);
    expect(m.get('late1')).toBe(12851);
    expect(m.get('zid1')).toBe(12851);
  });

  it('reads the REAL prod shape: post-level views is null, count under analytics.views', () => {
    const m = indexAnalyticsViews([{ _id: 'z', latePostId: 'l', views: null, analytics: { views: 1758712 } }]);
    expect(m.get('l')).toBe(1758712); // pins the `?? p.analytics?.views` fallback against a refactor
  });

  it('indexes by _id even when latePostId is absent', () => {
    const m = indexAnalyticsViews([{ _id: 'only-id', analytics: { views: 5 } }]);
    expect(m.get('only-id')).toBe(5);
  });

  it('skips posts with no numeric view count but keeps a real 0', () => {
    const m = indexAnalyticsViews([
      { latePostId: 'none' },                        // no views at all → not yet measured
      { latePostId: 'empty', analytics: {} },        // analytics present, views absent
      { latePostId: 'zero', views: 0 },              // 0 is a valid measured count
    ]);
    expect(m.has('none')).toBe(false);
    expect(m.has('empty')).toBe(false);
    expect(m.get('zero')).toBe(0);
  });

  it('records PRESENCE separately from measurement — an unmeasured post is present but not in views', () => {
    const present = new Set<string>();
    const m = indexAnalyticsViews(
      [{ _id: 'z', latePostId: 'fresh', views: null, analytics: {} }], // in the listing, no views yet
      undefined,
      present,
    );
    expect(m.has('fresh')).toBe(false);   // not measured
    expect(present.has('fresh')).toBe(true); // but definitively present (both ids)
    expect(present.has('z')).toBe(true);
  });

  it('accumulates views and presence across pages via the shared map/set', () => {
    const acc = new Map<string, number>();
    const present = new Set<string>();
    indexAnalyticsViews([{ latePostId: 'a', views: 1 }], acc, present);
    indexAnalyticsViews([{ latePostId: 'b', views: 2 }], acc, present);
    expect([...acc.entries()].sort()).toEqual([['a', 1], ['b', 2]]);
    expect([...present].sort()).toEqual(['a', 'b']);
  });
});

describe('decidePostAction', () => {
  const measuredOnce = { views_synced_at: '2026-07-25T00:00:00Z', removed_at: null };
  const neverSynced = { views_synced_at: null, removed_at: null };

  it("measured this run → 'sync' (regardless of prior state)", () => {
    expect(decidePostAction(neverSynced, { measured: true, present: true, allowRemoval: true })).toBe('sync');
    expect(decidePostAction({ views_synced_at: null, removed_at: 'x' }, { measured: true, present: true, allowRemoval: true })).toBe('sync');
  });

  it("present-but-unmeasured, currently removed → 'heal' (un-remove a live reel)", () => {
    expect(decidePostAction({ views_synced_at: null, removed_at: 'x' }, { measured: false, present: true, allowRemoval: true })).toBe('heal');
  });

  it("present-but-unmeasured, not removed → 'noop' (never remove a live reel)", () => {
    expect(decidePostAction(neverSynced, { measured: false, present: true, allowRemoval: true })).toBe('noop');
  });

  it("previously measured but STILL PRESENT this run (no fresh count) → 'noop', never 'remove' (presence guard)", () => {
    // The !present guard: a once-measured post that's in the listing but without a numeric count this
    // run must NOT be removed. Dropping !ctx.present would make this 'remove' (mutation catch).
    expect(decidePostAction(measuredOnce, { measured: false, present: true, allowRemoval: true })).toBe('noop');
  });

  it("previously measured, present again, currently removed → 'heal' (present ⇒ live)", () => {
    expect(decidePostAction({ views_synced_at: '2026-07-25T00:00:00Z', removed_at: 'x' }, { measured: false, present: true, allowRemoval: true })).toBe('heal');
  });

  it("NEVER-synced + absent + allowRemoval → 'noop', never 'remove' (too new to judge — the HIGH bug)", () => {
    // A brand-new reel not yet in the listing must NOT be false-removed.
    expect(decidePostAction(neverSynced, { measured: false, present: false, allowRemoval: true })).toBe('noop');
  });

  it("never-synced + absent + currently removed → 'heal' (it never met the removal bar)", () => {
    expect(decidePostAction({ views_synced_at: null, removed_at: 'x' }, { measured: false, present: false, allowRemoval: true })).toBe('heal');
  });

  it("previously measured + absent from a complete listing → 'remove' (genuinely deleted)", () => {
    expect(decidePostAction(measuredOnce, { measured: false, present: false, allowRemoval: true })).toBe('remove');
  });

  it("already-removed deleted post → 'noop' (don't re-stamp)", () => {
    expect(decidePostAction({ views_synced_at: '2026-07-25T00:00:00Z', removed_at: 'x' }, { measured: false, present: false, allowRemoval: true })).toBe('noop');
  });

  it("inconclusive listing (allowRemoval false): never removes, and does NOT resurrect a legit removal", () => {
    // never-removes a measured post while the listing can't be trusted
    expect(decidePostAction(measuredOnce, { measured: false, present: false, allowRemoval: false })).toBe('noop');
    // and does NOT heal a once-measured, genuinely-removed post — an inconclusive listing is not
    // evidence it's back (guards against resurrecting real deletions on soft-disconnect/partial pages)
    expect(decidePostAction({ views_synced_at: '2026-07-25T00:00:00Z', removed_at: 'x' }, { measured: false, present: false, allowRemoval: false })).toBe('noop');
    // but a NEVER-synced false-removal still heals even on an inconclusive run (goal #3: the 33 recover)
    expect(decidePostAction({ views_synced_at: null, removed_at: 'x' }, { measured: false, present: false, allowRemoval: false })).toBe('heal');
  });
});

describe('buildSyncPatch', () => {
  it('NEVER shrinks views_total — a Zernio blip returning fewer views cannot erase earned views', () => {
    expect(buildSyncPatch({ views_total: 1000, removed_at: null }, 400, 'T').views_total).toBe(1000); // lower fetch ignored
    expect(buildSyncPatch({ views_total: 1000, removed_at: null }, 1500, 'T').views_total).toBe(1500); // higher fetch taken
    expect(buildSyncPatch({ views_total: 0, removed_at: null }, 0, 'T').views_total).toBe(0);
  });

  it('stamps views_synced_at with the run time', () => {
    expect(buildSyncPatch({ views_total: 5, removed_at: null }, 9, 'NOW').views_synced_at).toBe('NOW');
  });

  it('lifts a stale removed_at when the post was removed (self-heal on measure — the 29 recover)', () => {
    const patch = buildSyncPatch({ views_total: 5, removed_at: '2026-07-25T00:00:00Z' }, 9, 'T');
    expect('removed_at' in patch).toBe(true);
    expect(patch.removed_at).toBeNull();
  });

  it('never-shrink STILL holds on the heal-lift path (recover a removed post reporting a LOWER live count)', () => {
    // guards against a mutation that sets views_total=fetched inside the removed_at branch, bypassing max
    const patch = buildSyncPatch({ views_total: 12851, removed_at: '2026-07-25T00:00:00Z' }, 900, 'T');
    expect(patch.views_total).toBe(12851);
    expect(patch.removed_at).toBeNull();
  });

  it('does NOT touch removed_at when the post was not removed (no needless write)', () => {
    expect('removed_at' in buildSyncPatch({ views_total: 5, removed_at: null }, 9, 'T')).toBe(false);
  });
});
