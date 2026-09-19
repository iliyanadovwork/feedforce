'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

// Local mirror of a subscription (see production/supabase/subscriptions.sql + stripe_billing.sql).
// Read-only from the browser via RLS; the source of truth is the billing provider (Stripe or Lemon
// Squeezy), synced by that provider's webhook.
export interface Subscription {
  provider: 'stripe' | 'lemonsqueezy' | 'redeem'; // redeem = a free-month code, no billing provider
  status: string;                 // on_trial | active | paused | past_due | unpaid | cancelled | expired
  plan_name: string | null;
  renews_at: string | null;
  ends_at: string | null;
  trial_ends_at: string | null;
  customer_portal_url: string | null;
  update_payment_url: string | null;
}

// A subscription still grants access while active/on-trial, or while cancelled but not yet past its
// paid-through date. Whatever the status, a set ends_at is a hard expiry — that's how redeemed
// free-month rows (provider 'redeem', status 'active', ends_at = +1 month, no webhook to flip them)
// lapse on their own. Exported as the ONE client-side copy of the access predicate — other client
// surfaces (admin dashboard) must use this, not re-derive it.
export function grantsAccess(s: Pick<Subscription, 'status' | 'ends_at'> | null): boolean {
  if (!s) return false;
  if (s.ends_at && new Date(s.ends_at).getTime() <= Date.now()) return false;
  if (s.status === 'active' || s.status === 'on_trial') return true;
  if (s.status === 'cancelled' && s.ends_at) return true; // ends_at already checked above
  return false;
}

// Fetch ALL of the user's rows: access is granted by ANY live row — the same predicate the server
// (requireSubscriber) and the database (has_active_subscription) apply. A user can hold several
// rows (e.g. a lapsed Lemon Squeezy one plus a live Stripe one); checking only the newest rendered
// such subscribers as free while every server check disagreed. `error: true` means the fetch
// FAILED — deliberately distinct from "no rows", which really is the free plan.
async function fetchSubscriptions(
  userId: string | null | undefined,
): Promise<{ subs: Subscription[]; error: boolean }> {
  if (!userId) return { subs: [], error: false };
  const { data, error } = await supabase
    .from('subscriptions')
    .select('provider,status,plan_name,renews_at,ends_at,trial_ends_at,customer_portal_url,update_payment_url')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) return { subs: [], error: true };
  return { subs: (data as Subscription[]) ?? [], error: false };
}

const RETRY_DELAYS_MS = [2000, 5000, 10000];

export function useSubscription(userId: string | null | undefined) {
  // Keep the result tagged with the user it was fetched for: loading is then DERIVED (result is for
  // a different user), so gates on this hook never act on the previous user's (or the signed-out)
  // value while a refetch after sign-in is still in flight.
  const [result, setResult] = useState<{ forUser: string | null; subs: Subscription[] } | null>(null);

  // A transient fetch failure must NOT render a paying subscriber as free (locked sections, quota
  // chips, upgrade prompts). Retry with backoff and only accept the answer once a fetch SUCCEEDS;
  // until then the hook stays in `loading`. After the retries are exhausted we fall through to
  // free — bounded degradation beats an infinite spinner.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const attempt = async (attemptNo: number) => {
      const { subs, error } = await fetchSubscriptions(userId);
      if (cancelled) return;
      if (error && attemptNo < RETRY_DELAYS_MS.length) {
        timer = window.setTimeout(() => void attempt(attemptNo + 1), RETRY_DELAYS_MS[attemptNo]);
        return;
      }
      if (error) console.error('useSubscription: fetch failed after retries — treating as free');
      setResult({ forUser: userId ?? null, subs });
    };
    void attempt(0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [userId]);

  const refresh = useCallback(async () => {
    const { subs, error } = await fetchSubscriptions(userId);
    // A failed manual refresh keeps the last good answer instead of downgrading the UI.
    if (error) return;
    setResult({ forUser: userId ?? null, subs });
  }, [userId]);

  const loading = !result || result.forUser !== (userId ?? null);
  const subs = loading ? [] : result!.subs;
  // Display row for the Account page: the newest access-granting row, else the newest row.
  const subscription = subs.find(grantsAccess) ?? subs[0] ?? null;

  const isActive = subs.some(grantsAccess);
  // Free tier (FREE_TIER_PLAN.md): no access-granting row simply IS the free plan.
  // Meaningless while loading — gate on `loading` before acting on it.
  const plan: 'free' | 'pro' = isActive ? 'pro' : 'free';

  return { subscription, isActive, plan, loading, refresh };
}
