'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@/app/components/ui';
import { authedFetch } from '@/lib/authedFetch';
import { useRotatingPlaceholder } from '@/app/hooks/useRotatingPlaceholder';
import { Sparkle } from '../ai/sparkle';
import { Shimmer } from '../ai/shimmer';
import { Message, MessageContent, MessageResponse } from '../ai/message';
import { TimelineRow } from '../ai/timeline';
import type { Edge, FlowNode, Graph } from '@/lib/automations';

// One chat, no forms:
//  • BUILD (empty canvas): you describe the goal → the agent (/api/automations/agent) searches the web for
//    a data source (keyless-preferred), builds + RUNS the source live, repairs it until real data flows,
//    adds a Code transform if the shape needs it, and wires it into the Apply Template node. The ONLY thing
//    it ever pauses to ask for is an API key. You pick the template + map the fields on the canvas.
//  • EDIT (existing flow): plain-language tweaks go to /api/automations/generate as before.
// The transcript renders on the same timeline rail as the template editor's copilot (TimelineRow): agent
// progress steps are dot-marked rail entries that cascade in, not one log bubble, and the in-flight state
// is the shimmering "thinking" beat.

interface AgentStep { kind: 'info' | 'ok' | 'warn' | 'error'; message: string }

type Turn =
  | { id: number; role: 'user'; content: string }
  | { id: number; role: 'assistant'; content: string; error?: boolean; delay?: number }
  | { id: number; role: 'step'; kind: AgentStep['kind']; message: string; delay: number };

// A dynamic element in the flow's templates the AI can also see + modify.
export interface FlowElementRef { feId: string; name: string; inputs: Array<{ key: string }>; code: string }

// The source node awaiting a key while the build is paused.
interface PendingKey { graph: Graph; httpNodeId: string }

// Rail node markers — colour encodes the entry's status, like the template editor's copilot rail.
const STEP_NODE_CLS: Record<AgentStep['kind'], string> = {
  info: 'bg-fg-4', ok: 'bg-accent', warn: 'bg-warning-text', error: 'bg-danger-text',
};
const LIVE_NODE = <span className="block size-[7px] rounded-full bg-accent motion-safe:animate-pulse" />;

function turnNode(t: Exclude<Turn, { role: 'user' }>): ReactNode {
  const cls = t.role === 'step' ? STEP_NODE_CLS[t.kind] : t.error ? 'bg-danger-text' : 'bg-fg-4';
  return <span className={`block size-[7px] rounded-full ${cls}`} />;
}

// Cascade delay for a batch of rail entries revealed together (the agent's steps land in one response).
const STAGGER_MS = 90;
const stagger = (i: number) => Math.min(i * STAGGER_MS, 540);

const EXAMPLE_PROMPTS = [
  'Every morning, post the top crypto mover to a carousel.',
  'Pull the top 3 gainers from an API and fill a carousel with their stats.',
  'Post the current weather for London to a carousel every day.',
];

export function ChatPanel({ graph, elements, runOutputs, onApply, onApplyElement, onClose, seed, onCreateCredential }: {
  graph: Graph;
  elements?: FlowElementRef[];
  /** The last run's real per-node data (label → received/emitted/error) — grounds the AI's fixes in what actually happened. */
  runOutputs?: Array<{ id?: string; label: string; received?: unknown; output?: unknown; outputItems?: number; error?: string; stale?: boolean }>;
  onApply: (graph: { nodes: FlowNode[]; edges: Edge[] }) => void;
  onApplyElement?: (feId: string, code: string) => Promise<void> | void;
  onClose: () => void;
  seed?: { text: string; nonce: number } | null;   // pre-fill the input (e.g. from "Edit with AI")
  onCreateCredential?: (label: string, secret: string, kind?: string) => Promise<string>;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingKey, setPendingKey] = useState<PendingKey | null>(null);
  const [waitTick, setWaitTick] = useState(0);   // gently escalates the "thinking" beat on slow turns
  const scrollerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);   // lets the Stop button cancel an in-flight turn
  const idRef = useRef(1);

  const emptyCanvas = graph.nodes.length === 0;

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, busy, pendingKey]);

  // Pre-fill the prompt when asked to (clicking "Edit with AI" on a component focuses this panel).
  useEffect(() => { if (seed) setInput(seed.text); }, [seed]);

  // Closing the panel mid-turn cancels the in-flight request.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Measure the floating composer so the chat reserves clearance below AND fades exactly across it.
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(96);
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setComposerH(el.offsetHeight));
    ro.observe(el);
    setComposerH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  // While we wait for the response, escalate the "thinking" beat in two gentle steps so a slow turn reads
  // as live progress instead of a frozen label (same rhythm as the template editor's copilot).
  useEffect(() => {
    if (!busy) { setWaitTick(0); return; }
    const t1 = setTimeout(() => setWaitTick(1), 1600);
    const t2 = setTimeout(() => setWaitTick(2), 3600);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [busy]);
  const beatLabel = waitTick >= 2
    ? (emptyCanvas ? 'Working on it — finding a data source…' : 'Still working on it…')
    : waitTick === 1 ? 'Thinking it through…' : 'Thinking…';

  const pushAssistant = (content: string, error?: boolean, delay?: number) =>
    setTurns(t => [...t, { id: idRef.current++, role: 'assistant', content, error, delay }]);
  const pushUser = (content: string) => setTurns(t => [...t, { id: idRef.current++, role: 'user', content }]);
  // The agent's progress log lands whole — each step becomes its own rail entry, cascading in.
  const pushSteps = (steps: AgentStep[]) =>
    setTurns(t => [...t, ...steps.map((s, i): Turn => ({ id: idRef.current++, role: 'step', kind: s.kind, message: s.message, delay: stagger(i) }))]);

  // History for the routes: the conversation minus the step log (it's progress noise, not dialogue).
  const chatHistory = () => turns
    .filter((t): t is Exclude<Turn, { role: 'step' }> => t.role !== 'step')
    .map(t => ({ role: t.role, content: t.content }));

  // ── Agentic build (/api/automations/agent) ────────────────────────────────
  function applyOutcome(data: { status?: string; graph?: Graph; steps?: AgentStep[]; summary?: string; message?: string; httpNodeId?: string; error?: string }, ok: boolean) {
    if (!ok) { pushAssistant(data.error || 'Something went wrong — try again.', true); return; }
    // Conversational turn (greeting / question) — a normal reply, nothing to build.
    if (data.status === 'chat') { pushAssistant(data.message || 'Tell me what you’d like to automate.'); return; }
    const steps = data.steps ?? [];
    pushSteps(steps);
    // The turn's closing message trails the step cascade so the timeline reads top-to-bottom.
    const after = steps.length ? stagger(steps.length - 1) + STAGGER_MS : 0;
    if (data.graph) onApply(data.graph); // show the (partial or finished) graph on the canvas

    if (data.status === 'need_key' && data.httpNodeId) {
      setPendingKey({ graph: data.graph!, httpNodeId: data.httpNodeId });
      pushAssistant(data.message || 'This source needs an API key. Paste it below and I’ll continue.', false, after);
    } else if (data.status === 'done') {
      setPendingKey(null);
      if (data.summary) pushAssistant(data.summary, false, after);
    } else {
      pushAssistant(data.message || 'I couldn’t finish this one — try describing the data more specifically.', true, after);
    }
  }

  async function callBuild(payload: Record<string, unknown>) {
    const res = await authedFetch('/api/automations/agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: abortRef.current?.signal,
      body: JSON.stringify(payload),
    });
    let data: Record<string, unknown> = {};
    try { data = await res.json(); } catch { /* fall through to a generic error below */ }
    applyOutcome(data, res.ok);
  }

  // A user-initiated Stop surfaces as a calm note, not an error.
  function pushFailure(e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') pushAssistant('Stopped.');
    else pushAssistant(e instanceof Error ? e.message : 'Request failed', true);
  }

  async function sendBuild(goal: string) {
    // Recent turns ride along so the conversational gate can answer follow-ups in context.
    const history = chatHistory().slice(-8);
    pushUser(goal); setInput(''); setBusy(true);
    abortRef.current = new AbortController();
    try { await callBuild({ goal, history }); }
    catch (e) { pushFailure(e); }
    finally { abortRef.current = null; setBusy(false); }
  }

  async function submitKey(secret: string) {
    if (!pendingKey || busy) return;
    if (!onCreateCredential) { pushAssistant('Can’t store the key here — add it on the source node instead.', true); return; }
    setBusy(true);
    abortRef.current = new AbortController();
    try {
      const credentialId = await onCreateCredential('API key', secret, 'apiKey');
      const resume = { graph: pendingKey.graph, httpNodeId: pendingKey.httpNodeId };
      setPendingKey(null);
      await callBuild({ resume, credentialId });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') pushAssistant('Stopped.');
      else pushAssistant(e instanceof Error ? e.message : 'Could not save the key — try again.', true);
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  // ── Free-form edit (/api/automations/generate) — existing behaviour ────────
  async function sendGenerate(text: string) {
    const messages = [...chatHistory(), { role: 'user' as const, content: text }].slice(-12);
    pushUser(text); setInput(''); setBusy(true);
    abortRef.current = new AbortController();
    try {
      const res = await authedFetch('/api/automations/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current.signal,
        body: JSON.stringify({ messages, graph, elements, runOutputs }),
      });
      const data = await res.json();
      if (!res.ok) {
        pushAssistant(data.error || 'Something went wrong.', true);
      } else if (typeof data.reply === 'string' && data.reply && !data.graph) {
        pushAssistant(data.reply); // conversational turn — no canvas change
      } else if (Array.isArray(data.elementEdits) && data.elementEdits.length) {
        for (const ed of data.elementEdits as Array<{ feId: string; code: string }>) await onApplyElement?.(ed.feId, ed.code);
        pushAssistant(data.summary || 'Updated and saved the element.');
      } else {
        onApply(data.graph);
        pushAssistant(data.summary || 'Updated the flow.');
      }
    } catch (e) {
      pushFailure(e);
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  function send(override?: string) {
    const text = (override ?? input).trim();
    if (!text || busy || pendingKey) return;
    // Empty canvas → agent builds it from scratch; an existing flow → free-form edit.
    if (emptyCanvas) void sendBuild(text);
    else void sendGenerate(text);
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  const inputPlaceholder = useRotatingPlaceholder(
    emptyCanvas ? 'What should this automation do?' : 'Describe or refine the automation…',
    emptyCanvas ? EXAMPLE_PROMPTS : [],
    input.length > 0 || busy || !!pendingKey,
  );

  // Rail bookkeeping: the trailing "thinking" beat connects up to the last turn only if it's on-rail.
  const lastTurn = turns[turns.length - 1];
  const onRailLast = !!lastTurn && lastTurn.role !== 'user';
  const clearance = composerH + 28;   // bottom padding so the newest entry clears the floating composer
  const fadeBand = composerH + 20;    // mask height: the chat fades exactly across the composer
  const maskImage = `linear-gradient(to bottom, black calc(100% - ${fadeBand}px), transparent)`;

  return (
    // z-toast: above the template-edit overlay (z-modal) so the AI dock stays usable while it's open, but
    // below the app nav sidebar (z-max).
    <aside className="de-panel-in-left relative z-toast flex w-[340px] shrink-0 flex-col overflow-hidden border-r border-line bg-surface-1">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4" style={{ height: 52 }}>
        <span className="text-fg-2"><Sparkle active={busy} size={18} strokeWidth={1} /></span>
        <span className="text-label font-semibold text-fg">Build with AI</span>
        <button aria-label="Close chat" onClick={onClose} className="ml-auto grid size-7 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg focus-ring">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* The chat fills the panel; a bottom gradient MASK fades it out as it scrolls behind the floating composer. */}
        <div className="h-full overflow-hidden" style={{ WebkitMaskImage: maskImage, maskImage }}>
        <div ref={scrollerRef} className="no-native-scrollbar flex h-full flex-col overflow-y-auto p-4" style={{ paddingBottom: clearance }}>
        {/* Empty state: a friendly idle mascot + one-tap example prompts that send straight away. */}
        {turns.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-2 text-center">
            <Sparkle size={30} strokeWidth={1.25} />
            <p className="max-w-[240px] text-[13px] leading-relaxed text-fg-3">
              {emptyCanvas
                ? 'Tell me what to automate — I’ll find the data source, wire it up, and get real data flowing into a template. You just pick the template and map the fields.'
                : 'Ask about this flow, or describe a change in plain language — I’ll apply it to the canvas.'}
            </p>
            {emptyCanvas && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {EXAMPLE_PROMPTS.map(p => (
                  <button key={p} type="button" disabled={busy} onClick={() => send(p)}
                    className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-fg-2 transition-colors hover:border-line-strong hover:text-fg disabled:opacity-40 focus-ring">
                    {p}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : turns.map((t, i) => {
          // OFF-RAIL: your messages break the thread — a flush-left bubble with no rail node.
          if (t.role === 'user') {
            return (
              <div key={t.id} className="de-msg-in flex flex-col items-start pb-6">
                <div className="w-fit max-w-[88%] rounded-lg bg-surface-2 px-3 py-2 text-[13px] font-medium text-fg">{t.content}</div>
              </div>
            );
          }
          // ON-RAIL: agent steps and assistant replies, dot-marked on the timeline.
          const prev = turns[i - 1];
          const next = turns[i + 1];
          const railPrev = !!prev && prev.role !== 'user';
          const isLast = i === turns.length - 1;
          const railNext = next ? next.role !== 'user' : (isLast && busy);
          // Consecutive steps sit tighter than full messages so the progress log reads as one run.
          const tight = t.role === 'step' && next?.role === 'step';
          const spaced = !tight && !(isLast && !busy);
          return (
            <div key={t.id} className="de-msg-in" style={t.delay ? { animationDelay: `${t.delay}ms` } : undefined}>
              <TimelineRow node={turnNode(t)} showTop={railPrev} showBottom={railNext} spaced={spaced}>
                {t.role === 'step' ? (
                  <div className={`text-[13px] ${t.kind === 'error' ? 'text-danger-text' : 'text-fg-2'} ${tight ? 'pb-3' : ''}`}>{t.message}</div>
                ) : t.error ? (
                  <div className="text-[13px] text-danger-text">{t.content}</div>
                ) : (
                  <Message from="assistant"><MessageContent><MessageResponse>{t.content}</MessageResponse></MessageContent></Message>
                )}
              </TimelineRow>
            </div>
          );
        })}
        {/* Working — the shimmering thinking beat (the label carries the signal under reduced motion). */}
        {busy && (
          <TimelineRow node={LIVE_NODE} showTop={onRailLast} showBottom={false} spaced={false}>
            <div className="flex items-center gap-2 text-[13px]"><Sparkle active size={16} /><Shimmer duration={1}>{pendingKey ? 'Retrying with your key…' : beatLabel}</Shimmer></div>
          </TimelineRow>
        )}
        </div>
        </div>

        {/* Floating composer cluster — sits OVER the chat (which scrolls + fades behind it). */}
        <div ref={composerRef} className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-col gap-2">
          {pendingKey ? (
            <div className="pointer-events-auto rounded-2xl border border-line-strong bg-surface-2 p-3 shadow-[0_12px_38px_-8px_rgba(0,0,0,0.78)]">
              <KeyPrompt busy={busy} onSubmit={submitKey} onCancel={() => setPendingKey(null)} />
            </div>
          ) : (
            <div className="pointer-events-auto flex flex-col rounded-2xl border border-line-strong bg-surface-2 shadow-[0_12px_38px_-8px_rgba(0,0,0,0.78)] focus-within:border-fg-3">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                placeholder={inputPlaceholder}
                // The card shows focus via focus-within; suppress the textarea's own (unlayered) global outline.
                style={{ outline: 'none' }}
                className="max-h-32 w-full resize-none bg-transparent px-3 pb-2 pt-2.5 text-[13px] leading-relaxed text-fg placeholder:text-fg-4 disabled:opacity-60"
              />
              <div className="flex items-center gap-2 border-t border-line px-2.5 py-2">
                <div className="ml-auto flex items-center gap-2.5">
                  {busy ? (
                    <button type="button" onClick={stop} aria-label="Stop"
                      className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-2 hover:bg-hover hover:text-fg focus-ring">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
                    </button>
                  ) : (
                    <button type="button" onClick={() => send()} disabled={!input.trim()} aria-label="Send"
                      className="grid size-7 shrink-0 place-items-center rounded-lg text-fg transition-colors disabled:text-fg-4 focus-ring">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" /></svg>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="pointer-events-auto flex items-center justify-end px-1">
            <span className="text-[10px] text-fg-4">{emptyCanvas ? 'I’ll find the data + wire it up · Enter to send' : 'Applies changes to the canvas · Enter to send'}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

// Inline key prompt shown while a build is paused waiting for an API key.
function KeyPrompt({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit: (secret: string) => void; onCancel: () => void }) {
  const [secret, setSecret] = useState('');
  return (
    <div className={`flex flex-col gap-2 ${busy ? 'pointer-events-none opacity-60' : ''}`}>
      <input
        type="password"
        value={secret}
        onChange={e => setSecret(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (secret.trim()) onSubmit(secret.trim()); } }}
        placeholder="Paste the API key…"
        className="h-9 rounded-lg border border-line bg-surface-2 px-3 text-[13px] text-fg placeholder:text-fg-4 focus:border-fg-3 focus:outline-none"
      />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={!secret.trim() || busy} onClick={() => onSubmit(secret.trim())}>Continue building</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Skip</Button>
      </div>
      <p className="text-[10px] text-fg-4">Stored encrypted; only its id is saved in the flow.</p>
    </div>
  );
}
