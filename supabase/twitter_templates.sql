-- Reels overlay templates (the Twitter/X-style header drawn over a video reel). One row per saved
-- template; the whole visual style lives in a single jsonb `settings` blob — TwitterTemplateSettings
-- in src/app/components/twitterTemplateTypes.ts (see that file for the field shapes). Read/written by
-- useTwitterTemplates and the reels editor (TwitterTemplateEditor); a reel row references a template
-- by id (video_reels.reels[].templateId). Owner-only RLS on all four verbs. Safe to re-run.
-- Run in: Supabase Dashboard → SQL Editor.
--
-- (Historically this table shipped only as a migration and had no reference file in the repo, so a
--  fresh setup from the SQL files couldn't create it — this file closes that gap. Matches prod.)

create table if not exists public.twitter_templates (
  id         uuid        not null default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  name       text        not null default 'Twitter template',
  position   integer     not null default 0,
  settings   jsonb       not null default '{}'::jsonb,   -- TwitterTemplateSettings blob
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint twitter_templates_pkey primary key (id)
);

create index if not exists twitter_templates_user_position_idx
  on public.twitter_templates(user_id, position);

alter table public.twitter_templates enable row level security;

drop trigger if exists set_twitter_templates_updated_at on public.twitter_templates;
create trigger set_twitter_templates_updated_at
  before update on public.twitter_templates
  for each row execute function public.set_updated_at();

drop policy if exists "owner select" on public.twitter_templates;
drop policy if exists "owner insert" on public.twitter_templates;
drop policy if exists "owner update" on public.twitter_templates;
drop policy if exists "owner delete" on public.twitter_templates;

create policy "owner select" on public.twitter_templates for select using ((select auth.uid()) = user_id);
create policy "owner insert" on public.twitter_templates for insert with check ((select auth.uid()) = user_id);
create policy "owner update" on public.twitter_templates for update using ((select auth.uid()) = user_id);
create policy "owner delete" on public.twitter_templates for delete using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.twitter_templates to authenticated;
