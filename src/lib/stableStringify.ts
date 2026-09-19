// Deterministic JSON with recursively-sorted object keys. Used to compare a reels/rows array we WROTE
// against the same array coming back over Supabase Realtime: Postgres jsonb does not preserve key order
// (or insignificant whitespace), so a naive JSON.stringify of payload.new would never equal our own
// stringify even for byte-identical data. Sorting keys at every level makes the comparison order-invariant,
// which is what the multi-tab echo-suppression and the save-storm no-op dedup both rely on.
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
