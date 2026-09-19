/**
 * Head-to-head model A/B for the editor copilot. Drives the REAL funnel (so it exercises the exact
 * provider routing, streaming, and validation the app uses) across a fixed prompt set, N times each,
 * per model, and reports the three things that actually decide the copilot's model:
 *
 *   • UNREADABLE rate — the stream produced JSON that won't parse/validate (the "unreadable response" bug)
 *   • APPLIED rate    — at least one action validated against the real zod schema (the edit lands)
 *   • latency         — median wall-clock to a fully drained stream
 *
 *   npx tsx scripts/model-ab.mts                                  # gemini-2.5-flash vs xiaomi/mimo-v2.5
 *   npx tsx scripts/model-ab.mts gemini-2.5-flash xiaomi/mimo-v2.5-pro
 *   RUNS=5 npx tsx scripts/model-ab.mts                           # 5 iterations per prompt (default 3)
 *
 * Needs GEMINI_API_KEY for the Gemini column and MIMO_API_KEY for the MiMo column (loaded from .env.local).
 * A model with no key is reported as KEY-MISSING and skipped, so this is safe to run before both keys exist.
 */
import { readFileSync } from 'node:fs';
import { openGeminiStream, parseJson, type ChatMessage } from '@/lib/gemini';
import { editorAgentSystemPrompt } from '@/lib/editorTools/promptDoc';
import { zAgentResponse, zAgentAction } from '@/lib/editorTools/agentActions';

for (const line of (() => { try { return readFileSync('.env.local', 'utf8'); } catch { return ''; } })().split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const models = process.argv.slice(2).length ? process.argv.slice(2) : ['gemini-2.5-flash', 'xiaomi/mimo-v2.5'];
const RUNS = Math.max(1, Number(process.env.RUNS) || 3);
const IMG = 'src/assets/opt/ex1.jpg';

const template = { id: 't1', name: 'Test', activeSlideId: 's1', slides: [{ id: 's1', name: 'Slide 1', position: 0, headline: 'Your headline here', subheadline: 'A supporting line', settings: {} }] };

interface Prompt { label: string; text: string; image?: boolean }
const PROMPTS: Prompt[] = [
  { label: 'simple', text: 'make the headline bigger' },
  { label: 'multi', text: 'redesign this slide completely — dark palette, bigger bolder centered headline, add a NEWS tag, tighten the subheadline' },
  { label: 'image', text: 'recreate this style', image: true },
];

function buildChat(p: Prompt): ChatMessage[] {
  const userTurn: ChatMessage = { role: 'user', content: p.text };
  if (p.image) {
    const buf = readFileSync(IMG);
    userTurn.images = [{ mimeType: 'image/jpeg', data: buf.toString('base64') }];
  }
  return [
    { role: 'system', content: editorAgentSystemPrompt([]) },
    { role: 'user', content: `CURRENT TEMPLATE STATE (compact JSON):\n${JSON.stringify(template)}` + (p.image ? `\n\nThe user attached an IMAGE — read it and act on it.` : '') + `\n\nAnswer ONLY for the latest user message.` },
    userTurn,
  ];
}

type Outcome = 'CLEAN' | 'PARTIAL' | 'NOOP' | 'UNREADABLE' | 'ERROR';
interface Result { outcome: Outcome; ms: number; validActions: number }

async function runOnce(model: string, p: Prompt): Promise<Result> {
  const t0 = Date.now();
  try {
    const deltas = await openGeminiStream(buildChat(p), { json: true, temperature: 0.35, maxOutputTokens: 16_000, model });
    let raw = '';
    for await (const d of deltas) raw += d;
    const ms = Date.now() - t0;
    let parsed: { actions?: unknown[] };
    try { parsed = parseJson(raw); } catch { return { outcome: 'UNREADABLE', ms, validActions: 0 }; }
    const env = zAgentResponse.safeParse(parsed);
    if (!env.success) return { outcome: 'UNREADABLE', ms, validActions: 0 };
    const actions = env.data.actions ?? [];
    const valid = actions.filter(a => zAgentAction.safeParse(a).success).length;
    const outcome: Outcome = valid === 0 ? 'NOOP' : valid === actions.length ? 'CLEAN' : 'PARTIAL';
    return { outcome, ms, validActions: valid };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/API_?KEY|not set/i.test(msg)) throw Object.assign(new Error('KEY-MISSING'), { keyMissing: true });
    return { outcome: 'ERROR', ms: Date.now() - t0, validActions: 0 };
  }
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

console.log(`\n=== model A/B — ${RUNS} run(s) × ${PROMPTS.length} prompts each ===\n`);

for (const model of models) {
  const results: Result[] = [];
  let keyMissing = false;
  for (const p of PROMPTS) {
    for (let i = 0; i < RUNS; i++) {
      try { results.push(await runOnce(model, p)); }
      catch (e) { if ((e as { keyMissing?: boolean }).keyMissing) { keyMissing = true; break; } throw e; }
    }
    if (keyMissing) break;
  }
  if (keyMissing) { console.log(`${model.padEnd(24)}  KEY-MISSING — set its API key in .env.local to include it\n`); continue; }

  const n = results.length;
  const c = (o: Outcome) => results.filter(r => r.outcome === o).length;
  const applied = c('CLEAN') + c('PARTIAL');
  const lat = median(results.map(r => r.ms));
  console.log(`── ${model} ──`);
  console.log(`   runs:        ${n}`);
  console.log(`   UNREADABLE:  ${c('UNREADABLE')}  (${pct(c('UNREADABLE'), n)})   ← the bug; want 0`);
  console.log(`   APPLIED:     ${applied}  (${pct(applied, n)})   [CLEAN ${c('CLEAN')} / PARTIAL ${c('PARTIAL')}]`);
  console.log(`   NOOP:        ${c('NOOP')}   ERROR: ${c('ERROR')}`);
  console.log(`   median latency: ${lat} ms\n`);
}

function pct(a: number, b: number): string { return b ? `${Math.round((100 * a) / b)}%` : '—'; }
