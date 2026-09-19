-- Redeem codes: admin-generated, one free month of access each, independent of Stripe/Lemon Squeezy.
-- Generated at /admin (POST /api/admin/codes); redeemed from the paywall (POST /api/billing/redeem),
-- which claims the code atomically and inserts a subscriptions row with provider='redeem',
-- status='active' and ends_at = now + months — the normal access check (grantsAccess) honours the
-- expiry, and when it lapses the paywall returns. Run AFTER stripe_billing.sql.
-- Safe to re-run.
-- Run in: Supabase Dashboard → SQL Editor.

create table if not exists public.redeem_codes (
  code        text primary key,               -- e.g. SCALR-4F7K-9Q2M
  months      integer not null default 1,     -- how many months of access the code grants
  created_at  timestamptz not null default now(),
  redeemed_by uuid references auth.users(id) on delete set null,
  redeemed_at timestamptz
);

alter table public.redeem_codes enable row level security;
-- No policies on purpose: only the service-role key (which bypasses RLS) may touch this table —
-- users never query codes directly, they POST to /api/billing/redeem.
