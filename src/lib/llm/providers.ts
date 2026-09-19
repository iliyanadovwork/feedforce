// Provider abstraction for the LLM funnel. The shared wrapper (AI_MOCK, per-user budget gate, retry,
// abort + idle-timeout, spend metering) lives in lib/gemini.ts and is provider-agnostic; the parts that
// actually differ per vendor — how a request is built, how the streamed/buffered response is parsed, and
// where the token usage lives — are isolated behind LLMProvider here. Adding a vendor = one more object.
//
// Two providers today:
//   • gemini  — Google Generative Language API (generateContent / streamGenerateContent?alt=sse)
//   • openai  — OpenAI-compatible Chat Completions, used for Xiaomi MiMo via OpenRouter (or mimo.mi.com).
//
// SECURITY / billing note: a provider only BUILDS requests and PARSES responses. It never touches the
// budget gate or the ledger — those stay in the shared funnel, so no provider can spend unmetered.

import type { GeminiUsageMetadata } from '../aiBudget';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  // Optional inline images (vision) attached to a user turn — base64 WITHOUT the data: prefix.
  images?: { mimeType: string; data: string }[];
}

export interface ChatOpts {
  json?: boolean;
  temperature?: number;
  model?: string;
  maxOutputTokens?: number;
  userId?: string;
  // Gemini structured output: force the reply to match this JSON schema (implies JSON mime). Far more
  // reliable than pasting the schema into the prompt. Gemini-only; the OpenAI provider ignores it.
  responseSchema?: Record<string, unknown>;
  // Gemini Google-Search grounding: let the model look things up on the web (e.g. discover an API
  // endpoint). Gemini-only. NOT combinable with responseSchema/json — grounding needs free-form output,
  // so when `search` is set the schema/json-mode are dropped (the caller uses one mode or the other).
  search?: boolean;
}

export interface StreamOpts extends ChatOpts {
  /** Caller abort (client disconnect / Stop) — propagated to the upstream fetch. */
  signal?: AbortSignal;
  /** Fires once at end-of-stream with the turn's token counts (for UI display; independent of metering). */
  onUsage?: (usage: { input: number; output: number }) => void;
}

// Model context-window sizes (tokens), for the copilot's "how full is the conversation" meter. All current
// models sit at ~1M; refine per-model if that changes.
export const CONTEXT_WINDOW: Record<string, number> = {
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
  'gemini-2.5-pro': 1_048_576,
  'xiaomi/mimo-v2.5': 1_048_576,
  'xiaomi/mimo-v2.5-pro': 1_048_576,
};

// Cap output tokens so a crafted prompt/schema can't make the model emit (and bill) an enormous reply.
// 8192 matches Gemini's prior default: the 2.5 models are "thinking" models whose hidden reasoning tokens
// draw from THIS budget, so a lower cap can truncate the visible JSON answer (→ parse failure).
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** Best-effort human message out of a vendor error body ({error:{message}} for both Gemini and OpenAI). */
export function parseErrorBody(text: string): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: string } };
    return json.error?.message ?? text;
  } catch {
    return text;
  }
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface LLMProvider {
  readonly id: 'gemini' | 'openai';
  /** Read the vendor's key from env; throw a clear error if it's missing. */
  requireKey(): string;
  /** Build the HTTP request. `streaming` toggles SSE vs a single buffered response. */
  buildRequest(a: { messages: ChatMessage[]; opts: ChatOpts; model: string; key: string; streaming: boolean }): BuiltRequest;
  /** Interpret ONE already-JSON.parsed SSE frame → text delta and/or a usage snapshot. */
  readStreamEvent(json: unknown): { text?: string; usage?: GeminiUsageMetadata };
  /** Interpret a full buffered JSON response → text + usage. */
  readBuffered(json: unknown): { text: string; usage?: GeminiUsageMetadata };
}

// ── Gemini provider ───────────────────────────────────────────────────────────────────────────────
// Extracted verbatim from the original gemini.ts so the working path is byte-for-byte unchanged.

type GeminiResp = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: GeminiUsageMetadata;
};

export const geminiProvider: LLMProvider = {
  id: 'gemini',
  requireKey() {
    const key = process.env.GEMINI_API_KEY ?? '';
    if (!key) throw new Error('GEMINI_API_KEY not set');
    return key;
  },
  buildRequest({ messages, opts, model, key, streaming }) {
    const systemMessage = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');
    // Grounding and structured output are mutually exclusive in one call: Google-Search grounding needs
    // free-form output, so when `search` is on we drop responseSchema and JSON mode.
    const grounding = !!opts.search;
    const useSchema = !!opts.responseSchema && !grounding;
    const wantJson = (opts.json || useSchema) && !grounding;
    const body: Record<string, unknown> = {
      contents: otherMessages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [
          { text: m.content },
          ...(m.images ?? []).map(im => ({ inlineData: { mimeType: im.mimeType, data: im.data } })),
        ],
      })),
      generationConfig: {
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        ...(wantJson && { responseMimeType: 'application/json' }),
        ...(useSchema && { responseSchema: opts.responseSchema }),
      },
      // Gemini 2.x web-search grounding tool. (REST field name; verify against the live API if grounding
      // ever returns ungrounded — some versions used `google_search_retrieval`.)
      ...(grounding && { tools: [{ google_search: {} }] }),
    };
    if (systemMessage) body.systemInstruction = { parts: [{ text: systemMessage.content }] };
    const verb = streaming ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:${verb}`,
      // Auth via header (not ?key=) so BOTH classic AIza… keys and the newer AQ.… "auth keys" work.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body,
    };
  },
  readStreamEvent(json) {
    const j = json as GeminiResp;
    return { text: j.candidates?.[0]?.content?.parts?.[0]?.text, usage: j.usageMetadata };
  },
  readBuffered(json) {
    const j = json as GeminiResp;
    return { text: j.candidates?.[0]?.content?.parts?.[0]?.text ?? '', usage: j.usageMetadata };
  },
};

// ── OpenAI-compatible provider (Xiaomi MiMo via OpenRouter / mimo.mi.com) ────────────────────────────
// Chat Completions shape: system stays inline as a message, images ride as image_url data URIs, JSON mode
// is response_format:{type:'json_object'}, and usage arrives in a trailing chunk when we ask for it.

type OpenAiResp = {
  choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};

/** OpenAI usage → the Gemini-shaped normalized usage the ledger already understands. completion_tokens
 * already INCLUDES a reasoning model's thinking tokens, so it maps whole to the output count. When the
 * gateway reports the ACTUAL charge (OpenRouter's usage.cost, in USD), carry it as exactCostMicros so the
 * ledger bills that precise amount rather than our rate estimate — the routed upstream (Parasail, etc.)
 * often prices differently from the base model listing. */
function mapOpenAiUsage(u: OpenAiResp['usage']): GeminiUsageMetadata | undefined {
  if (!u) return undefined;
  const usage: GeminiUsageMetadata = { promptTokenCount: u.prompt_tokens ?? 0, candidatesTokenCount: u.completion_tokens ?? 0, thoughtsTokenCount: 0 };
  if (typeof u.cost === 'number') usage.exactCostMicros = Math.round(u.cost * 1_000_000);
  return usage;
}

/** Base URL for the OpenAI-compatible endpoint. OpenRouter by default; point MIMO_BASE_URL at
 * mimo.mi.com (or any compatible gateway) to switch. Trailing slash tolerated. */
function mimoBaseUrl(): string {
  return (process.env.MIMO_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
}

/** JSON mode (response_format:{json_object}) is on by default, but not every model/gateway accepts it —
 * some 400 on it. Our prompt already demands JSON, so it's an optimization, not a requirement: set
 * MIMO_JSON_MODE=off to drop it without a code change if MiMo rejects it. */
function jsonModeEnabled(): boolean {
  return !/^(0|off|false|no)$/i.test(process.env.MIMO_JSON_MODE ?? '');
}

export const openaiProvider: LLMProvider = {
  id: 'openai',
  requireKey() {
    const key = process.env.MIMO_API_KEY || process.env.OPENROUTER_API_KEY || '';
    if (!key) throw new Error('MIMO_API_KEY not set (the OpenAI-compatible key for MiMo / OpenRouter)');
    return key;
  },
  buildRequest({ messages, opts, model, key, streaming }) {
    const body: Record<string, unknown> = {
      model,
      messages: messages.map(m => ({
        role: m.role,   // system|user|assistant are all valid OpenAI roles
        content: m.images?.length
          ? [
              { type: 'text', text: m.content },
              ...m.images.map(im => ({ type: 'image_url', image_url: { url: `data:${im.mimeType};base64,${im.data}` } })),
            ]
          : m.content,
      })),
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(opts.json && jsonModeEnabled() && { response_format: { type: 'json_object' } }),
      ...(streaming && { stream: true, stream_options: { include_usage: true } }),
    };
    return {
      url: `${mimoBaseUrl()}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        // Optional OpenRouter attribution headers — harmless elsewhere.
        'X-Title': 'FeedForce',
      },
      body,
    };
  },
  readStreamEvent(json) {
    const j = json as OpenAiResp;
    return { text: j.choices?.[0]?.delta?.content, usage: mapOpenAiUsage(j.usage) };
  },
  readBuffered(json) {
    const j = json as OpenAiResp;
    return { text: j.choices?.[0]?.message?.content ?? '', usage: mapOpenAiUsage(j.usage) };
  },
};

// ── Model registry / routing ────────────────────────────────────────────────────────────────────────
// Allow only known model ids so a stray config can't point the request at an arbitrary URL/model. The
// MiMo ids are OpenRouter's canonical strings; on mimo.mi.com the ids may differ — override via config
// there. Pricing for each lives in aiBudget.ts (keep the ids in sync).

export const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'] as const;
export const MIMO_MODELS = ['xiaomi/mimo-v2.5', 'xiaomi/mimo-v2.5-pro'] as const;
export const ALLOWED_MODELS = new Set<string>([...GEMINI_MODELS, ...MIMO_MODELS]);

/** Which provider serves a (resolved, allow-listed) model id. */
export function providerForModel(model: string): LLMProvider {
  return (MIMO_MODELS as readonly string[]).includes(model) ? openaiProvider : geminiProvider;
}
