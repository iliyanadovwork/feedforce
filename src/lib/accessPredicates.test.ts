import { describe, it, expect, afterEach, vi } from 'vitest';
import { grantsAccess } from '@/app/hooks/useSubscription';
import { rowGrantsAccess } from '@/lib/serverAuth';

// Drift guard for the subscription-access predicate that exists in THREE synced places
// (CLAUDE.md billing invariant: "change all three or none"):
//   1. grantsAccess              — src/app/hooks/useSubscription.ts   (client)
//   2. rowGrantsAccess           — src/lib/serverAuth.ts              (server)
//   3. has_active_subscription() — supabase/free_tier.sql             (database)
//
// The SQL copy can't execute here, so its row predicate is HAND-ENCODED below as SQL_TRUTH,
// transcribed from supabase/free_tier.sql:
//
//       (s.ends_at is null or s.ends_at > now())
//   and ( s.status in ('active', 'on_trial')
//         or (s.status = 'cancelled' and s.ends_at is not null) )
//
// If free_tier.sql's predicate ever changes, SQL_TRUTH must be re-transcribed by hand from the
// new SQL — that manual step is the documented residual of this guard. Both TS predicates are
// asserted cell-by-cell against SQL_TRUTH AND against each other, so a 1-of-3 or 2-of-3 edit
// fails this test. It is deliberately a literal truth table, not a fourth implementation of the
// rule (which would agree with whatever bug all copies share).

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z'; // valid until the year 2999 without fake timers

// Expected access per (status, ends_at) cell:      [ends_at PAST, ends_at FUTURE, ends_at null]
const SQL_TRUTH: Record<string, [boolean, boolean, boolean]> = {
  active:             [false, true,  true ],
  on_trial:           [false, true,  true ],
  cancelled:          [false, true,  false], // grace access only until a SET paid-through date
  past_due:           [false, false, false],
  unpaid:             [false, false, false],
  paused:             [false, false, false],
  expired:            [false, false, false],
  // Raw Stripe vocabulary: access keys on the APP vocabulary above — STATUS_MAP in
  // api/billing/stripe-webhook/route.ts translates before rows are written. A raw status
  // reaching a predicate must NEVER grant; note especially canceled (US) ≠ cancelled (app).
  canceled:           [false, false, false],
  trialing:           [false, false, false],
  incomplete:         [false, false, false],
  incomplete_expired: [false, false, false],
  '':                 [false, false, false], // degenerate/unknown status fails closed
};

const CASES: { status: string; ends_at: string | null; endsAt: string; expected: boolean }[] =
  Object.entries(SQL_TRUTH).flatMap(([status, [past, future, none]]) => [
    { status, ends_at: PAST, endsAt: 'past', expected: past },
    { status, ends_at: FUTURE, endsAt: 'future', expected: future },
    { status, ends_at: null, endsAt: 'null', expected: none },
  ]);

describe('access-predicate trio (client / server / SQL) stays in sync', () => {
  it.each(CASES)(
    'status=$status ends_at=$endsAt → $expected in all three copies',
    ({ status, ends_at, expected }) => {
      const row = { status, ends_at };
      // TS-vs-TS: mechanically catches 2-of-3 drift between the client and server copies.
      expect(grantsAccess(row)).toBe(rowGrantsAccess(row));
      // Each TS copy vs the hand-encoded SQL truth table (catches TS-only edits).
      expect(grantsAccess(row)).toBe(expected);
      expect(rowGrantsAccess(row)).toBe(expected);
    },
  );

  it('no subscription row → no access in all three copies', () => {
    // SQL: exists() over zero rows is false. Client: grantsAccess(null) guards explicitly.
    expect(grantsAccess(null)).toBe(false);
    expect(grantsAccess(undefined as unknown as null)).toBe(false);
    // Server: rowGrantsAccess's type excludes null — production only ever applies it via
    // rows.some(...) (readGrantsAccess); .some over [] mirrors SQL's exists-over-zero-rows.
    expect(([] as { status: string; ends_at: string | null }[]).some(rowGrantsAccess)).toBe(false);
  });

  it('ANY granting row suffices (.some(...) in both TS call sites ≡ SQL exists())', () => {
    const lapsed = { status: 'expired', ends_at: PAST };
    const live = { status: 'active', ends_at: null };
    expect([lapsed, live].some(rowGrantsAccess)).toBe(true);
    expect([lapsed, live].some(grantsAccess)).toBe(true);
    expect([lapsed].some(rowGrantsAccess)).toBe(false);
    expect([lapsed].some(grantsAccess)).toBe(false);
  });

  describe('expiry boundary: ends_at == now denies in all three copies', () => {
    afterEach(() => vi.useRealTimers());

    // SQL uses strict `ends_at > now()`; TS uses `getTime() <= Date.now()` — at the exact
    // expiry instant, all three deny. One millisecond before expiry all three still grant.
    it.each(['active', 'on_trial', 'cancelled'])('status=%s', (status) => {
      vi.useFakeTimers();
      const now = new Date('2026-07-17T12:00:00.000Z');
      vi.setSystemTime(now);

      const atExpiry = { status, ends_at: now.toISOString() };
      expect(grantsAccess(atExpiry)).toBe(false);
      expect(rowGrantsAccess(atExpiry)).toBe(false);

      const justBeforeExpiry = { status, ends_at: new Date(now.getTime() + 1).toISOString() };
      expect(grantsAccess(justBeforeExpiry)).toBe(true);
      expect(rowGrantsAccess(justBeforeExpiry)).toBe(true);
    });
  });
});
