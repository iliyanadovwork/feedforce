// Helpers for binding a source node's response fields to a template's {placeholders}. Pure + tested.

export interface FlatKey { path: string; value: unknown; }

/** Flatten any JSON into leaf key→value pairs with dot/index paths (capped). */
export function flattenKeys(input: unknown, opts: { maxEntries?: number } = {}): FlatKey[] {
  const max = opts.maxEntries ?? 200;
  const out: FlatKey[] = [];
  const walk = (val: unknown, path: string) => {
    if (out.length >= max) return;
    if (val === null || typeof val !== 'object') { if (path) out.push({ path, value: val }); return; }
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length && out.length < max; i++) walk(val[i], path ? `${path}.${i}` : String(i));
    } else {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (out.length >= max) break;
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(input, '');
  return out;
}

/** The final segment of a dotted path ("markets.0.ticker" → "ticker"). */
export function lastSegment(path: string): string {
  const parts = path.split('.');
  return parts[parts.length - 1] || path;
}

/** Unique {placeholder} tokens found in a string (single braces, word/.-_ chars). */
export function extractPlaceholders(text: string): string[] {
  const re = /\{([a-zA-Z0-9_.-]+)\}/g;
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) set.add(m[1]);
  return [...set];
}

/** Best-effort default mapping: a placeholder matches a key whose LAST segment equals its name. */
export function autoMatch(placeholders: string[], keyPaths: string[]): Record<string, string> {
  const bySegment = new Map<string, string>();
  for (const p of keyPaths) {
    const seg = lastSegment(p).toLowerCase();
    if (!bySegment.has(seg)) bySegment.set(seg, p); // first occurrence wins
  }
  const map: Record<string, string> = {};
  for (const ph of placeholders) {
    const hit = bySegment.get(ph.toLowerCase());
    if (hit) map[ph] = hit;
  }
  return map;
}

/** Read a value out of a JSON object by dot/index path ("data.markets.0.ticker"). */
export function getAtPath(root: unknown, path: string): unknown {
  if (!path) return root;
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Replace {placeholder} tokens in `text` with `values[placeholder]`; unmapped tokens stay as-is. */
export function fillText(text: string, values: Record<string, string>): string {
  return text.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, k) => (k in values ? values[k] : `{${k}}`));
}

/** Recursively collect all string values from a JSON blob (e.g. a reels settings object). */
export function collectStrings(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  return [];
}
