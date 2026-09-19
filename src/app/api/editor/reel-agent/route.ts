import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { openGeminiStream, parseJson, GeminiError, COPILOT_MODEL } from '@/lib/gemini';
import type { ChatMessage } from '@/lib/gemini';
import { AI_MOCK, mockDeltas, mockReelsJson } from '@/lib/aiMock';
import { copilotStreamResponse } from '@/lib/editorTools/copilotStream';
import { reelAgentSystemPrompt } from '@/lib/editorTools/reelPromptDoc';
import { zTwitterTemplateSettingsPatch } from '@/lib/editorTools/reelsSchema';

export const runtime = 'nodejs';
// The copilot stream budgets a 120s first-token timeout; the function must outlive that, not the ~60s default.
export const maxDuration = 120;

// The reels copilot planner. A reel template is one overlay, so one metered call returns
// { reply, patch } — a validated Partial<TwitterTemplateSettings> the client applies through the
// editor's updateSettings funnel (autosave + undo for free). Pro-gated + metered like every AI route.

const MAX_STATE_CHARS = 60_000;
const MAX_HISTORY = 12;

const zBody = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(8_000),
  })).min(1).max(50),
  settings: z.record(z.string(), z.unknown()),   // compact reel settings (diff vs defaults)
  templateName: z.string().max(200).optional(),
  extraFonts: z.array(z.string()).max(60).optional(),
  brand: z.object({
    logoUrl: z.string().max(2000).optional(),
    displayName: z.string().optional(),
    colors: z.array(z.string().max(16)).max(12).optional(),
  }).optional(),
  image: z.string().min(64).max(3_000_000).optional(),
});

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const gate = await requireSubscriber(req, user);
  if (gate) return gate;
  if (!(await rateLimit('editor:reel-agent:' + user.id, 10))) return tooManyRequests();

  const parsed = zBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }, { status: 400 });
  }
  const { messages, settings, templateName, extraFonts, brand, image } = parsed.data;

  const stateJson = JSON.stringify(settings);
  if (stateJson.length > MAX_STATE_CHARS) {
    return NextResponse.json({ error: 'This reel template is too large for the copilot.' }, { status: 400 });
  }

  const history = messages.slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content } as ChatMessage));
  if (image && history.length > 0) {
    const m = image.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    const img = m ? { mimeType: m[1], data: m[2] } : { mimeType: 'image/jpeg', data: image };
    history[history.length - 1] = { ...history[history.length - 1], images: [img] };
  }

  const chat: ChatMessage[] = [
    { role: 'system', content: reelAgentSystemPrompt(extraFonts ?? []) },
    {
      role: 'user',
      content:
        `CURRENT REEL SETTINGS (compact JSON — omitted fields are at their defaults)${templateName ? ` for "${templateName}"` : ''}:\n${stateJson}` +
        (brand ? `\n\nBRAND (prefer these colors unless asked otherwise): ${JSON.stringify(brand)}` : '') +
        (image ? `\n\nThe user attached an IMAGE to their latest message — read it and act per your rules.` : '') +
        `\n\nThe conversation follows. Answer ONLY for the latest user message.`,
    },
    ...history,
  ];

  // Open the stream first so the budget gate / a non-OK upstream still surface as a normal JSON error.
  let deltas: AsyncGenerator<string>;
  if (AI_MOCK) {
    // Zero-cost canned response (no Gemini, no metering); streamed through the identical pipeline.
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
    deltas = mockDeltas(mockReelsJson({ text: lastUser, brandColors: brand?.colors }));
  } else {
    try {
      deltas = await openGeminiStream(chat, { json: true, temperature: 0.35, maxOutputTokens: 8_000, userId: user.id, signal: req.signal, model: COPILOT_MODEL });
    } catch (e) {
      const status = e instanceof GeminiError ? e.status : 500;
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Copilot failed' }, { status });
    }
  }

  return copilotStreamResponse(deltas, (fullText) => {
    const raw = parseJson(fullText) as { reply?: string; patch?: unknown };
    let patch: Record<string, unknown> | undefined;
    let warning: string | undefined;
    if (raw.patch && typeof raw.patch === 'object' && Object.keys(raw.patch as object).length > 0) {
      const res = zTwitterTemplateSettingsPatch.safeParse(raw.patch);
      if (res.success && Object.keys(res.data).length > 0) patch = res.data as Record<string, unknown>;
      else warning = 'The AI proposed an invalid change, so nothing was applied.';
    }
    return {
      reply: typeof raw.reply === 'string' && raw.reply ? raw.reply : (patch ? 'Done.' : 'Let me know what you’d like to change.'),
      patch,
      warning,
    };
  });
}
