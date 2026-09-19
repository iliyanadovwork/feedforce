import { describe, it, expect } from 'vitest';
import { mockCarouselJson, mockReelsJson, mockElementJson, mockGenericText, mockDeltas } from './aiMock';
import { zAgentResponse, zAgentAction } from './editorTools/agentActions';
import { zTwitterTemplateSettingsPatch } from './editorTools/reelsSchema';
import { isElementCodeSafe } from './customElements/codeGuards';

const SLIDE = 'slide_test_1';

// Parse + fully validate a carousel mock exactly as the route does (envelope + each action).
function validateCarousel(json: string) {
  const parsed = zAgentResponse.parse(JSON.parse(json));
  const actions = (parsed.actions ?? []).map(a => zAgentAction.parse(a));   // throws if any action is invalid
  return { reply: parsed.reply, actions };
}

describe('mockCarouselJson', () => {
  const prompts = ['make the headline bigger', 'make it smaller', 'bolder', 'darker please', 'center it', 'add a caption', 'add a bar chart', 'redesign this slide', 'something random'];

  it('always produces a schema-valid { reply, actions } for every prompt', () => {
    for (const p of prompts) {
      const { reply, actions } = validateCarousel(mockCarouselJson({ slideId: SLIDE, text: p }));
      expect(reply.length).toBeGreaterThan(0);
      expect(actions.length).toBeGreaterThan(0);
    }
  });

  it('puts reply first (the stream reply-extractor requires it)', () => {
    expect(mockCarouselJson({ slideId: SLIDE, text: 'bigger' }).startsWith('{"reply":')).toBe(true);
  });

  it('maps "bigger" to a headline fontSize patch on the given slide', () => {
    const { actions } = validateCarousel(mockCarouselJson({ slideId: SLIDE, text: 'make the headline bigger' }));
    expect(actions[0]).toMatchObject({ type: 'patch_slide', slideId: SLIDE, settings: { fontSize: 88 } });
  });

  it('maps "chart" to a generate_element action', () => {
    const { actions } = validateCarousel(mockCarouselJson({ slideId: SLIDE, text: 'add a bar chart' }));
    expect(actions[0].type).toBe('generate_element');
  });

  it('maps "redesign" to >= 5 valid actions (triggers plan-before-apply)', () => {
    const { actions } = validateCarousel(mockCarouselJson({ slideId: SLIDE, text: 'redesign this slide' }));
    expect(actions.length).toBeGreaterThanOrEqual(5);
  });

  it('uses brand colors when asked and provided', () => {
    const { actions } = validateCarousel(mockCarouselJson({ slideId: SLIDE, text: 'match my brand', brandColors: ['#00CD40', '#0B0B0B'] }));
    expect(JSON.stringify(actions)).toContain('#00CD40');
  });
});

describe('mockReelsJson', () => {
  const prompts = ['dark header', 'make it light', 'bigger caption', 'circle avatar with a ring', 'match my brand colors', 'whatever'];

  it('always produces a schema-valid, non-empty patch for every prompt', () => {
    for (const p of prompts) {
      const parsed = JSON.parse(mockReelsJson({ text: p, brandColors: ['#00CD40', '#0B0B0B'] })) as { reply: string; patch: unknown };
      expect(parsed.reply.length).toBeGreaterThan(0);
      const res = zTwitterTemplateSettingsPatch.safeParse(parsed.patch);
      expect(res.success).toBe(true);
      if (res.success) expect(Object.keys(res.data).length).toBeGreaterThan(0);
    }
  });

  it('puts reply first', () => {
    expect(mockReelsJson({ text: 'dark' }).startsWith('{"reply":')).toBe(true);
  });

  it('maps "dark" to a dark header', () => {
    const patch = (JSON.parse(mockReelsJson({ text: 'dark header' })) as { patch: Record<string, unknown> }).patch;
    expect(patch.headerBgColor).toBe('#000000');
  });
});

describe('mockElementJson', () => {
  it('produces non-empty code that passes the safety guard', () => {
    const g = JSON.parse(mockElementJson('a stat card')) as { code: string; size: { w: number; h: number }; inputSchema: unknown[] };
    expect(g.code.length).toBeGreaterThan(0);
    expect(isElementCodeSafe(g.code)).toBe(true);
    expect(g.size.w).toBeGreaterThan(0);
    expect(Array.isArray(g.inputSchema)).toBe(true);
  });
});

describe('mockGenericText', () => {
  it('returns a caption shape for the caption prompt', () => {
    const out = JSON.parse(mockGenericText([{ role: 'user', content: 'Write the caption.' }], { json: true })) as { caption?: string };
    expect(typeof out.caption).toBe('string');
  });

  it('returns valid JSON for a generic json request', () => {
    expect(() => JSON.parse(mockGenericText([{ role: 'system', content: 'x' }], { json: true }))).not.toThrow();
  });
});

describe('mockDeltas', () => {
  it('reassembles to the original json', async () => {
    const json = mockReelsJson({ text: 'dark' });
    let out = '';
    for await (const d of mockDeltas(json)) out += d;
    expect(out).toBe(json);
  });
});
