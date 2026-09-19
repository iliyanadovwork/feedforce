import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { geminiChat, parseJson, GeminiError, BudgetError } from '@/lib/gemini';
import type { ChatMessage, ChatOpts } from '@/lib/llm/providers';
import { reportError } from '@/lib/reportError';
import { runGraphUpTo, graphLimitError } from '@/lib/automations';
import { serverNodeRegistry } from '@/lib/automations/serverNodes';
import { buildRunServices } from '@/lib/automations/serverContext';
import { runBuildAgent, type AgentLLM, type SourcePlan, type CodePlan, type AgentInput } from '@/lib/automations/buildAgent';
import type { Graph } from '@/lib/automations/types';

export const runtime = 'nodejs';
// The agent makes several grounded LLM calls AND runs the source live (with retries) — give it room.
export const maxDuration = 300;

// Gemini responseSchema uses the Schema proto (Type enum is UPPERCASE in REST JSON).
const SOURCE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    url: { type: 'STRING' },
    method: { type: 'STRING' },
    authKind: { type: 'STRING', enum: ['none', 'apiKey'] },
    needsKey: { type: 'BOOLEAN' },
    note: { type: 'STRING' },
  },
  required: ['url'],
};
const CODE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    needsCode: { type: 'BOOLEAN' },
    code: { type: 'STRING' },
    note: { type: 'STRING' },
  },
  required: ['needsCode'],
};
const GATE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    actionable: { type: 'BOOLEAN' },
    goal: { type: 'STRING' },
    reply: { type: 'STRING' },
  },
  required: ['actionable'],
};
interface GateResult { actionable?: boolean; goal?: string; reply?: string }

interface BuildBody {
  goal?: string;
  resume?: { graph: Graph; httpNodeId: string };
  credentialId?: string;
  history?: Array<{ role?: string; content?: string }>; // recent chat turns, for the conversational gate
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Retryable = a vendor 429/5xx or fetchWithTimeout's 60s abort. NOT BudgetError (its 429 is our monthly
// credit gate — hopeless until the 1st, retrying it just stalls the user before their own error).
const isTransient = (e: unknown) =>
  (e instanceof GeminiError && !(e instanceof BudgetError) && (e.status === 429 || (e.status >= 500 && e.status < 600))) ||
  (e instanceof Error && e.name === 'AbortError');

/** Exponential backoff between retries: 1s, 2s, 4s, … capped at 8s. Never retry immediately — an instant
 *  retry lands in the same overload spike that just rejected us. */
const backoff = (attempt: number) => sleep(Math.min(1_000 * 2 ** attempt, 8_000));

// How long into the request retrying stays allowed (epoch-ms `deadline` = request start + this). Sized so
// the WORST retry (a hung upstream: 2 fetches × 60s timeout inside geminiChat) still finishes inside
// maxDuration 300s and fails as a clean JSON error — not a platform 504 with an unparseable body.
const RETRY_BUDGET_MS = 150_000;

/** geminiChat with extra retries on transient 429/5xx/timeout — Google-Search grounding especially 503s
 *  under load ("high demand"), and geminiChat only retries a 5xx once, so a spike would kill the build. */
async function robustChat(messages: ChatMessage[], opts: ChatOpts, deadline: number, retries = 3): Promise<string> {
  for (let i = 0; ; i++) {
    try { return await geminiChat(messages, opts); }
    catch (e) {
      if (isTransient(e) && i < retries && Date.now() < deadline) { await backoff(i); continue; }
      throw e;
    }
  }
}

/** robustChat + parseJson, re-asking ONCE when the reply isn't valid JSON — a truncated or garbled reply
 *  is as transient as a 503 and must not 500 the whole build. */
async function robustJson<T>(messages: ChatMessage[], opts: ChatOpts, deadline: number): Promise<T> {
  try { return parseJson<T>(await robustChat(messages, opts, deadline)); }
  catch (e) {
    // Re-ask only parse failures (transport errors were already retried), and only inside the deadline —
    // a late re-ask could stack another ~2min worst case past maxDuration.
    if (!(e instanceof SyntaxError) || Date.now() >= deadline) throw e;
    return parseJson<T>(await robustChat(messages, opts, deadline));
  }
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route
  if (subGate) return subGate;
  if (!(await rateLimit('automations:agent:' + user.id, 6))) return tooManyRequests();

  const body = (await req.json().catch(() => ({}))) as BuildBody;
  let goal = String(body.goal ?? '').slice(0, 2_000).trim();
  if (!goal && !body.resume) return NextResponse.json({ error: 'Describe what the automation should do.' }, { status: 400 });
  // Resume graph is client-supplied — cap it before we run it live.
  if (body.resume?.graph) {
    const limit = graphLimitError(body.resume.graph);
    if (limit) return NextResponse.json({ error: limit }, { status: 400 });
  }

  const services = buildRunServices(user.id);
  const model = 'gemini-2.5-flash'; // the harder reasoning task — not flash-lite
  const deadline = Date.now() + RETRY_BUDGET_MS; // retries allowed only inside this window

  const llm: AgentLLM = {
    discover: async (g, prior) => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Use web search to READ the online documentation of real, public JSON APIs and choose ONE that returns the data for the user’s goal. STRONGLY prefer free / no-auth APIs. From the docs, give the exact endpoint URL WITH the required query params, the HTTP method, whether an API key is required, and a one-line reason. Concrete only — a URL that returns JSON right now.' },
        { role: 'user', content: `Goal: ${g}${prior.length ? `\nAlready tried (avoid these): ${prior.join(', ')}` : ''}` },
      ];
      // Grounding ("read the docs online") 503s heavily under load on this tier. Ride it out: many attempts
      // with exponential backoff, ROTATING models (each has its own grounding capacity), so it actually
      // reads the web instead of dying on a spike. Only if grounding stays down do we fall back to the
      // model's own API knowledge (it still knows the common public APIs) — the build should never fail
      // on a grounding blip.
      const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          return await geminiChat(messages, { search: true, temperature: 0.3, userId: user.id, model: models[attempt % models.length] });
        } catch (e) {
          if (!isTransient(e)) throw e;
          if (Date.now() >= deadline) break;
          if (attempt < 7) await backoff(attempt);
        }
      }
      return robustChat(messages, { temperature: 0.3, userId: user.id, model }, deadline); // last resort: knowledge only
    },

    planSource: (g, discovery, failure) =>
      robustJson<SourcePlan>([
        { role: 'system', content: 'Extract ONE concrete HTTP GET endpoint to call, as JSON. Prefer authKind "none"; set "apiKey"/needsKey only when a key is genuinely required to get data.' },
        { role: 'user', content: `Goal: ${g}\nResearch:\n${discovery.slice(0, 4_000)}${failure ? `\n\n${failure}` : ''}` },
      ], { responseSchema: SOURCE_SCHEMA, temperature: 0.2, userId: user.id, model }, deadline),

    planCode: (g, sample, failure) =>
      robustJson<CodePlan>([
        { role: 'system', content: 'Decide whether the raw API data needs a small transform to become clean per-record data for a carousel template, and if so WRITE it. Format: `export default function run(ctx){ … }` where ctx.input is EXACTLY the data sample below, already parsed and already unwrapped (any { status, ok, data } envelope is stripped by the runtime — never read ctx.input.data or index by a node label); return an object or a non-empty array. Only add a transform if it genuinely helps (pick the array out of a wrapper, flatten, rename). Pure JS, no network/imports.' },
        { role: 'user', content: `Goal: ${g}\nData sample (JSON):\n${JSON.stringify(sample ?? null).slice(0, 4_000)}${failure ? `\n\n${failure}` : ''}` },
      ], { responseSchema: CODE_SCHEMA, temperature: 0.2, userId: user.id, model }, deadline),
  };

  const runUpTo = (graph: Graph, targetId: string) => runGraphUpTo(graph, serverNodeRegistry, targetId, { userId: user.id, services });

  try {
    // ── Conversational gate ── "hi" / "what can you do?" must not launch a web-search build. One cheap
    // flash-lite call decides: an actionable automation goal proceeds to the build; anything else gets a
    // friendly chat reply (status "chat" — the panel renders it as a normal assistant bubble). Skipped on
    // resume: a resume IS the continuation of an already-gated build.
    if (!body.resume) {
      const history = (Array.isArray(body.history) ? body.history : [])
        .filter(t => (t?.role === 'user' || t?.role === 'assistant') && typeof t.content === 'string')
        .slice(-8)
        .map(t => ({ role: t.role as 'user' | 'assistant', content: String(t.content).slice(0, 2_000) }));
      const gate = await robustJson<GateResult>([
        { role: 'system', content: 'You are the chat gate of FeedForce\'s automation builder. The user is on an EMPTY automation canvas. Decide whether, IN THE CONTEXT OF THE CONVERSATION, the user is asking for a data automation to be built. That includes (a) a direct goal that names or implies data to fetch and post (e.g. "post the top crypto mover every morning"), and (b) a follow-up that commits to an idea already discussed — "do it", "yes", "build that", "the first one" all mean: build the automation described earlier. If they are (or plausibly are — when unsure, lean actionable), return {"actionable": true, "goal": "..."} where goal is ONE self-contained sentence describing the automation, resolved from the whole conversation — it must make sense on its own to someone who never saw the chat, so never echo bare words like "do it". Otherwise — greetings, questions, small talk, feedback — return {"actionable": false, "reply": "..."} where reply is a short, warm answer (1–3 sentences) speaking directly to the user as "you". Never describe the user in the third person and never restate or summarise their request back at them — respond to what they said, mention what you can do (find a public data API, wire it into a carousel template, run it on a schedule), and invite a concrete goal with one example.' },
        ...history,
        { role: 'user', content: goal },
      ], { responseSchema: GATE_SCHEMA, temperature: 0.3, userId: user.id, model: 'gemini-2.5-flash-lite' }, deadline);
      if (!gate.actionable) {
        return NextResponse.json({
          status: 'chat',
          message: gate.reply?.trim() || 'Tell me what you’d like to automate — e.g. “post the current weather for London to a carousel every day”.',
        });
      }
      // Build with the gate's history-resolved goal: the raw latest turn may be an anaphoric "do it"
      // that would send the discovery step web-searching for the literal words "do it".
      const resolved = (gate.goal ?? '').trim().slice(0, 2_000);
      if (resolved) goal = resolved;
    }

    const input: AgentInput = { goal, resume: body.resume, credentialId: body.credentialId };
    const outcome = await runBuildAgent(input, { llm, runUpTo });
    return NextResponse.json(outcome);
  } catch (e) {
    if (e instanceof GeminiError) {
      // 5xx and vendor 429s = the vendor shedding load/quota. Swap the raw upstream body (Google's
      // "high demand" text reads like a FeedForce outage) for our own copy. Our own errors (BudgetError,
      // bad request) keep their already-user-facing messages.
      const vendorBusy = e.status >= 500 || (e.status === 429 && !(e instanceof BudgetError));
      const message = vendorBusy
        ? 'The AI service is busy right now — give it a minute and try again.'
        : e.message;
      return NextResponse.json({ error: message }, { status: e.status });
    }
    reportError('automations/build', e);
    return NextResponse.json({ error: 'The AI builder hit a snag — try again.' }, { status: 500 });
  }
}
