'use client';

import { useRef, useEffect, useLayoutEffect, useState, useCallback, memo } from 'react';
import type { RecordingState } from './TikTokCanvas/types';
import { Button, IconButton, Slider, ProgressBar, Tooltip } from '@/app/components/ui';
import { TrashIcon, PlayIcon, PauseIcon, PlusIcon, MinusIcon, DownloadIcon } from '@/lib/icons';
import { getVideoBlob, primeVideoBlob } from '@/lib/reelVideoBlob';
import {
  MAIN_SRC, buildTimelineLayout, timelineAtOut, mkClipId,
  type TimelineClip, type TimelineSource, type ReelTimeline, type TimelineLayout,
} from './TikTokCanvas/timeline';

export interface VideoCanvasRef {
  play: () => void;
  pause: () => void;
  seekTo: (t: number) => void;
  setTrimRange: (start: number, end: number) => void;
  resetTrim: () => void;
  resetBox: () => void;
  centerBox: () => void;
  getVideoElement: () => HTMLVideoElement | null;
  useLocalBlob?: () => void;
  getTrimState: () => { trimStart: number; trimEnd: number; duration: number };
  /** Clip list mirrored into the canvas so multi-cut edits persist with the framing (autosave). */
  setSegments?: (segs: Array<{ start: number; end: number }> | null) => void;
  getSegments?: () => Array<{ start: number; end: number }> | null;
  /** Multi-clip / multi-source timeline — the bar's single write path (see TikTokCanvas/timeline.ts). */
  setTimeline?: (t: ReelTimeline | null) => void;
  getTimeline?: () => ReelTimeline | null;
  getPlayback?: () => { outT: number; clipIndex: number; playing: boolean } | null;
  seekOutput?: (outT: number) => void;
  getSourceDurations?: () => Record<string, number>;
  /** Null while the video is loading / a saved framing hasn't been applied yet — the bar must not
   *  seed its clip list before this settles (it would race the restore and wipe saved cuts). */
  getFraming?: () => unknown;
  startDownload: () => Promise<void>;
  cancelExport: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const FPS         = 30;     // reels render at 30fps in the exporter — keep the frame grid consistent
const RULER_H     = 22;
const STRIP_H     = 58;
const NAMEBAR_H   = 15;
const SNAP_PX     = 8;
const EDGE_PX     = 36;
const ZOOM_MAX    = 24;     // max zoom relative to fit
const MIN_CLIP    = 1 / FPS;
const MOVE_PX     = 6;      // pointer travel before a clip press becomes a reorder drag
const HISTORY_LIMIT = 100;

type Thumb = { t: number; url: string };
type Strip = { w: number; frames: Thumb[] };   // w = natural thumbnail width (px @ STRIP_H)
// LRU-capped: each strip is 24-64 JPEG data-URLs (~0.5-1.5MB), and per-source filmstrips multiply
// how fast this fills — unbounded, an editing session across many reels/uploads pinned tens of MB.
const THUMB_CACHE_LIMIT = 12;
const thumbCache = new Map<string, Strip>();
function getCachedStrip(url: string): Strip | undefined {
  const hit = thumbCache.get(url);
  if (hit) { thumbCache.delete(url); thumbCache.set(url, hit); }   // bump LRU
  return hit;
}
function cacheStrip(url: string, strip: Strip): void {
  thumbCache.delete(url);
  thumbCache.set(url, strip);
  while (thumbCache.size > THUMB_CACHE_LIMIT) {
    const oldest = thumbCache.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === url) break;
    thumbCache.delete(oldest);
  }
}

// Nearest extracted frame to a source time (frames are sorted ascending by t).
function frameAt(frames: Thumb[], t: number): string {
  if (!frames.length) return '';
  let best = frames[0], bestD = Math.abs(frames[0].t - t);
  for (let i = 1; i < frames.length; i++) {
    const d = Math.abs(frames[i].t - t);
    if (d < bestD) { bestD = d; best = frames[i]; }
    if (frames[i].t > t) break;
  }
  return best.url;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const qf    = (t: number) => Math.round(t * FPS) / FPS;

function clipsKey(clips: TimelineClip[]): string {
  return clips.map(c => `${c.id}:${c.src}:${c.start.toFixed(3)}:${c.end.toFixed(3)}`).join('|');
}

function fmtTC(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const total = Math.round(t * FPS);
  const f = total % FPS, secs = Math.floor(total / FPS);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

const TICKS = [1 / FPS, 2 / FPS, 5 / FPS, 10 / FPS, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

// Initial timeline for a (re)opened reel: the canvas's live timeline if it has one, else the saved
// multi-cut clips, else a single clip spanning the saved trim range (or the full source).
function seedTimeline(ref: VideoCanvasRef, d: number): ReelTimeline {
  const live = ref.getTimeline?.();
  if (live && live.clips.length) return { sources: live.sources.map(s => ({ ...s })), clips: live.clips.map(c => ({ ...c })) };
  const saved = ref.getSegments?.() ?? null;
  if (saved && saved.length) {
    const clips = [...saved].sort((a, b) => a.start - b.start)
      .map(s => ({ id: mkClipId(), src: MAIN_SRC, start: clamp(s.start, 0, d), end: clamp(s.end, 0, d) }))
      .filter(c => c.end - c.start >= MIN_CLIP);
    if (clips.length) return { sources: [], clips };
  }
  const t = ref.getTrimState();
  const t0 = clamp(t.trimStart || 0, 0, d);
  const t1 = t.trimEnd > t0 ? clamp(t.trimEnd, t0, d) : d;
  return { sources: [], clips: [{ id: mkClipId(), src: MAIN_SRC, start: t0, end: t1 > t0 ? t1 : d }] };
}

// ── Clip ──────────────────────────────────────────────────────────────────────
// The filmstrip is a FIXED-density strip: each thumbnail keeps a constant on-screen
// width (thumbW) and is placed by its source time. The clip is just a window onto it,
// so trimming/resizing reveals or hides whole frames instead of squishing them.
// Tiles are virtualised to the visible scroll window (viewLeft..viewRight, content px).
const Clip = memo(function Clip({
  clipId, label, leftPx, widthPx, dragDX, frames, thumbW, srcIn, effPps, viewLeft, viewRight, selected, settling, onBodyDown, onTrimDown,
}: {
  clipId: string; label: string; leftPx: number; widthPx: number;
  dragDX: number | null;   // non-null while this clip is being reorder-dragged (px offset)
  frames: Thumb[]; thumbW: number; srcIn: number; effPps: number;
  viewLeft: number; viewRight: number; selected: boolean; settling: boolean;
  onBodyDown: (e: React.PointerEvent, clipId: string) => void;
  onTrimDown: (e: React.PointerEvent, clipId: string, side: 'start' | 'end') => void;
}) {
  const showLabel = widthPx >= 56;
  const tw = thumbW > 0 ? thumbW : STRIP_H;
  const nTiles = Math.max(1, Math.ceil(widthPx / tw));
  const i0 = Math.max(0, Math.floor((viewLeft - leftPx) / tw) - 1);
  const i1 = Math.min(nTiles, Math.ceil((viewRight - leftPx) / tw) + 1);
  const tiles: { i: number; url: string }[] = [];
  for (let i = i0; i < i1; i++) {
    const srcT = srcIn + (i * tw + tw / 2) / (effPps || 1);
    tiles.push({ i, url: frameAt(frames, srcT) });
  }
  const dragging = dragDX != null;
  return (
    <div
      className={`group absolute top-0 bottom-0 overflow-hidden rounded-md bg-surface-3 ${dragging ? 'z-40 opacity-90' : selected ? 'z-20' : 'z-10'} ${settling && !dragging ? 'transition-[left,width] duration-150 ease-out' : ''}`}
      style={{ left: leftPx, width: Math.max(2, widthPx), transform: dragging ? `translateX(${dragDX}px)` : undefined }}
      onPointerDown={e => onBodyDown(e, clipId)}
    >
      {tiles.map(({ i, url }) => url && (
        <img key={i} src={url} alt="" draggable={false}
          className="absolute top-0 bottom-0 object-cover block pointer-events-none"
          style={{ left: i * tw, width: tw }} />
      ))}
      {showLabel && (
        <>
          <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/65 to-transparent pointer-events-none" style={{ height: NAMEBAR_H + 4 }} />
          <div className="absolute inset-x-0 top-0 px-1.5 flex items-center justify-between gap-2 pointer-events-none" style={{ height: NAMEBAR_H }}>
            <span className="text-[10px] tabular-nums leading-none text-white/85 truncate">{label}</span>
            <span className="text-[10px] tabular-nums leading-none text-white/65 shrink-0">{fmtTC(effPps > 0 ? widthPx / effPps : 0)}</span>
          </div>
        </>
      )}
      <div className={`absolute inset-0 rounded-md ring-inset pointer-events-none transition-all ${selected ? 'ring-2 ring-accent' : 'ring-1 ring-line-faint'}`} />
      {selected && <div className="absolute inset-0 rounded-md pointer-events-none" style={{ boxShadow: '0 0 0 1px var(--accent-border), 0 0 14px var(--accent-tint)' }} />}
      <div className="absolute inset-y-0 left-0 w-2.5 z-30 cursor-ew-resize opacity-0 group-hover:opacity-100 transition-opacity" onPointerDown={e => onTrimDown(e, clipId, 'start')}>
        <div className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-sm bg-danger" />
      </div>
      <div className="absolute inset-y-0 right-0 w-2.5 z-30 cursor-ew-resize opacity-0 group-hover:opacity-100 transition-opacity" onPointerDown={e => onTrimDown(e, clipId, 'end')}>
        <div className="absolute inset-y-1.5 right-0 w-[3px] rounded-l-sm bg-danger" />
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
interface VideoControlsBarProps {
  entryId:        string | null;
  activeRef:      VideoCanvasRef | null;
  recordingState: RecordingState | null;
  videoSrc:       string | null;
  onHistory?:     (api: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean }) => void;
  // Free-tier export quota gate, threaded from the host so its "N left" counter stays the single
  // source of truth (FREE_TIER_PLAN.md). Resolves false (and shows the upgrade prompt) when the
  // export must not run; absent = export freely.
  guardExport?:   (run: () => void | Promise<void>) => Promise<boolean>;
  // Upload a picked file to durable storage (post-videos) for a new timeline source. Absent (e.g.
  // signed out) hides the Add-video button.
  onUploadSource?: (file: File) => Promise<{ ok: true; url: string } | { ok: false; message: string }>;
}

export function VideoControlsBar({ entryId, activeRef, recordingState, videoSrc, onHistory, guardExport, onUploadSource }: VideoControlsBarProps) {
  const [isPlaying,   setIsPlaying]   = useState(false);
  const [playOut,     setPlayOut]     = useState(0);       // OUTPUT time of the playhead
  const [duration,    setDuration]    = useState(0);       // MAIN source duration
  const [clips,       setClips]       = useState<TimelineClip[]>([]);
  const [sources,     setSources]     = useState<TimelineSource[]>([]);
  const [strips,      setStrips]      = useState<Record<string, Strip>>({});   // srcId → filmstrip
  const [selection,   setSelection]   = useState<string | null>(null);

  const [pps,       setPps]       = useState(0);        // pixels per OUTPUT second (zoom state)
  const [viewportW, setViewportW] = useState(0);
  const [scrollX,   setScrollX]   = useState(0);

  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapLineT,   setSnapLineT]   = useState<number | null>(null);   // output time of the snap line
  const [readout,     setReadout]     = useState<{ t: number; text: string } | null>(null);   // t = OUTPUT time
  const [trimEdge,    setTrimEdge]    = useState<{ clipId: string; side: 'start' | 'end'; out: number; srcIn: number } | null>(null);
  const [moveDrag,    setMoveDrag]    = useState<{ clipId: string; dx: number; gap: number } | null>(null);
  const [settling,    setSettling]    = useState(false);
  const [uploading,   setUploading]   = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Live mirrors for handlers
  const outDurRef      = useRef(0);
  const ppsRef         = useRef(0);
  const fitPpsRef      = useRef(0);
  const playOutRef     = useRef(0);
  const clipsRef       = useRef<TimelineClip[]>([]);
  const sourcesRef     = useRef<TimelineSource[]>([]);
  const layoutRef      = useRef<TimelineLayout>({ items: [], total: 0 });
  const selectionRef   = useRef<string | null>(null);
  const snapEnabledRef = useRef(true);
  const durRef         = useRef(0);
  const srcDursRef     = useRef<Record<string, number>>({});

  // Drag machinery
  const dragRef        = useRef<{
    kind: 'playhead' | 'trim' | 'move';
    clipId?: string;
    side?: 'start' | 'end';
    item?: { out0: number; out1: number; start: number; end: number };
    lo?: number; hi?: number;
    startX?: number; started?: boolean; gap?: number;
  } | null>(null);
  const pendingSrcRef  = useRef<{ start?: number; end?: number } | null>(null);
  const lastClientXRef = useRef(0);
  const autoRafRef     = useRef(0);
  const autoDirRef     = useRef(0);
  const scrollRafRef   = useRef(0);
  const pendingScrollRef = useRef<number | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shuttleRef     = useRef<{ raf: number; rate: number; last: number } | null>(null);

  // Undo / redo — snapshots of {clips, sources}
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const pastRef   = useRef<Array<{ clips: TimelineClip[]; sources: TimelineSource[] }>>([]);
  const futureRef = useRef<Array<{ clips: TimelineClip[]; sources: TimelineSource[] }>>([]);

  const wrapperRef  = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const roRef       = useRef<ResizeObserver | null>(null);
  const activeRefRef = useRef(activeRef);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Which entry an async continuation (the Add-video upload) belongs to, plus whether the bar is
  // still mounted — both checked after the await so a resolution can never mutate a DIFFERENT reel
  // (the bar stays mounted across entry switches; refs re-point at the new entry).
  const entryIdRef = useRef(entryId);
  useEffect(() => { entryIdRef.current = entryId; });
  const barAliveRef = useRef(true);
  useEffect(() => { barAliveRef.current = true; return () => { barAliveRef.current = false; }; }, []);

  useEffect(() => { activeRefRef.current = activeRef; });
  useEffect(() => { clipsRef.current  = clips;  }, [clips]);
  useEffect(() => { sourcesRef.current = sources; }, [sources]);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  useEffect(() => { snapEnabledRef.current = snapEnabled; }, [snapEnabled]);
  useEffect(() => { playOutRef.current = playOut; }, [playOut]);
  // Sync the output layout + fit/pps into refs so pointer/keyboard handlers read
  // current values without touching refs during render.
  useEffect(() => {
    const L = buildTimelineLayout(clips);
    layoutRef.current = L; outDurRef.current = L.total;
    fitPpsRef.current = viewportW > 0 && L.total > 0 ? viewportW / L.total : 0;
  }, [clips, viewportW]);
  useEffect(() => {
    const total = buildTimelineLayout(clips).total;
    const fp = viewportW > 0 && total > 0 ? viewportW / total : 0;
    ppsRef.current = pps > 0 ? clamp(pps, fp, fp * ZOOM_MAX) : fp;
  }, [pps, clips, viewportW]);

  const hasRef = !!activeRef;

  const setViewportNode = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    roRef.current?.disconnect();
    if (node) {
      setViewportW(node.clientWidth);
      const ro = new ResizeObserver(() => setViewportW(node.clientWidth));
      ro.observe(node); roRef.current = ro;
    }
  }, []);
  useEffect(() => () => { roRef.current?.disconnect(); if (settleTimerRef.current) clearTimeout(settleTimerRef.current); }, []);

  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (vp && pendingScrollRef.current != null) {
      vp.scrollLeft = clamp(pendingScrollRef.current, 0, vp.scrollWidth - vp.clientWidth);
      pendingScrollRef.current = null;
      setScrollX(vp.scrollLeft);
    }
  }, [pps, viewportW]);

  // Push the current clip list into the canvas sequencer (playback + persistence single source of truth).
  const syncToCanvas = useCallback((next: { clips: TimelineClip[]; sources: TimelineSource[] }) => {
    activeRefRef.current?.setTimeline?.({ sources: next.sources, clips: next.clips });
  }, []);

  // ── Entry change ────────────────────────────────────────────────────────────
  // Synchronous setState is intentional: resync all local state to the new reel.
  useEffect(() => {
    const ref = activeRefRef.current;
    if (!ref) return;
    const state = ref.getTrimState();
    setPps(0); setSelection(null); setStrips({}); setSnapLineT(null); setReadout(null); setTrimEdge(null); setMoveDrag(null);
    setClips([]); clipsRef.current = [];
    setSources([]); sourcesRef.current = [];
    setUploadError(null);
    pastRef.current = []; futureRef.current = [];
    setUndoDepth(0); setRedoDepth(0);
    // durRef resets WITH the entry — leaving the previous reel's duration in place would let the
    // deferred seed build the new reel's first clip against the wrong length.
    durRef.current = 0;
    setDuration(0); setPlayOut(0); setIsPlaying(false);

    const v = ref.getVideoElement();
    const d = (v && v.duration && isFinite(v.duration)) ? v.duration : state.duration > 0 ? state.duration : 0;
    if (d > 0) {
      durRef.current = d;
      setDuration(d);
    }
    // Clips are NOT seeded here: seeding waits (in the rAF sync below) until the canvas has applied
    // any saved framing — getFraming() is null until then. Seeding at mount raced applyFraming and
    // let a placeholder single clip wipe a restored multi-clip timeline on the user's first edit.
  }, [entryId, hasRef]);

  // Adopt a timeline that changed OUTSIDE the bar — a saved-framing restore finishing after mount,
  // Reset trim clearing the canvas timeline, a multi-tab adoption. Foreign state invalidates the
  // undo stack (its snapshots would resurrect what the external change removed).
  const adoptExternal = useCallback((t: ReelTimeline) => {
    setClips(t.clips); clipsRef.current = t.clips;
    setSources(t.sources); sourcesRef.current = t.sources;
    setSelection(sel => (sel && t.clips.some(c => c.id === sel)) ? sel : null);
    pastRef.current = []; futureRef.current = [];
    setUndoDepth(0); setRedoDepth(0);
    syncToCanvas(t);
  }, [syncToCanvas]);

  // ── Playback follow + canvas↔bar timeline sync (rAF) ────────────────────────
  // The sequencer owns playback (it may be playing an extra source's element), so the playhead
  // follows ref.getPlayback() rather than <video> events — also buttery vs 4Hz timeupdate.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const ref = activeRefRef.current;
      if (!ref) return;
      const durs = ref.getSourceDurations?.();
      if (durs) srcDursRef.current = durs;

      // Main-video duration can arrive late (the <video> may not even be mounted when the
      // durationchange effect binds, and that effect never re-fires) — poll it here so the seed
      // and trim clamps always see the CURRENT reel's real length.
      const vd = ref.getVideoElement()?.duration;
      if (typeof vd === 'number' && isFinite(vd) && vd > 0 && durRef.current !== vd) {
        durRef.current = vd;
        setDuration(vd);
      }

      // Timeline sync — never mid-drag (a trim/move/scrub owns the state until pointer-up).
      // Identity-based: our own commits store OUR clip array in the canvas, so a mismatch is
      // always an external change.
      if (!dragRef.current) {
        const ct = ref.getTimeline?.() ?? null;
        if (clipsRef.current.length === 0) {
          // Initial seed — deferred until the canvas has applied any saved framing (getFraming()
          // null until then), so a placeholder can never wipe a restored multi-clip timeline.
          const d = durRef.current;
          if (d > 0 && (ref.getFraming?.() ?? null) != null) adoptExternal(seedTimeline(ref, d));
        } else if (ct && ct.clips !== clipsRef.current) {
          adoptExternal({ sources: ct.sources.map(s => ({ ...s })), clips: ct.clips.map(c => ({ ...c })) });
        } else if (!ct) {
          // Canvas timeline cleared externally (Adjust → Reset trim): re-seed from the reset trim
          // state instead of keeping (and later re-committing) the deleted clips.
          const d = durRef.current;
          if (d > 0) adoptExternal(seedTimeline(ref, d));
        }
      }

      const pb = ref.getPlayback?.();
      if (!pb) return;
      setIsPlaying(prev => (prev === pb.playing ? prev : pb.playing));
      if (dragRef.current?.kind === 'playhead') return;   // the drag owns the playhead position
      if (Math.abs(pb.outT - playOutRef.current) >= 1 / (2 * FPS)) {
        playOutRef.current = pb.outT;
        setPlayOut(pb.outT);
        // Keep the playhead in view while playing (trail-scroll like editors do).
        if (pb.playing) {
          const vp = viewportRef.current, p = ppsRef.current;
          if (vp && p > 0) {
            const x = pb.outT * p;
            if (x < vp.scrollLeft || x > vp.scrollLeft + vp.clientWidth)
              vp.scrollLeft = clamp(x - vp.clientWidth * 0.15, 0, vp.scrollWidth - vp.clientWidth);
          }
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [entryId, hasRef, adoptExternal]);

  // ── Late main-video metadata ────────────────────────────────────────────────
  // Duration bookkeeping only — seeding happens in the rAF sync once getFraming() settles, and
  // metadata (duration) always lands before loadeddata, so the seed never sees a stale duration.
  useEffect(() => {
    const ref = activeRefRef.current;
    if (!ref) return;
    const v = ref.getVideoElement();
    if (!v) return;
    const onDur = () => {
      if (!v.duration || !isFinite(v.duration)) return;
      durRef.current = v.duration;
      setDuration(v.duration);
    };
    v.addEventListener('durationchange', onDur);
    if (v.readyState >= 1 && v.duration && isFinite(v.duration)) onDur();
    return () => v.removeEventListener('durationchange', onDur);
  }, [entryId, hasRef]);

  // ── Filmstrip thumbnails per source (lazy, cached, DPR-aware, letterbox-cropped) ──
  useEffect(() => {
    if (!videoSrc || duration <= 0) return;
    const jobs: { srcId: string; url: string; isMain: boolean }[] = [
      { srcId: MAIN_SRC, url: videoSrc, isMain: true },
      ...sources.map(s => ({ srcId: s.id, url: s.url, isMain: false })),
    ];
    const vpW = viewportRef.current?.clientWidth ?? 0;
    let cancelled = false;
    // The in-flight extraction's element, reachable from the effect CLEANUP: the per-call finally
    // can't run while an await is stalled (e.g. a network-streamed source whose 'seeked' never
    // fires after a connection drop), and without this the hidden <video> + object URL leaked and
    // the sequential source loop hung forever.
    let live: { vid: HTMLVideoElement; blobUrl: string } | null = null;

    const extract = async ({ srcId, url, isMain }: { srcId: string; url: string; isMain: boolean }) => {
      const cached = getCachedStrip(url);
      if (cached) { if (!cancelled) setStrips(prev => (prev[srcId] === cached ? prev : { ...prev, [srcId]: cached })); return; }

      let blobUrl = '';
      const vid = document.createElement('video');
      vid.muted = true; vid.preload = 'auto'; vid.playsInline = true;
      live = { vid, blobUrl: '' };
      // Bounded: resolve after 8s even if 'seeked' never fires, so one stalled seek can't wedge
      // the whole extraction pipeline (the frame is simply skipped/reused).
      const seekDraw = (t: number) => new Promise<void>(res => {
        const onS = () => { vid.removeEventListener('seeked', onS); clearTimeout(timer); res(); };
        const timer = setTimeout(onS, 8000);
        vid.addEventListener('seeked', onS);
        vid.currentTime = t;
      });
      try {
        // Download once via the shared blob cache (the canvas reuses the same Blob for
        // fast, network-free scrubbing). Fall back to a direct (CORS) src if it fails.
        // A blob: src is ALREADY a local upload — seeking hits memory — so never re-download it.
        const isLocal = url.startsWith('blob:');
        const blob = isLocal ? null : await getVideoBlob(url);
        if (cancelled) return;
        if (blob) {
          blobUrl = URL.createObjectURL(blob);
          if (live?.vid === vid) live.blobUrl = blobUrl;
          vid.src = blobUrl;
          if (isMain) activeRefRef.current?.useLocalBlob?.();   // file is now local — swap the canvas for fast seeks
        } else if (isLocal) {
          vid.src = url;
        } else { vid.crossOrigin = 'anonymous'; vid.src = url; }
        await new Promise<void>((res, rej) => {
          const onErr = () => rej(new Error('load failed'));
          if (vid.readyState >= 1) { vid.removeEventListener('error', onErr); res(); return; }
          vid.addEventListener('loadedmetadata', () => { vid.removeEventListener('error', onErr); res(); }, { once: true });
          vid.addEventListener('error', onErr, { once: true });
        }).catch(() => null);
        if (cancelled || !vid.videoWidth) return;
        const vW = vid.videoWidth, vH = vid.videoHeight;
        const srcDur = isFinite(vid.duration) && vid.duration > 0 ? vid.duration : duration;

        let bandTop = 0, bandBot = 1;
        try {
          const aw = 24, ah = 192;
          const ac = document.createElement('canvas'); ac.width = aw; ac.height = ah;
          const actx = ac.getContext('2d', { willReadFrequently: true })!;
          let uTop = 1, uBot = 0, ok = false;
          for (const frac of [0.25, 0.5, 0.75]) {
            if (cancelled) break;
            await seekDraw(srcDur * frac);
            actx.drawImage(vid, 0, 0, aw, ah);
            const data = actx.getImageData(0, 0, aw, ah).data;
            let t0 = -1, t1 = -1;
            for (let y = 0; y < ah; y++) {
              let s = 0;
              for (let x = 0; x < aw; x++) { const i = (y * aw + x) * 4; s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }
              if (s / aw > 14) { if (t0 < 0) t0 = y; t1 = y; }
            }
            if (t0 >= 0) {
              const top = t0 / ah, bot = (t1 + 1) / ah;
              if (bot - top >= 0.25) { uTop = Math.min(uTop, top); uBot = Math.max(uBot, bot); ok = true; }
            }
          }
          if (ok && (uTop > 0.04 || uBot < 0.96)) { bandTop = uTop; bandBot = uBot; }
        } catch { /* tainted → keep full frame */ }
        if (cancelled) return;

        const sx = 0, sw = vW, sy = Math.round(bandTop * vH), sh = Math.max(1, Math.round((bandBot - bandTop) * vH));
        const thumbCssW = STRIP_H * (sw / sh);
        // Denser than "just fill the viewport at fit" so the fixed-width strip still has
        // distinct frames when zoomed in or split into small clips (bounded for decode cost).
        const fitTiles = (vpW || thumbCssW * 16) / thumbCssW;
        const count = Math.max(24, Math.min(64, Math.round(Math.max(fitTiles * 2.5, srcDur / 10))));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const off = document.createElement('canvas');
        off.width  = Math.round(thumbCssW * dpr);
        off.height = Math.round(STRIP_H * dpr);
        const ctx = off.getContext('2d')!;
        const results: Thumb[] = [];
        for (let i = 0; i < count; i++) {
          if (cancelled) break;
          const t = (i / (count - 1)) * srcDur;
          await seekDraw(t);
          try { ctx.drawImage(vid, sx, sy, sw, sh, 0, 0, off.width, off.height); results.push({ t, url: off.toDataURL('image/jpeg', 0.72) }); }
          catch { /* tainted */ }
          if (!cancelled && (i % 6 === 5 || i === count - 1)) {
            const partial = { w: thumbCssW, frames: [...results] };
            setStrips(prev => ({ ...prev, [srcId]: partial }));
          }
        }
        if (!cancelled && results.length) {
          const done = { w: thumbCssW, frames: results };
          cacheStrip(url, done);
          setStrips(prev => ({ ...prev, [srcId]: done }));
        }
      } finally {
        vid.src = ''; if (blobUrl) URL.revokeObjectURL(blobUrl);
        if (live?.vid === vid) live = null;
      }
    };

    // Sequential, main first: thumbnail extraction seeks aggressively; running several sources at
    // once would thrash decode. Each source is cached, so re-runs are instant.
    void (async () => { for (const job of jobs) { if (cancelled) break; await extract(job); } })();
    return () => {
      cancelled = true;
      // Abort the in-flight extraction element too — a pending await inside extract() would keep
      // it (and its object URL) alive past unmount/dep-change otherwise. Double-teardown with the
      // finally above is harmless (re-clearing src / re-revoking is a no-op).
      if (live) {
        live.vid.src = '';
        if (live.blobUrl) URL.revokeObjectURL(live.blobUrl);
        live = null;
      }
    };
  }, [entryId, videoSrc, duration, sources]);

  // ── Coordinate transforms (OUTPUT time) ─────────────────────────────────────
  // Visual↔layout pixel ratio of the timeline viewport. The app's page view-zoom (CSS zoom on an
  // ancestor) renders layout px at a different visual size, and pointer clientX arrives in VISUAL
  // px while scrollLeft/pps/element positions are LAYOUT px — mixing them shifted every pointer-
  // derived position (playhead, trim edges, drop indicator) by the zoom factor. Measuring the real
  // on-screen ratio folds in any zoom/scale, same pattern as the canvas crop-drag (useDrag).
  const viewScale = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || vp.offsetWidth === 0) return 1;
    return (vp.getBoundingClientRect().width / vp.offsetWidth) || 1;
  }, []);
  const timeOfX = useCallback((clientX: number) => {
    const vp = viewportRef.current, p = ppsRef.current;
    if (!vp || p <= 0) return 0;
    const r = vp.getBoundingClientRect();
    return clamp(((clientX - r.left) / viewScale() + vp.scrollLeft) / p, 0, outDurRef.current);
  }, [viewScale]);

  const snapOut = useCallback((targetOut: number, excludeClipId?: string) => {
    if (!snapEnabledRef.current) return { t: targetOut, at: null as number | null };
    const p = ppsRef.current;
    const cands: number[] = [0, outDurRef.current, playOutRef.current];
    for (const it of layoutRef.current.items) { if (it.clip.id === excludeClipId) continue; cands.push(it.out0, it.out1); }
    let best: number | null = null, bestD = Infinity;
    for (const c of cands) { const d = Math.abs(targetOut - c) * p; if (d <= SNAP_PX && d < bestD) { bestD = d; best = c; } }
    return best == null ? { t: targetOut, at: null } : { t: best, at: best };
  }, []);

  const seekOut = useCallback((outT: number) => {
    const t = clamp(outT, 0, outDurRef.current);
    playOutRef.current = t; setPlayOut(t);
    activeRefRef.current?.seekOutput?.(t);
  }, []);

  // ── Editing ops ──────────────────────────────────────────────────────────────
  const pushHistory = useCallback(() => {
    pastRef.current = [...pastRef.current, { clips: clipsRef.current, sources: sourcesRef.current }].slice(-HISTORY_LIMIT);
    futureRef.current = [];
    setUndoDepth(pastRef.current.length); setRedoDepth(0);
  }, []);
  const applyState = useCallback((next: { clips: TimelineClip[]; sources: TimelineSource[] }) => {
    setClips(next.clips); clipsRef.current = next.clips;
    setSources(next.sources); sourcesRef.current = next.sources;
    setSelection(sel => (sel && next.clips.some(c => c.id === sel)) ? sel : null);
    syncToCanvas(next);
  }, [syncToCanvas]);
  const commit = useCallback((nextClips: TimelineClip[], nextSources?: TimelineSource[]) => {
    const ns = nextSources ?? sourcesRef.current;
    if (clipsKey(clipsRef.current) === clipsKey(nextClips) && ns === sourcesRef.current) return;
    pushHistory();
    applyState({ clips: nextClips, sources: ns });
    setSettling(true);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => setSettling(false), 170);
  }, [pushHistory, applyState]);
  const undo = useCallback(() => {
    if (pastRef.current.length === 0) return;
    const prev = pastRef.current[pastRef.current.length - 1];
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [...futureRef.current, { clips: clipsRef.current, sources: sourcesRef.current }];
    setUndoDepth(pastRef.current.length); setRedoDepth(futureRef.current.length);
    applyState(prev);
  }, [applyState]);
  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const nxt = futureRef.current[futureRef.current.length - 1];
    futureRef.current = futureRef.current.slice(0, -1);
    pastRef.current = [...pastRef.current, { clips: clipsRef.current, sources: sourcesRef.current }];
    setUndoDepth(pastRef.current.length); setRedoDepth(futureRef.current.length);
    applyState(nxt);
  }, [applyState]);

  // ── Drag application ────────────────────────────────────────────────────────
  const applyDrag = useCallback((clientX: number) => {
    const drag = dragRef.current; if (!drag) return;
    const raw = timeOfX(clientX);

    if (drag.kind === 'playhead') {
      const { t, at } = snapOut(raw);
      setSnapLineT(at); setReadout({ t, text: fmtTC(t) });
      seekOut(qf(t));
      return;
    }

    if (drag.kind === 'move') {
      // Layout px: the dx becomes a translateX on a layout-positioned clip, so a visual-px delta
      // would lag the pointer under page view-zoom.
      const dx = (clientX - (drag.startX ?? clientX)) / viewScale();
      if (!drag.started && Math.abs(dx) < MOVE_PX) return;
      drag.started = true;
      // Insertion gap: count the OTHER clips whose midpoint lies left of the pointer. Kept on the
      // drag ref (synchronous truth for pointer-up) — moveDrag state only drives the visuals.
      const items = layoutRef.current.items.filter(it => it.clip.id !== drag.clipId);
      let gap = 0;
      for (const it of items) if ((it.out0 + it.out1) / 2 < raw) gap += 1;
      drag.gap = gap;
      setMoveDrag({ clipId: drag.clipId!, dx, gap });
      return;
    }

    // Trim — pure preview (no clip mutation until pointer-up); the OPPOSITE edge
    // stays fixed so the dragged edge follows the cursor and nothing reflows mid-drag.
    const it = drag.item!;
    const { t: snapped, at } = snapOut(raw, drag.clipId);
    if (drag.side === 'start') {
      let ns = it.start + (snapped - it.out0);
      ns = clamp(qf(ns), drag.lo!, it.end - MIN_CLIP);
      const edgeOut = it.out0 + (ns - it.start);
      pendingSrcRef.current = { start: ns };
      setTrimEdge({ clipId: drag.clipId!, side: 'start', out: edgeOut, srcIn: ns });
      setReadout({ t: edgeOut, text: fmtTC(edgeOut) });
    } else {
      let ne = it.start + (snapped - it.out0);
      ne = clamp(qf(ne), it.start + MIN_CLIP, drag.hi!);
      const edgeOut = it.out0 + (ne - it.start);
      pendingSrcRef.current = { end: ne };
      setTrimEdge({ clipId: drag.clipId!, side: 'end', out: edgeOut, srcIn: ne });
      setReadout({ t: edgeOut, text: fmtTC(edgeOut) });
    }
    setSnapLineT(at);
  }, [timeOfX, snapOut, seekOut, viewScale]);

  const stopAutoScroll = useCallback(() => {
    if (autoRafRef.current) cancelAnimationFrame(autoRafRef.current);
    autoRafRef.current = 0; autoDirRef.current = 0;
  }, []);
  const updateAutoScroll = useCallback((clientX: number) => {
    const vp = viewportRef.current; if (!vp) return;
    const r = vp.getBoundingClientRect();
    autoDirRef.current = clientX < r.left + EDGE_PX ? -1 : clientX > r.right - EDGE_PX ? 1 : 0;
    if (autoDirRef.current !== 0 && !autoRafRef.current) {
      const loop = () => {
        const dir = autoDirRef.current;
        if (dir === 0 || !dragRef.current) { autoRafRef.current = 0; return; }
        vp.scrollLeft = clamp(vp.scrollLeft + dir * 16, 0, vp.scrollWidth - vp.clientWidth);
        setScrollX(vp.scrollLeft);
        applyDrag(lastClientXRef.current);
        autoRafRef.current = requestAnimationFrame(loop);
      };
      autoRafRef.current = requestAnimationFrame(loop);
    }
  }, [applyDrag]);

  // ── Global pointer move/up ──────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      lastClientXRef.current = e.clientX;
      applyDrag(e.clientX);
      updateAutoScroll(e.clientX);
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      stopAutoScroll();
      dragRef.current = null;
      setSnapLineT(null); setReadout(null);
      if (drag.kind === 'trim' && pendingSrcRef.current) {
        const p = pendingSrcRef.current; pendingSrcRef.current = null;
        commit(clipsRef.current.map(c => c.id === drag.clipId
          ? { ...c, ...(p.start != null ? { start: p.start } : {}), ...(p.end != null ? { end: p.end } : {}) }
          : c));
      } else if (drag.kind === 'move' && drag.started && drag.gap != null) {
        const cur = clipsRef.current;
        const from = cur.findIndex(c => c.id === drag.clipId);
        if (from >= 0) {
          const without = cur.filter(c => c.id !== drag.clipId);
          commit([...without.slice(0, drag.gap), cur[from], ...without.slice(drag.gap)]);
        }
        setMoveDrag(null);
      }
      setTrimEdge(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [applyDrag, updateAutoScroll, stopAutoScroll, commit]);

  // ── Pointer-down entry points ───────────────────────────────────────────────
  const onRulerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault(); wrapperRef.current?.focus();
    dragRef.current = { kind: 'playhead' };
    lastClientXRef.current = e.clientX;
    applyDrag(e.clientX); updateAutoScroll(e.clientX);
  }, [applyDrag, updateAutoScroll]);
  const onTrackBgDown = useCallback((e: React.PointerEvent) => { setSelection(null); onRulerDown(e); }, [onRulerDown]);
  // A clip press selects immediately; travelling MOVE_PX turns it into a reorder drag (CapCut-style).
  const onClipBodyDown = useCallback((e: React.PointerEvent, clipId: string) => {
    e.stopPropagation(); wrapperRef.current?.focus(); setSelection(clipId);
    dragRef.current = { kind: 'move', clipId, startX: e.clientX, started: false };
    lastClientXRef.current = e.clientX;
  }, []);
  const onTrimDown = useCallback((e: React.PointerEvent, clipId: string, side: 'start' | 'end') => {
    e.stopPropagation(); wrapperRef.current?.focus(); setSelection(clipId);
    const L = layoutRef.current;
    const idx = L.items.findIndex(it => it.clip.id === clipId); if (idx < 0) return;
    const item = L.items[idx];
    const clip = item.clip;
    // Clips are independent windows into their sources (reordering breaks any source-order
    // relationship between neighbors), so an edge may travel the whole source.
    const srcDur = srcDursRef.current[clip.src] ?? (clip.src === MAIN_SRC ? durRef.current : 0);
    dragRef.current = {
      kind: 'trim', clipId, side,
      item: { out0: item.out0, out1: item.out1, start: clip.start, end: clip.end },
      lo: 0, hi: srcDur > 0 ? srcDur : clip.end,
    };
    pendingSrcRef.current = null;
    lastClientXRef.current = e.clientX;
    updateAutoScroll(e.clientX);
  }, [updateAutoScroll]);

  // ── Zoom (px per output second) ─────────────────────────────────────────────
  const zoomTo = useCallback((nextPps: number, anchorOut: number) => {
    const vp = viewportRef.current;
    const np = clamp(nextPps, fitPpsRef.current, fitPpsRef.current * ZOOM_MAX);
    if (!vp) { setPps(np); return; }
    const oldPps = ppsRef.current;
    pendingScrollRef.current = anchorOut * np - (anchorOut * oldPps - vp.scrollLeft);
    setPps(np);
  }, []);
  const zoomBy  = useCallback((f: number) => zoomTo(ppsRef.current * f, playOutRef.current), [zoomTo]);
  const zoomFit = useCallback(() => { pendingScrollRef.current = 0; setPps(fitPpsRef.current); }, []);
  const onViewportScroll = useCallback(() => {
    const vp = viewportRef.current; if (!vp || scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => { scrollRafRef.current = 0; setScrollX(vp.scrollLeft); });
  }, []);
  useEffect(() => {
    const vp = viewportRef.current; if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      zoomTo(ppsRef.current * (e.deltaY < 0 ? 1.15 : 1 / 1.15), timeOfX(e.clientX));
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [viewportW, zoomTo, timeOfX]);

  const cutAtPlayhead = useCallback(() => {
    const at = timelineAtOut(playOutRef.current, layoutRef.current);
    if (!at) return;
    const cur = clipsRef.current;
    const clip = cur[at.index];
    const t = qf(at.srcT);
    if (!clip || t <= clip.start + MIN_CLIP || t >= clip.end - MIN_CLIP) return;
    commit([
      ...cur.slice(0, at.index),
      { ...clip, id: `${clip.id}a`, end: t },
      { ...clip, id: `${clip.id}b`, start: t },
      ...cur.slice(at.index + 1),
    ]);
  }, [commit]);
  const removeClip = useCallback((clipId: string) => {
    const cur = clipsRef.current;
    if (cur.length <= 1) return;
    setSelection(null);
    const next = cur.filter(c => c.id !== clipId);
    // Drop sources no clip references anymore (they'd otherwise pin storage refs in the framing).
    const used = new Set(next.map(c => c.src));
    commit(next, sourcesRef.current.filter(s => used.has(s.id)));
  }, [commit]);
  const trimToPlayhead = useCallback((side: 'in' | 'out') => {
    const at = timelineAtOut(playOutRef.current, layoutRef.current);
    if (!at) return;
    const cur = clipsRef.current;
    const clip = cur[at.index];
    const t = qf(at.srcT);
    if (!clip || t <= clip.start || t >= clip.end) return;
    commit(cur.map((c, i) => i === at.index
      ? (side === 'in' ? { ...c, start: Math.min(t, c.end - MIN_CLIP) } : { ...c, end: Math.max(t, c.start + MIN_CLIP) })
      : c));
  }, [commit]);

  // ── Add video (upload a new source, appended as a clip) ─────────────────────
  const handleUploadFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onUploadSource) return;
    // Never commit onto an UNSEEDED timeline: before the deferred seed lands (main video still
    // buffering), clipsRef is empty and `[...clipsRef.current, clip]` would produce a timeline
    // containing ONLY the upload — silently dropping the main video, durably via autosave. The
    // button is disabled until seeded; this guards the file-picker race.
    if (clipsRef.current.length === 0) { setUploadError('Wait for the video to finish loading, then add clips.'); return; }
    // The reel this upload belongs to. The bar stays MOUNTED across entry switches (clipsRef &
    // friends re-point at the newly selected reel), so without this guard a slow upload would
    // append its clip to whichever reel happened to be selected when it resolved.
    const forEntry = entryIdRef.current;
    setUploadError(null);
    setUploading(true);
    try {
      // Probe the file locally for its duration (needed for the clip window) while it uploads.
      const probeUrl = URL.createObjectURL(file);
      const probe = new Promise<number>(resolve => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => resolve(isFinite(v.duration) ? v.duration : 0);
        v.onerror = () => resolve(0);
        v.src = probeUrl;
      });
      const [result, probedDur] = await Promise.all([onUploadSource(file), probe]);
      URL.revokeObjectURL(probeUrl);
      if (!barAliveRef.current) return;   // timeline closed mid-upload — the file stays as an accepted orphan
      if (entryIdRef.current !== forEntry) {
        setUploadError('The upload finished after you switched reels, so it wasn’t added — use Add video again on the reel you want it in.');
        return;
      }
      if (!result.ok) { setUploadError(result.message); return; }
      if (probedDur <= MIN_CLIP) { setUploadError('That file doesn’t look like a playable video.'); return; }
      // Re-check after the await: an entry switch mid-upload can reset clips to [] (unseeded again).
      if (clipsRef.current.length === 0) { setUploadError('Wait for the video to finish loading, then add clips.'); return; }
      // The durable URL is the source of truth (it persists); prime the blob cache with the local
      // file so the sequencer + filmstrip read it from memory instead of re-downloading it.
      primeVideoBlob(result.url, file);
      const source: TimelineSource = { id: `src-${Date.now().toString(36)}`, url: result.url, name: file.name };
      const clip: TimelineClip = { id: mkClipId(), src: source.id, start: 0, end: probedDur };
      commit([...clipsRef.current, clip], [...sourcesRef.current, source]);
    } finally {
      if (barAliveRef.current) setUploading(false);
    }
  }, [onUploadSource, commit]);

  // Step through the OUTPUT (skips removed source ranges, crosses clips/sources)
  const stepFrames = useCallback((n: number) => {
    seekOut(qf(playOutRef.current + n / FPS));
  }, [seekOut]);
  const gotoEdit = useCallback((dir: 1 | -1) => {
    const edges = new Set<number>([0, outDurRef.current]);
    for (const it of layoutRef.current.items) { edges.add(it.out0); edges.add(it.out1); }
    const sorted = [...edges].sort((a, b) => a - b);
    const cur = playOutRef.current;
    const target = dir > 0 ? sorted.find(e => e > cur + 1e-4) : [...sorted].reverse().find(e => e < cur - 1e-4);
    if (target != null) seekOut(target);
  }, [seekOut]);

  const stopShuttle = useCallback(() => {
    if (shuttleRef.current?.raf) cancelAnimationFrame(shuttleRef.current.raf);
    shuttleRef.current = null;
    const v = activeRefRef.current?.getVideoElement();
    if (v) v.playbackRate = 1;
  }, []);
  const shuttleFwd = useCallback(() => {
    // Rate applies to the MAIN element only (extras play at 1x) — good enough for a shuttle.
    const v = activeRefRef.current?.getVideoElement(); if (!v) return;
    stopShuttle();
    v.playbackRate = v.paused || v.playbackRate >= 4 ? 1 : Math.min(4, v.playbackRate * 2);
    activeRefRef.current?.play();
  }, [stopShuttle]);
  const shuttleRev = useCallback(() => {
    const rate = Math.min(8, (shuttleRef.current?.rate ?? 1) * 2);
    if (shuttleRef.current?.raf) cancelAnimationFrame(shuttleRef.current.raf);
    activeRefRef.current?.pause();
    const st = { raf: 0, rate, last: performance.now() };
    shuttleRef.current = st;
    const loop = (ts: number) => {
      if (shuttleRef.current !== st) return;
      const dt = (ts - st.last) / 1000; st.last = ts;
      const t = playOutRef.current - st.rate * dt;
      if (t <= 0) { seekOut(0); stopShuttle(); return; }
      seekOut(t);
      st.raf = requestAnimationFrame(loop);
    };
    st.raf = requestAnimationFrame(loop);
  }, [seekOut, stopShuttle]);
  useEffect(() => () => stopShuttle(), [stopShuttle]);

  // ── Keyboard (scoped to the timeline) ───────────────────────────────────────
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey) return;
    const ref = activeRefRef.current; if (!ref) return;
    const hit = () => { e.preventDefault(); e.stopPropagation(); };
    switch (e.key) {
      case ' ':         hit(); stopShuttle(); { const pb = ref.getPlayback?.(); if (pb?.playing) ref.pause(); else ref.play(); } break;
      case 'ArrowLeft': hit(); stepFrames(e.shiftKey ? -5 : -1); break;
      case 'ArrowRight':hit(); stepFrames(e.shiftKey ? 5 : 1); break;
      case 'ArrowUp':   hit(); gotoEdit(-1); break;
      case 'ArrowDown': hit(); gotoEdit(1); break;
      case 'Home':      hit(); seekOut(0); break;
      case 'End':       hit(); seekOut(outDurRef.current); break;
      case 'c': case 'C': case 'b': case 'B': hit(); cutAtPlayhead(); break;
      case 's': case 'S': hit(); setSnapEnabled(x => !x); break;
      case 'i': case 'I': hit(); trimToPlayhead('in'); break;
      case 'o': case 'O': hit(); trimToPlayhead('out'); break;
      case 'l': case 'L': hit(); shuttleFwd(); break;
      case 'k': case 'K': hit(); stopShuttle(); ref.pause(); break;
      case 'j': case 'J': hit(); shuttleRev(); break;
      case '\\':        hit(); zoomFit(); break;
      case '=': case '+': hit(); zoomBy(1.5); break;
      case '-': case '_': hit(); zoomBy(1 / 1.5); break;
      case 'Delete': case 'Backspace':
        if (selectionRef.current && clipsRef.current.length > 1) { hit(); removeClip(selectionRef.current); } break;
      case 'Escape': if (selectionRef.current) { hit(); setSelection(null); } break;
    }
  }, [seekOut, stepFrames, gotoEdit, cutAtPlayhead, removeClip, trimToPlayhead, shuttleFwd, shuttleRev, stopShuttle, zoomFit, zoomBy]);

  useEffect(() => {
    onHistory?.({ undo, redo, canUndo: undoDepth > 0, canRedo: redoDepth > 0 });
    return () => onHistory?.({ undo: () => {}, redo: () => {}, canUndo: false, canRedo: false });
  }, [onHistory, undo, redo, undoDepth, redoDepth]);

  if (!activeRef || duration <= 0) return null;

  // ── Derived layout / geometry (OUTPUT time) ─────────────────────────────────
  // Clips are NOT mutated mid-trim (trim is a pure preview via trimEdge), so the
  // committed layout is also the "frozen" layout during a drag — no extra state needed.
  const committed = buildTimelineLayout(clips);
  const totalOut  = committed.total;
  const fitPps    = viewportW > 0 && totalOut > 0 ? viewportW / totalOut : 0;
  const effPps    = pps > 0 ? clamp(pps, fitPps, fitPps * ZOOM_MAX) : fitPps;

  const isRecording = recordingState?.isRecording ?? false;
  const recProgress = recordingState?.recProgress ?? 0;
  const recStatus   = recordingState?.recStatus   ?? '';

  const contentW = totalOut * effPps;
  const X        = (outT: number) => outT * effPps;

  // Clip rects + the source in-point the strip should start from. The in-progress trim
  // edge is applied as a pure visual override (srcIn shifts for a head-trim preview).
  const sourceName = (src: string) => src === MAIN_SRC ? null : (sources.find(s => s.id === src)?.name ?? null);
  const renderItems = committed.items.map((it, i) => {
    let o0 = it.out0, o1 = it.out1, srcIn = it.clip.start;
    if (trimEdge && it.clip.id === trimEdge.clipId) {
      if (trimEdge.side === 'start') { o0 = trimEdge.out; srcIn = trimEdge.srcIn; }
      else o1 = trimEdge.out;
    }
    const name = sourceName(it.clip.src);
    return {
      clip: it.clip,
      label: name ? `${i + 1} · ${name}` : `Clip ${i + 1}`,
      srcIn, leftPx: X(o0), widthPx: X(o1 - o0),
    };
  });

  // Reorder indicator: the boundary of the target gap among the OTHER clips.
  let moveIndicatorX: number | null = null;
  if (moveDrag) {
    const others = committed.items.filter(it => it.clip.id !== moveDrag.clipId);
    moveIndicatorX = moveDrag.gap <= 0 ? 0
      : moveDrag.gap >= others.length ? X(totalOut)
      : X(others[moveDrag.gap - 1].out1);
  }

  const atFit = effPps <= fitPps * 1.0001;

  // Ruler ticks (virtualised to the visible window) in OUTPUT time
  const visStart = effPps > 0 ? (scrollX - 80) / effPps : 0;
  const visEnd   = effPps > 0 ? (scrollX + viewportW + 80) / effPps : totalOut;
  const majInt   = TICKS.find(iv => iv * effPps >= 76) ?? TICKS[TICKS.length - 1];
  const minInt   = majInt / (majInt < 1 ? 1 : 5);
  const ticks: { t: number; major: boolean }[] = [];
  if (effPps > 0) {
    const first = Math.max(0, Math.floor(visStart / minInt) * minInt);
    for (let t = first; t <= Math.min(totalOut, visEnd); t += minInt) {
      const tt = +t.toFixed(4);
      ticks.push({ t: tt, major: Math.abs(tt / majInt - Math.round(tt / majInt)) < 0.001 });
    }
  }

  return (
    <div
      ref={wrapperRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="shrink-0 mx-3 mb-3 rounded-lg border border-line bg-surface-1 px-4 py-3 flex flex-col gap-2.5 outline-none focus-visible:ring-1 focus-visible:ring-accent-border"
    >
      {/* ── Transport row ─────────────────────────────────────────────────────── */}
      <div className="flex items-center">
        <div className="flex-1 flex items-center gap-1.5">
          {onUploadSource && (
            <>
              <input ref={uploadInputRef} type="file" accept="video/*" onChange={handleUploadFile} className="hidden" />
              {/* start-aligned: this is the bar's leftmost control, and a centered bubble slides under the nav rail */}
              <Tooltip content="Add a video — uploads and appends it as a clip" align="start">
                <Button variant="secondary" size="sm" className="rounded-full" disabled={uploading || clips.length === 0} onClick={() => uploadInputRef.current?.click()}
                  leadingIcon={uploading
                    ? <span className="size-3 rounded-full border-2 border-fg-4 border-t-transparent animate-spin" />
                    : <PlusIcon size={12} />}>
                  {uploading ? 'Uploading…' : 'Add video'}
                </Button>
              </Tooltip>
              <div className="mx-1 h-4 w-px bg-line" />
            </>
          )}
          <Tooltip content="Split at playhead (C)">
            <IconButton size="sm" label="Split at playhead" onClick={cutAtPlayhead}
              icon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
                  <line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>
                </svg>
              } />
          </Tooltip>
          <Tooltip content="Delete clip (Del)">
            <IconButton size="sm" variant="danger" label="Delete clip" disabled={selection === null || clips.length <= 1}
              onClick={() => { if (selection && clips.length > 1) removeClip(selection); }}
              icon={<TrashIcon size={14} strokeWidth={1.8} />} />
          </Tooltip>
          <div className="mx-1 h-4 w-px bg-line" />
          <Tooltip content={`Snapping ${snapEnabled ? 'on' : 'off'} (S)`}>
            <IconButton size="sm" label="Toggle snapping" active={snapEnabled} onClick={() => setSnapEnabled(x => !x)}
              icon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 4H3v7a9 9 0 0 0 18 0V4h-4v7a5 5 0 0 1-10 0z"/><line x1="3" y1="8" x2="7" y2="8"/><line x1="17" y1="8" x2="21" y2="8"/>
                </svg>
              } />
          </Tooltip>
        </div>

        <div className="flex items-center gap-2">
          <Tooltip content="Go to start (Home)">
            <IconButton size="sm" label="Go to start" onClick={() => seekOut(0)}
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="2.5" height="16" rx="1"/><polygon points="20,4 8,12 20,20"/></svg>} />
          </Tooltip>
          <IconButton size="sm" label={isPlaying ? 'Pause' : 'Play'} title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            // stopShuttle first, like the Space handler: a running J/L shuttle would otherwise keep
            // seeking (fighting playback) or leave a 2-4x playbackRate on the main element.
            onClick={() => { stopShuttle(); if (isPlaying) activeRef.pause(); else activeRef.play(); }}
            icon={isPlaying ? <PauseIcon size={15} /> : <PlayIcon size={15} />} />
          <Tooltip content="Go to end (End)">
            <IconButton size="sm" label="Go to end" onClick={() => seekOut(totalOut)}
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="17.5" y="4" width="2.5" height="16" rx="1"/><polygon points="4,4 16,12 4,20"/></svg>} />
          </Tooltip>
          <span className="ml-1.5 text-caption tabular-nums leading-none">
            <span className="text-fg">{fmtTC(playOut)}</span>
            <span className="text-fg-4"> / {fmtTC(totalOut)}</span>
          </span>
        </div>

        <div className="flex-1 flex items-center justify-end gap-1.5">
          <Tooltip content="Zoom to fit (\\)">
            <IconButton size="sm" label="Zoom to fit" disabled={atFit} onClick={zoomFit}
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>} />
          </Tooltip>
          <Tooltip content="Zoom out (-)">
            <IconButton size="sm" label="Zoom out" disabled={atFit} onClick={() => zoomBy(1 / 1.5)} icon={<MinusIcon size={12} />} />
          </Tooltip>
          <Slider min={0} max={100} step={1} neutral showValue={false} className="w-24"
            value={fitPps > 0 ? Math.round(clamp(100 * Math.log(effPps / fitPps) / Math.log(ZOOM_MAX), 0, 100)) : 0}
            onChange={v => zoomTo(fitPps * Math.pow(ZOOM_MAX, v / 100), playOutRef.current)} />
          <Tooltip content="Zoom in (=)">
            <IconButton size="sm" label="Zoom in" disabled={effPps >= fitPps * ZOOM_MAX - 0.001} onClick={() => zoomBy(1.5)} icon={<PlusIcon size={12} />} />
          </Tooltip>
        </div>
      </div>

      {/* ── Timeline viewport (scrolls horizontally when zoomed in) ───────────── */}
      <div
        ref={setViewportNode}
        onScroll={onViewportScroll}
        className="relative w-full overflow-x-auto overflow-y-hidden rounded-md bg-page select-none"
        style={{ height: RULER_H + STRIP_H }}
      >
        <div className="relative" style={{ width: Math.max(contentW, viewportW), height: RULER_H + STRIP_H }}>

          {/* Ruler band */}
          <div className="absolute top-0 left-0 right-0 bg-surface-2 border-b border-line cursor-col-resize" style={{ height: RULER_H }} onPointerDown={onRulerDown}>
            {ticks.map(({ t, major }) => {
              const edge = t < majInt * 0.5 ? 'start' : t > totalOut - majInt * 0.5 ? 'end' : 'mid';
              return (
                <div key={t} className="absolute bottom-0" style={{ left: X(t), transform: 'translateX(-50%)' }}>
                  {major && (
                    <span className="absolute bottom-[7px] text-[10px] tabular-nums leading-none text-fg-3 whitespace-nowrap"
                      style={{ left: 0, transform: edge === 'start' ? 'translateX(0)' : edge === 'end' ? 'translateX(-100%)' : 'translateX(-50%)' }}>
                      {fmtTC(t)}
                    </span>
                  )}
                  <div className={major ? 'w-px bg-line-strong' : 'w-px bg-line'} style={{ height: major ? 7 : 4 }} />
                </div>
              );
            })}
          </div>

          {/* Clip lane */}
          <div className="absolute left-0 right-0 bg-surface-2" style={{ top: RULER_H, height: STRIP_H }} onPointerDown={onTrackBgDown}>
            {renderItems.map(it => {
              const strip = strips[it.clip.src];
              return (
                <Clip key={it.clip.id} clipId={it.clip.id} label={it.label} leftPx={it.leftPx} widthPx={it.widthPx}
                  dragDX={moveDrag?.clipId === it.clip.id ? moveDrag.dx : null}
                  frames={strip?.frames ?? []} thumbW={strip?.w ?? 0} srcIn={it.srcIn} effPps={effPps}
                  viewLeft={scrollX} viewRight={scrollX + viewportW} selected={selection === it.clip.id}
                  settling={settling} onBodyDown={onClipBodyDown} onTrimDown={onTrimDown} />
              );
            })}
          </div>

          {/* Reorder insertion indicator */}
          {moveIndicatorX != null && (
            <div className="absolute w-0.5 rounded-full bg-accent pointer-events-none z-50" style={{ left: moveIndicatorX - 1, top: RULER_H, height: STRIP_H }} />
          )}

          {/* Snap indicator (green) */}
          {snapLineT != null && <div className="absolute top-0 bottom-0 w-px bg-accent pointer-events-none z-40" style={{ left: X(snapLineT) }} />}

          {/* Playhead / CTI — flag head grabbable in the ruler; the line never blocks clips */}
          <div className="absolute top-0 bottom-0 z-50 -translate-x-1/2 pointer-events-none" style={{ left: X(playOut), width: 14 }}>
            <div className="absolute top-0 left-0 right-0 pointer-events-auto cursor-grab active:cursor-grabbing" style={{ height: RULER_H }} onPointerDown={onRulerDown}>
              <div className="absolute top-0 left-1/2 -translate-x-1/2" style={{ width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '8px solid var(--fg)' }} />
            </div>
            <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[1.5px] bg-fg/90 shadow-1" />
          </div>

          {readout && (
            <div className="absolute z-50 -translate-x-1/2 pointer-events-none rounded-md bg-surface-overlay border border-line shadow-2 px-1.5 py-0.5 text-[10px] tabular-nums text-fg whitespace-nowrap"
              style={{ left: X(readout.t), top: RULER_H + 3 }}>
              {readout.text}
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom row ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <span className="text-caption tabular-nums text-fg-3">{clips.length > 1 ? `${clips.length} clips · ` : ''}{fmtTC(totalOut)}</span>
        {uploadError && <span className="text-caption text-danger-text truncate" role="alert">{uploadError}</span>}
        <div className="flex-1" />
        {isRecording ? (
          <div className="flex items-center gap-3 shrink-0">
            <ProgressBar tone="accent" value={Math.round(recProgress * 100)} className="w-28 h-1" />
            <span className="text-caption text-fg-3 tabular-nums">{recStatus || `${Math.round(recProgress * 100)}%`}</span>
            <button onClick={() => activeRef.cancelExport()} className="text-caption text-danger-text hover:brightness-110 transition-colors focus-ring rounded-sm">Cancel</button>
          </div>
        ) : (
          <>
            <Button variant="primary" size="sm" onClick={() => { (guardExport ? guardExport(() => activeRef.startDownload()) : activeRef.startDownload())?.catch((err: unknown) => console.error('[reel export]', err)); }} leadingIcon={<DownloadIcon size={14} />} className="rounded-full shrink-0">
              Export
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
