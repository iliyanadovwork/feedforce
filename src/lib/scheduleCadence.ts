// Pure cadence helpers for "Schedule All": turn a start time plus an interval into concrete publish
// instants, and measure how dense the resulting schedule gets against Instagram's daily publish cap.
// No I/O and no Date.now() in here, everything is deterministic on its inputs (testable, UI-safe).

// Instagram's Graph API allows at most 25 API-published posts per ROLLING 24-hour window per account
// (Meta's `content_publishing_limit` endpoint tracks it; the 26th publish fails with error code 9).
// Bigger numbers circulate, but they measure different things: 50 is Meta's cap on simultaneously
// UNPUBLISHED media containers, and ~100/day is the app-level posting ceiling people discuss for
// manual posting. 25 is the most conservative documented publish limit, so the soft warning fires
// there, we warn rather than block because Zernio (not us) is the API publisher of record.
export const SOFT_DAILY_WARN = 25;

// App-level backlog cap: at most this many SCHEDULED posts per Instagram account. Keeps Schedule All
// (and repeated single scheduling) from stacking an unbounded queue on one account. Publish-now posts
// are exempt (they never sit in the backlog). Defined HERE (pure, client-safe) so the Schedule All
// modal and SchedulePanel can import it without pulling the server-only Zernio client into the
// bundle; lib/zernio re-exports it for the schedule API routes.
export const MAX_SCHEDULED_PER_ACCOUNT = 50;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// `startISOLocal` is what an <input type="datetime-local"> yields, e.g. "2026-07-19T09:00" (no
// timezone suffix). Per the ECMAScript date-time string format (MDN, Date reference): when the
// offset is absent, date-TIME forms are interpreted as LOCAL time (only date-ONLY forms default to
// UTC). So `new Date(startISOLocal)` is exactly the wall-clock moment the user picked, in their own
// timezone, which is what the picker means.
//
// Subsequent slots step by a fixed REAL-TIME delta (intervalHours in ms), not by wall clock. Across
// a DST change the instants stay exactly `intervalHours` apart while the local labels absorb the
// shifted hour, which is the behavior we want for pacing (and what the tests pin: deltas in ms,
// never wall-clock strings). Returns full `toISOString()` UTC strings, ready for the bulk API.
// Unparseable start, non-finite interval, or a non-positive count returns [] (nothing to schedule).
export function assignScheduleTimes(startISOLocal: string, intervalHours: number, count: number): string[] {
  const startMs = new Date(startISOLocal).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(intervalHours)) return [];
  if (!Number.isInteger(count) || count <= 0) return [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(new Date(startMs + i * intervalHours * HOUR_MS).toISOString());
  }
  return out;
}

// Max number of scheduled times that fall inside ANY rolling 24h window, for the SOFT_DAILY_WARN
// check. Windows are half-open: a window that starts AT a post's instant excludes a post exactly
// 24h later, so two posts precisely 24h apart are always in separate windows (a clean "1 per day"
// cadence counts as 1, not 2). Classic two-pointer sweep over the sorted instants: for each post,
// count how many land in the 24h window ENDING at that post. Unparseable entries are ignored.
export function maxInAnyRolling24h(timesISO: string[]): number {
  const times = timesISO
    .map((t) => new Date(t).getTime())
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  let max = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi] - times[lo] >= DAY_MS) lo++;
    if (hi - lo + 1 > max) max = hi - lo + 1;
  }
  return max;
}
