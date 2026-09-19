'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Spinner, BrandLoader } from './ui';

interface Msg { id: string; sender: 'user' | 'admin'; body: string; created_at: string }

const CLOSED = 48;                                   // launcher circle size (px)
const GAP = 12;                                      // gap between the circle and the panel
const PANEL_W = 'min(360px, calc(100vw - 40px))';    // open panel width

// Last-read mark for the unread badge — localStorage carries this browser, and the mark is also
// synced to the conversation row (user_last_read_at, owner-only column grant) so other devices
// agree. The worst failure mode is a stale badge that clears on open.
const readKey = (uid: string) => `ff-support-read:${uid}`;

// Floating help launcher → LIVE support chat, styled to match the AI chat (automations ChatPanel):
// same header bar, bubble geometry and composer, so every chat in the app reads the same. One
// ongoing conversation per user (get-or-created on first open); the user reads/writes it directly
// under RLS, and admin replies arrive in realtime via a postgres_changes subscription that stays
// live while the panel is CLOSED too — that's what feeds the unread badge on the launcher.
// Admins read and reply from the Support inbox in /admin. Honest presence: no fake "online now" —
// the hint says replies land right here.
export function HelpSupportWidget({ userId, email }: { userId: string | null; email: string | null }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const [convoId, setConvoId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  // Get-or-create failed (network, misconfig) — show a retry card instead of spinning forever.
  const [createFailed, setCreateFailed] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const threadRef = useRef<HTMLDivElement>(null);

  // Last-read mark, mirrored to localStorage. State (not a ref) so the badge re-derives when it
  // moves; the lazy initializer reads the stored mark once. `unread` is derived at render — no
  // effect involved — and reads are recorded from event/subscription callbacks only.
  const [lastRead, setLastRead] = useState<string>(() => {
    if (typeof window === 'undefined' || !userId) return '';
    try { return localStorage.getItem(readKey(userId)) ?? ''; } catch { return ''; }
  });
  // Ref mirror so callbacks can compare monotonically without being recreated per change.
  const lastReadRef = useRef(lastRead);
  // Adopt a newer mark locally (state + localStorage) WITHOUT echoing it back to the server —
  // used when the server's user_last_read_at (written by another device) is ahead of us.
  const absorbRead = useCallback((upTo: string | null | undefined) => {
    if (!userId || !upTo || upTo <= lastReadRef.current) return;
    lastReadRef.current = upTo;
    setLastRead(upTo);
    try { localStorage.setItem(readKey(userId), upTo); } catch { /* private mode */ }
  }, [userId]);
  const markRead = useCallback((upTo: string | undefined) => {
    if (!userId || !upTo || upTo <= lastReadRef.current) return;
    absorbRead(upTo);
    // Cross-device: best-effort watermark sync to the conversation row (owner-only column grant).
    // The or() guard keeps the server value monotonic even when another device is ahead of this
    // one (the quoted timestamp survives PostgREST's reserved chars). PostgREST builders are lazy —
    // then() is what executes this; both handlers keep it fire-and-forget.
    supabase
      .from('support_conversations')
      .update({ user_last_read_at: upTo })
      .eq('user_id', userId)
      .or(`user_last_read_at.is.null,user_last_read_at.lt."${upTo}"`)
      .then(() => {}, () => {});
  }, [userId, absorbRead]);
  // The realtime callback needs the CURRENT open state without resubscribing on every toggle.
  const openRef = useRef(false);
  useEffect(() => { openRef.current = open; }, [open]);

  // ISO timestamps (same source + format) compare correctly as strings.
  const unread = open || !msgs ? 0 : msgs.filter(m => m.sender === 'admin' && m.created_at > lastRead).length;

  // Close on outside click + Escape (matches the element rail flyout's behaviour).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // On sign-in: look up the existing conversation (SELECT only — never create one just to count
  // unread) and load its tail, so the launcher can badge admin replies that landed between visits.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data: existing } = await supabase
        .from('support_conversations')
        .select('id,user_last_read_at')
        .maybeSingle();
      if (cancelled || !existing?.id) return;
      setConvoId(existing.id);
      // Another device may have read further than this browser's localStorage mark.
      absorbRead(existing.user_last_read_at);
      // Newest 200 fetched descending then flipped — a long thread keeps its fresh end.
      const { data: rows } = await supabase
        .from('support_messages')
        .select('id,sender,body,created_at')
        .eq('conversation_id', existing.id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(200);
      if (cancelled) return;
      const list = ((rows as Msg[] | null) ?? []).reverse();
      setMsgs(list);
      // Loaded after the user already opened the panel (fast click) — everything shown is read.
      if (openRef.current) markRead(list[list.length - 1]?.created_at);
    })();
    return () => { cancelled = true; };
  }, [userId, markRead, absorbRead]);

  // First open with no thread yet: get-or-create the conversation, then load its (empty) messages.
  // The unique index on user_id makes the create race-safe (a concurrent tab's insert just makes
  // ours re-select). If BOTH the insert and the fallback select come back empty (offline, RLS
  // misconfig), surface a retry card instead of leaving the loader spinning forever.
  useEffect(() => {
    if (!open || !userId || convoId) return;
    let cancelled = false;
    (async () => {
      const { data: created } = await supabase
        .from('support_conversations')
        .insert({ user_id: userId, email: email ?? '' })
        .select('id')
        .single();
      let id = created?.id as string | undefined;
      if (!id) {
        const { data: again } = await supabase
          .from('support_conversations')
          .select('id,user_last_read_at')
          .maybeSingle();
        id = again?.id;
        if (!cancelled) absorbRead(again?.user_last_read_at);
      }
      if (cancelled) return;
      if (!id) { setCreateFailed(true); return; }
      setConvoId(id);
      // Newest 200 fetched descending then flipped — a long thread keeps its fresh end.
      const { data: rows } = await supabase
        .from('support_messages')
        .select('id,sender,body,created_at')
        .eq('conversation_id', id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(200);
      if (!cancelled) setMsgs(((rows as Msg[] | null) ?? []).reverse());
    })();
    return () => { cancelled = true; };
  }, [open, userId, email, convoId, retryTick, absorbRead]);

  // Realtime: admin replies (and our own inserts from other tabs) stream in whether the panel is
  // open or not — closed, they only bump the unread badge. RLS scopes postgres_changes delivery to
  // rows the user can select: their own thread.
  useEffect(() => {
    if (!convoId) return;
    const channel = supabase
      .channel(`support-${convoId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'support_messages', filter: `conversation_id=eq.${convoId}` },
        payload => {
          const msg = payload.new as Msg;
          setMsgs(prev => (prev && !prev.some(m => m.id === msg.id) ? [...prev, msg] : prev));
          // A reply landing while the panel is open is read on arrival; closed, it feeds the badge.
          if (openRef.current && msg.sender === 'admin') markRead(msg.created_at);
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [convoId, markRead]);

  // Keep the thread pinned to the bottom as messages arrive / the panel opens.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, open]);

  async function send() {
    const text = draft.trim().slice(0, 5000);
    if (!userId || !convoId || !text || sending) return;
    setSending(true);
    setError('');
    const { data, error: err } = await supabase
      .from('support_messages')
      .insert({ conversation_id: convoId, sender: 'user', body: text })
      .select('id,sender,body,created_at')
      .single();
    setSending(false);
    if (err || !data) { setError('Could not send — please try again.'); return; }
    setMsgs(prev => (prev && !prev.some(m => m.id === (data as Msg).id) ? [...prev, data as Msg] : prev));
    setDraft('');
  }

  const tabbable = open ? 0 : -1;

  return (
    // Between the fixed panels (z-overlay 1100) and modals (z-modal 1200), so the launcher floats
    // over the editor chrome without ever covering a real dialog.
    <div ref={wrapRef} className="fixed bottom-5 right-5" style={{ zIndex: 1150 }}>
      {/* The panel — always mounted so open AND close animate with the same origin-anchored
          scale+fade (grows out of the launcher's corner, shrinks back into it). */}
      <div
        className="absolute right-0 flex flex-col rounded-2xl bg-surface-1 border border-line-strong shadow-3 overflow-hidden transition-[opacity,transform] duration-[var(--dur-spatial)] ease-[var(--ease-emphasized)] motion-reduce:transition-none"
        style={{
          bottom: CLOSED + GAP,
          width: PANEL_W,
          height: 'min(480px, calc(100vh - 120px))',
          transformOrigin: 'bottom right',
          opacity: open ? 1 : 0,
          transform: open ? 'none' : 'translateY(8px) scale(0.94)',
          pointerEvents: open ? 'auto' : 'none',
        }}
        aria-hidden={!open}
      >
        {/* Header — same bar as the AI chat dock (icon + label, 52px, hairline below). */}
        <div className="shrink-0 flex items-center gap-2 border-b border-line px-4" style={{ height: 52 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-fg-2">
            <path d="M3 12a9 9 0 0 1 18 0" />
            <path d="M3 12h2a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z" />
            <path d="M21 12h-2a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v-7Z" />
            <path d="M21 17v1a4 4 0 0 1-4 4h-3" />
          </svg>
          <span className="text-label font-semibold text-fg">Help &amp; support</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            tabIndex={tabbable}
            className="ml-auto grid size-7 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg focus-ring"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Thread — AI-chat bubbles: own messages right + filled, replies left + outlined. */}
        <div ref={threadRef} className="flex-1 min-h-0 space-y-3 overflow-y-auto p-4">
          {msgs === null ? (
            createFailed ? (
              <div className="rounded-lg border border-line bg-surface-2 p-3 text-caption text-fg-3">
                Could not open the conversation — check your connection.
                <button
                  type="button"
                  onClick={() => { setCreateFailed(false); setRetryTick(t => t + 1); }}
                  tabIndex={tabbable}
                  className="mt-2 block rounded-md border border-line px-2 py-1 text-caption text-fg-2 hover:bg-hover hover:text-fg focus-ring"
                >
                  Try again
                </button>
              </div>
            ) : (
              <div className="grid h-full place-items-center"><BrandLoader size={36} /></div>
            )
          ) : msgs.length === 0 ? (
            <div className="rounded-lg border border-line bg-surface-2 p-3 text-caption text-fg-3">
              Send us a message — what you were doing, what you expected, what happened. Replies show
              up right here.
            </div>
          ) : (
            msgs.map(msg => (
              <div key={msg.id} className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
                {msg.sender === 'admin' && (
                  <span className="mb-0.5 px-1 text-[10px] font-medium text-fg-4">FeedForce</span>
                )}
                <div
                  className={`min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] ${
                    msg.sender === 'user'
                      ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-surface-3 px-3 py-2 text-[13px] text-fg'
                      : 'max-w-[90%] rounded-2xl rounded-bl-sm border border-line bg-surface-2 px-3 py-2 text-[13px] text-fg-2'
                  }`}
                >
                  {msg.body}
                </div>
                <span className="mt-0.5 px-1 text-[10px] text-fg-4">
                  {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Composer — the AI chat's bordered box with an icon send button. */}
        <div className="shrink-0 border-t border-line p-3">
          {error && <p className="mb-1.5 text-caption text-danger-text">{error}</p>}
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2 py-1.5 focus-within:border-fg-3">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
              }}
              rows={1}
              maxLength={5000}
              placeholder="Write a message…"
              tabIndex={tabbable}
              className="h-8 max-h-32 flex-1 resize-none bg-transparent py-1.5 text-[13px] leading-5 text-fg placeholder:text-fg-4 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!userId || !convoId || !draft.trim() || sending}
              aria-label="Send"
              tabIndex={tabbable}
              className="grid size-8 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:text-fg disabled:opacity-40 focus-ring"
            >
              {sending ? <Spinner size="sm" /> : (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" />
                </svg>
              )}
            </button>
          </div>
          <p className="mt-1.5 text-center text-[10px] text-fg-4">Replies land right here · Enter to send</p>
        </div>
      </div>

      {/* The launcher circle — toggles the panel; the ? and × crossfade with a little rotation.
          The unread pill sits on its corner while there are admin replies you haven't seen. */}
      <button
        type="button"
        onClick={() => {
          const willOpen = !open;
          // Opening shows the whole thread, so everything loaded so far becomes read.
          if (willOpen && msgs?.length) markRead(msgs[msgs.length - 1].created_at);
          // A fresh open retries a previously failed get-or-create (the effect re-runs on `open`).
          if (willOpen) setCreateFailed(false);
          setOpen(willOpen);
        }}
        aria-label={open ? 'Close help' : unread > 0 ? `Help & support — ${unread} unread ${unread === 1 ? 'reply' : 'replies'}` : 'Help & support'}
        aria-expanded={open}
        title="Help & support"
        className="relative grid place-items-center rounded-full bg-surface-1 border border-line shadow-2 text-fg-2 hover:text-fg hover:bg-hover hover:border-line-strong focus-ring transition-colors"
        style={{ width: CLOSED, height: CLOSED }}
      >
        <svg
          width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden
          className="absolute transition-[opacity,transform] duration-[var(--dur-base)] motion-reduce:transition-none"
          style={{ opacity: open ? 0 : 1, transform: open ? 'rotate(90deg) scale(0.6)' : 'none' }}
        >
          {/* Headset: headband + two ear cups + boom mic */}
          <path d="M3 12a9 9 0 0 1 18 0" />
          <path d="M3 12h2a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z" />
          <path d="M21 12h-2a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v-7Z" />
          <path d="M21 17v1a4 4 0 0 1-4 4h-3" />
        </svg>
        <svg
          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden
          className="absolute transition-[opacity,transform] duration-[var(--dur-base)] motion-reduce:transition-none"
          style={{ opacity: open ? 1 : 0, transform: open ? 'none' : 'rotate(-90deg) scale(0.6)' }}
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
        {unread > 0 && !open && (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-fg shadow-1"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
    </div>
  );
}
