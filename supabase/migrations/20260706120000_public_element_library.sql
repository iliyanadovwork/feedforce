-- Public element library: a curated, shared catalog of custom elements that any authenticated
-- user can browse and add to their own custom_elements. Distinct from custom_elements (per-user,
-- owner-only RLS): rows here are readable by everyone. "Adding" one inserts a fresh row into the
-- current user's custom_elements — ownership transfers on copy, there's no live reference back to
-- this table (matches how placed elements already snapshot code rather than pointing at a shared row).
-- Curation is admin-only for now: writes go through the service role key, so there are no
-- insert/update/delete policies for regular authenticated users.
-- Run in: Supabase Dashboard → SQL Editor.

create table if not exists public.public_elements (
  id              uuid primary key default gen_random_uuid(),
  source_user_id  uuid references auth.users(id) on delete set null, -- original author, for attribution/curation only
  author_name     text not null default 'Digital Estate',
  name            text not null default 'Untitled element',
  description     text not null default '',
  code            text not null default '',          -- render-function body: (ctx, props) => void
  input_schema    jsonb not null default '[]'::jsonb, -- ElementInput[] (data "ports"); [] = static element
  default_data    jsonb,                              -- sample data so it renders before a node is bound
  size            jsonb not null default '{}'::jsonb, -- { w, h, aspect } default box (canvas px / ratio)
  thumbnail_url   text,
  is_active       boolean not null default true,      -- soft-hide without deleting
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists public_elements_active_idx on public.public_elements(is_active, created_at desc);

alter table public.public_elements enable row level security;

drop policy if exists "public_elements: authenticated read" on public.public_elements;

create policy "public_elements: authenticated read" on public.public_elements
  for select to authenticated using (is_active = true);
