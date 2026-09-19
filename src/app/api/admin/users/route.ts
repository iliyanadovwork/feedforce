import { NextResponse } from 'next/server';
import { requireAdmin, forbidden } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { MONTHLY_BUDGET_MICROS } from '@/lib/aiBudget';
import { aiPeriodKeysByUser, matchAiUsageByUser } from '@/lib/adminAiUsage';

export const runtime = 'nodejs';

// Admin user overview (see /admin): every account with its latest subscription (provider, status,
// next payment / access-end date) and this month's AI-credit usage. Gated by ADMIN_EMAILS.


export async function GET(req: Request) {
  if (!(await requireAdmin(req))) return forbidden();

  const db = supabaseAdmin();

  // Auth users (email, signup date). Paged at 200/page — plenty of headroom for the current scale;
  // log if a page ever fills so we know to add real pagination.
  const users: Array<{ id: string; email?: string; created_at?: string; last_sign_in_at?: string }> = [];
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    users.push(...(data?.users ?? []));
    if ((data?.users?.length ?? 0) < 200) break;
    if (page === 10) console.warn('admin/users: >2000 users, response truncated');
  }

  // Subscriptions first: the AI-credit period is anchored to each user's billing cycle
  // (aiBudget.periodForSubRow), so the ai_usage key differs per user and must be known before we read
  // usage — we can no longer filter by one global calendar month. Order by (created_at, id) ascending
  // so last-write-wins keeps the SAME latest-granting row aiBudget.resolvePeriod anchors to (the id
  // tiebreak keeps them consistent even on an exact created_at tie).
  const { data: subs } = await db.from('subscriptions')
    .select('user_id,provider,status,plan_name,renews_at,ends_at,created_at')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  // Latest subscription per user for display.
  const subByUser = new Map<string, NonNullable<typeof subs>[number]>();
  for (const s of subs ?? []) subByUser.set(s.user_id as string, s);

  // Each user's current AI-credit period key, then one query for exactly those periods, then attribute
  // each usage row to its owner (see lib/adminAiUsage).
  const keyByUser = aiPeriodKeysByUser(users.map(u => u.id), (subs ?? []) as Parameters<typeof aiPeriodKeysByUser>[1]);
  const periods = [...new Set(keyByUser.values())];
  const { data: usage } = await db.from('ai_usage')
    .select('user_id,spent_micros,calls,period')
    .in('period', periods);
  const usageByUser = matchAiUsageByUser(keyByUser, (usage ?? []) as Parameters<typeof matchAiUsageByUser>[1]);

  const rows = users.map(u => {
    const sub = subByUser.get(u.id);
    const use = usageByUser.get(u.id);
    return {
      id: u.id,
      email: u.email ?? null,
      signedUpAt: u.created_at ?? null,
      lastSignInAt: u.last_sign_in_at ?? null,
      provider: sub?.provider ?? null,
      status: sub?.status ?? null,
      planName: sub?.plan_name ?? null,
      renewsAt: sub?.renews_at ?? null,
      endsAt: sub?.ends_at ?? null,
      aiSpentMicros: (use?.spent_micros as number | undefined) ?? 0,
      aiCalls: (use?.calls as number | undefined) ?? 0,
    };
  });

  return NextResponse.json({ users: rows, aiBudgetMicros: MONTHLY_BUDGET_MICROS });
}
