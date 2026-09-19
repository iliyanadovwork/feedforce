import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// End-to-end proof (no network) that routing a MiMo model through the SHARED funnel actually works:
// the OpenAI-compatible request is sent, the choices[].delta stream is parsed into deltas, and — the
// review's headline concern — the call is METERED like any Gemini call (no provider can spend unmetered).
// aiBudget is mocked so we can assert the ledger was hit with the mapped usage; fetch is stubbed to a
// canned OpenAI SSE stream.

const budget = vi.hoisted(() => ({
  recordAiSpend: vi.fn(async () => {}),
  hasAiBudget: vi.fn(async () => true),
  costMicros: vi.fn(() => 99),
  resolvePeriod: vi.fn(async () => ({ key: '2026-08-20', resetsAt: new Date(0) })),
}));
vi.mock('@/lib/aiBudget', () => ({
  recordAiSpend: budget.recordAiSpend,
  hasAiBudget: budget.hasAiBudget,
  costMicros: budget.costMicros,
  resolvePeriod: budget.resolvePeriod,
}));

import { openGeminiStream } from '@/lib/gemini';

function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`data: ${f}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));   // OpenAI's terminal sentinel
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const FRAMES = [
  '{"choices":[{"delta":{"content":"Hello"}}]}',
  '{"choices":[{"delta":{"content":" world"}}]}',
  '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
];

describe('MiMo streaming path through the shared funnel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MIMO_API_KEY = 'sk-or-test';
    fetchMock = vi.fn(async () => sseResponse(FRAMES));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MIMO_API_KEY;
  });

  it('routes a MiMo id to OpenRouter with Bearer auth + a streaming body, and yields the parsed deltas', async () => {
    const gen = await openGeminiStream([{ role: 'user', content: 'hi' }], { model: 'xiaomi/mimo-v2.5', userId: 'u1', json: true });
    let out = '';
    for await (const d of gen) out += d;
    expect(out).toBe('Hello world');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('xiaomi/mimo-v2.5');
    expect(body.stream).toBe(true);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('METERS the MiMo call with the mapped usage — no metering escape', async () => {
    const gen = await openGeminiStream([{ role: 'user', content: 'hi' }], { model: 'xiaomi/mimo-v2.5', userId: 'u1' });
    for await (const _d of gen) { /* drain to completion so the finally-block meters */ }
    // usage from the OpenAI trailing chunk, mapped to the ledger shape:
    expect(budget.costMicros).toHaveBeenCalledWith('xiaomi/mimo-v2.5', { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 0 });
    expect(budget.recordAiSpend).toHaveBeenCalledWith('u1', 99, '2026-08-20');   // billed to the resolved-once period key
    // resolve-once: the period is resolved a SINGLE time and its key threaded to BOTH gate and meter.
    expect(budget.resolvePeriod).toHaveBeenCalledTimes(1);
    expect(budget.hasAiBudget).toHaveBeenCalledWith('u1', '2026-08-20');
  });

  it('passes OpenRouter\'s reported usage.cost through to metering as exactCostMicros', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([
      '{"choices":[{"delta":{"content":"Hi"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4482,"completion_tokens":1318,"cost":0.000689}}',
    ]));
    const gen = await openGeminiStream([{ role: 'user', content: 'hi' }], { model: 'xiaomi/mimo-v2.5', userId: 'u1' });
    for await (const _d of gen) { /* drain */ }
    // The exact $0.000689 charge rides through as 689 micros; real costMicros would then return it verbatim.
    expect(budget.costMicros).toHaveBeenCalledWith('xiaomi/mimo-v2.5', { promptTokenCount: 4482, candidatesTokenCount: 1318, thoughtsTokenCount: 0, exactCostMicros: 689 });
  });

  it('still enforces the budget gate before spending (429 when out of credit)', async () => {
    budget.hasAiBudget.mockResolvedValueOnce(false);
    await expect(openGeminiStream([{ role: 'user', content: 'hi' }], { model: 'xiaomi/mimo-v2.5', userId: 'u1' }))
      .rejects.toMatchObject({ status: 429 });
    expect(fetchMock).not.toHaveBeenCalled();   // gate fires before the upstream request
  });

  it('meters an ESTIMATE when the stream ends with no usage chunk (aborted / usage-less gateway)', async () => {
    // Frames WITHOUT the trailing usage chunk — lastUsage stays undefined, so the finally must fall back
    // to estimateUsage so a completed generation can't bill zero. 'hi'=2 prompt chars → ceil(2/4)=1;
    // 'Hello world'=11 output chars → ceil(11/4)=3.
    fetchMock.mockResolvedValueOnce(sseResponse([
      '{"choices":[{"delta":{"content":"Hello"}}]}',
      '{"choices":[{"delta":{"content":" world"}}]}',
    ]));
    const gen = await openGeminiStream([{ role: 'user', content: 'hi' }], { model: 'xiaomi/mimo-v2.5', userId: 'u1' });
    let out = '';
    for await (const d of gen) out += d;
    expect(out).toBe('Hello world');
    expect(budget.costMicros).toHaveBeenCalledWith('xiaomi/mimo-v2.5', { promptTokenCount: 1, candidatesTokenCount: 3 });
    expect(budget.recordAiSpend).toHaveBeenCalledWith('u1', 99, '2026-08-20');
  });

  it('reassembles an SSE frame split across reads (multi-read buffering)', async () => {
    // Deliver the whole SSE payload in 5-byte slices so frames are cut mid-JSON and mid-multibyte — the
    // parser must buffer partial lines across reads and still yield every delta intact.
    const payload = FRAMES.map(f => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(payload);
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 5) c.enqueue(bytes.slice(i, i + 5));
        c.close();
      },
    }), { status: 200 }));
    const gen = await openGeminiStream([{ role: 'user', content: 'hi' }], { model: 'xiaomi/mimo-v2.5', userId: 'u1' });
    let out = '';
    for await (const d of gen) out += d;
    expect(out).toBe('Hello world');   // no dropped/duplicated deltas despite mid-frame read boundaries
  });
});
