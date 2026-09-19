import { NextResponse } from 'next/server';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

// POST /api/admin/affiliate-applications/{id}/reject { reason? } — decline a pending application.
// No Stripe/affiliate row is created. Gated by ADMIN_EMAILS.


// Application id from the path …/affiliate-applications/{id}/reject.
function targetId(req: Request): string {
  const parts = new URL(req.url).pathname.split('/');
  return decodeURIComponent(parts[parts.length - 2] ?? '');
}

export async function POST(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return forbidden();

  const id = targetId(req);
  if (!id) return NextResponse.json({ error: 'Missing application id' }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const reason = (body.reason ?? '').trim();

  const { data, error } = await supabaseAdmin()
    .from('affiliate_applications')
    .update({ status: 'rejected', reject_reason: reason || null, reviewed_at: new Date().toISOString(), reviewed_by: admin.id })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Application not found or already reviewed.' }, { status: 409 });

  return NextResponse.json({ ok: true });
}
