-- =============================================================================
-- Post images storage bucket
-- -----------------------------------------------------------------------------
-- Images uploaded or pasted while editing a POST (not brand assets). They are
-- referenced only by their public URL inside a post slide's image_boxes JSONB
-- (template_editor_post_slides), so no new table is needed — that row is already
-- owner-protected by its existing RLS. These images intentionally NEVER appear
-- in the Branding panel: they live in their own bucket and write no
-- brand_kit_logos row.
--
-- Mirrors the brand-kit-logos bucket 1:1 (public read; owner-folder writes).
-- The app uploads to "<auth.uid()>/<timestamp>_<filename>" — the first folder
-- segment is the user's UID, so each user manages only their own folder.
--
-- Run this once in the Supabase SQL editor. It is idempotent (re-runnable): the
-- bucket insert uses ON CONFLICT DO NOTHING and each policy is dropped first.
-- You can also create the bucket from Storage → New bucket (public ON) instead.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('post-images', 'post-images', true)
on conflict (id) do nothing;

DROP POLICY IF EXISTS "post-images public read"  ON storage.objects;
DROP POLICY IF EXISTS "post-images owner insert" ON storage.objects;
DROP POLICY IF EXISTS "post-images owner update" ON storage.objects;
DROP POLICY IF EXISTS "post-images owner delete" ON storage.objects;

CREATE POLICY "post-images public read" ON storage.objects
  FOR SELECT USING (bucket_id = 'post-images');

CREATE POLICY "post-images owner insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'post-images'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "post-images owner update" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'post-images'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "post-images owner delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'post-images'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
