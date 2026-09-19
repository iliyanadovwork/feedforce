-- Carousel folders — lightweight, ONE-LEVEL grouping for the Carousels home grid (no nesting, no
-- tags). A folder is just a named, owner-scoped bucket a post can point at; posts with a NULL
-- folder_id are "unfiled" and show under the grid's "All" chip only.
--
-- Additive + backwards-compatible with the currently deployed app:
--   * the app reads posts via select('*'), so the new template_editor_posts.folder_id column simply
--     appears in payloads once this runs — older bundles ignore it;
--   * CarouselHomeGrid hides the whole folder bar when its carousel_folders fetch errors (table not
--     created yet), so app deploys and this migration can land in either order without breakage —
--     but apply this BEFORE the folders UI ships or the feature stays invisible.
--
-- Requires setup.sql (set_updated_at()) and template_editor_posts_schema.sql. Safe to re-run
-- (if-not-exists tables/columns/indexes; policies, trigger and the folder FK are drop-and-recreate).
-- Run in: Supabase Dashboard → SQL Editor.

create table if not exists public.carousel_folders (
  id         uuid        not null default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  name       text        not null,
  position   integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint carousel_folders_pkey primary key (id)
);

-- The grid lists a user's folders in position order — the same access pattern (and index shape) as
-- template_editor_posts_user_position_idx.
create index if not exists carousel_folders_user_position_idx
  on public.carousel_folders (user_id, position);

drop trigger if exists set_carousel_folders_updated_at on public.carousel_folders;
create trigger set_carousel_folders_updated_at
  before update on public.carousel_folders
  for each row execute function public.set_updated_at();

-- Owner-only RLS — same semantics as template_editor_posts (auth.uid() = user_id on every verb).
alter table public.carousel_folders enable row level security;

drop policy if exists "carousel_folders: owner select" on public.carousel_folders;
drop policy if exists "carousel_folders: owner insert" on public.carousel_folders;
drop policy if exists "carousel_folders: owner update" on public.carousel_folders;
drop policy if exists "carousel_folders: owner delete" on public.carousel_folders;

create policy "carousel_folders: owner select" on public.carousel_folders
  for select to authenticated using (auth.uid() = user_id);
create policy "carousel_folders: owner insert" on public.carousel_folders
  for insert to authenticated with check (auth.uid() = user_id);
create policy "carousel_folders: owner update" on public.carousel_folders
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "carousel_folders: owner delete" on public.carousel_folders
  for delete to authenticated using (auth.uid() = user_id);

grant select, insert, update, delete on public.carousel_folders to authenticated;

-- Posts point at (at most) one folder; NULL = unfiled, and with MATCH SIMPLE a NULL folder_id
-- skips the FK check entirely, so unfiled posts stay valid.
alter table public.template_editor_posts
  add column if not exists folder_id uuid;

-- Same-owner enforcement. A plain folder_id → carousel_folders(id) FK would NOT be enough: FK
-- validation runs as the table owner and so bypasses carousel_folders' RLS, letting a user file
-- their OWN post into ANOTHER user's folder (and use FK success/failure as an existence oracle for
-- foreign folder ids). Making the FK composite — (folder_id, user_id) → (id, user_id) — forces the
-- referenced folder row to carry the same user_id as the post, closing both holes without a
-- trigger; the extra unique key exists only to give that composite FK a referenceable target
-- (id alone is already the PK). ON DELETE SET NULL keeps its meaning — deleting a folder RETURNS
-- its posts to unfiled rather than deleting them (the UI mirrors the same transition locally so no
-- refetch is needed) — but must be column-qualified: a bare SET NULL on a composite FK would null
-- the post's user_id too. `set null (folder_id)` needs PG 15+, which Supabase guarantees.
-- Drop-and-recreate (FK first: the unique key can't be dropped out from under a dependent FK)
-- keeps re-runs safe and upgrades any environment that already got the earlier single-column FK
-- under the same auto-generated name.
alter table public.template_editor_posts
  drop constraint if exists template_editor_posts_folder_id_fkey;
alter table public.carousel_folders
  drop constraint if exists carousel_folders_id_user_id_key;
alter table public.carousel_folders
  add constraint carousel_folders_id_user_id_key unique (id, user_id);
alter table public.template_editor_posts
  add constraint template_editor_posts_folder_id_fkey
    foreign key (folder_id, user_id) references public.carousel_folders (id, user_id)
    on delete set null (folder_id);

-- Supports the FK's on-delete scan (folder delete → NULL out matching posts) and folder-filtered
-- post queries. Partial: most posts are expected to stay unfiled, so indexing only filed rows keeps
-- the index tiny.
create index if not exists template_editor_posts_folder_id_idx
  on public.template_editor_posts (folder_id) where folder_id is not null;
