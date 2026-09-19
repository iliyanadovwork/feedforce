// Canonical rounding for persisted framing values, applied at the WRITE boundary (the autosave rows
// builder and the reel-switch framing capture). getFraming() reads live floats off the canvas, and an
// apply-then-read round-trip returns values that differ from the saved ones by float dust (1e-13-ish).
// Unrounded, every video load produced byte-different rows, which armed the autosave debounce on IDLE
// tabs; the pending-edit adoption guard then read that churn as "user is editing", refused the incoming
// foreign edit, and the armed stale save clobbered it by last-writer-wins (the 2026-07-21 localhost
// sync failure). Rounding makes load-churn rows byte-identical, so a no-op save never arms and an idle
// tab can always adopt. 4 decimals keeps sub-pixel/box precision and sub-millisecond trim precision.

const EPSILON = 1e-6;

function round4(v: number): number {
  if (!Number.isFinite(v)) return v;
  const r = Math.round(v * 10000) / 10000;
  // Snap float dust (and -0) to a plain 0 so jsonb round-trips can never resurrect E-notation values.
  return Math.abs(r) < EPSILON ? 0 : r;
}

/** Deep-round every number in a framing-shaped value; non-numbers pass through untouched. Idempotent:
 *  roundFramingDeep(roundFramingDeep(x)) always equals roundFramingDeep(x), which is what guarantees
 *  write-convergence (the second autosave of unchanged framing is byte-identical to the first). */
export function roundFramingDeep<T>(value: T): T {
  if (typeof value === 'number') return round4(value) as unknown as T;
  if (Array.isArray(value)) return value.map(roundFramingDeep) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, roundFramingDeep(v)]),
    ) as unknown as T;
  }
  return value;
}
