-- =============================================================================
-- Post videos storage bucket
-- -----------------------------------------------------------------------------
-- Videos uploaded/pasted in the carousel editor and the reels workspace, plus
-- baked schedule-time reel renders (under <uid>/_renders/). Mirrors
-- post_images_storage.sql 1:1: public read; owner-folder writes AND deletes.
-- The owner-delete policy matters: the client-side media GC (lib/mediaCleanup.ts)
-- removes a deleted carousel/reel/template's uploads directly from the browser.
--
-- Run once in the Supabase SQL editor. Idempotent (re-runnable).
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('post-videos', 'post-videos', true)
on conflict (id) do nothing;

DROP POLICY IF EXISTS "post-videos public read"  ON storage.objects;
DROP POLICY IF EXISTS "post-videos owner insert" ON storage.objects;
DROP POLICY IF EXISTS "post-videos owner update" ON storage.objects;
DROP POLICY IF EXISTS "post-videos owner delete" ON storage.objects;

CREATE POLICY "post-videos public read" ON storage.objects
  FOR SELECT USING (bucket_id = 'post-videos');

CREATE POLICY "post-videos owner insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'post-videos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "post-videos owner update" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'post-videos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "post-videos owner delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'post-videos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
