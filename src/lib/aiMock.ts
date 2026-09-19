// AI_MOCK: a zero-cost, deterministic stand-in for Gemini so the copilot (carousel + reels) and the
// element generator can be exercised end-to-end WITHOUT spending credits. When AI_MOCK is on, the
// three AI routes short-circuit their LLM call and return canned-but-SCHEMA-VALID JSON that flows
// through the exact same validation + streaming + apply pipeline as real output — and the LLM funnel
// (geminiChat / openGeminiStream) never runs, so no budget is checked and no spend is recorded.
//
// The canned responses are keyword-driven off the user's message so typing "make the headline bigger"
// actually applies a bigger headline. Every builder's output is asserted against the real zod schemas
// in aiMock.test.ts — if a key drifts out of schema, the test fails.
//
// Server-only + a BARE env var (never NEXT_PUBLIC_, which would inline into the client bundle).

const aiMockRequested = process.env.AI_MOCK === '1' || process.env.AI_MOCK === 'true';
// Defense-in-depth: this flag disables real AI + billing, so NEVER honor it in a production deployment
// even if the env var leaks in. `next dev` (development) and tests use it freely.
export const AI_MOCK = aiMockRequested && process.env.NODE_ENV !== 'production';
if (aiMockRequested && !AI_MOCK) console.warn('[aiMock] AI_MOCK is set but ignored because NODE_ENV=production.');

// Chunk a JSON string into small deltas so the streaming routes still fire token events (the reply
// prose types out just like production). Order preserved; `reply` must be the first JSON field.
export async function* mockDeltas(json: string): AsyncGenerator<string> {
  for (let i = 0; i < json.length; i += 18) yield json.slice(i, i + 18);
}

const lc = (s: string) => s.toLowerCase();

// Full, schema-valid TextBox shapes (id is added on apply). Keys match zTextBoxStyle exactly.
const CAPTION_TEXTBOX = {
  text: 'New caption', x: 90, y: 1120, width: 900, height: 120,
  fontLabel: 'Inter', fontSize: 36, fontWeight: 400, italic: false, color: '#ffffff',
  align: 'left', vAlign: 'top', letterSpacing: 0, lineHeight: 12, opacity: 100, fillPlaceholder: false,
};
const KICKER_TEXTBOX = {
  text: 'KICKER', x: 90, y: 120, width: 900, height: 60,
  fontLabel: 'Inter', fontSize: 24, fontWeight: 700, italic: false, allCaps: true, color: '#ffffff',
  align: 'center', vAlign: 'top', letterSpacing: 4, lineHeight: 12, opacity: 100, fillPlaceholder: false,
};

// Carousel copilot: keyword → { reply, actions } (reply FIRST). Uses only exact CarouselSettings keys.
export function mockCarouselJson(opts: { slideId: string; text: string; brandColors?: string[] }): string {
  const t = lc(opts.text);
  const id = opts.slideId;
  const brand = opts.brandColors ?? [];
  let reply: string;
  let actions: unknown[];

  if (/redesign|revamp|overhaul|makeover|rework|start over|from scratch/.test(t)) {
    reply = 'Here’s a full restyle — a dark palette, a **bolder centered headline**, a tighter sub, and a kicker. Review the plan and hit Apply.';
    actions = [
      { type: 'patch_slide', slideId: id, settings: { canvasColor: '#111111' } },
      { type: 'patch_slide', slideId: id, settings: { fontSize: 82, fontWeight: 800, headlineColor: '#ffffff', textAlign: 'center' } },
      { type: 'patch_slide', slideId: id, settings: { subFontSize: 30, subFontWeight: 400, subheadlineColor: '#cccccc', subTextAlign: 'center' } },
      { type: 'patch_slide', slideId: id, headline: 'A bold new headline' },
      { type: 'add_text_box', slideId: id, textBox: KICKER_TEXTBOX },
    ];
  } else if (/small|reduce|shrink/.test(t)) {
    reply = 'Bringing the headline size down a touch.';
    actions = [{ type: 'patch_slide', slideId: id, settings: { fontSize: 52 } }];
  } else if (/big|large|bigger/.test(t)) {
    reply = 'Bumping the headline up to **88px** so it reads bigger.';
    actions = [{ type: 'patch_slide', slideId: id, settings: { fontSize: 88 } }];
  } else if (/bold/.test(t)) {
    reply = 'Making the headline bolder.';
    actions = [{ type: 'patch_slide', slideId: id, settings: { fontWeight: 800 } }];
  } else if (/dark|black|night|moody/.test(t)) {
    reply = 'Darkening the background and switching the text to light for contrast.';
    actions = [{ type: 'patch_slide', slideId: id, settings: { canvasColor: '#0a0a0a', headlineColor: '#ffffff', subheadlineColor: '#e5e5e5' } }];
  } else if (/brand/.test(t) && brand.length > 0) {
    reply = 'Matching the slide to your brand colors.';
    actions = [{ type: 'patch_slide', slideId: id, settings: { canvasColor: brand[1] ?? '#111111', headlineColor: brand[0] } }];
  } else if (/cent(er|re)|align/.test(t)) {
    reply = 'Centering the headline and sub-headline.';
    actions = [{ type: 'patch_slide', slideId: id, settings: { textAlign: 'center', subTextAlign: 'center' } }];
  } else if (/text ?box|caption|kicker|label|add text/.test(t)) {
    reply = 'Adding a caption text box near the bottom.';
    actions = [{ type: 'add_text_box', slideId: id, textBox: CAPTION_TEXTBOX }];
  } else if (/chart|graph|\bbar\b|plot|data/.test(t)) {
    reply = 'Generating a chart element — Insert it when it appears.';
    actions = [{ type: 'generate_element', prompt: opts.text }];
  } else {
    reply = 'Making a small tweak (mock). Try “make the headline bigger”, “darker”, “center it”, “add a caption”, “add a chart”, or “redesign this slide”.';
    actions = [{ type: 'patch_slide', slideId: id, settings: { headlineColor: '#f5f5f5' } }];
  }
  return JSON.stringify({ reply, actions });
}

// Reels copilot: keyword → { reply, patch } (reply FIRST). Uses only exact TwitterTemplateSettings keys.
export function mockReelsJson(opts: { text: string; brandColors?: string[] }): string {
  const t = lc(opts.text);
  const brand = opts.brandColors ?? [];
  let reply: string;
  let patch: Record<string, unknown>;

  if (/light|white/.test(t)) {
    reply = 'Made the header light with dark text.';
    patch = { headerBgColor: '#ffffff', nameColor: '#0f1419', handleColor: '#536471', captionColor: '#0f1419' };
  } else if (/dark|black|night/.test(t)) {
    reply = 'Made the header black with light text so it stays legible.';
    patch = { headerBgColor: '#000000', nameColor: '#e7e9ea', handleColor: '#71767b', captionColor: '#e7e9ea' };
  } else if (/big|large|caption/.test(t)) {
    reply = 'Bumped the caption size up.';
    patch = { captionFontSize: 56 };
  } else if (/brand/.test(t) && brand.length > 0) {
    reply = 'Matched the header and accents to your brand colors.';
    patch = { headerBgColor: brand[1] ?? '#0b0b0b', avatarStroke: true, avatarStrokeColor: brand[0], nameColor: '#ffffff', handleColor: brand[0] };
  } else if (/circle|avatar|ring|round/.test(t)) {
    reply = 'Made the avatar a circle with a ring.';
    patch = { avatarShape: 'circle', avatarStroke: true, avatarStrokeColor: '#ffffff' };
  } else {
    reply = 'Small tweak applied (mock). Try “dark header”, “bigger caption”, “circle avatar with a ring”, or “match my brand colors”.';
    patch = { nameColor: '#00cd40' };
  }
  return JSON.stringify({ reply, patch });
}

// Custom-element generator (buffered). `code` is the BODY of (ctx, props) => void; it must be non-empty
// and pass isElementCodeSafe (no window/document/fetch/import/require/eval/Function/timers/network). This
// draws a progress-animated accent bar + a value/label — safe, and renders in the preview.
export function mockElementJson(_prompt: string): string {
  const code = [
    "const w = props.width, h = props.height, p = props.progress, th = props.theme;",
    "const d = (props.data && typeof props.data === 'object') ? props.data : {};",
    "const value = d.value != null ? String(d.value) : '84%';",
    "const label = d.label != null ? String(d.label) : 'Occupancy';",
    "ctx.fillStyle = th.accent; ctx.fillRect(0, 0, Math.max(2, w * 0.04), h * p);",
    "ctx.globalAlpha = p; ctx.fillStyle = th.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';",
    "ctx.font = '700 ' + Math.round(h * 0.34) + 'px ' + th.fontFamily; ctx.fillText(value, w * 0.1, h * 0.56);",
    "ctx.fillStyle = th.muted; ctx.font = '500 ' + Math.round(h * 0.11) + 'px ' + th.fontFamily; ctx.fillText(label, w * 0.1, h * 0.8);",
    "ctx.globalAlpha = 1;",
  ].join('\n');
  return JSON.stringify({
    name: 'Stat card',
    description: 'A styled statistic card: a big value with a caption and an animated accent bar. (mock)',
    code,
    inputSchema: [
      { key: 'value', label: 'Value', dataType: 'string', required: true, description: 'The headline stat to display.' },
      { key: 'label', label: 'Label', dataType: 'string', required: false, description: 'Caption under the value.' },
    ],
    defaultData: { value: '84%', label: 'Occupancy rate' },
    size: { w: 520, h: 300 },
  });
}

// Funnel fallback for the OTHER buffered geminiChat callers (caption, automations, doc-parse), so they
// also never spend under AI_MOCK. Returns a shape that parses for the known callers; generic otherwise.
export function mockGenericText(messages: { role: string; content: string }[], opts: { json?: boolean }): string {
  const sys = messages.find(m => m.role === 'system')?.content ?? '';
  const all = messages.map(m => m.content).join('\n');
  if (/caption/i.test(sys) || /write the caption/i.test(all)) {
    return JSON.stringify({ caption: 'A mock caption for testing — AI_MOCK is on. ✨', hashtags: ['mock', 'test'], altText: 'Mock alt text.' });
  }
  if (/\bnodes?\b|automation/i.test(sys)) return JSON.stringify({ nodes: [], summary: 'Mock automation (AI_MOCK).' });
  if (opts.json) return '{}';
  return 'This is a mock AI response (AI_MOCK is on).';
}
