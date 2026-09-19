'use client';

import { useState, useRef, useEffect } from 'react';
import { authedFetch } from '@/lib/authedFetch';
import type { TikTokCanvasRef } from '../components/TikTokCanvas';
import type { VideoEntry, VideoData, VideoMode, ReelTextField } from '../types';
import { makeEmptyEntry, MAX_REELS } from '@/lib/entry';
import { getCachedVideo, setCachedVideo, enqueueVideoFetch } from '@/lib/reelVideoCache';
import { collectMediaRefs, cleanupMediaRefs } from '@/lib/mediaCleanup';
import { urlChangeInvalidatesVideo } from '@/lib/framingSource';

export function useVideoEntries() {
  const [entries, setEntries] = useState<VideoEntry[]>([makeEmptyEntry('1')]);
  const canvasRefsMap = useRef<Map<string, TikTokCanvasRef>>(new Map());

  // Always-current snapshot used inside async callbacks to avoid stale closures
  const entriesRef = useRef(entries);
  useEffect(() => { entriesRef.current = entries; }, [entries]);

  // Add a blank reel, capped at MAX_REELS. Guarded inside the updater too so no path can ever push the
  // grid past the cap (which the server trigger would reject, breaking the save). The UI disables the
  // add affordance at the cap; this is the safety net.
  function addRow() {
    setEntries(prev => (prev.length >= MAX_REELS ? prev : [...prev, makeEmptyEntry(Date.now().toString(), prev[0]?.mode ?? 'twitter')]));
  }

  function removeRow(id: string) {
    // Allow deleting any row, including the last — the grid tolerates zero entries (every entries[0]
    // access is guarded) and always shows the "add row" ghost card to recover. Previously this no-op'd
    // when only one row remained, so the Delete button silently did nothing on a single-reel workspace.
    const doomed = entriesRef.current.find(e => e.id === id);
    const remaining = entriesRef.current.filter(e => e.id !== id);
    setEntries(prev => prev.filter(e => e.id !== id));
    // GC the reel's stored clip + poster (post-videos / post-images) unless a duplicate row still shares
    // them. The reels jsonb save is debounced, so liveness is checked against the in-memory rows, not the
    // stale DB row.
    if (doomed?.videoUrl || doomed?.posterUrl) void cleanupMediaRefs(collectMediaRefs([doomed.videoUrl, doomed.posterUrl]), remaining);
  }

  // Duplicate a row: insert a copy (new id) right after the source. Returns the new id so the caller can
  // copy the id-keyed editor state (framing / template / settings) and select the duplicate — or null
  // when the grid is at the cap (nothing added, so the caller must not carry state to a phantom id).
  function duplicateRow(id: string): string | null {
    if (entriesRef.current.length >= MAX_REELS) return null;
    const newId = Date.now().toString();
    setEntries(prev => {
      if (prev.length >= MAX_REELS) return prev;
      const idx = prev.findIndex(e => e.id === id);
      if (idx < 0) return prev;
      const copy: VideoEntry = { ...prev[idx], id: newId };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    return newId;
  }

  function resetEverything() {
    setEntries([makeEmptyEntry('1')]);
  }

  // Delete EVERY reel: reset the grid to a single empty reel and GC all stored videos + posters. The
  // debounced save hasn't written the empty grid yet, so pass it as liveReels — cleanupMediaRefs then
  // sees no surviving reference and removes every reel's bucket files.
  function deleteAllReels() {
    const candidates = collectMediaRefs(entriesRef.current.flatMap(e => [e.videoUrl, e.posterUrl]));
    const fresh = makeEmptyEntry('1');
    setEntries([fresh]);
    if (candidates.size) void cleanupMediaRefs(candidates, [fresh]);
  }

  function handleVideoError(id: string) {
    setEntries(prev => prev.map(e => e.id === id ? { ...e, videoFailed: true } : e));
  }

  function setMode(id: string, mode: VideoMode) {
    setEntries(prev => prev.map(e => e.id === id ? { ...e, mode } : e));
  }

  function updateEntry(id: string, field: ReelTextField, value: string) {
    if (field === 'caption') {
      setEntries(prev => prev.map(e => e.id === id ? { ...e, caption: value } : e));
      return;
    }
    // Description is a plain per-field set like caption: it's the Instagram post caption / download
    // sidecar text and never touches the video pipeline, so it must NOT clear a fetched/stored clip.
    if (field === 'description') {
      setEntries(prev => prev.map(e => e.id === id ? { ...e, description: value } : e));
      return;
    }
    // field === 'url': a changed link invalidates the currently fetched/stored video. Clear the derived
    // state so the NEW link re-fetches and re-stores — a stored reel (videoUrl set) otherwise kept showing
    // the OLD video forever, because both auto-fetch and the ingest loop skip reels that already have a
    // videoUrl. Only fire when the reel actually had video state, so a fresh reel typing its first URL is
    // untouched. Mirrors updateLocalVideo's clear-and-GC for uploads. The predicate is shared with
    // CanvasGrid, which strips the row's time-domain framing on the same condition (framingSource.ts).
    const prev0 = entriesRef.current.find(e => e.id === id);
    const invalidates = urlChangeInvalidatesVideo(prev0, value);
    setEntries(prev => prev.map(e => {
      if (e.id !== id) return e;
      return invalidates
        ? { ...e, url: value, data: null, videoUrl: undefined, posterUrl: undefined, videoFailed: false }
        : { ...e, url: value };
    }));
    // Intentionally NO immediate GC of the old bucket file here: this runs per keystroke, so an eager delete
    // would irreversibly destroy the stored clip the moment the user touches the URL (and be unrecoverable on
    // undo). The now-unreferenced file becomes an orphan, reclaimed by the delete/replace GC paths — a small
    // storage cost that's the right trade for not deleting a live file mid-edit.
  }

  function updateLocalVideo(id: string, src: string, name: string) {
    // Clear any previously-stored bucket URL + poster: a changed/removed local file (or a link being
    // replaced by an upload) must be re-stored, so the persistence layer re-derives them from the new blob.
    const prev0 = entriesRef.current.find(e => e.id === id);
    const prevUrl = prev0?.videoUrl;
    const prevPoster = prev0?.posterUrl;
    setEntries(prev => prev.map(e =>
      e.id === id ? { ...e, localVideoSrc: src || undefined, localVideoName: name || undefined, videoUrl: undefined, posterUrl: undefined, data: null, error: '', videoFailed: false } : e
    ));
    // The replaced/removed clip's stored files are now unreferenced — GC them (in-memory rows are the
    // live state; the debounced reels save hasn't written the cleared URLs yet).
    if (prevUrl || prevPoster) {
      const remaining = entriesRef.current.map(e => (e.id === id ? { ...e, videoUrl: undefined, posterUrl: undefined } : e));
      void cleanupMediaRefs(collectMediaRefs([prevUrl, prevPoster]), remaining);
    }
  }

  async function fetchVideo(id: string) {
    const currentEntry = entriesRef.current.find(e => e.id === id);
    if (!currentEntry || !currentEntry.url.trim()) {
      setEntries(prev => prev.map(e => e.id === id ? { ...e, error: 'URL is required' } : e));
      return;
    }
    // A caption is NOT required to fetch a video — the link/upload comes first and the caption can be
    // added (or left empty) afterwards. Only the URL is needed here (the caption isn't sent to the API).
    const url = currentEntry.url.trim();

    // Cache hit → restore instantly with NO API call. This is what makes returning to the reels section
    // (after switching away) not re-hit the download API for already-fetched links.
    const cached = getCachedVideo(url);
    if (cached) {
      setEntries(prev => prev.map(e =>
        e.id === id ? { ...e, loading: false, error: '', data: cached, videoFailed: false } : e
      ));
      return;
    }

    setEntries(prev => prev.map(e =>
      e.id === id ? { ...e, loading: true, error: '', data: null, videoFailed: false } : e
    ));

    // Route through the shared rate-limited queue so many reels fetch one-by-one (≥1s apart) instead of
    // all at once and tripping the API's 1/sec limit.
    const result = await enqueueVideoFetch(url, async () => {
      // A hung request must NOT freeze the shared fetch queue: reelVideoCache.runQueue awaits this serially,
      // so one stalled /api/download (slow upstream, flaky network) otherwise left EVERY queued reel stuck
      // on "loading" forever. A client-side timeout guarantees it settles; AbortSignal.timeout covers both
      // the response and the body read.
      try {
        const res = await authedFetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(30_000),
        });
        return { ok: res.ok, json: await res.json() };
      } catch (e) {
        const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
        return { ok: false, json: { error: timedOut ? 'The download timed out — please try again.' : 'Network error — please try again.' } };
      }
    });

    // The reel may have been deleted or its URL changed while queued — drop a stale result.
    const latest = entriesRef.current.find(e => e.id === id);
    if (!latest || latest.url.trim() !== url) return;

    const json = result.json as { error?: string; play?: string; hdplay?: string; wmplay?: string; images?: string[] };

    // Hard failure: the route returned a non-2xx with an error message (bad/unsupported/private
    // link, upstream error, timeout, etc.). Surface it verbatim.
    if (!result.ok) {
      const errorMsg = typeof json.error === 'string' ? json.error : 'Something went wrong';
      setEntries(prev => prev.map(e =>
        e.id === id ? { ...e, loading: false, error: errorMsg, data: null, videoFailed: false } : e
      ));
      return;
    }

    // Soft failure: the route can return 200 with NO usable video — a TikTok photo slideshow, an
    // Instagram/X photo-only post, or an otherwise empty payload. Without this the card would sit
    // empty with no explanation; instead tell the user what went wrong.
    const hasVideo = !!(json.play || json.hdplay || json.wmplay);
    if (!hasVideo) {
      const errorMsg = (json.images && json.images.length > 0)
        ? 'That link is a photo post — there’s no video to fetch.'
        : 'Couldn’t fetch a video from that link. Make sure it’s a public TikTok, Instagram, or X post that has a video.';
      setEntries(prev => prev.map(e =>
        e.id === id ? { ...e, loading: false, error: errorMsg, data: null, videoFailed: false } : e
      ));
      return;
    }

    setCachedVideo(url, json as VideoData);   // cache for instant restore on the next visit
    setEntries(prev => prev.map(e =>
      e.id === id ? { ...e, loading: false, error: '', data: json as VideoEntry['data'], videoFailed: false } : e
    ));
  }

  async function fetchAllVideos() {
    // Caption optional here too — fetch every entry that has a URL and isn't already fetched/loading.
    const toFetch = entriesRef.current.filter(e => e.url.trim() && !e.data && !e.loading);
    for (const entry of toFetch) {
      await fetchVideo(entry.id);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // NOTE: "Download all" lives in CanvasGrid now — only the on-screen reel is mounted, so it must cycle the
  // selection to each reel before exporting (which this hook can't drive). A loop over canvasRefsMap here
  // would only ever find the displayed reel's ref.

  return {
    entries, setEntries, canvasRefsMap,
    addRow, removeRow, duplicateRow, resetEverything, deleteAllReels, updateEntry, updateLocalVideo, setMode, handleVideoError,
    fetchVideo, fetchAllVideos,
  };
}
