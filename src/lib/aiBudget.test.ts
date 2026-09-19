import { describe, it, expect, vi } from 'vitest';

// resolvePeriod reads the subscription with the service-role client; mock it so we can drive the
// granting-row selection and, critically, the fail-safe fallback. rowGrantsAccess (from serverAuth)
// stays REAL so these tests also guard the real predicate.
// resolvePeriod chains .select().eq().order('created_at').order('id') then awaits; the awaited result
// is the SECOND .order() call.
const { orderMock } = vi.hoisted(() => ({ orderMock: vi.fn() }));
vi.mock('./supabaseAdmin', () => ({
  supabaseAdmin: () => ({ from: () => ({ select: () => ({ eq: () => ({ order: () => ({ order: orderMock }) }) }) }) }),
}));

import { costMicros, currentPeriod, periodForSubRow, resolvePeriod } from './aiBudget';

// costMicros prices every Gemini call against the user's monthly credit — a regression here either
// overcharges users (features lock too early) or undercharges (the $10 budget stops meaning $10).
describe('costMicros', () => {
  it('prices flash input/output at $0.30/$2.50 per 1M tokens', () => {
    // 1M input tokens = $0.30 = 300k micros; 1M output = $2.50 = 2.5M micros.
    expect(costMicros('gemini-2.5-flash', { promptTokenCount: 1_000_000 })).toBe(300_000);
    expect(costMicros('gemini-2.5-flash', { candidatesTokenCount: 1_000_000 })).toBe(2_500_000);
  });

  it('bills thinking tokens at the output rate', () => {
    const withThoughts = costMicros('gemini-2.5-flash', { candidatesTokenCount: 500, thoughtsTokenCount: 500 });
    const outputOnly = costMicros('gemini-2.5-flash', { candidatesTokenCount: 1000 });
    expect(withThoughts).toBe(outputOnly);
  });

  it('prices pro higher than flash for the same tokens', () => {
    const usage = { promptTokenCount: 10_000, candidatesTokenCount: 2_000 };
    expect(costMicros('gemini-2.5-pro', usage)).toBeGreaterThan(costMicros('gemini-2.5-flash', usage));
  });

  it('prices unknown models as pro (the dearest), never free', () => {
    const usage = { promptTokenCount: 1000, candidatesTokenCount: 1000 };
    expect(costMicros('gemini-9-experimental', usage)).toBe(costMicros('gemini-2.5-pro', usage));
  });

  it('rounds up so tiny calls still cost at least 1 micro', () => {
    expect(costMicros('gemini-2.5-flash', { promptTokenCount: 1 })).toBe(1);
    expect(costMicros('gemini-2.5-flash', {})).toBe(0);
  });
});

describe('period helpers', () => {
  it('currentPeriod is the UTC YYYY-MM month', () => {
    expect(currentPeriod()).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });
});

// periodForSubRow decides which ai_usage bucket a call bills to. Anchoring it to the billing cycle is
// the whole fix: a bug here re-opens the calendar-reset dead window (credit that ignores renewals) or
// mis-buckets spend so the meter and the budget gate disagree.
describe('periodForSubRow (billing-cycle anchored key)', () => {
  const RENEW = '2999-08-20T09:30:00.000Z';

  it('keys an active subscription to its renews_at date, and resets on that instant', () => {
    const p = periodForSubRow({ status: 'active', renews_at: RENEW, ends_at: null });
    expect(p.key).toBe('2999-08-20');
    expect(p.resetsAt.toISOString()).toBe(RENEW);
  });

  it('falls back to ends_at when renews_at is null (cancelled-in-window / redeemed free month)', () => {
    const p = periodForSubRow({ status: 'cancelled', renews_at: null, ends_at: RENEW });
    expect(p.key).toBe('2999-08-20');
    expect(p.resetsAt.toISOString()).toBe(RENEW);
  });

  it('falls back to the calendar month for a NON-granting row (e.g. past_due)', () => {
    expect(periodForSubRow({ status: 'past_due', renews_at: RENEW, ends_at: null }).key).toBe(currentPeriod());
  });

  it('falls back to the calendar month when there is no subscription', () => {
    expect(periodForSubRow(null).key).toBe(currentPeriod());
    expect(periodForSubRow(undefined).key).toBe(currentPeriod());
  });

  it('falls back to the calendar month when a granting row carries no anchor date', () => {
    expect(periodForSubRow({ status: 'active', renews_at: null, ends_at: null }).key).toBe(currentPeriod());
  });
});

// resolvePeriod is the DB glue over periodForSubRow. Its load-bearing property is fail-safe: a
// subscriptions read that errors or throws must fall back to the calendar month and NEVER surface an
// error, or the budget gate's fail-open guarantee breaks and a Supabase blip could paywall a payer.
describe('resolvePeriod (reads the subscription, fails safe)', () => {
  const RENEW = '2999-08-20T09:30:00.000Z';

  it('anchors to the GRANTING row when several rows exist', async () => {
    orderMock.mockResolvedValueOnce({
      data: [
        { status: 'expired', renews_at: null, ends_at: '2020-01-01T00:00:00.000Z' },
        { status: 'active', renews_at: RENEW, ends_at: null },
      ],
      error: null,
    });
    expect((await resolvePeriod('u1')).key).toBe('2999-08-20');
  });

  it('falls back to the calendar month when no row grants access', async () => {
    orderMock.mockResolvedValueOnce({ data: [{ status: 'past_due', renews_at: RENEW, ends_at: null }], error: null });
    expect((await resolvePeriod('u1')).key).toBe(currentPeriod());
  });

  it('fails SAFE to the calendar month on a read error (never throws)', async () => {
    orderMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(resolvePeriod('u1')).resolves.toEqual(expect.objectContaining({ key: currentPeriod() }));
  });

  it('fails SAFE when the query itself throws', async () => {
    orderMock.mockRejectedValueOnce(new Error('network down'));
    await expect(resolvePeriod('u1')).resolves.toEqual(expect.objectContaining({ key: currentPeriod() }));
  });
});
