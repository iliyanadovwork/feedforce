-- Monthly AI credit ledger: one row per (user, billing period) accumulating what their LLM calls cost
-- in USD micro-dollars (1e-6 USD, integers, no float drift). The period is part of the key, so a new
-- period simply starts a new row at 0 and credit NEVER rolls over. The period is ANCHORED to the
-- user's subscription cycle (lib/aiBudget.ts resolvePeriod): the key is the renewal date, so credit
-- refreshes on payment, not the calendar 1st. Users with no granting subscription fall back to a
-- 'YYYY-MM' calendar-month key. The budget itself is an env var (AI_MONTHLY_BUDGET_USD, default $15),
-- not stored here.
-- Safe to re-run.
-- Run in: Supabase Dashboard → SQL Editor.

create table if not exists public.ai_usage (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  period       text        not null,           -- billing-cycle anchor 'YYYY-MM-DD', or 'YYYY-MM' fallback
  spent_micros bigint      not null default 0, -- USD micro-dollars spent this period
  calls        integer     not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (user_id, period)
);

alter table public.ai_usage enable row level security;

-- Users may READ their own usage (the Account page meter); all writes go through the RPC below,
-- called server-side with the service-role key only.
drop policy if exists "ai_usage_select_own" on public.ai_usage;
create policy "ai_usage_select_own" on public.ai_usage
  for select using (auth.uid() = user_id);

-- Atomic increment: upsert the (user, period) row and add this call's cost. Returns the new total so
-- the caller could log/act on it. Mirrors rate_limit_hit's shape (see rate_limits.sql).
create or replace function public.ai_usage_add(p_user uuid, p_period text, p_micros bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_total bigint;
begin
  insert into ai_usage as u (user_id, period, spent_micros, calls, updated_at)
  values (p_user, p_period, p_micros, 1, now())
  on conflict (user_id, period) do update set
    spent_micros = u.spent_micros + excluded.spent_micros,
    calls        = u.calls + 1,
    updated_at   = now()
  returning spent_micros into new_total;
  return new_total;
end $$;

revoke all on function public.ai_usage_add(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.ai_usage_add(uuid, text, bigint) to service_role;
