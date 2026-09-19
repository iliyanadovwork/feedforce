import { describe, expect, it } from 'vitest';
import { parseCron, cronMatches, lastFire, wallTimeToUtcMs } from './cron';

describe('parseCron', () => {
  it('parses *, lists, ranges and steps', () => {
    const spec = parseCron('*/15 9-17 1,15 * 1-5')!;
    expect([...spec.min]).toEqual([0, 15, 30, 45]);
    expect(spec.hour.has(9) && spec.hour.has(17) && !spec.hour.has(8)).toBe(true);
    expect([...spec.dom]).toEqual([1, 15]);
    expect(spec.dow.has(1) && spec.dow.has(5) && !spec.dow.has(0)).toBe(true);
  });

  it('normalises dow 7 to Sunday and rejects invalid expressions', () => {
    expect([...parseCron('0 0 * * 7')!.dow]).toEqual([0]);
    for (const bad of ['', '0 0 * *', '60 0 * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', 'a b c d e', '0 0 * * */0']) {
      expect(parseCron(bad)).toBeNull();
    }
  });

  it('applies the classic dom/dow OR rule only when both are restricted', () => {
    const both = parseCron('0 0 13 * 5')!; // 13th OR Friday
    expect(cronMatches(both, { min: 0, hour: 0, dom: 13, mon: 6, dow: 2 })).toBe(true);  // 13th, not Friday
    expect(cronMatches(both, { min: 0, hour: 0, dom: 20, mon: 6, dow: 5 })).toBe(true);  // Friday, not 13th
    expect(cronMatches(both, { min: 0, hour: 0, dom: 20, mon: 6, dow: 2 })).toBe(false);
    const domOnly = parseCron('0 0 13 * *')!;
    expect(cronMatches(domOnly, { min: 0, hour: 0, dom: 20, mon: 6, dow: 5 })).toBe(false); // no OR — dom must match
  });
});

describe('lastFire', () => {
  // 2026-07-16 is a Thursday.
  const now = new Date('2026-07-16T14:37:22Z');

  it('finds the latest match at or before now (UTC)', () => {
    expect(lastFire('0 9 * * *', now)?.toISOString()).toBe('2026-07-16T09:00:00.000Z');
    expect(lastFire('*/15 * * * *', now)?.toISOString()).toBe('2026-07-16T14:30:00.000Z');
    expect(lastFire('0 16 * * *', now)?.toISOString()).toBe('2026-07-15T16:00:00.000Z'); // today's not reached yet
    expect(lastFire('0 9 * * 1', now)?.toISOString()).toBe('2026-07-13T09:00:00.000Z'); // last Monday
  });

  it('respects the timezone (9am in New York is 13:00/14:00 UTC)', () => {
    const fire = lastFire('0 9 * * *', now, 'America/New_York')!;
    expect(fire.toISOString()).toBe('2026-07-16T13:00:00.000Z'); // EDT = UTC-4
  });

  it('falls back to UTC for an invalid timezone and returns null for an invalid expression', () => {
    expect(lastFire('0 9 * * *', now, 'Not/AZone')?.toISOString()).toBe('2026-07-16T09:00:00.000Z');
    expect(lastFire('not cron', now)).toBeNull();
  });

  it('returns null when nothing matched inside the lookback window', () => {
    expect(lastFire('0 0 31 2 *', now)).toBeNull(); // Feb 31st never fires
  });
});

describe('wallTimeToUtcMs', () => {
  it('interprets an offset-less datetime-local string in the given timezone', () => {
    // 2pm in New York on 2026-07-20 (EDT, UTC-4) = 18:00 UTC.
    expect(new Date(wallTimeToUtcMs('2026-07-20T14:00', 'America/New_York')).toISOString()).toBe('2026-07-20T18:00:00.000Z');
    // Winter (EST, UTC-5) — DST handled by the two-pass offset.
    expect(new Date(wallTimeToUtcMs('2026-01-20T14:00', 'America/New_York')).toISOString()).toBe('2026-01-20T19:00:00.000Z');
    expect(new Date(wallTimeToUtcMs('2026-07-20T14:00', 'UTC')).toISOString()).toBe('2026-07-20T14:00:00.000Z');
  });

  it('leaves strings with an explicit offset alone and survives bad input', () => {
    expect(new Date(wallTimeToUtcMs('2026-07-20T14:00:00Z', 'America/New_York')).toISOString()).toBe('2026-07-20T14:00:00.000Z');
    expect(new Date(wallTimeToUtcMs('2026-07-20T14:00+02:00', 'America/New_York')).toISOString()).toBe('2026-07-20T12:00:00.000Z');
    expect(Number.isNaN(wallTimeToUtcMs('', 'UTC'))).toBe(true);
    expect(Number.isNaN(wallTimeToUtcMs('not a date', 'UTC'))).toBe(true);
  });
});
