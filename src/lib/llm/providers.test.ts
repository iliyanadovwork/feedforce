/* eslint-disable @typescript-eslint/no-explicit-any -- test file: `any` is used for mock provider payloads and response-shape assertions, where precise typing adds no safety */
import { describe, it, expect, afterEach } from 'vitest';
import {
  geminiProvider, openaiProvider, providerForModel, ALLOWED_MODELS, DEFAULT_MAX_OUTPUT_TOKENS,
  type ChatMessage,
} from './providers';
import { costMicros } from '../aiBudget';

// The provider layer is the seam that lets the funnel talk to Gemini OR an OpenAI-compatible backend
// (Xiaomi MiMo via OpenRouter). These pin the two things that have to be exactly right per vendor and
// can be tested with zero network: how a request is BUILT and how a response is PARSED (incl. usage).

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are a copilot.' },
  { role: 'user', content: 'make it bold' },
];
const IMG_MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'recreate this style', images: [{ mimeType: 'image/png', data: 'AAAA' }] },
];

// process.env mutations must not leak between tests.
const ENV_SNAPSHOT = { ...process.env };
afterEach(() => {
  for (const k of ['GEMINI_API_KEY', 'MIMO_API_KEY', 'OPENROUTER_API_KEY', 'MIMO_BASE_URL', 'MIMO_JSON_MODE']) delete process.env[k];
  Object.assign(process.env, ENV_SNAPSHOT);
});

describe('providerForModel — routing', () => {
  it('routes Gemini ids to the Gemini provider', () => {
    expect(providerForModel('gemini-2.5-flash').id).toBe('gemini');
    expect(providerForModel('gemini-2.5-flash-lite').id).toBe('gemini');
  });
  it('routes MiMo ids to the OpenAI-compatible provider', () => {
    expect(providerForModel('xiaomi/mimo-v2.5').id).toBe('openai');
    expect(providerForModel('xiaomi/mimo-v2.5-pro').id).toBe('openai');
  });
  it('both MiMo ids are allow-listed (so the funnel accepts them)', () => {
    expect(ALLOWED_MODELS.has('xiaomi/mimo-v2.5')).toBe(true);
    expect(ALLOWED_MODELS.has('xiaomi/mimo-v2.5-pro')).toBe(true);
  });
});

describe('geminiProvider — request build (must stay identical to the pre-refactor path)', () => {
  const built = (streaming: boolean) =>
    geminiProvider.buildRequest({ messages: MESSAGES, opts: { json: true, temperature: 0.35, maxOutputTokens: 16000 }, model: 'gemini-2.5-flash', key: 'AIzaKEY', streaming });

  it('uses generateContent (buffered) vs streamGenerateContent?alt=sse (streaming)', () => {
    expect(built(false).url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(built(true).url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  });
  it('auths via the x-goog-api-key header (works for classic + AQ keys)', () => {
    expect(built(false).headers['x-goog-api-key']).toBe('AIzaKEY');
  });
  it('pulls system out to systemInstruction, maps assistant→model, sets responseMimeType + generationConfig', () => {
    const body = built(false).body as Record<string, any>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are a copilot.' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'make it bold' }] }]);
    expect(body.generationConfig).toMatchObject({ temperature: 0.35, maxOutputTokens: 16000, responseMimeType: 'application/json' });
  });
  it('encodes images as inlineData', () => {
    const body = geminiProvider.buildRequest({ messages: IMG_MESSAGES, opts: {}, model: 'gemini-2.5-flash', key: 'k', streaming: false }).body as Record<string, any>;
    expect(body.contents[0].parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildBody = (opts: any) => geminiProvider.buildRequest({ messages: MESSAGES, opts, model: 'gemini-2.5-flash', key: 'k', streaming: false }).body as Record<string, any>;

  it('sets responseSchema + JSON mime for structured output', () => {
    const schema = { type: 'object', properties: { url: { type: 'string' } } };
    const body = buildBody({ responseSchema: schema });
    expect(body.generationConfig.responseSchema).toEqual(schema);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.tools).toBeUndefined();
  });

  it('adds the google_search tool for grounding, and does NOT force JSON/schema (mutually exclusive)', () => {
    const body = buildBody({ search: true, json: true, responseSchema: { type: 'object' } });
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.generationConfig.responseMimeType).toBeUndefined();
    expect(body.generationConfig.responseSchema).toBeUndefined();
  });

  it('leaves both off by default', () => {
    const body = buildBody({});
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig.responseSchema).toBeUndefined();
  });
});

describe('openaiProvider — request build (MiMo / OpenRouter)', () => {
  const built = (streaming: boolean, opts = {}) =>
    openaiProvider.buildRequest({ messages: MESSAGES, opts: { json: true, temperature: 0.35, maxOutputTokens: 16000, ...opts }, model: 'xiaomi/mimo-v2.5', key: 'sk-or-KEY', streaming });

  it('hits <base>/chat/completions on OpenRouter by default', () => {
    expect(built(false).url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });
  it('honours MIMO_BASE_URL (trailing slash tolerated)', () => {
    process.env.MIMO_BASE_URL = 'https://api.mimo.mi.com/v1/';
    expect(built(false).url).toBe('https://api.mimo.mi.com/v1/chat/completions');
  });
  it('auths via Authorization: Bearer', () => {
    expect(built(false).headers.Authorization).toBe('Bearer sk-or-KEY');
  });
  it('keeps system INLINE as a message, passes model, sets response_format + max_tokens + temperature', () => {
    const body = built(false).body as Record<string, any>;
    expect(body.model).toBe('xiaomi/mimo-v2.5');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a copilot.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'make it bold' });   // plain string when no images
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(16000);
    expect(body.temperature).toBe(0.35);
  });
  it('sets stream + include_usage ONLY when streaming', () => {
    expect((built(true).body as any).stream).toBe(true);
    expect((built(true).body as any).stream_options).toEqual({ include_usage: true });
    expect((built(false).body as any).stream).toBeUndefined();
  });
  it('omits response_format when json is off', () => {
    expect((built(false, { json: false }).body as any).response_format).toBeUndefined();
  });
  it('drops response_format when MIMO_JSON_MODE=off (escape hatch for a gateway that rejects json_object)', () => {
    process.env.MIMO_JSON_MODE = 'off';
    expect((built(false).body as any).response_format).toBeUndefined();   // even though json:true
  });
  it('encodes images as image_url data URIs in a content array', () => {
    const body = openaiProvider.buildRequest({ messages: IMG_MESSAGES, opts: {}, model: 'xiaomi/mimo-v2.5', key: 'k', streaming: false }).body as Record<string, any>;
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'recreate this style' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });
});

describe('response parsing — text + usage', () => {
  it('gemini: reads streamed delta text and usageMetadata', () => {
    expect(geminiProvider.readStreamEvent({ candidates: [{ content: { parts: [{ text: 'Hi' }] } }] }).text).toBe('Hi');
    const withUsage = geminiProvider.readStreamEvent({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    expect(withUsage.usage).toEqual({ promptTokenCount: 10, candidatesTokenCount: 5 });
  });
  it('gemini: reads buffered text', () => {
    expect(geminiProvider.readBuffered({ candidates: [{ content: { parts: [{ text: '{"reply":"hi"}' }] } }] }).text).toBe('{"reply":"hi"}');
    expect(geminiProvider.readBuffered({}).text).toBe('');   // missing → empty, never throws
  });

  it('openai: reads streamed delta.content and maps usage → the ledger shape', () => {
    expect(openaiProvider.readStreamEvent({ choices: [{ delta: { content: 'Hello' } }] }).text).toBe('Hello');
    const usageFrame = openaiProvider.readStreamEvent({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 7 } });
    // completion_tokens (incl. reasoning) → output count; thoughts fold in as 0.
    expect(usageFrame.usage).toEqual({ promptTokenCount: 12, candidatesTokenCount: 7, thoughtsTokenCount: 0 });
    expect(openaiProvider.readStreamEvent({ choices: [{ delta: {} }] }).usage).toBeUndefined();
  });
  it('openai: reads buffered message.content + usage', () => {
    const r = openaiProvider.readBuffered({ choices: [{ message: { content: '{"reply":"hi"}' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
    expect(r.text).toBe('{"reply":"hi"}');
    expect(r.usage).toEqual({ promptTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 0 });
    expect(openaiProvider.readBuffered({}).text).toBe('');
  });

  it('openai: carries OpenRouter usage.cost through as exactCostMicros (the real charge, $→micros)', () => {
    const r = openaiProvider.readBuffered({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 4482, completion_tokens: 1318, cost: 0.000689 } });
    expect(r.usage).toEqual({ promptTokenCount: 4482, candidatesTokenCount: 1318, thoughtsTokenCount: 0, exactCostMicros: 689 });
  });
  it('openai: leaves exactCostMicros unset when the gateway reports no cost (falls back to the rate table)', () => {
    expect(openaiProvider.readStreamEvent({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } }).usage?.exactCostMicros).toBeUndefined();
  });
});

describe('requireKey — clear failure when the vendor key is missing', () => {
  it('gemini requires GEMINI_API_KEY', () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => geminiProvider.requireKey()).toThrow(/GEMINI_API_KEY/);
    process.env.GEMINI_API_KEY = 'x';
    expect(geminiProvider.requireKey()).toBe('x');
  });
  it('openai accepts MIMO_API_KEY or OPENROUTER_API_KEY, else throws', () => {
    delete process.env.MIMO_API_KEY; delete process.env.OPENROUTER_API_KEY;
    expect(() => openaiProvider.requireKey()).toThrow(/MIMO_API_KEY/);
    process.env.OPENROUTER_API_KEY = 'sk-or-1';
    expect(openaiProvider.requireKey()).toBe('sk-or-1');
    process.env.MIMO_API_KEY = 'mimo-1';
    expect(openaiProvider.requireKey()).toBe('mimo-1');   // MIMO_API_KEY wins when both set
  });
});

describe('MiMo pricing is wired into the ledger', () => {
  it('costMicros bills MiMo V2.5 at its own rate (not the unknown-model Pro fallback)', () => {
    // 1M input @ $0.105 + 1M output @ $0.28 = 385,000 micro-USD.
    expect(costMicros('xiaomi/mimo-v2.5', { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 })).toBe(385_000);
    // Sanity: a genuinely unknown model still falls back to the dearest (Gemini Pro) rate, not MiMo's.
    expect(costMicros('unknown-model', { promptTokenCount: 1_000_000, candidatesTokenCount: 0 })).toBe(1_250_000);
  });
  it('bills MiMo V2.5-Pro at its own (pricier reasoning) rate', () => {
    // 1M in @ $0.435 + 1M out @ $0.87 = 1,305,000 micro-USD. A deleted -pro row would fall to Gemini-Pro's rate.
    expect(costMicros('xiaomi/mimo-v2.5-pro', { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 })).toBe(1_305_000);
  });
  it('bills the provider-REPORTED exact charge when present, ignoring the rate table', () => {
    // The upstream (Parasail) priced this call differently from our listing; OpenRouter's usage.cost wins.
    // Rate-table would say ceil(4482×0.105 + 1318×0.28) = 840 micros; the reported 689 must win instead.
    expect(costMicros('xiaomi/mimo-v2.5', { promptTokenCount: 4482, candidatesTokenCount: 1318, exactCostMicros: 689 })).toBe(689);
  });
});

describe('request defaults — temperature 0.2 + DEFAULT_MAX_OUTPUT_TOKENS when the caller omits them', () => {
  it('openai applies the defaults (a changed default silently shifts billable output)', () => {
    const body = openaiProvider.buildRequest({ messages: MESSAGES, opts: {}, model: 'xiaomi/mimo-v2.5', key: 'k', streaming: false }).body as Record<string, any>;
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
  it('gemini applies the defaults', () => {
    const body = geminiProvider.buildRequest({ messages: MESSAGES, opts: {}, model: 'gemini-2.5-flash', key: 'k', streaming: false }).body as Record<string, any>;
    expect(body.generationConfig.temperature).toBe(0.2);
    expect(body.generationConfig.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
});
