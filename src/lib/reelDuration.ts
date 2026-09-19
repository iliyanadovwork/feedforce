// Pure reel-duration helpers for the "Schedule All" preflight. The Graph API will PUBLISH a reel
// anywhere from 3 seconds to 15 minutes, but only reels between 5 and 90 seconds are eligible for
// Reels-tab distribution (the discovery surface that makes scheduling reels worthwhile), so we
// classify against the 5..90s eligibility window and surface "short"/"long" as warnings, not blocks.
export const MIN_REEL_S = 5;
export const MAX_REEL_S = 90;

// The duration Instagram will actually see for a reel: the summed clip windows of a saved
// multi-clip edit — `timeline.clips` (multi-source/reordered) or legacy `segments` (single-source
// cuts, which the export renders back-to-back too, so the trim span INCLUDING removed middles
// would over-count) — else the trim window when the user set a valid one (both bounds finite,
// trimEnd > trimStart >= 0), else the source clip's duration when known (finite and positive),
// else null (unknown, the UI shows no duration warning either way).
export function effectiveReelDuration(
  framing: {
    trimStart?: number; trimEnd?: number;
    segments?: { start?: number; end?: number }[];
    timeline?: { clips?: { start?: number; end?: number }[] };
  } | undefined | null,
  sourceDuration: number | null,
): number | null {
  const sumWindows = (ws: { start?: number; end?: number }[] | undefined): number | null => {
    if (!Array.isArray(ws) || ws.length === 0) return null;
    let total = 0;
    for (const w of ws) {
      if (typeof w?.start !== 'number' || typeof w?.end !== 'number' || !Number.isFinite(w.start) || !Number.isFinite(w.end)) return null;
      total += Math.max(0, w.end - w.start);
    }
    return total > 0 ? total : null;
  };
  const clipTotal = sumWindows(framing?.timeline?.clips) ?? sumWindows(framing?.segments);
  if (clipTotal != null) return clipTotal;
  const ts = framing?.trimStart;
  const te = framing?.trimEnd;
  if (
    typeof ts === 'number' && typeof te === 'number' &&
    Number.isFinite(ts) && Number.isFinite(te) &&
    ts >= 0 && te > ts
  ) {
    return te - ts;
  }
  if (typeof sourceDuration === 'number' && Number.isFinite(sourceDuration) && sourceDuration > 0) {
    return sourceDuration;
  }
  return null;
}

// null (and NaN, which is not a duration at all) reads as "unknown"; otherwise classify against the
// Reels-tab eligibility window. Boundaries are inclusive: exactly 5s and exactly 90s are both "ok".
// effectiveReelDuration never emits NaN, the guard here is belt-and-braces for direct callers.
export function classifyReelDuration(seconds: number | null): 'ok' | 'short' | 'long' | 'unknown' {
  if (seconds === null || Number.isNaN(seconds)) return 'unknown';
  if (seconds < MIN_REEL_S) return 'short';
  if (seconds > MAX_REEL_S) return 'long';
  return 'ok';
}
