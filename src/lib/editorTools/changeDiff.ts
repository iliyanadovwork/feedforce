// Turns a settings patch + the state it applies over into a short human "what changed" summary, e.g.
// "fontSize 68→88 · color #fff→#111", so the copilot's applied card shows the actual values it
// touched instead of a generic "Updated slide". Pure + unit-tested. Walks scalar leaves of the patch;
// array fields (imageBoxes, textBoxes…) are summarized by key name only (their internal shape is too
// deep to be readable inline).

function fmt(v: unknown): string {
  if (typeof v === 'number') return String(Math.round(v * 100) / 100);
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string') {
    const s = v.length > 24 ? `${v.slice(0, 24)}…` : v;
    // Hex colors and already-numeric-ish strings read fine bare; quote free text.
    return /^#|^\d/.test(s) ? s : `“${s}”`;
  }
  return String(v);
}

// Collect up to `limit` "key from→to" (or "key → to" for newly-set) strings for scalar leaves of
// `patch` whose value differs from `before` at the same path. Leaf key is the last path segment.
export function summarizeDiff(
  before: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
  limit = 4,
): string[] {
  const out: string[] = [];
  const walk = (b: unknown, p: unknown, key: string) => {
    if (out.length >= limit || p === undefined) return;
    if (p === null || typeof p !== 'object') {
      const from = (b === null || typeof b !== 'object') ? b : undefined;
      if (from === p) return;                                  // unchanged
      out.push(from === undefined ? `${key} → ${fmt(p)}` : `${key} ${fmt(from)}→${fmt(p)}`);
      return;
    }
    if (Array.isArray(p)) {                                     // array — summarize by key name
      if (b !== undefined && JSON.stringify(b) === JSON.stringify(p)) return;   // echoed unchanged array
      out.push(key);
      return;
    }
    const bo = (b && typeof b === 'object' && !Array.isArray(b)) ? (b as Record<string, unknown>) : {};
    for (const k of Object.keys(p as Record<string, unknown>)) walk(bo[k], (p as Record<string, unknown>)[k], k);
  };
  if (patch) for (const k of Object.keys(patch)) walk(before?.[k], patch[k], k);
  return out;
}

// Join a diff summary into one label; falls back to `fallback` when there's nothing scalar to show.
export function diffLabel(
  before: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
  fallback: string,
): string {
  const parts = summarizeDiff(before, patch);
  return parts.length ? `Set ${parts.join(' · ')}` : fallback;
}
