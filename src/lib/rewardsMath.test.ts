import { describe, it, expect } from 'vitest';
import {
  postMonthContribution,
  rankStandings,
  distributePool,
  planFinalizeWrites,
  bucketRevenueByMonth,
  monthlyRevenueCents,
  REWARDS_MIN_REEL_VIEWS,
} from './rewardsMath';

describe('postMonthContribution (per-reel 10k rule)', () => {
  it('contributes nothing while the reel is under 10k lifetime views', () => {
    expect(postMonthContribution({ startViews: 0, endViews: 9_999 })).toBe(0);
    expect(postMonthContribution({ startViews: 4_000, endViews: 8_000 })).toBe(0);
  });

  it('counts ALL views to date in the month the reel crosses 10k', () => {
    expect(postMonthContribution({ startViews: 6_000, endViews: 12_000 })).toBe(12_000);
    expect(postMonthContribution({ startViews: 0, endViews: REWARDS_MIN_REEL_VIEWS })).toBe(REWARDS_MIN_REEL_VIEWS);
  });

  it('counts only the monthly gain once already past 10k', () => {
    expect(postMonthContribution({ startViews: 15_000, endViews: 18_500 })).toBe(3_500);
    expect(postMonthContribution({ startViews: 15_000, endViews: 15_000 })).toBe(0);
  });

  it('never goes negative on an upstream views regression', () => {
    expect(postMonthContribution({ startViews: 20_000, endViews: 19_000 })).toBe(0);
  });
});

describe('rankStandings', () => {
  it('sorts by views desc, drops zero-view users, tie-breaks by userId', () => {
    const ranked = rankStandings([
      { userId: 'c', views: 50 },
      { userId: 'b', views: 100 },
      { userId: 'z', views: 0 },
      { userId: 'a', views: 100 },
    ]);
    expect(ranked.map((e) => e.userId)).toEqual(['a', 'b', 'c']);
  });
});

describe('distributePool', () => {
  it('gives a lone qualified creator the entire pool', () => {
    const [only] = distributePool(10_000, [{ userId: 'a', views: 12_000 }]);
    expect(only.tier).toBe('top');
    expect(only.amountCents).toBe(10_000);
  });

  it('empty leaderboard distributes nothing', () => {
    expect(distributePool(10_000, [])).toEqual([]);
  });

  it('splits the whole pool proportional to views', () => {
    const out = distributePool(100_000, [
      { userId: 'a', views: 40_000 },
      { userId: 'b', views: 30_000 },
      { userId: 'c', views: 20_000 },
      { userId: 'd', views: 10_000 },
    ]);
    expect(out.map((e) => e.amountCents)).toEqual([40_000, 30_000, 20_000, 10_000]);
  });

  it('has NO discontinuity at ANY creator count — identical views always earn identical pay', () => {
    // Regression guard. The old top-20%/80% tiering paid 80%/5%/5%/5%/5% at n=5: a 16x gap between
    // creators with the SAME views, decided by the userId tie-break, and an ~80% pay cut for ranks
    // 2-5 caused purely by a 5th creator joining. Swept across a WIDE n range on purpose — sampling
    // only a few n let a mutant that reintroduced tiering at a different threshold slip through.
    const equal = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, views: 10_000 }));
    for (let n = 2; n <= 40; n++) {
      const out = distributePool(100_000, equal(n));
      expect(out.every((e) => e.amountCents === Math.floor(100_000 / n))).toBe(true);
      expect(out.every((e) => e.tier === 'top')).toBe(true); // one undifferentiated group, always
    }
  });

  it('pays zero (not NaN) when the board has no views at all', () => {
    // Guards the totalViews > 0 branch: without it every amountCents is NaN, which JSON-serialises to
    // null and blows up the not-null amount_cents column at finalize.
    const out = distributePool(10_000, [{ userId: 'a', views: 0 }, { userId: 'b', views: 0 }]);
    expect(out.map((e) => e.amountCents)).toEqual([0, 0]);
    expect(out.every((e) => Number.isFinite(e.amountCents))).toBe(true);
  });

  it('sanitises hostile inputs rather than over-paying', () => {
    // A negative views value used to make the shares sum to MORE than the pool while paying its own
    // holder a negative amount; a NaN pool propagated into every amount.
    const neg = distributePool(1_499, [{ userId: 'a', views: 100 }, { userId: 'b', views: -50 }]);
    expect(neg.reduce((s, e) => s + e.amountCents, 0)).toBeLessThanOrEqual(1_499);
    expect(neg.every((e) => e.amountCents >= 0)).toBe(true);
    expect(distributePool(NaN, [{ userId: 'a', views: 100 }]).every((e) => e.amountCents === 0)).toBe(true);
    expect(distributePool(Infinity, [{ userId: 'a', views: 100 }]).every((e) => Number.isFinite(e.amountCents))).toBe(true);
  });

  it('property: pool invariants hold across 2,000 randomised boards', () => {
    // Seeded LCG so the sweep is deterministic (no Math.random in tests).
    let s = 42 >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let t = 0; t < 2_000; t++) {
      const n = 1 + Math.floor(rnd() * 30);
      const pool = Math.floor(rnd() * 200_000);
      const ranked = rankStandings(
        Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, views: 1 + Math.floor(rnd() * 1_000_000) })),
      );
      const out = distributePool(pool, ranked);
      const total = out.reduce((acc, e) => acc + e.amountCents, 0);
      expect(total).toBeLessThanOrEqual(pool);                  // never over-pay the pool
      expect(total).toBeGreaterThanOrEqual(pool - out.length);  // …and never strand more than n-1 cents
      expect(out.every((e) => e.amountCents >= 0 && Number.isInteger(e.amountCents))).toBe(true);
      for (let i = 1; i < out.length; i++) {
        // ranked desc by views ⇒ more views must never earn less money
        expect(out[i].amountCents).toBeLessThanOrEqual(out[i - 1].amountCents);
      }
    }
  });

  it('every payout share equals that creator’s view share', () => {
    const ranked = rankStandings([
      { userId: 'a', views: 300_000 },
      { userId: 'b', views: 100_000 },
      { userId: 'c', views: 50_000 },
      { userId: 'd', views: 50_000 },
    ]);
    const out = distributePool(100_000, ranked);
    const totalViews = ranked.reduce((s, e) => s + e.views, 0);
    for (const e of out) {
      expect(e.amountCents).toBe(Math.floor((100_000 * e.views) / totalViews));
    }
    const byId = Object.fromEntries(out.map((e) => [e.userId, e]));
    expect(byId.c.amountCents).toBe(byId.d.amountCents); // tie is money-neutral
    expect(byId.a.rank).toBe(1);
    expect(byId.d.rank).toBe(4);
  });

  it('rank is display-only and never changes the money', () => {
    const out = distributePool(100_000, [
      { userId: 'a', views: 10_000 },
      { userId: 'b', views: 10_000 },
    ]);
    expect(out.map((e) => e.rank)).toEqual([1, 2]);
    expect(out[0].amountCents).toBe(out[1].amountCents);
  });

  it('never distributes more than the pool (rounding dust stays in-house)', () => {
    const ranked = rankStandings(
      Array.from({ length: 13 }, (_, i) => ({ userId: `u${i}`, views: 10_000 + i * 7_777 })),
    );
    const out = distributePool(99_999, ranked);
    const total = out.reduce((s, e) => s + e.amountCents, 0);
    expect(total).toBeLessThanOrEqual(99_999);
  });

  it('zero pool pays zero to everyone', () => {
    const out = distributePool(0, [
      { userId: 'a', views: 50_000 },
      { userId: 'b', views: 20_000 },
    ]);
    expect(out.every((e) => e.amountCents === 0)).toBe(true);
  });
});

describe('revenue bucketing', () => {
  const invoices = [
    { amount_paid: 2900, status_transitions: { paid_at: Date.UTC(2026, 6, 3) / 1000 } },
    { amount_paid: 2900, status_transitions: { paid_at: Date.UTC(2026, 6, 20) / 1000 } },
    { amount_paid: 2900, created: Date.UTC(2026, 5, 15) / 1000 }, // falls back to created
    { amount_paid: 1000, status_transitions: {} }, // no timestamp → skipped
  ];

  it('buckets by paid_at (falling back to created) into YYYY-MM keys', () => {
    const byMonth = bucketRevenueByMonth(invoices);
    expect(byMonth.get('2026-07')).toBe(5800);
    expect(byMonth.get('2026-06')).toBe(2900);
  });

  it('monthlyRevenueCents returns 0 for a month with no invoices', () => {
    expect(monthlyRevenueCents(invoices, '2026-01')).toBe(0);
    expect(monthlyRevenueCents(invoices, '2026-07')).toBe(5800);
  });
});

describe('planFinalizeWrites (re-finalize safety)', () => {
  const standings = [
    { userId: 'a', views: 60_000 },
    { userId: 'b', views: 40_000 },
  ];

  it('first finalize pays the whole pool proportionally', () => {
    const { toWrite, paidCents, remainingCents } = planFinalizeWrites(1_000, standings, []);
    expect(paidCents).toBe(0);
    expect(remainingCents).toBe(1_000);
    expect(toWrite.map((s) => [s.userId, s.amountCents])).toEqual([['a', 600], ['b', 400]]);
  });

  it('a re-finalize never re-spends money already paid', () => {
    // 'a' was paid 600 of the 1000 pool; only the remaining 400 is available for 'b'.
    const { toWrite, paidCents, remainingCents } = planFinalizeWrites(1_000, standings, [
      { user_id: 'a', amount_cents: 600, paid_at: '2026-08-02T00:00:00Z' },
    ]);
    expect(paidCents).toBe(600);
    expect(remainingCents).toBe(400);
    expect(toWrite.map((s) => [s.userId, s.amountCents])).toEqual([['b', 400]]);
    expect(paidCents + toWrite.reduce((s, e) => s + e.amountCents, 0)).toBeLessThanOrEqual(1_000);
  });

  it('the over-pay case: a new creator qualifies after the pool was fully paid out', () => {
    // The bug this guards: 'a' took the whole $20 pool and was paid; 'b' then qualifies. Paying 'b'
    // a fresh full-pool share would put the month's obligations above the pool.
    const { toWrite, remainingCents } = planFinalizeWrites(2_000, [
      { userId: 'a', views: 100_000 },
      { userId: 'b', views: 50_000 },
    ], [{ user_id: 'a', amount_cents: 2_000, paid_at: '2026-08-02T00:00:00Z' }]);
    expect(remainingCents).toBe(0);
    expect(toWrite).toEqual([]);
  });

  it('never exceeds the pool even when the pool SHRANK after a payment', () => {
    // e.g. a refund lands and the recomputed pool is smaller than what was already sent.
    const { toWrite, paidCents } = planFinalizeWrites(1_500, standings, [
      { user_id: 'a', amount_cents: 2_000, paid_at: '2026-08-02T00:00:00Z' },
    ]);
    expect(toWrite).toEqual([]); // can't un-pay 'a', but never ADD to the overspend
    expect(paidCents).toBe(2_000);
  });

  it('drops zero-cent shares instead of writing a "pay $0.00" row', () => {
    const { toWrite } = planFinalizeWrites(1_499, [
      { userId: 'whale', views: 15_000_000 },
      { userId: 'small', views: 10_000 }, // share floors to 0 cents
    ], []);
    expect(toWrite.map((s) => s.userId)).toEqual(['whale']);
  });

  it('carries non-view fields (paypal snapshot) through untouched', () => {
    const { toWrite } = planFinalizeWrites(1_000, [
      { userId: 'a', views: 10_000, paypalEmail: 'a@x.com' },
    ], []);
    expect(toWrite[0]).toMatchObject({ userId: 'a', paypalEmail: 'a@x.com', amountCents: 1_000 });
  });

  it('caps a write at the full-pool share when the board drifts between finalizes', () => {
    // Regression: redistributing only the remainder let a survivor take the whole leftover. Pool $10,
    // board b=990k/a=10k pays b $9.90 / a $0.10; admin pays a; b's reel is then removed so the board
    // is 10k/10k. Uncapped, b was written the full $9.90 remainder against a $5.00 entitlement (~2x),
    // decided purely by which row was marked paid first.
    const drifted = [
      { userId: 'a', views: 10_000 },
      { userId: 'b', views: 10_000 },
    ];
    const { toWrite } = planFinalizeWrites(1_000, drifted, [
      { user_id: 'a', amount_cents: 10, paid_at: '2026-08-02T00:00:00Z' },
    ]);
    expect(toWrite.map((s) => [s.userId, s.amountCents])).toEqual([['b', 500]]);
  });

  it('property: nobody is ever written more than their full-pool share', () => {
    let s = 99 >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let t = 0; t < 1_000; t++) {
      const pool = 1 + Math.floor(rnd() * 50_000);
      const n = 1 + Math.floor(rnd() * 8);
      const board = rankStandings(
        Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, views: 1 + Math.floor(rnd() * 500_000) })),
      );
      const existing = board
        .filter(() => rnd() < 0.4)
        .map((e) => ({ user_id: e.userId, amount_cents: Math.floor(rnd() * pool), paid_at: rnd() < 0.7 ? 'x' : null }));
      const entitled = new Map(distributePool(pool, board).map((r) => [r.userId, r.amountCents]));
      for (const w of planFinalizeWrites(pool, board, existing).toWrite) {
        expect(w.amountCents).toBeLessThanOrEqual(entitled.get(w.userId) ?? 0);
      }
    }
  });

  it('property: paid + written never exceeds the pool, across randomised ledgers', () => {
    let s = 7 >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let t = 0; t < 1_000; t++) {
      const pool = Math.floor(rnd() * 50_000);
      const n = 1 + Math.floor(rnd() * 8);
      const board = rankStandings(
        Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, views: 1 + Math.floor(rnd() * 500_000) })),
      );
      const existing = board
        .filter(() => rnd() < 0.4)
        .map((e) => ({ user_id: e.userId, amount_cents: Math.floor(rnd() * pool), paid_at: rnd() < 0.7 ? 'x' : null }));
      const { toWrite, paidCents } = planFinalizeWrites(pool, board, existing);
      const written = toWrite.reduce((acc, e) => acc + e.amountCents, 0);
      expect(paidCents + written).toBeLessThanOrEqual(Math.max(pool, paidCents));
      expect(toWrite.every((e) => e.amountCents > 0)).toBe(true);
    }
  });
});
