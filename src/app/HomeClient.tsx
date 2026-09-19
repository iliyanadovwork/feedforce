'use client';

import React, { lazy, Suspense, useEffect, useRef, useState, startTransition } from 'react';
import { useVideoEntries } from './hooks/useVideoEntries';
import { useBrandKit } from './hooks/useBrandKit';
import { useAuth } from './hooks/useAuth';
import { useStoredSessionHint } from './hooks/useStoredSessionHint';
import { useSubscription } from './hooks/useSubscription';
import { UpgradeModal, useCheckoutActivation, ActivationToast } from './components/UpgradeModal';
import { PlanProvider } from './components/PlanContext';
import { prefetchTwitterTemplates } from './hooks/useTwitterTemplates';
import { Sidebar } from './components/Sidebar';
import { HelpSupportWidget } from './components/HelpSupportWidget';
import { authedFetch } from '@/lib/authedFetch';
import { UPGRADE_REQUIRED_EVENT } from '@/lib/upgradePrompt';
import { FeedforceLanding } from '@/components/feedforce-landing';
import { BrandKitPanel } from './components/BrandKitPanel';
import { AccountPanel } from './components/AccountPanel';
import { CanvasGrid } from './components/CanvasGrid';
import { ReelSheet } from './components/ReelSheet';
import { makeEmptyEntry, MAX_REELS } from '@/lib/entry';
import { isUploadedVideoUrl } from '@/lib/sheetVideoUpload';
import type { SheetRow } from './hooks/useReelSheet';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ModeToggleIsland, RailIcons } from './components/ElementRail';
import { BrandLoader, RAIL_W_COLLAPSED, RAIL_VAR, LEFT_PANEL_W_CSS, RIGHT_PANEL_W_CSS } from './components/ui';
import type { AppSection, ScheduleReelDraft } from './types';
import { AUTOMATIONS_ENABLED } from '@/lib/featureFlags';

const AutomationsSection = lazy(() =>
  import('./components/AutomationsSection').then(m => ({ default: m.AutomationsSection }))
);

const SchedulePanel = lazy(() =>
  import('./components/SchedulePanel').then(m => ({ default: m.SchedulePanel }))
);

const AnalyticsSection = lazy(() =>
  import('./components/AnalyticsSection').then(m => ({ default: m.AnalyticsSection }))
);

const RewardsSection = lazy(() =>
  import('./components/RewardsSection').then(m => ({ default: m.RewardsSection }))
);

// Both template editors are lazy chunks. We keep their import factories so the Carousel⇄Reels
// toggle can PRELOAD the target chunk during the collapse animation (and the inactive one on idle),
// so the swap lands instantly instead of hitting the lazy fallback.
const importTemplateEditorGrid = () => import('./components/TemplateEditorGrid');
const importTwitterTemplateEditor = () => import('./components/TwitterTemplateEditor');
const TemplateEditorGrid = lazy(() => importTemplateEditorGrid().then(m => ({ default: m.TemplateEditorGrid })));
const TwitterTemplateEditor = lazy(() => importTwitterTemplateEditor().then(m => ({ default: m.TwitterTemplateEditor })));
const preloadEditor = (kind: 'carousel' | 'twitter') => {
  void (kind === 'carousel' ? importTemplateEditorGrid() : importTwitterTemplateEditor());
};

// A Suspense "gate" that overlaps the incoming editor's render with the rail-collapse animation.
// On an animated swap we bump a token and render the new editor inside a transition; this gate (keyed
// on that token) throws a promise that resolves after the collapse duration, so React renders the new
// editor OFF-SCREEN during the animation but holds the COMMIT until the rail finishes — then reveals
// it already-rendered. Token 0 is pre-seeded "done" so the first mount never suspends.
const collapseGateCache = new Map<number, { promise: Promise<void>; done: boolean }>([
  [0, { promise: Promise.resolve(), done: true }],
]);
function CollapseGate({ token, ms }: { token: number; ms: number }) {
  let g = collapseGateCache.get(token);
  if (!g) {
    const entry: { promise: Promise<void>; done: boolean } = { promise: Promise.resolve(), done: false };
    entry.promise = new Promise<void>(resolve => { window.setTimeout(() => { entry.done = true; resolve(); }, ms); });
    collapseGateCache.set(token, entry);
    g = entry;
  }
  if (!g.done) throw g.promise;
  return null;
}

function SectionLoader() {
  return (
    <div className="flex items-center justify-center h-full min-h-[200px]">
      <BrandLoader />
    </div>
  );
}

function GridSection({ children }: { children: React.ReactNode }) {
  // bg-dot-grid (globals.css) rather than the inline GRID_BG_STYLE: the light theme flips the
  // grid to faint black via a class override, which an inline style would defeat.
  return (
    <div className="flex flex-col h-screen bg-dot-grid">
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

// initialAuthHint comes from the server (the ff-auth presence cookie, read in page.tsx). It seeds
// the auth gate below so a returning user's FIRST server-rendered paint is the loader, not the
// marketing page — killing the logged-in refresh flash. Logged-out visitors and crawlers have no
// cookie, so they still get the real landing HTML from SSR (SEO intact).
export function HomeClient({ initialAuthHint }: { initialAuthHint: boolean }) {
  const [activeSection, setActiveSection] = useState<AppSection>('posts');
  const [templateEditorKind, setTemplateEditorKind] = useState<'carousel' | 'twitter'>('carousel');
  // The toggle highlights kindIntent (set immediately on click); templateEditorKind — the editor
  // actually rendered — lags behind during the Carousel→Reels collapse. So the green selection
  // snaps to the clicked icon instantly while the rail collapse plays as the transition.
  const [kindIntent, setKindIntent] = useState<'carousel' | 'twitter'>('carousel');
  // Carousel⇄Reels rail transition. BOTH directions collapse the OUTGOING rail's middle island down
  // to its seam first (the shared brand logo, or 0 when there are no logos), THEN swap — the INCOMING
  // rail's ElementRail enters from that same seam and grows to its own height. Because the seam (the
  // logo row) is geometrically identical in both rails, any item count hands off to any other
  // (5→1, 5→3, 2→3, 1→5, 5→0, 0→5 …) with no jump, no close-to-nothing, and no reopen.
  const [railCollapsing, setRailCollapsing] = useState(false);
  // Bumped on each animated swap; the CollapseGate keyed on it holds the commit for the collapse
  // duration, so the incoming editor renders off-screen DURING the animation and reveals when it ends.
  const [transitionToken, setTransitionToken] = useState(0);
  // Rail collapse/expand duration — drives BOTH the CSS height transition (via the --rail-dur var)
  // and the CollapseGate hold, so they stay in lockstep.
  const railDurMs = 360;
  useEffect(() => { document.documentElement.style.setProperty('--rail-dur', `${railDurMs}ms`); }, [railDurMs]);
  const switchEditorKind = (next: 'carousel' | 'twitter') => {
    if (next === kindIntent) return;
    preloadEditor(next);                             // warm the target chunk
    if (next === 'twitter') prefetchTwitterTemplates(user?.id ?? null);  // …and the Reels template data
    setKindIntent(next);                             // highlight the clicked icon immediately
    const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      setRailCollapsing(true);                       // outgoing rail collapses now (CSS, --rail-dur)
      // Render the incoming editor immediately, in a transition so React renders it OFF-SCREEN while
      // the rail collapses. Bumping transitionToken inside the transition arms the CollapseGate, which
      // holds the COMMIT for --rail-dur — so the heavy render overlaps the animation and reveals right
      // when the rail finishes. (Token bumped INSIDE the transition so the still-visible editor stays
      // on the old, already-resolved token and never suspends → no fallback flash.)
      startTransition(() => {
        setTransitionToken(t => t + 1);
        setTemplateEditorKind(next);
        setRailCollapsing(false);
      });
    } else {
      startTransition(() => {
        setRailCollapsing(false);
        setTemplateEditorKind(next);
      });
    }
  };
  const { user, loading: authLoading, signIn, signUp, signOut, resetPassword, changePassword } = useAuth();
  const storedSessionHint = useStoredSessionHint();
  // Free tier (FREE_TIER_PLAN.md): no subscription = the free plan. Free users get the working
  // studio; Pro-only sections/features gate contextually via the UpgradeModal below.
  const { plan, loading: subLoading, refresh: refreshSubscription } = useSubscription(user?.id ?? null);
  // Contextual upgrade prompt — set to a one-line reason to open, null to close.
  const [upgradeReason, setUpgradeReason] = useState<string | null>(null);
  // Poll for the webhook after the provider redirects back with ?checkout=success;
  // plan flipping to 'pro' is the success signal that dismisses the pill.
  const activation = useCheckoutActivation(refreshSubscription, plan === 'pro', user?.id ?? null);
  // Catch-all: any API route answering 403 subscription_required pops the upgrade modal
  // (event fired by authedFetch), so Pro fetches deep in the tree need no wiring of their own.
  useEffect(() => {
    const onUpgradeRequired = (e: Event) =>
      setUpgradeReason((e as CustomEvent<{ reason?: string }>).detail?.reason ?? 'This feature needs a Pro subscription.');
    window.addEventListener(UPGRADE_REQUIRED_EVENT, onUpgradeRequired);
    return () => window.removeEventListener(UPGRADE_REQUIRED_EVENT, onUpgradeRequired);
  }, []);
  const { brand, setBrand, saving, uploading, loading, error, setError, save, uploadLogo, deleteLogo, selectLogo, uploadFont, deleteFont, saveColors } = useBrandKit(user?.id ?? null);

  // Admin-only Support-inbox link (the inbox itself lives in /admin) + its needs-reply badge.
  // Whether this account is an admin is decided server-side (ADMIN_EMAILS); the count call doubles
  // as the probe. Polled every 30s + on window focus so an admin working in the app notices new
  // user messages; a 401/403 means "not an admin" and the remaining ticks no-op. State is keyed by
  // user id so switching accounts needs no reset — a stale entry simply stops matching.
  const [supportState, setSupportState] = useState<{ uid: string; needsReply: number } | null>(null);
  useEffect(() => {
    const uid = user?.id;
    if (!uid) return;
    let cancelled = false;
    let stopped = false;   // flipped on 401/403 — not an admin, stop asking for this account
    const poll = async () => {
      if (stopped) return;
      try {
        const r = await authedFetch('/api/support/inbox?count=1');
        if (cancelled || stopped) return;
        if (r.status === 401 || r.status === 403) { stopped = true; return; }
        if (!r.ok) return;   // transient server error — keep the last good state
        const j = await r.json().catch(() => null) as { needsReply?: number } | null;
        if (!cancelled && j) setSupportState({ uid, needsReply: j.needsReply ?? 0 });
      } catch { /* transient network error — keep polling */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 30_000);
    const onFocus = () => { if (!cancelled) void poll(); };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [user?.id]);
  const showSupportInbox = !!user && supportState?.uid === user.id;
  const supportNeedsReply = showSupportInbox && supportState ? supportState.needsReply : 0;
  // Admin accounts ride free (FREE_TIER_PLAN.md): the inbox probe above doubles as the admin
  // signal, so admins get Pro chrome even before their comp subscription row self-provisions
  // (the probe's server side inserts it — see ensureAdminComp). Checkout activation stays on the
  // real plan: it tracks an actual purchase, which admin status doesn't change.
  const effectivePlan: 'free' | 'pro' = showSupportInbox ? 'pro' : plan;
  // Preload the INACTIVE editor in the background (after the section/kind settles) so the first
  // toggle is instant: warm its chunk AND, for Reels, its template data — so the first open of Reels
  // after a refresh skips the loading spinner too. The on-click preload covers fast switches.
  useEffect(() => {
    if (activeSection !== 'template-editor') return;
    const other = templateEditorKind === 'carousel' ? 'twitter' : 'carousel';
    const id = window.setTimeout(() => {
      preloadEditor(other);
      if (other === 'twitter') prefetchTwitterTemplates(user?.id ?? null);
    }, 500);
    return () => window.clearTimeout(id);
  }, [activeSection, templateEditorKind, user?.id]);

  const {
    entries, setEntries, canvasRefsMap,
    addRow, removeRow, duplicateRow, deleteAllReels, updateEntry, updateLocalVideo,
    handleVideoError, fetchVideo,
  } = useVideoEntries();

  // Reels section view: the canvas workspace or the Content Sheet backlog (see ReelSheet).
  // Restored across reloads like the section/editor kind above.
  const REELS_VIEW_KEY = 'de:reels-view';
  const [reelsView, setReelsView] = useState<'canvas' | 'sheet'>(() => {
    if (typeof window === 'undefined') return 'canvas';
    return localStorage.getItem(REELS_VIEW_KEY) === 'sheet' ? 'sheet' : 'canvas';
  });
  useEffect(() => {
    try { localStorage.setItem(REELS_VIEW_KEY, reelsView); } catch { /* ignore */ }
  }, [reelsView]);

  // Sheet rows → reel entries. The new ids are fetch-queued via the effect below (fetchVideo reads
  // an entries snapshot ref that only updates after commit, so fetching in the same tick would miss
  // them); enqueueVideoFetch then paces the actual /api/download calls. Flip to the canvas so the
  // strip filling up is the visible payoff.
  const pendingSheetFetches = useRef<string[]>([]);
  // Which user's saved grid the mount-time restore has applied this page-load. Derived `reelsRestored`
  // is true ONLY for the currently signed-in user — so a same-tab account switch (the studio unmounts on
  // sign-out but HomeClient stays mounted, keeping this state) can't leave it stale-true and make
  // CanvasGrid skip the new user's restore and autosave the previous user's reels into their row. It
  // gates the sheet's Send button (append-after-restore) and CanvasGrid's nav-back restore guard.
  const [restoredForUser, setRestoredForUser] = useState<string | null>(null);
  const reelsRestored = restoredForUser !== null && restoredForUser === (user?.id ?? null);
  // Transient notice when a "send to reels" was capped by MAX_REELS.
  const [reelSendNotice, setReelSendNotice] = useState<string | null>(null);
  const sendSheetRowsToReels = (rows: SheetRow[]) => {
    // Only take as many as fit under the reel cap — appending past it would make the grid's autosave
    // upsert get rejected by the server trigger (a broken save). Fill to the cap, tell the user what
    // didn't fit. `entries.length` is settled at click time, so it's an accurate count of room left.
    const room = Math.max(0, MAX_REELS - entries.length);
    const accepted = rows.slice(0, room);
    const dropped = rows.length - accepted.length;
    if (accepted.length === 0) {
      setReelSendNotice(`Your reels are at the ${MAX_REELS} limit — remove some before sending more.`);
      setReelsView('canvas');
      return;
    }
    const base = Date.now();
    const created = accepted.map((r, i) => {
      const link = r.link.trim();
      // The download API needs a protocol; sheets are full of bare www. links.
      const url = /^www\./i.test(link) ? `https://${link}` : link;
      // A sheet-uploaded video (the row's Upload button → our post-videos URL) is already durable:
      // it becomes the entry's stored videoUrl — played straight from the bucket, the same shape as
      // a restored uploaded reel — NOT a link for /api/download, which only speaks social URLs.
      const uploaded = isUploadedVideoUrl(url);
      return {
        // The '-s' suffix keeps these ids out of addRow/duplicateRow's plain Date.now() namespace.
        ...makeEmptyEntry(`${base}-s${i}`, entries[0]?.mode ?? 'twitter'),
        url: uploaded ? '' : url,
        videoUrl: uploaded ? url : undefined,
        caption: r.caption,
        // The sheet's description rides along to the reel: it becomes the Instagram post caption
        // (schedule) / a sidecar .txt (download). Previously dropped on send-to-reels.
        description: r.description,
      };
    });
    // Append to the current canvas (the reels persist), so sending adds to your existing reels.
    // Uploaded rows have nothing to fetch — their video is already in the bucket.
    pendingSheetFetches.current.push(...created.filter(e => !e.videoUrl).map(e => e.id));
    setEntries(prev => [...prev, ...created]);
    setReelsView('canvas');
    setReelSendNotice(dropped > 0
      ? `Added ${accepted.length}; ${dropped} didn’t fit (${MAX_REELS}-reel limit).`
      : null);
  };
  useEffect(() => {
    if (pendingSheetFetches.current.length === 0) return;
    const ready = pendingSheetFetches.current.filter(id => entries.some(e => e.id === id));
    if (ready.length === 0) return;
    pendingSheetFetches.current = pendingSheetFetches.current.filter(id => !ready.includes(id));
    ready.forEach(id => void fetchVideo(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // "Schedule this reel" (canvas): reels are ephemeral, so instead of the scheduler reading a saved
  // reel, the canvas exports the finished MP4 and hands it here; we open the Post section with it
  // attached. One-shot — cleared once the composer consumes it.
  const [scheduleReelDraft, setScheduleReelDraft] = useState<ScheduleReelDraft | null>(null);
  const scheduleReel = (draft: ScheduleReelDraft) => {
    setScheduleReelDraft(draft);
    setActiveSection('schedule');
  };

  // Skip persisting the section on the initial mount so we don't clobber the
  // restored value with the default before restore runs.
  const skipSectionPersist = useRef(true);
  const SECTION_KEY = 'de:active-section';
  const skipKindPersist = useRef(true);
  const KIND_KEY = 'de:editor-kind';
  // A stale saved section (e.g. a since-removed page) falls through to the default ('posts').
  const RESTORABLE: AppSection[] = ['posts', 'branding', 'template-editor', 'schedule', 'analytics', 'video-reels', 'rewards', 'account'];

  useEffect(() => {
    // Returning from a social-connect OAuth flow? The provider redirects to the app root with its own
    // params (step/connected/tempToken) appended — open the Post screen so SchedulePanel finishes it.
    const q = new URLSearchParams(window.location.search);
    if (q.has('step') || q.has('connected') || q.has('tempToken')) {
      const t = setTimeout(() => setActiveSection('schedule'), 0);
      return () => clearTimeout(t);
    }
    // Restore the section the user last had open. Deferred a tick so we don't
    // setState synchronously inside the effect body.
    const saved = localStorage.getItem(SECTION_KEY) as AppSection | null;
    const savedKind = localStorage.getItem(KIND_KEY);
    if (saved && RESTORABLE.includes(saved)) {
      const t = setTimeout(() => {
        setActiveSection(saved);
        // Reopen the same editor kind (Carousel/Reels) the user last had — set together with the
        // section so the editor renders straight into the right one (no Carousel→Reels flash).
        if (savedKind === 'carousel' || savedKind === 'twitter') { setTemplateEditorKind(savedKind); setKindIntent(savedKind); }
      }, 0);
      return () => clearTimeout(t);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the active section so a reload returns the user where they were.
  useEffect(() => {
    if (skipSectionPersist.current) { skipSectionPersist.current = false; return; }
    localStorage.setItem(SECTION_KEY, activeSection);
  }, [activeSection]);

  // Persist the editor kind (Carousel/Reels) so a reload reopens the same one (restored above).
  useEffect(() => {
    if (skipKindPersist.current) { skipKindPersist.current = false; return; }
    try { localStorage.setItem(KIND_KEY, templateEditorKind); } catch { /* ignore */ }
  }, [templateEditorKind]);

  // Mirror the sidebar width onto the document root as --rail-w so EVERY consumer can read it —
  // including the EditorScrollBar, which portals into <body> and so can't inherit a var scoped to
  // the app wrapper. The rail is collapsed-by-default and expands on hover as a fixed OVERLAY, so we
  // pin --rail-w at the collapsed width: the page layout reserves only the icon rail and never
  // reflows when the sidebar slides open over it.
  useEffect(() => {
    document.documentElement.style.setProperty('--rail-w', `${RAIL_W_COLLAPSED}px`);
  }, []);

  // Auth gate: the studio (and its sidebar) only render once a session exists.
  // Logged-out users land on the marketing homepage; auth happens through its CTAs.
  // While the session check runs, only visitors who are probably signed in get the loader:
  // the server-read cookie hint (covers the very first SSR paint → no landing flash on refresh)
  // OR the client-read localStorage token hint (post-hydration accuracy). Everyone else —
  // including crawlers, which send no cookie — gets the real landing HTML from SSR (SEO intact).
  if (authLoading && (initialAuthHint || storedSessionHint)) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-page text-fg">
        <BrandLoader size={64} />
      </div>
    );
  }

  if (!user) {
    return (
      <FeedforceLanding onSignIn={signIn} onSignUp={signUp} onResetPassword={resetPassword} />
    );
  }

  // Wait for the subscription row before rendering: `plan` is meaningless while loading, and
  // flashing free-tier chrome at a subscriber (or vice versa) would be worse than the spinner.
  if (subLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-page text-fg">
        <BrandLoader size={64} />
      </div>
    );
  }

  // Pro-only sections render an upgrade gate instead of their panel for free users. Checked at
  // render (not just hidden in the sidebar) so deep entry — e.g. a restored localStorage section
  // from a lapsed subscription — gates too. The API routes behind these 403 for free users anyway.
  const sectionLocked = effectivePlan === 'free' && (['schedule', 'analytics', 'automations', 'rewards'] as AppSection[]).includes(activeSection);

  // Template-type switch (Carousel ↔ Reels) as a compact icon island, matching the
  // rail / undo-redo islands. Both editors slot it on top of their element rail (via topIsland).
  // NB: the underlying kind value is still 'twitter' — only the label/icon are rebranded to Reels.
  const kindToggle = (
    <ModeToggleIsland
      value={kindIntent}
      onChange={switchEditorKind}
      options={[
        { value: 'carousel', label: 'Carousel', icon: RailIcons.carousel },
        { value: 'twitter', label: 'Reels', icon: RailIcons.reels },
      ]}
    />
  );

  return (
    <PlanProvider value={{ plan: effectivePlan, openUpgrade: setUpgradeReason }}>
    <div className="flex min-h-screen bg-page text-fg">
      {upgradeReason && <UpgradeModal reason={upgradeReason} email={user.email} onClose={() => setUpgradeReason(null)} onSubscribed={() => { void refreshSubscription(); setUpgradeReason(null); }} />}
      <ActivationToast state={activation} />
      {reelSendNotice && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[1200] flex items-center gap-3 rounded-full border border-line bg-surface-1 px-4 py-2 shadow-2">
          <span className="text-caption text-fg">{reelSendNotice}</span>
          <button type="button" onClick={() => setReelSendNotice(null)} aria-label="Dismiss" className="text-fg-4 hover:text-fg focus-ring rounded-xs">×</button>
        </div>
      )}

      {/* Floating Intercom-style help launcher — bottom-right, pops the support panel up above it
          and above the upgrade modal (z 1150 > 1000), so users mid-upgrade can still message
          support — they're exactly the ones with billing questions. Keyed by user id so an account
          switch remounts it fresh — thread, draft and the local last-read mark are all per-account
          state that must never leak across users. */}
      {user && <HelpSupportWidget key={user.id} userId={user.id} email={user.email ?? null} />}

      <div className="contents">
      <Sidebar
        active={activeSection}
        onSelect={setActiveSection}
        signedIn={!!user}
        email={user.email}
        supportAdmin={showSupportInbox}
        supportNeedsReply={supportNeedsReply}
      />

      {/* main: min-w-0 lets this flex child shrink below the zoomed canvas's intrinsic width
          (default min-width:auto would push the page wider than the viewport → a window-level
          horizontal scrollbar). [overflow-x:clip] clips residual sideways overflow without making
          a scroll container (overflow-y stays visible) and without clipping the fixed rail/panels. */}
      <main
        className="flex-1 min-w-0 [overflow-x:clip] min-h-screen transition-[margin-left] duration-[var(--dur-spatial)] ease-[var(--ease-emphasized)]"
        style={{ marginLeft: RAIL_VAR, ['--left-panel' as string]: LEFT_PANEL_W_CSS, ['--right-panel' as string]: RIGHT_PANEL_W_CSS }}
      >

        {activeSection === 'branding' && (
          <BrandKitPanel
            brand={brand}
            loading={loading}
            saving={saving}
            uploading={uploading}
            error={error}
            user={user}
            authLoading={authLoading}
            onSignIn={signIn}
            onSignUp={signUp}
            onResetPassword={resetPassword}
            onSave={save}
            onUploadLogo={uploadLogo}
            onDeleteLogo={deleteLogo}
            onSelectLogo={selectLogo}
            onUploadFont={uploadFont}
            onDeleteFont={deleteFont}
            onSaveColors={saveColors}
            onClearError={() => setError(null)}
          />
        )}

        {activeSection === 'account' && (
          <AccountPanel user={user} onChangePassword={changePassword} onSignOut={signOut} />
        )}

        {AUTOMATIONS_ENABLED && activeSection === 'automations' && !sectionLocked && (
          <ErrorBoundary>
            <Suspense fallback={<SectionLoader />}>
              <AutomationsSection userId={user?.id ?? null} />
            </Suspense>
          </ErrorBoundary>
        )}

        {activeSection === 'template-editor' && (
          <ErrorBoundary>
            <GridSection>
              <div className="relative h-full">
                {/* Template-type switch, now an island. Both editors take it as topIsland so it
                    stacks on top of their element rail (Carousel and Reels share the same rail). */}
                {/* ONE shared Suspense boundary around both editors. When startTransition swaps them,
                    the boundary already has the current editor revealed, so React holds it until the
                    incoming one resolves — no fallback spinner. (Separate per-branch boundaries each
                    mount fresh, which is why the spinner still flashed before.) */}
                <Suspense fallback={<SectionLoader />}>
                  {templateEditorKind === 'carousel' ? (
                    <TemplateEditorGrid brand={brand} userId={user?.id ?? null} topIsland={kindToggle} collapseMiddle={railCollapsing} onCreate={() => setActiveSection('posts')} />
                  ) : (
                    <TwitterTemplateEditor brand={brand} userId={user?.id ?? null} topIsland={kindToggle} collapseMiddle={railCollapsing} onCreate={() => setActiveSection('video-reels')} />
                  )}
                  {/* Holds the swap's commit until the rail collapse ends, so the editor above renders
                      off-screen DURING the animation and reveals already-rendered. */}
                  <CollapseGate token={transitionToken} ms={railDurMs} />
                </Suspense>
              </div>
            </GridSection>
          </ErrorBoundary>
        )}

        {activeSection === 'posts' && (
          <ErrorBoundary>
            <GridSection>
              <Suspense fallback={<SectionLoader />}>
                <TemplateEditorGrid brand={brand} userId={user?.id ?? null} mode="posts" onGoToTemplateEditor={() => { setTemplateEditorKind('carousel'); setKindIntent('carousel'); setActiveSection('template-editor'); }} />
              </Suspense>
            </GridSection>
          </ErrorBoundary>
        )}

        {activeSection === 'video-reels' && (
          <ErrorBoundary>
            <GridSection>
              {/* Video-reel workspace: paste TikTok / Instagram / X links, brand each into a
                  1080×1920 Twitter/Caption overlay, and export MP4s. The Sheet view is the
                  persistent backlog feeding it (links + captions, block-pasted from any
                  spreadsheet); Send to Reels turns rows into strip entries. */}
              {(() => {
                const reelsViewToggle = (
                  <div className="flex items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5" role="tablist" aria-label="Reels view">
                    {(['canvas', 'sheet'] as const).map(v => (
                      <button
                        key={v}
                        role="tab"
                        aria-selected={reelsView === v}
                        onClick={() => setReelsView(v)}
                        className={`px-2.5 py-1 rounded-md text-caption font-medium transition-colors focus-ring ${
                          reelsView === v ? 'bg-active text-fg' : 'text-fg-3 hover:text-fg'
                        }`}
                      >
                        {v === 'canvas' ? 'Canvas' : 'Sheet'}
                      </button>
                    ))}
                  </div>
                );
                // BOTH views stay mounted; only visibility flips. Unmounting CanvasGrid would
                // re-run its saved-grid restore on return (wiping entries appended from the sheet),
                // and unmounting the sheet mid-debounce would race its flush against the refetch.
                return (
                  <>
                    <div className={reelsView === 'sheet' ? 'h-full' : 'hidden'}>
                      <ReelSheet
                        userId={user?.id ?? null}
                        viewToggle={reelsViewToggle}
                        onSendToReels={sendSheetRowsToReels}
                        sendReady={reelsRestored}
                      />
                    </div>
                    <div className={reelsView === 'canvas' ? 'h-full' : 'hidden'}>
                      <CanvasGrid
                        entries={entries}
                        setEntries={setEntries}
                        canvasRefsMap={canvasRefsMap}
                        brand={brand}
                        onAddRow={addRow}
                        onRemoveRow={removeRow}
                        onDuplicateRow={duplicateRow}
                        onDeleteAllReels={deleteAllReels}
                        onHandleVideoError={handleVideoError}
                        onUpdateEntry={updateEntry}
                        onUpdateLocalVideo={updateLocalVideo}
                        onFetchVideo={fetchVideo}
                        userId={user?.id ?? null}
                        videoMode={entries[0]?.mode === 'caption' ? 'caption' : 'twitter'}
                        onGoToTemplateEditor={() => { setTemplateEditorKind('twitter'); setKindIntent('twitter'); setActiveSection('template-editor'); }}
                        viewToggle={reelsViewToggle}
                        active={reelsView === 'canvas'}
                        onScheduleReel={scheduleReel}
                        onRestored={() => setRestoredForUser(user?.id ?? null)}
                        restored={reelsRestored}
                      />
                    </div>
                  </>
                );
              })()}
            </GridSection>
          </ErrorBoundary>
        )}

        {/* Free user on a Pro-only section (deep entry: restored section, lapsed sub) — a quiet
            gate panel instead of the section; its API routes would 403 anyway. */}
        {sectionLocked && (
          <div className="flex flex-col items-center justify-center min-h-screen gap-4 px-6 text-center">
            <svg viewBox="0 0 24 24" className="h-8 w-8 text-fg-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            <div>
              <p className="text-label text-fg">
                {activeSection === 'schedule' ? 'Scheduling & publishing' : activeSection === 'analytics' ? 'Post analytics' : activeSection === 'rewards' ? 'Creator rewards' : 'Node automations'} is a Pro feature
              </p>
              <p className="text-body text-fg-3 mt-1">Subscribe to unlock it — everything you build stays.</p>
            </div>
            <button
              type="button"
              className="text-body underline underline-offset-2 text-fg-2 hover:text-fg focus-ring rounded-xs"
              onClick={() => setUpgradeReason(
                activeSection === 'schedule' ? 'Scheduling and publishing are Pro features.'
                : activeSection === 'analytics' ? 'Post analytics is a Pro feature.'
                : activeSection === 'rewards' ? 'Creator rewards is a Pro feature.'
                : 'Node automations are a Pro feature.'
              )}
            >
              See what Pro includes
            </button>
          </div>
        )}

        {activeSection === 'schedule' && !sectionLocked && (
          <ErrorBoundary>
            <Suspense fallback={<SectionLoader />}>
              <SchedulePanel userId={user?.id ?? null} brand={brand} reelDraft={scheduleReelDraft} onReelDraftConsumed={() => setScheduleReelDraft(null)} />
            </Suspense>
          </ErrorBoundary>
        )}

        {activeSection === 'analytics' && !sectionLocked && (
          <ErrorBoundary>
            <Suspense fallback={<SectionLoader />}>
              <AnalyticsSection />
            </Suspense>
          </ErrorBoundary>
        )}

        {activeSection === 'rewards' && !sectionLocked && (
          <ErrorBoundary>
            <Suspense fallback={<SectionLoader />}>
              <RewardsSection userId={user.id} />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>
      </div>
    </div>
    </PlanProvider>
  );
}
