-- Self-serve affiliate applications. An applicant creates a normal FeedForce account, then submits
-- one of these rows describing themselves (social handles, audience, promotion plan). An admin
-- reviews it in /admin -> Applications, sets the deal terms (commission %, discount %, discount
-- duration), and approves (mints the Stripe promo code + inserts the affiliates row, see
-- /api/admin/affiliate-applications/[id]/approve) or rejects it. Writes are service-role only except
-- the applicant's own insert/read (RLS below) — mirrors the affiliates/affiliate_referrals pattern in
-- 20260707180000_affiliate_system.sql.
create table if not exists public.affiliate_applications (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  status            text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  name              text not null,
  email             text not null,                          -- stamped from the applicant's account at submit time
  website           text not null default '',
  instagram_handle  text not null default '',
  tiktok_handle     text not null default '',
  youtube_handle    text not null default '',
  twitter_handle    text not null default '',
  audience_size     text not null default '',                -- free text, e.g. "40k followers"
  promotion_plan    text not null default '',                -- "how will you promote us"
  reject_reason     text,
  reviewed_at       timestamptz,
  reviewed_by       uuid references auth.users(id),
  created_at        timestamptz not null default now()
);
-- One application per account, ever. A rejected applicant has no self-serve resubmit path (v1
-- limitation) — an admin would need to reset the row's status to let them reapply.
create unique index if not exists affiliate_applications_user_id_uniq on public.affiliate_applications (user_id);

alter table public.affiliate_applications enable row level security;
grant select, insert on public.affiliate_applications to authenticated;

drop policy if exists "affiliate_applications: owner read" on public.affiliate_applications;
create policy "affiliate_applications: owner read" on public.affiliate_applications
  for select to authenticated using (user_id = (select auth.uid()));

-- Applicants can only ever insert their own row, and only as 'pending' — status transitions
-- (approve/reject) are service-role only (no update/delete policy for authenticated).
drop policy if exists "affiliate_applications: owner insert" on public.affiliate_applications;
create policy "affiliate_applications: owner insert" on public.affiliate_applications
  for insert to authenticated with check (user_id = (select auth.uid()) and status = 'pending');

-- Per-affiliate discount duration (was implicitly "once, first month only" for every affiliate).
-- null = forever; every existing/new row defaults to 1, preserving today's behavior exactly.
alter table public.affiliates
  add column if not exists discount_duration_months integer check (discount_duration_months >= 1);
update public.affiliates set discount_duration_months = 1 where discount_duration_months is null;
alter table public.affiliates alter column discount_duration_months set default 1;

-- The affiliate's own referred users, anonymized (no referred customer's name/email — just an
-- ordinal by first-referred, their subscription status/next renewal, and the commission earned from
-- them). SECURITY INVOKER: runs as the caller, scoped by the `a.user_id = auth.uid()` join below
-- (belt-and-suspenders with the owner-read RLS already on affiliate_referrals/affiliate_commissions).
create or replace function public.affiliate_referred_users()
returns table (ordinal integer, referred_at timestamptz, status text, renews_at timestamptz, revenue_cents bigint)
language sql security invoker set search_path = public as $$
  select
    row_number() over (order by r.created_at asc)::int,
    r.created_at,
    s.status,
    s.renews_at,
    coalesce((
      select sum(c.commission_cents) from public.affiliate_commissions c
      where c.referral_id = r.id and c.reversed_at is null
    ), 0)
  from public.affiliate_referrals r
  join public.affiliates a on a.id = r.affiliate_id and a.user_id = (select auth.uid())
  -- left join: a referral can land before the subscription mirror row does (webhook ordering), so
  -- status/renews_at come back null rather than the referral vanishing from the list.
  left join public.subscriptions s on s.stripe_subscription_id = r.stripe_subscription_id
  order by r.created_at asc;
$$;
revoke execute on function public.affiliate_referred_users() from public, anon;
grant execute on function public.affiliate_referred_users() to authenticated;

-- The affiliate's own commission earnings grouped by month, for the dashboard revenue chart.
-- SECURITY INVOKER: the owner-read RLS on affiliate_commissions scopes every row to the caller.
create or replace function public.affiliate_monthly_revenue()
returns table (month date, commission_cents bigint)
language sql security invoker set search_path = public as $$
  select date_trunc('month', c.created_at)::date, sum(c.commission_cents)
  from public.affiliate_commissions c
  where c.reversed_at is null
  group by 1
  order by 1;
$$;
revoke execute on function public.affiliate_monthly_revenue() from public, anon;
grant execute on function public.affiliate_monthly_revenue() to authenticated;
