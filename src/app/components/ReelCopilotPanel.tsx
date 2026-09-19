'use client';

import { useEffect, useRef, useState } from 'react';
import { authedFetch } from '@/lib/authedFetch';
import { readCopilotStream } from '@/lib/copilotStreamClient';
import { useStreamingBuffer } from '@/app/hooks/useStreamingBuffer';
import { useRotatingPlaceholder } from '@/app/hooks/useRotatingPlaceholder';
import { useCommandMenu } from '@/app/hooks/useCommandMenu';
import { REEL_COMMANDS } from '@/lib/editorTools/slashCommands';
import { AiMascot } from './AiMascot';
import { CommandMenu } from './CommandMenu';
import { MarkdownLite } from './MarkdownLite';
import type { ReelCopilot } from '@/app/hooks/useReelCopilot';
import type { TwitterTemplateSettings } from './twitterTemplateTypes';

const EXAMPLE_PROMPTS = ['Make the header dark', 'Bigger caption text', 'Circle avatar with a ring', 'Match my brand colors'];
const FOLLOW_UPS = ['Make it bolder', 'Adjust the spacing', 'Try lighter colors'];

// "Build with AI" for the REEL overlay editor. A reel is one overlay (no slides), so this is a
// straight conversational copilot: each message → one metered call → { reply, patch }, applied
// through the editor's updateSettings (autosave + one ⌘Z step). Supports pasting/attaching a
// reference image (style match). No element generator / remix here — that's carousel-only.

type Msg =
  | { id: number; role: 'user'; text: string; imageOnly?: boolean }
  | { id: number; role: 'ai'; kind: 'text'; text: string }
  | { id: number; role: 'ai'; kind: 'applied'; text: string };

async function fileToJpeg(file: File, maxDim = 1024): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return c.toDataURL('image/jpeg', 0.72);
  } catch { return null; }
}

const GREETING = 'Tell me how to style this reel overlay — colors, avatar, fonts, the caption, layout. Or paste a reference image to match its look. Every change is one ⌘Z step.';

export function ReelCopilotPanel({ userId, copilot, onClose, onUndoEdit }: {
  userId: string | null;
  copilot: ReelCopilot;
  onClose: () => void;
  onUndoEdit?: () => boolean;   // undo the editor's last step; returns whether anything was undone. Surfaced as an Undo button on the latest applied card.
}) {
  const threadKeyRef = useRef<string | null>(
    userId ? `de:reelcopilot:${userId}:${copilot.getState()?.id ?? 'none'}` : null,
  );
  const [messages, setMessages] = useState<Msg[]>(() => {
    const key = threadKeyRef.current;
    if (key) {
      try {
        const raw = localStorage.getItem(key);
        if (raw) { const p = JSON.parse(raw) as Msg[]; if (Array.isArray(p) && p.length) return p; }
      } catch { /* ignore */ }
    }
    return [{ id: 0, role: 'ai', kind: 'text', text: GREETING }];
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const idRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [undoneIds, setUndoneIds] = useState<Set<number>>(() => new Set());   // applied cards whose Undo has been used
  const streaming = useStreamingBuffer();   // live reply prose, throttled, kept out of `messages`
  const cmdMenu = useCommandMenu({ commands: REEL_COMMANDS, inputRef, setValue: setInput });

  useEffect(() => {
    idRef.current = messages.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const key = threadKeyRef.current;
    if (!key) return;
    try {
      if (messages.length <= 1) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(messages.slice(-40)));
    } catch { /* quota */ }
  }, [messages]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages, busy, streaming.text]);

  // Closing the panel mid-turn should cancel the in-flight request — otherwise a late response would
  // still apply a patch (and pulse the preview) after the copilot is gone, and burn a metered call.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function attach(file: File) {
    if (!file.type.startsWith('image/')) return;
    const jpeg = await fileToJpeg(file);
    if (jpeg) setAttachedImage(jpeg);
  }

  function stop() {
    abortRef.current?.abort();
  }

  // Runs one copilot turn against `base` (the conversation before this turn's user message). The user
  // bubble is shown by the caller; this only issues the request + shows results.
  async function runTurn(prompt: string, image: string | null, base: Msg[]) {
    const state = copilot.getState();
    if (!state) return;
    setBusy(true);
    abortRef.current = new AbortController();
    try {
      const history = [...base, { id: -1, role: 'user' as const, text: prompt || 'Use the attached image.' }]
        .map(m => m.role === 'user'
          ? { role: 'user' as const, content: m.text }
          : { role: 'assistant' as const, content: m.text })
        .slice(-12)
        .map(m => ({ ...m, content: m.content.slice(0, 4000) }));

      setStatus(image ? 'Looking at your image…' : 'Reading your reel…');
      const res = await authedFetch('/api/editor/reel-agent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current?.signal,
        body: JSON.stringify({ messages: history, settings: state.settings, templateName: state.name, brand: copilot.getBrand(), image: image ?? undefined }),
      });
      // Pre-stream failures (budget/rate/validation) come back as a normal JSON error.
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error((j as { error?: string }).error ?? 'Copilot failed'); }

      const { final: f, error: streamError, replyText } = await readCopilotStream<{ reply?: string; patch?: unknown; warning?: string }>(
        res,
        (t) => streaming.append(t),
      );

      streaming.reset();
      // On any non-success outcome, keep the prose the user already watched stream in (don't discard it).
      const keepStreamed = () => {
        if (replyText.trim()) setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: replyText }]);
      };
      if (streamError) {
        keepStreamed();
        setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: streamError }]);
      } else if (!f) {
        // Stream ended with no terminal frame (e.g. a dropped connection) — surface it, don't no-op silently.
        keepStreamed();
        setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: 'The reply was cut off before it finished — please try again.' }]);
      } else {
        const finalReply = f.reply;
        if (finalReply) setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: finalReply }]);
        if (f.patch) {
          // Pin the apply to the reel this request was about (state.id captured before the await).
          const changes = copilot.applyPatch(f.patch as Partial<TwitterTemplateSettings>, state.id);
          if (changes) {
            const keys = Object.keys(f.patch as object);
            const label = changes.length ? `Set ${changes.join(' · ')}` : `Applied ${keys.length <= 4 ? keys.join(', ') : `${keys.length} settings`}`;
            setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'applied', text: `${label} · ⌘Z to undo` }]);
          } else {
            setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: 'You switched templates, so I didn’t apply that change — ask again on this one.' }]);
          }
        }
        if (f.warning) setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: `⚠ ${f.warning}` }]);
      }
    } catch (e) {
      streaming.reset();
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: aborted ? 'Stopped.' : (e instanceof Error ? e.message : 'Something went wrong') }]);
    }
    abortRef.current = null;
    setStatus('');
    setBusy(false);
  }

  async function send(override?: string) {
    const prompt = (override ?? input).trim();
    if ((!prompt && !attachedImage) || busy) return;
    if (!copilot.getState()) return;
    const image = attachedImage;
    if (override === undefined) setInput('');
    setAttachedImage(null);
    const base = messages;   // history BEFORE this turn (the user bubble is appended below)
    const imageOnly = !prompt && !!image;
    setMessages([...base, { id: idRef.current++, role: 'user', text: prompt || '🖼️ (image attached)', ...(imageOnly ? { imageOnly: true } : {}) }]);
    await runTurn(prompt, image, base);
  }

  // Retry: re-run the last user message (drop that turn's AI responses first). An image-only turn is
  // un-retryable (the image isn't kept). No-op while busy.
  function retry() {
    if (busy) return;
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].role === 'user') { idx = i; break; } }
    if (idx === -1) return;
    const um = messages[idx];
    if (um.role !== 'user' || um.imageOnly) return;
    const text = um.text;
    if (!text.trim()) return;
    const base = messages.slice(0, idx);
    setMessages(messages.slice(0, idx + 1));
    void runTurn(text, null, base);
  }

  // Edit & resend: pull a past user message back into the input and rewind to just before it.
  function editMessage(id: number) {
    if (busy) return;
    const idx = messages.findIndex(m => m.id === id);
    if (idx === -1 || messages[idx].role !== 'user') return;
    const um = messages[idx];
    setInput(um.role === 'user' ? um.text : '');
    setMessages(messages.slice(0, idx));
    inputRef.current?.focus();
  }

  // Undo the editor's last step (the just-applied turn). Notes "Reverted" only when an undo actually
  // happened; marks the card so its Undo button doesn't linger.
  function undoLastEdit(id: number) {
    if (!onUndoEdit || busy) return;
    if (!onUndoEdit()) return;
    setUndoneIds(prev => new Set(prev).add(id));
    setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: '↩ Reverted that change.' }]);
  }

  const isEmptyState = messages.length === 1 && messages[0].role === 'ai' && messages[0].kind === 'text';
  const last = messages[messages.length - 1];
  const showFollowUps = !busy && last?.role === 'ai' && last.kind === 'applied';
  const lastUserMsg = messages.filter((m): m is Extract<Msg, { role: 'user' }> => m.role === 'user').at(-1);
  const showRetry = !busy && !streaming.text && last?.role === 'ai' && !!lastUserMsg && !lastUserMsg.imageOnly;
  const lastAppliedIndex = messages.reduce((acc, m, i) => (m.role === 'ai' && m.kind === 'applied' ? i : acc), -1);
  const inputPlaceholder = useRotatingPlaceholder('Ask for any change — or paste a reference image…', EXAMPLE_PROMPTS, input.length > 0 || busy || !!attachedImage);

  return (
    <aside className="de-panel-in-left flex h-full w-[340px] shrink-0 flex-col border-r border-line bg-surface-1">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4" style={{ height: 52 }}>
        <span className="text-fg"><AiMascot state={busy ? 'loading' : 'idle'} size={11} /></span>
        <span className="text-label font-semibold text-fg">Build with AI</span>
        {messages.some(m => m.role === 'user') && (
          <button aria-label="New chat" title="Clear this conversation" disabled={busy}
            onClick={() => { setMessages([{ id: 0, role: 'ai', kind: 'text', text: GREETING }]); idRef.current = 1; setUndoneIds(new Set()); try { if (threadKeyRef.current) localStorage.removeItem(threadKeyRef.current); } catch { /* ignore */ } }}
            className="ml-auto grid size-7 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg focus-ring disabled:opacity-40">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
          </button>
        )}
        <button aria-label="Close" onClick={onClose} className={`${messages.some(m => m.role === 'user') ? '' : 'ml-auto'} grid size-7 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg focus-ring`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {isEmptyState ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-2 text-center">
            <span className="text-fg-2"><AiMascot state="idle" size={28} /></span>
            <p className="max-w-[240px] text-[13px] leading-relaxed text-fg-3">{GREETING}</p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {EXAMPLE_PROMPTS.map(p => (
                <button key={p} type="button" disabled={busy} onClick={() => void send(p)}
                  className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-fg-2 transition-colors hover:border-line-strong hover:text-fg disabled:opacity-40 focus-ring">
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : messages.map((m, i) => {
          if (m.role === 'user') return (
            <div key={m.id} className="group flex max-w-[85%] flex-col items-end gap-0.5 self-end">
              <div className="de-msg-in rounded-2xl rounded-br-sm bg-surface-3 px-3 py-2 text-[13px] text-fg">{m.text}</div>
              {!busy && (
                <button type="button" onClick={() => editMessage(m.id)}
                  className="text-[10px] text-fg-4 opacity-0 transition-opacity hover:text-fg-2 focus-visible:opacity-100 group-hover:opacity-100 focus-ring">Edit</button>
              )}
            </div>
          );
          if (m.kind === 'applied') {
            const canUndoThis = i === lastAppliedIndex && !undoneIds.has(m.id);
            return (
              <div key={m.id} className="de-msg-in flex max-w-[90%] flex-col gap-1 self-start rounded-2xl rounded-bl-sm border border-line bg-surface-2 px-3 py-2 text-[12px] text-fg-2">
                <div className="flex items-center gap-1.5"><span className="text-[11px] text-fg-3" aria-hidden>✓</span>{m.text}</div>
                {canUndoThis && onUndoEdit && !busy && (
                  <button type="button" onClick={() => undoLastEdit(m.id)}
                    className="self-start text-[10px] text-fg-3 underline decoration-line-strong underline-offset-2 hover:text-fg focus-ring">Undo</button>
                )}
              </div>
            );
          }
          return <div key={m.id} className="de-msg-in max-w-[90%] self-start rounded-2xl rounded-bl-sm border border-line bg-surface-2 px-3 py-2 text-[13px] text-fg-2"><MarkdownLite text={m.text} /></div>;
        })}
        {/* Live reply, streaming in token-by-token, until it's committed to `messages` on done. */}
        {streaming.text && (
          <div className="max-w-[90%] self-start rounded-2xl rounded-bl-sm border border-line bg-surface-2 px-3 py-2 text-[13px] text-fg-2">{streaming.text}</div>
        )}
        {/* Mascot + phase text only until the first token arrives; then the live bubble carries the signal. */}
        {busy && !streaming.text && (
          <div className="flex items-center gap-2 self-start text-caption text-fg-3">
            <span className="text-fg-2"><AiMascot state="loading" size={13} /></span>
            {status || 'Thinking…'}
          </div>
        )}
        {showFollowUps && (
          <div className="de-msg-in flex flex-wrap gap-1.5 self-start">
            {FOLLOW_UPS.map(f => (
              <button key={f} type="button" onClick={() => void send(f)}
                className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-fg-3 transition-colors hover:border-line-strong hover:text-fg focus-ring">
                {f}
              </button>
            ))}
          </div>
        )}
        {/* Retry the last user message (re-runs after dropping that turn's AI responses). */}
        {showRetry && (
          <button type="button" onClick={retry}
            className="flex items-center gap-1 self-start text-[11px] text-fg-4 transition-colors hover:text-fg-2 focus-ring">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
            Retry
          </button>
        )}
      </div>

      <div className="shrink-0 border-t border-line p-3">
        {attachedImage && (
          <div className="mb-1.5 flex items-center gap-2 rounded-md border border-line bg-surface-2 p-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={attachedImage} alt="attachment" className="size-9 rounded object-cover" />
            <span className="flex-1 text-[11px] text-fg-3">Image attached — describe what to do with it.</span>
            <button type="button" aria-label="Remove attachment" onClick={() => setAttachedImage(null)} className="grid size-5 place-items-center rounded text-fg-3 hover:text-fg focus-ring">✕</button>
          </div>
        )}
        {cmdMenu.menu && <CommandMenu items={cmdMenu.menu.items} index={cmdMenu.menu.index} onSelect={cmdMenu.select} onHover={cmdMenu.setIndex} />}
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2 py-1.5 focus-within:border-fg-3">
          <button type="button" aria-label="Attach image" title="Attach an image (or paste one)" disabled={busy}
            onClick={() => attachRef.current?.click()}
            className="grid size-8 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:text-fg disabled:opacity-40 focus-ring">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.49-8.49" /></svg>
          </button>
          <input ref={attachRef} type="file" accept="image/*" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void attach(f); if (attachRef.current) attachRef.current.value = ''; }} />
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => { setInput(e.target.value); cmdMenu.sync(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
            // Re-sync on caret moves (arrows / clicks) so the menu closes when the caret leaves the trigger.
            onSelect={e => cmdMenu.sync(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
            onKeyDown={e => {
              if (cmdMenu.menu) {
                if (e.key === 'ArrowDown') { e.preventDefault(); cmdMenu.move(1); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); cmdMenu.move(-1); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); cmdMenu.select(cmdMenu.menu.items[cmdMenu.menu.index]); return; }
                if (e.key === 'Escape') { e.preventDefault(); cmdMenu.close(); return; }
              }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
            onBlur={() => cmdMenu.close()}
            onPaste={e => { const img = Array.from(e.clipboardData.items).find(it => it.type.startsWith('image/'))?.getAsFile(); if (img) { e.preventDefault(); void attach(img); } }}
            rows={1}
            placeholder={inputPlaceholder}
            className="h-8 max-h-32 flex-1 resize-none bg-transparent text-[13px] leading-8 text-fg placeholder:text-fg-4 focus:outline-none"
          />
          {busy ? (
            <button type="button" onClick={stop} aria-label="Stop"
              className="grid size-8 shrink-0 place-items-center rounded-md text-fg-2 transition-colors hover:bg-hover hover:text-fg focus-ring">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
            </button>
          ) : (
            <button type="button" onClick={() => void send()} disabled={!input.trim() && !attachedImage} aria-label="Send"
              className="grid size-8 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:text-fg disabled:opacity-40 focus-ring">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" /></svg>
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[10px] text-fg-4">Edits apply to the reel instantly · ⌘Z to undo</p>
      </div>
    </aside>
  );
}
