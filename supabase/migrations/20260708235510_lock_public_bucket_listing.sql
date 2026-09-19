-- Public storage buckets serve objects by URL WITHOUT any policy check (public buckets bypass RLS
-- for reads), so the broad "public read" SELECT policies (using bucket_id = X) add nothing for URL
-- access — they only let any client LIST every file in the bucket (user-content enumeration the
-- Supabase advisor flags, lint 0025).
--
-- We must NOT simply drop the SELECT policies: under RLS, remove()'s `DELETE ... WHERE bucket_id AND
-- name IN (...)` needs the target rows VISIBLE via a SELECT policy, so with no SELECT policy the
-- delete silently matches zero rows — "deleted" logos/fonts/media would keep serving at their public
-- URLs and storage would grow unbounded. Instead we REPLACE each broad SELECT with an OWNER-SCOPED
-- one (mirroring the existing owner delete/insert policies: foldername(name)[1] = auth.uid()). Anon
-- has no auth.uid() so still can't enumerate; an authenticated user can only list their OWN folder;
-- remove()/GC keep working; public URL serving is unaffected either way.
--
-- CAVEAT: storage.objects is Supabase-managed. If the migration role lacks privilege to alter its
-- policies, make the same change via the dashboard (Storage → Policies). SMOKE-TEST after applying:
-- upload, delete (must actually purge), and public-URL load for each bucket.

drop policy if exists "brand-kit-logos public read" on storage.objects;
create policy "brand-kit-logos owner read" on storage.objects for select
  using (bucket_id = 'brand-kit-logos' and (storage.foldername(name))[1] = (auth.uid())::text);

drop policy if exists "fonts: public read" on storage.objects;
create policy "brand-kit-fonts owner read" on storage.objects for select
  using (bucket_id = 'brand-kit-fonts' and (storage.foldername(name))[1] = (auth.uid())::text);

drop policy if exists "post-images public read" on storage.objects;
create policy "post-images owner read" on storage.objects for select
  using (bucket_id = 'post-images' and (storage.foldername(name))[1] = (auth.uid())::text);

drop policy if exists "post-videos public read" on storage.objects;
create policy "post-videos owner read" on storage.objects for select
  using (bucket_id = 'post-videos' and (storage.foldername(name))[1] = (auth.uid())::text);
