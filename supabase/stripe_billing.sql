-- Dual-provider billing: Stripe alongside Lemon Squeezy. Run AFTER subscriptions.sql.
-- Which provider NEW checkouts use is a runtime setting in app_settings (key 'billing_provider',
-- default 'stripe' in code) toggled from the /admin panel — switching it never touches existing
-- rows, so subscribers keep billing on the provider they signed up with until they churn.
-- Safe to re-run.
-- Run in: Supabase Dashboard → SQL Editor.

-- ── subscriptions: provider tag + Stripe ids ────────────────────────────────
-- Existing rows are all Lemon Squeezy; new Stripe rows get provider='stripe' from the webhook.
alter table public.subscriptions add column if not exists provider text not null default 'lemonsqueezy';
alter table public.subscriptions add column if not exists stripe_subscription_id text unique;
alter table public.subscriptions add column if not exists stripe_customer_id text;
alter table public.subscriptions add column if not exists stripe_price_id text;
-- Stripe rows have no Lemon Squeezy id (unique still holds: Postgres allows many NULLs).
alter table public.subscriptions alter column ls_subscription_id drop not null;

-- ── app_settings: tiny service-role-only key/value store ───────────────────
-- Holds runtime switches the admin panel edits (currently just billing_provider).
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
-- No policies on purpose: only the service-role key (which bypasses RLS) may read or write.
