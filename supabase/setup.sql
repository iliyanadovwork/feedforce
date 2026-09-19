-- =============================================================================
-- Sonotool — Supabase setup
-- =============================================================================
-- Run this once in the Supabase SQL editor on a fresh project.
-- It is idempotent where possible (CREATE TABLE IF NOT EXISTS, ADD COLUMN
-- IF NOT EXISTS) but the policies/triggers are NOT — drop the relevant
-- objects first if re-running.
--
-- Pre-requisites already done in the dashboard:
--   * Authentication → Email provider enabled
--   * Authentication → Site URL = https://www.feedforce.ai
--     (the Site URL is the fallback destination for auth email links, so it
--     must point at prod — a localhost Site URL sends prod users' links to
--     localhost)
--   * Authentication → Redirect URLs include the exact origins
--     https://www.feedforce.ai AND http://localhost:3000 PLUS the wildcards
--     https://www.feedforce.ai/** AND http://localhost:3000/**
--     (Supabase ignores any emailRedirectTo/redirectTo that doesn't match an
--     allow-list entry and falls back to the Site URL. The bare-origin
--     entries are load-bearing: signUp sends the plain origin, which the
--     '/**' globs do NOT match — the glob requires a '/' after the host —
--     while resetPassword's '/reset-password' link needs the wildcards.
--     The localhost entries keep local dev working.)
--   * Storage → bucket "brand-kit-logos" created, public access ON
-- =============================================================================


-- =============================================================================
-- Shared trigger function: updated_at
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- =============================================================================
-- brand_kit + brand_kit_logos
-- -----------------------------------------------------------------------------
-- One brand_kit per signed-in user. Logos are 1-N children stored in the
-- "brand-kit-logos" storage bucket; brand_kit_logos.url is the full public URL.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.brand_kit (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL UNIQUE,
  display_name text        NOT NULL DEFAULT '',
  handle       text        NOT NULL DEFAULT '',   -- stored without leading '@'
  colors       jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- ordered brand palette (hex strings)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_kit_pkey         PRIMARY KEY (id),
  CONSTRAINT brand_kit_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.brand_kit_logos (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  brand_kit_id  uuid        NOT NULL,
  url           text        NOT NULL,
  label         text,
  position      integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_kit_logos_pkey              PRIMARY KEY (id),
  CONSTRAINT brand_kit_logos_brand_kit_id_fkey FOREIGN KEY (brand_kit_id)
    REFERENCES public.brand_kit(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS brand_kit_logos_brand_kit_id_idx
  ON public.brand_kit_logos(brand_kit_id, position);

CREATE TRIGGER set_brand_kit_updated_at
  BEFORE UPDATE ON public.brand_kit
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.brand_kit       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_kit_logos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner select" ON public.brand_kit
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "owner insert" ON public.brand_kit
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "owner update" ON public.brand_kit
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "owner delete" ON public.brand_kit
  FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "owner select" ON public.brand_kit_logos
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.brand_kit b WHERE b.id = brand_kit_id AND b.user_id = auth.uid())
  );
CREATE POLICY "owner insert" ON public.brand_kit_logos
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.brand_kit b WHERE b.id = brand_kit_id AND b.user_id = auth.uid())
  );
CREATE POLICY "owner update" ON public.brand_kit_logos
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.brand_kit b WHERE b.id = brand_kit_id AND b.user_id = auth.uid())
  );
CREATE POLICY "owner delete" ON public.brand_kit_logos
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.brand_kit b WHERE b.id = brand_kit_id AND b.user_id = auth.uid())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_kit       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_kit_logos TO authenticated;


-- =============================================================================
-- Storage policies for the brand-kit-logos bucket
-- -----------------------------------------------------------------------------
-- The app uploads to "<auth.uid()>/<timestamp>_<filename>" — the first folder
-- segment is the user's UID. These policies allow each user to manage only
-- their own folder. Reads are public because the bucket is public.
-- =============================================================================
CREATE POLICY "brand-kit-logos public read" ON storage.objects
  FOR SELECT USING (bucket_id = 'brand-kit-logos');

CREATE POLICY "brand-kit-logos owner insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'brand-kit-logos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "brand-kit-logos owner update" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'brand-kit-logos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "brand-kit-logos owner delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'brand-kit-logos'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

