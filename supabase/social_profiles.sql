-- Maps each app user to their own Zernio "profile" (sub-account), so a user's connected social
-- accounts (Instagram, etc.) are isolated from everyone else's. One row per user. The mapping is
-- created lazily by the server (lib/zernio.ts → getOrCreateZernioProfile) using the service-role key,
-- which bypasses RLS. The browser may only READ its own row. Safe to run more than once.
-- Run in: Supabase Dashboard → SQL Editor (or via psql / the Management API).

create table if not exists public.social_profiles (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  zernio_profile_id text not null,                 -- Zernio profile _id this user posts/connects under
  created_at        timestamptz not null default now()
);

alter table public.social_profiles enable row level security;

-- A user may read only their own mapping. There is intentionally NO insert/update/delete policy for
-- end users: the mapping is written server-side with the service-role key (which bypasses RLS).
drop policy if exists "social_profiles: owner read" on public.social_profiles;
create policy "social_profiles: owner read"
  on public.social_profiles for select to authenticated
  using (user_id = auth.uid());
