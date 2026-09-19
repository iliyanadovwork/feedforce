'use client';

import { useEffect, useState } from 'react';
import { authedFetch } from '@/lib/authedFetch';

// ── Rewards-program enrollment ────────────────────────────────────────────────────────────────────
// Whether the signed-in user is enrolled in the creator rewards program (GET /api/rewards/enrollment,
// 401/403 for signed-out/free users). Gates the per-reel "FeedForce sticker" toggle: non-enrolled
// users never see it and their schedule requests never carry the flag. Fails CLOSED — any error or
// non-200 reads as not enrolled, never throws.

// Session-stable answer per user (mirrors CanvasGrid's reelSelectionCache idiom): a section
// round-trip re-renders instantly with no refetch. Only SUCCESSFUL (2xx) responses are cached — a
// thrown network error or a non-ok status stays uncached so the next mount retries (a transient 500
// must not read as "not enrolled" for the whole session).
const enrollmentCache = new Map<string, boolean>();
// Bumped by invalidateRewardsEnrollment: a fetch already in flight at invalidation time must not
// write its (now stale) answer back into the cache.
const cacheEpoch = new Map<string, number>();

/** Drop the cached enrollment answer for a user (e.g. after joining/leaving the program) so the
 *  next mount refetches instead of serving the stale flag. */
export function invalidateRewardsEnrollment(userId: string): void {
  enrollmentCache.delete(userId);
  cacheEpoch.set(userId, (cacheEpoch.get(userId) ?? 0) + 1);
}

export function useRewardsEnrollment(userId: string | null): { enrolled: boolean; loaded: boolean } {
  // Re-render trigger for a fetch settling on THIS mount; the answer itself is read from the cache
  // (or this record, for an uncached error result). Keyed by user so a mid-fetch account
  // switch can't surface the previous user's answer.
  const [fetched, setFetched] = useState<{ userId: string; enrolled: boolean } | null>(null);

  useEffect(() => {
    if (!userId || enrollmentCache.has(userId)) return;   // nothing to fetch — derived at render below
    const epoch = cacheEpoch.get(userId) ?? 0;
    let cancelled = false;
    (async () => {
      let enrolled = false;
      let definitive = false;
      try {
        const res = await authedFetch('/api/rewards/enrollment');
        if (res.ok) {
          definitive = true;   // the server answered successfully — cache it
          const json = await res.json().catch(() => null) as { enrolled?: boolean } | null;
          enrolled = json?.enrolled === true;
        }
        // non-ok → not enrolled for now, but NOT cached: a later mount retries
      } catch { /* network blip → not enrolled for now, retry on next mount */ }
      if (cancelled) return;
      if (definitive && (cacheEpoch.get(userId) ?? 0) === epoch) enrollmentCache.set(userId, enrolled);
      setFetched({ userId, enrolled });
    })();
    return () => { cancelled = true; };
  }, [userId]);

  if (!userId) return { enrolled: false, loaded: true };   // signed out → definitively not enrolled
  const cached = enrollmentCache.get(userId);
  if (cached !== undefined) return { enrolled: cached, loaded: true };
  if (fetched?.userId === userId) return { enrolled: fetched.enrolled, loaded: true };
  return { enrolled: false, loaded: false };
}
