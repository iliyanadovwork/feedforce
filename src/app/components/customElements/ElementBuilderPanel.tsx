'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/app/components/ui';
import { authedFetch } from '@/lib/authedFetch';
import { readCopilotStream } from '@/lib/copilotStreamClient';
import { useStreamingBuffer } from '@/app/hooks/useStreamingBuffer';
import { useRotatingPlaceholder } from '@/app/hooks/useRotatingPlaceholder';
import { useCommandMenu } from '@/app/hooks/useCommandMenu';
import { CAROUSEL_COMMANDS } from '@/lib/editorTools/slashCommands';
import { useCustomElements } from '@/app/hooks/useCustomElements';
import { renderCustomElement, type ElementRenderTheme, type ElementInput } from '@/lib/customElements/runtime';
import { zAgentAction, describeAction, type AgentAction } from '@/lib/editorTools/agentActions';
import type { EditorCopilot } from '@/app/hooks/useEditorCopilot';
import { CommandMenu } from '../CommandMenu';
import { Sparkle } from '../ai/sparkle';
import { Shimmer } from '../ai/shimmer';
import { Message, MessageContent, MessageResponse } from '../ai/message';
import { Plan, PlanHeader, PlanTitle, PlanDescription, PlanContent, PlanFooter, PlanTrigger } from '../ai/plan';
import { Task, TaskTrigger, TaskContent, TaskItem } from '../ai/task';
import { CodeBlock, CodeDiff } from '../ai/code-block';
import { TimelineRow } from '../ai/timeline';
import { ContextRing, TotalTokens, TurnTokens, type TokenUsage } from '../ai/token-usage';
import { ElementPreview } from './ElementPreview';

// The timeline-rail node marker for an AI block — colour encodes status.
function aiNode(m: Extract<Msg, { role: 'ai' }>): ReactNode {
  if (m.kind === 'turntokens') return <span className="block size-1 rounded-full bg-fg-4" />;
  if (m.kind === 'generating') return <span className="block size-[7px] rounded-full bg-accent motion-safe:animate-pulse" />;
  const cls = m.kind === 'applied' || m.kind === 'element' ? 'bg-accent' : m.kind === 'plan' ? 'bg-fg-3' : 'bg-fg-4';
  return <span className={`block size-[7px] rounded-full ${cls}`} />;
}
const LIVE_NODE = <span className="block size-[7px] rounded-full bg-accent motion-safe:animate-pulse" />;

// Example prompts shown as one-tap chips on the empty state (copilot mode).
const EXAMPLE_PROMPTS = ['Make the headline bigger and bolder', 'Restyle this slide darker', 'Add a “SWIPE” cue', 'Add a bar chart'];
// Contextual follow-ups offered after the AI applies an edit — clicking pre-fills the input.
const FOLLOW_UPS = ['Make it bolder', 'Try a darker look', 'Tweak the spacing'];

// What the editor needs to drop a custom element onto the canvas (a FreeElement 'custom').
export interface ElementInsert {
  elementId: string;
  name: string;
  code: string;
  inputSchema: ElementInput[];
  data: unknown;
  size: { w: number; h: number };
}

interface Generated {
  name: string; description: string; code: string;
  inputSchema: ElementInput[]; defaultData: unknown; size: { w: number; h: number; aspect: number };
}

// Downscale a user-supplied reference image to a light JPEG data URL for vision grounding.
async function fileToReferenceJpeg(file: File, maxDim = 1024): Promise<string | null> {
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

type Msg =
  | { id: number; role: 'user'; text: string; imageOnly?: boolean }
  | { id: number; role: 'ai'; kind: 'text'; text: string }
  | { id: number; role: 'ai'; kind: 'generating' }
  | { id: number; role: 'ai'; kind: 'element'; el: Generated; refine?: boolean; prevCode?: string }
  | { id: number; role: 'ai'; kind: 'turntokens'; input: number; output: number }
  | { id: number; role: 'ai'; kind: 'applied'; labels: string[] }
  | { id: number; role: 'ai'; kind: 'plan'; steps: string[] }
  | { id: number; role: 'ai'; kind: 'library' };

// A big multi-step turn (this many valid actions or more) is proposed as a plan to confirm, rather
// than auto-applied.
const PLAN_THRESHOLD = 5;

function greetingMsg(copilot: boolean): Extract<Msg, { kind: 'text' }> {
  return {
    id: 0, role: 'ai', kind: 'text',
    text: copilot
      ? 'Tell me what to change on this template — restyle text, move things, add tags or swipe cues, edit slides — or describe a chart/table/metric element to generate. Every change is one ⌘Z step.'
      : 'Describe an element: a chart, table, candlestick, metric card… It’s generated to fit the canvas, and data elements can be wired to automation nodes. Ask follow-ups to refine it.',
  };
}

// Only the LIGHT conversational messages survive a reload: user turns, plain AI replies, and the
// applied-changes chips. The interactive element cards carry generated code + previews tied to
// state that may have changed since — rehydrating those could
// apply an edit against stale state, and they bloat localStorage. They degrade to nothing on reload.
type LightMsg = Extract<Msg, { kind: 'text' | 'applied' }> | Extract<Msg, { role: 'user' }>;
function isLightMsg(m: Msg): m is LightMsg {
  return m.role === 'user' || (m.role === 'ai' && (m.kind === 'text' || m.kind === 'applied'));
}

// "Build with AI" — the template editor's copilot chat. With a `copilot` bridge it edits the whole
// template (the agent route plans validated actions; they apply through the editor's own
// updateSlide funnel, so every AI edit autosaves and is one ⌘Z step). Custom chart/table elements
// still go through the specialized generator (/api/elements/generate), which the agent invokes via
// a generate_element action — or directly when no bridge is passed (legacy element-only mode).
export function ElementBuilderPanel({ userId, canvas, theme, captureCanvas, onInsert, onClose, onUndoEdit, copilot }: {
  userId: string | null;
  canvas: { width: number; height: number };
  theme: ElementRenderTheme;
  captureCanvas?: () => Promise<string | null>;   // screenshot of the current template canvas (vision grounding)
  onInsert: (el: ElementInsert) => void;
  onClose: () => void;
  onUndoEdit?: () => boolean;   // undo the editor's last step; returns whether anything was undone. Surfaced as an Undo button on the latest applied card.
  copilot?: EditorCopilot;   // editor bridge — when present the chat can edit the whole template
}) {
  const { elements, loading: elementsLoading, saveElement, removeElement, renameElement, duplicateElement } = useCustomElements(userId);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');

  // Per-template chat persistence (copilot mode only) — so closing/reopening the panel or reloading
  // keeps the conversation. Captured once at mount; the panel remounts on each open.
  const threadKeyRef = useRef<string | null>(
    copilot && userId ? `de:copilot:${userId}:${copilot.getState()?.id ?? 'none'}` : null,
  );
  const [messages, setMessages] = useState<Msg[]>(() => {
    const key = threadKeyRef.current;
    if (key) {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw) as Msg[];
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      } catch { /* ignore corrupt/oversized */ }
    }
    return [greetingMsg(!!copilot)];
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');   // phase text shown next to the loading mascot
  const [attachedImage, setAttachedImage] = useState<string | null>(null);   // data URL, rides the next send
  const attachInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);   // lets the Stop button cancel an in-flight turn
  const [undoneIds, setUndoneIds] = useState<Set<number>>(() => new Set());   // applied cards whose Undo has been used
  const pendingPlansRef = useRef<Map<number, AgentAction[]>>(new Map());   // proposed plans awaiting Apply/Discard (by message id)
  const streaming = useStreamingBuffer();   // live reply prose, throttled, kept out of `messages`
  const [lastUsage, setLastUsage] = useState<TokenUsage | null>(null);   // tokens of the latest copilot turn
  const [totalTokens, setTotalTokens] = useState(0);   // running session total (input + output across turns)
  const [waitTick, setWaitTick] = useState(0);         // gently escalates the "thinking" beat on slow turns
  const [menuOpen, setMenuOpen] = useState(false);     // the "+" upload popover in the composer
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);
  // Measure the floating composer so the chat reserves clearance below AND fades exactly across it.
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(132);
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setComposerH(el.offsetHeight));
    ro.observe(el);
    setComposerH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);
  const cmdMenu = useCommandMenu({
    commands: copilot ? CAROUSEL_COMMANDS : [],   // shortcuts only make sense in template-editing mode
    getSlides: () => copilot?.getState()?.slides ?? [],
    inputRef,
    setValue: setInput,
  });
  const idRef = useRef(1);
  // Seed the id counter past any restored messages so new ids never collide (mount-only).
  useEffect(() => {
    idRef.current = messages.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Persist the light conversation on every change (capped, debounce-free — it's tiny).
  useEffect(() => {
    const key = threadKeyRef.current;
    if (!key) return;
    const light = messages.filter(isLightMsg);
    try {
      if (light.length <= 1) localStorage.removeItem(key);   // nothing but the greeting → no thread
      else localStorage.setItem(key, JSON.stringify(light.slice(-40)));
    } catch { /* quota / disabled storage — non-fatal */ }
  }, [messages]);
  const lastCodeRef = useRef<string | undefined>(undefined);   // for multi-turn refine
  const lastElRef = useRef<{ code: string; data: unknown; size: { w: number; h: number } } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Render the last element to an offscreen canvas → PNG data URL, so the model can critique its own
  // output from real pixels (§4.3). Best-effort.
  function renderElementImage(): string | undefined {
    const el = lastElRef.current;
    if (!el) return undefined;
    try {
      const c = document.createElement('canvas');
      c.width = el.size.w; c.height = el.size.h;
      const ctx = c.getContext('2d');
      if (!ctx) return undefined;
      renderCustomElement(ctx, el.code, { width: el.size.w, height: el.size.h, progress: 1, t: 0, data: el.data, theme });
      return c.toDataURL('image/png');
    } catch { return undefined; }
  }
  const seededLibrary = useRef(false);

  // Surface the saved-element library as the first AI message once it has loaded (once).
  useEffect(() => {
    if (seededLibrary.current || elements.length === 0) return;
    seededLibrary.current = true;
    setMessages(prev => [{ id: -1, role: 'ai', kind: 'library' }, ...prev]);
  }, [elements.length]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages, busy, streaming.text]);

  // Closing the panel mid-turn should cancel the in-flight request — otherwise a late response would
  // still apply an edit (and pulse the canvas) after the copilot is gone, and burn a metered call.
  useEffect(() => () => abortRef.current?.abort(), []);

  // The specialized custom-element pipeline (charts/tables/…): vision grounding via the canvas
  // screenshot (placement/theme) and, when refining, the current element's render (critique).
  // refine=false starts FRESH (clears the previous element's code so an unrelated ask doesn't
  // mutate the last element instead of creating a new one).
  async function generateElement(prompt: string, refine = true): Promise<void> {
    // A refine continues from the previous element's code; capture it BEFORE any reset so the result can
    // show a diff of just what changed.
    const prevCode = refine ? lastCodeRef.current : undefined;
    if (!refine) { lastCodeRef.current = undefined; lastElRef.current = null; }
    setStatus('Designing the element…');
    // A "Generating…" pending block while the (buffered) generator writes the code.
    const genMsgId = idRef.current++;
    setMessages(prev => [...prev, { id: genMsgId, role: 'ai', kind: 'generating' }]);
    try {
      const [canvasImage, renderImage] = [captureCanvas ? await captureCanvas() : null, renderElementImage()];
      const res = await authedFetch('/api/elements/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current?.signal,
        body: JSON.stringify({
          prompt,
          canvas,
          box: { w: Math.round(canvas.width * 0.7), h: Math.round(canvas.height * 0.4) },
          previousCode: prevCode,
          canvasImage: canvasImage ?? undefined,
          renderImage: renderImage ?? undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Generation failed');
      const el = json as Generated;
      lastCodeRef.current = el.code;
      lastElRef.current = { code: el.code, data: el.defaultData, size: el.size };
      // Replace the pending block with the finished element (a diff when this was a refine).
      setMessages(prev => prev.map(m => (m.id === genMsgId ? { id: genMsgId, role: 'ai', kind: 'element', el, refine: !!prevCode, prevCode } : m)));
    } catch (e) {
      setMessages(prev => prev.filter(m => m.id !== genMsgId));   // drop the pending block; the caller surfaces the error
      throw e;
    }
  }

  // The copilot path: send the chat + the template's compact state to the agent route; apply the
  // validated actions it returns through the editor bridge (each one an undoable editor step).
  // generate_element actions route back into the element pipeline above.
  async function runCopilot(prompt: string, image: string | null, base: Msg[]): Promise<void> {
    const state = copilot?.getState();
    if (!copilot || !state) {
      // No template loaded yet — behave like the legacy element builder.
      await generateElement(prompt);
      return;
    }
    // Rebuild a text-only history for the model (element/library cards become short markers),
    // trimmed to the route's caps: last 12 entries, each clamped well under the 8k content limit —
    // otherwise long sessions would start 400ing at the request validator. `base` is the conversation
    // BEFORE this turn's user message (passed explicitly so retry/edit don't read stale state).
    const history = [...base, { id: -99, role: 'user' as const, text: prompt }]
      .map(m => {
        if (m.role === 'user') return { role: 'user' as const, content: m.text };
        if (m.kind === 'text') return { role: 'assistant' as const, content: m.text };
        if (m.kind === 'element') return { role: 'assistant' as const, content: `[generated custom element "${m.el.name}"]` };
        if (m.kind === 'applied') return { role: 'assistant' as const, content: `[applied: ${m.labels.join('; ')}]` };
        return null;   // library card — not conversation
      })
      .filter((m): m is { role: 'user' | 'assistant'; content: string } => m !== null)
      .slice(-12)
      .map(m => ({ ...m, content: m.content.slice(0, 4000) }));

    setStatus(image ? 'Looking at your image…' : 'Reading your template…');
    const res = await authedFetch('/api/editor/agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: abortRef.current?.signal,
      body: JSON.stringify({ messages: history, template: state, brand: copilot.getBrand(), image: image ?? undefined }),
    });
    // Pre-stream failures (budget/rate/validation) come back as a normal JSON error.
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error((j as { error?: string }).error ?? 'Copilot failed'); }

    // Stream the reply prose token-by-token; the validated actions arrive whole on the terminal event.
    const { final: fin, error: streamError, replyText } = await readCopilotStream<{ reply?: string; actions?: unknown[]; warnings?: string[]; usage?: TokenUsage }>(
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
      return;
    }
    if (!fin) {
      // Stream ended with no terminal frame (e.g. a dropped connection) — surface it instead of a silent no-op.
      keepStreamed();
      setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: 'The reply was cut off before it finished — please try again.' }]);
      return;
    }
    if (fin.usage) { const u = fin.usage; setLastUsage(u); setTotalTokens(t => t + u.input + u.output); }
    // The per-turn token block closes out a turn — emitted LAST (after the reply + any applied/plan/element
    // cards) so it reads as this turn's receipt on the rail. No-op when the turn carried no usage.
    const emitTurnTokens = () => {
      const u = fin.usage;
      if (u) setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'turntokens', input: u.input, output: u.output }]);
    };
    setStatus('Applying changes…');

    const finalReply = fin.reply;
    if (finalReply) {
      setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: finalReply }]);
    }
    // Validate the actions up front so we can both preview a plan and apply the same list.
    const valid: AgentAction[] = [];
    const parseProblems: string[] = Array.isArray(fin.warnings) ? [...fin.warnings] : [];
    for (const raw of Array.isArray(fin.actions) ? fin.actions : []) {
      const parsed = zAgentAction.safeParse(raw);
      if (parsed.success) valid.push(parsed.data);
      else parseProblems.push('The AI proposed an invalid change (skipped).');
    }
    // A big multi-step change → propose a plan and wait for Apply, rather than auto-applying.
    if (valid.length >= PLAN_THRESHOLD) {
      const planId = idRef.current++;
      pendingPlansRef.current.set(planId, valid);
      setMessages(prev => [...prev, { id: planId, role: 'ai', kind: 'plan', steps: valid.map(describeAction) }]);
      if (parseProblems.length > 0) setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: `⚠ ${parseProblems.join(' · ')}` }]);
      emitTurnTokens();
      return;
    }
    await applyActions(valid, parseProblems);
    emitTurnTokens();
  }

  // Apply a validated action list through the editor bridge. Batches consecutive edit-actions through
  // applyAll (it threads a working copy so same-turn edits never clobber each other); generate_element
  // flushes the batch first and routes into the element pipeline. Appends the applied/warning cards.
  async function applyActions(actions: AgentAction[], seedProblems: string[]) {
    const cp = copilot;
    if (!cp) return;
    const labels: string[] = [];
    const problems: string[] = [...seedProblems];
    let batch: Parameters<typeof cp.applyAll>[0] = [];
    const flushBatch = async () => {
      if (batch.length === 0) return;
      const result = await cp.applyAll(batch);
      labels.push(...result.labels);
      problems.push(...result.problems);
      batch = [];
    };
    try {
      for (const action of actions) {
        if (action.type === 'generate_element') {
          await flushBatch();
          try {
            await generateElement(action.prompt, action.refine === true);
            labels.push('Generated a custom element (Insert to place it)');
          } catch (e) {
            // A user Stop aborts this sub-fetch too — let it bubble to the caller (calm "Stopped." and
            // halts the rest of the batch) instead of downgrading it to a warning and carrying on.
            if (e instanceof DOMException && e.name === 'AbortError') throw e;
            problems.push(e instanceof Error ? e.message : 'Element generation failed.');
          }
        } else {
          batch.push(action);
        }
      }
      await flushBatch();
    } finally {
      // Emit the cards for whatever ALREADY committed, even if an abort rethrows mid-batch. A Stop during a
      // trailing generate would otherwise drop the applied card for edits already live on the canvas — losing
      // their transcript record (which the next turn's history + reload read from) and their card-level Undo.
      if (labels.length > 0) setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'applied', labels }]);
      if (problems.length > 0) setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: `⚠ ${problems.join(' · ')}` }]);
    }
  }

  // Confirm a proposed plan: apply its stashed actions (with the same Stop/undo affordances a normal
  // turn has). Removes the plan card first so it can't be applied twice.
  async function applyPlan(id: number) {
    if (busy) return;
    const actions = pendingPlansRef.current.get(id);
    if (!actions) return;
    pendingPlansRef.current.delete(id);
    // The plan turn's token receipt was emitted right after the plan card (so it carries a higher id). Lift it
    // out with the plan card and re-emit it after the applied card, so it still TRAILS the turn instead of
    // stranding above the result. Applying runs no new model call, so the same counts are reused (no double-
    // count — the session total already includes them).
    const receipt = messages.find((m): m is Extract<Msg, { kind: 'turntokens' }> =>
      m.role === 'ai' && m.kind === 'turntokens' && m.id > id) ?? null;
    setMessages(prev => prev.filter(m => m.id !== id && m.id !== receipt?.id));
    setBusy(true);
    abortRef.current = new AbortController();
    try {
      await applyActions(actions, []);
      if (receipt) setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'turntokens', input: receipt.input, output: receipt.output }]);
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: aborted ? 'Stopped.' : (e instanceof Error ? e.message : 'Something went wrong') }]);
    }
    abortRef.current = null;
    setStatus('');
    setBusy(false);
  }

  function discardPlan(id: number) {
    if (busy) return;
    pendingPlansRef.current.delete(id);
    setMessages(prev => prev.map(m => (m.id === id ? { id, role: 'ai', kind: 'text', text: 'Okay, discarded — nothing changed.' } : m)));
  }

  // A pending plan is only valid for the turn that produced it — starting a new turn sets it aside so
  // its now-stale actions can't be applied over the edits since (they were validated at turn time).
  function invalidatePendingPlans() {
    if (pendingPlansRef.current.size === 0) return;
    const ids = new Set(pendingPlansRef.current.keys());
    pendingPlansRef.current.clear();
    setMessages(prev => prev.map(m => (ids.has(m.id) && m.role === 'ai' && m.kind === 'plan'
      ? { id: m.id, role: 'ai' as const, kind: 'text' as const, text: 'Set that plan aside — ask again to regenerate it.' }
      : m)));
  }

  async function attachImageFile(file: File) {
    if (!file.type.startsWith('image/')) return;
    const jpeg = await fileToReferenceJpeg(file);
    if (jpeg) setAttachedImage(jpeg);
  }

  function stop() {
    abortRef.current?.abort();
  }

  // Runs one copilot turn against `base` (the conversation before this turn's user message). The user
  // bubble is expected to already be shown by the caller — this only runs the request + shows results.
  async function runTurn(prompt: string, image: string | null, base: Msg[]) {
    invalidatePendingPlans();   // a new turn supersedes any un-applied plan
    setBusy(true);
    abortRef.current = new AbortController();
    try {
      if (copilot) await runCopilot(prompt || 'Use the attached image.', image, base);
      else await generateElement(prompt);
    } catch (e) {
      // A user-initiated Stop aborts the fetch → surface a calm note, not an error.
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: aborted ? 'Stopped.' : (e instanceof Error ? e.message : 'Something went wrong') }]);
    }
    abortRef.current = null;
    streaming.reset();   // drop any partial live bubble (e.g. after an aborted stream)
    setStatus('');
    setBusy(false);
  }

  async function send(override?: string) {
    const prompt = (override ?? input).trim();
    if ((!prompt && !attachedImage) || busy) return;
    const image = attachedImage;
    if (override === undefined) setInput('');
    setAttachedImage(null);
    const base = messages;   // history BEFORE this turn (the user bubble is appended below)
    const imageOnly = !prompt && !!image;
    setMessages([...base, { id: idRef.current++, role: 'user', text: prompt || (image ? '🖼️ (image attached)' : ''), ...(imageOnly ? { imageOnly: true } : {}) }]);
    await runTurn(prompt, image, base);
  }

  // Retry: re-run the last user message (drop that turn's AI responses first). Images aren't retried
  // (they aren't kept in the transcript), so an image-only turn is un-retryable. No-op while busy.
  function retry() {
    if (busy) return;
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].role === 'user') { idx = i; break; } }
    if (idx === -1) return;
    const um = messages[idx];
    if (um.role !== 'user' || um.imageOnly) return;
    const text = um.text;
    if (!text.trim()) return;
    const base = messages.slice(0, idx);       // conversation before that user message
    setMessages(messages.slice(0, idx + 1));   // keep the user bubble, drop the old AI responses
    void runTurn(text, null, base);
  }

  // Edit & resend: pull a past user message back into the input and rewind the conversation to just
  // before it, so sending re-runs from that point.
  function editMessage(id: number) {
    if (busy) return;
    const idx = messages.findIndex(m => m.id === id);
    if (idx === -1 || messages[idx].role !== 'user') return;
    const um = messages[idx];
    pendingPlansRef.current.clear();   // rewinding the conversation invalidates any pending plan
    setInput(um.role === 'user' ? um.text : '');
    setMessages(messages.slice(0, idx));
    inputRef.current?.focus();
  }

  // Undo the editor's last step (the just-applied turn). Only notes "Reverted" when an undo actually
  // happened (so it never lies on a no-op), and marks the card so its Undo button doesn't linger.
  function undoLastEdit(id: number) {
    if (!onUndoEdit || busy) return;
    if (!onUndoEdit()) return;
    setUndoneIds(prev => new Set(prev).add(id));
    setMessages(prev => [...prev, { id: idRef.current++, role: 'ai', kind: 'text', text: '↩ Reverted that change.' }]);
  }

  async function insertGenerated(g: Generated) {
    const rec = await saveElement({
      name: g.name, description: g.description, code: g.code,
      inputSchema: g.inputSchema, defaultData: g.defaultData, size: g.size,
    });
    const elementId = rec?.id ?? `local_${Date.now()}`;
    onInsert({ elementId, name: g.name, code: g.code, inputSchema: g.inputSchema, data: g.defaultData, size: g.size });
  }

  // Copilot mode, nothing said yet, and no saved-element library to show → the welcome empty state.
  // Gated on the library fetch having settled: otherwise we'd flash the onboarding chips on first
  // paint (elements still []), then swap them for the saved-elements grid once the fetch lands.
  // A returning user with saved elements gets their library grid instead (that's their launchpad).
  const conversationEmpty = messages.filter(m => !(m.role === 'ai' && m.kind === 'library')).length <= 1;
  const isEmptyState = !!copilot && !elementsLoading && elements.length === 0
    && messages.length === 1 && messages[0].role === 'ai' && messages[0].kind === 'text';
  const greetingText = isEmptyState ? (messages[0] as Extract<Msg, { kind: 'text' }>).text : '';
  // While the library is still loading on a fresh thread, hold a calm mascot beat (no chips, no
  // bubble) so nothing flickers before we know whether there's a library to show.
  const showLoadingBeat = !!copilot && elementsLoading && conversationEmpty;
  // Follow-up chips appear only when the AI just applied an edit. Every turn now closes with a 'turntokens'
  // receipt, so look past it to the turn's last real content block.
  const last = messages[messages.length - 1];
  const lastContent = messages.reduce<Msg | undefined>((acc, m) => (m.role === 'ai' && m.kind === 'turntokens' ? acc : m), undefined);
  const showFollowUps = !!copilot && !busy && lastContent?.role === 'ai' && lastContent.kind === 'applied';
  // Retry: offered once a turn has settled (last message is from the AI) and there's a re-runnable
  // user turn (image-only turns can't be retried — the image isn't kept).
  const lastUserMsg = messages.filter((m): m is Extract<Msg, { role: 'user' }> => m.role === 'user').at(-1);
  const showRetry = !!copilot && !busy && !streaming.text && last?.role === 'ai' && !!lastUserMsg && !lastUserMsg.imageOnly;
  // The latest applied card gets the Undo affordance (found by kind, so a trailing warning/note after
  // it doesn't hide it).
  const lastAppliedIndex = messages.reduce((acc, m, i) => (m.role === 'ai' && m.kind === 'applied' ? i : acc), -1);
  const inputPlaceholder = useRotatingPlaceholder(
    copilot ? 'Ask for any change — or paste a table / reference image…' : 'Describe or refine an element…',
    copilot ? EXAMPLE_PROMPTS : [],
    input.length > 0 || busy || !!attachedImage,
  );

  // Rail bookkeeping: the trailing live block (streaming reply or "thinking") connects up to the last
  // message only if it's an on-rail AI block.
  const lastMsg = messages[messages.length - 1];
  const onRailLast = !!lastMsg && lastMsg.role === 'ai' && lastMsg.kind !== 'library';
  // A generating block is its OWN live tail, so it suppresses the separate trailing "working" row (below) —
  // keep trailingLive false in that case so the generating block doesn't draw a segment into a gap.
  const midGenerate = !!lastMsg && lastMsg.role === 'ai' && lastMsg.kind === 'generating';
  const trailingLive = !!streaming.text || (busy && !streaming.text && !midGenerate);
  // While we wait for the model's first token, escalate the "thinking" beat in two gentle steps so a slow
  // turn reads as live progress instead of a frozen label. Fast turns (first token < 1.6s) never advance,
  // so nothing changes for them. Timers are cleared whenever the wait ends (token arrives / turn settles).
  const waiting = busy && !streaming.text && !midGenerate;
  useEffect(() => {
    if (!waiting) { setWaitTick(0); return; }
    const t1 = setTimeout(() => setWaitTick(1), 1600);
    const t2 = setTimeout(() => setWaitTick(2), 3600);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [waiting]);
  // The beat's label: the specific status first, then softer "still working" phrasing as the wait grows.
  const beatLabel = status && waitTick === 0
    ? status
    : waitTick >= 2 ? 'Still working on it…' : waitTick === 1 ? 'Thinking it through…' : (status || (copilot ? 'Thinking…' : 'Generating…'));
  // A single ghost-text follow-up shown in the empty input after an applied edit; Tab types it.
  const suggestion = copilot && showFollowUps && !input.trim() ? FOLLOW_UPS[0] : null;
  const clearance = composerH + 28;   // bottom padding so the newest message clears the floating composer
  const fadeBand = composerH + 20;    // mask height: the chat fades exactly across the composer
  const maskImage = `linear-gradient(to bottom, black calc(100% - ${fadeBand}px), transparent)`;

  // Render one AI timeline block (text / applied / plan / generated element). The off-rail kinds (user,
  // library) are handled inline in the list. Closes over the editor handlers, so it lives here.
  const renderAi = (m: Exclude<Extract<Msg, { role: 'ai' }>, { kind: 'library' }>, i: number): ReactNode => {
    if (m.kind === 'text') {
      return <Message from="assistant"><MessageContent><MessageResponse>{m.text}</MessageResponse></MessageContent></Message>;
    }
    if (m.kind === 'generating') {
      return <div className="flex items-center gap-2 text-[13px]"><Sparkle active size={16} /><Shimmer duration={1}>Generating an element…</Shimmer></div>;
    }
    if (m.kind === 'turntokens') {
      // The per-prompt cost, inline at the end of the turn — muted so it reads as metadata, not a message.
      return <div className="pt-0.5"><TurnTokens usage={{ input: m.input, output: m.output }} className="opacity-70" /></div>;
    }
    if (m.kind === 'applied') {
      const canUndoThis = i === lastAppliedIndex && !undoneIds.has(m.id);
      return (
        <Task defaultOpen>
          <TaskTrigger title={`Applied ${m.labels.length} edit${m.labels.length === 1 ? '' : 's'}`} />
          <TaskContent>
            {m.labels.map((label, j) => <TaskItem key={j}>✓ {label}</TaskItem>)}
          </TaskContent>
          {/* Undo lives OUTSIDE the collapsible content so it stays visible when the card is collapsed. */}
          <div className="mt-1.5 flex items-center gap-2 text-[12px]">
            <span className="text-fg-4">⌘Z undoes each step</span>
            {canUndoThis && onUndoEdit && !busy && (
              <button type="button" onClick={() => undoLastEdit(m.id)} className="text-fg-3 underline decoration-line-strong underline-offset-2 hover:text-fg focus-ring">Undo</button>
            )}
          </div>
        </Task>
      );
    }
    if (m.kind === 'plan') {
      const pending = pendingPlansRef.current.has(m.id);
      return (
        <Plan defaultOpen className="mb-0">
          <PlanHeader>
            <PlanTitle>Here’s my plan</PlanTitle>
            <PlanDescription>{`${m.steps.length} step${m.steps.length === 1 ? '' : 's'}`}</PlanDescription>
            <PlanTrigger />
          </PlanHeader>
          <PlanContent>
            <ol className="ml-4 list-decimal space-y-1 text-[13px] text-fg-2">{m.steps.map((s, j) => <li key={j}>{s}</li>)}</ol>
          </PlanContent>
          <PlanFooter>
            {pending && !busy ? (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => void applyPlan(m.id)}>Apply all</Button>
                <button type="button" onClick={() => discardPlan(m.id)} className="text-[11px] text-fg-3 hover:text-fg focus-ring">Discard</button>
              </div>
            ) : <span className="text-[11px] text-fg-4">Set aside</span>}
          </PlanFooter>
        </Plan>
      );
    }
    // generated element (fresh → whole code block; a refine → a diff of just what changed)
    return (
      <div className="flex flex-col gap-2">
        <div className="text-[13px] text-fg">{m.refine ? 'Updated' : 'Generated'} {m.el.name}</div>
        <ElementPreview code={m.el.code} data={m.el.defaultData} size={m.el.size} theme={theme} displayW={250} animate />
        {m.el.description && <div className="text-caption text-fg-3">{m.el.description}</div>}
        {m.el.inputSchema.length > 0 && <div className="text-[11px] text-fg-4">Data inputs: {m.el.inputSchema.map(x => x.key).join(', ')}</div>}
        {m.refine && m.prevCode
          ? <CodeDiff oldCode={m.prevCode} newCode={m.el.code} title={`${m.el.name} element`} />
          : <CodeBlock code={m.el.code} title={`${m.el.name} element`} />}
        <Button size="sm" variant="primary" onClick={() => void insertGenerated(m.el)}>Insert</Button>
      </div>
    );
  };

  return (
    <aside className="de-panel-in-left flex h-full w-[340px] shrink-0 flex-col overflow-hidden border-r border-line bg-surface-1">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4" style={{ height: 52 }}>
        <span className="text-fg-2"><Sparkle active={busy} size={18} strokeWidth={1} /></span>
        <span className="text-label font-semibold text-fg">Build with AI</span>
        {copilot && messages.some(m => m.role === 'user') && (
          <button
            aria-label="New chat"
            title="Clear this conversation"
            disabled={busy}
            onClick={() => {
              setMessages([greetingMsg(true)]);
              idRef.current = 1;
              setUndoneIds(new Set());
              setLastUsage(null);
              setTotalTokens(0);
              pendingPlansRef.current.clear();
              lastCodeRef.current = undefined;
              lastElRef.current = null;
              try { if (threadKeyRef.current) localStorage.removeItem(threadKeyRef.current); } catch { /* ignore */ }
            }}
            className="ml-auto grid size-7 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg focus-ring disabled:opacity-40"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
          </button>
        )}
        <button aria-label="Close" onClick={onClose} className={`${copilot && messages.some(m => m.role === 'user') ? '' : 'ml-auto'} grid size-7 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg focus-ring`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* The chat fills the panel; a bottom gradient MASK fades it out as it scrolls behind the floating composer. */}
        <div className="h-full overflow-hidden" style={{ WebkitMaskImage: maskImage, maskImage }}>
        <div ref={scrollRef} className="no-native-scrollbar flex h-full flex-col gap-0 overflow-y-auto p-4" style={{ paddingBottom: clearance }}>
        {/* Library still loading on a fresh thread: a calm mascot beat so the onboarding chips don't
            flash and then get swapped for the saved-elements grid. */}
        {showLoadingBeat ? (
          <div className="flex flex-1 flex-col items-center justify-center">
            <Sparkle size={30} strokeWidth={1.25} />
          </div>
        ) : /* Empty state (copilot mode, nothing said yet): a friendly idle mascot + the greeting +
            one-tap example prompts that pre-fill and send. */
        isEmptyState ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-2 text-center">
            <Sparkle size={30} strokeWidth={1.25} />
            <p className="max-w-[240px] text-[13px] leading-relaxed text-fg-3">{greetingText}</p>
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
          // OFF-RAIL: your messages break the thread — a flush-left bubble with no rail node.
          if (m.role === 'user') {
            return (
              <div key={m.id} className="group flex flex-col items-start gap-0.5 pb-6">
                <div className="de-msg-in w-fit max-w-[88%] rounded-lg bg-surface-2 px-3 py-2 text-[13px] font-medium text-fg">{m.text}</div>
                {!busy && (
                  <button type="button" onClick={() => editMessage(m.id)}
                    className="text-[10px] text-fg-4 opacity-0 transition-opacity hover:text-fg-2 focus-visible:opacity-100 group-hover:opacity-100 focus-ring">Edit</button>
                )}
              </div>
            );
          }
          // OFF-RAIL: the saved-elements library grid.
          if (m.kind === 'library') {
            if (elements.length === 0) return null;
            return (
              <div key={m.id} className="flex flex-col gap-1.5 pb-6">
                <span className="text-caption text-fg-3">Your saved elements</span>
                <div className="grid grid-cols-2 gap-2">
                  {elements.map(el => (
                    <div key={el.id} className="group relative flex flex-col items-center gap-1 rounded-md border border-line p-2">
                      <button onClick={() => onInsert({ elementId: el.id, name: el.name, code: el.code, inputSchema: el.inputSchema, data: el.defaultData, size: el.size })}
                        title={`Insert ${el.name}`} className="focus-ring">
                        <ElementPreview code={el.code} data={el.defaultData} size={el.size} theme={theme} displayW={110} />
                      </button>
                      {renamingId === el.id ? (
                        <input autoFocus value={renameVal}
                          onChange={e => setRenameVal(e.target.value)}
                          onBlur={() => { void renameElement(el.id, renameVal); setRenamingId(null); }}
                          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenamingId(null); }}
                          className="w-full rounded bg-surface-3 px-1 py-0.5 text-center text-[11px] text-fg outline-none focus-ring" />
                      ) : (
                        <button onClick={() => { setRenameVal(el.name); setRenamingId(el.id); }} title="Rename"
                          className="w-full truncate text-center text-[11px] text-fg-3 hover:text-fg focus-ring">{el.name}</button>
                      )}
                      <div className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
                        <button aria-label={`Duplicate ${el.name}`} onClick={() => void duplicateElement(el.id)}
                          className="grid size-5 place-items-center rounded bg-surface-overlay text-fg-3 hover:text-fg">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
                        </button>
                        <button aria-label={`Delete ${el.name}`} onClick={() => void removeElement(el.id)}
                          className="grid size-5 place-items-center rounded bg-surface-overlay text-fg-3 hover:text-danger-text">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          // ON-RAIL: AI timeline blocks (text / applied / plan / generated element).
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const railPrev = !!prev && prev.role === 'ai' && prev.kind !== 'library';
          const isLast = i === messages.length - 1;
          const railNext = next ? (next.role === 'ai' && next.kind !== 'library') : (isLast && trailingLive);
          // Keep the inter-row gap under the final card when follow-ups / retry trail it (they're off-rail).
          const spaced = !(isLast && !trailingLive && !showFollowUps && !showRetry);
          return (
            <TimelineRow key={m.id} node={aiNode(m)} showTop={railPrev} showBottom={railNext} spaced={spaced}>
              {renderAi(m, i)}
            </TimelineRow>
          );
        })}
        {/* Live reply — streaming token-by-token until committed to `messages` on done. */}
        {streaming.text && (
          <TimelineRow node={LIVE_NODE} showTop={onRailLast} showBottom={false} spaced={false}>
            <Message from="assistant"><MessageContent>{streaming.text}</MessageContent></Message>
          </TimelineRow>
        )}
        {/* Working — the thinking beat (a label carries the signal under reduced motion). Hidden once the
            reply starts streaming — the live block then carries it — and while an element is generating
            (its own 'generating' block on the rail is the live indicator, so this would double up). */}
        {busy && !streaming.text && !midGenerate && (
          <TimelineRow node={LIVE_NODE} showTop={onRailLast} showBottom={false} spaced={false}>
            <div className="flex items-center gap-2 text-[13px]"><Sparkle active size={16} /><Shimmer duration={1}>{beatLabel}</Shimmer></div>
          </TimelineRow>
        )}
        {/* Follow-ups are now shown as a single ghost-text suggestion in the composer input (Tab to accept). */}
        {/* Retry the last user message (re-runs after dropping that turn's AI responses). */}
        {showRetry && (
          <button type="button" onClick={retry} className="ml-7 mt-1 self-start text-[11px] text-fg-4 transition-colors hover:text-fg-2 focus-ring">↻ Retry</button>
        )}
        </div>
        </div>

        {/* Floating composer cluster — sits OVER the chat (which scrolls + fades behind it). */}
        <div ref={composerRef} className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-col gap-2">
        {cmdMenu.menu && <div className="pointer-events-auto"><CommandMenu items={cmdMenu.menu.items} index={cmdMenu.menu.index} onSelect={cmdMenu.select} onHover={cmdMenu.setIndex} /></div>}
        {/* Composer card — an optional attachment row, the textbox, and a toolbar, divided by hairlines. */}
        <div className="pointer-events-auto flex flex-col rounded-2xl border border-line-strong bg-surface-2 shadow-[0_12px_38px_-8px_rgba(0,0,0,0.78)] focus-within:border-fg-3">
          <input ref={attachInputRef} type="file" accept="image/*" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void attachImageFile(f); if (attachInputRef.current) attachInputRef.current.value = ''; }} />
          {/* box above — the attached image, shown as a chip */}
          {attachedImage && (
            <div className="border-b border-line px-2.5 pb-2 pt-2.5">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-surface-3 py-1 pl-1.5 pr-1 text-[11px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={attachedImage} alt="attachment" className="size-4 rounded object-cover" />
                <span className="font-medium text-fg-2">Image attached</span>
                <button type="button" onClick={() => setAttachedImage(null)} aria-label="Remove image"
                  className="ml-0.5 grid size-4 place-items-center rounded text-fg-4 hover:bg-hover hover:text-fg focus-ring">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </span>
            </div>
          )}
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
              // Tab (forward only) accepts the ghost-text follow-up; Shift+Tab is left for normal focus traversal.
              if (e.key === 'Tab' && !e.shiftKey && suggestion && !input.trim()) { e.preventDefault(); setInput(suggestion); return; }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
            onBlur={() => cmdMenu.close()}
            onPaste={e => {
              if (!copilot) return;
              const img = Array.from(e.clipboardData.items).find(it => it.type.startsWith('image/'));
              const file = img?.getAsFile();
              if (file) { e.preventDefault(); void attachImageFile(file); }
            }}
            rows={1}
            placeholder={suggestion ?? inputPlaceholder}
            // The card shows focus via focus-within; suppress the textarea's own (unlayered) global outline.
            style={{ outline: 'none' }}
            className="max-h-32 w-full resize-none bg-transparent px-3 pb-2 pt-2.5 text-[13px] leading-relaxed text-fg placeholder:text-fg-4 disabled:opacity-60"
          />
          <div className="flex items-center gap-2 border-t border-line px-2.5 py-2">
            {copilot && (
              <div ref={menuRef} className="relative">
                <button type="button" onClick={() => setMenuOpen(o => !o)} disabled={busy} aria-haspopup="menu" aria-expanded={menuOpen} title="Add" aria-label="Add"
                  className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-3 hover:bg-hover hover:text-fg disabled:opacity-40 focus-ring">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
                </button>
                {menuOpen && (
                  <div role="menu" className="absolute bottom-full left-0 z-10 mb-2 w-52 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-[0_16px_44px_-10px_rgba(0,0,0,0.85)]">
                    {/* One item only, on purpose — the copilot only accepts image references. */}
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); attachInputRef.current?.click(); }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-fg-2 hover:bg-hover hover:text-fg focus-ring">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-fg-3" aria-hidden><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
                      Upload image
                    </button>
                  </div>
                )}
              </div>
            )}
            {copilot && lastUsage && <ContextRing usage={lastUsage} />}
            {suggestion && <span className="shrink-0 text-[10px] text-fg-4">⇥ Tab</span>}
            <div className="ml-auto flex items-center gap-2.5">
              {busy ? (
                <button type="button" onClick={stop} aria-label="Stop"
                  className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-2 hover:bg-hover hover:text-fg focus-ring">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
                </button>
              ) : (
                <button type="button" onClick={() => void send()} disabled={!input.trim() && !attachedImage} aria-label="Send"
                  className="grid size-7 shrink-0 place-items-center rounded-lg text-fg transition-colors disabled:text-fg-4 focus-ring">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" /></svg>
                </button>
              )}
            </div>
          </div>
        </div>
        {/* running session total + a one-line hint */}
        <div className="pointer-events-auto mt-2 flex items-center justify-between gap-2 px-1">
          {copilot && totalTokens > 0 ? <TotalTokens total={totalTokens} /> : <span />}
          <span className="text-[10px] text-fg-4">{copilot ? 'Edits apply instantly · ⌘Z to undo' : 'Insert adds it to the canvas'}</span>
        </div>
        </div>
      </div>
    </aside>
  );
}
