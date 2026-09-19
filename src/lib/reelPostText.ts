// Pure, client-safe helpers mapping a reel's text fields onto what Instagram actually posts.
//
// Instagram posts (feed, Reels, carousels) have exactly ONE editable text field (the caption), capped at
// 2,200 characters. There is no separate "description" field on Instagram (Meta Graph API passes a single
// `caption` on the media container). So our per-reel `description` IS the Instagram post caption, while the
// reel's `caption` field stays the on-video overlay text.
//
// reelPostText is the single source of truth for that mapping and is deliberately NON-BREAKING: a reel with
// an overlay caption and no description still posts its caption exactly as before.

// The Instagram post caption for a reel: the description (trimmed) when it has content, else the on-video
// caption, else ''. Accepts null/undefined (and null-ish fields) so callers never have to pre-guard.
export function reelPostText(r: { description?: string | null; caption?: string | null } | null | undefined): string {
  const description = (r?.description ?? '').trim();
  if (description) return description;
  return r?.caption ?? '';
}

// A sidecar .txt for a downloaded reel, or null when there's no description to write. The emptiness check
// trims (whitespace-only counts as blank), but the written bytes are the description VERBATIM (untrimmed).
export function descriptionSidecar(
  stem: string,
  description: string | null | undefined,
): { name: string; bytes: Uint8Array } | null {
  if (!description || !description.trim()) return null;
  return { name: stem + '.txt', bytes: new TextEncoder().encode(description) };
}
