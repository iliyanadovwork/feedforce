-- The reels Content Sheet: each user's persistent backlog of links + captions + notes, upstream of
-- the reels workspace. One row per (user, sheet): a user can keep several named sheet tabs
-- ("Sheet 1", "Client A", …), each with `rows` as an ordered jsonb array, autosaved on a debounce
-- (see hooks/useReelSheet.ts — useSheetTabs manages the tab list, useReelSheet one sheet's rows).
-- Each rows[] element:
--   {
--     id:          string,                 -- stable row id (React key)
--     link:        string,                 -- TikTok / Instagram / X url (sent to reels later)
--     caption:     string,                 -- caption the reel will start with
--     description: string                  -- user's own notes; stays in the sheet, never leaves it
--   }
-- The sheet_id / name DEFAULTs let a pre-tabs client (which upserts {user_id, rows} only) keep
-- writing the ('sheet-1', 'Sheet 1') row during a deploy window. Deliberately NOT quota-capped for
-- free users (FREE_TIER_PLAN.md): it's plain text, and a full backlog is what pushes people into
-- the export quota; the client caps tabs at 10. Written client-side by the owner; RLS grants the
-- owner full CRUD on their own rows. Safe to re-run.
-- Run in: Supabase Dashboard → SQL Editor.

create table if not exists public.reel_sheets (
  user_id    uuid not null references auth.users(id) on delete cascade,
  sheet_id   text not null default 'sheet-1',
  name       text not null default 'Sheet 1',
  position   integer not null default 0,
  rows       jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, sheet_id)
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
