-- Enable Supabase Realtime (Postgres Changes) for the reel-persistence tables so an open tab receives
-- live UPDATE/INSERT events (the full new row, incl. the reels/rows jsonb array) whenever ANOTHER tab or
-- device autosaves. This is the server side of the multi-tab live-sync fix for the last-writer-wins
-- clobber: without it a stale second tab silently overwrites (resurrects) a reel/row the first tab deleted.
--
--   * Catalog-only change: ADD TABLE does not rewrite or scan the table, so it is independent of row
--     count (the 400+-reel rows are irrelevant) and near-instant. SELECT reads are never blocked.
--   * Default replica identity (the user_id primary key) is enough — payload.new is delivered in full on
--     INSERT/UPDATE. We deliberately do NOT set REPLICA IDENTITY FULL: the client only consumes `new`,
--     and FULL would only backfill payload.old while increasing WAL write volume on every autosave.
--   * RLS already gates delivery: both tables have an owner SELECT policy (user_id = auth.uid()), so each
--     user receives ONLY their own row's changes.
--   * Plain `alter publication ... add table` errors if a table is already a member (Postgres has no
--     ADD TABLE IF NOT EXISTS), so each ADD is guarded via pg_publication_tables → safe to re-run.
--
-- Revert block is at the bottom (commented). Apply via MCP apply_migration with the user's go-ahead.

set local lock_timeout = '5s';   -- fail fast instead of stalling behind a long write txn (runs in a txn)

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'video_reels'
    ) then
      alter publication supabase_realtime add table public.video_reels;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reel_sheets'
    ) then
      alter publication supabase_realtime add table public.reel_sheets;
    end if;

  end if;
end $$;

-- ── Revert (guarded) ─────────────────────────────────────────────────────────
-- do $$
-- begin
--   if exists (select 1 from pg_publication_tables
--              where pubname='supabase_realtime' and schemaname='public' and tablename='video_reels')
--   then alter publication supabase_realtime drop table public.video_reels; end if;
--   if exists (select 1 from pg_publication_tables
--              where pubname='supabase_realtime' and schemaname='public' and tablename='reel_sheets')
--   then alter publication supabase_realtime drop table public.reel_sheets; end if;
-- end $$;
