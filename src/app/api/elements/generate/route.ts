import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { geminiChat, parseJson, GeminiError, type ChatMessage } from '@/lib/gemini';
import { AI_MOCK, mockElementJson } from '@/lib/aiMock';
import { SAMPLE_BAR_CHART } from '@/lib/customElements/samples';
import { isElementCodeSafe } from '@/lib/customElements/codeGuards';
import type { ElementInput } from '@/lib/customElements/runtime';
import { reportError } from '@/lib/reportError';

export const runtime = 'nodejs';

// "Build with AI" → a custom element (AI_ELEMENTS_DESIGN.md). The model writes the BODY of a pure 2D-canvas
// draw-function (ctx, props) plus its data-binding schema. We pass the canvas/box dimensions + brand theme
// so it sizes the element to the template (§4.1 relative coords), and decide-per-element data-bindability
// (§4.4). The code is sandboxed client-side, but we still reject obviously-dangerous output here.

const DATA_TYPES = ['number', 'string', 'array', 'object', 'series', 'ohlc'];

interface GenBody {
  prompt?: string;
  canvas?: { width?: number; height?: number };
  box?: { w?: number; h?: number };
  previousCode?: string;   // when editing an existing element
  canvasImage?: string;    // base64 PNG of the current template canvas (vision grounding — §4.2)
  renderImage?: string;    // base64 PNG of the current element rendered (critique — §4.3)
}

// Accept a raw base64 string or a data: URL; return { mimeType, data } or null.
// ~4MB of base64 ≈ 3MB image — plenty for a canvas screenshot; anything bigger is cost abuse.
const MAX_IMAGE_B64 = 4_000_000;
function parseImage(raw: unknown): { mimeType: string; data: string } | null {
  if (typeof raw !== 'string' || raw.length < 32 || raw.length > MAX_IMAGE_B64) return null;
  const m = raw.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (m) return { mimeType: m[1], data: m[2] };
  return { mimeType: 'image/png', data: raw };
}

function system(canvas: { width: number; height: number }, box: { w: number; h: number }): string {
  const aspect = (canvas.width / canvas.height).toFixed(3);
  return `You generate a CUSTOM ELEMENT for a template/canvas editor — a self-contained 2D-canvas draw-function.

Return ONLY JSON, no prose:
{
  "name": "short element name",
  "description": "one sentence describing it",
  "code": "<the BODY of a function (ctx, props) => void>",
  "inputSchema": [{ "key": "...", "label": "...", "dataType": "number|string|array|object|series|ohlc", "required": true, "description": "..." }],
  "defaultData": <sample data matching inputSchema, or null if static>,
  "size": { "w": <px>, "h": <px> }
}

The draw-function receives (ctx, props):
  props = { width, height, progress (0..1), data, theme, t }
  props.theme = { fg, bg, accent, muted, positive, negative, fontFamily }

HARD RULES:
- Draw EVERYTHING relative to props.width / props.height. NEVER hardcode canvas pixel dimensions
  (do NOT use ${canvas.width}, ${canvas.height}, 1080, 1350, 1920, etc.). Derive sizes/fonts from width/height.
- Use props.theme colours + props.theme.fontFamily so it matches the template.
- Animate with props.progress (0→1) — grow/fade/draw-on. progress=1 is the settled frame (static carousels render this).
- PURE 2D canvas only. No window, document, fetch, import, require, eval, timers, network, or libraries. Synchronous. Read input ONLY from props.data.
- Read props.data DEFENSIVELY (it is either the bound shape or your defaultData; guard for missing/empty).
- DATA-BINDABILITY (important): if the element visualizes data (chart, candlestick, table, list, metric, progress, anything with values), it MUST be data-driven — declare an inputSchema of typed inputs, read EVERY displayed value from props.data (NEVER hardcode the dataset inside the code), and provide defaultData ONLY as a small sample so it previews before binding. An automation node will replace props.data with real data, so the code must render whatever shape props.data provides. Only a purely decorative/static element returns "inputSchema": [] and "defaultData": null.

CONTEXT: the canvas is ${canvas.width}×${canvas.height} (aspect ${aspect}); the element box is about ${box.w}×${box.h}. Choose a "size" (in canvas px) that fits nicely within the canvas.

EXAMPLE — a bar chart (follow this style exactly: relative coords, progress-driven, themed):
inputSchema: ${JSON.stringify(SAMPLE_BAR_CHART.inputSchema)}
defaultData: ${JSON.stringify(SAMPLE_BAR_CHART.defaultData)}
code:
${SAMPLE_BAR_CHART.code}`;
}

interface GenResult {
  name?: string; description?: string; code?: string;
  inputSchema?: unknown; defaultData?: unknown; size?: { w?: number; h?: number };
}

function cleanInputSchema(raw: unknown): ElementInput[] {
  if (!Array.isArray(raw)) return [];
  const out: ElementInput[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.key !== 'string' || !o.key) continue;
    const dataType = DATA_TYPES.includes(o.dataType as string) ? (o.dataType as ElementInput['dataType']) : 'object';
    out.push({
      key: o.key,
      label: typeof o.label === 'string' ? o.label : o.key,
      dataType,
      required: o.required === true,
      description: typeof o.description === 'string' ? o.description : undefined,
    });
  }
  return out;
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('elements:generate:' + user.id, 5))) return tooManyRequests();

  const body = (await req.json().catch(() => ({}))) as GenBody;
  const prompt = (body.prompt ?? '').trim();
  if (!prompt) return NextResponse.json({ error: 'Describe the element you want.' }, { status: 400 });
  // Size caps — the prompt and previous code go straight into a metered LLM call.
  if (prompt.length > 10_000) return NextResponse.json({ error: 'Prompt too long.' }, { status: 400 });
  if (typeof body.previousCode === 'string' && body.previousCode.length > 50_000) {
    return NextResponse.json({ error: 'Element code too large to refine.' }, { status: 400 });
  }

  const canvas = { width: Math.round(body.canvas?.width ?? 1080), height: Math.round(body.canvas?.height ?? 1350) };
  const box = { w: Math.round(body.box?.w ?? Math.round(canvas.width * 0.7)), h: Math.round(body.box?.h ?? Math.round(canvas.height * 0.4)) };

  const messages: ChatMessage[] = [
    { role: 'system', content: system(canvas, box) },
  ];
  if (body.previousCode) {
    messages.push({ role: 'user', content: `Here is the element's current code to modify:\n${body.previousCode}` });
  }

  // Vision grounding (§4.2/§4.3): attach the canvas screenshot (so it fits the template's layout/theme)
  // and, when refining, the current element's render (so it corrects legibility/overflow from real pixels).
  const images: { mimeType: string; data: string }[] = [];
  const canvasImg = parseImage(body.canvasImage);
  const renderImg = parseImage(body.renderImage);
  const notes: string[] = [];
  if (canvasImg) { images.push(canvasImg); notes.push('The first image is the CURRENT TEMPLATE CANVAS — size, place and theme the element to fit its empty space and match its colours/typography.'); }
  if (renderImg) { images.push(renderImg); notes.push(`The ${canvasImg ? 'second' : 'first'} image is the element AS CURRENTLY RENDERED in its box — critique it and FIX what is wrong: text legibility, overflow outside the box, proportions, spacing, contrast.`); }

  messages.push({
    role: 'user',
    content: notes.length ? `${prompt}\n\n${notes.join('\n')}` : prompt,
    images: images.length ? images : undefined,
  });

  try {
    // Bigger output budget than the default: a thinking model spends hidden reasoning tokens from the same
    // pool, and the answer carries a whole code string — too small a cap truncates the JSON (→ parse fail).
    // AI_MOCK returns a canned, safety-guard-passing element (no Gemini, no metering) for credit-free testing.
    const text = AI_MOCK ? mockElementJson(prompt) : await geminiChat(messages, { json: true, temperature: 0.3, maxOutputTokens: 24000, userId: user.id });
    let raw: GenResult;
    try {
      raw = parseJson<GenResult>(text);
    } catch {
      return NextResponse.json({ error: 'The model returned an empty or cut-off response — try again, or describe the element more simply.' }, { status: 502 });
    }

    const code = typeof raw.code === 'string' ? raw.code.trim() : '';
    if (!code) return NextResponse.json({ error: 'I couldn’t generate that element — try rephrasing.' }, { status: 400 });
    if (!isElementCodeSafe(code)) {
      return NextResponse.json({ error: 'The generated element used a disallowed API — try rephrasing.' }, { status: 400 });
    }

    const w = Math.max(80, Math.min(canvas.width, Math.round(raw.size?.w ?? box.w)));
    const h = Math.max(60, Math.min(canvas.height, Math.round(raw.size?.h ?? box.h)));

    return NextResponse.json({
      name: (raw.name && String(raw.name).trim()) || 'Element',
      description: (raw.description && String(raw.description).trim()) || '',
      code,
      inputSchema: cleanInputSchema(raw.inputSchema),
      defaultData: raw.defaultData ?? null,
      size: { w, h, aspect: w / h },
    });
  } catch (e) {
    if (e instanceof GeminiError) return NextResponse.json({ error: e.message }, { status: e.status });
    // Unknown = a real server fault (DB, bug), not bad input → 500 + generic message (don't leak internals).
    reportError('elements/generate', e);
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 });
  }
}
