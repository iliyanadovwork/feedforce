-- Saved Video Reels for the Video Reels workspace. The whole grid is autosaved as ONE row per user,
-- mirroring how `automations.graph` stores a flow. `reels` is an ordered JSON array — each element is one
-- reel row in the grid. We persist ONLY numbers/strings needed to re-render a reel identically — never
-- the video itself. Each element:
--   {
--     id:         string,                       -- the grid row's stable id (React/key + canvas ref)
--     name:       string?,                      -- optional user label shown in the bottom strip; absent/''
--                                               --   on older reels (they render as just their number)
--     mode:       'twitter' | 'caption',        -- overlay style family
--     url:        string,                        -- pasted TikTok/IG/X link, re-fetched on load via /api/download
--     videoUrl:   string,                        -- durable public URL of an UPLOADED reel video in the
--                                                --   post-videos bucket (like carousels); empty for links
--     caption:    string,                        -- overlay caption text
--     templateId: string | null,                -- inherited reel template (twitter_templates) → text boxes / pfp / positions
--     framing:    { box:{x,y,w,h}, videoOffset:{x,y}, videoScale, trimStart, trimEnd, includeEdit }
--   }
-- Pasted links are re-fetched on load; UPLOADED files are pushed to the post-videos storage bucket and
-- referenced by videoUrl, so uploaded reels survive reload exactly like carousel videos. Written
-- client-side by the owner; RLS grants the owner full CRUD on their own row. Safe to re-run.
-- Run in: Supabase Dashboard → SQL Editor.

create table if not exists public.video_reels (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  reels      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.video_reels enable row level security;

drop policy if exists "video_reels: owner read"   on public.video_reels;
drop policy if exists "video_reels: owner insert" on public.video_reels;
drop policy if exists "video_reels: owner update" on public.video_reels;
drop policy if exists "video_reels: owner delete" on public.video_reels;

create policy "video_reels: owner read"   on public.video_reels for select to authenticated using (user_id = auth.uid());
create policy "video_reels: owner insert" on public.video_reels for insert to authenticated with check (user_id = auth.uid());
create policy "video_reels: owner update" on public.video_reels for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "video_reels: owner delete" on public.video_reels for delete to authenticated using (user_id = auth.uid());

-- 50-reel cap, enforced non-destructively: block only writes that GROW the array past 50, so an
-- existing over-cap grid (one user has 486) still saves/shrinks fine. UPDATE only, so the client's
-- INSERT ... ON CONFLICT DO UPDATE upsert isn't rejected on its insert-attempt phase. See the
-- 20260710190000_reel_cap migration for the full rationale.
create or replace function public.enforce_reel_cap() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(coalesce(new.reels, '[]'::jsonb)) > 50
     and jsonb_array_length(coalesce(new.reels, '[]'::jsonb)) > jsonb_array_length(coalesce(old.reels, '[]'::jsonb)) then
    raise exception 'Reel limit reached (max 50 per grid)' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists reel_cap on public.video_reels;
create trigger reel_cap before update on public.video_reels
  for each row execute function public.enforce_reel_cap();
