'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch } from '@/lib/authedFetch';
import { Button, Badge, Spinner, Card, BrandLoader } from './ui';

interface Convo {
  id: string; email: string; status: 'open' | 'closed'; last_sender: 'user' | 'admin';
  created_at: string; last_message_at: string; preview: string;
}
interface Msg { id: string; sender: 'user' | 'admin'; body: string; created_at: string }

// Admin side of the live support chat: every user conversation, newest activity first, with a
// thread view + reply box. Lives in the /admin operator panel (Support tab). Access is enforced
// server-side (/api/support/inbox checks ADMIN_EMAILS); the admin page only mounts it for accounts
// the API confirmed. Polls every 5s (the user side gets true realtime; a solo-admin inbox is fine
// on a poll). Thread + composer share the AI chat's visual language (see automations/ChatPanel).
export function SupportInboxSection({ onNeedsReplyChange }: { onNeedsReplyChange?: (n: number) => void } = {}) {
  const [convos, setConvos] = useState<Convo[] | null>(null);
  const [active, setActive] = useState<Convo | null>(null);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = active?.id ?? null;

  const loadList = useCallback(async () => {
    try {
      const res = await authedFetch('/api/support/inbox');
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json() as { conversations: Convo[] };
      setConvos(json.conversations);
      // Keep the host's badge honest in real time — replying/closing refreshes this list, so the
      // count updates immediately instead of waiting for the host page's slower poll.
      onNeedsReplyChange?.(json.conversations.filter(c => c.status === 'open' && c.last_sender === 'user').length);
    } catch {
      setError('Could not load conversations.');
      setConvos(prev => prev ?? []);
    }
  }, [onNeedsReplyChange]);

  const loadThread = useCallback(async (id: string) => {
    try {
      const res = await authedFetch(`/api/support/inbox?conversation=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json() as { conversation: Convo; messages: Msg[] };
      // Only apply if this thread is still the one on screen (poll races with navigation).
      if (activeIdRef.current === id) {
        setMsgs(json.messages);
        setActive(prev => (prev && prev.id === id ? { ...prev, status: json.conversation.status } : prev));
      }
    } catch { /* transient poll failure — keep the last good state */ }
  }, []);

  // Initial load + 5s poll (list always; the open thread too).
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    const id = setInterval(() => {
      void loadList();
      if (activeIdRef.current) void loadThread(activeIdRef.current);
    }, 5000);
    return () => clearInterval(id);
  }, [loadList, loadThread]);

  // Pin the thread to the bottom as messages arrive / a thread opens.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  function openThread(c: Convo) {
    setActive(c);
    setMsgs(null);
    setDraft('');
    void loadThread(c.id);
  }

  async function sendReply() {
    const text = draft.trim().slice(0, 5000);
    if (!active || !text || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await authedFetch('/api/support/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: active.id, body: text }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json() as { message: Msg };
      setMsgs(prev => (prev ? [...prev, json.message] : [json.message]));
      setDraft('');
      void loadList();
    } catch {
      setError('Could not send the reply.');
    } finally {
      setSending(false);
    }
  }

  async function setStatus(status: 'open' | 'closed') {
    if (!active) return;
    const res = await authedFetch('/api/support/inbox', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: active.id, status }),
    });
    if (res.ok) {
      setActive(prev => (prev ? { ...prev, status } : prev));
      void loadList();
    }
  }

  const openCount = (convos ?? []).filter(c => c.status === 'open').length;

  // ── Thread view ─────────────────────────────────────────────────────────────
  if (active) {
    return (
      <div className="flex flex-col items-center">
        <div className="w-full max-w-2xl flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setActive(null); setMsgs(null); void loadList(); }}
              leadingIcon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
              }
            >
              All conversations
            </Button>
            <span className="flex-1" />
            <Badge tone={active.status === 'closed' ? 'neutral' : 'info'}>{active.status}</Badge>
            <Button size="sm" variant="secondary" onClick={() => setStatus(active.status === 'open' ? 'closed' : 'open')}>
              {active.status === 'open' ? 'Close' : 'Reopen'}
            </Button>
          </div>

          <div>
            <h2 className="text-[20px] leading-tight font-bold tracking-[-0.01em] text-fg">{active.email || 'No email'}</h2>
            <p className="text-caption text-fg-3">Started {new Date(active.created_at).toLocaleString()}</p>
          </div>

          <Card surface={1} padding="md">
            <div ref={threadRef} className="max-h-[50vh] overflow-y-auto flex flex-col gap-2.5 pr-1">
              {msgs === null ? (
                <div className="grid min-h-[20vh] place-items-center"><BrandLoader size={40} /></div>
              ) : msgs.length === 0 ? (
                <p className="text-body text-fg-3">No messages yet.</p>
              ) : (
                msgs.map(m => (
                  <div key={m.id} className={`flex flex-col ${m.sender === 'admin' ? 'items-end' : 'items-start'}`}>
                    {/* Same bubble language as the AI chat: own messages right + filled, theirs left + outlined. */}
                    <div
                      className={`min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] ${
                        m.sender === 'admin'
                          ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-surface-3 px-3 py-2 text-[13px] text-fg'
                          : 'max-w-[90%] rounded-2xl rounded-bl-sm border border-line bg-surface-2 px-3 py-2 text-[13px] text-fg-2'
                      }`}
                    >
                      {m.body}
                    </div>
                    <span className="text-[10px] text-fg-4 mt-0.5 px-1">
                      {m.sender === 'admin' ? 'You · ' : ''}{new Date(m.created_at).toLocaleString()}
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="mt-3 pt-3 border-t border-line flex flex-col gap-2">
              {error && <p className="text-caption text-danger-text">{error}</p>}
              {/* Composer — the AI chat's bordered box with an icon send button. */}
              <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2 py-1.5 focus-within:border-fg-3">
                <textarea
                  rows={1}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendReply(); }
                  }}
                  maxLength={5000}
                  placeholder="Reply — the user sees it instantly in their chat…"
                  className="h-8 max-h-32 flex-1 resize-none bg-transparent py-1.5 text-[13px] leading-5 text-fg placeholder:text-fg-4 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void sendReply()}
                  disabled={!draft.trim() || sending}
                  aria-label="Send reply"
                  className="grid size-8 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:text-fg disabled:opacity-40 focus-ring"
                >
                  {sending ? <Spinner size="sm" /> : (
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" />
                    </svg>
                  )}
                </button>
              </div>
              <p className="text-center text-[10px] text-fg-4">Lands in their chat instantly · Enter to send</p>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  // ── Conversation list ───────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center">
      <div className="w-full max-w-2xl flex flex-col gap-6">
        <div>
          <h2 className="text-[20px] leading-tight font-bold tracking-[-0.01em] text-fg mb-1">Support inbox</h2>
          <p className="text-body text-fg-3">
            Live chats from Help &amp; support{convos ? ` · ${openCount} open` : ''}
          </p>
        </div>

        {error && <p className="text-caption text-danger-text">{error}</p>}

        {convos === null ? (
          <div className="grid min-h-[30vh] place-items-center"><BrandLoader /></div>
        ) : convos.length === 0 ? (
          <p className="text-body text-fg-3">No conversations yet.</p>
        ) : (
          convos.map(c => (
            <button key={c.id} onClick={() => openThread(c)} className="text-left focus-ring rounded-xl">
              <Card surface={1} padding="md" className="hover:border-line-strong transition-colors">
                <div className="flex items-center gap-3">
                  {/* Needs-reply dot: the latest message is from the user. */}
                  {c.last_sender === 'user' && c.status === 'open'
                    ? <span className="size-2 rounded-full bg-accent shrink-0" title="Awaiting your reply" />
                    : <span className="size-2 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-label text-fg truncate">{c.email || 'No email'}</p>
                    <p className="text-caption text-fg-3 truncate">{c.preview || '—'}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="text-caption text-fg-4">{new Date(c.last_message_at).toLocaleString()}</span>
                    <Badge tone={c.status === 'closed' ? 'neutral' : c.last_sender === 'user' ? 'info' : 'success'}>
                      {c.status === 'closed' ? 'closed' : c.last_sender === 'user' ? 'needs reply' : 'replied'}
                    </Badge>
                  </div>
                </div>
              </Card>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
