import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The BUFFERED funnel (geminiChat) had zero metering/gate coverage — the review's biggest hole, and the
// path where the metering-escape bug lived (a MiMo 200 with no `usage` billed zero). These drive the real
// geminiChat with the OpenAI-compatible provider and pin: it meters real usage, it meters an ESTIMATE when
// the gateway omits usage (no unmetered spend), and the budget gate fires before the request.

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

const http = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));
vi.mock('@/lib/http', () => ({ fetchWithTimeout: http.fetchWithTimeout }));

import { geminiChat } from '@/lib/gemini';

const json200 = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('buffered MiMo path (geminiChat) — metering + gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MIMO_API_KEY = 'sk-or-test';
    http.fetchWithTimeout.mockReset();
    budget.hasAiBudget.mockResolvedValue(true);
  });
  afterEach(() => { delete process.env.MIMO_API_KEY; });

  it('routes to OpenRouter, returns the message content, and meters the real usage', async () => {
    http.fetchWithTimeout.mockResolvedValueOnce(json200({
      choices: [{ message: { content: 'the answer' } }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    }));
    const text = await geminiChat([{ role: 'user', content: 'hi' }], { model: 'xiaomi/mimo-v2.5', userId: 'u1' });
    expect(text).toBe('the answer');
    const [url, init] = http.fetchWithTimeout.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(init.body as string).stream).toBeUndefined();   // buffered, not streamed
    expect(budget.costMicros).toHaveBeenCalledWith('xiaomi/mimo-v2.5', { promptTokenCount: 8, candidatesTokenCount: 4, thoughtsTokenCount: 0 });
    expect(budget.recordAiSpend).toHaveBeenCalledWith('u1', 99, '2026-08-20');   // billed to the resolved-once period key
    // resolve-once: the period is resolved a SINGLE time and its key threaded to BOTH gate and meter.
    expect(budget.resolvePeriod).toHaveBeenCalledTimes(1);
    expect(budget.hasAiBudget).toHaveBeenCalledWith('u1', '2026-08-20');
  });

  it('METERS AN ESTIMATE when a 200 omits usage — a MiMo call can never bill zero (the fixed escape)', async () => {
    http.fetchWithTimeout.mockResolvedValueOnce(json200({ choices: [{ message: { content: 'answer here' } }] }));   // no usage
    const text = await geminiChat([{ role: 'user', content: 'hi' }], { model: 'xiaomi/mimo-v2.5', userId: 'u1' });
    expect(text).toBe('answer here');
    // estimate: 'hi'=2 prompt chars → 1; 'answer here'=11 output chars → ceil(11/4)=3.
    expect(budget.costMicros).toHaveBeenCalledWith('xiaomi/mimo-v2.5', { promptTokenCount: 1, candidatesTokenCount: 3 });
    expect(budget.recordAiSpend).toHaveBeenCalledWith('u1', 99, '2026-08-20');   // spend recorded despite absent usage
  });

  it('enforces the budget gate before the request (429, no fetch)', async () => {
    budget.hasAiBudget.mockResolvedValueOnce(false);
    await expect(geminiChat([{ role: 'user', content: 'hi' }], { model: 'xiaomi/mimo-v2.5', userId: 'u1' }))
      .rejects.toMatchObject({ status: 429 });
    expect(http.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('does not meter when there is no userId (anonymous/system call)', async () => {
    http.fetchWithTimeout.mockResolvedValueOnce(json200({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    await geminiChat([{ role: 'user', content: 'hi' }], { model: 'xiaomi/mimo-v2.5' });
    expect(budget.recordAiSpend).not.toHaveBeenCalled();
  });
});
