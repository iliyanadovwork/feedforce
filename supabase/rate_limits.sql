-- Shared fixed-window rate limiting, backed by Postgres so limits hold across serverless instances
-- (the in-process limiter alone resets per instance — parallel requests to different instances could
-- bypass it). One row per (route, user) key; an atomic upsert RPC counts hits within the window.
-- Called ONLY server-side with the service-role key (lib/rateLimit.ts); no client access.
-- Rows are tiny and bounded (#users × #limited-routes); the cleanup cron prunes stale ones.
-- Safe to re-run.
-- Run in: Supabase Dashboard → SQL Editor.

create table if not exists public.rate_limits (
  key      text primary key,
  count    integer     not null,
  reset_at timestamptz not null
);

alter table public.rate_limits enable row level security;
-- No policies on purpose: only the service-role key (which bypasses RLS) may touch this table.

create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_ms bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed boolean;
begin
  insert into rate_limits as rl (key, count, reset_at)
  values (p_key, 1, now() + make_interval(secs => p_window_ms / 1000.0))
  on conflict (key) do update set
    count    = case when rl.reset_at <= now() then 1 else rl.count + 1 end,
    reset_at = case when rl.reset_at <= now() then now() + make_interval(secs => p_window_ms / 1000.0) else rl.reset_at end
  returning count <= p_limit into allowed;
  return allowed;
end $$;

revoke all on function public.rate_limit_hit(text, integer, bigint) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, bigint) to service_role;
