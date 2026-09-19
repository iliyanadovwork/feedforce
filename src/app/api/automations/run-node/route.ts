import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { serverNodeRegistry } from '@/lib/automations/serverNodes';
import { buildRunServices } from '@/lib/automations/serverContext';

export const runtime = 'nodejs';

// Run a single node with the given config (and optional mocked inputs) and return its outputs.
// Powers the "Run" button in a node's config panel.
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;

  const { type, config, inputs } = await req.json().catch(() => ({}));
  const def = serverNodeRegistry[type as string];
  if (!def) return NextResponse.json({ error: `No runner for node type "${type}"` }, { status: 400 });

  // Throttle AI node-tests tightly (they spend shared Gemini quota); other node tests (HTTP/template) get
  // a looser cap so iterating on a flow isn't painful.
  if (!(await rateLimit('automations:run-node:' + user.id, type === 'ai' ? 4 : 15))) return tooManyRequests();

  try {
    const outputs = await def.run({ config: config ?? {}, inputs: inputs ?? {}, userId: user.id, services: buildRunServices(user.id) });
    return NextResponse.json({ outputs });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Run failed' }, { status: 400 });
  }
}
