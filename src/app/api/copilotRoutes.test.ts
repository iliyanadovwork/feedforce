import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readCopilotStream } from '@/lib/copilotStreamClient';
import { isElementCodeSafe } from '@/lib/customElements/codeGuards';

// Tier 2 — the REAL route handlers, called directly with a fake Request. This adds request validation
// + the AI_MOCK branch on top of Tier 1's pipeline. Auth / rate-limit / budget are stubbed. Two things
// prove the mock branch is genuinely the one exercised: (1) the endpoints return DETERMINISTIC mock
// content (e.g. canvasColor '#0a0a0a') that real Gemini could never reliably produce, and (2) a
// negative control below shows the budget gate IS reached when AI_MOCK is OFF — which is what gives the
// "hasAiBudget not called under AI_MOCK" assertions real teeth (they'd otherwise pass vacuously,
// because the no-key check in the funnel aborts before the budget gate).

const budget = vi.hoisted(() => ({
  recordAiSpend: vi.fn(async () => {}),
  hasAiBudget: vi.fn(async () => true),
  resolvePeriod: vi.fn(async () => ({ key: '2026-08-20', resetsAt: new Date(0) })),
}));

vi.mock('@/lib/serverAuth', () => ({
  requireUser: async () => ({ id: 'u1', email: 'test@example.com' }),
  unauthorized: () => new Response(JSON.stringify({ error: 'unauth' }), { status: 401 }),
  requireSubscriber: async () => null,   // null → not gated
  subscriptionRequired: () => new Response(JSON.stringify({ error: 'sub' }), { status: 402 }),
}));
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: async () => true,
  tooManyRequests: () => new Response(JSON.stringify({ error: 'rate' }), { status: 429 }),
}));
vi.mock('@/lib/aiBudget', () => ({
  recordAiSpend: budget.recordAiSpend,
  hasAiBudget: budget.hasAiBudget,
  resolvePeriod: budget.resolvePeriod,
  costMicros: () => 0,
}));

// No real network in tests: the non-mock path (negative control) must never actually call Gemini.
const fetchMock = vi.fn(async () => { throw new Error('network disabled in test'); });
vi.stubGlobal('fetch', fetchMock);

type Handler = (req: Request) => Promise<Response>;
// Load the routes with AI_MOCK on or off. A dummy GEMINI_API_KEY lets the NON-mock path get past the
// funnel's key check and actually reach the budget gate (so the negative control is meaningful).
async function loadRoutes(mockOn: boolean): Promise<{ agent: Handler; reel: Handler; element: Handler }> {
  vi.resetModules();
  vi.stubEnv('AI_MOCK', mockOn ? '1' : '');
  vi.stubEnv('GEMINI_API_KEY', 'test-dummy');
  return {
    agent: (await import('@/app/api/editor/agent/route')).POST,
    reel: (await import('@/app/api/editor/reel-agent/route')).POST,
    element: (await import('@/app/api/elements/generate/route')).POST,
  };
}

let mock: Awaited<ReturnType<typeof loadRoutes>>;
beforeAll(async () => { mock = await loadRoutes(true); });
beforeEach(() => { budget.recordAiSpend.mockClear(); budget.hasAiBudget.mockClear(); fetchMock.mockClear(); });

function post(url: string, body: unknown): Request {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const oneSlideTemplate = { activeSlideId: 's1', slides: [{ id: 's1', name: 'Slide 1', position: 0, headline: 'Hi', subheadline: 'Sub', settings: {} }] };

async function readSSE(res: Response) {
  const tokens: string[] = [];
  const { final, error } = await readCopilotStream<Record<string, unknown>>(res, t => tokens.push(t));
  return { final, error, replyText: tokens.join('') };
}

describe('Tier 2 — /api/editor/agent (carousel)', () => {
  it('streams a validated darker-palette turn (deterministic mock content proves the mock branch ran)', async () => {
    const res = await mock.agent(post('http://t/api/editor/agent', { messages: [{ role: 'user', content: 'make it darker' }], template: oneSlideTemplate }));
    expect(res.status).toBe(200);
    const { final, error, replyText } = await readSSE(res);
    expect(error).toBeNull();
    expect(replyText.length).toBeGreaterThan(0);
    const actions = final?.actions as Array<{ type: string; slideId: string; settings?: Record<string, unknown> }>;
    expect(actions[0]).toMatchObject({ type: 'patch_slide', slideId: 's1', settings: { canvasColor: '#0a0a0a' } });
  });

  it('returns >= 5 actions for a redesign (plan-before-apply path)', async () => {
    const res = await mock.agent(post('http://t/api/editor/agent', { messages: [{ role: 'user', content: 'redesign this slide' }], template: oneSlideTemplate }));
    const { final } = await readSSE(res);
    expect((final?.actions as unknown[]).length).toBeGreaterThanOrEqual(5);
  });

  it('rejects an invalid body with 400 (not a stream)', async () => {
    const res = await mock.agent(post('http://t/api/editor/agent', { messages: [], template: oneSlideTemplate }));
    expect(res.status).toBe(400);
  });
});

describe('Tier 2 — /api/editor/reel-agent (reels)', () => {
  it('streams a validated dark-header patch', async () => {
    const res = await mock.reel(post('http://t/api/editor/reel-agent', { messages: [{ role: 'user', content: 'dark header' }], settings: {} }));
    expect(res.status).toBe(200);
    const { final, error } = await readSSE(res);
    expect(error).toBeNull();
    expect((final?.patch as Record<string, unknown>).headerBgColor).toBe('#000000');
  });
});

describe('Tier 2 — /api/elements/generate (element generator)', () => {
  it('returns a safe, non-empty element', async () => {
    const res = await mock.element(post('http://t/api/elements/generate', { prompt: 'a stat card' }));
    expect(res.status).toBe(200);
    const json = await res.json() as { code: string; size: { w: number; h: number; aspect: number } };
    expect(json.code.length).toBeGreaterThan(0);
    expect(isElementCodeSafe(json.code)).toBe(true);
    expect(json.size.w).toBeGreaterThan(0);
  });
});

describe('Tier 2 — no-spend guarantee (with a negative control)', () => {
  it('AI_MOCK ON: the budget gate is never reached and nothing is billed', async () => {
    await mock.agent(post('http://t/api/editor/agent', { messages: [{ role: 'user', content: 'darker' }], template: oneSlideTemplate }));
    expect(budget.hasAiBudget).not.toHaveBeenCalled();
    expect(budget.recordAiSpend).not.toHaveBeenCalled();
  });

  it('CONTROL — AI_MOCK OFF: the budget gate IS reached, so the assertion above has teeth', async () => {
    const off = await loadRoutes(false);
    const res = await off.agent(post('http://t/api/editor/agent', { messages: [{ role: 'user', content: 'darker' }], template: oneSlideTemplate }));
    // With the mock branch removed, the route runs the real funnel: it passes the key check (dummy key),
    // reaches hasAiBudget, then the (disabled) network aborts the turn → 500. The point is the gate ran.
    expect(budget.hasAiBudget).toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});
