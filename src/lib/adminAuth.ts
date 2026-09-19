import { NextResponse } from 'next/server';
import type { User, SupabaseClient } from '@supabase/supabase-js';
import { requireUser, isAdminEmail } from './serverAuth';

/** Standard 403 for admin routes whose caller failed requireAdmin. Shared so the shape stays uniform. */
export function forbidden(): NextResponse {
  return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
}

// The allowlist check lives in serverAuth (requireSubscriber needs it and imports would cycle);
// re-exported here so admin call sites keep their natural import.
export { isAdminEmail };

// Admin accounts get everything without paying (FREE_TIER_PLAN.md): a comp subscription row
// (provider 'redeem', status 'active') makes all three enforcement layers — the client plan,
// requireSubscriber, and the DB quota triggers/RPCs — read them as Pro. Called from the admin
// inbox probe, which every admin's browser hits on app load, so an account added to ADMIN_EMAILS
// self-provisions on its next visit. The row is a ROLLING LEASE, not a permanent grant: ends_at
// sits 7 days out and every probe renews it, so an email removed from ADMIN_EMAILS stops being
// renewed and the comp lapses on its own within a week (a permanent row used to outlive
// offboarding until someone remembered the manual DELETE). Best-effort: on failure the
// route-level admin bypass still covers everything except the DB quotas until the next probe.
// Immediate revoke: delete from subscriptions where user_id = '<uid>' and plan_name = 'Admin (comp)';
const ADMIN_COMP_LEASE_MS = 7 * 24 * 60 * 60 * 1000;

export async function ensureAdminComp(db: SupabaseClient, user: User): Promise<void> {
  try {
    const endsAt = new Date(Date.now() + ADMIN_COMP_LEASE_MS).toISOString();
    const { data } = await db
      .from('subscriptions')
      .select('id')
      .eq('user_id', user.id)
      .eq('plan_name', 'Admin (comp)')
      .limit(1)
      .maybeSingle();
    if (data) {
      await db.from('subscriptions')
        .update({ status: 'active', ends_at: endsAt, updated_at: new Date().toISOString() })
        .eq('id', (data as { id: string }).id);
      return;
    }
    await db.from('subscriptions').insert({
      user_id: user.id,
      provider: 'redeem',
      status: 'active',
      plan_name: 'Admin (comp)',
      ends_at: endsAt,
    });
  } catch { /* best-effort — see above */ }
}

// Admin gate for /api/admin/* routes: a signed-in user whose email is on the allowlist.
export async function requireAdmin(req: Request): Promise<User | null> {
  const user = await requireUser(req);
  if (!user?.email) return null;
  return isAdminEmail(user.email) ? user : null;
}
