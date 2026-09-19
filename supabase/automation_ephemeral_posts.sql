-- Automation runs snapshot a template into a real post (template_editor_posts + slides) so the publish
-- step can render exactly what the run produced. Those posts are THROWAWAY: once rendered/published (or
-- the run is abandoned) they're dead weight, and they must not show up in the Carousels grid alongside
-- posts the user made by hand. Mark them so the app can hide and sweep them:
--   • the Template node inserts posts with ephemeral = true
--   • the publish step deletes them right after posting (slides cascade via FK)
--   • the automations page sweeps leftovers on load (interrupted runs, closed tabs)
--   • /api/cron/cleanup-renders sweeps any ephemeral post older than a day (cron runs, signed-out users)
-- Safe to re-run.
-- Run in: Supabase Dashboard → SQL Editor.

alter table public.template_editor_posts
  add column if not exists ephemeral boolean not null default false;

-- Sweeps filter on (ephemeral, created_at); partial index keeps it cheap and off the common path.
create index if not exists template_editor_posts_ephemeral_idx
  on public.template_editor_posts (created_at) where ephemeral;
