import { describe, it, expect } from 'vitest';
import { assignScheduleTimes, maxInAnyRolling24h, SOFT_DAILY_WARN } from './scheduleCadence';

// These tests must pass in ANY runner timezone. Datetime-local inputs (no offset) parse as LOCAL
// time, so the absolute instants produced depend on the runner's TZ; the tests therefore assert
// RELATIVE deltas in ms (which are TZ-invariant by construction) and only pin absolute output for
// inputs that carry an explicit offset. DST cases use fixed dates that cross the 2026 US/EU
// transitions and still only assert deltas, wall-clock strings are never compared.

const HOUR_MS = 3_600_000;

function deltasMs(times: string[]): number[] {
  const ms = times.map((t) => Date.parse(t));
  return ms.slice(1).map((v, i) => v - ms[i]);
}

describe('assignScheduleTimes', () => {
  it('interprets a datetime-local string as LOCAL time (first slot = new Date(input))', () => {
    // Per MDN, a date-TIME string without an offset is parsed as local time; the function must
    // agree with Date's own reading of the picker value, whatever TZ the runner is in.
    const input = '2026-07-19T09:00';
    const out = assignScheduleTimes(input, 24, 3);
    expect(Date.parse(out[0])).toBe(new Date(input).getTime());
  });

  it('emits full ISO strings (toISOString shape, Z suffix)', () => {
    const out = assignScheduleTimes('2026-07-19T09:00', 24, 2);
    for (const t of out) {
      expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(t).toISOString()).toBe(t);
    }
  });

  it('is deterministic for an offset-carrying input (TZ-independent anchor)', () => {
    // Date also accepts explicit-offset strings; with one, the absolute output is pinnable exactly.
    const out = assignScheduleTimes('2026-01-15T10:00:00Z', 6, 3);
    expect(out).toEqual([
      '2026-01-15T10:00:00.000Z',
      '2026-01-15T16:00:00.000Z',
      '2026-01-15T22:00:00.000Z',
    ]);
  });

  it('24h interval: consecutive slots are exactly 24h apart', () => {
    const out = assignScheduleTimes('2026-07-19T09:00', 24, 5);
    expect(out).toHaveLength(5);
    expect(deltasMs(out)).toEqual([24 * HOUR_MS, 24 * HOUR_MS, 24 * HOUR_MS, 24 * HOUR_MS]);
  });

  it('12h interval: consecutive slots are exactly 12h apart', () => {
    const out = assignScheduleTimes('2026-07-19T09:00', 12, 4);
    expect(deltasMs(out)).toEqual([12 * HOUR_MS, 12 * HOUR_MS, 12 * HOUR_MS]);
  });

  it('fractional 0.5h interval: consecutive slots are exactly 30min apart', () => {
    const out = assignScheduleTimes('2026-07-19T09:00', 0.5, 4);
    expect(deltasMs(out)).toEqual([0.5 * HOUR_MS, 0.5 * HOUR_MS, 0.5 * HOUR_MS]);
  });

  it('count 1: exactly one slot, equal to the start', () => {
    const input = '2026-03-03T18:30';
    const out = assignScheduleTimes(input, 8, 1);
    expect(out).toHaveLength(1);
    expect(Date.parse(out[0])).toBe(new Date(input).getTime());
  });

  it('count 50 (the Schedule All maximum): full span is 49 intervals', () => {
    const out = assignScheduleTimes('2026-07-19T09:00', 0.5, 50);
    expect(out).toHaveLength(50);
    expect(Date.parse(out[49]) - Date.parse(out[0])).toBe(49 * 0.5 * HOUR_MS);
    // Strictly increasing, no duplicate slots.
    expect(new Set(out).size).toBe(50);
  });

  it('DST fall-back (US 2026-11-01): real-time deltas stay exactly the interval', () => {
    // 6h steps from the evening of Oct 31 cross 02:00 local on Nov 1 in US zones. If the runner is
    // in such a zone and slots were stepped by WALL CLOCK, one delta would come out as 7h of real
    // time; stepping by ms keeps every delta exact. In non-DST runners this still holds trivially.
    const out = assignScheduleTimes('2026-10-31T20:00', 6, 6);
    expect(deltasMs(out)).toEqual(Array(5).fill(6 * HOUR_MS));
  });

  it('DST spring-forward (EU 2026-03-29): real-time deltas stay exactly the interval', () => {
    const out = assignScheduleTimes('2026-03-28T22:00', 3, 8);
    expect(deltasMs(out)).toEqual(Array(7).fill(3 * HOUR_MS));
  });

  it('returns [] for unparseable start, non-finite interval, or non-positive count', () => {
    expect(assignScheduleTimes('not a date', 24, 3)).toEqual([]);
    expect(assignScheduleTimes('', 24, 3)).toEqual([]);
    expect(assignScheduleTimes('2026-07-19T09:00', NaN, 3)).toEqual([]);
    expect(assignScheduleTimes('2026-07-19T09:00', Infinity, 3)).toEqual([]);
    expect(assignScheduleTimes('2026-07-19T09:00', 24, 0)).toEqual([]);
    expect(assignScheduleTimes('2026-07-19T09:00', 24, -1)).toEqual([]);
    expect(assignScheduleTimes('2026-07-19T09:00', 24, 2.5)).toEqual([]);
  });
});

describe('maxInAnyRolling24h', () => {
  // Pinned semantics: windows are half-open, so two posts EXACTLY 24h apart never share a window.
  const base = Date.parse('2026-07-19T09:00:00Z');
  const at = (hours: number) => new Date(base + hours * HOUR_MS).toISOString();

  it('empty input counts 0, single time counts 1', () => {
    expect(maxInAnyRolling24h([])).toBe(0);
    expect(maxInAnyRolling24h([at(0)])).toBe(1);
  });

  it('posts exactly 24h apart land in SEPARATE windows (boundary is exclusive)', () => {
    expect(maxInAnyRolling24h([at(0), at(24)])).toBe(1);
    // A hair inside the window and they share it.
    expect(maxInAnyRolling24h([at(0), at(23.999)])).toBe(2);
  });

  it('a clean daily cadence of 50 posts counts 1 per window', () => {
    const daily = assignScheduleTimes('2026-07-19T09:00', 24, 50);
    expect(maxInAnyRolling24h(daily)).toBe(1);
  });

  it('12h cadence counts 2 per window', () => {
    const twice = assignScheduleTimes('2026-07-19T09:00', 12, 5);
    expect(maxInAnyRolling24h(twice)).toBe(2);
  });

  it('1h cadence of 50 counts 24 (just under the soft warning)', () => {
    const hourly = assignScheduleTimes('2026-07-19T09:00', 1, 50);
    expect(maxInAnyRolling24h(hourly)).toBe(24);
    expect(maxInAnyRolling24h(hourly)).toBeLessThanOrEqual(SOFT_DAILY_WARN);
  });

  it('0.5h cadence of 50 counts 48 (trips the soft warning)', () => {
    const halfHourly = assignScheduleTimes('2026-07-19T09:00', 0.5, 50);
    expect(maxInAnyRolling24h(halfHourly)).toBe(48);
    expect(maxInAnyRolling24h(halfHourly)).toBeGreaterThan(SOFT_DAILY_WARN);
  });

  it('a dense cluster inside one hour is counted in full', () => {
    const cluster = Array.from({ length: 26 }, (_, i) => at(i / 60));
    expect(maxInAnyRolling24h(cluster)).toBe(26);
  });

  it('does not require sorted input', () => {
    const times = [at(30), at(0), at(12), at(23)];
    expect(maxInAnyRolling24h(times)).toBe(3); // 0h, 12h, 23h share a window; 30h does not.
  });

  it('ignores unparseable entries', () => {
    expect(maxInAnyRolling24h(['garbage', at(0), '', at(1)])).toBe(2);
    expect(maxInAnyRolling24h(['garbage'])).toBe(0);
  });

  it('finds the max in a mixed schedule (window not anchored at the first post)', () => {
    // Sparse start, dense finish: the busiest window is at the end.
    const times = [at(0), at(30), at(31), at(32), at(33)];
    expect(maxInAnyRolling24h(times)).toBe(4);
  });
});

describe('SOFT_DAILY_WARN', () => {
  it('is 25, the documented Graph API publish cap per rolling 24h', () => {
    expect(SOFT_DAILY_WARN).toBe(25);
  });
});
