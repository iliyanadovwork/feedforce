// Guards for per-reel framing when a reel's VIDEO SOURCE changes (link repaste, upload replace).
// Saved framing carries time-domain state — trimStart/trimEnd/segments/timeline — that describes a
// SPECIFIC video. Re-applying it to a different video silently capped the new reel at the previous
// video's length (the trim window is applied verbatim on restore, and the export bake stops at
// trimEnd; its clamp only shrinks windows, so a stale-shorter window passed straight through).
// Two layers, both pure and unit-tested here:
//   1. stripTimeDomainFraming — invalidation at the source-change boundary (CanvasGrid strips the
//      row's framingMap entry, so restore/autosave can't resurrect the old window).
//   2. clampTrimWindow — belt-and-braces inside applyFraming: a restored plain-trim window is
//      clamped to the actually-loaded duration, so any stale path that slips past layer 1 can
//      still never cap a longer video.
// The crop/pan/zoom half of framing (box/videoOffset/videoScale/includeEdit) survives a source
// change deliberately: it's canvas-space, the user likely wants the same composition for the
// replacement clip, and loadedmetadata re-derives the band when dimensions differ.

import type { Framing } from '@/app/components/TikTokCanvas/types';
import type { VideoEntry } from '@/app/types';

/** The framing fields that describe a specific video's time axis. */
const TIME_DOMAIN_FIELDS = ['trimStart', 'trimEnd', 'segments', 'timeline'] as const;

/** Remove time-domain state from a framing. Returns the SAME reference when there is nothing to
 *  strip, so callers can cheaply skip state updates (and autosave sees byte-identical rows). */
export function stripTimeDomainFraming(f: Framing): Framing {
  if (!TIME_DOMAIN_FIELDS.some(k => k in f)) return f;
  const rest = { ...f };
  for (const k of TIME_DOMAIN_FIELDS) delete rest[k];
  return rest;
}

/** True when setting `newUrl` on `prev` replaces an actually-fetched/stored video — the same
 *  predicate updateEntry's url branch uses to clear the video pipeline state. Single source of
 *  truth: useVideoEntries clears the pipeline with it, CanvasGrid strips framing with it. */
export function urlChangeInvalidatesVideo(prev: VideoEntry | undefined, newUrl: string): boolean {
  return !!prev && (prev.url ?? '') !== newUrl && !!(prev.videoUrl || prev.data || prev.posterUrl);
}

/** True when replacing/removing the local upload discards an existing video (upload, stored file,
 *  or fetched link data) — mirrors updateLocalVideo's clear-and-GC semantics. A row restored from
 *  a reload has NO live localVideoSrc (the blob died with the session) yet still carries the stored
 *  video (videoUrl); removing/replacing that is a source change too, so the guard is "had any
 *  video, and the local source is different or was never live" — only the same-blob no-op stays
 *  false. (Without the second clause, remove-then-re-upload on a restored upload skipped the strip
 *  entirely and resurrected the original stale-trim bug.) */
export function localVideoChangeInvalidatesVideo(prev: VideoEntry | undefined, newSrc: string): boolean {
  return !!prev
    && !!(prev.localVideoSrc || prev.videoUrl || prev.data || prev.posterUrl)
    && ((prev.localVideoSrc ?? '') !== newSrc || !prev.localVideoSrc);
}

/** Clamp a restored plain-trim window to the loaded video's duration. Returns the window to apply,
 *  or null when the clamped window collapses (start at/past the end) — callers should then skip
 *  applying trim and keep the full-duration default from the metadata reset. A non-finite or
 *  non-positive duration (video not loaded yet) applies no cap, preserving verbatim behaviour.
 *  NOT for timeline-mirrored trim: a multi-source timeline's total legitimately exceeds the main
 *  video's duration — the caller must only clamp when no timeline was restored. */
export function clampTrimWindow(
  trimStart: number | undefined,
  trimEnd: number | undefined,
  duration: number | undefined,
): { trimStart?: number; trimEnd?: number } | null {
  const cap = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const start = typeof trimStart === 'number' ? Math.min(Math.max(0, trimStart), cap) : undefined;
  const end = typeof trimEnd === 'number' ? Math.min(Math.max(0, trimEnd), cap) : undefined;
  if (start !== undefined && end !== undefined && end <= start) return null;
  // A start pinned AT the cap leaves zero playable video even without an end — collapse that too.
  if (start !== undefined && start >= cap) return null;
  return { trimStart: start, trimEnd: end };
}
