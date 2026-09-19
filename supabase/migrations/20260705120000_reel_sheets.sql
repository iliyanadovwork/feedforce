-- The reels Content Sheet: each user's persistent backlog of links + captions + notes, upstream of
-- the reels workspace. Mirrors video_reels' shape — the whole sheet is ONE row per user, `rows` an
-- ordered jsonb array, autosaved on a debounce (see hooks/useReelSheet.ts). Each element:
--   {
--     id:          string,                 -- stable row id (React key)
--     link:        string,                 -- TikTok / Instagram / X url (sent to reels later)
--     caption:     string,                 -- caption the reel will start with
--     description: string,                 -- user's own notes; stays in the sheet, never leaves it
--     status:      'queued' | 'sent'       -- whether the row was already sent to the reels strip
--   }
-- Deliberately NOT quota-capped for free users (FREE_TIER_PLAN.md): it's plain text, and a full
-- backlog is what pushes people into the export quota. Written client-side by the owner; RLS
-- grants the owner full CRUD on their own row. Safe to re-run.
-- Run in: Supabase Dashboard → SQL Editor.

create table if not exists public.reel_sheets (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  rows       jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.reel_sheets enable row level security;

drop policy if exists "reel_sheets: owner read"   on public.reel_sheets;
drop policy if exists "reel_sheets: owner insert" on public.reel_sheets;
drop policy if exists "reel_sheets: owner update" on public.reel_sheets;
drop policy if exists "reel_sheets: owner delete" on public.reel_sheets;

create policy "reel_sheets: owner read"   on public.reel_sheets for select to authenticated using (user_id = auth.uid());
create policy "reel_sheets: owner insert" on public.reel_sheets for insert to authenticated with check (user_id = auth.uid());
create policy "reel_sheets: owner update" on public.reel_sheets for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "reel_sheets: owner delete" on public.reel_sheets for delete to authenticated using (user_id = auth.uid());
