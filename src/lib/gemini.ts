import { fetchWithTimeout } from './http';
import { hasAiBudget, recordAiSpend, resolvePeriod, costMicros, type GeminiUsageMetadata } from './aiBudget';
import { AI_MOCK, mockGenericText, mockDeltas } from './aiMock';
import {
  type ChatMessage, type ChatOpts, type StreamOpts,
  ALLOWED_MODELS, providerForModel, parseErrorBody,
} from './llm/providers';

// The LLM funnel. Despite the historical name, geminiChat / openGeminiStream are provider-AGNOSTIC: they
// resolve the model, pick its provider (Gemini or an OpenAI-compatible backend like Xiaomi MiMo — see
// lib/llm/providers.ts), and run the SHARED machinery — AI_MOCK, the per-user monthly budget gate, retry,
// stream abort + idle-timeout, and spend metering — around it. Only request-building and response-parsing
// differ per vendor, and those are isolated in the provider. Every call is metered here, so no provider
// can spend unmetered.

export type { ChatMessage } from './llm/providers';
export { CONTEXT_WINDOW } from './llm/providers';

// The env default model for the buffered/batch callers. Ignored (falls back to the default) unless it's
// allow-listed, so a typo can't reach a bad model id. Flash-LITE is the default: the batch callers are
// BUFFERED (not streamed), so flash-lite's stream-drop weakness never applies here, and it's far cheaper.
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const MODEL = process.env.GEMINI_MODEL && ALLOWED_MODELS.has(process.env.GEMINI_MODEL)
  ? process.env.GEMINI_MODEL
  : DEFAULT_MODEL;

// The interactive copilots emit STRUCTURED JSON over a LIVE stream, where a mid-stream drop surfaces to
// the user as "the model returned an unreadable response". gemini-2.5-flash-lite intermittently truncates
// such streams — ~1 in 4 on multi-action asks, finishReason undefined, well under the token cap (measured)
// — while gemini-2.5-flash is reliable. The copilots' outputs are tiny (~hundreds of tokens), so flash's
// higher rate costs ~$0.001/call. So the copilots PIN flash regardless of GEMINI_MODEL (which stays free to
// select a cheaper tier for the buffered/batch callers). Override with COPILOT_MODEL to A/B another model
// (e.g. an allow-listed MiMo id) once a run proves it reliable.
export const COPILOT_MODEL = process.env.COPILOT_MODEL && ALLOWED_MODELS.has(process.env.COPILOT_MODEL)
  ? process.env.COPILOT_MODEL
  : 'gemini-2.5-flash';

/** Resolve the model for a call: the caller's choice if allow-listed, else the env/default model. */
function resolveModel(optModel?: string): string {
  return optModel && ALLOWED_MODELS.has(optModel) ? optModel : MODEL;
}

export class GeminiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GeminiError';
  }
}

/** The per-user monthly credit gate. A subclass so retry loops can tell "your budget is spent" (hopeless
 *  until the 1st — never retry, message already user-facing) from a vendor 429 (often transient). */
export class BudgetError extends GeminiError {
  constructor() {
    super(429, 'You’ve used this month’s AI credit — it resets on the 1st.');
    this.name = 'BudgetError';
  }
}

// Google bills Search grounding PER GROUNDED REQUEST (~$35/1k beyond the free daily tier), and that
// fee never appears in usageMetadata — token metering alone would let a search-heavy caller drain
// dollars while the ledger barely moves. So every `search: true` call carries a flat surcharge.
// Deliberately charged even inside Google's free tier: the free tier is app-wide, not per-user, and
// a conservative flat fee only overcharges credit, never leaks real spend.
const GROUNDING_FEE_MICROS = 35_000;   // $0.035 per grounded call

// Record one call's spend, and — when AI_DEBUG_USAGE=1 — log the model, tokens, cost, and whether that
// cost was the provider's REPORTED charge (e.g. OpenRouter's usage.cost) or our rate estimate. Lets you
// reconcile the ledger against the provider's own dashboard per call.
async function meterSpend(userId: string, model: string, usage: GeminiUsageMetadata, grounded = false, key?: string): Promise<void> {
  const micros = costMicros(model, usage) + (grounded ? GROUNDING_FEE_MICROS : 0);
  if (process.env.AI_DEBUG_USAGE === '1') {
    const src = usage.exactCostMicros != null ? 'reported' : 'rate-est';
    console.log(`[ai-usage] ${model} in=${usage.promptTokenCount ?? 0} out=${usage.candidatesTokenCount ?? 0} cost=$${(micros / 1e6).toFixed(6)} (${src}${grounded ? '+grounding' : ''})`);
  }
  await recordAiSpend(userId, micros, key);
}

export async function geminiChat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  // AI_MOCK short-circuits BEFORE the key check, budget gate, fetch, and metering — the 3 AI routes
  // supply their own richer mocks; this covers the remaining buffered callers so none of them spend.
  if (AI_MOCK) return mockGenericText(messages, opts);

  const model = resolveModel(opts.model);
  const provider = providerForModel(model);
  const key = provider.requireKey();

  // Every buffered path (chat builder, doc parser, AI node, cron) funnels through here. The ONLY limit is
  // the per-user monthly dollar credit (lib/aiBudget.ts) — no daily or per-minute caps by design. Since
  // every call carries a userId, total spend is bounded at budget × users even if something runs away.
  // Resolve the billing-cycle period ONCE and thread its key through both the gate and the meter, so the
  // call bills exactly the bucket it was gated against and the subscription is read once, not twice.
  const periodKey = opts.userId ? (await resolvePeriod(opts.userId)).key : undefined;
  if (opts.userId && !(await hasAiBudget(opts.userId, periodKey))) {
    throw new BudgetError();
  }

  const { url, headers, body } = provider.buildRequest({ messages, opts, model, key, streaming: false });
  const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body) };

  // Retry a transient 5xx once. Don't retry 4xx (incl. 429 quota — quota doesn't reset in 500ms).
  const MAX_ATTEMPTS = 2;
  let lastStatus = 0;
  let lastMessage = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetchWithTimeout(url, init, 60_000);
    if (res.ok) {
      const json = await res.json();
      const { text, usage } = provider.readBuffered(json);
      // Charge the actual token cost to the user's monthly credit. Awaited (not fire-and-forget) so a
      // serverless runtime can't freeze the instance before the ledger write lands. Meter even when the
      // vendor omitted usage — Gemini always returns it, but an OpenAI-compatible gateway can return a 200
      // with no `usage` object, and a real generation must never bill zero. Fall back to a char estimate.
      if (opts.userId) {
        await meterSpend(opts.userId, model, usage ?? estimateUsage(messages, text.length), !!opts.search, periodKey);
      }
      return text;
    }
    lastStatus = res.status;
    lastMessage = parseErrorBody(await res.text());
    if (res.status >= 500 && res.status < 600 && attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 500 * attempt));
      continue;
    }
    break;
  }
  throw new GeminiError(lastStatus, lastMessage);
}

export function parseJson<T>(text: string): T {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(stripped) as T;
}

// ── Streaming ────────────────────────────────────────────────────────────────────────────────────
// A sibling to geminiChat for the interactive copilots: streams the model's text deltas so the panel can
// render the reply prose token-by-token. The structured JSON (actions/patch) arrives as part of that same
// text and is parsed WHOLE by the caller at end-of-stream — only the display is incremental.

// A stalled upstream must not hold the connection open forever, but a fixed total timeout would cut a
// legitimately long (thinking) stream. So we abort only after a gap with NO new bytes — and give the FIRST
// token a longer budget, because thinking models emit no frames before the first byte, and folding that
// into the inter-token gap would abort a healthy slow-to-start stream.
const STREAM_FIRST_TOKEN_TIMEOUT_MS = 120_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;

// Parse an SSE byte stream (`data: {json}` frames, OpenAI/Gemini alike) into parsed JSON objects. The
// per-frame INTERPRETATION (which fields hold the text/usage) is the provider's job.
async function* parseSseChunks(body: ReadableStream<Uint8Array>, onBytes: () => void): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes();
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are newline-delimited; keep the trailing partial line in the buffer.
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;   // OpenAI ends with data: [DONE]; Gemini omits it
        try { yield JSON.parse(payload); } catch { /* skip a malformed frame rather than kill the stream */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ~4 chars per token is the standard rough heuristic; the fallback for when real usage never arrived —
// an aborted stream, or an OpenAI-compatible gateway that returned no usage. It ensures a real generation
// can't bill zero, but it counts only VISIBLE output chars: a reasoning model's hidden thinking tokens
// aren't in the text, so this UNDER-bills them. That only matters if usage is genuinely absent — the
// default backends (Gemini, and OpenRouter via stream_options.include_usage / a buffered `usage`) always
// return real usage, so this stays a conservative floor for the abort / misconfigured-gateway case.
function estimateUsage(messages: ChatMessage[], outputChars: number): GeminiUsageMetadata {
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  const promptImages = messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
  return {
    promptTokenCount: Math.ceil(promptChars / 4) + promptImages * 258,   // ~258 tokens per inline image
    candidatesTokenCount: Math.ceil(outputChars / 4),
  };
}

/**
 * Open a streaming completion. AWAITS the initial upstream response, so the budget gate, a missing key, or
 * a non-OK status throw a GeminiError HERE — before the caller commits to a streamed HTTP response —
 * letting the route still return a normal JSON error. The returned async generator yields decoded text
 * deltas; its `finally` records the spend (real usage, or an estimate if aborted before the usage chunk).
 */
export async function openGeminiStream(messages: ChatMessage[], opts: StreamOpts = {}): Promise<AsyncGenerator<string>> {
  // Safety net: the two copilot routes mock BEFORE calling this, but if AI_MOCK is on and something
  // reaches here, return a canned stream (no fetch, no metering) rather than spending.
  if (AI_MOCK) return mockDeltas('{"reply":"Mock response — AI_MOCK is on.","actions":[]}');

  const model = resolveModel(opts.model);
  const provider = providerForModel(model);
  const key = provider.requireKey();
  // Resolve the period ONCE (see geminiChat) and thread it into the gate and the streamed meterSpend
  // in the generator's finally, so gate and record hit the same billing-cycle bucket.
  const periodKey = opts.userId ? (await resolvePeriod(opts.userId)).key : undefined;
  if (opts.userId && !(await hasAiBudget(opts.userId, periodKey))) {
    throw new BudgetError();
  }

  const { url, headers, body } = provider.buildRequest({ messages, opts, model, key, streaming: true });

  // Combine the caller's signal with an idle-timeout abort. The first token gets a longer budget (the
  // model may think a while before any byte); once bytes flow, a 45s gap means a real stall.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', abort, { once: true });
  }
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let flowing = false;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(abort, flowing ? STREAM_IDLE_TIMEOUT_MS : STREAM_FIRST_TOKEN_TIMEOUT_MS);
  };
  const onBytes = () => { flowing = true; resetIdle(); };
  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
    opts.signal?.removeEventListener('abort', abort);
    controller.abort();   // stop the upstream if we were finalized early (client disconnect / cancel)
  };

  resetIdle();
  let upstream: Response;
  try {
    upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (e) {
    cleanup();
    throw e;
  }
  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => '');   // read the error body BEFORE cleanup aborts
    cleanup();
    throw new GeminiError(upstream.status || 502, parseErrorBody(errText));
  }

  return (async function* () {
    let lastUsage: GeminiUsageMetadata | undefined;
    let outputChars = 0;
    try {
      for await (const chunk of parseSseChunks(upstream.body!, onBytes)) {
        const { text, usage } = provider.readStreamEvent(chunk);
        if (usage) lastUsage = usage;
        if (text) { outputChars += text.length; yield text; }
      }
    } finally {
      cleanup();
      // Real usage, or an estimate if aborted before the terminal usage chunk. Surface it to the UI
      // (onUsage) and bill it (awaited — not fire-and-forget — so the ledger write lands before freeze).
      const usage = lastUsage ?? estimateUsage(messages, outputChars);
      opts.onUsage?.({ input: usage.promptTokenCount ?? 0, output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) });
      if (opts.userId) {
        await meterSpend(opts.userId, model, usage, !!opts.search, periodKey);
      }
    }
  })();
}
