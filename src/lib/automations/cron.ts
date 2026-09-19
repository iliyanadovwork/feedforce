// Minimal, dependency-free 5-field cron support for the scheduled runner. Standard syntax:
//   minute hour day-of-month month day-of-week
// with *, lists (1,2), ranges (1-5), steps (*/15, 1-30/5) and the classic dom/dow OR rule (when BOTH
// are restricted, a time matches if EITHER matches — same as Vixie cron). Day-of-week: 0 or 7 = Sunday.
// Pure + tested; no Date.parse tricks, timezone handled via Intl (invalid tz falls back to UTC).

export interface CronSpec {
  min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>;
  domStar: boolean; dowStar: boolean;
}

const FIELDS: Array<{ lo: number; hi: number }> = [
  { lo: 0, hi: 59 },  // minute
  { lo: 0, hi: 23 },  // hour
  { lo: 1, hi: 31 },  // day of month
  { lo: 1, hi: 12 },  // month
  { lo: 0, hi: 7 },   // day of week (7 = Sunday, normalised to 0)
];

function parseField(raw: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const step = m[2] ? parseInt(m[2], 10) : 1;
    if (!Number.isFinite(step) || step < 1) return null;
    let from = lo, to = hi;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(n => parseInt(n, 10));
      from = a; to = b ?? a;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < lo || to > hi || from > to) return null;
      // A bare value with a step ("5/15") is rare but valid cron: range runs to the field max.
      if (m[2] && b === undefined) to = hi;
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/** Parse a 5-field cron expression. Returns null when it isn't valid. */
export function parseCron(expr: string): CronSpec | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const set = parseField(parts[i], FIELDS[i].lo, FIELDS[i].hi);
    if (!set) return null;
    sets.push(set);
  }
  const dow = new Set([...sets[4]].map(d => (d === 7 ? 0 : d)));
  return {
    min: sets[0], hour: sets[1], dom: sets[2], mon: sets[3], dow,
    domStar: parts[2] === '*', dowStar: parts[4] === '*',
  };
}

interface WallClock { min: number; hour: number; dom: number; mon: number; dow: number }

/** Does the spec match this wall-clock minute? (dom/dow OR rule when both are restricted.) */
export function cronMatches(spec: CronSpec, t: WallClock): boolean {
  if (!spec.min.has(t.min) || !spec.hour.has(t.hour) || !spec.mon.has(t.mon)) return false;
  const domOk = spec.dom.has(t.dom);
  const dowOk = spec.dow.has(t.dow);
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dowOk;
  if (spec.dowStar) return domOk;
  return domOk || dowOk;
}

const DOW_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** A formatter per timezone (cached — Intl construction is the expensive part). */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, minute: 'numeric', hour: 'numeric', hourCycle: 'h23', day: 'numeric', month: 'numeric', weekday: 'short',
    });
    fmtCache.set(tz, fmt);
  }
  return fmt;
}

function wallClockAt(ms: number, tz: string): WallClock | null {
  try {
    const parts = formatterFor(tz).formatToParts(new Date(ms));
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return {
      min: parseInt(get('minute'), 10),
      hour: parseInt(get('hour'), 10) % 24, // h23 can still yield "24" on some ICU versions
      dom: parseInt(get('day'), 10),
      mon: parseInt(get('month'), 10),
      dow: DOW_INDEX[get('weekday')] ?? new Date(ms).getUTCDay(),
    };
  } catch {
    return null; // invalid timezone
  }
}

const MINUTE = 60_000;
export const CRON_LOOKBACK_MS = 35 * 24 * 60 * MINUTE; // covers monthly-ish schedules

/**
 * Interpret an offset-less wall-clock string ("2026-07-20T14:00", the shape a datetime-local input
 * produces) as a time IN the given IANA timezone and return the UTC ms. Strings that already carry an
 * offset/Z parse as-is; invalid tz falls back to plain Date.parse (server-local). Two-pass offset
 * correction handles DST boundaries.
 */
export function wallTimeToUtcMs(s: string, tz?: string): number {
  const trimmed = s.trim();
  if (!trimmed) return NaN;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return Date.parse(trimmed);
  if (!tz) return Date.parse(trimmed);
  const asUtc = Date.parse(trimmed.includes('T') ? `${trimmed}Z` : `${trimmed}T00:00Z`);
  if (!Number.isFinite(asUtc)) return NaN;
  const offsetAt = (utcMs: number): number | null => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
      }).formatToParts(new Date(utcMs));
      const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '', 10);
      const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
      return wallAsUtc - utcMs;
    } catch { return null; }
  };
  const first = offsetAt(asUtc);
  if (first === null) return Date.parse(trimmed); // invalid tz — old server-local behaviour
  const second = offsetAt(asUtc - first) ?? first;
  return asUtc - second;
}

/**
 * The most recent time (≤ now) the expression fired, scanning back minute-by-minute up to the lookback
 * cap, in the given IANA timezone (default UTC; invalid tz → UTC). Returns null when the expression is
 * invalid or nothing matched inside the window — callers should fall back to a sane default interval.
 */
export function lastFire(expr: string, now: Date, tz = 'UTC', lookbackMs: number = CRON_LOOKBACK_MS): Date | null {
  const spec = parseCron(expr);
  if (!spec) return null;
  const zone = wallClockAt(now.getTime(), tz) ? tz : 'UTC';
  const start = Math.floor(now.getTime() / MINUTE) * MINUTE; // truncate to the minute
  for (let t = start; t >= start - lookbackMs; t -= MINUTE) {
    const wall = wallClockAt(t, zone);
    if (wall && cronMatches(spec, wall)) return new Date(t);
  }
  return null;
}
