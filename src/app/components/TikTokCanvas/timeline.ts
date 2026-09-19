// The reel timeline model — pure functions shared by the canvas sequencer (preview playback), the
// exporter (useRecording) and the timeline bar (VideoControlsBar), so the three can never disagree
// about what the output video IS.
//
// A timeline is an ORDERED list of clips; each clip is a window [start,end] (source-time seconds)
// into one SOURCE. `src: ''` (MAIN_SRC) is the reel's own video (pasted link or upload); any other
// id references an extra source the user added from the timeline's "Add video" button (a durable
// post-videos URL, so it survives reload and rides the framing autosave). Output time is the clips
// packed back-to-back in ARRAY order — reordering clips reorders the output, and the same source
// span may appear in several clips (CapCut semantics). This supersedes the legacy single-source
// `segments` model, whose output order was locked to source order.

export const MAIN_SRC = '';

export interface TimelineSource {
  id: string;      // stable non-empty id, referenced by clips
  url: string;     // durable public URL (post-videos bucket) — playable + fetchable for export
  name?: string;   // display name (original filename)
}

export interface TimelineClip {
  id: string;      // UI identity (selection, drag); NOT persisted
  src: string;     // MAIN_SRC or a TimelineSource id
  start: number;   // source-time in-point (s)
  end: number;     // source-time out-point (s), > start
}

export interface ReelTimeline {
  sources: TimelineSource[];   // extra sources only — the main video is implied
  clips: TimelineClip[];       // ordered; output = clips back-to-back
}

/** Persisted shape (inside Framing) — clip ids are session-only, so they're stripped. */
export interface SavedTimeline {
  sources: { id: string; url: string; name?: string }[];
  clips: { src: string; start: number; end: number }[];
}

let clipCounter = 0;
export function mkClipId(): string {
  clipCounter += 1;
  return `clip-${Date.now().toString(36)}-${clipCounter}`;
}

// ── Output layout ────────────────────────────────────────────────────────────────────────────────
// Clips packed contiguously from output time 0, in ARRAY order (never sorted — order IS the edit).
export interface TimelineItem { clip: TimelineClip; out0: number; out1: number; dur: number }
export interface TimelineLayout { items: TimelineItem[]; total: number }

export function buildTimelineLayout(clips: TimelineClip[]): TimelineLayout {
  let acc = 0;
  const items = clips.map(clip => {
    const dur = Math.max(0, clip.end - clip.start);
    const it: TimelineItem = { clip, out0: acc, out1: acc + dur, dur };
    acc += dur;
    return it;
  });
  return { items, total: acc };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** The clip playing at output time `outT` plus the source time within it. End-inclusive on the last
 *  clip so seeking to the very end resolves instead of returning null. */
export function timelineAtOut(outT: number, L: TimelineLayout): { index: number; srcT: number } | null {
  if (!L.items.length) return null;
  const t = clamp(outT, 0, L.total);
  for (let i = 0; i < L.items.length; i++) {
    const it = L.items[i];
    if (t < it.out1 || i === L.items.length - 1) {
      return { index: i, srcT: clamp(it.clip.start + (t - it.out0), it.clip.start, it.clip.end) };
    }
  }
  return null;
}

/** Output time of source time `srcT` assuming clip `index` is the one playing. */
export function timelineOutOf(index: number, srcT: number, L: TimelineLayout): number {
  const it = L.items[index];
  if (!it) return 0;
  return clamp(it.out0 + (srcT - it.clip.start), it.out0, it.out1);
}

// ── Legacy conversion + persistence ──────────────────────────────────────────────────────────────

/** Legacy `segments` (single-source cuts, output order = source order) → ordered clips of MAIN. */
export function clipsFromSegments(segments: { start: number; end: number }[]): TimelineClip[] {
  return [...segments]
    .sort((a, b) => a.start - b.start)
    .map(s => ({ id: mkClipId(), src: MAIN_SRC, start: s.start, end: s.end }));
}

/** Is this timeline expressible as the legacy model (main-only clips, in source order)? Such
 *  timelines persist as `segments` so rows stay readable by pre-timeline code. */
export function isLegacyShape(t: ReelTimeline): boolean {
  if (t.sources.length > 0) return false;
  if (t.clips.some(c => c.src !== MAIN_SRC)) return false;
  for (let i = 1; i < t.clips.length; i++) if (t.clips[i].start < t.clips[i - 1].end) return false;
  return true;
}

export function saveTimeline(t: ReelTimeline): SavedTimeline {
  return {
    sources: t.sources.map(s => ({ id: s.id, url: s.url, ...(s.name ? { name: s.name } : {}) })),
    clips: t.clips.map(c => ({ src: c.src, start: c.start, end: c.end })),
  };
}

/** Restore a persisted timeline; drops clips whose source id no longer resolves and degenerate
 *  (non-positive) windows, so a partially-corrupt blob restores what it can. */
export function loadTimeline(raw: unknown): ReelTimeline | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SavedTimeline>;
  const sources: TimelineSource[] = (Array.isArray(r.sources) ? r.sources : [])
    .filter((s): s is { id: string; url: string; name?: string } =>
      !!s && typeof s === 'object' && typeof s.id === 'string' && s.id !== '' && typeof s.url === 'string' && s.url !== '')
    .map(s => ({ id: s.id, url: s.url, ...(typeof s.name === 'string' ? { name: s.name } : {}) }));
  const ids = new Set(sources.map(s => s.id));
  const clips: TimelineClip[] = (Array.isArray(r.clips) ? r.clips : [])
    .filter((c): c is { src: string; start: number; end: number } =>
      !!c && typeof c === 'object'
      && typeof (c as { src?: unknown }).src === 'string'
      && typeof (c as { start?: unknown }).start === 'number' && typeof (c as { end?: unknown }).end === 'number')
    .filter(c => c.end > c.start && c.start >= 0 && (c.src === MAIN_SRC || ids.has(c.src)))
    .map(c => ({ id: mkClipId(), src: c.src, start: c.start, end: c.end }));
  if (!clips.length) return null;
  // Sources nothing references are dead weight (and would pin storage refs) — drop them.
  const used = new Set(clips.map(c => c.src));
  return { sources: sources.filter(s => used.has(s.id)), clips };
}
