-- Lemon Squeezy subscriptions. Source of truth is Lemon Squeezy; this table is a local mirror kept
-- in sync by the billing webhook (/api/billing/webhook), which writes with the service-role key and
-- therefore bypasses RLS. The browser may only READ its own row. Safe to run more than once.
-- Run in: Supabase Dashboard → SQL Editor (or via psql / the Management API).

create table if not exists public.subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  ls_subscription_id  text not null unique,          -- Lemon Squeezy subscription id
  ls_customer_id      text,                           -- Lemon Squeezy customer id
  ls_order_id         text,
  ls_product_id       text,
  ls_variant_id       text,
  status              text not null,                  -- on_trial | active | paused | past_due | unpaid | cancelled | expired
  plan_name           text,                           -- human-readable product/variant name
  card_brand          text,
  card_last_four      text,
  renews_at           timestamptz,                    -- next billing date (when active)
  ends_at             timestamptz,                    -- access end date (when cancelled / expired)
  trial_ends_at       timestamptz,
  customer_portal_url text,                           -- Lemon Squeezy-hosted "manage subscription" link
  update_payment_url  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists subscriptions_user_id_idx on public.subscriptions(user_id);

alter table public.subscriptions enable row level security;

-- A user may read only their own subscription. There is intentionally NO insert/update/delete policy
-- for end users: all writes come from the webhook using the service-role key (which bypasses RLS).
drop policy if exists "subscriptions: owner read" on public.subscriptions;
create policy "subscriptions: owner read"
  on public.subscriptions for select to authenticated
  using (user_id = auth.uid());

-- Note: updated_at is set explicitly by the webhook on each upsert (the column default only fires on
-- insert), so no trigger is needed here.
