-- Affiliate system. Each affiliate has a Stripe promotion code (e.g. PRESSI50) that gives the
-- customer 50% off their first month AND tags the sale to that affiliate. The affiliate earns a
-- recurring commission (default 10%) on EVERY payment the referred customer makes, for the life of
-- the subscription. Manual payouts: the admin panel reads the commission ledger and stamps
-- paid_out_at when the affiliate has been paid.
--
-- Attribution: /api/billing/stripe-webhook writes a referral on checkout.session.completed (the
-- session carries both the user and the promotion code used), then writes one commission row per
-- paid invoice (invoice.payment_succeeded). All writes go through the service role.
--
-- All three tables are service-role only (no RLS policies) — like redeem_codes/app_settings. Users
-- never touch them; the admin API and webhook (service-role key, bypasses RLS) are the only writers.

-- The affiliates themselves.
create table if not exists public.affiliates (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  email                 text not null default '',              -- contact / where payouts go
  code                  text not null,                         -- the Stripe promo code, e.g. PRESSI50
  commission_pct        integer not null default 10 check (commission_pct between 0 and 100),
  stripe_coupon_id      text,                                  -- the %-off-first-month coupon backing the code
  stripe_promo_code_id  text,                                  -- the Stripe promotion_code object id
  active                boolean not null default true,         -- deactivating stops NEW attributions
  payout_notes          text not null default '',              -- how to pay them (bank / PayPal / etc.)
  -- Links the affiliate to a (free) FeedForce login so a future affiliate dashboard can show them
  -- their own stats. Nullable: admins create affiliates who may not have an account yet, and it's
  -- set once they claim one. Phase 2 adds the owner-read RLS + the dashboard page on top of this.
  user_id               uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now()
);
-- Case-insensitive uniqueness — Stripe matches promo codes case-insensitively at checkout.
create unique index if not exists affiliates_code_lower_uniq on public.affiliates (lower(code));
-- One active affiliate per Stripe promotion code, so attribution's maybeSingle() lookup is
-- unambiguous (two active affiliates can't share a code id).
create unique index if not exists affiliates_promo_code_active_uniq
  on public.affiliates (stripe_promo_code_id) where active and stripe_promo_code_id is not null;
-- One affiliate per account (nullable, so many not-yet-linked affiliates coexist). Keeps the
-- dashboard's "my affiliate row" a single row and prevents an accidental double-link.
create unique index if not exists affiliates_user_id_uniq
  on public.affiliates (user_id) where user_id is not null;

-- One row per referred subscription: which affiliate gets credit for it.
create table if not exists public.affiliate_referrals (
  id                     uuid primary key default gen_random_uuid(),
  affiliate_id           uuid not null references public.affiliates(id) on delete cascade,
  user_id                uuid not null references auth.users(id) on delete cascade,
  stripe_subscription_id text not null unique,                 -- one referral per subscription (idempotent)
  created_at             timestamptz not null default now()
);
create index if not exists affiliate_referrals_affiliate_idx on public.affiliate_referrals (affiliate_id);

-- The payout ledger: one row per successful payment on a referred subscription.
create table if not exists public.affiliate_commissions (
  id                  uuid primary key default gen_random_uuid(),
  referral_id         uuid not null references public.affiliate_referrals(id) on delete cascade,
  affiliate_id        uuid not null references public.affiliates(id) on delete cascade,  -- denormalized for reporting
  stripe_invoice_id   text not null unique,                    -- idempotency: one commission per invoice
  gross_amount_cents  integer not null,                        -- what the customer actually paid (after any discount)
  commission_cents    integer not null,                        -- gross * commission_pct, locked at payment time
  currency            text not null default 'usd',
  created_at          timestamptz not null default now(),
  paid_out_at         timestamptz,                             -- stamped when the affiliate has been paid (manual)
  -- Refund / chargeback: the payment was reversed, so this commission is no longer owed. The payout
  -- view excludes rows where reversed_at is set. Kept as a row (not deleted) for an audit trail.
  reversed_at         timestamptz,
  reversal_reason     text
);
-- Unpaid-commission lookups per affiliate for the payouts view.
create index if not exists affiliate_commissions_affiliate_idx on public.affiliate_commissions (affiliate_id, paid_out_at);

alter table public.affiliates            enable row level security;
alter table public.affiliate_referrals   enable row level security;
alter table public.affiliate_commissions enable row level security;
-- Writes are service-role only (admin API + webhook). Reads: an affiliate may SELECT ONLY their own
-- data (their row + their referrals + their commissions), matched via affiliates.user_id — that's
-- what powers the affiliate dashboard. No user INSERT/UPDATE/DELETE.
grant select on public.affiliates, public.affiliate_referrals, public.affiliate_commissions to authenticated;

drop policy if exists "affiliates: owner read" on public.affiliates;
create policy "affiliates: owner read" on public.affiliates
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "affiliate_referrals: owner read" on public.affiliate_referrals;
create policy "affiliate_referrals: owner read" on public.affiliate_referrals
  for select to authenticated using (exists (
    select 1 from public.affiliates a where a.id = affiliate_id and a.user_id = (select auth.uid())
  ));

drop policy if exists "affiliate_commissions: owner read" on public.affiliate_commissions;
create policy "affiliate_commissions: owner read" on public.affiliate_commissions
  for select to authenticated using (exists (
    select 1 from public.affiliates a where a.id = affiliate_id and a.user_id = (select auth.uid())
  ));

-- Per-affiliate rollups for the admin list, aggregated IN SQL so totals stay correct past any
-- client row cap. earned/unpaid exclude reversed rows; clawback = reversed AFTER being paid out
-- (a refund on money already sent to the affiliate). Service-role only.
create or replace function public.admin_affiliate_stats()
returns table (affiliate_id uuid, referrals bigint, earned_cents bigint, unpaid_cents bigint, clawback_cents bigint)
language sql security definer set search_path = public as $$
  select a.id,
    (select count(*) from public.affiliate_referrals r where r.affiliate_id = a.id),
    coalesce((select sum(c.commission_cents) from public.affiliate_commissions c
              where c.affiliate_id = a.id and c.reversed_at is null), 0),
    coalesce((select sum(c.commission_cents) from public.affiliate_commissions c
              where c.affiliate_id = a.id and c.reversed_at is null and c.paid_out_at is null), 0),
    coalesce((select sum(c.commission_cents) from public.affiliate_commissions c
              where c.affiliate_id = a.id and c.reversed_at is not null and c.paid_out_at is not null), 0)
  from public.affiliates a;
$$;
revoke execute on function public.admin_affiliate_stats() from public, anon, authenticated;
grant execute on function public.admin_affiliate_stats() to service_role;

-- The signed-in affiliate's OWN totals for their dashboard. SECURITY INVOKER: runs as the caller, so
-- the owner-read RLS above scopes every count/sum to their own rows; aggregated in SQL (no client cap).
create or replace function public.affiliate_self_stats()
returns table (referrals bigint, earned_cents bigint, unpaid_cents bigint, paid_cents bigint, clawback_cents bigint)
language sql security invoker set search_path = public as $$
  select
    (select count(*) from public.affiliate_referrals),
    coalesce((select sum(commission_cents) from public.affiliate_commissions where reversed_at is null), 0),
    coalesce((select sum(commission_cents) from public.affiliate_commissions where reversed_at is null and paid_out_at is null), 0),
    coalesce((select sum(commission_cents) from public.affiliate_commissions where reversed_at is null and paid_out_at is not null), 0),
    coalesce((select sum(commission_cents) from public.affiliate_commissions where reversed_at is not null and paid_out_at is not null), 0);
$$;
-- Strip the default PUBLIC grant so anon can't call it (matching admin_affiliate_stats hardening);
-- authenticated callers are still scoped to their own rows by the owner-read RLS above.
revoke execute on function public.affiliate_self_stats() from public, anon;
grant execute on function public.affiliate_self_stats() to authenticated;
