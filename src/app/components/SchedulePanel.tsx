'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Avatar, Badge, Button, Modal, Textarea, SegmentedControl, Spinner, BrandLoader, Tooltip, HEADER_H } from '@/app/components/ui';
import { authedFetch } from '@/lib/authedFetch';
import { uploadRenderBlob } from '@/lib/renderUpload';
import { MAX_SCHEDULED_PER_ACCOUNT } from '@/lib/scheduleCadence';
import { supabase } from '@/lib/supabase';
import { ChevronDownIcon, TrashIcon } from '@/lib/icons';
import { DateTimePicker } from './DateTimePicker';
import { AccountPicker } from './SocialAccountPicker';
import { rowToSlide, type SlideRow } from './templateEditorRows';
import TemplateEditorCanvas, { CAROUSEL_PREVIEW_W, CAROUSEL_PREVIEW_H } from './TemplateEditorCanvas';
import type { TemplateEditorCanvasRef } from './templateEditorTypes';
import type { BrandProps, ScheduleReelDraft } from '@/app/types';
import { reelPostText } from '@/lib/reelPostText';

// Post → Instagram scheduling (Zernio-backed, fully white-label). A month calendar is the home view:
// the header carries the connected accounts + a Connect/Schedule button. Users connect their own
// Instagram in-app (headless OAuth: authorize on Instagram, pick a Page in our own modal — Zernio is
// never seen). Each user posts under their own Zernio profile (resolved server-side).

type ContentType = 'feed' | 'reels' | 'story';
type WhenMode = 'now' | 'schedule';
type Bucket = 'post-images' | 'post-videos';

// Each user may connect at most this many Instagram accounts. To add another past the cap they must
// disconnect one first (kept in sync with the server guard in /api/schedule/accounts).
const MAX_ACCOUNTS = 2;

// profileId mirrors the API payload: the live Zernio API returns it POPULATED as an object (see
// ZernioAccount in lib/zernio.ts); this component never reads it, the accounts route just passes it through.
interface Account { _id: string; platform: string; profileId: string | { _id: string; name?: string; slug?: string }; username: string; displayName: string; profilePicture?: string | null; isActive: boolean }
interface Post { _id: string; content?: string; status: 'draft' | 'scheduled' | 'published' | 'failed'; scheduledFor?: string; publishedAt?: string; mediaItems?: { type?: string; url: string }[] }
interface FacebookPage { id: string; name: string; username?: string; category?: string }
interface PagePicker { tempToken: string; connectToken?: string; userProfile: unknown; pages: FacebookPage[]; busy?: string }
// A saved carousel post and its slides — loaded straight from the same tables the carousel/Posts page
// uses (template_editor_posts + template_editor_post_slides), so the picker shows the user's real posts.
interface PostItem { id: string; name: string; slides: SlideRow[] }
// A saved reel (video_reels) — the numbers/strings to re-render it (link or uploaded videoUrl + framing +
// inherited template). Posted to Instagram as a baked MP4.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number) => String(n).padStart(2, '0');
// Downscale a rendered slide blob to a light JPEG data URL for AI vision grounding (same recipe
// as the template editor's captureCanvas — ≤640px wide, quality 0.7).
async function blobToGroundingJpeg(blob: Blob, maxW = 640): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxW / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return c.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
}

function toLocalInput(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dayKey(d: Date) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function isSameDay(a: Date, b: Date) { return dayKey(a) === dayKey(b); }

const STATUS_TONE: Record<Post['status'], 'accent' | 'success' | 'danger' | 'neutral'> = {
  scheduled: 'accent', published: 'success', failed: 'danger', draft: 'neutral',
};
// Rectangle styling per status in the week (time) view.
const STATUS_RECT: Record<Post['status'], string> = {
  scheduled: 'bg-info-tint text-info-text border-info-border',
  published: 'bg-success-tint text-success-text border-success-border',
  failed: 'bg-danger-tint text-danger-text border-danger-border',
  draft: 'bg-surface-3 text-fg-2 border-line',
};

type CalView = 'week' | 'month';

// ── Week (time-grid) geometry ───────────────────────────────────────────────────────────────────
// The whole day fits the viewport (no scroll), so positions are PERCENTAGES of the day height.
const POST_BLOCK_MIN = 45;                          // visual block length (overlap window), in minutes
const BLOCK_PCT = (POST_BLOCK_MIN / 1440) * 100;    // its height as a % of the full day
const pctOfDay = (min: number) => (min / 1440) * 100;

function startOfWeek(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()); }
function addDays(d: Date, n: number) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function minutesOfDay(d: Date) { return d.getHours() * 60 + d.getMinutes(); }

interface LaidOut { post: Post; startMin: number; col: number; ncols: number }

// Assign overlapping posts in a day to side-by-side columns (interval-graph packing), so two posts at
// the same time get squeezed next to each other rather than stacked on top of one another.
function layoutDay(items: { post: Post; date: Date }[]): LaidOut[] {
  const evs = items
    .map((it) => { const m = minutesOfDay(it.date); return { post: it.post, start: m, end: m + POST_BLOCK_MIN, col: 0 }; })
    .sort((a, b) => a.start - b.start);
  const out: LaidOut[] = [];
  let cluster: typeof evs = [];
  let clusterEnd = -1;
  const flush = () => {
    const colEnds: number[] = [];
    for (const e of cluster) {
      let placed = false;
      for (let c = 0; c < colEnds.length; c++) { if (colEnds[c] <= e.start) { colEnds[c] = e.end; e.col = c; placed = true; break; } }
      if (!placed) { e.col = colEnds.length; colEnds.push(e.end); }
    }
    for (const e of cluster) out.push({ post: e.post, startMin: e.start, col: e.col, ncols: colEnds.length });
    cluster = [];
  };
  for (const e of evs) {
    if (cluster.length && e.start >= clusterEnd) flush();
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  if (cluster.length) flush();
  return out;
}

export function SchedulePanel({ userId, brand, reelDraft, onReelDraftConsumed }: {
  userId: string | null;
  brand: BrandProps;
  // A finished reel MP4 handed off from the Reels canvas — when it arrives the composer auto-opens
  // in reels mode with it attached. onReelDraftConsumed clears it so it's a one-shot.
  reelDraft?: ScheduleReelDraft | null;
  onReelDraftConsumed?: () => void;
}) {
  const [view, setView] = useState<CalView>('week');
  const [cursor, setCursor] = useState(() => new Date()); // reference date for the shown week/month
  // Ticking "now" — drives the week view's now-line (updates each minute, so it drifts down slowly).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);

  const [composer, setComposer] = useState<{ open: boolean; mode: WhenMode; date: Date | null }>({ open: false, mode: 'now', date: null });
  const [detailPost, setDetailPost] = useState<Post | null>(null); // clicked scheduled post → preview/edit/cancel

  // A reel handed off from the canvas auto-opens the composer (publish-now default) with it attached.
  useEffect(() => {
    if (reelDraft) setComposer({ open: true, mode: 'now', date: null });
  }, [reelDraft]);

  // Connect flow
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [pagePicker, setPagePicker] = useState<PagePicker | null>(null);

  const loadAccounts = useCallback(async () => {
    setAccounts(null);
    try {
      const res = await authedFetch('/api/schedule/accounts');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to load accounts');
      setAccounts((json.accounts ?? []).filter((a: Account) => a.platform === 'instagram'));
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Failed to load accounts');
      setAccounts([]);
    }
  }, []);

  const loadPosts = useCallback(async () => {
    setPostsLoading(true);
    try {
      const res = await authedFetch('/api/schedule/posts');
      const json = await res.json();
      if (res.ok) setPosts(json.posts ?? []);
    } catch { /* calendar just shows fewer chips */ }
    setPostsLoading(false);
  }, []);

  useEffect(() => { void loadAccounts(); void loadPosts(); }, [loadAccounts, loadPosts]);

  // Disconnect one connected account (removed from Zernio; the row in social_profiles is dropped
  // server-side when it was the last one), then refresh the list.
  const removeAccount = useCallback(async (id: string) => {
    setConnectError(null);
    try {
      const res = await authedFetch(`/api/schedule/accounts?accountId=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'Failed to disconnect account');
      await loadAccounts();
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Failed to disconnect account');
    }
  }, [loadAccounts]);

  // Start a headless connect: redirect the browser to Instagram's OAuth screen.
  const startConnect = useCallback(async () => {
    setConnectError(null);
    setConnecting(true);
    try {
      const res = await authedFetch('/api/schedule/connect?platform=instagram');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to start connection');
      window.location.href = json.authUrl;
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Failed to start connection');
      setConnecting(false);
    }
  }, []);

  const openPagePicker = useCallback(async (tempToken: string, connectToken: string | undefined, userProfile: unknown) => {
    setConnectError(null);
    try {
      const qs = new URLSearchParams({ tempToken });
      if (connectToken) qs.set('connectToken', connectToken);
      const res = await authedFetch(`/api/schedule/connect/pages?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to list pages');
      setPagePicker({ tempToken, connectToken, userProfile, pages: json.pages ?? [] });
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Failed to finish connecting');
    }
  }, []);

  // Handle the OAuth return: Zernio appended its params to our redirect (the app root). Strip them so
  // a refresh can't replay, then finish (in-app page selection) or just reload the connected accounts.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const step = sp.get('step');
    const connected = sp.get('connected');
    const tempToken = sp.get('tempToken');
    if (!step && !connected && !tempToken) return;
    const connectToken = sp.get('connect_token') ?? undefined;
    const userProfileRaw = sp.get('userProfile');
    window.history.replaceState(null, '', window.location.pathname);
    if (step === 'select_page' && tempToken) {
      let userProfile: unknown;
      try { userProfile = userProfileRaw ? JSON.parse(userProfileRaw) : undefined; } catch { userProfile = undefined; }
      void openPagePicker(tempToken, connectToken, userProfile);
    } else if (connected || sp.get('accountId')) {
      void loadAccounts();
      void loadPosts();
    }
  }, [openPagePicker, loadAccounts, loadPosts]);

  async function confirmPage(pageId: string) {
    if (!pagePicker) return;
    setPagePicker({ ...pagePicker, busy: pageId });
    setConnectError(null);
    try {
      const res = await authedFetch('/api/schedule/connect/select-page', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId, tempToken: pagePicker.tempToken, connectToken: pagePicker.connectToken, userProfile: pagePicker.userProfile }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to connect account');
      setPagePicker(null);
      await loadAccounts();
      void loadPosts();
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Failed to connect account');
      setPagePicker((p) => (p ? { ...p, busy: undefined } : p));
    }
  }

  const byDay = useMemo(() => {
    const m = new Map<string, Post[]>();
    for (const p of posts) {
      const t = p.scheduledFor ?? p.publishedAt;
      if (!t) continue;
      const k = dayKey(new Date(t));
      const arr = m.get(k) ?? [];
      arr.push(p);
      m.set(k, arr);
    }
    return m;
  }, [posts]);

  const igAccounts = accounts ?? [];
  const weekDays = useMemo(() => { const s = startOfWeek(cursor); return Array.from({ length: 7 }, (_, i) => addDays(s, i)); }, [cursor]);
  const headerLabel = view === 'month'
    ? cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : `${weekDays[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${weekDays[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

  function shift(dir: -1 | 1) {
    setCursor((c) => (view === 'week' ? addDays(c, dir * 7) : new Date(c.getFullYear(), c.getMonth() + dir, 1)));
  }

  function openComposer(mode: WhenMode, date: Date | null) { setComposer({ open: true, mode, date }); }
  function onDayClick(d: Date) {
    if (igAccounts.length === 0) return;
    const at9 = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0);
    if (at9.getTime() < Date.now()) return; // past days are read-only
    openComposer('schedule', at9);
  }
  function onSlotClick(at: Date) {
    if (igAccounts.length === 0 || at.getTime() < Date.now()) return;
    openComposer('schedule', at);
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Header: month nav (left) · connected accounts + Connect/Schedule (right) */}
      <header className="shrink-0 flex items-center justify-between gap-3 px-6 border-b border-line" style={{ height: HEADER_H }}>
        <div className="flex items-center gap-3">
          <h1 className="text-title text-fg">Post</h1>
          <div className="flex items-center gap-1">
            <NavBtn label="Previous" onClick={() => shift(-1)} dir="left" />
            <button onClick={() => setCursor(new Date())} title="Jump to today" className="px-2.5 h-8 rounded-md text-label text-fg-2 hover:text-fg hover:bg-hover focus-ring min-w-[150px] text-center">
              {headerLabel}
            </button>
            <NavBtn label="Next" onClick={() => shift(1)} dir="right" />
          </div>
          <SegmentedControl<CalView>
            ariaLabel="Calendar view" emphasis="fill" size="sm"
            items={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]}
            value={view} onChange={setView}
          />
        </div>

        <div className="flex items-center gap-3">
          <HeaderAccounts accounts={accounts} max={MAX_ACCOUNTS} connecting={connecting} onConnect={startConnect} onRemove={removeAccount} />
          {igAccounts.length === 0 ? (
            <Button variant="primary" leadingIcon={<InstagramIcon />} onClick={startConnect} loading={connecting} disabled={accounts === null}>
              Connect Instagram
            </Button>
          ) : (
            <Button variant="primary" leadingIcon={<PlusIcon />} onClick={() => openComposer('now', null)}>Schedule post</Button>
          )}
        </div>
      </header>

      {connectError && <div className="px-6 pt-3"><Alert tone="danger">{connectError}</Alert></div>}

      {/* Calendar */}
      <div className="flex-1 min-h-0 flex flex-col px-6 py-4">
        <div className="flex-1 min-h-0">
          {view === 'week'
            ? <WeekView days={weekDays} posts={posts} now={now} onPostClick={setDetailPost} onSlotClick={onSlotClick} />
            : <MonthView cursor={cursor} now={now} byDay={byDay} igCount={igAccounts.length} onDayClick={onDayClick} onPostClick={setDetailPost} />}
        </div>
        {postsLoading && <p className="mt-2 text-caption text-fg-3 flex items-center gap-2"><Spinner size="sm" /> Loading scheduled posts…</p>}
      </div>

      {composer.open && (
        <Composer
          key={`${composer.mode}:${composer.date?.toISOString() ?? 'now'}:${reelDraft ? 'reel' : 'post'}`}
          accounts={igAccounts}
          userId={userId}
          brand={brand}
          initialMode={composer.mode}
          initialDate={composer.date}
          reelDraft={reelDraft ?? null}
          onClose={() => { setComposer((c) => ({ ...c, open: false })); onReelDraftConsumed?.(); }}
          onScheduled={() => { setComposer((c) => ({ ...c, open: false })); onReelDraftConsumed?.(); void loadPosts(); }}
        />
      )}

      {detailPost && (
        <PostDetail
          post={detailPost}
          onClose={() => setDetailPost(null)}
          onChanged={() => { setDetailPost(null); void loadPosts(); }}
        />
      )}

      {pagePicker && (
        <Modal
          open onClose={() => setPagePicker(null)} size="sm"
          title="Choose an account" description="Pick the Instagram account (Facebook Page) to connect."
          footer={<Button variant="ghost" onClick={() => setPagePicker(null)}>Cancel</Button>}
        >
          <div className="flex flex-col gap-2 py-1">
            {pagePicker.pages.length === 0 && (
              <p className="text-caption text-fg-3">No Pages with a connected Instagram account were found. Make sure your Instagram is a Business/Creator account linked to a Facebook Page.</p>
            )}
            {pagePicker.pages.map((pg) => (
              <button key={pg.id} onClick={() => confirmPage(pg.id)} disabled={!!pagePicker.busy}
                className="flex items-center justify-between gap-3 p-2.5 rounded-md border border-line hover:bg-hover focus-ring text-left disabled:opacity-50">
                <span className="flex items-center gap-2 min-w-0">
                  <Avatar fallback={(pg.name || '?').charAt(0)} size={28} />
                  <span className="min-w-0">
                    <span className="block text-label text-fg truncate">{pg.name}</span>
                    {pg.username && <span className="block text-caption text-fg-3 truncate">@{pg.username}</span>}
                  </span>
                </span>
                {pagePicker.busy === pg.id ? <Spinner size="sm" /> : <span className="text-caption text-accent">Connect</span>}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Composer modal ─────────────────────────────────────────────────────────────────────────────
function Composer({ accounts, userId, brand, initialMode, initialDate, reelDraft, onClose, onScheduled }: {
  accounts: Account[]; userId: string | null; brand: BrandProps; initialMode: WhenMode; initialDate: Date | null;
  // A finished reel MP4 handed off from the Reels canvas ("Schedule this reel"): reels are ephemeral,
  // so the scheduler no longer reconstructs them from the DB — it just posts this already-rendered blob.
  reelDraft: ScheduleReelDraft | null;
  onClose: () => void; onScheduled: () => void;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?._id ?? '');
  const [contentType, setContentType] = useState<ContentType>(reelDraft ? 'reels' : 'feed');
  // Seed the editable Instagram caption from reelPostText (the reel's description, falling back to the
  // on-video caption). Instagram has one text field, and the description IS that post caption. Fully
  // editable after. reelPostText handles a null draft (non-reel opens) → ''.
  const [caption, setCaption] = useState(reelPostText(reelDraft));
  const [when, setWhen] = useState<WhenMode>(initialMode);
  const [scheduledLocal, setScheduledLocal] = useState(() => toLocalInput(initialDate ?? new Date(Date.now() + 3600_000)));
  // Earliest schedulable slot, frozen when the composer opens; the picker forbids anything earlier. Floored
  // to the NEXT whole minute (seconds zeroed) so the earliest option is genuinely in the future. Otherwise
  // the very first slot equals a now-with-seconds and the live-clock submit guard would reject it.
  const scheduleMin = useMemo(() => { const d = new Date(); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1); return d; }, []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiCaptionBusy, setAiCaptionBusy] = useState(false);
  const [bestTimeBusy, setBestTimeBusy] = useState(false);
  // Selection epoch for the AI caption's async guards: bumped whenever the selected content (or
  // Type) changes, so a caption generated for Post A never fills the field while Post B is selected,
  // and the slide-capture loop aborts instead of mixing B's pixels under A's metadata.
  const selectionEpochRef = useRef(0);

  // The user's saved carousel posts — straight from the Posts tables (same source as the carousel page).
  const [posts, setPosts] = useState<PostItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0); // which slide the right-hand visualiser shows
  // Refs to the selected post's slide canvases (the thumbnail row) — exported to PNGs at schedule time.
  const slideRefs = useRef<(TemplateEditorCanvasRef | null)[]>([]);

  // Reels are ephemeral, so there's no saved-reel list to reconstruct: the reel arrives as a finished
  // MP4 blob from the canvas (reelDraft). Preview it via an object URL, revoked on unmount.
  const isReels = contentType === 'reels';
  // Object URL managed INSIDE an effect (create on run, revoke on cleanup) rather than useMemo +
  // revoke-on-unmount: React StrictMode double-invokes effects in dev, and the memoized URL survived
  // the first fake unmount already-revoked, so the <video> got a dead src and errored (the "preview
  // never loads" report). The effect re-run mints a fresh URL, so both dev and prod always get a live one.
  const [reelPreviewUrl, setReelPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!reelDraft) { setReelPreviewUrl(null); return; }
    const url = URL.createObjectURL(reelDraft.blob);
    setReelPreviewUrl(url);
    return () => { URL.revokeObjectURL(url); };
  }, [reelDraft]);
  // Preview decode failed (rare, browser-specific). Show a note instead of a silent black box; the reel is
  // already baked and still posts. Cleared whenever a new preview URL is created.
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => { setPreviewError(false); }, [reelPreviewUrl]);
  useEffect(() => { selectionEpochRef.current++; }, [selectedId, contentType]);

  const timezone = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
  }, []);

  // How many posts the picked account already has scheduled, read from pagination.total of a
  // limit-1 listing (one cheap call). Drives the per-account schedule cap below. null = unknown,
  // and unknown FAILS OPEN: a count hiccup must never block posting (the server re-checks anyway).
  const [scheduledCount, setScheduledCount] = useState<number | null>(null);
  useEffect(() => {
    setScheduledCount(null);
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(`/api/schedule/posts?status=scheduled&accountId=${encodeURIComponent(accountId)}&limit=1`);
        const json = await res.json().catch(() => ({}));
        const total = json?.pagination?.total;
        if (!cancelled && res.ok && typeof total === 'number') setScheduledCount(total);
      } catch { /* fail open */ }
    })();
    return () => { cancelled = true; };
  }, [accountId]);
  // Blocks only "Date & time" scheduling. Publish now is exempt from the cap by design.
  const scheduleCapReached = scheduledCount !== null && scheduledCount >= MAX_SCHEDULED_PER_ACCOUNT;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!userId) { setPosts([]); return; }
      const { data: postRows, error: pErr } = await supabase
        .from('template_editor_posts').select('id,name').eq('user_id', userId).order('position', { ascending: true });
      if (cancelled) return;
      if (pErr) { setError(pErr.message); setPosts([]); return; }
      const ids = (postRows ?? []).map((p) => p.id as string);
      if (ids.length === 0) { setPosts([]); return; }
      const { data: slideRows } = await supabase
        .from('template_editor_post_slides').select('*').in('post_id', ids).order('position', { ascending: true });
      if (cancelled) return;
      const byPost = new Map<string, SlideRow[]>();
      for (const row of (slideRows ?? []) as Record<string, unknown>[]) {
        const pid = row.post_id as string;
        const arr = byPost.get(pid) ?? [];
        arr.push(rowToSlide(row));
        byPost.set(pid, arr);
      }
      const items: PostItem[] = (postRows ?? [])
        .map((p) => ({ id: p.id as string, name: (p.name as string) || 'Untitled post', slides: byPost.get(p.id as string) ?? [] }))
        .filter((p) => p.slides.length > 0);
      setPosts(items);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const account = accounts.find((a) => a._id === accountId) ?? null;
  const selectedPost = posts?.find((p) => p.id === selectedId) ?? null;
  const canSubmit = !!account && (when === 'now' || !!scheduledLocal) && !submitting && !aiCaptionBusy
    && (isReels ? !!reelDraft : !!selectedPost)
    && !(when === 'schedule' && scheduleCapReached);

  function pickPost(p: PostItem) {
    slideRefs.current = [];
    setSelectedId(p.id);
    setActiveIdx(0);
    if (contentType === 'reels') setContentType('feed'); // carousels are feed posts
  }

  // AI caption writer — grounded in the REAL pixels: capture the selected post's slide canvases
  // (the same refs handleSubmit exports at schedule time), downscale, and let the model write the
  // caption from what will actually publish. Reels send text context only (their export is a full
  // MP4 bake — too heavy for a caption preview).
  async function writeCaption() {
    if (aiCaptionBusy || submitting || (isReels ? !reelDraft : !selectedPost)) return;
    const epoch = selectionEpochRef.current;
    setAiCaptionBusy(true);
    setError(null);
    try {
      const images: string[] = [];
      if (!isReels && selectedPost) {
        for (let i = 0; i < Math.min(4, selectedPost.slides.length); i++) {
          // exportBlob yields; if the user switched content mid-capture the live refs now render
          // the OTHER post's slides — abort rather than ground the caption in mixed pixels.
          if (selectionEpochRef.current !== epoch) throw new Error('Selection changed — try again.');
          const blob = await slideRefs.current[i]?.exportBlob();
          if (!blob) continue;
          const jpeg = await blobToGroundingJpeg(blob);
          if (jpeg) images.push(jpeg);
        }
      }
      const res = await authedFetch('/api/schedule/caption', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: images.length ? images : undefined,
          context: {
            kind: isReels ? 'reel' : 'post',
            name: isReels ? undefined : selectedPost?.name,
            existingCaption: caption.trim() || (isReels ? reelPostText(reelDraft) : undefined) || undefined,
            headlines: isReels ? undefined : selectedPost?.slides.map(s => s.headline).filter(Boolean).slice(0, 10),
            brandName: brand.displayName || undefined,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Caption generation failed');
      // The vision round-trip takes seconds — if the selection changed underneath, drop the result
      // instead of captioning the wrong content.
      if (selectionEpochRef.current !== epoch) throw new Error('Selection changed — the caption was written for the previous selection. Try again.');
      const tags = Array.isArray(json.hashtags) && json.hashtags.length
        ? `\n\n${json.hashtags.map((h: string) => `#${h}`).join(' ')}`
        : '';
      setCaption(`${json.caption}${tags}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Caption generation failed');
    }
    setAiCaptionBusy(false);
  }

  // "Best time" — the analytics route already computes engagement-ranked day/hour slots (UTC);
  // pick the top slot's next future occurrence and drop it into the schedule field. Slots use
  // Mon-first day_of_week (0 = Monday), matching the analytics heatmap.
  async function pickBestTime() {
    if (bestTimeBusy || !account) return;
    setBestTimeBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/api/schedule/analytics?accountId=${encodeURIComponent(account._id)}&days=90`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load your analytics');
      const slots = (json?.bestTime?.slots ?? []) as { day_of_week: number; hour: number; avg_engagement: number }[];
      if (slots.length === 0) throw new Error('No best-time data yet — it needs some posting history.');
      const ranked = [...slots].sort((a, b) => b.avg_engagement - a.avg_engagement);
      const minTime = Date.now() + 30 * 60_000;   // at least 30 min out
      for (const slot of ranked) {
        const jsDow = (slot.day_of_week + 1) % 7;   // Mon-first 0-6 → JS getUTCDay (0 = Sunday)
        const d = new Date();
        d.setUTCHours(slot.hour, 0, 0, 0);
        for (let add = 0; add <= 7; add++) {
          const candidate = new Date(d.getTime() + add * 86_400_000);
          if (candidate.getUTCDay() === jsDow && candidate.getTime() >= minTime) {
            setWhen('schedule');
            setScheduledLocal(toLocalInput(candidate));
            setBestTimeBusy(false);
            return;
          }
        }
      }
      throw new Error('Could not find an upcoming best-time slot.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not pick a best time');
      setBestTimeBusy(false);
    }
  }

  // Renders upload via the shared lib/renderUpload helper (the user's `_renders/` folder, throwaway
  // media that the cleanup cron sweeps), the same path the Reels Schedule All engine uses.

  async function postMedia(mediaItems: { type: 'image' | 'video'; url: string }[]): Promise<{ _id?: string } | null> {
    const res = await authedFetch('/api/schedule/post', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: account!._id,
        // Cap at Instagram's 2200-char limit (matches the bulk path). maxLength guards typing; this
        // also covers an AI-written caption, and trims on a code-point boundary so it never splits an
        // emoji surrogate pair.
        content: caption.length > 2200 ? [...caption].slice(0, 2200).join('') : caption,
        mediaItems,
        contentType,
        publishNow: when === 'now',
        scheduledFor: when === 'now' ? undefined : new Date(scheduledLocal).toISOString(),
        timezone,
        // FeedForce rewards sticker flag (reels only): included only when the editor sent a decision,
        // so ordinary posts — and non-enrolled members' reels — never carry the key.
        ...(reelDraft?.stickerEnabled !== undefined ? { stickerEnabled: reelDraft.stickerEnabled } : {}),
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Failed to schedule post');
    return (json.post ?? null) as { _id?: string } | null;
  }

  // Safety-net ledger BEFORE posting: if the tab dies mid-flight, the hourly cron still sweeps the
  // uploads. Once Zernio accepts the post, /api/schedule/post swaps these pending rows for rows keyed
  // by the real post id (with the real expiry) — the server owns success-path ledgering. Best-effort:
  // a ledger hiccup must not block posting (worst case the render lingers until a manual sweep).
  async function ledgerPending(stamp: number, uploaded: { bucket: Bucket; path: string }[]) {
    if (!userId || uploaded.length === 0) return;
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    try {
      await supabase.from('scheduled_render_media').insert(
        uploaded.map((u) => ({ user_id: userId, post_id: `pending_${stamp}`, bucket: u.bucket, path: u.path, expires_at: expiresAt })),
      );
    } catch { /* ignore */ }
  }

  // The post never went out → the uploads are dead weight; drop the files + their pending ledger rows.
  async function handleSubmit() {
    if (!account) return;
    if (isReels ? !reelDraft : !selectedPost) return;
    setError(null);
    if (when === 'schedule') {
      const t = Date.parse(scheduledLocal);
      if (Number.isNaN(t)) { setError('Pick a valid date & time.'); return; }
      if (t <= Date.now()) { setError('Schedule time must be in the future.'); return; }
    }
    setSubmitting(true);
    const stamp = Date.now();
    const uploaded: { bucket: Bucket; path: string }[] = [];
    try {
      if (isReels && reelDraft) {
        // The reel was already rendered on the canvas (crop + overlay + trim baked in). Just upload
        // the finished MP4 and post it — no reconstruction, no re-render.
        const up = await uploadRenderBlob(userId ?? '', 'post-videos', reelDraft.blob, `reel_${stamp}.mp4`, 'video/mp4');
        if (!up.ok) throw new Error(up.message);   // real reason (size cap / RLS / network), not a generic shrug
        uploaded.push({ bucket: up.bucket, path: up.path });
        await ledgerPending(stamp, uploaded);
        await postMedia([{ type: 'video', url: up.url }]);
      } else if (selectedPost) {
        // Render each previewed slide → PNG → upload → public URL.
        const urls: string[] = [];
        let lastUploadError: string | null = null;
        for (let i = 0; i < selectedPost.slides.length; i++) {
          const blob = await slideRefs.current[i]?.exportBlob();
          if (!blob) continue;
          const up = await uploadRenderBlob(userId ?? '', 'post-images', blob, `post_${selectedPost.id}_${stamp}_${i}.png`, 'image/png');
          if (up.ok) { urls.push(up.url); uploaded.push({ bucket: up.bucket, path: up.path }); }
          else lastUploadError = up.message;   // keep the real reason for the all-failed error below
        }
        if (urls.length === 0) throw new Error(lastUploadError ?? 'Could not render this post’s slides. Try reopening it.');
        await ledgerPending(stamp, uploaded);
        await postMedia(urls.map((url) => ({ type: 'image', url })));
      }
      // On success the SERVER ledgers the renders for cleanup (/api/schedule/post) — nothing to do here.
      onScheduled();
    } catch (e) {
      // Do NOT delete the uploads here: a "failure" can be a LOST RESPONSE on a request the server
      // actually completed (Zernio scheduled the post and ledgered these very files) — deleting them
      // would break that scheduled post at publish time. If the post truly never went out, the
      // pending ledger rows written above expire in 1h and the cleanup cron removes the files.
      setError(e instanceof Error ? e.message : 'Failed to schedule post');
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open onClose={onClose} size="xl" dismissOnBackdrop={false} variant="auth"
      title={when === 'now' ? 'Publish to Instagram' : 'Schedule Instagram post'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
            {when === 'now' ? 'Publish now' : 'Schedule'}
          </Button>
        </>
      }
    >
      {/* Two sister columns: the whole form (left) · the slide visualiser (right). */}
      <div className="flex gap-6 py-1">
        {/* LEFT — form */}
        <div className="w-[330px] shrink-0 flex flex-col gap-4">
          <AccountPicker accounts={accounts} value={accountId} onChange={setAccountId} />

          <div className="flex flex-col gap-1.5">
            <span className="text-label text-fg-2">Type</span>
            <SegmentedControl<ContentType>
              ariaLabel="Post type" emphasis="fill"
              items={[{ value: 'feed', label: 'Feed' }, { value: 'reels', label: 'Reel' }, { value: 'story', label: 'Story' }]}
              value={contentType} onChange={setContentType}
            />
          </div>

          {/* Selector — the handed-off reel when Type is "Reel", else saved carousel posts. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-label text-fg-2">{isReels ? 'Reel' : 'Post'}</span>
            <div className={`${isReels ? 'h-[112px]' : 'h-[168px]'} overflow-y-auto rounded-md border border-line bg-surface-1 p-2`}>
              {isReels ? (
                !reelDraft ? (
                  <div className="grid h-full place-items-center text-center px-3"><p className="text-caption text-fg-3">To schedule a reel, open <span className="text-fg-2">Reels</span>, make one, and press <span className="text-fg-2">Schedule</span>.</p></div>
                ) : (
                  <div className="flex items-center gap-2 rounded-md border border-fg ring-1 ring-fg px-2.5 py-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded bg-surface-2 text-caption text-fg-3">▶</span>
                    <span className="min-w-0 flex-1 truncate text-body text-fg-2">{reelPostText(reelDraft).trim() || 'Reel ready to schedule'}</span>
                    <Badge tone="accent">Ready</Badge>
                  </div>
                )
              ) : posts === null ? (
                <div className="grid h-full place-items-center"><BrandLoader size={36} /></div>
              ) : posts.length === 0 ? (
                <div className="grid h-full place-items-center text-center"><p className="text-caption text-fg-3">No posts yet. Create one in <span className="text-fg-2">Carousels</span> first.</p></div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {posts.map((p) => {
                    const isSel = p.id === selectedId;
                    return (
                      <button key={p.id} onClick={() => pickPost(p)} title={p.name}
                        className={`cursor-pointer rounded-md border overflow-hidden focus-ring ${isSel ? 'border-fg ring-1 ring-fg' : 'border-line hover:border-line-strong'}`}>
                        <SlidePreview slide={p.slides[0]} index={0} width={88} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Textarea label={isReels ? 'Description' : 'Caption'} rows={3} maxLength={2200} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={isReels ? 'Write a description…' : 'Write a caption…'} />
            {/* AI caption — writes from the selected content's rendered pixels (posts) or its
                details (reels); improves the current caption when one is already typed. */}
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => void writeCaption()}
                loading={aiCaptionBusy} disabled={isReels ? !reelDraft : !selectedPost}>
                <span className="brightness-0 invert mr-1" aria-hidden>✨</span>
                {caption.trim() ? 'Improve with AI' : 'Write with AI'}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-label text-fg-2">When</span>
            <SegmentedControl<WhenMode>
              ariaLabel="When to post" emphasis="fill"
              items={[{ value: 'now', label: 'Now' }, { value: 'schedule', label: 'Date & time' }]}
              value={when} onChange={setWhen}
            />
            {when === 'schedule' && (
              <>
                <DateTimePicker value={scheduledLocal} onChange={setScheduledLocal} min={scheduleMin} timezone={timezone} ariaLabel="Schedule date and time" />
                {/* Fill the field with the engagement-ranked best slot from this account's history. */}
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => void pickBestTime()} loading={bestTimeBusy} disabled={!account}>
                    Use my best time
                  </Button>
                </div>
                {scheduleCapReached && (
                  <Alert tone="warning">
                    This account already has {MAX_SCHEDULED_PER_ACCOUNT} scheduled posts (the maximum).
                    Publish now still works, or wait for a scheduled post to go out.
                  </Alert>
                )}
              </>
            )}
          </div>

          {error && <Alert tone="danger">{error}</Alert>}
        </div>

        {/* RIGHT — visualiser. Reels render live (and are baked to MP4 at schedule time); carousels show
            their slides. */}
        <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-3 rounded-lg border border-line bg-surface-1 p-4">
          {isReels ? (
            !reelDraft ? (
              <div className="grid flex-1 place-items-center text-caption text-fg-3 text-center px-4">Make a reel in the Reels workspace and press Schedule to bring it here.</div>
            ) : !reelPreviewUrl ? (
              // The object URL is minted in an effect one tick after mount; render nothing for that frame
              // instead of flashing the contradictory "Make a reel..." empty state next to a Ready reel.
              <div className="flex-1" />
            ) : previewError ? (
              <div className="grid flex-1 place-items-center text-caption text-fg-3 text-center px-4">Preview could not play in this browser, but the reel is rendered and will post normally.</div>
            ) : (
              // The finished MP4 exactly as it will post (overlay + crop + trim already baked in). autoPlay +
              // muted + preload="auto" so it loads and paints a frame immediately: a bare <video src={blob}>
              // defaults to preload="metadata" and can sit on an unpainted black poster (controls + 0:00 but
              // no picture) until you press play. onError surfaces a genuine decode failure instead of a
              // silent black box. The blob is already fast-start H.264 (mediabunny BufferTarget default).
              <video
                src={reelPreviewUrl}
                className="max-h-[420px] w-auto rounded-lg bg-black"
                controls
                loop
                muted
                autoPlay
                playsInline
                preload="auto"
                onError={() => setPreviewError(true)}
              />
            )
          ) : !selectedPost ? (
            <div className="grid flex-1 place-items-center text-caption text-fg-3">Select a post to preview its slides</div>
          ) : (
            <>
              <div className="flex-1 grid place-items-center min-h-0">
                <SlidePreview slide={selectedPost.slides[activeIdx] ?? selectedPost.slides[0]} index={activeIdx} width={288} />
              </div>
              {/* Slide selectors — also the canvases we export at schedule time (all mounted). p-1.5 so
                  the selected white ring isn't clipped by overflow-x-auto (which also clips vertically). */}
              <div className="flex gap-2 overflow-x-auto max-w-full p-1.5">
                {selectedPost.slides.map((s, i) => (
                  <button key={i} onClick={() => setActiveIdx(i)} aria-label={`Slide ${i + 1}`}
                    className={`shrink-0 cursor-pointer rounded-md overflow-hidden focus-ring ${i === activeIdx ? 'ring-2 ring-white' : 'ring-1 ring-line opacity-80 hover:opacity-100'}`}>
                    <SlidePreview slide={s} index={i} width={56} canvasRef={(el) => { slideRefs.current[i] = el; }} />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Static slide preview — the same TemplateEditorCanvas (staticMode) the editor/automations previews use,
// scaled to `width`. Pass canvasRef to capture it for PNG export at schedule time.
function SlidePreview({ slide, index, width, canvasRef }: {
  slide: SlideRow; index: number; width: number; canvasRef?: (el: TemplateEditorCanvasRef | null) => void;
}) {
  const scale = width / CAROUSEL_PREVIEW_W;
  return (
    <div className="overflow-hidden rounded-md ring-1 ring-line bg-surface-2 pointer-events-none" style={{ width, height: CAROUSEL_PREVIEW_H * scale }}>
      <div style={{ width: CAROUSEL_PREVIEW_W, height: CAROUSEL_PREVIEW_H, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <TemplateEditorCanvas
          ref={canvasRef}
          imageSrc=""
          headline={slide.headline}
          subheadline={slide.subheadline}
          settings={slide.settings}
          rectMode
          invertedSlots={index === 2}
          staticMode
          cleanView
        />
      </div>
    </div>
  );
}

// Live reel preview in the composer — resolves the video source (uploaded videoUrl, or the link via the
// same cache/queue the reels section uses), then renders the saved reel exactly (framing + template). The
// mounted TikTokCanvas is captured via canvasRef so the composer can bake it to MP4 at schedule time.
// ── Week (time-grid) view ────────────────────────────────────────────────────────────────────────
function WeekView({ days, posts, now, onPostClick, onSlotClick }: {
  days: Date[]; posts: Post[]; now: Date; onPostClick: (p: Post) => void; onSlotClick: (at: Date) => void;
}) {
  const byDay = useMemo(() => {
    const m = new Map<string, { post: Post; date: Date }[]>();
    for (const p of posts) {
      const t = p.scheduledFor ?? p.publishedAt;
      if (!t) continue;
      const d = new Date(t);
      const arr = m.get(dayKey(d)) ?? [];
      arr.push({ post: p, date: d });
      m.set(dayKey(d), arr);
    }
    return m;
  }, [posts]);

  const todayInWeek = days.some((d) => isSameDay(d, now));

  return (
    <div className="flex flex-col h-full rounded-lg border border-line overflow-hidden bg-surface-1">
      {/* Day headers */}
      <div className="flex shrink-0 border-b border-line">
        <div className="w-14 shrink-0" />
        {days.map((d) => {
          const isToday = isSameDay(d, now);
          return (
            <div key={d.toISOString()} className="flex-1 text-center py-2 border-l border-line">
              <div className="text-caption text-fg-3">{WEEKDAYS[d.getDay()]}</div>
              <div className={`mx-auto mt-0.5 inline-grid place-items-center size-7 rounded-full text-label tabular-nums ${isToday ? 'bg-action text-action-fg' : 'text-fg-2'}`}>{d.getDate()}</div>
            </div>
          );
        })}
      </div>
      {/* Time grid — fills the remaining height; the whole day is shown (no scroll). */}
      <div className="flex-1 min-h-0 flex">
        {/* Hour gutter — even hours only, HH:00 */}
        <div className="w-14 shrink-0 relative">
          {Array.from({ length: 24 }, (_, h) => (h === 0 || h % 2 !== 0 ? null : (
            <div key={h} className="absolute right-1.5 -translate-y-1/2 text-[10px] text-fg-4 tabular-nums" style={{ top: `${(h / 24) * 100}%` }}>
              {`${pad(h)}:00`}
            </div>
          )))}
        </div>
        {/* Day columns */}
        <div className="flex-1 relative flex">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="absolute left-0 right-0 border-t border-line/60" style={{ top: `${(h / 24) * 100}%` }} aria-hidden />
          ))}
          {todayInWeek && (
            <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: `${pctOfDay(minutesOfDay(now))}%` }}>
              <div className="relative h-px bg-danger">
                <span className="absolute -left-1 -top-[3px] size-1.5 rounded-full bg-danger" />
              </div>
            </div>
          )}
          {days.map((d) => {
            const laid = layoutDay(byDay.get(dayKey(d)) ?? []);
            return (
              <div key={d.toISOString()} className="flex-1 relative border-l border-line"
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const raw = ((e.clientY - rect.top) / rect.height) * 1440;
                  const min = Math.max(0, Math.min(1439, Math.round(raw / 15) * 15));
                  onSlotClick(new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(min / 60), min % 60));
                }}>
                {laid.map((it) => {
                  const t = it.post.scheduledFor ?? it.post.publishedAt;
                  const time = t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
                  return (
                    <button key={it.post._id}
                      onClick={(e) => { e.stopPropagation(); onPostClick(it.post); }}
                      title={it.post.content ? `${time} · ${it.post.content}` : time}
                      className={`absolute rounded-md border px-1 text-left overflow-hidden cursor-pointer leading-none ${STATUS_RECT[it.post.status]}`}
                      style={{ top: `${pctOfDay(it.startMin)}%`, height: `${BLOCK_PCT}%`, minHeight: 14, left: `calc(${(it.col / it.ncols) * 100}% + 2px)`, width: `calc(${100 / it.ncols}% - 4px)` }}>
                      <span className="block text-[10px] font-medium truncate">{time}{it.post.content ? ` · ${it.post.content}` : ''}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Month view ───────────────────────────────────────────────────────────────────────────────────
function MonthView({ cursor, now, byDay, igCount, onDayClick, onPostClick }: {
  cursor: Date; now: Date; byDay: Map<string, Post[]>; igCount: number; onDayClick: (d: Date) => void; onPostClick: (p: Post) => void;
}) {
  const grid = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [cursor]);

  return (
    <div className="h-full flex flex-col">
      <div className="grid grid-cols-7">
        {WEEKDAYS.map((d) => <div key={d} className="px-2 py-1 text-caption font-medium text-fg-3 select-none">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 grid-rows-6 gap-px bg-line rounded-lg overflow-hidden border border-line flex-1 min-h-0">
        {grid.map((d) => {
          const inMonth = d.getMonth() === cursor.getMonth();
          const isToday = isSameDay(d, now);
          const dayPosts = byDay.get(dayKey(d)) ?? [];
          const isPast = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59).getTime() < now.getTime();
          const clickable = !isPast && igCount > 0;
          return (
            <div key={d.toISOString()}
              onClick={() => { if (clickable) onDayClick(d); }}
              className={`min-h-0 overflow-hidden p-1.5 flex flex-col gap-1 transition-colors ${inMonth ? 'bg-surface-1' : 'bg-page'} ${clickable ? 'cursor-pointer hover:bg-hover' : ''} ${isPast ? 'opacity-55' : ''}`}>
              <span className={`inline-grid place-items-center size-6 rounded-full text-caption tabular-nums shrink-0 ${isToday ? 'bg-action text-action-fg' : inMonth ? 'text-fg-2' : 'text-fg-4'}`}>{d.getDate()}</span>
              <div className="flex flex-col gap-1 min-h-0 overflow-hidden">
                {dayPosts.slice(0, 3).map((p) => {
                  const t = p.scheduledFor ?? p.publishedAt;
                  const time = t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
                  return (
                    <button key={p._id} onClick={(e) => { e.stopPropagation(); onPostClick(p); }}
                      title={p.content ? `${time} · ${p.content}` : time}
                      className={`block w-full text-left rounded-md border px-1 py-0.5 overflow-hidden cursor-pointer leading-none ${STATUS_RECT[p.status]}`}>
                      <span className="block text-[10px] truncate">{time}{p.content ? ` · ${p.content}` : ''}</span>
                    </button>
                  );
                })}
                {dayPosts.length > 3 && <span className="text-caption text-fg-3 px-1">+{dayPosts.length - 3} more</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Post detail (preview · edit caption · cancel) ─────────────────────────────────────────────────
function PostDetail({ post, onClose, onChanged }: { post: Post; onClose: () => void; onChanged: () => void }) {
  const [caption, setCaption] = useState(post.content ?? '');
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = post.status === 'scheduled' || post.status === 'draft';
  const when = post.scheduledFor ?? post.publishedAt;
  const whenLabel = when ? new Date(when).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

  async function save() {
    setError(null); setSaving(true);
    try {
      const res = await authedFetch(`/api/schedule/post/${post._id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: caption }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to update post');
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to update post'); setSaving(false); }
  }

  async function cancelSchedule() {
    setError(null); setCancelling(true);
    try {
      const res = await authedFetch(`/api/schedule/post/${post._id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'Failed to cancel post');
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to cancel post'); setCancelling(false); }
  }

  return (
    <Modal
      open onClose={onClose} size="md" variant="auth"
      title={editable ? 'Edit scheduled post' : 'Post details'}
      footer={
        <div className="flex items-center justify-between w-full">
          {editable
            ? <Button variant="danger" onClick={cancelSchedule} loading={cancelling}>Cancel schedule</Button>
            : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Close</Button>
            {editable && <Button variant="primary" onClick={save} loading={saving} disabled={caption === (post.content ?? '')}>Save</Button>}
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3 py-1">
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[post.status]} dot>{post.status}</Badge>
          <span className="text-caption text-fg-3">{whenLabel}</span>
        </div>

        {/* Media preview — the images/video Zernio holds for this post (the public URLs we uploaded). */}
        {post.mediaItems && post.mediaItems.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-label text-fg-2">{post.mediaItems.length > 1 ? `${post.mediaItems.length} slides` : 'Media'}</span>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {post.mediaItems.map((m, i) => (
                <div key={i} className="shrink-0 w-[120px] aspect-[4/5] rounded-md border border-line overflow-hidden bg-surface-2">
                  {m.type === 'video'
                    ? <video src={m.url} controls className="w-full h-full object-cover" />
                    : <img src={m.url} alt={`Media ${i + 1}`} className="w-full h-full object-cover" />}
                </div>
              ))}
            </div>
          </div>
        )}

        <Textarea label="Caption" rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} disabled={!editable} />
        {error && <Alert tone="danger">{error}</Alert>}
        {!editable && <p className="text-caption text-fg-3">Published posts can’t be edited or cancelled here.</p>}
      </div>
    </Modal>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────────────────────────────────
// Connected-accounts control in the Post header. Styled like the Analytics account dropdown (avatar +
// @username + chevron); the open menu lists each connected account with a disconnect button, and a
// trailing "+" connects another — disabled once the user hits the MAX_ACCOUNTS cap.
function HeaderAccounts({ accounts, max, connecting, onConnect, onRemove }: {
  accounts: Account[] | null; max: number; connecting: boolean; onConnect: () => void; onRemove: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (accounts === null) return <Spinner size="sm" />;
  if (accounts.length === 0) return null; // empty state handled by the primary "Connect Instagram" button

  const atMax = accounts.length >= max;
  const primary = accounts[0];

  async function remove(id: string) {
    setBusy(id);
    await onRemove(id);
    setBusy(null);
  }

  return (
    <div className="flex items-center gap-1.5">
      <div ref={ref} className="relative">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
          className="h-9 min-w-[180px] flex items-center gap-2 px-2.5 rounded-md border border-line bg-surface-1 text-left focus-ring hover:border-line-strong">
          <Avatar src={primary.profilePicture} fallback={(primary.username || '?').charAt(0)} size={20} />
          <span className="flex-1 min-w-0 truncate text-body text-fg">@{primary.username}</span>
          {accounts.length > 1 && <span className="shrink-0 text-caption text-fg-3">+{accounts.length - 1}</span>}
          <ChevronDownIcon size={14} className={`shrink-0 text-fg-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </button>
        {open && (
          <div role="listbox" className="absolute right-0 z-dropdown mt-1 w-[260px] rounded-md border border-line bg-surface-3 shadow-2 p-1">
            {accounts.map((a) => (
              <div key={a._id} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-hover">
                <Avatar src={a.profilePicture} fallback={(a.username || '?').charAt(0)} size={24} />
                <span className="flex-1 min-w-0">
                  <span className="block text-body text-fg truncate">@{a.username}</span>
                  {a.displayName && <span className="block text-caption text-fg-3 truncate">{a.displayName}</span>}
                </span>
                <Tooltip content="Disconnect account" side="bottom">
                  <button onClick={() => void remove(a._id)} disabled={busy === a._id} aria-label={`Disconnect @${a.username}`}
                    className="shrink-0 grid place-items-center size-7 rounded-md text-fg-3 hover:text-danger-text hover:bg-danger-tint focus-ring disabled:opacity-50">
                    {busy === a._id ? <Spinner size="sm" /> : <TrashIcon size={15} />}
                  </button>
                </Tooltip>
              </div>
            ))}
            <p className="mt-0.5 border-t border-line px-2 pt-1.5 pb-0.5 text-caption text-fg-3">
              {accounts.length}/{max} connected{atMax ? ' · disconnect one to add another' : ''}
            </p>
          </div>
        )}
      </div>
      <Tooltip content={atMax ? `Max ${max} accounts — disconnect one to add another` : 'Connect another account'} side="bottom">
        <button onClick={onConnect} disabled={connecting || atMax} aria-label="Connect another account"
          className="grid place-items-center size-9 rounded-md border border-line text-fg-3 hover:text-fg hover:border-line-strong focus-ring disabled:opacity-40 disabled:cursor-not-allowed">
          <PlusIcon />
        </button>
      </Tooltip>
    </div>
  );
}

function NavBtn({ label, onClick, dir }: { label: string; onClick: () => void; dir: 'left' | 'right' }) {
  return (
    <button onClick={onClick} aria-label={label} className="grid place-items-center size-8 rounded-md text-fg-3 hover:text-fg hover:bg-hover focus-ring">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {dir === 'left' ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
      </svg>
    </button>
  );
}
function PlusIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>;
}
function InstagramIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="2" y="2" width="20" height="20" rx="5" /><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" /><line x1="17.5" y1="6.5" x2="17.51" y2="6.5" /></svg>;
}
