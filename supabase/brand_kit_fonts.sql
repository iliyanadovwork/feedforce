-- Custom font upload support for the Brand Kit.
-- Mirrors the brand-kit-logos setup. Safe to run more than once (idempotent).
-- Run in: Supabase Dashboard → SQL Editor (or via psql / the Management API).

-- 1) Public storage bucket for uploaded font files
insert into storage.buckets (id, name, public)
values ('brand-kit-fonts', 'brand-kit-fonts', true)
on conflict (id) do nothing;

-- 2) Storage RLS: a user may write/delete only inside their own  {userId}/...  folder; anyone may read.
drop policy if exists "fonts: owner upload" on storage.objects;
create policy "fonts: owner upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'brand-kit-fonts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "fonts: owner delete" on storage.objects;
create policy "fonts: owner delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'brand-kit-fonts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "fonts: public read" on storage.objects;
create policy "fonts: public read"
  on storage.objects for select to public
  using (bucket_id = 'brand-kit-fonts');

-- 3) Table of uploaded fonts, tied to the brand kit (mirrors brand_kit_logos)
create table if not exists public.brand_kit_fonts (
  id           uuid primary key default gen_random_uuid(),
  brand_kit_id uuid not null references public.brand_kit(id) on delete cascade,
  label        text not null,
  url          text not null,
  created_at   timestamptz not null default now()
);

alter table public.brand_kit_fonts enable row level security;

-- 4) Table RLS: only the brand kit's owner can read/write its fonts
drop policy if exists "brand_kit_fonts: owner all" on public.brand_kit_fonts;
create policy "brand_kit_fonts: owner all"
  on public.brand_kit_fonts for all to authenticated
  using      (exists (select 1 from public.brand_kit k where k.id = brand_kit_id and k.user_id = auth.uid()))
  with check (exists (select 1 from public.brand_kit k where k.id = brand_kit_id and k.user_id = auth.uid()));
