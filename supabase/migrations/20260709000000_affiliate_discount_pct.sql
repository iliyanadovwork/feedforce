-- Per-affiliate discount rate (was a fixed 50% for everyone). Defaults to 50 so existing rows keep
-- their current behavior; the admin can now set it per affiliate alongside commission_pct.
alter table public.affiliates
  add column if not exists discount_pct integer not null default 50 check (discount_pct between 0 and 100);
