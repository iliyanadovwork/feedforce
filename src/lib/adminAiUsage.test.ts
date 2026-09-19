import { describe, it, expect } from 'vitest';
import { aiPeriodKeysByUser, matchAiUsageByUser } from './adminAiUsage';
import { currentPeriod } from './aiBudget';

// Covers the admin overview's per-user AI-credit attribution — the one piece of new admin logic the
// aiBudget tests don't already exercise. rowGrantsAccess + periodForSubRow stay real here.

describe('aiPeriodKeysByUser', () => {
  it('keys each user to their LATEST granting row (subs arrive oldest→newest, last-wins)', () => {
    const subs = [
      { user_id: 'a', status: 'active', renews_at: '2026-08-20T00:00:00.000Z', ends_at: null, created_at: '2026-01-01T00:00:00.000Z' },
      { user_id: 'a', status: 'active', renews_at: '2026-09-15T00:00:00.000Z', ends_at: null, created_at: '2026-06-01T00:00:00.000Z' }, // later-created wins
    ];
    expect(aiPeriodKeysByUser(['a'], subs).get('a')).toBe('2026-09-15');
  });

  it('ignores NON-granting rows even when newer', () => {
    const subs = [
      { user_id: 'a', status: 'active', renews_at: '2026-08-20T00:00:00.000Z', ends_at: null, created_at: '2026-01-01T00:00:00.000Z' },
      { user_id: 'a', status: 'past_due', renews_at: '2026-12-31T00:00:00.000Z', ends_at: null, created_at: '2026-06-01T00:00:00.000Z' }, // newer but doesn't grant
    ];
    expect(aiPeriodKeysByUser(['a'], subs).get('a')).toBe('2026-08-20');
  });

  it('falls back to the calendar month for a user with no subscription or no granting row', () => {
    expect(aiPeriodKeysByUser(['a'], []).get('a')).toBe(currentPeriod());
    const expired = [{ user_id: 'a', status: 'expired', renews_at: null, ends_at: '2020-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z' }];
    expect(aiPeriodKeysByUser(['a'], expired).get('a')).toBe(currentPeriod());
  });
});

describe('matchAiUsageByUser', () => {
  it('attributes each usage row ONLY to the user whose current key equals its period (no cross-user bleed)', () => {
    // Two users share the date string '2026-08-20' as their period key — the `.in` returns both rows.
    const keyByUser = new Map([['a', '2026-08-20'], ['b', '2026-08-20']]);
    const usage = [
      { user_id: 'a', period: '2026-08-20', spent_micros: 100, calls: 1 },
      { user_id: 'b', period: '2026-08-20', spent_micros: 200, calls: 2 },
    ];
    const out = matchAiUsageByUser(keyByUser, usage);
    expect(out.get('a')).toEqual({ spent_micros: 100, calls: 1 });
    expect(out.get('b')).toEqual({ spent_micros: 200, calls: 2 });
  });

  it('drops a usage row from a period the user is no longer in (stale bucket)', () => {
    const keyByUser = new Map([['a', '2026-09-20']]);
    const usage = [{ user_id: 'a', period: '2026-08-20', spent_micros: 999, calls: 5 }];
    expect(matchAiUsageByUser(keyByUser, usage).size).toBe(0);
  });

  it('returns an empty map when there is no usage', () => {
    expect(matchAiUsageByUser(new Map([['a', '2026-08-20']]), []).size).toBe(0);
  });
});
