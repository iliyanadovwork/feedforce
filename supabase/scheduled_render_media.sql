-- Ledger of baked, schedule-time media renders so they can be cleaned up (storage isn't free, and Zernio
-- only REFERENCES our public URL — Instagram fetches it at publish time and then hosts its own copy, so
-- once a post is published/cancelled our copy is dead weight).
--
-- A row is written client-side right after a post is scheduled/published, one per uploaded render
-- (a baked reel MP4, or a carousel slide PNG). Cleanup happens two ways:
--   • cancel  — the DELETE /api/schedule/post/{id} route removes that post_id's renders immediately
--   • expiry  — a cron (/api/cron/cleanup-renders) deletes rows past expires_at (publish time + buffer),
--               which also sweeps published/failed/orphaned renders. expires_at is set from the post's
--               publish time, so far-future scheduled posts keep their media until they actually publish.
-- Both cleanups run with the service-role key (bypasses RLS) and remove the storage object + the row.
-- Safe to re-run.
-- Run in: Supabase Dashboard → SQL Editor.

create table if not exists public.scheduled_render_media (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  post_id     text not null,            -- Zernio post _id this render backs (for cancel cleanup)
  bucket      text not null,            -- 'post-videos' | 'post-images'
  path        text not null,            -- exact object path within the bucket
  expires_at  timestamptz not null,     -- safe-to-delete time (publish time + buffer)
  created_at  timestamptz not null default now()
);

create index if not exists scheduled_render_media_expires_idx on public.scheduled_render_media(expires_at);
create index if not exists scheduled_render_media_post_idx    on public.scheduled_render_media(post_id);
create index if not exists scheduled_render_media_user_idx     on public.scheduled_render_media(user_id);

alter table public.scheduled_render_media enable row level security;

-- The owner records their own renders; deletion is done server-side with the service-role key.
drop policy if exists "scheduled_render_media: owner read"   on public.scheduled_render_media;
drop policy if exists "scheduled_render_media: owner insert" on public.scheduled_render_media;
drop policy if exists "scheduled_render_media: owner delete" on public.scheduled_render_media;

create policy "scheduled_render_media: owner read"   on public.scheduled_render_media for select to authenticated using (user_id = auth.uid());
create policy "scheduled_render_media: owner insert" on public.scheduled_render_media for insert to authenticated with check (user_id = auth.uid());
create policy "scheduled_render_media: owner delete" on public.scheduled_render_media for delete to authenticated using (user_id = auth.uid());
