// Rewards view-sync: mapping a Zernio /analytics listing to per-post view counts, and deciding what
// the cron should do with each tracked post.
//
// Zernio wraps the "Late" publishing API (getlate.dev → docs.zernio.com), so every post carries TWO
// ids: Zernio's own `_id` and the underlying `latePostId`. A reel published through us is recorded in
// rewards_posts under the id the publish response returns — the `latePostId`, NOT `_id`. The analytics
// listing is keyed by `_id`, so matching a tracked post ONLY against `_id` silently misses every post
// (0 views ever sync, and the miss also reads as "deleted upstream" → false removed_at). Index by BOTH
// ids so a tracked zernio_post_id matches whichever id space it was stored under. (Confirmed
// 2026-07-25: 0/33 tracked posts matched `_id`, 29/33 matched `latePostId`.)

// Only the fields the rewards cron reads off an analytics post. `views` is null at the post level in
// the live shape — the real count is nested under `analytics.views`.
export interface AnalyticsPost {
  _id?: string;
  latePostId?: string;
  views?: number | null;
  analytics?: { views?: number | null };
}

// Fold an analytics page into a postId -> views lookup, indexing by both `_id` and `latePostId`. Also
// records PRESENCE (into `present`, if given) — every id SEEN in the listing, regardless of whether a
// numeric view count is available yet. Presence and measurement are deliberately separate: a freshly
// published reel appears in the listing with views not-yet-computed, and the removal logic must not
// mistake "present but unmeasured" for "deleted". A real count of 0 IS kept as a measurement.
export function indexAnalyticsViews(
  posts: AnalyticsPost[],
  into?: Map<string, number>,
  present?: Set<string>,
): Map<string, number> {
  const views = into ?? new Map<string, number>();
  for (const p of posts) {
    if (present) {
      if (p._id) present.add(p._id);
      if (p.latePostId) present.add(p.latePostId);
    }
    const v = p.views ?? p.analytics?.views;
    if (typeof v !== 'number') continue;
    if (p._id) views.set(p._id, v);
    if (p.latePostId) views.set(p.latePostId, v);
  }
  return views;
}

export type PostAction = 'sync' | 'heal' | 'remove' | 'noop';

// Decide what the view-sync cron should do with ONE tracked post this run:
//   sync   — measured this run: advance views_total + views_synced_at (and lift any stale removal).
//   remove — was ONCE measured and is now confirmed absent from a fully-paged, non-empty listing:
//            genuinely deleted upstream, stamp removed_at.
//   heal   — currently removed but should NOT be (present again, or never legitimately removable):
//            clear removed_at.
//   noop   — nothing to do.
//
// A post is legitimately "removed" ONLY when it was previously measured (views_synced_at set) AND is
// now absent from a complete listing. Every other absent state (present-but-unmeasured, or
// never-synced/brand-new/not-yet-listed) is treated as too-new-to-judge and must never be removed.
// Un-removal (heal) requires POSITIVE evidence the removal was wrong — the post is present again, or
// it was never legitimately removable (never synced, e.g. the ID-mismatch false removals). An
// INCONCLUSIVE listing (allowRemoval false: soft-disconnect, partial paging, pagination drift) is NOT
// evidence, so a once-measured, genuinely-removed post is left alone rather than resurrected. This
// closes the class of bug where the ID mismatch made the cron mistake unmatched-live posts for
// deletions and irreversibly remove them, without letting self-heal reverse legitimate deletions.
export function decidePostAction(
  post: { views_synced_at: string | null; removed_at: string | null },
  ctx: { measured: boolean; present: boolean; allowRemoval: boolean },
): PostAction {
  if (ctx.measured) return 'sync'; // the caller's sync update also clears removed_at when it was set
  const shouldBeRemoved = ctx.allowRemoval && !ctx.present && !!post.views_synced_at;
  if (shouldBeRemoved) return post.removed_at ? 'noop' : 'remove';
  if (post.removed_at && (ctx.present || !post.views_synced_at)) return 'heal';
  return 'noop';
}

// Build the DB patch for a MEASURED tracked post. Extracted + tested because these are money-critical
// invariants that would otherwise sit untested inside the cron: views_total NEVER shrinks (Math.max —
// a Zernio blip returning a lower count must not erase earned views), and a measured post is
// definitively live so a stale removed_at is lifted (the primary self-heal path for a recovered post).
export function buildSyncPatch(
  post: { views_total: number; removed_at: string | null },
  fetched: number,
  now: string,
): { views_total: number; views_synced_at: string; removed_at?: null } {
  const patch: { views_total: number; views_synced_at: string; removed_at?: null } = {
    views_total: Math.max(post.views_total, fetched),
    views_synced_at: now,
  };
  if (post.removed_at) patch.removed_at = null;
  return patch;
}
