import { NextResponse } from 'next/server';
import { requireUser, unauthorized, requireSubscriber } from '@/lib/serverAuth';
import { storeCredential, listCredentials } from '@/lib/automations/credentials';

export const runtime = 'nodejs';

// GET → list the user's credentials (id, label, kind — NEVER the secret).
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  try {
    return NextResponse.json({ credentials: await listCredentials(user.id) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to list credentials' }, { status: 400 });
  }
}

// POST { label, kind, secret } → store an encrypted credential; returns { id, label, kind }.
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  const subGate = await requireSubscriber(req, user); // Pro-only route (FREE_TIER_PLAN.md)
  if (subGate) return subGate;
  const { label, kind, secret } = (await req.json().catch(() => ({}))) as { label?: string; kind?: string; secret?: string };
  if (!label || !kind || !secret) return NextResponse.json({ error: 'label, kind and secret are required' }, { status: 400 });
  try {
    return NextResponse.json({ credential: await storeCredential(user.id, label, kind, secret) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to store credential' }, { status: 400 });
  }
}
