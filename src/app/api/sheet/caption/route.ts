import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { geminiChat, parseJson, GeminiError } from '@/lib/gemini';
import { fetchWithTimeout, isSafePublicUrl } from '@/lib/http';
import {
  buildExtractionPrompt, cleanDescription, stripSourceCitations, capCaption,
  decodeHtmlEntities, DESCRIPTION_PROMPT_PREFIX, DESCRIPTION_MAX,
} from '@/lib/sheetCaption';

export const runtime = 'nodejs';
export const maxDuration = 60;

// AI generator for a Content Sheet row (shared with the reels pipeline). From a
// pasted link the client sends up to 3 video frames plus the source post's description; this route
// produces the two sheet fields:
//   • caption      — the creator's overlay text read VERBATIM off the frames (vision, temp 0)
//   • description  — a fresh Instagram caption written from the source description as topic,
//                    grounded with Google Search, citations stripped, sentence-capped at 2000 chars
// When the source gave no description (uploads, Instagram links where the scraper returns none),
// the extracted overlay caption doubles as the topic. Budget-metered, Pro-gated like every AI route.

// ~2MB base64 ≈ 1.5MB image; the client sends ≤720px JPEGs (~200KB base64), far below this. Cap =
// cost abuse guard, and 2 × 2MB stays under the platform's 4.5MB request-body limit so an oversized
// body fails zod with a clear 400 instead of an opaque platform 413.
const MAX_IMAGE_CHARS = 2_000_000;

// Both calls need more than flash-lite: verbatim OCR-style vision reading and search-grounded prose.
const MODEL = 'gemini-2.5-flash';

const zBody = z.object({
  frames: z.array(z.string().min(32).max(MAX_IMAGE_CHARS)).max(2).optional(),
  topic: z.string().max(4000).optional(),
  link: z.string().max(2000).optional(),
});

function parseImage(raw: string): { mimeType: string; data: string } | null {
  const m = raw.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (m) return { mimeType: m[1], data: m[2] };
  return { mimeType: 'image/jpeg', data: raw };
}

// Fallback topic source for Instagram links: our /api/download importer can't recover the post's
// text, but a crawler UA gets the server-rendered og:description for public posts. Same hostname +
// SSRF checks as the importer — this fetches a user-supplied URL.
function isInstagramUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'instagram.com' || h.endsWith('.instagram.com');
  } catch { return false; }
}

async function fetchInstagramDescriptionOg(url: string): Promise<string> {
  if (!isInstagramUrl(url) || !(await isSafePublicUrl(url))) return '';
  try {
    // redirect:'manual' — the guards above only vet hop 0, and an instagram.com link-shim
    // (l.instagram.com/?u=…) could otherwise bounce this server-side fetch to an internal address.
    // Public post pages serve their og: tags directly to a crawler UA; anything that redirects is
    // not worth chasing (same hardening as /api/proxy, which re-validates every hop).
    const res = await fetchWithTimeout(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)',
        Accept: 'text/html',
      },
    }, 12_000);
    if (!res.ok) return '';
    const html = await res.text();
    const meta = html.match(/property=["']og:description["'][^>]*content="([^"]*)"/i)
      || html.match(/content="([^"]*)"[^>]*property=["']og:description["']/i);
    if (!meta) return '';
    const raw = decodeHtmlEntities(meta[1]);
    // IG format: `<n> likes, <n> comments - <user> on <date>: "<caption>"`.
    // Prefer the quoted caption; otherwise take everything after the last ": ".
    const quoted = raw.match(/:\s*"([\s\S]+)"\s*$/);
    if (quoted) return quoted[1].trim();
    const afterColon = raw.match(/:\s*([\s\S]+)$/);
    return (afterColon ? afterColon[1] : '').trim();
  } catch {
    return '';
  }
}

async function extractOverlayCaption(frames: string[], userId: string): Promise<string | null> {
  const images = frames.map(parseImage).filter((x): x is { mimeType: string; data: string } => x !== null);
  if (!images.length) return null;
  const text = await geminiChat([
    { role: 'user', content: buildExtractionPrompt(images.length), images },
  ], { json: true, temperature: 0, model: MODEL, userId });
  const raw = parseJson<{ caption?: unknown }>(text);
  const caption = typeof raw.caption === 'string' ? raw.caption.trim() : '';
  return caption || null;
}

async function writeDescription(topic: string, userId: string): Promise<string | null> {
  // Search grounding needs free-form output (no JSON mode) — citations are stripped after instead.
  const text = await geminiChat([
    { role: 'user', content: `${DESCRIPTION_PROMPT_PREFIX} ${topic}` },
  ], { search: true, temperature: 0.7, model: MODEL, userId });
  const description = capCaption(stripSourceCitations(text), DESCRIPTION_MAX);
  return description || null;
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const gate = await requireSubscriber(req, user);
  if (gate) return gate;
  // Two model calls per request (one grounded); 10/min lets a user work down a sheet without
  // opening a cost hole — the monthly AI budget inside geminiChat is the real backstop.
  if (!(await rateLimit('sheet:caption:' + user.id, 10))) return tooManyRequests();

  const parsed = zBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { frames = [], topic: rawTopic = '', link = '' } = parsed.data;

  try {
    let topic = cleanDescription(rawTopic);

    // When the client had no source description, the Instagram page itself is the next-best source.
    // Only then fall back to the extracted overlay caption — so extraction must complete first in
    // that case; otherwise the two calls run concurrently.
    if (!topic && link) topic = cleanDescription(await fetchInstagramDescriptionOg(link));

    let caption: string | null;
    let description: string | null;
    if (topic) {
      [caption, description] = await Promise.all([
        frames.length ? extractOverlayCaption(frames, user.id) : Promise.resolve(null),
        writeDescription(topic, user.id),
      ]);
    } else {
      caption = frames.length ? await extractOverlayCaption(frames, user.id) : null;
      const fallbackTopic = cleanDescription(caption ?? '');
      description = fallbackTopic ? await writeDescription(fallbackTopic, user.id) : null;
    }

    if (!caption && !description) {
      return NextResponse.json({
        error: 'Nothing to generate from — no overlay caption was found in the video and the post has no description to write from.',
      }, { status: 422 });
    }
    return NextResponse.json({ caption, description });
  } catch (e) {
    const status = e instanceof GeminiError ? e.status : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Generation failed' }, { status });
  }
}
