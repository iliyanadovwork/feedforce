import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { requireUser, unauthorized } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { VERBS, VerbError, callerClient } from '@/lib/editorTools/verbs';
import { reportError } from '@/lib/reportError';

export const runtime = 'nodejs';

// The editor tools API — one dispatch endpoint over the typed verbs in lib/editorTools. This is
// the mutation/read surface the AI copilot (and later an MCP server) drives; it is NOT itself an
// LLM route, so it is rate-limited but not AI-budget-metered or Pro-gated: every verb only does
// what the signed-in user can already do in the editor, and RLS (caller-scoped client) enforces
// ownership. The future /api/editor/agent LLM loop is where Pro-gating applies.
//
// POST { verb: string, args: object } → verb result | { error, issues? }

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  // Generous limit: an agent turn can legitimately run a handful of verbs; 120/min per user
  // still stops runaway loops.
  if (!(await rateLimit('editor:tools:' + user.id, 120))) return tooManyRequests();

  const body = (await req.json().catch(() => null)) as { verb?: string; args?: unknown } | null;
  const verb = body?.verb ?? '';
  const run = VERBS[verb];
  if (!run) {
    return NextResponse.json(
      { error: `Unknown verb "${verb}". Available: ${Object.keys(VERBS).join(', ')}` },
      { status: 400 },
    );
  }

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  try {
    const result = await run(callerClient(token), user.id, body?.args ?? {});
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ZodError) {
      // Field-level issues, shaped so an agent can self-correct the exact path that failed.
      return NextResponse.json({
        error: 'Invalid arguments',
        issues: e.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      }, { status: 400 });
    }
    if (e instanceof VerbError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    reportError(`editor/tools ${verb} failed`, e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
