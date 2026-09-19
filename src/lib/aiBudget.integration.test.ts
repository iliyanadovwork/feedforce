import { describe, it, expect, beforeEach, vi } from 'vitest';

// Integration coverage for the cycle-anchored budget WITHOUT a real DB: a small in-memory FAKE of the
// service-role client models the `subscriptions` and `ai_usage` tables plus the additive `ai_usage_add`
// RPC (matching supabase/ai_usage.sql's `spent_micros = spent_micros + excluded`). The REAL
// resolvePeriod / getSpentMicros / recordAiSpend / hasAiBudget run their actual query-building and
// key derivation against it, so the whole glue — including the renewal → fresh-bucket fix — is
// exercised deterministically in CI. rowGrantsAccess (serverAuth) stays real.
//
// The one thing a fake cannot prove is that the live Postgres RPC accepts a 'YYYY-MM-DD' text key;
// `period` is an unconstrained `text` column, so that is a real-DB-only smoke check, called out in the
// PR notes, not something a unit test can cover.

type SubRow = { user_id: string; status: string; renews_at: string | null; ends_at: string | null; created_at?: string | null };
type UsageRow = { user_id: string; period: string; spent_micros: number; calls: number };

class Store {
  subs: SubRow[] = [];
  usage = new Map<string, UsageRow>();
  static k(u: string, p: string) { return `${u}::${p}`; }
}

const { store } = vi.hoisted(() => ({ store: { current: null as unknown } }));

// Thenable query builder: supports .select().eq()[.eq()][.order()][.maybeSingle()] and `await`.
// .order() actually SORTS (not a no-op) so a sort-dependent regression in resolvePeriod is catchable.
class Query {
  private filters: Array<[string, unknown]> = [];
  private sorts: Array<{ col: string; asc: boolean }> = [];   // chained .order() → multi-key sort
  constructor(private s: Store, private table: string) {}
  select() { return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.sorts.push({ col, asc: opts?.ascending !== false }); return this; }
  eq(col: string, val: unknown) { this.filters.push([col, val]); return this; }
  private rows(): Array<Record<string, unknown>> {
    const src = this.table === 'subscriptions' ? this.s.subs : [...this.s.usage.values()];
    let out = (src as Array<Record<string, unknown>>).filter(r => this.filters.every(([c, v]) => r[c] === v));
    if (this.sorts.length) {
      out = [...out].sort((a, b) => {
        for (const { col, asc } of this.sorts) {
          const av = a[col] as string | undefined, bv = b[col] as string | undefined;
          if (av === bv) continue;
          if (av === undefined) return 1;
          if (bv === undefined) return -1;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
    }
    return out;
  }
  async maybeSingle() { return { data: this.rows()[0] ?? null, error: null }; }
  then(resolve: (v: { data: Array<Record<string, unknown>>; error: null }) => void) {
    resolve({ data: this.rows(), error: null });
  }
}

function makeClient(s: Store) {
  return {
    from: (table: string) => new Query(s, table),
    rpc: async (name: string, args: { p_user: string; p_period: string; p_micros: number }) => {
      if (name !== 'ai_usage_add') return { data: null, error: { message: `unexpected rpc ${name}` } };
      const k = Store.k(args.p_user, args.p_period);
      const row = s.usage.get(k);
      if (row) { row.spent_micros += args.p_micros; row.calls += 1; }
      else s.usage.set(k, { user_id: args.p_user, period: args.p_period, spent_micros: args.p_micros, calls: 1 });
      return { data: s.usage.get(k)!.spent_micros, error: null };
    },
  };
}

vi.mock('./supabaseAdmin', () => ({ supabaseAdmin: () => makeClient((store as { current: Store }).current) }));

import { resolvePeriod, getSpentMicros, recordAiSpend, hasAiBudget, currentPeriod, MONTHLY_BUDGET_MICROS } from './aiBudget';

let db: Store;
beforeEach(() => {
  db = new Store();
  (store as { current: Store }).current = db;
});

describe('cycle-anchored budget end-to-end (in-memory fake client)', () => {
  it('bills to the renewal-anchored bucket, and a RENEWAL opens a fresh full bucket (the fix)', async () => {
    db.subs = [{ user_id: 'u1', status: 'active', renews_at: '2026-08-20T09:30:00.000Z', ends_at: null }];

    const p1 = await resolvePeriod('u1');
    expect(p1.key).toBe('2026-08-20');
    expect(p1.resetsAt.toISOString()).toBe('2026-08-20T09:30:00.000Z');

    await recordAiSpend('u1', 123_456);
    expect(await getSpentMicros('u1')).toBe(123_456);
    expect(await hasAiBudget('u1')).toBe(true);

    // Exhaust the bucket → gate closes.
    await recordAiSpend('u1', MONTHLY_BUDGET_MICROS);
    expect(await getSpentMicros('u1')).toBe(123_456 + MONTHLY_BUDGET_MICROS);
    expect(await hasAiBudget('u1')).toBe(false);

    // RENEWAL: provider advances renews_at → new key → fresh bucket at 0, budget restored.
    db.subs[0].renews_at = '2026-09-20T09:30:00.000Z';
    const p2 = await resolvePeriod('u1');
    expect(p2.key).toBe('2026-09-20');
    expect(await getSpentMicros('u1')).toBe(0);
    expect(await hasAiBudget('u1')).toBe(true);

    // The exhausted prior bucket persists untouched; the new period simply has no row yet.
    expect(db.usage.get(Store.k('u1', '2026-08-20'))?.spent_micros).toBe(123_456 + MONTHLY_BUDGET_MICROS);
    expect(db.usage.has(Store.k('u1', '2026-09-20'))).toBe(false);
  });

  it('a user with NO subscription bills to the calendar-month fallback bucket', async () => {
    db.subs = [];
    const p = await resolvePeriod('u2');
    expect(p.key).toBe(currentPeriod());

    await recordAiSpend('u2', 500);
    expect(await getSpentMicros('u2')).toBe(500);
    expect(db.usage.get(Store.k('u2', currentPeriod()))?.spent_micros).toBe(500);
  });

  it('a cancelled-but-in-window row anchors to ends_at', async () => {
    db.subs = [{ user_id: 'u3', status: 'cancelled', renews_at: null, ends_at: '2999-01-15T00:00:00.000Z' }];
    expect((await resolvePeriod('u3')).key).toBe('2999-01-15');
  });

  it('picks the granting row when a lapsed row co-exists, and gate math holds at the boundary', async () => {
    db.subs = [
      { user_id: 'u4', status: 'expired', renews_at: null, ends_at: '2020-01-01T00:00:00.000Z' },
      { user_id: 'u4', status: 'active', renews_at: '2026-08-20T09:30:00.000Z', ends_at: null },
    ];
    const { key } = await resolvePeriod('u4');
    expect(key).toBe('2026-08-20');

    // Spend to exactly the budget → gate closes (predicate is spent < budget).
    await recordAiSpend('u4', MONTHLY_BUDGET_MICROS);
    expect(await getSpentMicros('u4', key)).toBe(MONTHLY_BUDGET_MICROS);
    expect(await hasAiBudget('u4')).toBe(false);
  });

  it('meter-route call pattern: resolvePeriod then getSpentMicros(key) reads the same bucket', async () => {
    db.subs = [{ user_id: 'u5', status: 'active', renews_at: '2026-08-20T09:30:00.000Z', ends_at: null }];
    db.usage.set(Store.k('u5', '2026-08-20'), { user_id: 'u5', period: '2026-08-20', spent_micros: 999, calls: 3 });
    const { key, resetsAt } = await resolvePeriod('u5');
    expect(await getSpentMicros('u5', key)).toBe(999);
    expect(resetsAt.toISOString()).toBe('2026-08-20T09:30:00.000Z');
  });

  it('with multiple granting rows, anchors to the latest-CREATED one (created_at, not renews_at, drives it), order-independent', async () => {
    // Two active rows (e.g. a cross-provider Stripe+Lemon overlap). The columns are DECOUPLED on
    // purpose: the later-CREATED row (B) has the EARLIER renews_at. resolvePeriod must key on B
    // (created_at desc) → '2026-08-20'; a regression sorting by renews_at desc would pick A →
    // '2026-09-15' and fail. This also matches the admin overview's latest-created-granting rule.
    db.subs = [
      { user_id: 'u6', status: 'active', renews_at: '2026-09-15T00:00:00.000Z', ends_at: null, created_at: '2026-01-01T00:00:00.000Z' }, // A: created first, renews later
      { user_id: 'u6', status: 'active', renews_at: '2026-08-20T00:00:00.000Z', ends_at: null, created_at: '2026-06-01T00:00:00.000Z' }, // B: created later, renews earlier
    ];
    expect((await resolvePeriod('u6')).key).toBe('2026-08-20');
    db.subs.reverse();   // flip physical order — the answer must not change
    expect((await resolvePeriod('u6')).key).toBe('2026-08-20');
  });

  it('honors an explicitly threaded period key end to end (the resolve-once funnel path)', async () => {
    db.subs = [{ user_id: 'u7', status: 'active', renews_at: '2026-08-20T09:30:00.000Z', ends_at: null }];
    // Pass a key that is NOT the resolved one, to prove write and read both use the threaded key verbatim
    // (this is how gemini.ts bills exactly the bucket its gate was checked against).
    await recordAiSpend('u7', 700, '2026-12-31');
    expect(db.usage.get(Store.k('u7', '2026-12-31'))?.spent_micros).toBe(700);
    expect(await getSpentMicros('u7', '2026-12-31')).toBe(700);
    expect(await hasAiBudget('u7', '2026-12-31')).toBe(true);
    expect(db.usage.has(Store.k('u7', '2026-08-20'))).toBe(false);   // the resolved bucket was never touched
  });
});
