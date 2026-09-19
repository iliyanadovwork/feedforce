'use client';

import { useState, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';

import {
  CANVAS_W, CANVAS_H, CAPTION_LINE_HEIGHT, HEADER_PADDING_X,
} from '../constants';
import { drawHeaderOnContext, computeSonotradeHeaderHeight } from '../drawing/drawHeader';
import { drawReelCells, drawFreeElements, reelLayout, reelVideoRect, ensureReelTextFontsLoaded, shiftFreeElementsForReelCrop } from '../drawing/drawReelCell';
import { drawMarketRow, MARKET_ROW_H } from '../drawing/drawMarketRow';
import { drawRewardsSticker, stickerVariant, rewardsStickerSrc } from '../drawing/drawRewardsSticker';
import { countCaptionLines } from '../drawing/countCaptionLines';
import type { Box, ClipSegment, MarketData } from '../types';
import type { TwitterTemplateSettings } from '../../twitterTemplateTypes';
import { MAIN_SRC, type ReelTimeline } from '../timeline';
import type { EncodedAudioPacketSource as TEncodedAudioPacketSource, EncodedPacket as TEncodedPacket } from 'mediabunny';

// Our own Supabase Storage (uploaded reels) is CORS-enabled and public, so fetch it DIRECTLY — never
// through /api/proxy, whose allowlist is CDN-only and 403s it, making an uploaded reel un-exportable
// after a reload (its src is the durable supabase URL, not a blob:).
const SUPABASE_HOST = (() => {
  try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').host; } catch { return ''; }
})();
function isDirectFetchable(url: string): boolean {
  if (url.startsWith('blob:')) return true;   // byte-cached local blob
  try {
    const h = new URL(url).host;
    return (!!SUPABASE_HOST && h === SUPABASE_HOST) || h.endsWith('.supabase.co');
  } catch { return false; }
}

export interface UseRecordingConfig {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  brand: string;
  rowNumber: number;
  videoId?: string;
  boxRef: MutableRefObject<Box>;
  videoOffsetRef: MutableRefObject<{ x: number; y: number }>;
  videoScaleRef: MutableRefObject<number>;
  trimStartRef: MutableRefObject<number>;
  trimEndRef: MutableRefObject<number>;
  includeEditRef: MutableRefObject<boolean>;
  /** The multi-clip / multi-source timeline; when set, the export renders the OUTPUT sequence
   *  (clips back-to-back in order) instead of the single trim window. */
  timelineRef?: MutableRefObject<ReelTimeline | null>;
  /** Legacy multi-cut clip list (single-source). Fallback when no timeline is set, so interior
   *  cuts export correctly (previously they applied to the preview only — the export rendered the
   *  whole trim window including removed middles). */
  segmentsRef?: MutableRefObject<ClipSegment[] | null>;
  /** Pause sequencer playback (all timeline elements, not just the main video) — export teardown. */
  pauseTimeline?: () => void;
  logoImgRef: MutableRefObject<HTMLImageElement | null>;
  verifiedImgRef: MutableRefObject<HTMLImageElement | null>;
  overlayCaption: string;
  overlayLogoSrc: string;
  overlayDisplayName: string;
  overlayHandle: string;
  overlayVerified: boolean;
  marketData?: MarketData | null;
  marketAvatarImgRef?: MutableRefObject<HTMLImageElement | null>;
  marketAvatarUrlRef?: MutableRefObject<string | null>;
  twitterSettings: TwitterTemplateSettings;
  /** FeedForce rewards sticker (enrolled members only): bake the branded lockup + tagline just below
   *  the video crop — identical math to the live preview's draw loop (WYSIWYG). */
  stickerEnabled?: boolean;
}

export function useRecording(config: UseRecordingConfig) {
  const [isRecording, setIsRecording] = useState(false);
  const [recProgress, setRecProgress] = useState(0);
  const [recStatus, setRecStatus] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);

  async function startRecording(opts?: { returnBlob?: boolean }): Promise<Blob | void> {
    const {
      canvasRef, videoRef, brand, rowNumber, videoId,
      boxRef, videoOffsetRef, videoScaleRef,
      trimStartRef, trimEndRef, includeEditRef,
      logoImgRef, verifiedImgRef,
      overlayCaption, overlayLogoSrc, overlayDisplayName, overlayHandle, overlayVerified,
      marketData, marketAvatarImgRef, marketAvatarUrlRef,
      twitterSettings, stickerEnabled,
    } = config;

    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || isRecording) throw new Error('Cannot start recording');

    // Freeze the framing for the WHOLE export. The encode loop runs for tens of seconds and used to
    // read the live refs per frame, so anything that reset them mid-export — a src swap's
    // loadedmetadata reset (offset/scale/box back to defaults), a framing re-apply race — baked a
    // burst of uncropped/unzoomed frames into the finished file. One export = one framing.
    const exportBox = { ...boxRef.current };
    const exportOffset = { ...videoOffsetRef.current };
    const exportScale = videoScaleRef.current;
    const exportTrimStart = trimStartRef.current;
    const exportTrimEnd = trimEndRef.current;
    const exportIncludeEdit = includeEditRef.current;
    // The timeline/segments too: they were read after the first `await` (mediabunny import), so a
    // clear in that gap exported the dead trim mirror of the just-removed timeline.
    const exportTimeline = config.timelineRef?.current ?? null;
    const exportSegments = config.segmentsRef?.current ?? null;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const signal = abortController.signal;

    setIsRecording(true);
    setRecProgress(0);
    setRecStatus('Initializing...');

    const isClean = brand === 'clean';
    const cellMode = brand !== 'clean' && !marketData;   // reel cell layout (market reels keep the legacy layout)
    // A terminal status (error, "Saved:", "Exported without audio") is set on the same synchronous
    // job as the finally below, so without this flag the finally's setRecStatus('') coalesces it away
    // and it never renders. Set it wherever a status must survive to be seen (its own timeout clears it).
    let keepStatus = false;

    // Throttled progress: the encode loop produces ~30 values/second of output; pushing every one
    // through setState re-renders the whole canvas → grid → timeline-bar chain per frame. 1% steps
    // keep the bar smooth at ~1/70th of the churn (part of the max-update-depth fix, 2026-07-20).
    let lastReported = -1;
    const reportProgress = (p: number) => {
      if (p - lastReported < 0.01) return;
      lastReported = p;
      setRecProgress(p);
    };

    try {
      const mediabunny = await import('mediabunny');
      const {
        Output, Mp4OutputFormat, BufferTarget, VideoSample, VideoSampleSource,
        EncodedAudioPacketSource, EncodedVideoPacketSource, EncodedPacketSink, EncodedPacket,
        Input, BlobSource, ALL_FORMATS,
      } = mediabunny;

      const EXPORT_FPS = 30;
      const EXPORT_FRAME_DURATION = 1 / EXPORT_FPS;

      const headerDrawOpts = {
        overlayCaption, overlayLogoSrc, overlayDisplayName, overlayHandle, overlayVerified,
        logoImgRef, verifiedImgRef, s: twitterSettings,
      };

      // Encode a rendered 44.1kHz AudioBuffer to AAC packets + decoder config. Shared by the
      // timeline audio assembly (multi-clip exports) and mergeWithEdit's mix — one encoder, so a
      // codec/config fix can't land in one and miss the other. Throws on encoder error.
      async function encodeMixToAac(mixed: AudioBuffer): Promise<{ packets: TEncodedPacket[]; config: AudioDecoderConfig | null }> {
        const MERGED_SR = 44100;
        const AFRAME = 1024;
        const mixCh = 2;
        const mixLen = mixed.length;
        const chunks: EncodedAudioChunk[] = [];
        let encCfg: AudioDecoderConfig | null = null;
        let encErr: Error | null = null;
        const enc = new AudioEncoder({
          output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
            chunks.push(chunk);
            if (meta?.decoderConfig && !encCfg) encCfg = meta.decoderConfig;
          },
          error: (e: Error) => { encErr = e; },
        });
        enc.configure({ codec: 'mp4a.40.2', sampleRate: MERGED_SR, numberOfChannels: mixCh, bitrate: 128_000 });
        // A mono render still feeds both output channels (duplicated), matching the old inline code
        // whose OfflineAudioContext was always stereo.
        const chData = Array.from({ length: mixCh }, (_, c) => mixed.getChannelData(Math.min(c, mixed.numberOfChannels - 1)));
        let tMicros = 0;
        for (let offset = 0; offset < mixLen; offset += AFRAME) {
          const fc = Math.min(AFRAME, mixLen - offset);
          const planar = new Float32Array(fc * mixCh);
          for (let c = 0; c < mixCh; c++) {
            const src = chData[c];
            for (let i = 0; i < fc; i++) planar[c * fc + i] = src[offset + i] ?? 0;
          }
          const ad = new AudioData({ format: 'f32-planar', sampleRate: MERGED_SR, numberOfFrames: fc, numberOfChannels: mixCh, timestamp: tMicros, data: planar });
          enc.encode(ad);
          ad.close();
          tMicros += Math.round((fc / MERGED_SR) * 1_000_000);
        }
        await enc.flush();
        enc.close();
        if (encErr) throw encErr;
        if (chunks.length > 0 && !encCfg) {
          const sfIdx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350].indexOf(MERGED_SR);
          const si = sfIdx >= 0 ? sfIdx : 4;
          encCfg = { codec: 'mp4a.40.2', sampleRate: MERGED_SR, numberOfChannels: mixCh, description: new Uint8Array([(2 << 3) | (si >> 1), ((si & 1) << 7) | (mixCh << 3)]) };
        }
        return { packets: chunks.map(c => EncodedPacket.fromEncodedChunk(c)), config: encCfg };
      }

      async function mergeWithEdit(mainBuffer: ArrayBuffer, mainDuration: number): Promise<ArrayBuffer> {
        setRecStatus('Appending edit clip...');

        const editResp = await fetch('/edit.mp4');
        if (!editResp.ok) throw new Error(`Failed to fetch edit.mp4: ${editResp.status}`);
        const editArrayBuffer = await editResp.arrayBuffer();

        const mkMain = () => new Input({ source: new BlobSource(new Blob([mainBuffer], { type: 'video/mp4' })), formats: ALL_FORMATS });
        const mkEdit = () => new Input({ source: new BlobSource(new Blob([editArrayBuffer], { type: 'video/mp4' })), formats: ALL_FORMATS });

        const mainVideoTrack = await mkMain().getPrimaryVideoTrack();
        const editVideoTrack = await mkEdit().getPrimaryVideoTrack();
        if (!mainVideoTrack || !editVideoTrack) throw new Error('Missing video track for merge');

        const mainVideoConfig = await mainVideoTrack.getDecoderConfig();
        const editVideoConfig = await editVideoTrack.getDecoderConfig();

        const mainVPackets: TEncodedPacket[] = [];
        for await (const p of new EncodedPacketSink(mainVideoTrack).packets()) mainVPackets.push(p);
        let editVPackets: TEncodedPacket[] = [];
        for await (const p of new EncodedPacketSink(editVideoTrack).packets()) editVPackets.push(p);
        if (editVPackets.length > 0) {
          const firstTs = editVPackets[0].timestamp;
          editVPackets = editVPackets.map(p => p.clone({ timestamp: p.timestamp - firstTs + mainDuration }));
        }

        const MERGED_SR = 44100;
        const allAudioPackets: TEncodedPacket[] = [];
        let sharedAudioConfig: AudioDecoderConfig | null = null;
        setRecStatus('Mixing audio...');
        try {
          if (typeof AudioEncoder === 'undefined' || typeof OfflineAudioContext === 'undefined')
            throw new Error('Web Audio API not supported');

          const tempCtx = new AudioContext({ sampleRate: MERGED_SR });
          let mainAudioBuffer: AudioBuffer;
          try { mainAudioBuffer = await tempCtx.decodeAudioData(mainBuffer.slice(0)); }
          catch { mainAudioBuffer = tempCtx.createBuffer(2, Math.ceil(mainDuration * MERGED_SR), MERGED_SR); }
          const editAudioBuffer = await tempCtx.decodeAudioData(editArrayBuffer.slice(0));
          await tempCtx.close();

          const totalSamples = Math.ceil((mainDuration + editAudioBuffer.duration) * MERGED_SR);
          const offCtx = new OfflineAudioContext(2, totalSamples, MERGED_SR);
          const ms = offCtx.createBufferSource(); ms.buffer = mainAudioBuffer; ms.connect(offCtx.destination); ms.start(0);
          const es = offCtx.createBufferSource(); es.buffer = editAudioBuffer; es.connect(offCtx.destination); es.start(mainDuration);
          const mixed = await offCtx.startRendering();

          const encoded = await encodeMixToAac(mixed);
          if (encoded.packets.length > 0) {
            sharedAudioConfig = encoded.config;
            allAudioPackets.push(...encoded.packets);
          }
        } catch (audioErr) {
          console.error('[mergeWithEdit] audio mix/encode failed:', audioErr);
        }

        const mergeOut = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        const mergeVSrc = new EncodedVideoPacketSource('avc');
        mergeOut.addVideoTrack(mergeVSrc);
        let mergeASrc: TEncodedAudioPacketSource | null = null;
        if (allAudioPackets.length > 0) {
          mergeASrc = new EncodedAudioPacketSource('aac');
          mergeOut.addAudioTrack(mergeASrc);
        }
        await mergeOut.start();
        for (let i = 0; i < mainVPackets.length; i++) await mergeVSrc.add(mainVPackets[i], i === 0 && mainVideoConfig ? { decoderConfig: mainVideoConfig } : undefined);
        for (let i = 0; i < editVPackets.length; i++) await mergeVSrc.add(editVPackets[i], i === 0 && editVideoConfig ? { decoderConfig: editVideoConfig } : undefined);
        if (mergeASrc) {
          for (let i = 0; i < allAudioPackets.length; i++) await mergeASrc.add(allAudioPackets[i], i === 0 && sharedAudioConfig ? { decoderConfig: sharedAudioConfig } : undefined);
        }
        setRecStatus('Finalizing merged video...');
        await mergeOut.finalize();
        const merged = mergeOut.target.buffer;
        if (!merged) throw new Error('No buffer from merge output');
        return merged;
      }

      // ── Export plan: the ordered clip list the output video IS ────────────────
      // A timeline (multi-clip / multi-source) exports clip-by-clip in ARRAY order; legacy
      // multi-cut segments map onto main-only clips (fixing the old behavior where interior cuts
      // applied to the preview but the export rendered the whole trim window); otherwise the
      // single trim window. Windows are clamped to each source's real duration after demux.
      const tl = exportTimeline;
      const legacySegs = exportSegments;
      const mainSrcUrl = video.src || video.currentSrc;
      let plan: { srcUrl: string; label: string; start: number; end: number }[];
      if (tl && tl.clips.length > 0) {
        plan = tl.clips.map((c, i) => {
          const src = c.src === MAIN_SRC ? { url: mainSrcUrl, name: 'main video' } : tl.sources.find(s => s.id === c.src);
          if (!src?.url) throw new Error(`Timeline clip ${i + 1} references a missing source — remove that clip and try again.`);
          return { srcUrl: src.url, label: src.name || `clip ${i + 1}`, start: c.start, end: c.end };
        });
      } else if (legacySegs && legacySegs.length > 0) {
        plan = [...legacySegs].sort((a, b) => a.start - b.start)
          .map((s, i) => ({ srcUrl: mainSrcUrl, label: `clip ${i + 1}`, start: s.start, end: s.end }));
      } else {
        plan = [{ srcUrl: mainSrcUrl, label: 'main video', start: exportTrimStart, end: exportTrimEnd > 0 ? exportTrimEnd : Infinity }];
      }

      // ── Fetch + demux each distinct source once ──────────────────────────────
      // Demuxed with mediabunny (the same library that already extracts the audio packets and muxes
      // the output), NOT the old hand-rolled MP4Box + avcC extraction: that path could only produce
      // an H.264 decoder config, so any HEVC main video (TikTok HD, iPhone uploads) died with
      // "only H.264 MP4 videos are supported" even though the browser could decode it fine. The
      // container's real decoder config drives VideoDecoder, so anything the browser can decode
      // (H.264, HEVC, VP9, AV1…) exports; a genuinely undecodable codec still fails with a message.
      interface DemuxedSource {
        buffer: ArrayBuffer;
        videoSamples: Array<{ data: Uint8Array; timestamp: number; duration: number; isKeyframe: boolean }>;
        hasAudio: boolean;
        decoderConfig: VideoDecoderConfig;
        duration: number;
      }
      const toFetchUrl = (srcUrl: string) => isDirectFetchable(srcUrl)   // local blob OR our own Supabase storage
        ? srcUrl
        : srcUrl.includes('/api/proxy') ? srcUrl : `/api/proxy?url=${encodeURIComponent(srcUrl)}&stream=1`;

      async function demuxSource(srcUrl: string, label: string): Promise<DemuxedSource> {
        setRecStatus('Downloading video file...');
        let arrayBuffer: ArrayBuffer;
        try {
          const response = await fetch(toFetchUrl(srcUrl));
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          arrayBuffer = await response.arrayBuffer();
        } catch (fetchError) {
          console.error('[EXPORT] ❌ Download failed:', label, fetchError);
          throw new Error(`Failed to download video (${label}): ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`);
        }

        setRecStatus('Parsing video file...');
        const input = new Input({ source: new BlobSource(new Blob([arrayBuffer], { type: 'video/mp4' })), formats: ALL_FORMATS });
        const vTrack = await input.getPrimaryVideoTrack();
        if (!vTrack) throw new Error(`No video track found in ${label}`);
        const decoderConfig = await vTrack.getDecoderConfig();
        if (!decoderConfig) throw new Error(`“${label}” can’t be exported — its video codec couldn’t be read. Try a different file.`);
        const support = await VideoDecoder.isConfigSupported(decoderConfig).catch(() => null);
        if (!support?.supported) {
          throw new Error(`“${label}” can’t be exported — this browser can’t decode its video (${decoderConfig.codec}). Convert it to H.264 MP4 and try again.`);
        }
        const videoSamples: DemuxedSource['videoSamples'] = [];
        const sink = new EncodedPacketSink(vTrack);
        for await (const p of sink.packets()) {
          videoSamples.push({ data: p.data, timestamp: p.timestamp, duration: p.duration, isKeyframe: p.type === 'key' });
        }
        if (videoSamples.length === 0) throw new Error(`No video samples found in ${label}`);
        const hasAudio = !!(await input.getPrimaryAudioTrack());
        const last = videoSamples[videoSamples.length - 1];
        return { buffer: arrayBuffer, videoSamples, hasAudio, decoderConfig, duration: last.timestamp + last.duration };
      }

      // Distinct sources download + demux in PARALLEL — a stitched reel's wall-clock is the slowest
      // source, not the sum (they're independent fetches; demux is I/O-bound on the same bytes).
      const demuxCache = new Map<string, DemuxedSource>();
      const distinctSources = [...new Map(plan.map(p => [p.srcUrl, p.label]))];
      const demuxed = await Promise.all(distinctSources.map(([url, label]) => demuxSource(url, label)));
      if (signal.aborted) throw new Error('Cancelled');
      distinctSources.forEach(([url], i) => demuxCache.set(url, demuxed[i]));

      // Clamp windows to real durations, drop sub-frame slivers, and lay clips out back-to-back —
      // the same packing as timeline.ts / the preview, so what plays is what exports.
      const items = plan
        .map(p => {
          const d = demuxCache.get(p.srcUrl)!;
          const start = Math.max(0, Math.min(p.start, d.duration));
          return { ...p, start, end: Math.max(start, Math.min(p.end, d.duration)) };
        })
        .filter(p => p.end - p.start > 1 / EXPORT_FPS);
      if (items.length === 0) throw new Error('Nothing to export — the timeline has no playable clips.');
      let outAcc = 0;
      const layout = items.map(p => {
        const it = { ...p, out0: outAcc, out1: outAcc + (p.end - p.start) };
        outAcc += p.end - p.start;
        return it;
      });
      const clipDuration = Math.max(0.1, outAcc);   // total OUTPUT duration (drives bitrate + merge offset)
      const totalFrames = Math.floor(clipDuration * EXPORT_FPS);

      // ── Set up output container + audio BEFORE decoding so we can stream ─────
      setRecStatus('Preparing audio...');

      const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
      // Duration-aware bitrate: budget the VIDEO track at 44 MiB so the finished MP4 (plus audio and
      // container overhead) always lands under the 50 MiB storage upload cap. The previous QUALITY_HIGH
      // preset resolved to a flat 6 Mbps for 1080x1920 regardless of length, which crossed the cap
      // around the 66s mark and 400'd longer reels' schedule uploads ("Failed to upload the reel",
      // incident 2026-07-19). The 10 Mbps ceiling is a quality bump for short clips (<~35s); the floor
      // keeps a max-length reel (~90s → ~4 Mbps) visually fine for 1080x1920 H.264. NOTE: the
      // includeEdit merge appends the edit clip's packets on top of this budget; renderUpload's
      // preflight catches any overflow with an actionable message.
      const VIDEO_BUDGET_BITS = 44 * 1024 * 1024 * 8;
      const exportBitrate = Math.max(2_000_000, Math.min(10_000_000, Math.floor(VIDEO_BUDGET_BITS / clipDuration)));
      const videoSource = new VideoSampleSource({ codec: 'avc', bitrate: exportBitrate });
      output.addVideoTrack(videoSource);

      let audioPackets: TEncodedPacket[] = [];
      let audioDecoderConfigForExport: AudioDecoderConfig | null = null;
      let audioDecodeFailed = false;
      const anySourceAudio = layout.some(p => demuxCache.get(p.srcUrl)?.hasAudio ?? false);

      if (anySourceAudio && layout.length === 1) {
        // Single clip → lossless fast path: copy the source's packets for the window, no re-encode.
        // ONLY when the source audio actually IS AAC: the mediabunny demux admits any container the
        // browser decodes (WebM/Opus uploads, MOV/PCM), and feeding non-AAC packets into the
        // 'aac'-declared output track would produce a broken/mislabeled MP4 or a cryptic mid-export
        // throw. Anything else falls through to the PCM re-encode below.
        const only = layout[0];
        const d = demuxCache.get(only.srcUrl)!;
        try {
          const input = new Input({ source: new BlobSource(new Blob([d.buffer], { type: 'video/mp4' })), formats: ALL_FORMATS });
          const audioTrack = await input.getPrimaryAudioTrack();
          const cfg = audioTrack ? await audioTrack.getDecoderConfig() : null;
          if (audioTrack && cfg?.codec?.startsWith('mp4a')) {
            audioDecoderConfigForExport = cfg;
            const sink = new EncodedPacketSink(audioTrack);
            for await (const packet of sink.packets()) audioPackets.push(packet);
            const firstTs = audioPackets[0]?.timestamp || 0;
            audioPackets = audioPackets
              .map(p => p.clone({ timestamp: p.timestamp - firstTs }))
              .filter(p => p.timestamp >= only.start && p.timestamp < only.end);
            if (audioPackets.length > 0) {
              const firstTrim = audioPackets[0].timestamp;
              audioPackets = audioPackets.map(p => p.clone({ timestamp: p.timestamp - firstTrim }));
            }
          }
        } catch (e) { console.error('[audio setup]', e); audioPackets = []; }
        audioDecoderConfigForExport = audioPackets.length > 0 ? audioDecoderConfigForExport : null;
      }
      if (anySourceAudio && audioPackets.length === 0) {
        // Decode each source's audio to PCM once, place every clip's slice at its output position
        // on an offline context, and re-encode the assembled track to AAC. This is the multi-clip
        // path AND the fallback for single clips whose audio isn't AAC (or whose packet copy
        // failed) — packet-copying can't express reordered/multi-source/mixed-codec audio.
        setRecStatus('Assembling audio...');
        try {
          if (typeof AudioEncoder === 'undefined' || typeof OfflineAudioContext === 'undefined')
            throw new Error('Web Audio API not supported');
          const MERGED_SR = 44100;
          const pcmCache = new Map<string, AudioBuffer | null>();
          const tempCtx = new AudioContext({ sampleRate: MERGED_SR });
          for (const url of new Set(layout.map(p => p.srcUrl))) {
            const d = demuxCache.get(url)!;
            if (!d.hasAudio) { pcmCache.set(url, null); continue; }
            try { pcmCache.set(url, await tempCtx.decodeAudioData(d.buffer.slice(0))); }
            catch { pcmCache.set(url, null); audioDecodeFailed = true; }   // that source exports silent
          }
          await tempCtx.close();
          const offCtx = new OfflineAudioContext(2, Math.ceil(clipDuration * MERGED_SR), MERGED_SR);
          let placed = false;
          for (const p of layout) {
            const buf = pcmCache.get(p.srcUrl);
            if (!buf) continue;
            const s = offCtx.createBufferSource();
            s.buffer = buf;
            s.connect(offCtx.destination);
            s.start(p.out0, p.start, p.end - p.start);
            placed = true;
          }
          if (placed) {
            const mixed = await offCtx.startRendering();
            const encoded = await encodeMixToAac(mixed);
            audioPackets = encoded.packets;
            audioDecoderConfigForExport = encoded.config;
          }
        } catch (e) { console.error('[audio assembly]', e); audioPackets = []; }
      }

      let audioSource: TEncodedAudioPacketSource | null = null;
      if (audioPackets.length > 0) {
        audioSource = new EncodedAudioPacketSource('aac');
        output.addAudioTrack(audioSource);
      }
      // A source had audio but none (or not all of it) made it into the export → the user should
      // hear about it here, not discover it on Instagram.
      const audioDropped = audioDecodeFailed || (anySourceAudio && audioPackets.length === 0);

      // Ensure logo is loaded with crossOrigin=anonymous — the preview canvas may have
      // cached it without CORS, which would taint the OffscreenCanvas and fail VideoSample.
      if (overlayLogoSrc && (!logoImgRef.current?.crossOrigin)) {
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { logoImgRef.current = img; resolve(); };
          img.onerror = () => resolve();
          img.src = overlayLogoSrc;
        });
      }

      // FeedForce rewards sticker lockup — pre-loaded with CORS like the logo above so it can't taint
      // the OffscreenCanvas. Resolves on error too: drawRewardsSticker then draws its text fallback,
      // so the sticker never silently vanishes from a bake. Variant matches the preview's pick.
      const stickerVar = stickerEnabled ? stickerVariant(isClean ? '#fff' : twitterSettings.headerBgColor) : null;
      let stickerImg: HTMLImageElement | null = null;
      if (stickerVar) {
        stickerImg = await new Promise<HTMLImageElement>((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => resolve(img);
          img.onerror = () => resolve(img);
          img.src = rewardsStickerSrc(stickerVar);
        });
      }

      // Pre-load market avatar with CORS so it doesn't taint the OffscreenCanvas.
      if (marketData?.photo_url && marketAvatarImgRef) {
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { marketAvatarImgRef.current = img; resolve(); };
          img.onerror = () => resolve();
          img.src = marketData.photo_url!;
        });
      }

      // Pre-load any cell images (CORS) so they're ready for every exported frame.
      const cellImgs = new Map<string, HTMLImageElement>();
      for (const url of [
        twitterSettings.cellTop?.imageUrl, twitterSettings.cellTop2?.imageUrl, twitterSettings.cellBottom?.imageUrl, twitterSettings.cellBottom2?.imageUrl,
        twitterSettings.cellTop?.banner?.avatarUrl, twitterSettings.cellTop2?.banner?.avatarUrl, twitterSettings.cellBottom?.banner?.avatarUrl, twitterSettings.cellBottom2?.banner?.avatarUrl,
        ...(twitterSettings.freeElements ?? []).map(el => el.type === 'image' ? el.imageUrl : (el.type === 'banner' || el.type === 'bannerText') ? el.banner?.avatarUrl : undefined),
      ]) {
        if (!url || cellImgs.has(url)) continue;
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { cellImgs.set(url, img); resolve(); };
          img.onerror = () => resolve();
          img.src = url;
        });
      }

      // Ensure text-cell fonts are loaded before drawing any frame, so exports bake in the chosen font.
      await ensureReelTextFontsLoaded(twitterSettings);

      await output.start();

      // ── Streaming decode + render, clip by clip ──────────────────────────────
      // Frames stream through a bounded queue (queue-all-then-flush deadlocks: the decoder's GPU
      // frame pool fills up and frames never get closed until flush returns). Each clip gets a
      // FRESH decoder — sources differ (different avcC descriptions), and feeding from the nearest
      // preceding keyframe makes a mid-source in-point cheap without decoding the whole file.
      setRecStatus('Encoding...');

      const offscreen = new OffscreenCanvas(CANVAS_W, CANVAS_H);
      const offCtx = offscreen.getContext('2d')!;
      const STALL_MS = 20_000;

      // Draw ONE decoded frame through the reel template. Sizing uses the FRAME's own dimensions —
      // clips from different sources can differ in resolution/aspect, and each must cover-fit
      // exactly as the live preview does (which reads the active element's videoWidth/Height).
      const renderFrame = (frame: VideoFrame) => {
        const vw = frame.displayWidth || 1080;
        const vh = frame.displayHeight || 1920;

        if (isClean) {
          // ── Caption template: white bg, caption above, video in crop box ──
          offCtx.fillStyle = '#fff';
          offCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);

          const cropBox = exportBox;
          const { x: ox, y: oy } = exportOffset;

          if (overlayCaption) {
            const captionLines = countCaptionLines(offCtx, overlayCaption);
            const CAPTION_BOTTOM_OFFSET = 18;
            const CLEAN_PAD_TOP = 44;
            const CLEAN_PAD_BOT = 40;
            const captionAreaH = CLEAN_PAD_TOP + (captionLines * CAPTION_LINE_HEIGHT) + CLEAN_PAD_BOT - CAPTION_BOTTOM_OFFSET;
            const captionAreaY = Math.max(0, cropBox.y - captionAreaH + 4);

            offCtx.font = `400 44px "Libre Franklin", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
            offCtx.fillStyle = '#000';
            const padX = HEADER_PADDING_X + 43;
            const maxWidth = CANVAS_W - padX * 2;
            let cy = captionAreaY + CLEAN_PAD_TOP + CAPTION_LINE_HEIGHT - 10;

            for (const userLine of overlayCaption.split('\n')) {
              if (!userLine) { cy += CAPTION_LINE_HEIGHT; continue; }
              let line = '';
              for (const word of userLine.split(' ')) {
                const test = line + word + ' ';
                if (offCtx.measureText(test).width > maxWidth && line) {
                  offCtx.fillText(line.trimEnd(), padX, cy);
                  line = word + ' '; cy += CAPTION_LINE_HEIGHT;
                } else { line = test; }
              }
              offCtx.fillText(line.trimEnd(), padX, cy);
              cy += CAPTION_LINE_HEIGHT;
            }
          }

          const scale = (CANVAS_W / vw) * exportScale;
          const dx = (CANVAS_W - vw * scale) / 2 + ox;
          const dy = (CANVAS_H - vh * scale) / 2 + oy;

          offCtx.save();
          offCtx.beginPath();
          offCtx.rect(cropBox.x, cropBox.y, cropBox.w, cropBox.h);
          offCtx.clip();
          offCtx.drawImage(frame, dx, dy, vw * scale, vh * scale);
          offCtx.restore();

          // FeedForce rewards sticker — drawn LAST, just below the crop (matches the live preview).
          if (stickerVar) {
            drawRewardsSticker({ ctx: offCtx, img: stickerImg, variant: stickerVar, centerX: cropBox.x + cropBox.w / 2, bottomY: cropBox.y + cropBox.h, maxW: cropBox.w });
          }
          return;
        }

        // ── Twitter template ──
        offCtx.fillStyle = twitterSettings.headerBgColor;
        offCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);

        const { x: ox, y: oy } = exportOffset;

        if (cellMode) {
          // ── Reel cell layout: [top · top2] · centred video band · [bottom · bottom2] ──
          const L = reelLayout(twitterSettings);
          const getCellImg = (url?: string) => (url && cellImgs.get(url)) || null;
          // The video band is a reorderable z-layer: free elements before `videoLayer` draw BEHIND it, so
          // they must be painted before the video frame; the rest paint on top afterwards.
          const videoLayer = twitterSettings.videoLayer ?? 0;
          // When the video is cropped, the free elements follow the crop edges so spacing holds (matches
          // the live preview). No crop → same array, identical export.
          const cropTw = { ...twitterSettings, freeElements: shiftFreeElementsForReelCrop(twitterSettings.freeElements ?? [], L, exportBox, twitterSettings) };
          drawFreeElements({
            ctx: offCtx, s: cropTw,
            logoSrc: overlayLogoSrc, name: overlayDisplayName, handle: overlayHandle,
            logoImgRef, verifiedImgRef, placeholder: false, getCellImg, overlayCaption, to: videoLayer,
          });
          // Match the live preview: tc/bc CROP the video (clip window = boxRef y/h); the video itself
          // stays positioned by the layout band, so it never moves/rescales while cropping.
          const r = reelVideoRect(vw, vh, L, exportScale, ox, oy);
          offCtx.save();
          offCtx.beginPath();
          offCtx.roundRect(L.bandX, exportBox.y, L.bandW, exportBox.h, twitterSettings.videoCornerRadius ?? 24);
          offCtx.clip();
          offCtx.drawImage(frame, r.dx, r.dy, r.dw, r.dh);
          offCtx.restore();

          drawReelCells({
            ctx: offCtx, s: twitterSettings, L,
            logoSrc: overlayLogoSrc, name: overlayDisplayName, handle: overlayHandle,
            logoImgRef, verifiedImgRef, placeholder: false, getCellImg, overlayCaption,
          });
          drawFreeElements({
            ctx: offCtx, s: cropTw,
            logoSrc: overlayLogoSrc, name: overlayDisplayName, handle: overlayHandle,
            logoImgRef, verifiedImgRef, placeholder: false, getCellImg, overlayCaption, from: videoLayer,
          });
          // FeedForce rewards sticker — drawn LAST, above cells/free elements (matches the live preview).
          if (stickerVar) {
            drawRewardsSticker({ ctx: offCtx, img: stickerImg, variant: stickerVar, centerX: L.bandX + L.bandW / 2, bottomY: exportBox.y + exportBox.h, maxW: L.bandW });
          }
        } else {
          // ── Market reels: X header above the video + market row (legacy layout) ──
          const cropBox = exportBox;
          const videoTargetW = CANVAS_W - 2 * (twitterSettings.cellMargin ?? 60);
          const scale = Math.min(videoTargetW / vw, CANVAS_H / vh) * exportScale;
          const dx = (CANVAS_W - vw * scale) / 2 + ox;
          const dy = (CANVAS_H - vh * scale) / 2 + oy;

          offCtx.save();
          offCtx.beginPath();
          offCtx.rect(cropBox.x, cropBox.y, cropBox.w, cropBox.h);
          offCtx.clip();
          offCtx.drawImage(frame, dx, dy, vw * scale, vh * scale);
          offCtx.restore();

          const headerHeight = computeSonotradeHeaderHeight(offCtx, overlayCaption, twitterSettings);
          const headerY = Math.max(0, cropBox.y - headerHeight + 4);
          drawHeaderOnContext({ ctx: offCtx, cx: 0, cy: headerY, cw: CANVAS_W, ...headerDrawOpts });

          if (marketData && marketAvatarImgRef && marketAvatarUrlRef) {
            drawMarketRow({
              ctx: offCtx,
              cx: 0,
              videoBottomY: cropBox.y + cropBox.h,
              cw: CANVAS_W,
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

          // FeedForce rewards sticker — drawn LAST, below the crop (and the market row when shown).
          if (stickerVar) {
            drawRewardsSticker({ ctx: offCtx, img: stickerImg, variant: stickerVar, centerX: cropBox.x + cropBox.w / 2, bottomY: cropBox.y + cropBox.h + (marketData ? MARKET_ROW_H : 0), maxW: cropBox.w });
          }
        }
      };

      // Decode one clip's sample window and emit its output frames [k0, k1).
      async function renderClip(
        d: DemuxedSource,
        clip: { start: number; end: number; out0: number },
        k0: number,
        k1: number,
      ): Promise<void> {
        // Sample window: from the last keyframe at/before the in-point (decode order) to a little
        // past the out-point — the margin covers B-frame reordering around the cut.
        let keyIdx = 0;
        for (let i = 0; i < d.videoSamples.length; i++) {
          const s = d.videoSamples[i];
          if (s.timestamp > clip.start) break;
          if (s.isKeyframe) keyIdx = i;
        }
        let endIdx = d.videoSamples.length;
        for (let i = keyIdx; i < d.videoSamples.length; i++) {
          if (d.videoSamples[i].timestamp > clip.end + 0.5) { endIdx = i; break; }
        }
        const samples = d.videoSamples.slice(keyIdx, endIdx);

        const frameQueue: Array<{ frame: VideoFrame; ts: number }> = [];
        let decoderError: Error | null = null;
        let producerDone = false;
        let consumerWaiter: (() => void) | null = null;
        let producerWaiter: (() => void) | null = null;
        const wakeConsumer = () => { const r = consumerWaiter; consumerWaiter = null; r?.(); };
        const wakeProducer = () => { const r = producerWaiter; producerWaiter = null; r?.(); };

        // Bounded wait for the next decoded frame. A silently-stalled VideoDecoder — Windows hardware decode
        // can stop emitting frames with NO `output` and NO `error` — would otherwise leave the consumer (and
        // the whole export) hanging forever. A healthy decoder emits frames in milliseconds, so 20s with zero
        // new frames is a definite stall: reject so the export fails cleanly (and retryable) instead of freezing.
        const waitForFrame = () => new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('Video export stalled while decoding — please try again.')), STALL_MS);
          consumerWaiter = () => { clearTimeout(t); resolve(); };
        });

        const decoder = new VideoDecoder({
          output: (frame: VideoFrame) => {
            frameQueue.push({ frame, ts: frame.timestamp / 1_000_000 });
            wakeConsumer();
          },
          error: (e: Error) => {
            decoderError = e;
            console.error('[EXPORT] ❌ VideoDecoder error:', e, 'name:', e?.name, 'message:', e?.message);
            wakeConsumer();
            wakeProducer();
          },
        });

        decoder.configure(d.decoderConfig);   // the container's real config (any browser-decodable codec)

        // Cap how many decoded frames sit in memory before the producer waits.
        // Empirically Chromium's H.264 decoder needs ~4-8 frames in flight for
        // reorder buffer; 12 leaves headroom without blowing GPU memory.
        const MAX_BUFFERED = 12;

        const producer = (async () => {
          try {
            for (let i = 0; i < samples.length; i++) {
              if (signal.aborted) throw new Error('Cancelled');
              if (decoderError) throw decoderError;
              while (frameQueue.length >= MAX_BUFFERED) {
                await new Promise<void>((r) => { producerWaiter = r; });
                if (signal.aborted) throw new Error('Cancelled');
                if (decoderError) throw decoderError;
              }
              const s = samples[i];
              decoder.decode(new EncodedVideoChunk({
                type: s.isKeyframe ? 'key' : 'delta',
                timestamp: s.timestamp * 1_000_000,
                data: s.data,
              }));
            }
            // Bound flush too: decoder.flush() can hang on a stalled hardware decoder, which would leave the
            // final `await producer` below hanging forever. A healthy flush is near-instant (frames stream out
            // continuously above), so a generous timeout never cuts a real one.
            let flushTimer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              decoder.flush().finally(() => clearTimeout(flushTimer)),
              new Promise<never>((_, reject) => { flushTimer = setTimeout(() => reject(new Error('Video export stalled (decoder flush timed out) — please try again.')), STALL_MS + 10_000); }),
            ]);
          } finally {
            producerDone = true;
            wakeConsumer();
          }
        })();
        // Surface producer failure to the consumer loop.
        producer.catch((e) => {
          if (!decoderError) decoderError = e instanceof Error ? e : new Error(String(e));
          producerDone = true;
          wakeConsumer();
        });

        let currentFrame: { frame: VideoFrame; ts: number } | null = null;

        // Advance `currentFrame` to the latest decoded frame with ts <= targetTs,
        // closing earlier frames as we step past them. Waits for the producer if
        // nothing's available yet.
        const advanceTo = async (targetTs: number): Promise<void> => {
          while (true) {
            if (decoderError) throw decoderError;
            if (signal.aborted) throw new Error('Cancelled');

            while (frameQueue.length > 0 && frameQueue[0].ts <= targetTs) {
              if (currentFrame) currentFrame.frame.close();
              currentFrame = frameQueue.shift()!;
              wakeProducer();
            }

            // Queue head (if any) has ts > targetTs — we're settled.
            if (frameQueue.length > 0) {
              // First-frame edge case: no current frame because the first decoded
              // frame's ts is already past targetTs. Adopt it anyway.
              if (!currentFrame) {
                currentFrame = frameQueue.shift()!;
                wakeProducer();
              }
              return;
            }

            // Queue empty + producer done → no more frames coming.
            if (producerDone) return;

            // Wait for the next decoded frame (bounded — see waitForFrame: a stalled decoder fails cleanly).
            await waitForFrame();
          }
        };

        try {
          for (let k = k0; k < k1; k++) {
            if (signal.aborted) throw new Error('Cancelled');

            const outT = k * EXPORT_FRAME_DURATION;
            await advanceTo(clip.start + (outT - clip.out0));
            if (!currentFrame) {
              console.warn('[EXPORT] no frame available at output frame', k, '— stopping this clip early');
              break;
            }
            renderFrame((currentFrame as { frame: VideoFrame; ts: number }).frame);
            const sample = new VideoSample(offscreen, { timestamp: outT, duration: EXPORT_FRAME_DURATION });
            await videoSource.add(sample);
            sample.close();
            reportProgress(0.15 + (k / totalFrames) * 0.7);
            // Yield a REAL task periodically: this loop otherwise runs on microtasks alone
            // (decode → draw → encode), so the browser never paints and React never gets a task
            // boundary — its nested-update counter accumulates across the per-frame progress
            // renders until it throws "Maximum update depth exceeded" (2026-07-20).
            if ((k - k0) % 15 === 14) await new Promise<void>(r => setTimeout(r, 0));
          }
        } finally {
          // Cast: TS's flow analysis can't see advanceTo's closure assignments and narrows this to null.
          (currentFrame as { frame: VideoFrame; ts: number } | null)?.frame.close();
          currentFrame = null;
          while (frameQueue.length > 0) frameQueue.shift()!.frame.close();
          wakeProducer(); // in case it's still waiting on backpressure
        }

        // Wait for producer (decode + flush) to complete before closing decoder.
        try { await producer; } catch { /* already surfaced via decoderError */ }
        if (decoderError) throw decoderError;
        try { decoder.close(); } catch { /* may already be closed */ }
      }

      // Frame k belongs to the clip whose output window contains k/FPS; the last clip absorbs
      // rounding so exactly totalFrames frames are emitted.
      let renderedK = 0;
      for (let ci = 0; ci < layout.length; ci++) {
        const p = layout[ci];
        const kEnd = ci === layout.length - 1 ? totalFrames : Math.min(totalFrames, Math.floor(p.out1 * EXPORT_FPS + 1e-6));
        if (kEnd > renderedK) {
          await renderClip(demuxCache.get(p.srcUrl)!, p, renderedK, kEnd);
          renderedK = kEnd;
        }
      }

      if (audioSource && audioPackets.length > 0) {
        setRecStatus('Adding audio...');
        for (let i = 0; i < audioPackets.length; i++) {
          await audioSource.add(audioPackets[i], i === 0 && audioDecoderConfigForExport ? { decoderConfig: audioDecoderConfigForExport } : undefined);
        }
      }

      setRecStatus('Finalizing...');
      setRecProgress(0.95);
      await output.finalize();

      let buffer = output.target.buffer;
      if (!buffer) throw new Error('No buffer received from output');
      if (exportIncludeEdit) buffer = await mergeWithEdit(buffer, clipDuration);

      const blob = new Blob([buffer], { type: 'video/mp4' });

      // Pre-render mode (Post scheduler): hand the baked MP4 back to the caller instead of
      // saving/downloading it — they upload it and post it to Instagram.
      if (opts?.returnBlob) { setRecProgress(1); return blob; }

      // Filename = short, readable version of the on-card caption (word-boundary
      // truncated). Falls back to the old row/id naming when there's no caption.
      const captionBase = (overlayCaption || '').replace(/\s+/g, ' ').trim();
      let nameBase = captionBase;
      if (nameBase.length > 60) {
        const cut = nameBase.slice(0, 60);
        const lastSpace = cut.lastIndexOf(' ');
        nameBase = (lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim();
      }
      if (!nameBase) nameBase = videoId ?? 'export';
      // Prefix the reel number (its card position) so every export is numbered and sorts in order —
      // reel 1 → "01_….mp4", reel 2 → "02_….mp4", etc.
      nameBase = `${String(rowNumber + 1).padStart(2, '0')}_${nameBase}`;

      // A local "Studio" helper can drop exports straight into a Downloads folder, but it only exists
      // on the operator's own machine — so try it ONLY on localhost and always fall back to a normal
      // browser download. Prod users get the file immediately, with no doomed upload to a 404 route.
      const canLocalSave = typeof window !== 'undefined'
        && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
      let saved = false;
      if (canLocalSave) {
        try {
          const resp = await fetch(`/api/export/save?name=${encodeURIComponent(nameBase)}`, {
            method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: blob,
          });
          if (!resp.ok) throw new Error(await resp.text());
          const data = await resp.json() as { filename?: string };
          setRecStatus(`Saved: ${data.filename ?? nameBase + '.mp4'}`);
          setTimeout(() => setRecStatus(''), 5000);
          saved = true;
          keepStatus = true;
        } catch (saveErr) {
          console.warn('[EXPORT] local save failed, using browser download:', saveErr);
        }
      }
      if (!saved) {
        const url = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: url, download: `${nameBase}.mp4` }).click();
        URL.revokeObjectURL(url);
      }
      // A silently-muted export is worse than a visible warning.
      if (audioDropped) { setRecStatus('⚠ Exported without audio'); setTimeout(() => setRecStatus(''), 6000); keepStatus = true; }
      setRecProgress(1);

    } catch (error) {
      if (error instanceof Error && error.message !== 'Cancelled') {
        console.error('[EXPORT] ❌ EXPORT FAILED:', error);
        console.error('[EXPORT] stack:', error.stack);
        keepStatus = true;
        setRecStatus(`Error: ${error.message}`);
        setTimeout(() => setRecStatus(''), 8000);
        throw error;
      }
    } finally {
      setIsRecording(false);
      setRecProgress(0);
      // Don't wipe a terminal status set just above (error / saved / audio warning): React batches
      // these synchronous updates, so clearing here would coalesce it to '' and it would never render.
      // Each terminal status carries its own timeout to clear itself after it's been seen.
      if (!keepStatus) setRecStatus('');
      resetPreviewAfterExport();
      abortControllerRef.current = null;
    }
  }

  // Export teardown for the PREVIEW. Legacy (no timeline): the historical reset — rewind, re-arm the
  // element loop. With a timeline: the sequencer owns positioning and looping (main.loop stays false
  // so wrap happens at the LAST clip, not the source end), and playback may be running on a hidden
  // extra-source element — pause it all via the sequencer, and never seek outside the clip windows.
  function resetPreviewAfterExport() {
    const v = config.videoRef.current;
    const tlActive = !!config.timelineRef?.current;
    if (tlActive) config.pauseTimeline?.();
    if (v) {
      v.pause();
      v.playbackRate = 1.0;
      if (!tlActive) { v.muted = true; v.currentTime = 0; v.loop = true; }
    }
  }

  function cancelRecording() {
    abortControllerRef.current?.abort();
    setIsRecording(false);
    setRecProgress(0);
    setRecStatus('');
    resetPreviewAfterExport();
  }

  return { isRecording, recProgress, recStatus, startRecording, cancelRecording };
}
