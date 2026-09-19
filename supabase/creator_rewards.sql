-- Creator Rewards Program: durable record of reels published through FeedForce with the branded
-- sticker, per-month view attribution, opt-in enrollment (payout details), and the month-end payout
-- ledger. Views come from the daily rewards-views cron (Zernio per-post analytics — lifetime totals),
-- so month attribution works via first-sync-of-month baselines rather than deltas: monthly views for
-- a post = endViews − baseline(month), where endViews is next month's baseline (closed months) or the
-- live views_total (current month). Baselines are written once per post per month with
-- "on conflict do nothing", making the cron fully idempotent. Keep in sync with the fresh-setup
-- reference supabase/creator_rewards.sql.

-- 1. One row per Zernio post published through FeedForce by an enrolled user. Written by the schedule
--    routes right after a successful Zernio publish (service role); the cron updates view columns.
create table if not exists public.rewards_posts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  zernio_post_id     text not null unique,          -- idempotency: Zernio x-request-id resends return the original post id
  zernio_account_id  text not null,                 -- accountId for the per-post /analytics lookup
  sticker_enabled    boolean not null default false,
  views_total        bigint not null default 0,     -- lifetime views at last sync (never decreased)
  views_synced_at    timestamptz,                   -- null = never synced
  removed_at         timestamptz,                   -- post no longer returned by Zernio analytics (deleted upstream)
  created_at         timestamptz not null default now()
);

create index if not exists rewards_posts_user_idx on public.rewards_posts (user_id);
-- Cron scan: active sticker posts grouped by account.
create index if not exists rewards_posts_account_idx on public.rewards_posts (zernio_account_id)
  where sticker_enabled and removed_at is null;

alter table public.rewards_posts enable row level security;

drop policy if exists "rewards_posts: owner read" on public.rewards_posts;
create policy "rewards_posts: owner read"
  on public.rewards_posts for select to authenticated
  using (user_id = auth.uid());

-- 2. Month-attribution baselines: views_total as of the FIRST cron sync of that month. Insert-once
--    (on conflict do nothing) — re-running the cron never rewrites history.
create table if not exists public.rewards_post_baselines (
  rewards_post_id  uuid not null references public.rewards_posts(id) on delete cascade,
  month            date not null,                   -- first day of month, UTC
  baseline_views   bigint not null default 0,
  primary key (rewards_post_id, month)
);

-- Service-role only (cron writes, RPC reads): RLS on, no policies — same stance as rate_limits.
alter table public.rewards_post_baselines enable row level security;

-- 3. Enrollment: row exists ⇔ user is in the rewards program. Payout email collected at join;
--    Pro gating is enforced by the API route (and again at payout computation), not the table.
create table if not exists public.rewards_enrollments (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  paypal_email  text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.rewards_enrollments enable row level security;

drop policy if exists "rewards_enrollments: owner read" on public.rewards_enrollments;
create policy "rewards_enrollments: owner read"
  on public.rewards_enrollments for select to authenticated
  using (user_id = auth.uid());

-- 4. Month-end payout ledger, written by admin "finalize month" (idempotent via unique(month,user_id)),
--    with paypal_email snapshotted at finalization. paid_at stamped by admin after the manual payout.
create table if not exists public.rewards_payouts (
  id            uuid primary key default gen_random_uuid(),
  month         date not null,                     -- first day of month, UTC
  user_id       uuid not null references auth.users(id) on delete cascade,
  views         bigint not null,                   -- qualified views locked at finalization
  tier          text not null check (tier in ('top', 'rest')),
  pool_cents    bigint not null,                   -- the month's pool used for the computation (audit)
  amount_cents  bigint not null,
  paypal_email  text not null,
  paid_at       timestamptz,
  created_at    timestamptz not null default now(),
  unique (month, user_id)
);

create index if not exists rewards_payouts_month_idx on public.rewards_payouts (month);

-- Service-role only: payout rows carry pool_cents (the whole month's pool = revenue signal), which
-- users must never read directly. The user-facing summary API serves each user their own numbers.
alter table public.rewards_payouts enable row level security;

-- 5. Per-user qualified views for a month, with the per-reel 10k rule:
--    a reel enters the money calculation only once its lifetime views reach 10,000. The month it
--    crosses 10k ALL its views to date count; later months contribute only that month's gain.
--
--    End-of-month views (endV) = baseline(month+1). Live views_total substitutes ONLY while p_month
--    is the current UTC month; a closed month with no next-month baseline contributes 0 rather than
--    falling back to live totals — otherwise a post whose baselines stopped (deleted upstream, sync
--    outage) would re-pay its full lifetime views every month. The cron therefore writes monthly
--    baselines for ALL tracked posts, including removed ones (frozen views_total), so earned views
--    stay payable and the chain never breaks. Start-of-month views (startV) fall back to the latest
--    baseline at-or-before p_month, so a month with a missed sync can't re-count views paid earlier.
create or replace function public.rewards_month_views(p_month date)
returns table (user_id uuid, views bigint)
language sql
security definer
set search_path = public
as $$
  with bounds as (
    select p.user_id,
           (select b.baseline_views
              from public.rewards_post_baselines b
             where b.rewards_post_id = p.id and b.month <= p_month
             order by b.month desc
             limit 1) as start_views,
           case
             when nb.baseline_views is not null then nb.baseline_views
             when p_month = (date_trunc('month', now() at time zone 'utc'))::date then p.views_total
             else null
           end as end_views
    from public.rewards_posts p
    left join public.rewards_post_baselines nb
      on nb.rewards_post_id = p.id and nb.month = (p_month + interval '1 month')::date
    where p.sticker_enabled
      and p.created_at < (p_month + interval '1 month')
  )
  select user_id,
         sum(
           case
             when end_views is null or end_views < 10000 then 0
             when coalesce(start_views, 0) < 10000 then end_views
             else greatest(0, end_views - start_views)
           end
         )::bigint as views
  from bounds
  group by user_id
$$;

revoke execute on function public.rewards_month_views(date) from public, anon, authenticated;
grant execute on function public.rewards_month_views(date) to service_role;
