// Client plumbing for the free-tier upgrade prompt (FREE_TIER_PLAN.md). Anything that discovers a
// plan limit — a 403 subscription_required from an API route (authedFetch), a quota trigger firing
// in Postgres (supabase/free_tier.sql), a UI-level gate — funnels through requestUpgrade();
// page.tsx listens and opens the UpgradeModal with the given reason.

export const UPGRADE_REQUIRED_EVENT = 'feedforce:upgrade-required';

export function requestUpgrade(reason?: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(UPGRADE_REQUIRED_EVENT, { detail: { reason } }));
}

// The database quota triggers reject with stable tokens in the error message. Returns the human
// reason for the upgrade modal, or null when the error is unrelated (caller handles it as usual).
export function upgradeReasonForDbError(message: string | null | undefined): string | null {
  if (!message) return null;
  if (message.includes('free_plan_template_limit')) return 'The free plan includes one carousel and one reel template — Pro removes the cap.';
  if (message.includes('free_plan_storage_quota')) return "You've filled the free plan's 500MB of upload storage — Pro removes the cap.";
  if (message.includes('free_plan_file_too_large')) return 'Uploads over 100MB need a Pro subscription.';
  return null;
}
