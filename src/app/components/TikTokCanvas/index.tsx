'use client';

import { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react';

import {
  CANVAS_W, CANVAS_H, DISPLAY_SCALE,
  BASE_HEADER_HEIGHT, CAPTION_LINE_HEIGHT, HEADER_PADDING_X,
} from './constants';
import type { Box, ClipSegment, Framing, TikTokCanvasProps, TikTokCanvasRef } from './types';
import { drawHeaderOnContext, computeSonotradeHeaderHeight } from './drawing/drawHeader';
import { drawReelCells, drawFreeElements, reelLayout, reelVideoRect, ensureReelTextFontsLoaded, shiftFreeElementsForReelCrop, reelFreeElementDrawnRect } from './drawing/drawReelCell';
import { drawMarketRow, MARKET_ROW_H } from './drawing/drawMarketRow';
import { drawRewardsSticker, stickerReservedBottom, stickerVariant, rewardsStickerSrc } from './drawing/drawRewardsSticker';
import { resolveTwitterTemplateSettings } from '../twitterTemplateTypes';
import { clampTrimWindow } from '@/lib/framingSource';
import { VideoOverlays } from './ui/VideoOverlays';
import { CanvasHandles } from './ui/CanvasHandles';
import { useVideoLoading } from './hooks/useVideoLoading';
import { useDrag } from './hooks/useDrag';
import { useRecording } from './hooks/useRecording';
import { useTimelineSequencer } from './hooks/useTimelineSequencer';
import { loadTimeline, saveTimeline, clipsFromSegments, isLegacyShape, type ReelTimeline } from './timeline';

export type { TikTokCanvasRef, MarketData, SparkPoint } from './types';

export const TikTokCanvas = forwardRef<TikTokCanvasRef, TikTokCanvasProps>(function TikTokCanvas({
  videoSrc,
  videoId,
  rowNumber = 0,
  onVideoError,
  brand = 'sonotrade',
  overlayLogoSrc = '/templatelogo.png',
  overlayDisplayName = 'Sonotrade',
  overlayHandle = '@SonotradeHQ',
  overlayVerified = true,
  overlayCaption = '',
  marketData = null,
  twitterSettings,
  stickerEnabled = false,
  onRecordingStateChange,
  initialFraming = null,
  onFramingChange,
}: TikTokCanvasProps, ref) {
  // Resolved overlay style (defaults reproduce the original look). twKey lets the draw loop restart
  // only when the style actually changes, not on every render.
  const tw = resolveTwitterTemplateSettings(twitterSettings);
  const twKey = JSON.stringify(twitterSettings ?? null);
  // The video is fit to this width (CANVAS_W − 2·padding); the outer padding insets cells + video alike.
  const videoTargetW = CANVAS_W - 2 * (tw.cellMargin ?? 60);
  const videoBandHeight = tw.videoBandHeight ?? 900;
  // Reel cell layout for normal Twitter reels; market reels keep the old header-above-video layout.
  const cellMode = brand !== 'clean' && !marketData;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingSeekRef = useRef<number | null>(null);   // latest scrub target while a seek is in flight
  const blobSwapRef = useRef(false);                    // true while swapping the <video> to a local blob
  const raf = useRef(0);

  const verifiedImgRef = useRef<HTMLImageElement | null>(null);
  const logoImgRef = useRef<HTMLImageElement | null>(null);
  const marketAvatarImgRef = useRef<HTMLImageElement | null>(null);
  const cellImgRef = useRef<Map<string, HTMLImageElement>>(new Map());   // lazy cache of cell images by url
  const marketAvatarUrlRef = useRef<string | null>(null);

  const videoOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const videoScaleRef = useRef<number>(1);
  const [videoScale, setVideoScale] = useState(1);

  const boxRef = useRef<Box>({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H });
  const [box, setBox] = useState<Box>({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H });

  const [includeEdit, setIncludeEdit] = useState(false);
  const includeEditRef = useRef(false);

  // Timeline clip list (multi-cut edits), owned by the canvas so it persists with the framing and
  // survives the timeline panel unmounting. null = simple trim; the timeline seeds itself from this.
  const timelineSegmentsRef = useRef<ClipSegment[] | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => { logoImgRef.current = null; }, [overlayLogoSrc]);

  // FeedForce rewards sticker lockup — variant follows the background the sticker sits on, preloaded
  // with CORS (mirrors the logoImgRef idiom) so the draw loop can composite it without tainting.
  const stickerImgRef = useRef<HTMLImageElement | null>(null);
  const stickerVar = brand === 'clean' ? stickerVariant('#fff') : stickerVariant(tw.headerBgColor);
  useEffect(() => {
    if (!stickerEnabled) { stickerImgRef.current = null; return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = rewardsStickerSrc(stickerVar);
    stickerImgRef.current = img;
  }, [stickerEnabled, stickerVar]);

  // Reel text cells may use Google/custom fonts; ensure they're loaded so the draw loop renders them (not a fallback).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (cellMode) void ensureReelTextFontsLoaded(tw); }, [twKey, cellMode]);

  // ── Hooks ────────────────────────────────────────────────────────────────────

  const {
    isVideoLoading, videoError, setVideoError,
    videoDuration, trimStart, trimEnd, setTrimStart, setTrimEnd,
    currentTime, setCurrentTime, trimStartRef, trimEndRef, swapToLocalBlob,
  } = useVideoLoading({
    videoRef, videoSrc, brand, rowNumber, videoId, videoTargetW, videoBandHeight, cellMode,
    boxRef, setBox, videoOffsetRef, videoScaleRef, setVideoScale, onVideoError, blobSwapRef,
  });

  // Video zoom is controlled ONLY by the Adjust flyout's Zoom slider (TikTokCanvasRef.setZoom). The old
  // canvas gesture-zoom (two-finger pinch / Ctrl+wheel → usePanZoom) was removed so a stray scroll or
  // trackpad pinch over a reel can't change its framing — Ctrl+wheel now falls through to the page view-zoom.

  // Notify the workspace when framing changes (crop resize, zoom, trim, OR panning the video inside the
  // crop). Panning only mutates videoOffsetRef, so useDrag's onChange (drag-end) is the signal for it.
  const onFramingChangeRef = useRef(onFramingChange);
  useEffect(() => { onFramingChangeRef.current = onFramingChange; });
  const notifyFraming = useCallback(() => onFramingChangeRef.current?.(), []);

  const { startDrag, isDraggingRef } = useDrag({ boxRef, setBox, videoOffsetRef, canvasRef, onChange: notifyFraming });

  // Multi-clip / multi-source timeline playback. Owns hidden <video> elements for extra uploaded
  // sources and advances/switches at clip boundaries; when no timeline is set (plain trim), all the
  // legacy playback behavior below is untouched.
  const seq = useTimelineSequencer({ videoRef });

  const { isRecording, recProgress, recStatus, startRecording, cancelRecording } = useRecording({
    canvasRef, videoRef, brand, rowNumber, videoId,
    boxRef, videoOffsetRef, videoScaleRef,
    trimStartRef, trimEndRef, includeEditRef,
    timelineRef: seq.timelineRef, segmentsRef: timelineSegmentsRef, pauseTimeline: seq.pause,
    logoImgRef, verifiedImgRef,
    overlayCaption, overlayLogoSrc, overlayDisplayName, overlayHandle, overlayVerified,
    marketData, marketAvatarImgRef, marketAvatarUrlRef,
    twitterSettings: tw,
    stickerEnabled,
  });

  // Re-apply a saved framing (crop/pan/zoom/trim). Setters from useState/useVideoLoading are stable.
  const applyFramingFn = useCallback((f: Framing) => {
    // Ignore a saved box that's exactly the full-canvas placeholder {0,0,CANVAS_W,CANVAS_H}: it isn't a
    // real crop, it's the pre-load default that a mid-load/failed autosave persisted (this is what made
    // sheet-sent reels show full-canvas instead of the template band). Skipping it lets calcVideoBox's
    // band stand, healing already-saved reels on load. A genuinely full-canvas band re-derives to the
    // same box, so this is safe.
    if (f.box && !(f.box.x === 0 && f.box.y === 0 && f.box.w === CANVAS_W && f.box.h === CANVAS_H)) {
      boxRef.current = { ...f.box }; setBox({ ...f.box });
    }
    if (f.videoOffset) videoOffsetRef.current = { ...f.videoOffset };
    if (typeof f.videoScale === 'number') {
      const c = Math.max(0.5, Math.min(3, f.videoScale));
      videoScaleRef.current = c; setVideoScale(c);
    }
    // Timeline restore: a full multi-source timeline wins; legacy multi-cut segments become an
    // ordered main-only timeline (so the sequencer — not the trim loop — drives playback and the
    // cuts are honored even with the timeline bar closed); neither → plain trim, sequencer off.
    const restored = f.timeline ? loadTimeline(f.timeline) : null;
    // A saved MULTI-SOURCE timeline mirrors its OUTPUT total into trimStart/trimEnd (see setTimeline).
    // If that timeline fails to restore (all clips dropped — e.g. sources were session blobs, or the
    // row is malformed), the mirrored trim is an output duration with no meaning against the main
    // source: applying it would silently truncate the reel at the dead edit's length. Leave the
    // full-duration default instead. (Only non-legacy timelines are ever persisted, and a main-only
    // one can't fail restore, so failed-restore ⇒ the trim is a mirror, never a hand-set window.)
    const trimIsDeadMirror = !restored && !!f.timeline;
    if (!trimIsDeadMirror) {
      // Belt-and-braces (see lib/framingSource.ts): clamp a restored plain-trim window to the video
      // that's ACTUALLY loaded, so an out-of-range window (from a source that changed under saved
      // framing) can't produce a start beyond the video or a phantom end. A stale but IN-range window
      // is indistinguishable from a deliberate trim — catching that is the source-change strip's job
      // (CanvasGrid), not the clamp's. Plain trim only: a restored multi-source timeline mirrors its
      // OUTPUT total, which legitimately has no relation to the main duration (cap = Infinity while a
      // timeline restored or the duration is unknown, preserving verbatim behaviour there). A
      // collapsed window applies nothing, leaving the metadata reset's full-duration default.
      const clamped = clampTrimWindow(f.trimStart, f.trimEnd, restored ? undefined : videoRef.current?.duration);
      if (clamped) {
        if (clamped.trimStart !== undefined) { trimStartRef.current = clamped.trimStart; setTrimStart(clamped.trimStart); }
        if (clamped.trimEnd !== undefined) { trimEndRef.current = clamped.trimEnd; setTrimEnd(clamped.trimEnd); }
      }
    }
    if (typeof f.includeEdit === 'boolean') { includeEditRef.current = f.includeEdit; setIncludeEdit(f.includeEdit); }
    timelineSegmentsRef.current = Array.isArray(f.segments) && f.segments.length
      ? f.segments.map(s => ({ start: s.start, end: s.end }))
      : null;
    if (restored) {
      timelineSegmentsRef.current = null;
      seq.setTimeline(restored);
    } else if (Array.isArray(f.segments) && f.segments.length) {
      seq.setTimeline({ sources: [], clips: clipsFromSegments(f.segments) });
    } else {
      seq.setTimeline(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // useVideoLoading resets framing whenever a video (re)loads. So restore a saved reel's framing only
  // AFTER loading finishes, once per source — otherwise the reset would clobber it.
  const framingAppliedSrcRef = useRef<string | null>(null);
  // Current source + saved-framing prop, readable from getFraming() without a stale imperative closure.
  const videoSrcRef = useRef(videoSrc); videoSrcRef.current = videoSrc;
  const initialFramingRef = useRef(initialFraming); initialFramingRef.current = initialFraming;
  // Readable from getFraming(): while true, boxRef is still the full-canvas placeholder, not the band.
  const isVideoLoadingRef = useRef(isVideoLoading); isVideoLoadingRef.current = isVideoLoading;
  // Last APPLIED framing (canonical JSON), alongside the per-source ref: a cross-tab adoption changes the
  // initialFraming PROP for an already-applied source, and the once-per-source guard alone stranded the
  // canvas on stale framing whenever the adoption-time applyFraming push was skipped (e.g. a mid-seek
  // readyState dip); the stranded canvas's next autosave then overwrote the adopted foreign edit. Value
  // awareness makes the effect re-apply exactly when the saved framing genuinely differs from what this
  // canvas last applied, so a skipped push self-heals on the next render. User edits never re-trigger it:
  // they mutate live canvas state, not the initialFraming prop (framingMap changes only on restore,
  // adoption, and reel-switch capture, and the capture writes back the just-read live values, a no-op).
  const framingAppliedValueRef = useRef<string | null>(null);
  useEffect(() => {
    if (isVideoLoading || !initialFraming || !videoSrc) return;
    const valueKey = JSON.stringify(initialFraming);
    if (framingAppliedSrcRef.current === videoSrc && framingAppliedValueRef.current === valueKey) return;
    framingAppliedSrcRef.current = videoSrc;
    framingAppliedValueRef.current = valueKey;
    applyFramingFn(initialFraming);
  }, [isVideoLoading, initialFraming, videoSrc, applyFramingFn]);

  // Also fire on state-backed framing changes (crop resize / zoom / trim / include-edit). Pan is covered
  // by useDrag's onChange above. Skips the initial mount.
  const framingMountedRef = useRef(false);
  useEffect(() => {
    if (!framingMountedRef.current) { framingMountedRef.current = true; return; }
    notifyFraming();
  }, [box, videoScale, trimStart, trimEnd, includeEdit, notifyFraming]);

  useImperativeHandle(ref, () => ({
    startDownload: () => (!isRecording ? startRecording().then(() => undefined) : Promise.resolve()),
    exportBlob: async () => (!isRecording ? ((await startRecording({ returnBlob: true })) ?? null) : null),
    cancelExport: cancelRecording,
    play: () => { if (seq.timelineRef.current) { seq.play(); return; } const v = videoRef.current; if (v) v.play(); },
    pause: () => { if (seq.timelineRef.current) { seq.pause(); return; } const v = videoRef.current; if (v) v.pause(); },
    // Coalesce rapid scrub seeks: only one seek in flight, always re-target to the
    // latest position when it completes (drops intermediate targets) — see onSeeked.
    seekTo: (t: number) => {
      const v = videoRef.current; if (!v) return;
      if (v.seeking) { pendingSeekRef.current = t; }
      else { pendingSeekRef.current = null; v.currentTime = t; }
    },
    setTrimRange: (start: number, end: number) => {
      trimStartRef.current = start; trimEndRef.current = end;
      setTrimStart(start); setTrimEnd(end);
    },
    resetTrim: () => {
      trimStartRef.current = 0; trimEndRef.current = videoDuration;
      setTrimStart(0); setTrimEnd(videoDuration);
      timelineSegmentsRef.current = null;   // cuts are part of the trim — reset clears them too
      seq.setTimeline(null);                // ...and so is the whole multi-clip timeline
      const v = videoRef.current; if (v) v.currentTime = 0;
    },
    zoomIn, zoomOut, resetZoom,
    setZoom: (s: number) => { const c = Math.max(0.5, Math.min(3, s)); videoScaleRef.current = c; setVideoScale(c); },
    resetBox,
    centerBox: centerEverything,
    setIncludeEdit: (v: boolean) => { setIncludeEdit(v); includeEditRef.current = v; },
    getVideoElement: () => videoRef.current,
    useLocalBlob: swapToLocalBlob,   // timeline asks us to swap to the downloaded blob (fast seeking)
    getTrimState: () => ({ trimStart, trimEnd, duration: videoDuration, includeEdit, videoScale }),
    setSegments: (segs: ClipSegment[] | null) => {
      timelineSegmentsRef.current = segs && segs.length ? segs.map(s => ({ ...s })) : null;
      // Trim-range changes already notify via state; interior cuts (same outer bounds) need this one.
      notifyFraming();
    },
    getSegments: () => timelineSegmentsRef.current,
    // The timeline bar's single write path: hands playback to the sequencer and keeps the legacy
    // persistence fields (trim range + segments) mirrored whenever the edit is still expressible in
    // them — so pre-timeline readers of the saved framing keep working for plain cuts.
    setTimeline: (t: ReelTimeline | null) => {
      if (!t || t.clips.length === 0) {
        // Clearing a non-legacy (multi-source/reordered) timeline must also clear the trim window
        // that was MIRRORED from its output total below: that mirror is an output duration, not a
        // source-time window, so once the timeline is gone it silently truncates the plain-trim
        // export at the old stitched length (reels published cut to the stale total, 2026-07-23).
        const prev = seq.timelineRef.current;
        if (prev && !isLegacyShape(prev)) {
          trimStartRef.current = 0; trimEndRef.current = videoDuration;
          setTrimStart(0); setTrimEnd(videoDuration);
        }
        seq.setTimeline(null);
        timelineSegmentsRef.current = null;
        notifyFraming();
        return;
      }
      seq.setTimeline(t);
      if (isLegacyShape(t)) {
        timelineSegmentsRef.current = t.clips.length > 1 ? t.clips.map(c => ({ start: c.start, end: c.end })) : null;
        const s0 = t.clips[0].start, s1 = t.clips[t.clips.length - 1].end;
        trimStartRef.current = s0; trimEndRef.current = s1;
        setTrimStart(s0); setTrimEnd(s1);
      } else {
        timelineSegmentsRef.current = null;
        // Mirror the OUTPUT duration into the trim window (0..total): consumers that derive the
        // reel's length from trimEnd−trimStart (Schedule All's over/under-Reels-limit preflight via
        // effectiveReelDuration) would otherwise classify a stitched edit by a stale main-source
        // trim that has nothing to do with the real output length.
        const total = t.clips.reduce((acc, c) => acc + Math.max(0, c.end - c.start), 0);
        trimStartRef.current = 0; trimEndRef.current = total;
        setTrimStart(0); setTrimEnd(total);
      }
      notifyFraming();
    },
    getTimeline: () => seq.timelineRef.current,
    getPlayback: seq.getPlayback,
    seekOutput: seq.seekOutput,
    getSourceDurations: seq.getSourceDurations,
    getFraming: (): Framing | null =>
      // Return null while boxRef is still the placeholder (NOT the reel's band), so the autosave/capture
      // never persist it: (a) while the video is loading — boxRef is the full-canvas placeholder until
      // loadedmetadata runs calcVideoBox (this is why sheet-SENT reels reloaded as a full-canvas crop:
      // an autosave fired mid-load and saved the placeholder); (b) a saved reel whose framing hasn't been
      // applied for the current source yet. Once loaded, boxRef holds the real band/crop and we return it.
      (isVideoLoadingRef.current || (initialFramingRef.current && framingAppliedSrcRef.current !== videoSrcRef.current)) ? null : ({
        box: { ...boxRef.current },
        videoOffset: { ...videoOffsetRef.current },
        videoScale: videoScaleRef.current,
        trimStart: trimStartRef.current,
        trimEnd: trimEndRef.current,
        includeEdit: includeEditRef.current,
        segments: timelineSegmentsRef.current ?? undefined,
        timeline: (() => {
          const t = seq.timelineRef.current;
          return t && !isLegacyShape(t) ? saveTimeline(t) : undefined;
        })(),
      }),
    applyFraming: applyFramingFn,
  }), [isRecording, startRecording, cancelRecording, videoDuration, trimStart, trimEnd, includeEdit, videoScale, zoomIn, zoomOut, resetZoom, applyFramingFn, swapToLocalBlob, seq, setTrimStart, setTrimEnd]);

  const onRecordingStateChangeRef = useRef(onRecordingStateChange);
  useEffect(() => { onRecordingStateChangeRef.current = onRecordingStateChange; });

  useEffect(() => {
    onRecordingStateChangeRef.current?.({ isRecording, recProgress, recStatus });
  }, [isRecording, recProgress, recStatus]);

  // ── Main draw loop ────────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    const v = videoRef.current;
    if (!canvas || !v) return;
    const mainVideo = v;
    const ctx = canvas.getContext('2d')!;
    let active = true;

    const drawOpts = {
      overlayCaption, overlayLogoSrc, overlayDisplayName, overlayHandle, overlayVerified,
      logoImgRef, verifiedImgRef, s: tw,
    };

    // ── Pre-compute caption layout once per effect (caption text doesn't change mid-loop) ──
    const CAPTION_PAD_X   = HEADER_PADDING_X + 43;
    const CAPTION_MAX_W   = CANVAS_W - CAPTION_PAD_X * 2;
    const CAPTION_BOT_OFF = 18;
    const CLEAN_PAD_TOP   = 44;
    const CLEAN_PAD_BOT   = 40;

    // Groups of pre-wrapped lines; null entry = blank user-line (paragraph break)
    const captionGroups: (string[] | null)[] = [];
    if (overlayCaption && brand === 'clean') {
      ctx.font = '400 42px "Libre Franklin", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      for (const userLine of overlayCaption.split('\n')) {
        if (!userLine) { captionGroups.push(null); continue; }
        const words = userLine.split(' ');
        const wrapped: string[] = [];
        let cur = '';
        for (const word of words) {
          const test = cur + word + ' ';
          if (ctx.measureText(test).width > CAPTION_MAX_W && cur) {
            wrapped.push(cur); cur = word + ' ';
          } else { cur = test; }
        }
        if (cur) wrapped.push(cur);
        captionGroups.push(wrapped);
      }
    }
    const captionLineCount = captionGroups.reduce((n, g) => n + (g === null ? 1 : g.length), 0);
    const captionAreaH = captionLineCount > 0
      ? CLEAN_PAD_TOP + (captionLineCount * CAPTION_LINE_HEIGHT) + CLEAN_PAD_BOT - CAPTION_BOT_OFF
      : 0;

    // Pre-compute sonotrade header height (depends only on caption + style, not on box position)
    const sonotradeHeaderHeight = brand !== 'clean'
      ? computeSonotradeHeaderHeight(ctx, overlayCaption, tw)
      : BASE_HEADER_HEIGHT;

    // ── Draw loop — throttled to ~10 fps when paused to spare CPU ──────────────
    let lastDrawTime = 0;
    // Force an immediate redraw whenever the video seeks (timeline scrub, frame-step,
    // J/K/L) so the preview tracks the playhead at full framerate even while paused.
    const onSeeked = () => {
      lastDrawTime = 0;   // redraw at full framerate the instant a frame decodes
      // Drain the coalesced scrub target: chase the latest cursor position.
      const p = pendingSeekRef.current;
      if (p != null) { pendingSeekRef.current = null; if (Math.abs(p - mainVideo.currentTime) > 0.001) mainVideo.currentTime = p; }
    };
    mainVideo.addEventListener('seeked', onSeeked);

    function draw() {
      if (!active) return;
      raf.current = requestAnimationFrame(draw);

      // Advance the multi-clip sequencer (clip-boundary jumps / source switches). No-op without a timeline.
      seq.tick();
      // Paint whichever element the sequencer wants on screen; the main video otherwise.
      const video = seq.drawVideoRef.current ?? mainVideo;

      // Hold the last frame while the main <video> is mid-swap to a local blob (avoids a flash).
      if (blobSwapRef.current && video === mainVideo) return;

      // Hold the last frame while a seek is in flight with no decoded frame ready — drawing
      // it would paint black/garbage. We repaint on 'seeked' the moment the frame lands.
      // (readyState >= 3 means the current frame IS available, so a fast local seek still draws.)
      if (video.seeking && video.readyState < 3) return;

      // Throttle to ~10fps when paused and idle; bypass throttle while dragging for smooth 60fps.
      // A sequencer nudge (an extra source finished seeking / a source switch adopted) also bypasses
      // it for one frame so paused scrubs of extra sources render immediately.
      if (video.paused && !isDraggingRef.current) {
        if (seq.redrawNudgeRef.current) {
          seq.redrawNudgeRef.current = false;
          lastDrawTime = performance.now();
        } else {
          const now = performance.now();
          if (now - lastDrawTime < 100) return;
          lastDrawTime = now;
        }
      }

      if (brand === 'clean') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

        if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          const { x, y, w, h } = boxRef.current;
          const { x: ox, y: oy } = videoOffsetRef.current;

          if (captionGroups.length > 0) {
            const captionAreaY = Math.max(0, y - captionAreaH + 4);
            ctx.font = '400 42px "Libre Franklin", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            ctx.fillStyle = '#000';
            let cy = captionAreaY + CLEAN_PAD_TOP + CAPTION_LINE_HEIGHT - 10;
            for (let gi = 0; gi < captionGroups.length; gi++) {
              const group = captionGroups[gi];
              const isLastGroup = gi === captionGroups.length - 1;
              if (group === null) { cy += CAPTION_LINE_HEIGHT; continue; }
              for (let wi = 0; wi < group.length; wi++) {
                ctx.fillText(group[wi], CAPTION_PAD_X, cy);
                if (wi < group.length - 1) cy += CAPTION_LINE_HEIGHT;
              }
              if (!isLastGroup) cy += CAPTION_LINE_HEIGHT;
            }
          }

          const scale = (CANVAS_W / video.videoWidth) * videoScaleRef.current;
          const drawW = video.videoWidth * scale;
          const drawH = video.videoHeight * scale;
          const dx = (CANVAS_W - drawW) / 2 + ox;
          const dy = (CANVAS_H - drawH) / 2 + oy;

          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
          ctx.drawImage(video, dx, dy, drawW, drawH);
          ctx.restore();

          // FeedForce rewards sticker — drawn LAST so it sits above the video, just below the crop.
          if (stickerEnabled) {
            drawRewardsSticker({ ctx, img: stickerImgRef.current, variant: stickerVar, centerX: x + w / 2, bottomY: y + h, maxW: w });
          }
        }
        return;
      }

      // sonotrade (Twitter/X header template)
      ctx.fillStyle = tw.headerBgColor;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      if (cellMode) {
        // ── Reel cell layout: [top · top2] · centred video band · [bottom · bottom2] ──
        const L = reelLayout(tw);
        const getCellImg = (url?: string): HTMLImageElement | null => {
          if (!url) return null;
          let img = cellImgRef.current.get(url);
          if (!img) { img = new Image(); img.crossOrigin = 'anonymous'; img.src = url; cellImgRef.current.set(url, img); }
          return img.complete && img.naturalWidth > 0 ? img : null;
        };
        // The video band is a reorderable z-layer: free elements before `videoLayer` draw BEHIND it, so
        // they must be painted before the video frame; the rest paint on top afterwards.
        const videoLayer = tw.videoLayer ?? 0;
        // When the video is cropped, the free elements follow the crop edges so spacing to the video holds
        // (elements above ← top edge, below ← bottom edge). No crop → same array, identical render.
        const cropTw = { ...tw, freeElements: shiftFreeElementsForReelCrop(tw.freeElements ?? [], L, boxRef.current, tw) };
        drawFreeElements({ ctx, s: cropTw, logoSrc: overlayLogoSrc, name: overlayDisplayName, handle: overlayHandle, logoImgRef, verifiedImgRef, getCellImg, placeholder: false, overlayCaption, to: videoLayer });
        if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          const { x: ox, y: oy } = videoOffsetRef.current;
          // The tc/bc handles CROP the video vertically: the video is cover-fit + positioned by the LAYOUT
          // band (so it never moves or rescales while cropping), and only the CLIP window changes to boxRef's
          // y/h. Shrinking the box hides the top/bottom; growing it reveals more (up to the video's extent).
          // boxRef seeds to the layout band, so an untouched reel looks identical; the recorder clips the same.
          const r = reelVideoRect(video.videoWidth, video.videoHeight, L, videoScaleRef.current, ox, oy);
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(L.bandX, boxRef.current.y, L.bandW, boxRef.current.h, tw.videoCornerRadius ?? 24);
          ctx.clip();
          ctx.drawImage(video, r.dx, r.dy, r.dw, r.dh);
          ctx.restore();
        }
        drawReelCells({ ctx, s: tw, L, logoSrc: overlayLogoSrc, name: overlayDisplayName, handle: overlayHandle, logoImgRef, verifiedImgRef, getCellImg, placeholder: false, overlayCaption });
        drawFreeElements({ ctx, s: cropTw, logoSrc: overlayLogoSrc, name: overlayDisplayName, handle: overlayHandle, logoImgRef, verifiedImgRef, getCellImg, placeholder: false, overlayCaption, from: videoLayer });
        // FeedForce rewards sticker — drawn LAST so it sits above cells/free elements, below the crop.
        if (stickerEnabled) {
          drawRewardsSticker({ ctx, img: stickerImgRef.current, variant: stickerVar, centerX: L.bandX + L.bandW / 2, bottomY: boxRef.current.y + boxRef.current.h, maxW: L.bandW });
        }
        return;
      }

      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        const { x, y, w, h } = boxRef.current;
        const { x: ox, y: oy } = videoOffsetRef.current;

        const headerY = Math.max(0, y - sonotradeHeaderHeight + 4);
        drawHeaderOnContext({ ctx, cx: 0, cy: headerY, cw: CANVAS_W, ...drawOpts });

        const scale = Math.min(videoTargetW / video.videoWidth, CANVAS_H / video.videoHeight) * videoScaleRef.current;
        const drawW = video.videoWidth * scale;
        const drawH = video.videoHeight * scale;
        const dx = (CANVAS_W - drawW) / 2 + ox;
        const dy = (CANVAS_H - drawH) / 2 + oy;

        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.drawImage(video, dx, dy, drawW, drawH);
        ctx.restore();

        if (marketData) {
          drawMarketRow({
            ctx, cx: 0, videoBottomY: y + h, cw: CANVAS_W,
            name: marketData.name,
            subtitle: marketData.industry ?? marketData.subcategory ?? '—',
            photo_url: marketData.photo_url,
            priceUsd: marketData.price.usd,
            lifetimeChangePct: marketData.price.lifetimeChangePct,
            sparkline: marketData.sparkline,
            avatarImgRef: marketAvatarImgRef,
            lastPhotoUrlRef: marketAvatarUrlRef,
          });
        }

        // FeedForce rewards sticker — drawn LAST, below the crop (and below the market row when shown).
        if (stickerEnabled) {
          drawRewardsSticker({ ctx, img: stickerImgRef.current, variant: stickerVar, centerX: x + w / 2, bottomY: y + h + (marketData ? MARKET_ROW_H : 0), maxW: w });
        }
      }
    }

    draw();
    return () => { active = false; cancelAnimationFrame(raf.current); mainVideo.removeEventListener('seeked', onSeeked); };
  // videoScale intentionally omitted: the draw loop reads videoScaleRef.current directly,
  // so including it would restart the RAF loop on every zoom step causing a visible frame drop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSrc, overlayDisplayName, overlayHandle, overlayVerified, overlayCaption, brand, overlayLogoSrc, marketData, twKey, cellMode, stickerEnabled]);

  // ── Interaction handlers ──────────────────────────────────────────────────────

  function resetBox() {
    const video = videoRef.current;
    if (cellMode) {
      const L = reelLayout(tw);
      const b = { x: L.bandX, y: L.bandY, w: L.bandW, h: L.bandH };
      boxRef.current = b;
      setBox(b);
    } else if (video && video.videoWidth && video.videoHeight) {
      const scale = Math.min(videoTargetW / video.videoWidth, CANVAS_H / video.videoHeight);
      const b = {
        x: (CANVAS_W - video.videoWidth * scale) / 2,
        y: (CANVAS_H - video.videoHeight * scale) / 2,
        w: video.videoWidth * scale,
        h: video.videoHeight * scale,
      };
      boxRef.current = b;
      setBox(b);
    } else {
      const b = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
      boxRef.current = b;
      setBox(b);
    }
    videoOffsetRef.current = { x: 0, y: 0 };
    videoScaleRef.current = 1;
    setVideoScale(1);
  }

  function centerEverything() {
    const currentBox = boxRef.current;
    if (cellMode) {
      // Reels: centre the WHOLE composition vertically — the free overlay elements (banner / caption / image)
      // PLUS the visible video band — not just the bare video crop (centring only the crop left the banner +
      // caption too high). Measure the current on-screen extent, mirroring shiftFreeElementsForReelCrop so a
      // cropped video and its shifted elements are accounted for, then move the crop window + pan the video by
      // the same delta so banner, video and caption travel together. Re-centring an already-centred reel is a
      // no-op (idempotent).
      // Crop-shift the elements EXACTLY as the draw does, then measure each one's ACTUAL drawn rect — so a
      // multi-line per-post caption's real height is counted (reelFreeElementDrawnRect with placeholder:false
      // reads overlayCaption), not the ~2-line editor sample. Skip empty (undrawn) text elements (h <= 0).
      const L = reelLayout(tw);
      const ctx = canvasRef.current?.getContext('2d');
      const shifted = shiftFreeElementsForReelCrop(tw.freeElements ?? [], L, currentBox, tw);
      let compTop = currentBox.y, compBot = currentBox.y + currentBox.h;   // the visible (clipped) video band
      if (ctx) {
        for (const el of shifted) {
          if (el.hidden) continue;
          const r = reelFreeElementDrawnRect(ctx, el, tw, { overlayCaption, placeholder: false });
          if (r.h <= 0) continue;
          compTop = Math.min(compTop, r.y);
          compBot = Math.max(compBot, r.y + r.h);
        }
        // Reserve the rewards sticker's footprint (crop bottom + gap + height) so an enabled sticker
        // is balanced INTO the composition instead of hanging below a centred crop. Uses the UNCLAMPED
        // reserve (see stickerReservedBottom) so it shifts 1:1 with the crop — centring lands in one
        // pass and stays idempotent even when the crop starts near the canvas floor.
        if (stickerEnabled) {
          compBot = Math.max(compBot, stickerReservedBottom({
            ctx,
            bottomY: currentBox.y + currentBox.h,
            maxW: L.bandW,
          }));
        }
      }
      const dy = (CANVAS_H - (compBot - compTop)) / 2 - compTop;
      boxRef.current = { x: currentBox.x, y: currentBox.y + dy, w: currentBox.w, h: currentBox.h };
      videoOffsetRef.current = { x: videoOffsetRef.current.x, y: videoOffsetRef.current.y + dy };
      setBox({ ...boxRef.current });
      return;
    }
    let headerHeight = BASE_HEADER_HEIGHT;
    if (brand !== 'clean') {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (ctx) headerHeight = computeSonotradeHeaderHeight(ctx, overlayCaption, tw);
    }
    const totalHeight = headerHeight + currentBox.h;
    const newY = (CANVAS_H - totalHeight) / 2 - 60 + headerHeight;
    const b = { x: currentBox.x, y: newY, w: currentBox.w, h: currentBox.h };
    boxRef.current = b;
    setBox({ ...b });
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setIsPlaying(true); }
    else { v.pause(); setIsPlaying(false); }
  }

  function zoomIn() { const n = Math.min(3, videoScaleRef.current + 0.05); videoScaleRef.current = n; setVideoScale(n); }
  function zoomOut() { const n = Math.max(0.5, videoScaleRef.current - 0.05); videoScaleRef.current = n; setVideoScale(n); }
  function resetZoom() { videoScaleRef.current = 1; setVideoScale(1); }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div
      className="relative"
      style={{ width: CANVAS_W * DISPLAY_SCALE, height: CANVAS_H * DISPLAY_SCALE, overflow: 'visible' }}
    >
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        style={{ width: CANVAS_W * DISPLAY_SCALE, height: CANVAS_H * DISPLAY_SCALE }}
        className="block border border-zinc-700"
      />
      <VideoOverlays isVideoLoading={isVideoLoading} videoError={videoError} />
      <CanvasHandles box={box} onStartDrag={startDrag} verticalOnly={cellMode} />
      <video
        ref={videoRef}
        crossOrigin="anonymous"
        preload="auto"
        loop playsInline
        onPlay={() => {
          setIsPlaying(true);
          // With a timeline the sequencer owns positioning (its clip in-points, not the trim range).
          if (seq.timelineRef.current) return;
          const v = videoRef.current;
          if (v && v.currentTime < trimStartRef.current) v.currentTime = trimStartRef.current;
        }}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={() => {
          const v = videoRef.current;
          if (!v) return;
          setCurrentTime(v.currentTime);
          // Legacy trim loop only — the sequencer wraps at the LAST clip's out-point instead.
          if (!seq.timelineRef.current && trimEndRef.current > 0 && v.currentTime >= trimEndRef.current) {
            v.currentTime = trimStartRef.current;
          }
        }}
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (v && v.duration > 1) v.currentTime = 1;
        }}
        onError={(e) => {
          const v = e.target as HTMLVideoElement;
          const errorCode = v.error?.code;
          if (!errorCode) return;
          const msgs: Record<number, string> = {
            4: 'Video format not supported. Try refreshing the page.',
            3: 'Video decode error. The file may be corrupted.',
            2: 'Network error. Check your internet connection.',
          };
          setVideoError(msgs[errorCode] ?? 'Failed to load video. The link may be invalid.');
          onVideoError?.();
        }}
        style={{ display: 'none' }}
      />
    </div>
  );
});
