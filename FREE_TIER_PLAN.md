# FeedForce Free Tier — Product Plan

Status: **implemented, pending rollout** (as of 2026-07-04). Enforcement lives in
`supabase/free_tier.sql` (quotas: exports/templates/storage), `lib/serverAuth.ts`'s
`isSubscriber` gate on the AI/automations/schedule/elements API routes, and the
`PlanContext`/`UpgradeModal` UI layer. The migration must be applied to prod BEFORE
the code deploys (exports call the `consume_export` RPC).

## Philosophy

Free users get the full creation experience; paying unlocks scale and distribution.
The upgrade prompt happens at moments of real intent — exporting, reaching for AI —
not at the front door. The current hard paywall (subscribe before touching anything)
is retired: no subscription row simply *is* the free plan.

## Tiers

| | Free | Pro (subscribers) |
|---|---|---|
| Carousel & Reels editors | ✅ Full access | ✅ |
| Brand kit | ✅ | ✅ |
| Saved templates | 1 carousel + 1 reel — editable and replaceable, just can't accumulate more | Unlimited |
| Exports (finished carousels or reels, shared pool) | **3 per month**, resets monthly, no watermark | Unlimited |
| Media uploads | **500MB total, 100MB per file** (images and video alike — no separate video rules) | Effectively unlimited |
| Import video by link (TikTok / IG / X) | ✅ | ✅ |
| AI features (elements, automation builder) | ❌ — visible with a Pro badge | ✅ |
| Node automations | ❌ | ✅ |
| Scheduling & publishing | ❌ | ✅ |
| Analytics | ❌ | ✅ |

## Decision sheet

| Decision | Choice | Rationale / notes |
|---|---|---|
| Export quota | 3 per month, monthly reset | Counts finished pieces out, whatever the mix — a carousel's PNG set = 1, a reel MP4 = 1. Charged per piece via export keys (`carousel:<templateId>` / `reel:<entryId>`): re-exporting an already-charged piece (another slide, a retry, a re-download) is free within the month. Monthly reset (not a lifetime cap) keeps free users coming back. |
| Export pool | One shared pool | 3 total across carousels + reels, not 3 per kind — one counter, honest tier. |
| Watermark | None | Neither on exports nor on the canvas. |
| Template cap | 1 carousel + 1 reel | Editable and replaceable — free users can delete and start over, they just can't accumulate a stable. |
| Lapsed subscribers | Work is never deleted | Templates beyond the cap become **read-only** (most recently edited stays active); media stays put. |
| Upload budget | 500MB total, 100MB per file | Input side, independent of exports. The byte caps double as the video policy: 100MB admits a normal sub-minute phone clip, 500MB holds a handful of clips plus effectively unlimited images. No length caps unless abuse shows up. |
| Video-by-link | Free ✅ | Watch item: resolves/downloads via our server (`/api/download`), so it consumes our bandwidth — revisit if free-tier usage gets expensive. |
| AI / automations / scheduling / analytics | Pro only | The features with real marginal cost; enforced server-side. |
| Locked-feature UX | Visible with Pro badge + upgrade prompt | Hidden features sell nothing. |
| Admin accounts | Everything free | `ADMIN_EMAILS` accounts bypass `requireSubscriber` outright, render as Pro in the UI (the admin probe doubles as the signal), and self-provision a permanent comp subscription row (`plan_name 'Admin (comp)'`, provider `redeem`, no `ends_at`) on first app load so the DB quota layer passes too. Revoke by removing from `ADMIN_EMAILS` and deleting that row. |
| Rollout | Quiet launch, email later | See Rollout below. |

## Enforcement posture

- The features with real marginal cost (AI, automations, scheduling) are enforced
  **server-side** in their API routes — leak-proof.
- Export/template/storage quotas are enforced at the database layer, with friendly
  UI preflights. Client-side rendering means a determined user can screenshot or
  devtools their way past the export cap; we deliberately don't fight this. The cap
  targets honest workflow users — people willing to screenshot-and-crop ten slides a
  post were never customers, and DRM theater would cost more than it saves.

## Rollout

1. Existing signed-up-but-never-subscribed accounts automatically become free users —
   the paywall just disappears for them on next login.
2. Launch quietly first to shake out the quotas with low traffic.
3. Later (optional): announcement email to dormant signups — a free reactivation
   campaign. Blocked on choosing an email provider (Resend was removed over cost);
   nothing in the build depends on it.

## Accepted trade-offs

- Some export-cap leakage via screenshots (see enforcement posture).
- Bigger support surface — free users can reach support chat too.
- Modest Supabase storage/egress cost growth (a maxed-out free account is ~cents/month).
- Some would-have-paid users will live in the free tier forever.

In exchange: an actual top-of-funnel instead of a hard wall, upgrade prompts placed
at peak motivation, and free users' exported content acting as organic distribution.
