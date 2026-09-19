// Compact-state serialization + patch merge for the editor tools API.
//
// compact*Settings: the token-economy half — an agent reads only the fields that DIFFER from the
// defaults (a typical slide compresses ~8KB → 1-2KB of JSON). Reconstruct with
// mergePatch(defaults, compact).
//
// mergePatch: the write half — deterministic merge semantics for validated patches:
//   * plain objects merge recursively (so { tagStyle: { bgColor } } keeps the other tag fields)
//   * arrays and primitives REPLACE (send arrays whole — index-wise array merging is a footgun)
//   * null is an explicit value (clears/overwrites); undefined keys are ignored

import type { CarouselSettings } from '@/app/components/templateEditorTypes';
import { defaultCarouselSettings } from '@/app/components/templateEditorTypes';
import type { TwitterTemplateSettings } from '@/app/components/twitterTemplateTypes';
import { defaultTwitterTemplateSettings } from '@/app/components/twitterTemplateTypes';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` into `base` (see rules above). Returns a new object; inputs are not mutated. */
export function mergePatch<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = mergePatch(current, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Top-level fields of `settings` that differ (deep-compared) from `defaults`. */
function diffFromDefaults<T extends Record<string, unknown>>(settings: T, defaults: T): Partial<T> {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(defaults), ...Object.keys(settings)]);
  for (const key of keys) {
    const a = settings[key];
    const b = defaults[key];
    if (a === undefined && b === undefined) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = a;
  }
  return out as Partial<T>;
}

export function compactCarouselSettings(settings: CarouselSettings): Partial<CarouselSettings> {
  return diffFromDefaults(
    settings as unknown as Record<string, unknown>,
    defaultCarouselSettings() as unknown as Record<string, unknown>,
  ) as Partial<CarouselSettings>;
}

export function compactReelSettings(settings: TwitterTemplateSettings): Partial<TwitterTemplateSettings> {
  return diffFromDefaults(
    settings as unknown as Record<string, unknown>,
    defaultTwitterTemplateSettings() as unknown as Record<string, unknown>,
  ) as Partial<TwitterTemplateSettings>;
}
