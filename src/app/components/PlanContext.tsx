'use client';

import { createContext, useContext } from 'react';

// Free-tier entitlements (product spec: FREE_TIER_PLAN.md). `plan` is derived from
// useSubscription in page.tsx and threaded here so feature components don't each
// re-fetch the subscription. `openUpgrade(reason)` pops the contextual UpgradeModal
// with a one-line explanation of what's locked.
//
// The default is deliberately 'pro' (fail OPEN): editor components also render in
// contexts with no provider — the server-side automation render pages — where no
// quota UI should ever appear. Real enforcement is server-side (requireSubscriber,
// the free_tier.sql triggers); this context only drives presentation.

export type Plan = 'free' | 'pro';

export interface PlanContextValue {
  plan: Plan;
  openUpgrade: (reason: string) => void;
}

const PlanContext = createContext<PlanContextValue>({ plan: 'pro', openUpgrade: () => {} });

export function PlanProvider({ value, children }: { value: PlanContextValue; children: React.ReactNode }) {
  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlan(): PlanContextValue {
  return useContext(PlanContext);
}
