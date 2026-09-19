'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { getCachedBlob } from '@/lib/reelVideoBlob';
import {
  MAIN_SRC, buildTimelineLayout, timelineAtOut, timelineOutOf,
  type ReelTimeline, type TimelineLayout,
} from '../timeline';

// The canvas-side timeline sequencer: plays an ordered multi-clip (possibly multi-source) timeline
// through hidden <video> elements — the main reel video plus one detached element per extra uploaded
// source — advancing/switching at clip boundaries. It owns WHICH element the draw loop paints
// (drawVideoRef): on a source switch the old element keeps painting until the new one has a decoded
// frame, so switches hold the last frame instead of flashing the background. Active whenever a
// timeline is set (the bar sets one as soon as clips exist); when null, the canvas's legacy
// trim-loop behavior is untouched.

const BOUNDARY_EPS = 1 / 30;   // one output frame: treat the clip as finished within its last frame

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

interface ExtraSource { el: HTMLVideoElement; url: string; ownedBlobUrl: string | null }

export function useTimelineSequencer({ videoRef }: { videoRef: RefObject<HTMLVideoElement | null> }) {
  const timelineRef = useRef<ReelTimeline | null>(null);
  const layoutRef = useRef<TimelineLayout | null>(null);
  const activeClipRef = useRef(0);
  // The element the draw loop should paint. Lags the active element during a source switch (until
  // the incoming element has a decoded frame). null = paint the main video (legacy path).
  const drawVideoRef = useRef<HTMLVideoElement | null>(null);
  // Set by element events (e.g. a seek completing on a paused extra source) to tell the draw loop
  // to bypass its paused ~10fps throttle for one frame, so scrubbing extras stays fluid.
  const redrawNudgeRef = useRef(false);
  const playingRef = useRef(false);
  const extrasRef = useRef<Map<string, ExtraSource>>(new Map());

  const elementFor = useCallback((src: string): HTMLVideoElement | null => {
    if (src === MAIN_SRC) return videoRef.current;
    return extrasRef.current.get(src)?.el ?? null;
  }, [videoRef]);

  const activeClip = useCallback(() => {
    const t = timelineRef.current;
    if (!t || !t.clips.length) return null;
    const idx = clamp(activeClipRef.current, 0, t.clips.length - 1);
    return { idx, clip: t.clips[idx] };
  }, []);

  const disposeExtra = useCallback((ex: ExtraSource) => {
    ex.el.pause();
    ex.el.removeAttribute('src');
    ex.el.load();
    if (ex.ownedBlobUrl) URL.revokeObjectURL(ex.ownedBlobUrl);
    // Drop any coalesced-seek entry: 'seeked' may never fire after the src teardown, and the
    // strong-keyed map would otherwise pin the detached element (and its decoder) forever.
    pendingSeeksRef.current.delete(ex.el);
  }, []);

  // ── Coalesced seeks ─────────────────────────────────────────────────────────
  // One seek in flight per element; while it's seeking, remember only the LATEST target and chase
  // it on 'seeked'. Without this, scrubbing assigns currentTime per pointermove, each assignment
  // aborts the previous in-flight seek, and a remote source never paints an intermediate frame.
  const pendingSeeksRef = useRef<Map<HTMLVideoElement, number>>(new Map());
  const drainWiredRef = useRef<WeakSet<HTMLVideoElement>>(new WeakSet());
  const wireSeekDrain = useCallback((el: HTMLVideoElement) => {
    if (drainWiredRef.current.has(el)) return;
    drainWiredRef.current.add(el);
    el.addEventListener('seeked', () => {
      redrawNudgeRef.current = true;
      const p = pendingSeeksRef.current.get(el);
      if (p != null) {
        pendingSeeksRef.current.delete(el);
        if (Math.abs(p - el.currentTime) > 0.001) { try { el.currentTime = p; } catch { /* retried on next seek */ } }
      }
    });
  }, []);
  const seekEl = useCallback((el: HTMLVideoElement, t: number) => {
    wireSeekDrain(el);
    if (el.seeking) { pendingSeeksRef.current.set(el, t); return; }
    pendingSeeksRef.current.delete(el);
    try { el.currentTime = t; } catch { /* not ready yet — retried by the next seek/tick */ }
  }, [wireSeekDrain]);

  // play() with an autoplay-policy fallback: Safari/iOS reject audible play() on elements that never
  // received a user gesture (our extra sources are created programmatically). Falling back to muted
  // playback keeps the preview MOVING at a source switch instead of freezing; audio returns once the
  // element gets unlocked by a later gesture (see the unlock pass in play()).
  const tryPlay = useCallback((el: HTMLVideoElement) => {
    void el.play().catch((err: unknown) => {
      if ((err as { name?: string } | null)?.name === 'NotAllowedError' && !el.muted) {
        el.muted = true;
        void el.play().catch(() => { playingRef.current = false; });
        return;
      }
      playingRef.current = false;
    });
  }, []);

  // Create/drop hidden elements to match the timeline's source list. Detached elements decode fine
  // for canvas drawing; blob-cached files play from memory, otherwise the durable URL streams
  // (our Supabase storage is CORS-enabled and range-request friendly).
  const ensureSources = useCallback((sources: ReelTimeline['sources']) => {
    const want = new Map(sources.map(s => [s.id, s.url]));
    for (const [id, ex] of extrasRef.current) {
      if (want.get(id) !== ex.url) {
        disposeExtra(ex);
        extrasRef.current.delete(id);
        if (drawVideoRef.current === ex.el) drawVideoRef.current = null;
      }
    }
    for (const [id, url] of want) {
      if (extrasRef.current.has(id)) continue;
      const el = document.createElement('video');
      el.playsInline = true;
      el.crossOrigin = 'anonymous';
      const blob = getCachedBlob(url);
      const ownedBlobUrl = blob ? URL.createObjectURL(blob) : null;
      // Memory-backed blob → buffer freely. Network source → metadata only: a restored timeline
      // with several uploaded sources would otherwise fully download EVERY one on the spot (on top
      // of the filmstrip's own byte-cache download); playback buffers ranges on demand instead.
      el.preload = ownedBlobUrl ? 'auto' : 'metadata';
      el.src = ownedBlobUrl ?? url;
      wireSeekDrain(el);   // redraw nudge + coalesced-seek chasing
      extrasRef.current.set(id, { el, url, ownedBlobUrl });
    }
  }, [disposeExtra, wireSeekDrain]);

  // Pause every managed element EXCEPT the given one. Pausing only "the previous" element is not
  // enough: a rapid second switch fires while the first switch's element is still spinning up (its
  // draw adoption pending), and that element would keep playing audibly off-screen forever.
  const pauseOthers = useCallback((except: HTMLVideoElement | null) => {
    const main = videoRef.current;
    if (main && main !== except && !main.paused) main.pause();
    for (const ex of extrasRef.current.values()) {
      if (ex.el !== except && !ex.el.paused) ex.el.pause();
    }
  }, [videoRef]);

  // Switch playback to clip `idx` at source time `srcT`. Everything else pauses; the incoming
  // element seeks and (optionally) plays; the DRAW element only follows once a frame is decodable.
  const switchTo = useCallback((idx: number, srcT: number, opts: { play: boolean }) => {
    const t = timelineRef.current;
    const clip = t?.clips[idx];
    if (!t || !clip) return;
    const to = elementFor(clip.src);
    activeClipRef.current = idx;
    playingRef.current = opts.play;
    if (!to) return;   // source element missing (still materializing) — the next tick retries
    pauseOthers(to);
    seekEl(to, clamp(srcT, clip.start, clip.end));
    if (opts.play) tryPlay(to);
    else if (!to.paused) to.pause();
    if (drawVideoRef.current !== to) {
      if (to.readyState >= 2 && !to.seeking) {
        drawVideoRef.current = to;
        redrawNudgeRef.current = true;
      } else {
        const adopt = () => {
          to.removeEventListener('seeked', adopt);
          to.removeEventListener('canplay', adopt);
          // Only adopt if this element is STILL what the sequencer wants painted (a rapid second
          // switch may have superseded it).
          const cur = activeClip();
          if (cur && elementFor(cur.clip.src) === to) { drawVideoRef.current = to; redrawNudgeRef.current = true; }
        };
        to.addEventListener('seeked', adopt);
        to.addEventListener('canplay', adopt);
      }
    }
  }, [elementFor, activeClip, seekEl, tryPlay, pauseOthers]);

  // Per-frame boundary check, called from the canvas draw loop: while playing, an element crossing
  // its clip's out-point advances to the next clip (wrapping — the reel loops like the trim loop).
  const tick = useCallback(() => {
    const t = timelineRef.current;
    if (!t || !t.clips.length) return;
    const cur = activeClip();
    if (!cur) return;
    const el = elementFor(cur.clip.src);
    if (!el) return;
    if (el.paused || el.seeking) return;
    if (el.ended || el.currentTime >= cur.clip.end - BOUNDARY_EPS) {
      const next = (cur.idx + 1) % t.clips.length;
      switchTo(next, t.clips[next].start, { play: true });
    }
  }, [activeClip, elementFor, switchTo]);

  const setTimeline = useCallback((t: ReelTimeline | null) => {
    const main = videoRef.current;
    if (!t || !t.clips.length) {
      timelineRef.current = null;
      layoutRef.current = null;
      drawVideoRef.current = null;
      ensureSources([]);
      if (main) main.loop = true;   // legacy trim-loop behavior owns playback again
      return;
    }
    timelineRef.current = t;
    layoutRef.current = buildTimelineLayout(t.clips);
    ensureSources(t.sources);
    if (main) main.loop = false;   // the sequencer wraps at the LAST clip, not the source's end
    activeClipRef.current = clamp(activeClipRef.current, 0, t.clips.length - 1);
    // If the active clip's element is already the draw element, playback continues seamlessly
    // (trim edits mid-play). If the active clip's SOURCE changed under us (clip deleted), re-anchor.
    // And when nothing has been painted yet (fresh restore) but the first clip is an EXTRA source,
    // anchor to it — otherwise the canvas would show the main video until the first interaction.
    const cur = activeClip();
    if (cur) {
      const el = elementFor(cur.clip.src);
      if (el && drawVideoRef.current !== el && (drawVideoRef.current !== null || el !== main)) {
        switchTo(cur.idx, cur.clip.start, { play: playingRef.current });
      } else if (el && (el.currentTime < cur.clip.start - BOUNDARY_EPS || el.currentTime > cur.clip.end + BOUNDARY_EPS)) {
        // Same element, but the edit removed the region it was parked in (e.g. the clip under the
        // playhead was deleted or its window moved): re-seat inside the clip so the canvas doesn't
        // keep painting removed footage while the bar's playhead claims a clamped position.
        seekEl(el, cur.clip.start);
        if (playingRef.current) tryPlay(el);
      }
    }
  }, [videoRef, ensureSources, activeClip, elementFor, switchTo, seekEl, tryPlay]);

  const seekOutput = useCallback((outT: number) => {
    const L = layoutRef.current;
    if (!L) return;
    const at = timelineAtOut(outT, L);
    if (at) switchTo(at.index, at.srcT, { play: playingRef.current });
  }, [switchTo]);

  const play = useCallback(() => {
    const cur = activeClip();
    if (!cur) return;
    const el = elementFor(cur.clip.src);
    if (!el) return;
    // This runs from a real user gesture (the bar's Play button / spacebar) — the one chance to
    // unlock the OTHER sources' elements under strict autoplay policies (Safari/iOS bless play()
    // per element): a momentary play-then-pause here lets later programmatic boundary switches
    // play them audibly instead of being rejected. It's also the moment audible playback becomes
    // allowed again, so undo any muted-fallback tryPlay applied earlier.
    for (const ex of extrasRef.current.values()) {
      ex.el.muted = false;
      if (ex.el === el || !ex.el.paused) continue;
      void ex.el.play().then(() => {
        // The unlock element may have BECOME the active playing element while its play() promise
        // settled (a clip boundary crossed during buffering) — pausing it then would freeze the
        // preview at the boundary. Only park it if the sequencer still considers it inactive.
        const now = activeClip();
        const activeEl = now ? elementFor(now.clip.src) : null;
        if (ex.el !== activeEl || !playingRef.current) ex.el.pause();
      }).catch(() => { /* stays locked — tryPlay falls back to muted */ });
    }
    el.muted = false;
    // Outside the clip window (e.g. paused at the wrapped end) → restart the clip.
    if (el.currentTime < cur.clip.start - BOUNDARY_EPS || el.currentTime >= cur.clip.end - BOUNDARY_EPS) {
      seekEl(el, cur.clip.start);
    }
    playingRef.current = true;
    tryPlay(el);
    if (!drawVideoRef.current) drawVideoRef.current = el;
  }, [activeClip, elementFor, seekEl, tryPlay]);

  // Pause EVERYTHING, not just the active clip's element — a mid-switch element that hasn't been
  // adopted for drawing yet may also be playing.
  const pause = useCallback(() => {
    playingRef.current = false;
    pauseOthers(null);
  }, [pauseOthers]);

  const getPlayback = useCallback(() => {
    const t = timelineRef.current;
    const L = layoutRef.current;
    const cur = activeClip();
    if (!t || !L || !cur) return null;
    const el = elementFor(cur.clip.src);
    const srcT = el ? clamp(el.currentTime, cur.clip.start, cur.clip.end) : cur.clip.start;
    return { outT: timelineOutOf(cur.idx, srcT, L), clipIndex: cur.idx, playing: !!el && !el.paused };
  }, [activeClip, elementFor]);

  const getSourceDurations = useCallback((): Record<string, number> => {
    const out: Record<string, number> = {};
    const main = videoRef.current;
    if (main && isFinite(main.duration) && main.duration > 0) out[MAIN_SRC] = main.duration;
    for (const [id, ex] of extrasRef.current) {
      if (isFinite(ex.el.duration) && ex.el.duration > 0) out[id] = ex.el.duration;
    }
    return out;
  }, [videoRef]);

  // Unmount: silence + release every extra element and their object URLs.
  useEffect(() => () => {
    for (const ex of extrasRef.current.values()) disposeExtra(ex);
    extrasRef.current.clear();
  }, [disposeExtra]);

  // Stable object identity: every member is a ref or a stable callback, so consumers can list `seq`
  // itself in dep arrays (the canvas's imperative handle) without rebuilding each render.
  return useMemo(() => ({
    timelineRef, layoutRef, drawVideoRef, redrawNudgeRef, playingRef,
    setTimeline, seekOutput, play, pause, tick, getPlayback, getSourceDurations,
  }), [setTimeline, seekOutput, play, pause, tick, getPlayback, getSourceDurations]);
}
