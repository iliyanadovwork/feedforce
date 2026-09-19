import { NextResponse } from 'next/server';
import { requireUser, unauthorized } from '@/lib/serverAuth';
import { getSpentMicros, MONTHLY_BUDGET_MICROS, resolvePeriod } from '@/lib/aiBudget';

export const runtime = 'nodejs';

// The signed-in user's AI credit for the current billing-cycle period (see lib/aiBudget.ts): how much
// of the budget is spent and when it resets (their renewal date, or the 1st if they have no anchor).
// Powers the usage meter on the Account page.
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  try {
    const { key, resetsAt } = await resolvePeriod(user.id);
    const spentMicros = await getSpentMicros(user.id, key);
    return NextResponse.json({
      spentMicros,
      budgetMicros: MONTHLY_BUDGET_MICROS,
      resetsAt: resetsAt.toISOString(),
    });
  } catch {
    return NextResponse.json({ error: 'Could not load AI usage' }, { status: 500 });
  }
}
