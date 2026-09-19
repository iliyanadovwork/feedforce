import { NextResponse } from 'next/server';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

// Admin "comp" toggle (see /admin users table): grants or revokes free access for one target user
// without touching any real subscription they may already have. Mirrors ensureAdminComp
// (lib/adminAuth.ts) — a permanent 'redeem' row with no ends_at — but for an arbitrary user_id
// instead of the admin's own, under a distinct plan_name so it's distinguishable from
// self-provisioned admin access. Gated by ADMIN_EMAILS.


// Must match the literal checked client-side in admin/page.tsx. Not exported: Next.js route
// files only permit specific named exports (HTTP methods + a small config allowlist).
const COMP_PLAN_NAME = 'Comp (admin-granted)';

// User id from the path (avoids Next's version-specific params typing): …/users/{id}/comp
function targetId(req: Request): string {
  const parts = new URL(req.url).pathname.split('/');
  return decodeURIComponent(parts[parts.length - 2] ?? '');
}

export async function POST(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();

  const body = (await req.json().catch(() => ({}))) as { active?: boolean };
  if (typeof body.active !== 'boolean') {
    return NextResponse.json({ error: 'Body must be { active: boolean }' }, { status: 400 });
  }
  const userId = targetId(req);
  if (!userId) return NextResponse.json({ error: 'Missing user id' }, { status: 400 });

  const db = supabaseAdmin();

  try {
    if (body.active) {
      const { data: existing } = await db
        .from('subscriptions')
        .select('id')
        .eq('user_id', userId)
        .eq('plan_name', COMP_PLAN_NAME)
        .limit(1)
        .maybeSingle();
      if (!existing) {
        const { error } = await db.from('subscriptions').insert({
          user_id: userId,
          provider: 'redeem',
          status: 'active',
          plan_name: COMP_PLAN_NAME,
        });
        if (error) throw error;
      }
    } else {
      const { error } = await db
        .from('subscriptions')
        .delete()
        .eq('user_id', userId)
        .eq('plan_name', COMP_PLAN_NAME);
      if (error) throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Save failed' }, { status: 500 });
  }
}
