import { supabase } from '@/lib/supabase';
import type { Plan } from '@/app/components/PlanContext';

// Free-tier export quota (FREE_TIER_PLAN.md): 3 finished pieces per UTC month, shared across
// carousels and reels. The ledger and the atomic check-and-increment live in Postgres
// (supabase/free_tier.sql) — this is the client face of it.

export const EXPORTS_EXHAUSTED_REASON = "You've used your 3 free exports this month — they reset on the 1st.";

export class ExportBlockedError extends Error {
  constructor() { super('Monthly export quota exhausted'); }
}

// Spend one export for the named piece. Pro users skip the round-trip entirely (unlimited — and
// their exports must never depend on the RPC being reachable). Free users consume atomically via
// the RPC, which charges each key at most once per month (re-exports of the same piece are free);
// a spent quota throws ExportBlockedError, any transport/RPC failure throws a plain Error (fail
// closed — the export itself renders client-side, so this call IS the gate). Returns exports
// remaining this month (null = unlimited).
export async function consumeExport(plan: Plan, key: string): Promise<number | null> {
  if (plan === 'pro') return null;
  const { data, error } = await supabase.rpc('consume_export', { p_key: key });
  if (error) throw new Error('Could not verify your export quota — try again.');
  const res = data as { allowed?: boolean; unlimited?: boolean; remaining?: number | null } | null;
  // A null or malformed RPC payload means we couldn't READ a verdict — fail CLOSED, but surface it as a
  // transient "try again" (a plain Error). Previously `res.unlimited` off a null payload threw a raw
  // TypeError (shown to the user), and a garbage object fell through to `!res.allowed` and threw
  // ExportBlockedError — wrongly popping the UPGRADE modal at a user whose quota we simply failed to read.
  if (!res || typeof res !== 'object' || (res.unlimited !== true && typeof res.allowed !== 'boolean')) {
    throw new Error('Could not verify your export quota — try again.');
  }
  if (res.unlimited) return null;
  if (!res.allowed) throw new ExportBlockedError();
  return res.remaining ?? null;
}

// Read-only quota status for the "N left" chip (never consumes). Null on any failure — the chip
// simply doesn't render; the consume path above still enforces.
export async function fetchExportQuota(): Promise<{ unlimited: boolean; cap: number | null; remaining: number | null } | null> {
  const { data, error } = await supabase.rpc('export_quota');
  if (error || !data) return null;
  return data as { unlimited: boolean; cap: number | null; remaining: number | null };
}
