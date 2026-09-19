import { describe, it, expect } from 'vitest';
import { mockCarouselJson, mockReelsJson, mockDeltas } from '@/lib/aiMock';
import { copilotStreamResponse } from './copilotStream';
import { readCopilotStream } from '@/lib/copilotStreamClient';
import { parseJson } from '@/lib/gemini';
import { zAgentResponse, zAgentAction, type AgentAction } from './agentActions';
import { zTwitterTemplateSettingsPatch } from './reelsSchema';

// Tier 1 — the streaming + validation core, end to end but with no HTTP/auth/browser. We drive a canned
// mock response through the REAL server stream (copilotStreamResponse) and the REAL client reader
// (readCopilotStream), so a break in SSE framing, the reply extractor, whole-JSON validation, or the
// client parser is caught here. The `finalize` closures below mirror the two copilot routes.

interface CarouselFinal { reply: string; actions: AgentAction[]; warnings: string[] }
function carouselFinalize(fullText: string): Record<string, unknown> {
  const raw = zAgentResponse.parse(parseJson(fullText));
  const actions: AgentAction[] = [];
  const warnings: string[] = [];
  for (const c of raw.actions ?? []) {
    const r = zAgentAction.safeParse(c);
    if (r.success) actions.push(r.data);
    else warnings.push('invalid action');
  }
  return { reply: raw.reply || 'Done.', actions, warnings };
}

interface ReelFinal { reply: string; patch?: Record<string, unknown>; warning?: string }
function reelFinalize(fullText: string): Record<string, unknown> {
  const raw = parseJson(fullText) as { reply?: string; patch?: unknown };
  let patch: Record<string, unknown> | undefined;
  let warning: string | undefined;
  if (raw.patch && typeof raw.patch === 'object' && Object.keys(raw.patch as object).length > 0) {
    const r = zTwitterTemplateSettingsPatch.safeParse(raw.patch);
    if (r.success && Object.keys(r.data).length > 0) patch = r.data as Record<string, unknown>;
    else warning = 'invalid patch';
  }
  return { reply: typeof raw.reply === 'string' && raw.reply ? raw.reply : 'Done.', patch, warning };
}

// Run a canned response string through the full server→client pipeline, capturing streamed tokens.
async function roundTrip<T>(json: string, finalize: (t: string) => Record<string, unknown>) {
  const res = copilotStreamResponse(mockDeltas(json), finalize);
  const tokens: string[] = [];
  const { final, error } = await readCopilotStream<T>(res, t => tokens.push(t));
  return { final, error, tokens, replyText: tokens.join('') };
}

describe('Tier 1 — carousel pipeline round-trip', () => {
  it('streams the reply and delivers a validated fontSize patch for "bigger"', async () => {
    const json = mockCarouselJson({ slideId: 's1', text: 'make the headline bigger' });
    const { final, error, replyText, tokens } = await roundTrip<CarouselFinal>(json, carouselFinalize);
    expect(error).toBeNull();
    expect(tokens.length).toBeGreaterThan(1);              // the reply arrived incrementally, not all at once
    expect(replyText).toContain('88px');
    expect(final?.actions[0]).toMatchObject({ type: 'patch_slide', slideId: 's1', settings: { fontSize: 88 } });
  });

  it('delivers a dark-palette patch for "darker"', async () => {
    const { final } = await roundTrip<CarouselFinal>(mockCarouselJson({ slideId: 's1', text: 'darker please' }), carouselFinalize);
    expect(final?.actions[0]).toMatchObject({ type: 'patch_slide', settings: { canvasColor: '#0a0a0a' } });
  });

  it('produces a generate_element action for "add a chart"', async () => {
    const { final } = await roundTrip<CarouselFinal>(mockCarouselJson({ slideId: 's1', text: 'add a bar chart' }), carouselFinalize);
    expect(final?.actions[0].type).toBe('generate_element');
  });

  it('produces >= 5 valid actions for "redesign" (the plan-before-apply trigger)', async () => {
    const { final } = await roundTrip<CarouselFinal>(mockCarouselJson({ slideId: 's1', text: 'redesign this slide' }), carouselFinalize);
    expect(final?.actions.length).toBeGreaterThanOrEqual(5);
    expect(final?.warnings).toHaveLength(0);              // every proposed action validated
  });

  it('every keyword yields a clean, validated turn', async () => {
    for (const text of ['bigger', 'smaller', 'bolder', 'center it', 'add a caption', 'match my brand', 'anything else']) {
      const { final, error } = await roundTrip<CarouselFinal>(mockCarouselJson({ slideId: 's1', text, brandColors: ['#00CD40', '#0B0B0B'] }), carouselFinalize);
      expect(error).toBeNull();
      expect((final?.actions.length ?? 0)).toBeGreaterThan(0);
      expect(final?.warnings).toHaveLength(0);
    }
  });

  it('drops an invalid action to warnings and applies only the valid one (the validation path)', async () => {
    // First action is valid; second is a patch_slide missing its required slideId → must be rejected.
    const json = '{"reply":"one good, one bad","actions":[{"type":"patch_slide","slideId":"s1","settings":{"fontSize":88}},{"type":"patch_slide"}]}';
    const { final, error } = await roundTrip<CarouselFinal>(json, carouselFinalize);
    expect(error).toBeNull();
    expect(final?.actions).toHaveLength(1);
    expect(final?.actions[0]).toMatchObject({ type: 'patch_slide', slideId: 's1' });
    expect(final?.warnings).toHaveLength(1);
  });
});

describe('Tier 1 — reels pipeline round-trip', () => {
  it('delivers a dark-header patch for "dark"', async () => {
    const { final, error, replyText } = await roundTrip<ReelFinal>(mockReelsJson({ text: 'dark header' }), reelFinalize);
    expect(error).toBeNull();
    expect(replyText.length).toBeGreaterThan(0);
    expect(final?.patch).toMatchObject({ headerBgColor: '#000000' });
  });

  it('every keyword yields a non-empty, validated patch', async () => {
    for (const text of ['dark', 'light', 'bigger caption', 'circle avatar', 'match my brand', 'whatever']) {
      const { final, error } = await roundTrip<ReelFinal>(mockReelsJson({ text, brandColors: ['#00CD40', '#0B0B0B'] }), reelFinalize);
      expect(error).toBeNull();
      expect(final?.patch && Object.keys(final.patch).length).toBeGreaterThan(0);
    }
  });
});

describe('Tier 1 — error + edge handling', () => {
  it('turns a truncated/malformed response into an in-band error, not a crash', async () => {
    // finalize throws (JSON.parse fails) → copilotStreamResponse emits event:error → reader returns it.
    const { final, error } = await roundTrip<CarouselFinal>('{"reply":"partial","actions":[', carouselFinalize);
    expect(final).toBeNull();
    expect(error).toBeTruthy();
  });

  it('still streams the reply prose even when the structured part later fails', async () => {
    const { replyText } = await roundTrip<CarouselFinal>('{"reply":"I started but got cut off","actions":[', carouselFinalize);
    expect(replyText).toContain('I started but got cut off');
  });

  it('completes (does not hang) and closes the stream on a normal turn', async () => {
    const { final } = await roundTrip<ReelFinal>(mockReelsJson({ text: 'dark' }), reelFinalize);
    expect(final).not.toBeNull();   // resolved → the done event closed the stream
  });
});
