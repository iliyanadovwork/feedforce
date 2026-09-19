/**
 * Copilot debug CLI — drive the REAL editor-copilot funnel from the terminal and see the raw model
 * output + exactly where parsing/validation breaks. No auth gate, no subscriber check, no metering
 * (passes no userId), so it's a pure repro harness for "why did the copilot return X".
 *
 *   npx tsx scripts/copilot-cli.mts "make the headline bigger"
 *   npx tsx scripts/copilot-cli.mts --model gemini-2.5-flash "redesign this slide"
 *   npx tsx scripts/copilot-cli.mts --model gemini-2.5-flash-lite --image ~/ref.png "recreate this style"
 *
 * Loads GEMINI_API_KEY / GEMINI_MODEL from .env.local automatically.
 */
import { readFileSync } from 'node:fs';
import { openGeminiStream, parseJson, type ChatMessage } from '@/lib/gemini';
import { editorAgentSystemPrompt } from '@/lib/editorTools/promptDoc';
import { zAgentResponse, zAgentAction } from '@/lib/editorTools/agentActions';

// Load .env.local into process.env (the key is read at call time, so this runs after the hoisted imports
// but before the funnel call — fine). Model is passed explicitly, so the import-time MODEL const is moot.
for (const line of (() => { try { return readFileSync('.env.local', 'utf8'); } catch { return ''; } })().split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const argv = process.argv.slice(2);
let model: string | undefined;
let imagePath: string | undefined;
const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--model') model = argv[++i];
  else if (argv[i] === '--image') imagePath = argv[++i];
  else words.push(argv[i]);
}
const prompt = words.join(' ') || 'make the headline bigger';
const resolvedModel = model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

const template = {
  id: 't1', name: 'Test template', activeSlideId: 's1',
  slides: [{ id: 's1', name: 'Slide 1', position: 0, headline: 'Your headline here', subheadline: 'A supporting line', settings: {} }],
};

const userTurn: ChatMessage = { role: 'user', content: prompt };
if (imagePath) {
  const buf = readFileSync(imagePath.replace(/^~/, process.env.HOME ?? '~'));
  const ext = imagePath.split('.').pop()?.toLowerCase();
  userTurn.images = [{ mimeType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg', data: buf.toString('base64') }];
}

const chat: ChatMessage[] = [
  { role: 'system', content: editorAgentSystemPrompt([]) },
  {
    role: 'user',
    content:
      `CURRENT TEMPLATE STATE (compact JSON — fields omitted are at their defaults):\n${JSON.stringify(template)}` +
      (imagePath ? `\n\nThe user attached an IMAGE to their latest message — read it and act on it (see the image rules in your instructions).` : '') +
      `\n\nThe conversation follows. Answer ONLY for the latest user message.`,
  },
  userTurn,
];

console.log(`\n=== copilot-cli ===`);
console.log(`model:  ${resolvedModel}`);
console.log(`prompt: ${prompt}${imagePath ? `  (+image ${imagePath})` : ''}\n`);

const deltas = await openGeminiStream(chat, { json: true, temperature: 0.35, maxOutputTokens: 16_000, model: resolvedModel });
let raw = '';
for await (const d of deltas) raw += d;

console.log('----- RAW MODEL OUTPUT -----');
console.log(raw);
console.log(`----- (${raw.length} chars) -----\n`);

console.log('----- PARSE + VALIDATE (exactly what the route does) -----');
try {
  const parsed = parseJson<{ reply?: string; actions?: unknown[] }>(raw);
  const env = zAgentResponse.safeParse(parsed);
  if (!env.success) {
    console.log('❌ envelope invalid:', env.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' · '));
  } else {
    console.log('✅ envelope ok — reply:', JSON.stringify((env.data.reply ?? '').slice(0, 90)));
    const actions = env.data.actions ?? [];
    console.log(`   ${actions.length} action(s):`);
    actions.forEach((a, i) => {
      const r = zAgentAction.safeParse(a);
      console.log(`   [${i}] ${r.success ? '✅ ' + r.data.type : '❌ ' + JSON.stringify(a).slice(0, 70) + ' — ' + r.error.issues.map(iss => `${iss.path.join('.')}: ${iss.message}`).join('; ')}`);
    });
  }
} catch (e) {
  console.log('❌ JSON.parse FAILED (malformed/truncated) —', e instanceof Error ? e.message : e);
  console.log('   → this is exactly the "The model returned an unreadable response" case in the UI.');
}
