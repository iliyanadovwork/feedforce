import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { openGeminiStream, parseJson, GeminiError, COPILOT_MODEL, CONTEXT_WINDOW } from '@/lib/gemini';
import type { ChatMessage } from '@/lib/gemini';
import { AI_MOCK, mockDeltas, mockCarouselJson } from '@/lib/aiMock';
import { copilotStreamResponse } from '@/lib/editorTools/copilotStream';
import { editorAgentSystemPrompt } from '@/lib/editorTools/promptDoc';
import { zAgentAction, zAgentResponse } from '@/lib/editorTools/agentActions';
import type { AgentAction } from '@/lib/editorTools/agentActions';

export const runtime = 'nodejs';
// The copilot stream budgets a 120s first-token timeout; the function must outlive that, not the ~60s default.
export const maxDuration = 120;

// The editor copilot planner. One metered LLM call per user message: the client sends the chat
// history + the template's COMPACT state (diff-vs-defaults, so a whole carousel is a few KB), the
// model returns { reply, actions[] }. Actions are validated here against the shared zod protocol
// (agentActions.ts); the client applies valid ones through the editor hook so every AI edit is
// autosaved and undoable. Invalid actions are dropped and reported as warnings — the client can
// surface them and the user can re-ask.
//
// Pro-gated + budget-metered (geminiChat with userId) like every LLM route.

const MAX_STATE_CHARS = 120_000;    // compact template state — generous; a big carousel is ~10-30KB
const MAX_HISTORY = 12;

const zBody = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(8_000),
  })).min(1).max(50),
  // Compact template state, produced client-side with compactCarouselSettings. Passed through
  // verbatim as model context — shape-validated only loosely here (the client owns it).
  template: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    activeSlideId: z.string().nullable().optional(),
    slides: z.array(z.object({
      id: z.string(),
      name: z.string(),
      position: z.number(),
      headline: z.string(),
      subheadline: z.string(),
      settings: z.record(z.string(), z.unknown()),
    })).min(1).max(30),
  }),
  extraFonts: z.array(z.string()).max(60).optional(),   // user-uploaded font labels
  brand: z.object({
    logoUrl: z.string().max(2000).optional(),
    displayName: z.string().optional(),
    colors: z.array(z.string().max(16)).max(12).optional(),   // the brand palette (hex strings)
  }).optional(),
  // Optional image the user attached to their latest message (a data table to chart, a style
  // reference, a logo…) — downscaled client-side to a small JPEG. Only rides when present.
  image: z.string().min(64).max(3_000_000).optional(),
});

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const gate = await requireSubscriber(req, user);
  if (gate) return gate;
  if (!(await rateLimit('editor:agent:' + user.id, 10))) return tooManyRequests();

  const parsed = zBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }, { status: 400 });
  }
  const { messages, template, extraFonts, brand, image } = parsed.data;

  const stateJson = JSON.stringify(template);
  if (stateJson.length > MAX_STATE_CHARS) {
    return NextResponse.json({ error: 'Template too large for the copilot — try a template with fewer slides.' }, { status: 400 });
  }

  // Attach the user's image (if any) to their LATEST turn, so the model reads it in context.
  const history = messages.slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content } as ChatMessage));
  if (image && history.length > 0) {
    const m = image.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    const parsedImg = m ? { mimeType: m[1], data: m[2] } : { mimeType: 'image/jpeg', data: image };
    const last = history[history.length - 1];
    history[history.length - 1] = { ...last, images: [parsedImg] };
  }

  const chat: ChatMessage[] = [
    { role: 'system', content: editorAgentSystemPrompt(extraFonts ?? []) },
    {
      role: 'user',
      content:
        `CURRENT TEMPLATE STATE (compact JSON — fields omitted are at their defaults):\n${stateJson}` +
        (brand ? `\n\nBRAND (prefer these colors for any color choice unless asked otherwise): ${JSON.stringify(brand)}` : '') +
        (image ? `\n\nThe user attached an IMAGE to their latest message — read it and act on it (see the image rules in your instructions).` : '') +
        `\n\nThe conversation follows. Answer ONLY for the latest user message.`,
    },
    ...history,
  ];

  // Open the stream first: the budget gate / a non-OK upstream throw here, BEFORE we commit to a
  // streamed 200, so those still surface as a normal JSON error the client can read via res.ok.
  let deltas: AsyncGenerator<string>;
  let turnUsage: { input: number; output: number } | undefined;   // set by onUsage at end-of-stream
  if (AI_MOCK) {
    // Zero-cost canned response (no Gemini, no metering); streamed through the identical pipeline.
    const slideId = template.activeSlideId && template.slides.some(s => s.id === template.activeSlideId) ? template.activeSlideId : template.slides[0].id;
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
    deltas = mockDeltas(mockCarouselJson({ slideId, text: lastUser, brandColors: brand?.colors }));
  } else {
    try {
      deltas = await openGeminiStream(chat, { json: true, temperature: 0.35, maxOutputTokens: 16_000, userId: user.id, signal: req.signal, model: COPILOT_MODEL, onUsage: (u) => { turnUsage = u; } });
    } catch (e) {
      const status = e instanceof GeminiError ? e.status : 500;
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Copilot failed' }, { status });
    }
  }

  // The reply prose streams as `token` events; the whole JSON is parsed + validated once at end-of-
  // stream (throwing → an in-band `error` event), so actions still arrive whole and pre-validated. The
  // finalize runs AFTER the stream drains, so onUsage has already set turnUsage — ride it along for the UI.
  return copilotStreamResponse(deltas, (fullText) => {
    const raw: z.infer<typeof zAgentResponse> = zAgentResponse.parse(parseJson(fullText));
    const actions: AgentAction[] = [];
    const warnings: string[] = [];
    for (const [i, candidate] of (raw.actions ?? []).entries()) {
      const res = zAgentAction.safeParse(candidate);
      if (res.success) actions.push(res.data);
      else warnings.push(`action ${i + 1} (${(candidate as { type?: string })?.type ?? 'unknown'}): ${res.error.issues.map(iss => `${iss.path.join('.')}: ${iss.message}`).join('; ')}`);
    }
    const usage = turnUsage ? { ...turnUsage, contextWindow: CONTEXT_WINDOW[COPILOT_MODEL] ?? 1_048_576 } : undefined;
    // Fallback is present-tense to match the reply's preamble convention (it renders ABOVE the change card).
    return { reply: raw.reply || 'On it.', actions, warnings, usage };
  });
}
