'use client';

import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { TikTokCanvas } from './TikTokCanvas';
import type { TikTokCanvasRef } from './TikTokCanvas';
import { CAROUSEL_PREVIEW_W } from './TemplateEditorCanvas/constants';
import { useTwitterTemplates } from '../hooks/useTwitterTemplates';
import { useReelPersistence, type SavedReel } from '../hooks/useReelPersistence';
import { useRewardsEnrollment } from '../hooks/useRewardsEnrollment';
import { makeEmptyEntry, MAX_REELS } from '@/lib/entry';
import { getCachedVideo, prioritizeVideoFetch } from '@/lib/reelVideoCache';
import { supabase } from '@/lib/supabase';
import { requestUpgrade, upgradeReasonForDbError } from '@/lib/upgradePrompt';
import type { Framing } from './TikTokCanvas/types';
import { TemplatesEmptyState } from './TemplatesEmptyState';
import { defaultTwitterTemplateSettings } from './twitterTemplateTypes';
import type { VideoEntry, BrandProps, ReelTextField, ScheduleReelDraft } from '../types';
import { reelPostText, descriptionSidecar } from '@/lib/reelPostText';
import { describeReelSyncChange } from '@/lib/reelSyncNotice';
import { roundFramingDeep } from '@/lib/framingRound';
import { stripTimeDomainFraming, urlChangeInvalidatesVideo, localVideoChangeInvalidatesVideo } from '@/lib/framingSource';
import type { RecordingState } from './TikTokCanvas/types';
import { VideoControlsBar } from './VideoControlsBar';
import { bestVideoUrl } from '@/lib/utils';
import { getVideoBlob } from '@/lib/reelVideoBlob';
import { authedFetch } from '@/lib/authedFetch';
import { uploadRenderBlob } from '@/lib/renderUpload';
import { uploadDurableVideo } from '@/lib/sheetVideoUpload';
import { classifyReelDuration, effectiveReelDuration } from '@/lib/reelDuration';
import { ScheduleAllModal, type ScheduleAllReelItem, type ScheduleAllSubmitArgs } from './ScheduleAllModal';
import { Button, IconButton, Modal, HEADER_H } from './ui';
import { AutosaveChip } from './AutosaveChip';
import { useExportGuard, ExportQuotaChip } from './ExportGuard';
import { usePlan } from './PlanContext';
import { ElementRail, RailActionButton } from './ElementRail';
import { ReelTemplatePreview } from './ReelTemplatePreview';
import { SlidesStrip } from './SlidesStrip';
import { EditorScrollBar } from './EditorScrollBar';
import { ZoomControl } from './ZoomControl';
import { useObservedSize, fitScaleFor } from '@/app/hooks/useElementSize';
import { useEditorZoomPan, EDITOR_ZOOM_MIN as ZOOM_MIN, EDITOR_ZOOM_MAX as ZOOM_MAX } from '@/app/hooks/useEditorZoomPan';
import {
  UploadIcon, ArrowRightIcon, SpinnerIcon,
  CloseIcon, DownloadIcon, VideoIcon, LinkIcon, ChevronDownIcon, TrashIcon,
} from '@/lib/icons';

const CARD_W = CAROUSEL_PREVIEW_W; // 410 — same width as canvas preview

// Height of the flow spacer at the end of the scroll content, reserving room so the reel centres above
// the docked slides strip rather than behind it (matches the carousels editor's SLIDES_DOCK_CLEARANCE).
const SLIDES_DOCK_CLEARANCE = 120;

// Schedule All submits rendered reels to POST /api/schedule/posts/bulk in chunks of this many items
// (the route's per-call cap).
const BULK_CHUNK = 10;

// The base filename (no extension) a single reel export uses. MIRRORS useRecording.ts's naming (keep
// in sync): a short, word-boundary-truncated version of the on-card caption, numbered by card
// position, falling back to the video id (then 'export'). Used to name the description sidecar .txt so
// it lands next to the browser-downloaded .mp4.
function reelExportBaseName(caption: string | null | undefined, rowNumber: number, videoId?: string): string {
  const captionBase = (caption || '').replace(/\s+/g, ' ').trim();
  let nameBase = captionBase;
  if (nameBase.length > 60) {
    const cut = nameBase.slice(0, 60);
    const lastSpace = cut.lastIndexOf(' ');
    nameBase = (lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim();
  }
  if (!nameBase) nameBase = videoId ?? 'export';
  return `${String(rowNumber + 1).padStart(2, '0')}_${nameBase}`;
}


interface CanvasGridProps {
  entries: VideoEntry[];
  setEntries?: Dispatch<SetStateAction<VideoEntry[]>>;   // present in the Video Reels workspace (entries are page-owned)
  canvasRefsMap: MutableRefObject<Map<string, TikTokCanvasRef>>;
  brand: BrandProps;
  onAddRow: () => void;
  onRemoveRow: (id: string) => void;
  onDuplicateRow: (id: string) => string | null;   // inserts a copy, returns the new id (null if at the reel cap)
  onDeleteAllReels?: () => void;                    // reset the grid to one empty reel + GC stored media
  onHandleVideoError: (id: string) => void;
  onUpdateEntry: (id: string, field: ReelTextField, value: string) => void;
  onUpdateLocalVideo: (id: string, src: string, name: string) => void;
  onFetchVideo: (id: string) => void;
  userId: string | null;
  videoMode: 'twitter' | 'caption';                          // current overlay style (drives the Twitter template picker + rendering)
  onGoToTemplateEditor?: () => void;                         // reels posting: jump to the template editor when there are no reel templates
  viewToggle?: React.ReactNode;                              // Canvas ⇄ Sheet segmented control, rendered in the toolbar's left slot
  active?: boolean;                                          // false when the Sheet view is showing — suppresses the body-portalled scroll bar
  onScheduleReel?: (draft: ScheduleReelDraft) => void; // "Schedule": hand the exported reel MP4 (+ caption/description) to the Post screen
  onRestored?: () => void;                                   // fires once the saved grid has been applied (Sheet sends wait for this)
  restored?: boolean;                                        // true on a nav-back remount (page-load restore already ran): re-seed maps, don't rebuild entries
}

// ── Reels posting rail: Link + Caption flyouts (edit the SELECTED reel) + URL/caption undo history ─────
const linkGlyph = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);
const captionGlyph = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
);
// Distinct from captionGlyph: a document with text lines (the written video description that posts as the
// Instagram caption), so the Caption and Description rail items read as clearly different affordances.
const descriptionGlyph = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M9 8h6M9 12h6M9 16h4" />
  </svg>
);
const SVG_PROPS = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const zoomInGlyph  = (<svg {...SVG_PROPS}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M11 8v6M8 11h6" /></svg>);
const zoomOutGlyph = (<svg {...SVG_PROPS}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M8 11h6" /></svg>);
const resetGlyph   = (<svg {...SVG_PROPS}><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" /><path d="M21 3v5h-5" /></svg>);
const centerGlyph  = (<svg {...SVG_PROPS}><circle cx="12" cy="12" r="2.5" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>);
const timelineGlyph = (<svg {...SVG_PROPS}><path d="M3 12h18" /><rect x="8" y="9" width="4" height="6" rx="1" /></svg>);
const removeVideoGlyph = (<svg {...SVG_PROPS}><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10.5 21 8v8l-5-2.5" /><path d="m3 3 18 18" /></svg>);
// Sticker with a peeled corner — the FeedForce rewards sticker toggle.
const stickerGlyph = (<svg {...SVG_PROPS}><path d="M20 13V7a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h6" /><path d="M13 20v-4a3 3 0 0 1 3-3h4l-7 7Z" /></svg>);

// The selected reel's video source — paste a URL / upload a file / fetch. Ported from the old inline card.
function ReelLinkFlyout({ entry, onUpdateField, onUpdateLocalVideo, onFetch }: {
  entry: VideoEntry;
  onUpdateField: (field: ReelTextField, value: string) => void;
  onUpdateLocalVideo: (src: string, name: string) => void;
  onFetch: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const hasLocal = !!entry.localVideoSrc;
  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    onUpdateLocalVideo(URL.createObjectURL(file), file.name);
    onUpdateField('url', '');
    if (fileRef.current) fileRef.current.value = '';
  }
  function clearLocalVideo() {
    if (entry.localVideoSrc) URL.revokeObjectURL(entry.localVideoSrc);
    onUpdateLocalVideo('', '');
  }
  return (
    <div className="flex flex-col gap-2">
      {hasLocal ? (
        <div className="flex items-center gap-2">
          <VideoIcon size={13} className="text-fg-2 shrink-0" />
          <span className="text-body text-fg-2 truncate flex-1 min-w-0">{entry.localVideoName || 'Uploaded video'}</span>
          <IconButton icon={<UploadIcon />} label="Change video" variant="secondary" onClick={() => fileRef.current?.click()} />
          <IconButton icon={<CloseIcon size={13} />} label="Remove video" variant="secondary" onClick={clearLocalVideo} />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 border border-line-strong rounded-md px-2.5 h-9">
            <LinkIcon size={13} className="text-fg-3 shrink-0" />
            <input
              type="url"
              value={entry.url}
              onChange={e => onUpdateField('url', e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') onFetch(); }}
              placeholder="Paste TikTok, Instagram or X URL…"
              className="flex-1 min-w-0 bg-transparent text-body text-fg placeholder:text-fg-3 outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <IconButton icon={<UploadIcon />} label="Upload video file" variant="secondary" onClick={() => fileRef.current?.click()} />
            <IconButton
              icon={entry.loading ? <SpinnerIcon style={{ animation: 'spin 1s linear infinite' }} /> : <ArrowRightIcon />}
              label="Fetch video"
              variant="secondary"
              onClick={onFetch}
              disabled={entry.loading || !entry.url.trim() || (!!entry.data && !entry.videoFailed)}
            />
          </div>
        </>
      )}
      <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={handleFile} />
      {entry.error && !hasLocal && <span className="text-caption text-danger-text">{entry.error}</span>}
    </div>
  );
}

// The selected reel's caption.
function ReelCaptionFlyout({ entry, onUpdateField }: {
  entry: VideoEntry;
  onUpdateField: (field: ReelTextField, value: string) => void;
}) {
  return (
    <textarea
      value={entry.caption}
      onChange={e => onUpdateField('caption', e.target.value)}
      placeholder="Caption…"
      rows={5}
      autoFocus
      className="w-full bg-transparent text-body text-fg placeholder:text-fg-3 outline-none resize-none leading-relaxed border border-line-strong rounded-md p-2.5"
    />
  );
}

// The selected reel's description: the Instagram post caption when scheduled, a sidecar .txt when
// downloaded. Mirrors ReelCaptionFlyout; edits entry.description.
function ReelDescriptionFlyout({ entry, onUpdateField }: {
  entry: VideoEntry;
  onUpdateField: (field: ReelTextField, value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        value={entry.description}
        onChange={e => onUpdateField('description', e.target.value)}
        placeholder="Description…"
        rows={5}
        autoFocus
        className="w-full bg-transparent text-body text-fg placeholder:text-fg-3 outline-none resize-none leading-relaxed border border-line-strong rounded-md p-2.5"
      />
      <span className="text-caption text-fg-3 leading-snug">
        Becomes the Instagram caption when you schedule; exported as a .txt when you download.
      </span>
    </div>
  );
}

// The selected reel's video adjustments as a rail-island icon-button COLUMN (rail convention):
// zoom in, zoom out, reset (framing + trim + zoom back to defaults), center, and the timeline toggle.
function ReelAdjustFlyout({ zoom, onZoom, onResetTrim, onResetBox, onCenter, timelineOpen, onToggleTimeline, onRemoveVideo, stickerEnabled, onToggleSticker }: {
  zoom: number;
  onZoom: (z: number) => void;
  onResetTrim: () => void;
  onResetBox: () => void;
  onCenter: () => void;
  timelineOpen: boolean;
  onToggleTimeline: () => void;
  onRemoveVideo: () => void;
  // FeedForce rewards sticker toggle — onToggleSticker is set only for enrolled rewards members.
  stickerEnabled?: boolean;
  onToggleSticker?: () => void;
}) {
  const STEP = 0.05, MIN = 0.5, MAX = 3;
  const round2 = (z: number) => Math.round(z * 100) / 100;
  // Just the button column — ElementRail provides the animated pill card (it expands in once a video
  // is loaded), so this renders only the content.
  return (
    <>
      <RailActionButton label={`Zoom in (${Math.round(zoom * 100)}%)`}  icon={zoomInGlyph}  disabled={zoom >= MAX} onClick={() => onZoom(Math.min(MAX, round2(zoom + STEP)))} />
      <RailActionButton label={`Zoom out (${Math.round(zoom * 100)}%)`} icon={zoomOutGlyph} disabled={zoom <= MIN} onClick={() => onZoom(Math.max(MIN, round2(zoom - STEP)))} />
      <RailActionButton label="Reset"  icon={resetGlyph}  onClick={() => { onResetBox(); onResetTrim(); onZoom(1); }} />
      <RailActionButton label="Center" icon={centerGlyph} onClick={onCenter} />
      <RailActionButton label={timelineOpen ? 'Hide timeline' : 'Open timeline'} icon={timelineGlyph} onClick={onToggleTimeline} active={timelineOpen} />
      {onToggleSticker && (
        <RailActionButton label={stickerEnabled ? 'FeedForce sticker: on' : 'FeedForce sticker: off'} icon={stickerGlyph} onClick={onToggleSticker} active={!!stickerEnabled} />
      )}
      <RailActionButton label="Remove video" icon={removeVideoGlyph} onClick={onRemoveVideo} />
    </>
  );
}

// Empty timeline strip — shown when the reels timeline is toggled open before a video is loaded.
// Matches VideoControlsBar's outer frame so the bottom strip looks consistent either way.
function EmptyTimeline() {
  return (
    <div className="shrink-0 mx-3 mb-3 rounded-lg border border-line bg-surface-1 px-4 py-3">
      <div className="h-14 rounded-md border border-dashed border-line bg-surface-2 flex items-center justify-center">
        <span className="text-caption text-fg-3">No video yet — paste a link or upload a clip to edit the timeline.</span>
      </div>
    </div>
  );
}

// Undo/redo history for the reels' URL + caption + description text edits. Snapshots the pre-edit state at
// the start of a typing burst and commits it on a 500ms debounce (coalescing the burst into one undo step),
// mirroring the template editor's history. Scope: the reels' url + caption + description only.
type ReelEditSnap = Record<string, { url: string; caption: string; description: string }>;
function useReelEditHistory(
  entries: VideoEntry[],
  onUpdateEntry: (id: string, field: ReelTextField, value: string) => void,
) {
  const entriesRef = useRef(entries);
  useEffect(() => { entriesRef.current = entries; }, [entries]);
  const snap = useCallback((): ReelEditSnap => {
    const m: ReelEditSnap = {};
    for (const e of entriesRef.current) m[e.id] = { url: e.url ?? '', caption: e.caption ?? '', description: e.description ?? '' };
    return m;
  }, []);
  const past = useRef<ReelEditSnap[]>([]);
  const future = useRef<ReelEditSnap[]>([]);
  const base = useRef<ReelEditSnap | null>(null);   // pre-burst snapshot, committed on debounce
  const burstId = useRef<string | null>(null);      // the reel id the current burst is editing
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // canUndo/canRedo are held in state (computed from the ref stacks via refresh()), so the render never
  // reads refs — refresh runs only from the mutation handlers below.
  const [flags, setFlags] = useState({ canUndo: false, canRedo: false });
  const refresh = useCallback(() => {
    setFlags({ canUndo: past.current.length > 0 || base.current != null, canRedo: future.current.length > 0 });
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const commit = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (base.current) { past.current.push(base.current); base.current = null; refresh(); }
  }, [refresh]);
  const apply = useCallback((target: ReelEditSnap) => {
    for (const e of entriesRef.current) {
      const t = target[e.id];
      if (!t) continue;
      if ((e.url ?? '') !== t.url) onUpdateEntry(e.id, 'url', t.url);
      if ((e.caption ?? '') !== t.caption) onUpdateEntry(e.id, 'caption', t.caption);
      if ((e.description ?? '') !== t.description) onUpdateEntry(e.id, 'description', t.description);
    }
  }, [onUpdateEntry]);
  const recordEdit = useCallback((id: string, field: ReelTextField, value: string) => {
    if (base.current && burstId.current !== id) commit();   // editing a different reel → close the prior reel's burst
    if (!base.current) { base.current = snap(); burstId.current = id; future.current = []; }   // burst start → a new edit clears redo
    onUpdateEntry(id, field, value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(commit, 500);
    refresh();
  }, [snap, onUpdateEntry, commit, refresh]);
  const undo = useCallback(() => {
    commit();   // flush any in-progress burst so it's undoable
    if (!past.current.length) return;
    const prev = past.current.pop()!;
    future.current.push(snap());
    apply(prev);
    refresh();
  }, [commit, snap, apply, refresh]);
  const redo = useCallback(() => {
    commit();
    if (!future.current.length) return;
    const next = future.current.pop()!;
    past.current.push(snap());
    apply(next);
    refresh();
  }, [commit, snap, apply, refresh]);

  return { recordEdit, undo, redo, canUndo: flags.canUndo, canRedo: flags.canRedo };
}

// ── CanvasGrid ────────────────────────────────────────────────────────────────

// Remember the last-selected reel template per user so the Reels posting page reopens it instead of
// snapping back to the first one. The in-memory map survives section-switch remounts within a session;
// localStorage (read below) survives a full page reload. Mirrors the carousel editor's `de:tpl:` scheme.
const reelSelectionCache = new Map<string, string>();   // userId → reel-template id
const reelSelectionKey = (userId: string) => `de:reeltpl:${userId}`;

// Cross-instance reel-ingest de-dup. CanvasGrid unmounts when the user leaves the reels section, but
// entries live in HomeClient — so an in-flight store keeps running and a remount would otherwise
// re-store the same reel (orphaning a copy) or re-attempt a parked/oversized link every revisit. These
// module maps survive the remount. Keyed `${userId}/${entryId}`.
const reelIngestInflight = new Set<string>();        // currently storing → block a duplicate store
const reelIngestTried = new Map<string, string>();   // link we failed to store → retry only if it changes

// Draw a representative frame from a video Blob to a JPEG poster (for the grid's non-live thumbnails).
// Best-effort: resolves null on any failure or a stuck decode, so reel storage never blocks on it.
async function makePoster(blob: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    let settled = false;
    const done = (out: Blob | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      try { v.load(); } catch { /* ignore */ }
      resolve(out);
    };
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.addEventListener('error', () => done(null), { once: true });
    v.addEventListener('loadeddata', () => {
      // A hair past the start avoids an all-black opening frame; capped so short clips still land in-range.
      const seekTo = Math.min(0.1, (isFinite(v.duration) ? v.duration : 1) / 2);
      const draw = () => {
        try {
          if (!v.videoWidth || !v.videoHeight) return done(null);
          const c = document.createElement('canvas');
          c.width = v.videoWidth; c.height = v.videoHeight;
          const ctx = c.getContext('2d');
          if (!ctx) return done(null);
          ctx.drawImage(v, 0, 0);
          c.toBlob(b => done(b), 'image/jpeg', 0.72);
        } catch { done(null); }
      };
      v.addEventListener('seeked', draw, { once: true });
      try { v.currentTime = seekTo; } catch { draw(); }
    }, { once: true });
    v.src = url;
    setTimeout(() => done(null), 15_000);   // never hang the ingest queue on a stuck decode
  });
}

// Build the grid's editor state (framing / template / name maps + entries) from saved rows. Shared by
// the initial page-load restore AND the multi-tab live-sync path, so the two can never diverge. Uses
// getCachedVideo so a link already fetched this session restores instantly with no re-download.
function buildReelState(rows: SavedReel[]): {
  fm: Record<string, Framing>; tm: Record<string, string | null>; nm: Record<string, string>;
  sm: Record<string, boolean>; entries: VideoEntry[];
} {
  const fm: Record<string, Framing> = {};
  const tm: Record<string, string | null> = {};
  const nm: Record<string, string> = {};
  const sm: Record<string, boolean> = {};
  const entries: VideoEntry[] = rows.map(r => {
    fm[r.id] = r.framing ?? {};
    tm[r.id] = r.templateId ?? null;
    if (r.name) nm[r.id] = r.name;
    if (r.stickerEnabled) sm[r.id] = true;
    const cached = r.url.trim() && !r.videoUrl ? getCachedVideo(r.url.trim()) : undefined;
    return { ...makeEmptyEntry(r.id, r.mode), url: r.url, caption: r.caption, description: r.description ?? '', videoUrl: r.videoUrl || undefined, posterUrl: r.posterUrl || undefined, data: cached ?? null };
  });
  return { fm, tm, nm, sm, entries };
}

export function CanvasGrid({
  entries, setEntries, canvasRefsMap, brand,
  onAddRow, onRemoveRow, onDuplicateRow, onDeleteAllReels, onHandleVideoError,
  onUpdateEntry, onUpdateLocalVideo,
  onFetchVideo, userId,
  videoMode, onGoToTemplateEditor, viewToggle, active = true, onScheduleReel, onRestored, restored,
}: CanvasGridProps) {
  // Free-tier export quota — one counter shared by the single-download button, the batch
  // download-all loop, and the timeline bar's Export (FREE_TIER_PLAN.md).
  const exportGuard = useExportGuard();
  const { plan } = usePlan();
  // Export actions each drive a real-time canvas recording, so only ONE may run at a time — a second
  // would read a canvas that's already recording (exportBlob → null) and, for Schedule, navigating
  // away mid-run would unmount the canvas. `downloadingOne` covers the single Download (Download-All
  // has isDownloadingAll; Schedule has `scheduling`); every export button gates on all three.
  const [downloadingOne, setDownloadingOne] = useState(false);
  // "Schedule this reel": render the on-screen reel to an MP4 and hand it to the Post screen. Pro-only
  // (scheduling is a Pro feature), so it doesn't touch the export quota.
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  // Saved Twitter/X overlay templates. The selected one's style applies to all twitter-mode rows
  // (defaults reproduce the original look when the user has none).
  const { templates: twitterTemplates, loaded: twitterLoaded } = useTwitterTemplates(userId);
  // Seed from the remembered selection (in-memory cache → localStorage) so a remount/reload reopens the
  // same template; falls back to the first one only when nothing is remembered.
  const [activeTwitterId, setActiveTwitterId] = useState<string | null>(() => {
    if (!userId) return null;
    const cached = reelSelectionCache.get(userId);
    if (cached) return cached;
    try { return localStorage.getItem(reelSelectionKey(userId)); } catch { return null; }
  });
  const activeTwitter = twitterTemplates.find(t => t.id === activeTwitterId) ?? twitterTemplates[0] ?? null;
  const twSettings = activeTwitter?.settings ?? defaultTwitterTemplateSettings();

  // If userId arrives after the initial render (the seed above ran with no user), restore then.
  useEffect(() => {
    if (activeTwitterId || !userId) return;
    let saved: string | null = reelSelectionCache.get(userId) ?? null;
    if (!saved) { try { saved = localStorage.getItem(reelSelectionKey(userId)); } catch { /* ignore */ } }
    if (saved) setActiveTwitterId(saved);
  }, [userId, activeTwitterId]);

  // Persist the selection: in-memory cache for fast remounts, localStorage for full reloads.
  useEffect(() => {
    if (!userId || !activeTwitterId) return;
    reelSelectionCache.set(userId, activeTwitterId);
    try { localStorage.setItem(reelSelectionKey(userId), activeTwitterId); } catch { /* ignore */ }
  }, [userId, activeTwitterId]);

  // Drop a remembered id whose template was since deleted, so it cleanly falls back to the first.
  useEffect(() => {
    if (!activeTwitterId || !twitterLoaded || twitterTemplates.length === 0) return;
    if (!twitterTemplates.some(t => t.id === activeTwitterId)) {
      setActiveTwitterId(null);
      if (userId) {
        reelSelectionCache.delete(userId);
        try { localStorage.removeItem(reelSelectionKey(userId)); } catch { /* ignore */ }
      }
    }
  }, [activeTwitterId, twitterLoaded, twitterTemplates, userId]);

  // ── Saved reels (autosave the whole grid) ──────────────────────────────────────────────────────
  // Each grid row is a saved reel: we persist only numbers/strings (link, caption, mode, inherited
  // template id, framing) and re-apply them on load. Re-fetching the link reloads the video; the canvas
  // then restores its exact crop/pan/zoom/trim via `initialFraming`. Only active in the Video Reels
  // workspace (where setEntries is provided).
  const { loaded: reelsLoaded, loadError: reelsLoadError, retryLoad: retryReelsLoad, initialRows, saveState: reelSaveState, scheduleSave, external: externalReels } = useReelPersistence(setEntries ? userId : null);
  const [framingMap, setFramingMap] = useState<Record<string, Framing>>({});
  const [reelTemplateMap, setReelTemplateMap] = useState<Record<string, string | null>>({}); // entryId → template id
  // entryId → user-given reel name (shown/edited in the bottom strip). Kept OUTSIDE VideoEntry — like
  // framing/template above — because entries model the video pipeline (fetch/upload state) while the name
  // is pure saved-grid metadata; it rides the same autosave rows. '' / absent = unnamed (number only).
  const [reelNameMap, setReelNameMap] = useState<Record<string, string>>({});
  // entryId → the RAW per-reel "FeedForce sticker" toggle. Persisted as-is on the saved row; the
  // sticker only actually renders/bakes while the user is ENROLLED in the rewards program
  // (effectiveSticker below), so a lapsed member's choice survives re-enrollment untouched.
  const [stickerMap, setStickerMap] = useState<Record<string, boolean>>({});
  const { enrolled: rewardsEnrolled } = useRewardsEnrollment(userId);
  const effectiveSticker = useCallback((id: string) => rewardsEnrolled && (stickerMap[id] ?? false), [rewardsEnrolled, stickerMap]);
  const [framingDirty, setFramingDirty] = useState(0);   // bumped when a reel's crop/pan/zoom/trim changes
  const markFramingDirty = useCallback(() => setFramingDirty(n => n + 1), []);
  const reelsApplied = useRef(false);
  const autoFetched = useRef<Map<string, string>>(new Map());   // entryId → last URL we auto-fetched (no repeats)

  // Restore the saved grid once, after the saved rows have loaded.
  useEffect(() => {
    if (!setEntries || reelsApplied.current || !reelsLoaded) return;
    reelsApplied.current = true;
    onRestored?.();   // safe to append from the Content Sheet now — this restore won't clobber
    // Cached fetches (client-side cache survives section switches) restore the video instantly with no
    // API call and no skeleton flash. Same mapping the live-sync path uses (buildReelState).
    const { fm, tm, nm, sm, entries: loaded } = buildReelState(initialRows);
    setFramingMap(fm);
    setReelTemplateMap(tm);
    setReelNameMap(nm);
    setStickerMap(sm);
    // On the FIRST restore this page-load, rebuild the grid from the saved rows. On a nav-back remount
    // the entries are already live in HomeClient (freshest — they include an upload that finished while
    // the grid was unmounted), so we only re-seed the maps above and must NOT overwrite entries.
    if (!restored) {
      // Reset even when there are NO saved rows (loaded is []) — to a single empty reel — so a same-tab
      // account switch can't leave the previous user's entries live (the autosave would otherwise capture
      // and write them into THIS user's row). setEntries also triggers a re-render that re-runs the
      // autosave with the reset entries, cancelling any transient debounce armed with the old user's rows.
      setEntries(loaded.length ? loaded : [makeEmptyEntry('1')]);
      // Cached links already carry their video (data set above) — mark them so the auto-fetch effect
      // skips them. UNCACHED links (e.g. after a full refresh clears the in-memory cache) are left
      // UNMARKED so the auto-fetch effect re-downloads them. Fetching there (on a debounced timer) is
      // what makes it work: an immediate fetch here races useVideoEntries' entriesRef, which isn't yet
      // updated with the restored reels, so fetchVideo can't find the entry and bails with "URL required".
      loaded.forEach(e => {
        if (!e.url.trim() || e.videoUrl) return;
        if (e.data) autoFetched.current.set(e.id, e.url.trim());
      });
    }
    // Adopt the first saved row's template as the active default for the picker.
    const firstTpl = initialRows.find(r => r.templateId)?.templateId;
    if (firstTpl) setActiveTwitterId(firstTpl);
  }, [setEntries, reelsLoaded, initialRows, onRestored, restored]);

  // Auto-fetch: in the reels section, a pasted/typed link fetches on its own (no Fetch button press).
  // Debounced via the effect's cleanup — while the URL keeps changing the timer resets; ~700ms after it
  // settles we fetch. Guarded so we never re-fetch the same URL or a row that's already loaded/uploading.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const e of entries) {
      if (e.loading || e.localVideoSrc || e.videoUrl) continue;
      if (e.data && !e.videoFailed) continue;                      // already fetched
      const url = e.url.trim();
      if (!/^https?:\/\/\S+\.\S+/.test(url)) continue;             // wait for a complete-looking link
      if (autoFetched.current.get(e.id) === url) continue;         // already auto-fetched this exact URL
      const id = e.id;
      timers.push(setTimeout(() => { autoFetched.current.set(id, url); onFetchVideo(id); }, 700));
    }
    return () => timers.forEach(clearTimeout);
  }, [entries, onFetchVideo]);

  // Autosave: rebuild the rows from entries + live framing (read off each canvas ref) and debounce-save.
  useEffect(() => {
    if (!setEntries || !reelsApplied.current) return;
    const rows: SavedReel[] = entries
      .map(e => ({
        id: e.id,
        name: reelNameMap[e.id] ?? '',
        mode: e.mode === 'caption' ? 'caption' : 'twitter',
        url: e.url ?? '',
        videoUrl: e.videoUrl ?? '',
        posterUrl: e.posterUrl ?? '',
        caption: e.caption ?? '',
        description: e.description ?? '',
        templateId: reelTemplateMap[e.id] ?? activeTwitterId ?? null,
        stickerEnabled: stickerMap[e.id] ?? false,   // the RAW toggle, not the enrollment-gated value
        // Only trust the live canvas framing once the video is actually loaded (readyState >= 2). A
        // mounted-but-not-loaded canvas (still buffering, or a failed/timed-out video) holds the
        // full-canvas placeholder box, not the band — persisting it made sheet-sent reels reload
        // full-canvas. getFraming() already nulls while loading; this also covers the errored case.
        // roundFramingDeep: live getFraming() floats differ from the saved values by dust after an
        // apply-then-read round-trip; unrounded, every video load armed the autosave with byte-different
        // rows, which blocked adoption on idle tabs and clobbered foreign edits (see lib/framingRound).
        framing: roundFramingDeep(((canvasRefsMap.current.get(e.id)?.getVideoElement()?.readyState ?? 0) >= 2
          ? canvasRefsMap.current.get(e.id)?.getFraming() : null) ?? framingMap[e.id] ?? {}),
      }));
    scheduleSave(rows);
  }, [entries, reelTemplateMap, reelNameMap, stickerMap, activeTwitterId, framingDirty, setEntries, reelsLoaded, scheduleSave, framingMap, canvasRefsMap]);

  // Persist UPLOADED reel videos like carousels: push the local file to the post-videos bucket and keep
  // only its public URL, so an uploaded reel survives reload. (Pasted links stay re-fetched, not uploaded.)
  const uploadedBlob = useRef<Map<string, string>>(new Map());   // entryId → the blob URL we've already started uploading
  const persistUpload = useCallback(async (id: string, blobUrl: string, name?: string) => {
    if (!userId || !setEntries) return;
    try {
      const blob = await fetch(blobUrl).then(r => r.blob());
      const safe = (name?.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'reel').slice(0, 100);
      const path = `${userId}/${Date.now()}_${safe}`;
      const { error } = await supabase.storage.from('post-videos').upload(path, blob, { contentType: blob.type || 'video/mp4' });
      if (error) {
        // Silent background persist — but a free-plan quota rejection deserves the upgrade prompt.
        const upgrade = upgradeReasonForDbError(error.message);
        if (upgrade) requestUpgrade(upgrade);
        uploadedBlob.current.delete(id); return;
      }
      const { data: { publicUrl } } = supabase.storage.from('post-videos').getPublicUrl(path);
      setEntries(prev => prev.map(e => (e.id === id ? { ...e, videoUrl: publicUrl } : e)));
    } catch { uploadedBlob.current.delete(id); }
  }, [userId, setEntries]);
  useEffect(() => {
    if (!setEntries || !userId) return;
    for (const e of entries) {
      if ((e.mode === 'twitter' || e.mode === 'caption')
        && e.localVideoSrc?.startsWith('blob:')
        && !e.videoUrl
        && uploadedBlob.current.get(e.id) !== e.localVideoSrc) {   // (re)upload only when the blob is new
        uploadedBlob.current.set(e.id, e.localVideoSrc);
        void persistUpload(e.id, e.localVideoSrc, e.localVideoName);
      }
    }
  }, [entries, setEntries, userId, persistUpload]);

  // Always-current entries snapshot for async callbacks (storeReel awaits a download, then re-checks).
  const cgEntriesRef = useRef(entries);
  useEffect(() => { cgEntriesRef.current = entries; }, [entries]);

  // ── Source-change framing invalidation ────────────────────────────────────────────────────────
  // Saved framing carries trim/segments/timeline made FOR a specific video. When a row's source is
  // replaced (link repaste, upload replace/remove), those fields must not survive to the next video:
  // the post-load restore re-applies initialFraming verbatim, which capped the new reel at the
  // PREVIOUS video's length (the bake stops at trimEnd, and its clamp only shrinks windows — a
  // stale-shorter window sails through). Strip the time-domain half at the same boundary that
  // clears the video pipeline, with the same shared predicates (framingSource.ts), so the map,
  // the autosaved row, and the restore all see source-fresh framing. Crop/pan/zoom survive on
  // purpose: canvas-space, still meaningful for the replacement clip. Every internal update path
  // must go through these wrappers, undo/redo included — an undone URL is a source change too.
  const stripFramingTimeDomain = useCallback((id: string) => {
    setFramingMap(prev => {
      const f = prev[id];
      if (!f) return prev;
      const stripped = stripTimeDomainFraming(f);
      return stripped === f ? prev : { ...prev, [id]: stripped };
    });
  }, []);
  const guardedUpdateEntry = useCallback((id: string, field: ReelTextField, value: string) => {
    // No strip while a LOCAL upload is live: videoSrc prefers localVideoSrc, so a url edit (or a
    // url undo replayed by the edit history) doesn't change what's on the canvas — stripping here
    // would wipe the upload's live timeline via the value-aware restore re-apply. The upload's own
    // removal/replacement is the real source boundary, and guardedUpdateLocalVideo strips there.
    const prev = cgEntriesRef.current.find(e => e.id === id);
    if (field === 'url' && !prev?.localVideoSrc && urlChangeInvalidatesVideo(prev, value)) {
      stripFramingTimeDomain(id);
    }
    onUpdateEntry(id, field, value);
  }, [onUpdateEntry, stripFramingTimeDomain]);
  const guardedUpdateLocalVideo = useCallback((id: string, src: string, name: string) => {
    if (localVideoChangeInvalidatesVideo(cgEntriesRef.current.find(e => e.id === id), src)) {
      stripFramingTimeDomain(id);
    }
    onUpdateLocalVideo(id, src, name);
  }, [onUpdateLocalVideo, stripFramingTimeDomain]);

  // ── Store a pasted LINK reel into our own bucket (durability + rot-proof, fast reload) ────────────
  // Downloads the source video the browser was going to stream anyway (getVideoBlob — deduped/cached, so
  // if the timeline already fetched it this is free), uploads it + a generated poster, and sets
  // videoUrl/posterUrl so the reel loads from OUR bucket forever after (no more re-fetch from the link).
  // Uploaded local files are handled by persistUpload above; this is the link path. Returns whether it
  // stored (false → the paced effect below marks the link tried, so a dead link can't loop).
  const storeReel = useCallback(async (id: string): Promise<boolean> => {
    if (!userId || !setEntries) return false;
    const lockKey = `${userId}/${id}`;
    if (reelIngestInflight.has(lockKey)) return false;   // another (possibly remounted) instance is storing this reel
    const e0 = cgEntriesRef.current.find(x => x.id === id);
    if (!e0?.data || !e0.url.trim() || e0.videoUrl || e0.localVideoSrc) return false;
    const key = e0.url.trim();
    reelIngestInflight.add(lockKey);
    try {
      const blob = await getVideoBlob(bestVideoUrl(e0.data));
      if (!blob) return false;
      const stamp = Date.now();
      const vPath = `${userId}/${stamp}_link.mp4`;
      const { error: vErr } = await supabase.storage.from('post-videos')
        .upload(vPath, blob, { contentType: blob.type || 'video/mp4' });
      if (vErr) { const up = upgradeReasonForDbError(vErr.message); if (up) requestUpgrade(up); return false; }
      // Poster is best-effort — a stored video with no poster is fine (grid falls back to the video/cover).
      let posterUrl: string | undefined;
      let pPath: string | undefined;
      const poster = await makePoster(blob);
      if (poster) {
        pPath = `${userId}/${stamp}_poster.jpg`;
        const { error: pErr } = await supabase.storage.from('post-images')
          .upload(pPath, poster, { contentType: 'image/jpeg' });
        if (pErr) pPath = undefined;
        else posterUrl = supabase.storage.from('post-images').getPublicUrl(pPath).data.publicUrl;
      }
      // Re-check RIGHT before commit (download + poster can take seconds): if the reel was deleted,
      // re-linked, or already stored meanwhile, the files we just wrote reference nothing — delete them
      // so they don't leak, and don't commit.
      const e1 = cgEntriesRef.current.find(x => x.id === id);
      if (!e1 || e1.url.trim() !== key || e1.videoUrl || e1.localVideoSrc) {
        void supabase.storage.from('post-videos').remove([vPath]).then(() => undefined, () => undefined);
        if (pPath) void supabase.storage.from('post-images').remove([pPath]).then(() => undefined, () => undefined);
        return false;
      }
      const videoUrl = supabase.storage.from('post-videos').getPublicUrl(vPath).data.publicUrl;
      setEntries(prev => prev.map(x => (x.id === id && x.url.trim() === key && !x.videoUrl && !x.localVideoSrc)
        ? { ...x, videoUrl, posterUrl: posterUrl ?? x.posterUrl } : x));
      return true;
    } finally {
      reelIngestInflight.delete(lockKey);
    }
  }, [userId, setEntries]);

  // URL + caption edit history (undo/redo via the rail + ⌘Z / ⌘⇧Z) for the reels posting page.
  const { recordEdit, undo, redo, canUndo, canRedo } = useReelEditHistory(entries, guardedUpdateEntry);

  // The video timeline (VideoControlsBar) keeps its own segment-edit history and reports it
  // up here, so the SAME rail island + ⌘Z drive it — no separate buttons in the bar. Timeline
  // edits take priority while the timeline is open and has history; otherwise we fall through
  // to the URL/caption history. The bar reports cleared state on unmount (timeline closed).
  const tlUndoRef = useRef<() => void>(() => {});
  const tlRedoRef = useRef<() => void>(() => {});
  const [tlCanUndo, setTlCanUndo] = useState(false);
  const [tlCanRedo, setTlCanRedo] = useState(false);
  const handleTimelineHistory = useCallback(
    (api: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean }) => {
      tlUndoRef.current = api.undo; tlRedoRef.current = api.redo;
      setTlCanUndo(api.canUndo); setTlCanRedo(api.canRedo);
    }, []);
  const mergedUndo = useCallback(() => { if (tlCanUndo) tlUndoRef.current(); else undo(); }, [tlCanUndo, undo]);
  const mergedRedo = useCallback(() => { if (tlCanRedo) tlRedoRef.current(); else redo(); }, [tlCanRedo, redo]);
  const mergedCanUndo = tlCanUndo || canUndo;
  const mergedCanRedo = tlCanRedo || canRedo;

  // Hold undo/redo in refs so the global keydown listener binds once (per videoMode), not every render.
  const undoRef = useRef(mergedUndo); const redoRef = useRef(mergedRedo);
  useEffect(() => { undoRef.current = mergedUndo; redoRef.current = mergedRedo; }, [mergedUndo, mergedRedo]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;   // let native text undo win in fields
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) redoRef.current(); else undoRef.current(); }
      else if (k === 'y') { e.preventDefault(); redoRef.current(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Centered template dropdown (mirrors the Carousels toolbar) — open state, measured anchor, refs.
  const [showTemplateDropdown, setShowTemplateDropdown] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);   // video-timeline editor — closed by default
  const [dropdownAnchor, setDropdownAnchor] = useState<{ top: number; left: number } | null>(null);
  const templateDropdownRef = useRef<HTMLDivElement>(null);
  const templateTriggerRef = useRef<HTMLButtonElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showTemplateDropdown) return;
    const onDown = (e: MouseEvent) => {
      if (templateDropdownRef.current && !templateDropdownRef.current.contains(e.target as Node)) setShowTemplateDropdown(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowTemplateDropdown(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [showTemplateDropdown]);

  const videoRenderEntries = entries.filter(e =>
    !e.loading && (
      e.localVideoSrc || e.videoUrl || (e.data && !(e.data.images && e.data.images.length > 0))
    )
  );

  const [selectedId,                setSelectedId]                = useState<string>(entries[0]?.id ?? '');
  // Which reel is actually on screen — lags selectedId by one fade so the current reel can fade OUT
  // before we swap to (and fade IN) the next. reelVisible drives that fade's opacity.
  const [displayId,   setDisplayId]   = useState(selectedId);
  const [reelVisible, setReelVisible] = useState(true);
  const [recordingStateMap, setRecordingStateMap] = useState<Record<string, RecordingState>>({});

  // Store un-stored LINK reels one at a time (active reel first), in the background: new reels store as
  // they're fetched, old ones as they're reached. Paced (a single in-flight) so 50 reels don't all
  // download at once. A reel whose store fails is parked (keyed by its current link) so a bad link can't
  // spin — it retries only if the link changes.
  const ingestingRef = useRef(false);
  const [ingestTick, setIngestTick] = useState(0);
  useEffect(() => {
    if (!setEntries || !userId || ingestingRef.current) return;
    const eligible = entries.filter(e =>
      e.data && e.url.trim() && !e.videoUrl && !e.localVideoSrc && !e.loading
      && reelIngestTried.get(`${userId}/${e.id}`) !== e.url.trim());
    if (eligible.length === 0) return;
    const target = eligible.find(e => e.id === selectedId) ?? eligible[0];
    ingestingRef.current = true;
    void storeReel(target.id)
      .then(ok => { if (!ok) reelIngestTried.set(`${userId}/${target.id}`, target.url.trim()); })
      .finally(() => { ingestingRef.current = false; setIngestTick(t => t + 1); });   // pick the next
  }, [entries, selectedId, userId, setEntries, storeReel, ingestTick]);

  // ── Multi-tab live sync: adopt a foreign write ──────────────────────────────────────────────────
  // useReelPersistence hands us another tab/device's saved rows (via Realtime, already echo-suppressed).
  // Rebuild the grid from them with the SAME mapping as the initial restore, so a reel THEY deleted
  // vanishes here instead of being resurrected by our next autosave, and one they added/renamed appears.
  // Cached videos don't re-download; a still-present selection is kept. The adopted rows match the hook's
  // sync baseline, so the triggered autosave is normally a no-op. (Edge: a reel adopted with templateId=null
  // while this tab has an activeTwitterId writes ONCE via the `?? activeTwitterId` default below, then
  // converges — no infinite ping-pong.)
  const [reelSyncNotice, setReelSyncNotice] = useState<string | null>(null);
  const externalApplied = useRef(0);
  // Pre-adoption entries snapshot for the toast diff (the apply effect must not depend on `entries`,
  // or every keystroke would re-run it).
  const preAdoptEntriesRef = useRef(entries);
  useEffect(() => { preAdoptEntriesRef.current = entries; }, [entries]);
  useEffect(() => {
    if (!setEntries || !externalReels || externalReels.rev === externalApplied.current) return;
    externalApplied.current = externalReels.rev;
    // Initial restore hasn't run yet: drop this apply. Safe because a pre-restore adoption updates the
    // module cache and the persistence hook's load continuation carries the newer-than-loaded cache into
    // initialRows (keepAdoptedOverLoaded), which is what the restore below builds from.
    if (!reelsApplied.current) return;
    const { fm, tm, nm, sm, entries: next } = buildReelState(externalReels.rows);
    setFramingMap(fm);
    setReelTemplateMap(tm);
    setReelNameMap(nm);
    setStickerMap(sm);
    setEntries(next.length ? next : [makeEmptyEntry('1')]);
    setSelectedId(prev => (next.some(e => e.id === prev) ? prev : (next[0]?.id ?? '')));
    // Mark cached links fetched so the auto-fetch effect skips them (uncached ones re-download).
    next.forEach(e => { if (e.url.trim() && !e.videoUrl && e.data) autoFetched.current.set(e.id, e.url.trim()); });
    // Push adopted framing INTO any live canvas: TikTokCanvas auto-applies initialFraming only ONCE per
    // video source, so an already-loaded canvas kept its stale zoom/crop/trim after adoption, and its
    // next autosave then read that stale live framing back off the canvas and WROTE it over the foreign
    // edit (a framing ping-pong between tabs; descriptions synced fine because text needs no canvas).
    // Only the displayed reel's canvas is mounted; the others pick up fm via initialFraming on mount.
    next.forEach(e => {
      const ref = canvasRefsMap.current.get(e.id);
      const f = fm[e.id];
      if (ref && f && Object.keys(f).length > 0 && (ref.getVideoElement()?.readyState ?? 0) >= 2) {
        ref.applyFraming(f);
      }
    });
    // Name the reel + field in the toast: a description edit has NO resting UI (it only renders inside the
    // selected reel's Description panel), so the generic "Reels updated" fired with zero visible pixels
    // changing and read as a broken sync (E2E-verified 2026-07-19).
    setReelSyncNotice(describeReelSyncChange(preAdoptEntriesRef.current, next, nm));
    window.setTimeout(() => setReelSyncNotice(null), 4000);
  }, [externalReels, setEntries]);

  const [canvasRefVersion,  setCanvasRefVersion]  = useState(0);
  const [videoZoomMap,      setVideoZoomMap]      = useState<Record<string, number>>({});

  const scrollRef  = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lane = useObservedSize(scrollRef);
  // Height-aware: video cards are 9:16 (tall), so fit to BOTH dims or a tall card overflows the viewport.
  const fitFactor = fitScaleFor(lane, CARD_W, Math.round(CARD_W * 16 / 9));
  // Focal-anchored pinch/Ctrl-scroll zoom with a one-shot absolute-100% default (shared editor scaffolding).
  const { viewScale, setViewScale, captureFocal, attachScroll } = useEditorZoomPan({
    scrollRef, contentRef, fitFactor, laneWidth: lane.width,
  });

  const prevLengthRef         = useRef(entries.length);
  const canvasRefRegistered   = useRef(new Set<string>());

  // Switching reels is instant — swap the rendered reel to the selection immediately, no fade. We don't
  // recenter: the reel centres on mount via the focal effect and the layout is identical, so scroll persists.
  // (A deleted selection is handled by the selectedId-validity effect below, which then re-runs this.)
  //
  // Only the DISPLAYED reel mounts a live <video>+canvas (see the render map) — a large grid must never
  // mount hundreds of videos (a 486-reel account would hang the browser). So before switching, snapshot
  // the OUTGOING reel's live framing into framingMap: its canvas is still mounted here (displayId hasn't
  // changed yet this render), getFraming() reads the current crop/pan/zoom/trim, and both autosave and the
  // reel's next mount read framingMap once the canvas ref is gone. getFraming() returns null mid-load
  // (framing not yet applied) — skip then, keeping the last-known value rather than a placeholder.
  const displayIdRef = useRef(displayId);
  const batchExportRef = useRef(false);   // true while Download All / Schedule All cycle the reels; set below
  useEffect(() => { displayIdRef.current = displayId; }, [displayId]);
  useEffect(() => {
    const outgoing = displayIdRef.current;
    // Skip during a batch export (Download All / Schedule All): they cycle selectedId through every
    // reel to export them, and capturing each would materialize default framing + churn autosave for
    // no user edit.
    if (outgoing && outgoing !== selectedId && !batchExportRef.current) {
      const outRef = canvasRefsMap.current.get(outgoing);
      // Only snapshot a reel whose video is actually LOADED (readyState ≥ 2). A mid-load canvas reports
      // a placeholder full-canvas box + zero-length trim, and getFraming() can't self-detect that for a
      // session-added reel (null initialFraming) — persisting it would corrupt the reel's crop/trim.
      if ((outRef?.getVideoElement()?.readyState ?? 0) >= 2) {
        const raw = outRef?.getFraming();
        // Round BEFORE the changed-check so float dust from the live read never counts as a change
        // (unrounded values here re-armed the autosave on every reel switch; see lib/framingRound).
        const f = raw ? roundFramingDeep(raw) : null;
        // Only commit when the framing actually changed, so merely navigating between reels doesn't
        // trigger an autosave (a whole-array upsert) on every switch.
        if (f) setFramingMap(prev => {
          const cur = prev[outgoing];
          return cur && JSON.stringify(cur) === JSON.stringify(f) ? prev : { ...prev, [outgoing]: f };
        });
      }
    }
    setDisplayId(selectedId);
    setReelVisible(true);
  }, [selectedId]);

  // Keep the active template tracking the reel currently on screen. A reel's effective template is
  // reelTemplateMap[id] ?? activeTwitterId, so syncing activeTwitterId to the selected reel's template
  // means template-less reels — freshly added, or SENT from the Content Sheet — inherit the band of the
  // reel you're actually looking at, not whatever template happened to be picked last. (If the selected
  // reel has no explicit template it's already using activeTwitterId, so leave it be.)
  useEffect(() => {
    const t = reelTemplateMap[selectedId];
    if (t) setActiveTwitterId(t);
  }, [selectedId, reelTemplateMap]);

  // Keep selectedId valid: if the selected reel is deleted, fall back to the first reel so the canvas
  // and the bottom strip's highlight stay coherent.
  useEffect(() => {
    if (selectedId && !entries.some(e => e.id === selectedId)) setSelectedId(entries[0]?.id ?? '');
  }, [entries, selectedId]);

  // Prioritise the reel you're looking at: when you switch to one whose video is still waiting in the
  // rate-limited fetch queue, bump it to the front so it loads next instead of behind the others. No-op
  // if it isn't queued (already fetched, or already downloading).
  useEffect(() => {
    const e = entries.find(x => x.id === selectedId);
    if (e && !e.data && !e.videoUrl && !e.localVideoSrc && e.url.trim()) prioritizeVideoFetch(e.url.trim());
  }, [selectedId, entries]);

  // When a new entry is added, select and scroll to it
  useEffect(() => {
    if (entries.length > prevLengthRef.current) {
      const newest = entries[entries.length - 1];
      if (newest) setTimeout(() => setSelectedId(newest.id), 30);
    }
    prevLengthRef.current = entries.length;
  }, [entries.length]);

  // Only the active reel plays: pause every other reel's video whenever the focus changes. Videos
  // never autoplay, so pausing the ones you flick away from keeps at most one playing at a time.
  useEffect(() => {
    canvasRefsMap.current.forEach((ref, id) => { if (id !== selectedId) ref.pause(); });
  }, [selectedId, canvasRefsMap]);


  // Paste-to-fill the selected row: ⌘/Ctrl+V a video file from the clipboard sets it as the
  // selected reel's media — the same as clicking that row's Upload button — so the user doesn't
  // have to. Ignored while typing so text / URL paste still works. Reels media are local object
  // URLs (no bucket upload), matching the Upload handlers; only video files are intercepted,
  // anything else falls through to default paste.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const sel = entries.find(en => en.id === selectedId) ?? entries[0];
      if (!sel) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.kind !== 'file' || !it.type.startsWith('video/')) continue;
        const file = it.getAsFile();
        if (!file) continue;
        e.preventDefault();
        if (sel.localVideoSrc?.startsWith('blob:')) URL.revokeObjectURL(sel.localVideoSrc);
        guardedUpdateLocalVideo(sel.id, URL.createObjectURL(file), file.name);
        guardedUpdateEntry(sel.id, 'url', '');
        return;
      }
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [entries, selectedId, guardedUpdateLocalVideo, guardedUpdateEntry]);

  // Duplicate a reel: copy the entry, then carry over all id-keyed editor state (reel
  // framing/template/zoom/scale) to the new id, and select the copy. Framing prefers the LIVE value
  // off the canvas ref so the duplicate matches exactly what's on screen.
  const handleDuplicate = useCallback((id: string) => {
    const newId = onDuplicateRow(id);
    if (!newId) { setReelCapNotice(`You’ve hit the ${MAX_REELS}-reel limit — remove one to add another.`); return; }
    const carry = <T,>(set: Dispatch<SetStateAction<Record<string, T>>>) =>
      set(prev => (id in prev ? { ...prev, [newId]: prev[id] } : prev));
    carry(setVideoZoomMap);
    carry(setReelNameMap);   // the copy keeps the source's name (rename it apart afterwards)
    carry(setStickerMap);    // …and its FeedForce-sticker toggle
    setReelTemplateMap(prev => ({ ...prev, [newId]: prev[id] ?? activeTwitterId ?? null }));
    setFramingMap(prev => ({ ...prev, [newId]: canvasRefsMap.current.get(id)?.getFraming() ?? prev[id] ?? {} }));
    setSelectedId(newId);
  }, [onDuplicateRow, activeTwitterId]);

  const getVideoZoom = useCallback((id: string) => videoZoomMap[id] ?? 1, [videoZoomMap]);

  const applyVideoZoom = useCallback((id: string, s: number) => {
    const clamped = Math.max(0.5, Math.min(3, s));
    setVideoZoomMap(prev => ({ ...prev, [id]: clamped }));
    canvasRefsMap.current.get(id)?.setZoom(clamped);
  }, [canvasRefsMap]);

  // ── Download (one reel, or all) ───────────────────────────────────────────────
  // Only the on-screen reel is mounted (canvasRefsMap holds a single ref), so "Download all" can't just
  // loop the refs — it cycles the selection to each reel, waits for it to mount + load, then exports.
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  // ── Schedule All (Pro): bulk-render chosen reels, upload each, then bulk-schedule via the API ──
  const [scheduleAllOpen, setScheduleAllOpen] = useState(false);
  const [scheduleAllList, setScheduleAllList] = useState<ScheduleAllReelItem[]>([]);
  const [isSchedulingAll, setIsSchedulingAll] = useState(false);
  const [scheduleAllProgress, setScheduleAllProgress] = useState<{ phase: 'render' | 'submit'; done: number; total: number }>({ phase: 'render', done: 0, total: 0 });
  // Post-batch summary (mirrors downloadNotice); `detail` carries the per-reel reasons (title attr).
  const [scheduleAllNotice, setScheduleAllNotice] = useState<{ text: string; detail: string } | null>(null);
  useEffect(() => { batchExportRef.current = isDownloadingAll || isSchedulingAll; }, [isDownloadingAll, isSchedulingAll]);
  const [downloadProgress, setDownloadProgress] = useState({ done: 0, total: 0 });
  // Post-batch summary when a "download all" didn't produce every reel — otherwise the zip silently
  // omits failed/never-ready reels and the user thinks they got everything.
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  // Shown when an add/duplicate is blocked by the MAX_REELS cap.
  const [reelCapNotice, setReelCapNotice] = useState<string | null>(null);
  const atReelCap = entries.length >= MAX_REELS;
  // "Delete all reels" confirm. Only offered when there's actually something to clear (more than one
  // reel, or a single reel that isn't blank).
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const hasReelContent = entries.length > 1
    || (!!entries[0] && !!(entries[0].url?.trim() || entries[0].videoUrl || entries[0].localVideoSrc || entries[0].caption?.trim()));
  // Any export in flight: every export button (single Download, Download All, Schedule, Schedule
  // All) disables while one runs, since they share the reel canvases and only one recording can run
  // at a time.
  const exportBusy = downloadingOne || isDownloadingAll || scheduling || isSchedulingAll;
  const flashScheduleError = useCallback((msg: string) => {
    setScheduleError(msg);
    window.setTimeout(() => setScheduleError(null), 4000);
  }, []);

  // Wait until reel `id`'s canvas has mounted (after the swap fade) and its video is ready enough to export.
  const waitForReelReady = useCallback(async (id: string, timeoutMs = 15000): Promise<TikTokCanvasRef | null> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ref = canvasRefsMap.current.get(id);
      const video = ref?.getVideoElement();
      // getFraming() is null until the saved crop/trim has been applied for the current source —
      // exporting before that bakes default-framed (uncropped) frames into the head of the file.
      if (ref && video && video.readyState >= 2 && ref.getFraming() !== null) return ref;
      await new Promise(r => setTimeout(r, 80));
    }
    return canvasRefsMap.current.get(id) ?? null;
  }, [canvasRefsMap]);

  const downloadAllReels = useCallback(async () => {
    if (isDownloadingAll || downloadingOne || scheduling || isSchedulingAll) return;
    const toDownload = entries.filter(e => !e.loading
      && (e.localVideoSrc || e.videoUrl || (e.data && !(e.data.images && e.data.images.length > 0))));
    if (toDownload.length === 0) return;
    const original = selectedId;
    // Export in strip/number order (FIFO) so the files come out numbered 1→N. Only the displayed reel is
    // mounted (virtualized), so we flip each reel on-screen (setSelectedId) and waitForReelReady before
    // exporting it; each reel's crop/pan/zoom is restored from framingMap on that mount.
    const ordered = toDownload;
    // One dated folder for the whole batch (filesystem-safe, no colons): YYYY-MM-DD_HH-MM-SS.
    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const folder = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}_${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
    setIsDownloadingAll(true);
    setDownloadNotice(null);
    setDownloadProgress({ done: 0, total: ordered.length });
    // Collect every reel's export as bytes (in number order), then bundle into ONE zip named the folder,
    // with each file nested under `<folder>/` so it extracts to a single dated folder.
    let omitted = 0;              // reels that never rendered (canvas not ready, or export failed/empty)
    let stoppedForQuota = false;  // export quota ran out mid-batch
    let added = 0;                // reels actually written into the zip
    try {
      // Stream each reel into ONE zip as it renders, freeing its MP4 bytes before rendering the next — peak
      // memory is one clip plus the growing archive, NOT all N sources + a full-archive buffer held at once
      // (a 50-reel batch otherwise risked an out-of-memory tab crash). Store-only (ZipPassThrough): the MP4s
      // are already compressed. fflate loads on demand — only this export path needs it.
      const { Zip, ZipPassThrough } = await import('fflate');
      const zipChunks: Uint8Array[] = [];
      let resolveZip!: (b: Blob) => void;
      let rejectZip!: (e: unknown) => void;
      const zipDone = new Promise<Blob>((res, rej) => { resolveZip = res; rejectZip = rej; });
      const zip = new Zip((err, chunk, final) => {
        if (err) { rejectZip(err); return; }
        zipChunks.push(chunk);
        if (final) resolveZip(new Blob(zipChunks as BlobPart[], { type: 'application/zip' }));
      });
      const usedNames = new Set<string>();   // never let one reel overwrite another (suffix _2, _3, …)
      for (let i = 0; i < ordered.length; i++) {
        const entry = ordered[i];
        // Pipeline: start downloading the NEXT reel's bytes while this one exports, so flipping to it
        // isn't gated on a fresh CDN fetch (its canvas then loads instantly from the blob cache).
        const next = ordered[i + 1];
        const nextSrc = next && !next.localVideoSrc ? (next.videoUrl ?? (next.data ? bestVideoUrl(next.data) : null)) : null;
        if (nextSrc) void getVideoBlob(nextSrc);
        let ref = canvasRefsMap.current.get(entry.id);
        const vid = ref?.getVideoElement();
        // getFraming() null = saved crop/trim not applied to this mount yet — exporting now would
        // bake default framing; fall through to waitForReelReady, which gates on it.
        if (!ref || !vid || vid.readyState < 2 || ref.getFraming() === null) {
          setSelectedId(entry.id);
          ref = (await waitForReelReady(entry.id)) ?? undefined;
        }
        if (ref) {
          // Each finished reel is one export (FREE_TIER_PLAN.md), charged once the canvas is
          // actually ready — keyed by entry, so a failed export retries free and a spent quota
          // ends the batch (whatever exported before the stop still zips below).
          if (!(await exportGuard.consumeOne(`reel:${entry.id}`))) { stoppedForQuota = true; break; }
          try {
            const blob = await ref.exportBlob();
            if (blob) {
              const reelNo = entries.findIndex(x => x.id === entry.id) + 1;
              const cap = (entry.caption || '').replace(/[/\\:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
              const stem = `${String(reelNo).padStart(2, '0')}_${cap || 'reel'}`;
              // Nested under `<folder>/` so it extracts to a single dated folder. Unique by construction,
              // but suffix _2, _3, … on any caption/number clash so no reel is silently dropped.
              let name = `${folder}/${stem}.mp4`;
              for (let n = 2; usedNames.has(name); n++) name = `${folder}/${stem}_${n}.mp4`;
              usedNames.add(name);
              // Read the bytes BEFORE registering the stream: if arrayBuffer() rejects we must not leave an
              // added-but-never-pushed entry, which would corrupt the archive and hang zip.end()/await zipDone.
              let bytes: Uint8Array | null = new Uint8Array(await blob.arrayBuffer());
              const file = new ZipPassThrough(name);
              zip.add(file);
              file.push(bytes, true);   // final (only) chunk for this file; fflate consumes the buffer…
              bytes = null;             // …so drop our reference to this reel's MP4 before the next render
              added++;
              // Sidecar .txt of the reel's description, sitting next to its MP4 (same path, .mp4 → .txt).
              // Added ONLY after the MP4 stream is finalized above, so entries stay sequential. fflate
              // requires one ZipPassThrough be fully pushed before the next is added, and interleaving
              // would corrupt the archive. Null when the description is blank; never counted as a reel.
              const sidecar = descriptionSidecar(name.replace(/\.mp4$/, ''), entry.description);
              if (sidecar) {
                const txtFile = new ZipPassThrough(sidecar.name);
                zip.add(txtFile);
                txtFile.push(sidecar.bytes, true);
              }
            } else { omitted++; }   // exportBlob returned null → nothing rendered
          } catch (err) { omitted++; console.error(`Failed to export reel ${entry.id}:`, err); }
        } else { omitted++; }       // canvas never became ready within the timeout
        setDownloadProgress(p => ({ ...p, done: i + 1 }));
      }
      if (added > 0) {
        zip.end();                       // writes the central directory → emits the final ondata chunk
        const zipBlob = await zipDone;   // resolves inside the Zip ondata handler on the final chunk
        const url = URL.createObjectURL(zipBlob);
        Object.assign(document.createElement('a'), { href: url, download: `${folder}.zip` }).click();
        URL.revokeObjectURL(url);
      }
      // Tell the user when the zip isn't the whole set (rendered count vs attempted), instead of
      // silently handing over a short zip.
      const got = added;
      // consumeOne returns false for BOTH a real quota-exhaustion and a transient quota-check failure,
      // so don't assert "limit reached" (a false paywall on a network blip) — point at the export-limit
      // chip, which shows the true remaining count, and stay accurate either way.
      if (stoppedForQuota) setDownloadNotice(`Stopped at ${got} of ${ordered.length} — check your export limit.`);
      else if (omitted > 0) setDownloadNotice(`Downloaded ${got} of ${ordered.length} — ${omitted} couldn’t be rendered.`);
    } finally {
      setSelectedId(original);   // restore the user's reel (no-op if already there)
      setReelVisible(true);
      setIsDownloadingAll(false);
    }
  }, [isDownloadingAll, downloadingOne, scheduling, isSchedulingAll, entries, selectedId, canvasRefsMap, waitForReelReady, exportGuard]);

  // ── Schedule All ──────────────────────────────────────────────────────────────────────────────
  // Open the modal with a snapshot of the eligible reels (the same filter as Download All). Only the
  // mounted reel has a live <video> (the grid is virtualized), so its duration/framing are the best
  // guess for the modal's chips; every reel is re-measured authoritatively at render time below.
  const openScheduleAll = useCallback(() => {
    if (exportBusy) return;
    const eligible = entries.filter(e => !e.loading
      && (e.localVideoSrc || e.videoUrl || (e.data && !(e.data.images && e.data.images.length > 0))));
    setScheduleAllList(eligible.map(e => {
      const ref = canvasRefsMap.current.get(e.id);
      const d = ref?.getVideoElement()?.duration;
      return {
        id: e.id,
        number: entries.findIndex(x => x.id === e.id) + 1,
        // The Instagram post caption is the reel's description (falling back to the overlay caption),
        // NOT the on-video caption. Set here at the source so the modal's preview + 2200-char trim guard
        // operate on the actual text; it flows unchanged through the modal into the bulk-route items.
        caption: reelPostText(e),
        framing: ref?.getFraming() ?? framingMap[e.id] ?? null,
        sourceDuration: typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : null,
      };
    }));
    setScheduleAllNotice(null);
    setScheduleAllOpen(true);
  }, [entries, exportBusy, framingMap, canvasRefsMap]);

  // The engine: mirror downloadAllReels' virtualized cycle (flip each reel on screen, waitForReelReady,
  // exportBlob), but upload each render to post-videos and bulk-schedule instead of zipping. Does NOT
  // consume the export quota: scheduling is Pro-only, same as the existing single Schedule button.
  const scheduleAllRun = useCallback(async ({ accountId, timezone, items }: ScheduleAllSubmitArgs) => {
    if (isDownloadingAll || downloadingOne || scheduling || isSchedulingAll) return;
    if (!userId || items.length === 0) return;
    const original = selectedId;
    const stamp = Date.now();
    // Per-reel outcome keyed by id; `note` is a failure reason, or a duration warning on a success.
    const outcome = new Map<string, { label: string; ok: boolean; note?: string }>();
    const labelOf = (id: string) => {
      const n = cgEntriesRef.current.findIndex(x => x.id === id) + 1;
      return n > 0 ? `Reel ${n}` : 'Reel';
    };
    const fail = (id: string, note: string) => outcome.set(id, { label: labelOf(id), ok: false, note });
    const ready: { id: string; mediaUrl: string; caption: string; scheduledFor: string; requestId?: string; stickerEnabled?: boolean }[] = [];
    setIsSchedulingAll(true);
    setScheduleAllNotice(null);
    setScheduleAllProgress({ phase: 'render', done: 0, total: items.length });
    try {
      // ── Phase 1: render + upload, one reel at a time. A failed reel is skipped, never aborts. ──
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await (async () => {
          const entry = cgEntriesRef.current.find(e => e.id === item.id);
          if (!entry) { fail(item.id, 'the reel was removed'); return; }
          // Pipeline: start downloading the NEXT reel's bytes while this one renders (same trick as
          // Download All), so flipping to it isn't gated on a fresh CDN fetch.
          const nid = items[i + 1]?.id;
          const nextEntry = nid ? cgEntriesRef.current.find(e => e.id === nid) : undefined;
          const nextSrc = nextEntry && !nextEntry.localVideoSrc
            ? (nextEntry.videoUrl ?? (nextEntry.data ? bestVideoUrl(nextEntry.data) : null)) : null;
          if (nextSrc) void getVideoBlob(nextSrc);

          let ref = canvasRefsMap.current.get(item.id);
          const vid0 = ref?.getVideoElement();
          // Same framing gate as Download All: an already-mounted canvas can be video-ready while
          // its saved crop/trim hasn't been applied yet — bake then and the reel exports unframed.
          if (!ref || !vid0 || vid0.readyState < 2 || ref.getFraming() === null) {
            setSelectedId(item.id);
            ref = (await waitForReelReady(item.id)) ?? undefined;
          }
          if (!ref || (ref.getVideoElement()?.readyState ?? 0) < 2) {
            fail(item.id, 'its video never became ready');
            return;
          }
          // Authoritative duration check on the MOUNTED video (the modal could only guess for
          // unmounted reels). Long/short attach a warning to the result, they never block.
          const dur = ref.getVideoElement()?.duration;
          const srcDuration = typeof dur === 'number' && Number.isFinite(dur) && dur > 0 ? dur : null;
          const framing = ref.getFraming() ?? framingMap[item.id] ?? null;
          const cls = classifyReelDuration(effectiveReelDuration(framing, srcDuration));
          const note = cls === 'long' ? 'over 90s, will post as a video not a Reel'
            : cls === 'short' ? 'under the Reels minimum, Instagram may reject it' : undefined;
          // Snapshot the sticker flag BEFORE rendering: exportBlob bakes the sticker as it is right
          // now, and a toggle flipped mid-render must not record a flag that doesn't match the
          // baked video. Undefined (not false) for non-members, so JSON.stringify drops it.
          const stickerSnapshot = rewardsEnrolled ? effectiveSticker(item.id) : undefined;
          try {
            let blob: Blob | null = await ref.exportBlob();
            if (!blob) { fail(item.id, 'could not be rendered'); return; }
            const up = await uploadRenderBlob(userId, 'post-videos', blob, `reel_${stamp}_${i}.mp4`, 'video/mp4');
            blob = null;   // drop the MP4 reference so its bytes can be collected before the next render
            if (!up.ok) { fail(item.id, up.message); return; }   // real reason (size cap / RLS / network)
            // Safety-net ledger BEFORE scheduling (mirrors the Composer's ledgerPending): if the tab
            // dies mid-batch the hourly cron still sweeps the upload. On success the bulk route
            // re-ledgers the file against the real post id. Expiry = this reel's publish time + 6h
            // (the same sweep time the server swap writes), NOT the Composer's flat now+1h: a big
            // batch renders and uploads for well over an hour, and a 1h window would let the hourly
            // cron delete early uploads before phase 2 even submits them.
            try {
              const whenMs = Date.parse(item.scheduledFor);
              const pendingExpiryMs = (Number.isFinite(whenMs) ? whenMs : Date.now()) + 6 * 3600_000;
              await supabase.from('scheduled_render_media').insert({
                user_id: userId, post_id: `pending_${stamp}`, bucket: up.bucket, path: up.path,
                expires_at: new Date(pendingExpiryMs).toISOString(),
              });
            } catch { /* best-effort, must not block scheduling */ }
            // Idempotency key, minted ONCE per rendered file: if this item is ever resent within
            // Zernio's ~5 minute x-request-id window (lost response, quick manual retry), the
            // resend maps onto the ORIGINAL post instead of double-posting. Omitted (not faked)
            // when randomUUID is unavailable, the bulk route treats it as optional.
            const requestId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID() : undefined;
            // stickerEnabled rides only for enrolled members (the pre-render snapshot above),
            // mirroring the single Schedule handoff.
            ready.push({ id: item.id, mediaUrl: up.url, caption: item.caption, scheduledFor: item.scheduledFor, requestId, stickerEnabled: stickerSnapshot });
            outcome.set(item.id, { label: labelOf(item.id), ok: true, note });
          } catch (err) {
            console.error(`[schedule all] failed to render reel ${item.id}:`, err);
            fail(item.id, 'could not be rendered');
          }
        })();
        setScheduleAllProgress(p => ({ ...p, done: i + 1 }));
      }

      // A slow batch can outrun a near-term slot, and one past time would 400 the WHOLE bulk call
      // (the route validates all-or-nothing), so peel those off as failures instead of poisoning a
      // chunk. 30s of margin for the request itself.
      const submittable = ready.filter(r => {
        const stillFuture = Date.parse(r.scheduledFor) > Date.now() + 30_000;
        if (!stillFuture) fail(r.id, 'its scheduled time passed while rendering');
        return stillFuture;
      });

      // ── Phase 2: submit in chunks of BULK_CHUNK, sequentially. NEVER retry a failed chunk: a
      // lost response can mean the server already scheduled it, and a resend would double-post. ──
      if (submittable.length > 0) {
        setScheduleAllProgress({ phase: 'submit', done: 0, total: submittable.length });
        let capHit = false;
        for (let at = 0; at < submittable.length; at += BULK_CHUNK) {
          const chunk = submittable.slice(at, at + BULK_CHUNK);
          if (capHit) { chunk.forEach(c => fail(c.id, 'the account hit its scheduled-post limit')); continue; }
          try {
            const res = await authedFetch('/api/schedule/posts/bulk', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                accountId, timezone,
                items: chunk.map(c => ({ mediaUrl: c.mediaUrl, caption: c.caption, scheduledFor: c.scheduledFor, requestId: c.requestId, stickerEnabled: c.stickerEnabled })),
              }),
            });
            const json: { results?: { ok?: boolean; error?: string }[]; error?: string } = await res.json().catch(() => ({}));
            if (!res.ok) {
              const msg = typeof json?.error === 'string' ? json.error : 'scheduling failed';
              chunk.forEach(c => fail(c.id, msg));
              // 409 = the account's schedule slots are full; later chunks would 409 too, so stop
              // sending them (this is not a retry, just not burning doomed requests).
              if (res.status === 409) capHit = true;
            } else {
              const rs = Array.isArray(json?.results) ? json.results : [];
              chunk.forEach((c, j) => {
                if (!rs[j]?.ok) fail(c.id, typeof rs[j]?.error === 'string' ? rs[j].error! : 'scheduling failed');
              });
            }
          } catch {
            // Lost response: the server may have scheduled some or all of this chunk. Surface it for
            // a manual calendar check instead of resending (double-post risk).
            chunk.forEach(c => fail(c.id, 'no response, check the Post calendar before retrying'));
          }
          setScheduleAllProgress(p => ({ ...p, done: Math.min(at + chunk.length, p.total) }));
        }
      }

      // ── Summary (mirrors downloadNotice): counts up front, per-reel reasons on hover. ──
      const all = Array.from(outcome.values());
      const okCount = all.filter(o => o.ok).length;
      const failed = all.filter(o => !o.ok);
      const warned = all.filter(o => o.ok && o.note);
      const text = failed.length === 0
        ? `Scheduled ${okCount} of ${items.length} reels.${warned.length ? ` ${warned.length} with warnings.` : ''}`
        : `Scheduled ${okCount} of ${items.length}, ${failed.length} failed.`;
      const detail = all.filter(o => o.note).map(o => `${o.label}: ${o.note}`).join('\n');
      setScheduleAllNotice({ text, detail: detail || 'All reels were scheduled.' });
    } finally {
      setSelectedId(original);   // restore the user's reel (no-op if already there)
      setReelVisible(true);
      setIsSchedulingAll(false);
    }
  }, [isDownloadingAll, downloadingOne, scheduling, isSchedulingAll, userId, selectedId, canvasRefsMap, waitForReelReady, framingMap, rewardsEnrolled, effectiveSticker]);

  const selectedEntry = entries.find(e => e.id === selectedId) ?? entries[0];

  const showVideoControls = !!selectedEntry && (
    !!selectedEntry.localVideoSrc || !!selectedEntry.videoUrl || (!!selectedEntry.data && !selectedEntry.loading)
  );
  // The bottom timeline strip shows whenever it's toggled open AND either a video is loaded (the real
  // VideoControlsBar) or there's no video yet (an empty-timeline placeholder).
  const timelineStripShown = timelineOpen && !!selectedEntry;

  // canvasRefVersion forces re-derivation when refs populate
  const activeVideoRef = showVideoControls && canvasRefVersion >= 0
    ? (canvasRefsMap.current.get(selectedEntry!.id) ?? null)
    : null;

  const activeRecordingState = showVideoControls
    ? (recordingStateMap[selectedEntry!.id] ?? null)
    : null;

  // Source URL for the selected reel's video — fed to the timeline for filmstrip thumbnail extraction.
  // Byte-cache the active reel's video so export doesn't re-download the (short-lived) CDN URL — which
  // 403s once it expires. We fetch the full file through the proxy once, while the link is fresh, into a
  // blob and prefer that as the source; export then reads the blob directly instead of re-hitting the CDN.
  const [videoBlobUrls, setVideoBlobUrls] = useState<Record<string, string>>({});
  const blobFetchingRef = useRef<Set<string>>(new Set());
  // Revoke every cached blob URL on unmount — each one pins the full video bytes in memory, so
  // section-switching without this leaks the entire byte-cache every visit.
  const videoBlobUrlsRef = useRef(videoBlobUrls);
  useEffect(() => { videoBlobUrlsRef.current = videoBlobUrls; }, [videoBlobUrls]);
  useEffect(() => () => { for (const url of Object.values(videoBlobUrlsRef.current)) URL.revokeObjectURL(url); }, []);

  const activeVideoSrc = useMemo(() => {
    if (!showVideoControls) return null;
    // Prefer the in-session source (local blob → downloaded blob → the proxy stream we're already
    // playing) over videoUrl. A background store setting videoUrl mid-session must NOT flip the source,
    // which would reload the <video> and reset the user's live crop/pan/zoom/trim. videoUrl is only the
    // source on a fresh load, when data is null (auto-fetch skips already-stored reels).
    return selectedEntry!.localVideoSrc
      ?? videoBlobUrls[selectedEntry!.id]
      ?? (selectedEntry!.data ? bestVideoUrl(selectedEntry!.data) : selectedEntry!.videoUrl ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showVideoControls,
    selectedEntry?.id,
    selectedEntry?.localVideoSrc,
    selectedEntry?.videoUrl,
    selectedEntry?.data?.play,
    selectedEntry?.data?.hdplay,
    selectedEntry?.data?.wmplay,
    videoBlobUrls,
  ]);

  // Best-effort: download the selected link-fetched reel's bytes into a blob once it loads (uploads and
  // persisted reels are already stable, so they're skipped). If the download fails (e.g. the URL already
  // expired), we just fall back to the CDN URL and export may still 403 — but the common
  // fetch→edit→export flow caches the bytes while the link is fresh.
  useEffect(() => {
    const e = selectedEntry;
    if (!e) return;
    if (e.localVideoSrc || e.videoUrl || !e.data) return;
    if (videoBlobUrls[e.id] || blobFetchingRef.current.has(e.id)) return;
    const proxyUrl = bestVideoUrl(e.data);
    if (!proxyUrl) return;
    blobFetchingRef.current.add(e.id);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(proxyUrl);
        if (!res.ok || cancelled) return;
        const blobUrl = URL.createObjectURL(await res.blob());
        if (cancelled) { URL.revokeObjectURL(blobUrl); return; }
        setVideoBlobUrls(prev => {
          if (prev[e.id]) { URL.revokeObjectURL(blobUrl); return prev; }
          return { ...prev, [e.id]: blobUrl };
        });
      } catch { /* best-effort */ }
      finally { blobFetchingRef.current.delete(e.id); }
    })();
    return () => { cancelled = true; };
  }, [selectedEntry, videoBlobUrls]);

  // First-run / empty state: reels posting in twitter mode with no reel templates → send to the editor.
  // While templates are still loading, render blank (not the posting UI) so it doesn't flash for a frame.
  // (Caption mode doesn't use a reel template, so it's unaffected.)
  if (videoMode === 'twitter' && twitterTemplates.length === 0) {
    return twitterLoaded ? (
      <TemplatesEmptyState
        title="No reel templates yet"
        description="You need a reel template before you can make a reel. Create one in the template editor first."
        actionLabel="Go to template editor"
        onAction={() => onGoToTemplateEditor?.()}
      />
    ) : <div className="h-full w-full" />;
  }

  return (
    <div className="relative w-full flex flex-col h-full overflow-hidden">

      {/* ── Element rail (mirrors the template editor): link + caption flyouts edit the SELECTED reel,
            with undo/redo for the URL/caption edits beneath. ── */}
      {selectedEntry && (
        <ElementRail
          categories={[
            { id: 'caption', label: 'Caption', icon: captionGlyph, content: (
              <ReelCaptionFlyout
                entry={selectedEntry}
                onUpdateField={(f, v) => recordEdit(selectedEntry.id, f, v)}
              />
            ) },
            { id: 'link', label: 'Video link', icon: linkGlyph, content: (
              <ReelLinkFlyout
                entry={selectedEntry}
                onUpdateField={(f, v) => recordEdit(selectedEntry.id, f, v)}
                onUpdateLocalVideo={(s, n) => guardedUpdateLocalVideo(selectedEntry.id, s, n)}
                onFetch={() => onFetchVideo(selectedEntry.id)}
              />
            ) },
            // The Instagram post caption (and download sidecar text); its own document glyph, distinct from Caption.
            { id: 'description', label: 'Description', icon: descriptionGlyph, content: (
              <ReelDescriptionFlyout
                entry={selectedEntry}
                onUpdateField={(f, v) => recordEdit(selectedEntry.id, f, v)}
              />
            ) },
          ]}
          extraIsland={(
            // Adjust island: per-reel framing/trim controls as a rail-style icon-button column.
            <ReelAdjustFlyout
              zoom={getVideoZoom(selectedEntry.id)}
              onZoom={z => applyVideoZoom(selectedEntry.id, z)}
              stickerEnabled={effectiveSticker(selectedEntry.id)}
              onToggleSticker={rewardsEnrolled ? () => setStickerMap(prev => ({ ...prev, [selectedEntry.id]: !(prev[selectedEntry.id] ?? false) })) : undefined}
              onResetTrim={() => canvasRefsMap.current.get(selectedEntry.id)?.resetTrim()}
              onResetBox={() => canvasRefsMap.current.get(selectedEntry.id)?.resetBox()}
              onCenter={() => canvasRefsMap.current.get(selectedEntry.id)?.centerBox()}
              timelineOpen={timelineOpen}
              onToggleTimeline={() => setTimelineOpen(o => !o)}
              onRemoveVideo={() => {
                // Erase the loaded clip + its link → showVideoControls flips false, so the island
                // collapses back out. Clearing the URL too prevents an auto re-fetch.
                if (selectedEntry.localVideoSrc) URL.revokeObjectURL(selectedEntry.localVideoSrc);
                guardedUpdateLocalVideo(selectedEntry.id, '', '');
                recordEdit(selectedEntry.id, 'url', '');
                setTimelineOpen(false);   // close the timeline too — no video left to edit
              }}
            />
          )}
          extraIslandOpen={showVideoControls}
          onUndo={mergedUndo}
          onRedo={mergedRedo}
          canUndo={mergedCanUndo}
          canRedo={mergedCanRedo}
          bottomSlot={onDeleteAllReels && hasReelContent ? (
            // Its own rail island (matches the undo/redo card): a size-9 rounded-xl icon button,
            // danger-tinted, so it reads as a sibling of the rail's other action buttons.
            <div className="w-full flex flex-col items-center gap-1 rounded-2xl bg-surface-1 border border-line shadow-2 p-1.5">
              <button
                type="button"
                title="Delete all reels"
                aria-label="Delete all reels"
                disabled={exportBusy || isDownloadingAll}
                onClick={() => setConfirmDeleteAll(true)}
                className="flex items-center justify-center size-9 rounded-xl text-danger-text hover:bg-danger-tint transition-colors focus-ring disabled:opacity-35 disabled:cursor-not-allowed"
              >
                <TrashIcon size={16} />
              </button>
            </div>
          ) : undefined}
        />
      )}

      {/* ── Toolbar (mirrors the Carousels toolbar: zoom · centred template dropdown · autosave + download) ── */}
      <div ref={toolbarRef} className="relative flex items-center justify-between gap-4 px-4 border-b border-line shrink-0 bg-surface-1" style={{ height: HEADER_H }}>
        {/* Left slot: the Canvas ⇄ Sheet toggle when the host provides one; otherwise an empty
            spacer keeping justify-between honest (autosave + download stay pinned right even when
            the absolutely-centred template dropdown is the only other child). Mirrors Carousels. */}
        <div className="flex items-center">{viewToggle}</div>

        {/* Centre: reel-template dropdown — mirrors the Carousels template dropdown. Selects which saved
            reel template (overlay style) is active; absolutely centred over the canvas. Only in twitter
            mode (where the templates apply). */}
        {videoMode === 'twitter' && (
          <div className="absolute inset-x-0 flex justify-center items-center pointer-events-none">
            <div ref={templateDropdownRef} className="pointer-events-auto relative flex items-center">
              <button
                ref={templateTriggerRef}
                onClick={() => setShowTemplateDropdown(v => {
                  if (!v && templateTriggerRef.current) {
                    const r = templateTriggerRef.current.getBoundingClientRect();
                    const headerBottom = toolbarRef.current?.getBoundingClientRect().bottom ?? r.bottom;
                    setDropdownAnchor({ top: headerBottom + 8, left: r.left + r.width / 2 });
                  }
                  return !v;
                })}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-fg hover:bg-hover transition-colors focus-ring"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-fg-3 shrink-0">
                  <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
                </svg>
                <span className="text-subheading text-fg max-w-[180px] truncate">
                  {activeTwitter?.name ?? 'Reels'}
                </span>
                <ChevronDownIcon size={12} className="text-fg-3 shrink-0" aria-hidden />
              </button>
              {showTemplateDropdown && dropdownAnchor && (
                <div
                  className="fixed w-[240px] bg-surface-2 border border-line rounded-xl shadow-3 z-modal py-1 overflow-hidden"
                  style={{ top: dropdownAnchor.top, left: dropdownAnchor.left, transform: 'translateX(-50%)' }}
                >
                  <div className="max-h-[320px] overflow-y-auto scrollbar-none">
                    {twitterTemplates.length === 0 ? (
                      <p className="text-caption text-fg-3 px-3 py-4 text-center">No reel templates yet</p>
                    ) : twitterTemplates.map(t => {
                      const isActive = t.id === (activeTwitter?.id ?? '');
                      return (
                        <button
                          key={t.id}
                          onClick={() => {
                            setActiveTwitterId(t.id);
                            // Assign the chosen template to the selected reel (so rows can inherit different templates).
                            if (selectedId) setReelTemplateMap(prev => ({ ...prev, [selectedId]: t.id }));
                            setShowTemplateDropdown(false);
                          }}
                          className={`flex items-center gap-2 w-full py-2 px-3 text-subheading text-left rounded-sm focus-ring transition-colors ${isActive ? 'bg-active text-fg' : 'text-fg-2 hover:text-fg hover:bg-hover'}`}
                        >
                          <span className="flex-1 truncate">{t.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Right: autosave + export quota + download (styled like Carousels). */}
        <div className="flex items-center gap-3">
          {scheduleError && <span className="text-caption text-danger-text whitespace-nowrap">{scheduleError}</span>}
          {/* Sustained load failure: the persistence guard keeps `loaded` false so autosave can't
              overwrite the saved grid with an empty one — but that also means edits made now won't
              save. Say so and offer a retry instead of a silently-empty, silently-unsaved canvas. */}
          {reelsLoadError && (
            <span className="flex items-center gap-1.5 text-caption text-danger-text whitespace-nowrap">
              Couldn&apos;t load your reels — edits won&apos;t save yet
              <button type="button" onClick={retryReelsLoad} className="underline underline-offset-2 hover:text-fg focus-ring rounded-xs">Retry</button>
            </span>
          )}
          {downloadNotice && (
            <span className="flex items-center gap-1.5 text-caption text-fg-2 whitespace-nowrap">
              {downloadNotice}
              <button type="button" onClick={() => setDownloadNotice(null)} aria-label="Dismiss" className="text-fg-4 hover:text-fg focus-ring rounded-xs">×</button>
            </span>
          )}
          {/* Schedule All summary (hover for the per-reel reasons/warnings collected by the run). */}
          {scheduleAllNotice && (
            <span className="flex items-center gap-1.5 text-caption text-fg-2 whitespace-nowrap" title={scheduleAllNotice.detail}>
              {scheduleAllNotice.text}
              <button type="button" onClick={() => setScheduleAllNotice(null)} aria-label="Dismiss" className="text-fg-4 hover:text-fg focus-ring rounded-xs">×</button>
            </span>
          )}
          {reelSyncNotice && (
            <span className="flex items-center gap-1.5 text-caption text-fg-2 whitespace-nowrap">
              {reelSyncNotice}
            </span>
          )}
          {reelCapNotice && (
            <span className="flex items-center gap-1.5 text-caption text-fg-2 whitespace-nowrap">
              {reelCapNotice}
              <button type="button" onClick={() => setReelCapNotice(null)} aria-label="Dismiss" className="text-fg-4 hover:text-fg focus-ring rounded-xs">×</button>
            </span>
          )}
          <AutosaveChip state={reelSaveState} />
          <ExportQuotaChip remaining={exportGuard.remaining} notice={exportGuard.notice} />
          {/* Download just the on-screen reel — keeps its live crop/pan/zoom. */}
          {showVideoControls && selectedEntry && (
            <Button
              variant="primary"
              size="sm"
              loading={downloadingOne}
              onClick={async () => {
                if (exportBusy) return;
                const id = selectedEntry.id;
                setDownloadingOne(true);
                // The render surfaces its own failure via the canvas status; swallow the rejection
                // here so it doesn't become an uncaught promise error.
                try {
                  const ran = await exportGuard.guard(`reel:${id}`, () => canvasRefsMap.current.get(id)?.startDownload());
                  // Emit the description sidecar .txt next to the just-downloaded MP4 (same base name the
                  // canvas built, see reelExportBaseName), so a single download carries its Instagram
                  // caption too. Only when the export actually ran (guard returns false, without throwing,
                  // when quota is spent or a download is already in flight), and descriptionSidecar returns
                  // null for a blank description, so this no-ops then too.
                  const idx = entries.findIndex(e => e.id === id);
                  const sidecar = ran ? descriptionSidecar(reelExportBaseName(selectedEntry.caption, idx, selectedEntry.data?.id), selectedEntry.description) : null;
                  if (sidecar) {
                    // The Blob encodes the same verbatim UTF-8 as sidecar.bytes; a string part sidesteps
                    // the Uint8Array/BlobPart typing mismatch and matches the CSV-export idiom.
                    const url = URL.createObjectURL(new Blob([selectedEntry.description], { type: 'text/plain;charset=utf-8' }));
                    Object.assign(document.createElement('a'), { href: url, download: sidecar.name }).click();
                    URL.revokeObjectURL(url);
                  }
                }
                catch (err) { console.error('[reel download]', err); }
                finally { setDownloadingOne(false); }
              }}
              disabled={exportBusy}
              leadingIcon={<DownloadIcon size={13} />}
              className="rounded-full"
            >
              Download
            </Button>
          )}
          {/* Schedule the on-screen reel: render it to an MP4 and hand it to the Post screen. Pro-only. */}
          {plan === 'pro' && onScheduleReel && showVideoControls && selectedEntry && (
            <Button
              variant="secondary"
              size="sm"
              loading={scheduling}
              disabled={exportBusy}
              onClick={async () => {
                if (exportBusy) return;
                const id = selectedEntry.id;
                setScheduleError(null);
                setScheduling(true);
                try {
                  const blob = await canvasRefsMap.current.get(id)?.exportBlob();
                  // Hand off both the on-video caption AND the description; the Post composer seeds its
                  // editable Instagram caption from reelPostText(draft) (description preferred).
                  // stickerEnabled rides only for enrolled members (undefined otherwise), so the
                  // schedule request never carries the flag for non-members.
                  if (blob) onScheduleReel({ blob, caption: selectedEntry.caption ?? '', description: selectedEntry.description ?? '', stickerEnabled: rewardsEnrolled ? effectiveSticker(id) : undefined });
                  else flashScheduleError('Could not render this reel — give it a moment to load, then try again.');
                } catch {
                  flashScheduleError('Could not render this reel — try again.');
                } finally {
                  setScheduling(false);
                }
              }}
              className="rounded-full"
            >
              Schedule
            </Button>
          )}
          {/* Download every reel (cycles through them); only shown when there's more than one. */}
          {videoRenderEntries.length > 1 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={downloadAllReels}
              disabled={exportBusy}
              leadingIcon={<DownloadIcon size={13} />}
              className="rounded-full"
            >
              {isDownloadingAll ? `Downloading ${downloadProgress.done}/${downloadProgress.total}…` : 'Download All'}
            </Button>
          )}
          {/* Bulk-schedule every eligible reel to Instagram (Pro-only, Video Reels workspace only). */}
          {plan === 'pro' && setEntries && (
            <Button
              variant="secondary"
              size="sm"
              onClick={openScheduleAll}
              disabled={exportBusy}
              className="rounded-full"
            >
              {isSchedulingAll
                ? (scheduleAllProgress.phase === 'render'
                  ? `Rendering ${Math.min(scheduleAllProgress.done + 1, scheduleAllProgress.total)} of ${scheduleAllProgress.total}…`
                  : 'Scheduling…')
                : 'Schedule All'}
            </Button>
          )}
        </div>
      </div>

      {onDeleteAllReels && (
        <Modal
          open={confirmDeleteAll}
          onClose={() => setConfirmDeleteAll(false)}
          title="Delete all reels?"
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setConfirmDeleteAll(false)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={() => {
                onDeleteAllReels();
                // The reset reel reuses id '1', so the per-reel state maps (keyed by id) must be cleared
                // too — otherwise the deleted reel's template/framing/zoom/name/recording bleed onto the
                // fresh reel and get re-saved. Clearing gives a true clean slate.
                setFramingMap({}); setReelTemplateMap({}); setReelNameMap({}); setStickerMap({}); setVideoZoomMap({}); setRecordingStateMap({});
                setConfirmDeleteAll(false);
              }}>Delete all reels</Button>
            </>
          }
        >
          <p className="text-caption text-fg-3">
            This removes every reel from your workspace and permanently deletes their stored videos. It
            can&apos;t be undone. Download anything you want to keep first.
          </p>
        </Modal>
      )}

      {/* Schedule All planner: picks the reels/account/cadence, then hands off to scheduleAllRun. */}
      {scheduleAllOpen && (
        <ScheduleAllModal
          open={scheduleAllOpen}
          onClose={() => setScheduleAllOpen(false)}
          reels={scheduleAllList}
          onSubmit={(args) => { setScheduleAllOpen(false); void scheduleAllRun(args); }}
        />
      )}

      {/* ── Reel canvas — one reel at a time, like the carousels editor (switch via the docked strip) ── */}
      <div
        ref={attachScroll}
        className="flex-1 overflow-auto overscroll-contain no-native-scrollbar flex flex-col [align-items:safe_center] [justify-content:safe_center]"
      >
        {/* World wrapper — width = lane × viewScale/ZOOM_MIN. At min zoom it exactly fills the view (whole
            reel visible, nothing to pan); zoom in and it overflows so you pan within that one reel. The
            pannable area is always just the min-zoom view scaled up — never an unbounded void. */}
        <div className="flex justify-center" style={{ minWidth: lane.width ? lane.width * viewScale / ZOOM_MIN : undefined }}>
        <div ref={contentRef} className="flex flex-col items-center py-6 px-4" style={{ zoom: fitFactor * viewScale, opacity: reelVisible ? 1 : 0 }}>
          {/* VIRTUALIZED: only the displayed reel mounts a live canvas — mounting every reel's <video>
              would hang the browser on a large grid (a real account has 486 reels). A reel's edits
              (crop/zoom/pan/trim) live inside its canvas while mounted, so before a switch unmounts the
              outgoing reel we snapshot its getFraming() into framingMap (see the [selectedId] effect
              above); its next mount replays that via initialFraming. Do NOT revert to keeping all reels
              mounted without also removing that capture, or edits are lost. displayId lags selectedId by
              one render, which is why the capture reads the still-mounted outgoing reel. */}
          {entries.map((entry, index) => {
            // Virtualized: only the displayed reel renders its (heavy) canvas + template compute. Every
            // other reel is a zero-cost hidden placeholder — navigation is the SlidesStrip below, and the
            // outgoing reel's framing was snapshotted into framingMap on the switch, so nothing is lost.
            if (entry.id !== displayId) return <div key={entry.id} className="hidden" aria-hidden />;
            // Each reel renders with ITS OWN inherited template (so a saved grid can mix templates);
            // falls back to the active picker selection, then the default look.
            const rowTemplateId = reelTemplateMap[entry.id] ?? activeTwitterId;
            const rowSettings = twitterTemplates.find(t => t.id === rowTemplateId)?.settings ?? twSettings;

            const hasRender = !entry.loading && (
              !!entry.localVideoSrc
              || !!entry.videoUrl
              || (!!entry.data && !(entry.data.images && entry.data.images.length > 0))
            );

            return (
              <div
                key={entry.id}
                className="flex flex-col gap-3"
                style={{ width: CARD_W }}
              >
                {/* URL + caption live in the left rail's link/caption flyouts. */}

                {/* Template + video skeleton — what the reel will look like, shown until a video is added. */}
                {!hasRender && entry.mode === 'twitter' && !entry.loading && (
                  <div className="mt-2">
                    <ReelTemplatePreview settings={rowSettings} brand={brand} width={CARD_W} overlayCaption={entry.caption} />
                  </div>
                )}
                {/* Canvas render (only when ready) */}
                {hasRender && (
                  <div className="flex flex-col gap-4 mt-2">
                    {/* Selection ring + canvas */}
                    <div
                      onClick={() => setSelectedId(entry.id)}
                      className="relative cursor-pointer transition-all duration-150 mt-1 ring-1 ring-line hover:ring-line-strong"
                    >
                      <TikTokCanvas
                          ref={r => {
                            if (r) {
                              canvasRefsMap.current.set(entry.id, r);
                              if (!canvasRefRegistered.current.has(entry.id)) {
                                canvasRefRegistered.current.add(entry.id);
                                setCanvasRefVersion(v => v + 1);
                              }
                            } else {
                              canvasRefsMap.current.delete(entry.id);
                            }
                          }}
                          videoSrc={entry.localVideoSrc ?? (entry.data ? bestVideoUrl(entry.data) : entry.videoUrl ?? '')}
                          videoId={entry.data?.id}
                          rowNumber={index}
                          onVideoError={() => onHandleVideoError(entry.id)}
                          brand={entry.mode === 'caption' ? 'clean' : 'sonotrade'}
                          overlayLogoSrc={brand.logoSrc || '/templatelogo.png'}
                          overlayDisplayName={rowSettings.defaultDisplayName || brand.displayName || 'Your Name'}
                          overlayHandle={rowSettings.defaultHandle || brand.handle || '@yourhandle'}
                          overlayVerified={rowSettings.showVerified}
                          overlayCaption={entry.caption}
                          twitterSettings={rowSettings}
                          stickerEnabled={effectiveSticker(entry.id)}
                          initialFraming={framingMap[entry.id] ?? null}
                          onFramingChange={markFramingDirty}
                          onRecordingStateChange={state =>
                            setRecordingStateMap(prev => ({ ...prev, [entry.id]: state }))
                          }
                        />
                      {/* Export progress — a bar across the bottom of the current reel while it downloads. */}
                      {(() => {
                        const rec = recordingStateMap[entry.id];
                        if (!rec?.isRecording) return null;
                        return (
                          <div className="absolute inset-x-0 bottom-0 z-20 h-2 bg-black/50 overflow-hidden">
                            <div
                              className="h-full bg-accent transition-[width] duration-200 ease-out"
                              style={{ width: `${Math.max(2, Math.round(rec.recProgress * 100))}%` }}
                            />
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </div>
        {/* Spacer reserving room for the docked slides strip — a flow element (not container padding) so
            safe-centre can still scroll the reel to its top. */}
        <div aria-hidden className="shrink-0" style={{ height: SLIDES_DOCK_CLEARANCE }} />
      </div>

      {/* ── Video timeline — bottom panel; toggled from the on-canvas button. Sits in FRONT of the left
            rail (z-30) so the undo/redo island tucks behind the timeline instead of overlapping it. ── */}
      <div className="relative bg-surface-1" style={{ zIndex: 40 }}>
        {timelineStripShown && (
          showVideoControls ? (
            <VideoControlsBar
              entryId={selectedEntry!.id}
              activeRef={activeVideoRef}
              recordingState={activeRecordingState}
              videoSrc={activeVideoSrc}
              onHistory={handleTimelineHistory}
              guardExport={run => exportGuard.guard(`reel:${selectedEntry!.id}`, run)}
              // Timeline "Add video": durable post-videos upload (same namespace as all reel
              // uploads; free-plan quota rejections raise the upgrade prompt inside the helper).
              onUploadSource={userId ? (file: File) => uploadDurableVideo(userId, file) : undefined}
            />
          ) : (
            <EmptyTimeline />
          )
        )}
      </div>

      {/* Add-reel card — docked at the bottom of the lane (like the Carousels slides strip), so it's
          out of the spotlight carousel flow and never pushes the active reel off-centre. Click-through
          outer that tracks the rail; the centred card captures clicks and is capped to the canvas region.
          Hidden while the reel video timeline is open — the timeline takes over the bottom strip. */}
      {!timelineStripShown && (
      <div className="fixed bottom-4 z-30 flex justify-center pointer-events-none" style={{ left: 'var(--rail-w, 0px)', right: 0 }}>
        {/* Cap the strip to the canvas region so it stays centred under the reel. */}
        <div className="pointer-events-auto" style={{ maxWidth: 'calc(100% - 20%)' }}>
          <SlidesStrip
            slides={entries.map(e => {
              const rs = recordingStateMap[e.id];
              return { id: e.id, name: reelNameMap[e.id] ?? '', progress: rs?.isRecording ? rs.recProgress : undefined };
            })}
            activeSlideId={selectedId}
            onSelect={setSelectedId}
            onAdd={() => { if (atReelCap) { setReelCapNotice(`You’ve hit the ${MAX_REELS}-reel limit — remove one to add another.`); return; } onAddRow(); }}
            // Renames land in the name map, which is an autosave-effect dep — so they persist onto the
            // reel's saved-grid row through the normal debounced save, no extra write path.
            onRename={(id, name) => setReelNameMap(prev => ({ ...prev, [id]: name }))}
            onDelete={onRemoveRow}
            onDuplicate={handleDuplicate}
            onReorder={() => {}}
            numbered
          />
        </div>
      </div>
      )}

      {/* Portals into <body>, so the wrapper's display:none (Sheet view) can't hide it — gate on active. */}
      {active && (
        <EditorScrollBar
          targetRef={scrollRef}
          zoom={fitFactor * viewScale}
          extent={Math.max(0, 1 - (viewScale - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN))}
          style={{ left: 'var(--rail-w, 0px)', right: 0 }}
        />
      )}

      {/* Bottom-left zoom box — hidden while the reel timeline is open (it would overlap the timeline). */}
      {!timelineStripShown && (
        <ZoomControl value={fitFactor * viewScale} min={fitFactor * ZOOM_MIN} max={fitFactor * ZOOM_MAX} resetTo={1} onChange={v => { captureFocal(); setViewScale(v / fitFactor); }} />
      )}
    </div>
  );
}
