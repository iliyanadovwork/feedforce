-- Multi-sheet tabs for the reels Content Sheet: reel_sheets goes from ONE row per user to one row
-- per (user, sheet). Tabs are user-named ("Sheet 1", "Client A", …); each keeps its own jsonb rows
-- (see hooks/useReelSheet.ts — useSheetTabs manages the tab list, useReelSheet one sheet's rows).
--
-- The sheet_id / name DEFAULTs are deliberate deploy-window compatibility: the previous client
-- upserts {user_id, rows} with no sheet_id, which now lands on ('sheet-1', 'Sheet 1') — the exact
-- row every existing user's sheet becomes under the new composite key. Sequencing: apply this
-- BEFORE deploying the tabbed client (old client keeps working; new client needs these columns).
--
-- RLS: the existing owner policies are per-row checks on user_id, so they cover the multi-row
-- shape unchanged. Safe to re-run.

alter table public.reel_sheets add column if not exists sheet_id text not null default 'sheet-1';
alter table public.reel_sheets add column if not exists name     text not null default 'Sheet 1';
alter table public.reel_sheets add column if not exists position integer not null default 0;

-- Swap the PK user_id → (user_id, sheet_id). Guarded: only a single-column PK is dropped, so a
-- re-run (or a fresh-setup DB already created with the composite key) is a no-op.
do $$
declare pk text;
begin
  select conname into pk
    from pg_constraint
   where conrelid = 'public.reel_sheets'::regclass
     and contype = 'p'
     and array_length(conkey, 1) = 1;
  if pk is not null then
    execute format('alter table public.reel_sheets drop constraint %I', pk);
    alter table public.reel_sheets add constraint reel_sheets_pkey primary key (user_id, sheet_id);
  end if;
end $$;
