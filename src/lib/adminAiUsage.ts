import { rowGrantsAccess } from './serverAuth';
import { periodForSubRow } from './aiBudget';

// Pure helpers behind the admin overview's AI-credit column (api/admin/users). Extracted so the
// per-user period attribution — the one piece of new admin logic not covered by the aiBudget tests —
// is unit-testable without standing up the whole route. Server-only.

type SubRow = { user_id: string; status: string; renews_at: string | null; ends_at: string | null; created_at?: string | null };
type UsageRow = { user_id: string; period: string; spent_micros: number; calls: number };

// The current billing-cycle period key per user, matching lib/aiBudget.resolvePeriod: the LATEST
// granting subscription row by (created_at, id). `subs` MUST arrive ordered oldest→newest (the route
// fetches them ORDER BY created_at, id ascending), so last-write-wins keeps exactly that row.
export function aiPeriodKeysByUser(userIds: string[], subs: SubRow[]): Map<string, string> {
  const grantingByUser = new Map<string, SubRow>();
  for (const s of subs) if (rowGrantsAccess(s)) grantingByUser.set(s.user_id, s);
  return new Map(userIds.map(id => [id, periodForSubRow(grantingByUser.get(id) ?? null).key]));
}

// Keep only each user's CURRENT-period ai_usage row. A single `.in('period', keys)` across everyone's
// keys can return rows for OTHER users that happen to share a date string, so match on (user_id, period).
export function matchAiUsageByUser(
  keyByUser: Map<string, string>,
  usageRows: UsageRow[],
): Map<string, { spent_micros: number; calls: number }> {
  const out = new Map<string, { spent_micros: number; calls: number }>();
  for (const row of usageRows) {
    if (keyByUser.get(row.user_id) === row.period) {
      out.set(row.user_id, { spent_micros: row.spent_micros, calls: row.calls });
    }
  }
  return out;
}
