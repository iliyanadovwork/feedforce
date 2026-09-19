import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { geminiChat, parseJson, GeminiError } from '@/lib/gemini';
import { reportError } from '@/lib/reportError';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Turn pasted API docs / a cURL command / an OpenAPI snippet into a structured request spec the editor
// compiles into the HTTP node's panel (§5). Constrained-JSON Gemini call, server-side.

const SYSTEM = `You convert API documentation, a cURL command, or an OpenAPI snippet into a strict JSON spec.
Return ONLY JSON of this exact shape (no prose, no markdown):
{
  "baseUrl": "https://api.example.com",
  "auth": { "type": "none|apiKey|bearer|basic", "in": "header|query", "name": "Authorization" },
  "endpoints": [
    {
      "name": "Human label",
      "method": "GET|POST|PUT|PATCH|DELETE",
      "path": "/v1/thing/{id}",
      "params": [{ "in": "path|query|body", "name": "id", "required": true, "type": "string|number|boolean", "description": "" }],
      "outputs": [{ "name": "price", "jsonPath": "data.0.close", "dataType": "string|number|boolean|array|object" }]
    }
  ]
}
If something is unknown, omit it or use sensible defaults. Keep at most 8 endpoints.`;

interface ParsedSpec {
  baseUrl?: string;
  auth?: { type?: string; in?: string; name?: string };
  endpoints?: Array<{
    name?: string; method?: string; path?: string;
    params?: Array<{ in?: string; name?: string; required?: boolean; type?: string; description?: string }>;
    outputs?: Array<{ name?: string; jsonPath?: string; dataType?: string }>;
  }>;
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  if (!(await rateLimit('automations:parse-docs:' + user.id, 3))) return tooManyRequests();

  const { docs } = (await req.json().catch(() => ({}))) as { docs?: string };
  if (!docs || !docs.trim()) return NextResponse.json({ error: 'Paste some API docs, a cURL command, or an OpenAPI snippet.' }, { status: 400 });

  try {
    const text = await geminiChat(
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: docs.slice(0, 20_000) }],
      { json: true, temperature: 0, userId: user.id },
    );
    const spec = parseJson<ParsedSpec>(text);
    return NextResponse.json({ spec });
  } catch (e) {
    if (e instanceof GeminiError) return NextResponse.json({ error: e.message }, { status: e.status });
    reportError('automations/parse-docs', e);
    return NextResponse.json({ error: 'Could not parse those docs' }, { status: 500 });
  }
}
