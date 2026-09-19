import { NextResponse } from 'next/server';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { markAffiliatePaid } from '@/lib/affiliates';

export const runtime = 'nodejs';

// POST /api/admin/affiliates/{id}/payout — mark every unpaid, non-reversed commission for this
// affiliate as paid now (manual payout: the operator has sent the money, this records it). Returns
// how much was stamped. Gated by ADMIN_EMAILS.


// Affiliate id from the path …/affiliates/{id}/payout (avoids Next's version-specific params typing).
function targetId(req: Request): string {
  const parts = new URL(req.url).pathname.split('/');
  return decodeURIComponent(parts[parts.length - 2] ?? '');
}

export async function POST(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();
  const affiliateId = targetId(req);
  if (!affiliateId) return NextResponse.json({ error: 'Missing affiliate id' }, { status: 400 });
  // `before` is the asOf the client loaded with — bound the payout to commissions the operator
  // actually saw, so one that accrued since isn't marked paid without being sent.
  const body = (await req.json().catch(() => ({}))) as { before?: string };
  try {
    const result = await markAffiliatePaid(supabaseAdmin(), affiliateId, body.before ?? null);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Payout failed' }, { status: 500 });
  }
}
