import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { geminiChat, parseJson, GeminiError } from '@/lib/gemini';

export const runtime = 'nodejs';
export const maxDuration = 60;

// AI caption writer for the scheduler composer — grounded in the REAL pixels of the post. The
// client captures the selected post's slide canvases (downscaled JPEGs) and sends them here; the
// model writes the caption looking at what will actually be published, not at metadata. Budget-
// metered vision call, Pro-gated like every AI route.

// ~2.7MB base64 ≈ 2MB image; the client sends ≤640px JPEGs, far below this. Cap = cost abuse guard.
const MAX_IMAGE_CHARS = 2_700_000;

const zBody = z.object({
  images: z.array(z.string().min(32).max(MAX_IMAGE_CHARS)).max(4).optional(),
  context: z.object({
    kind: z.enum(['post', 'reel']),
    name: z.string().max(200).optional(),
    existingCaption: z.string().max(3000).optional(),
    headlines: z.array(z.string().max(300)).max(10).optional(),   // slide headlines (text grounding)
    brandName: z.string().max(120).optional(),
  }),
});

function parseImage(raw: string): { mimeType: string; data: string } | null {
  const m = raw.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (m) return { mimeType: m[1], data: m[2] };
  return { mimeType: 'image/jpeg', data: raw };
}

const SYSTEM = `You write Instagram captions for a social-media studio. Given the rendered slides of a carousel (images) or a reel's details, write ONE publish-ready caption.

Return ONLY JSON:
{ "caption": "the caption text — hook first line, 2-5 short lines, line breaks between thoughts, no hashtags inside",
  "hashtags": ["5-10 relevant tags, no # prefix, lowercase"],
  "altText": "one-sentence accessibility description of the visuals" }

Rules: match the tone and topic visible in the content; the first line must work as a feed hook (it's what shows before "…more"); no emojis unless the visuals are playful; never invent facts not visible in the content; if an existing caption is provided, improve it rather than ignoring it.`;

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const gate = await requireSubscriber(req, user);
  if (gate) return gate;
  if (!(await rateLimit('schedule:caption:' + user.id, 5))) return tooManyRequests();

  const parsed = zBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { images, context } = parsed.data;

  const parts: string[] = [
    `Content type: ${context.kind === 'reel' ? 'Instagram reel' : 'Instagram carousel post'}.`,
    context.name ? `Post name: ${context.name}` : '',
    context.brandName ? `Brand: ${context.brandName}` : '',
    context.headlines?.length ? `Slide headlines: ${context.headlines.join(' | ')}` : '',
    context.existingCaption ? `Existing caption to improve: ${context.existingCaption}` : '',
    images?.length ? 'The attached images are the rendered slides, in order.' : '',
    'Write the caption.',
  ].filter(Boolean);

  try {
    const text = await geminiChat([
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: parts.join('\n'),
        images: images?.map(parseImage).filter((x): x is { mimeType: string; data: string } => x !== null),
      },
      // No explicit maxOutputTokens: the flash model's hidden thinking tokens draw from the same
      // budget (see gemini.ts), and a low cap truncates the JSON AFTER the spend is billed. The
      // 8192 default leaves ample thinking room for a 4-image vision call with a short answer.
    ], { json: true, temperature: 0.7, userId: user.id });

    const raw = parseJson<{ caption?: string; hashtags?: unknown; altText?: string }>(text);
    const caption = typeof raw.caption === 'string' ? raw.caption.trim() : '';
    if (!caption) return NextResponse.json({ error: 'No caption came back — try again.' }, { status: 502 });
    const hashtags = (Array.isArray(raw.hashtags) ? raw.hashtags : [])
      .filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
      .map(h => h.trim().replace(/^#/, '').toLowerCase())
      .slice(0, 12);
    return NextResponse.json({
      caption,
      hashtags,
      altText: typeof raw.altText === 'string' ? raw.altText.trim() : '',
    });
  } catch (e) {
    const status = e instanceof GeminiError ? e.status : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Caption generation failed' }, { status });
  }
}
