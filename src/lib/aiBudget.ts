import { supabaseAdmin } from './supabaseAdmin';
import { rowGrantsAccess } from './serverAuth';

// Per-user monthly AI credit, priced in USD micro-dollars (1e-6 USD, integers, no float drift).
// Every LLM call funnels through ln / openGeminiStream, which checks hasAiBudget() before spending
// and recordAiSpend()s the actual token cost after (ledger: production/supabase/ai_usage.sql).
// The period key is ANCHORED TO THE USER'S BILLING CYCLE (resolvePeriod): the bucket rolls over on
// the subscription's renewal date, not the calendar 1st, so a fresh payment refreshes credit. Users
// with no granting subscription (admins, pre-provision, non-subscribers) fall back to the UTC month.
// Server-only (service-role client) — never import from client code.

/** Monthly credit per user in micro-USD. Default $15; override with AI_MONTHLY_BUDGET_USD. */
export const MONTHLY_BUDGET_MICROS = Math.round((Number(process.env.AI_MONTHLY_BUDGET_USD) || 15) * 1_000_000);

// Gemini paid-tier pricing, USD per 1M tokens (https://ai.google.dev/gemini-api/docs/pricing).
// Thinking tokens bill at the output rate. Pro's >200k-prompt tier is pricier ($2.50/$15) but our
// prompts are sliced well under 200k, so the base tier applies.
const PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
  'gemini-2.5-flash-lite': { inputPerM: 0.1, outputPerM: 0.4 },   // the cheapest Gemini tier
  'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10 },
  // Xiaomi MiMo via OpenRouter (https://openrouter.ai/xiaomi). Reasoning tokens fold into completion_tokens,
  // which we map to the output count — so a reasoning model bills its thinking at the output rate, as intended.
  'xiaomi/mimo-v2.5': { inputPerM: 0.105, outputPerM: 0.28 },
  'xiaomi/mimo-v2.5-pro': { inputPerM: 0.435, outputPerM: 0.87 },
};

// Token counts a completion reports. Named for Gemini's shape (the original caller); the OpenAI-compatible
// provider maps its own usage into it. `exactCostMicros` is set only when the vendor reports the ACTUAL
// amount charged (OpenRouter's usage.cost) — see costMicros.
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  /** Provider-reported exact charge in micro-USD (e.g. OpenRouter). When present it OVERRIDES the
   * token×rate estimate, so the ledger matches the provider's own accounting regardless of which upstream
   * model host served the request. */
  exactCostMicros?: number;
}

/** Calendar-month fallback key ('YYYY-MM') for users with no billing anchor (admins, non-subscribers). */
export function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** First instant of the next UTC month, the fallback reset when a user has no billing anchor. */
function nextCalendarMonth(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** A resolved AI-credit period: the ai_usage key and when it next resets (for the meter UI). */
export interface Period {
  key: string;
  resetsAt: Date;
}

type SubRow = { status: string; renews_at: string | null; ends_at: string | null };

// Derive the current AI-credit period from a user's GRANTING subscription row (pure). The key is the
// billing period-end date (renews_at, or ends_at for a cancelled-but-in-window / redeemed free-month
// row), so it advances when the provider advances the cycle, i.e. on payment. No granting row (or no
// anchor date) falls back to the UTC calendar month, preserving pre-anchoring behaviour for admins
// and non-subscribers.
//
// ASSUMES MONTHLY billing (the only plan today). An annual plan would hand its subscriber a single
// yearly bucket here; supporting one means computing a monthly sub-window from the anchor's
// day-of-month instead of keying on renews_at directly.
export function periodForSubRow(sub: SubRow | null | undefined): Period {
  if (sub && rowGrantsAccess(sub)) {
    const anchor = sub.renews_at ?? sub.ends_at;
    if (anchor) {
      const at = new Date(anchor);
      if (!Number.isNaN(at.getTime())) return { key: at.toISOString().slice(0, 10), resetsAt: at };
    }
  }
  return { key: currentPeriod(), resetsAt: nextCalendarMonth() };
}

// Resolve the user's current period, reading their subscription with the service-role client. Fails
// SAFE: any read error falls back to the calendar month and NEVER throws, so the budget gate keeps
// its fail-open guarantee (a subscriptions blip must not paywall a paying user).
export async function resolvePeriod(userId: string): Promise<Period> {
  try {
    // Order newest-first and take the first granting row so the anchor is DETERMINISTIC across calls
    // and matches the admin overview's "latest-created granting row" rule (admin/users/route.ts). A
    // user can hold >1 granting row (cross-provider overlap, a redeem free-month row alongside a paid
    // row); without ORDER BY, Postgres row order is unspecified and the gate, the meter, and admin
    // could bill/read/display different buckets. The id tiebreak makes even an exact created_at tie
    // resolve to the same row here and in admin (there is no index on created_at, so the sort is not
    // stable on its own).
    const { data, error } = await supabaseAdmin()
      .from('subscriptions')
      .select('status, renews_at, ends_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (error) throw new Error(error.message);
    const granting = ((data as SubRow[] | null) ?? []).find(rowGrantsAccess);
    return periodForSubRow(granting);
  } catch (e) {
    console.error('[aiBudget] resolvePeriod fell back to calendar month:', e instanceof Error ? e.message : e);
    return { key: currentPeriod(), resetsAt: nextCalendarMonth() };
  }
}

/** Cost of one call in micro-USD. Prefers the provider's OWN reported charge (exactCostMicros, e.g.
 * OpenRouter's usage.cost) when present; otherwise derives it from token counts × the model's rate.
 * Unknown models price as Pro (the dearest). */
export function costMicros(model: string, usage: GeminiUsageMetadata): number {
  if (usage.exactCostMicros != null) return usage.exactCostMicros;
  const p = PRICING[model] ?? PRICING['gemini-2.5-pro'];
  const inputTokens = usage.promptTokenCount ?? 0;
  const outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  // $per1M / 1M tokens × 1M micros/$ cancel out: micros = tokens × $per1M.
  return Math.ceil(inputTokens * p.inputPerM + outputTokens * p.outputPerM);
}

/** Micro-USD the user has spent so far this period (0 if no row yet). Throws on infra error. Pass an
 * already-resolved key to avoid a second subscription read; otherwise resolves the caller's period. */
export async function getSpentMicros(userId: string, key?: string): Promise<number> {
  const period = key ?? (await resolvePeriod(userId)).key;
  const { data, error } = await supabaseAdmin()
    .from('ai_usage')
    .select('spent_micros')
    .eq('user_id', userId)
    .eq('period', period)
    .maybeSingle();
  if (error) throw new Error(`ai_usage read failed: ${error.message}`);
  return (data?.spent_micros as number | undefined) ?? 0;
}

/**
 * True while the user still has credit this month. Fails OPEN on infra errors — same philosophy as
 * the rate limiter: a Supabase blip must not switch AI off for every user (the overshoot risk is one
 * month's tail of calls, bounded by the rate caps).
 */
export async function hasAiBudget(userId: string, key?: string): Promise<boolean> {
  try {
    return (await getSpentMicros(userId, key)) < MONTHLY_BUDGET_MICROS;
  } catch {
    return true;
  }
}

/** Add one call's cost to the user's current billing-cycle period. Best-effort: a failed write logs
 * but never fails the call. Pass an already-resolved key so a single AI call bills exactly the bucket
 * its gate was checked against (the funnel resolves once); otherwise it resolves the period itself. */
export async function recordAiSpend(userId: string, micros: number, key?: string): Promise<void> {
  if (micros <= 0) return;
  try {
    const period = key ?? (await resolvePeriod(userId)).key;
    const { error } = await supabaseAdmin().rpc('ai_usage_add', {
      p_user: userId,
      p_period: period,
      p_micros: micros,
    });
    if (error) console.error('[aiBudget] ai_usage_add failed:', error.message);
  } catch (e) {
    console.error('[aiBudget] ai_usage_add failed:', e instanceof Error ? e.message : e);
  }
}
