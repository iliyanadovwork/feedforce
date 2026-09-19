-- =============================================================================
-- Posts schema (create posts FROM templates)
-- -----------------------------------------------------------------------------
-- A post is an INDEPENDENT SNAPSHOT of a template: when created, the template's
-- slides are deep-copied into post slides, then the post is edited freely and is
-- decoupled from its template afterward.
--
-- These tables mirror template_editor_* 1:1 so the SAME column-mapped
-- persistence (rowToSettings/slideToRow in useTemplateEditor.ts) and the SAME
-- editor work unchanged — only the table names + the parent FK differ.
--
-- Differences vs the template tables:
--   * template_editor_posts adds `status` and a soft `source_template_id`
--     breadcrumb (NULLed if the source template is deleted).
--   * template_editor_post_slides uses `post_id` instead of `template_id`.
--
-- Run this in the Supabase SQL editor AFTER template_editor_schema.sql.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Drop (safe to re-run; CASCADE removes the post_slides FK)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.template_editor_post_slides CASCADE;
DROP TABLE IF EXISTS public.template_editor_posts       CASCADE;


-- =============================================================================
-- template_editor_posts  (N per user; reorderable; renamable; carries a status
-- and a soft provenance pointer to the template it was cloned from)
-- =============================================================================
CREATE TABLE public.template_editor_posts (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL,
  name               text        NOT NULL DEFAULT 'Untitled post',
  status             text        NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','ready','published')),
  position           integer     NOT NULL DEFAULT 0,
  source_template_id uuid        REFERENCES public.template_editor_templates(id)
                       ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT template_editor_posts_pkey         PRIMARY KEY (id),
  CONSTRAINT template_editor_posts_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE INDEX template_editor_posts_user_position_idx
  ON public.template_editor_posts (user_id, position);


-- =============================================================================
-- template_editor_post_slides  (columns identical to template_editor_slides;
-- parent key is post_id, not template_id)
-- =============================================================================
CREATE TABLE public.template_editor_post_slides (
  id       uuid    NOT NULL DEFAULT gen_random_uuid(),
  post_id  uuid    NOT NULL,
  name     text    NOT NULL DEFAULT 'main',
  position integer NOT NULL DEFAULT 0,

  -- Text content (image is ephemeral client state — not stored)
  headline    text NOT NULL DEFAULT '',
  subheadline text NOT NULL DEFAULT '',

  -- ── Logo ──────────────────────────────────────────────────────────────────
  logo_opacity       integer NOT NULL DEFAULT 100 CHECK (logo_opacity       BETWEEN 0 AND 100),
  logo_scale         integer NOT NULL DEFAULT 100 CHECK (logo_scale         BETWEEN 10 AND 200),
  logo_corner_radius integer NOT NULL DEFAULT 0   CHECK (logo_corner_radius >= 0),
  logo_shadow        jsonb,
  logo_slot_aligns   text[]  NOT NULL DEFAULT ARRAY['center','center','center'],

  -- ── Layout ────────────────────────────────────────────────────────────────
  head_sub_gap    integer NOT NULL DEFAULT 20,
  above_logo_gap  integer NOT NULL DEFAULT 8,
  content_padding integer NOT NULL DEFAULT 50,

  -- ── Fade ──────────────────────────────────────────────────────────────────
  show_fade          boolean NOT NULL DEFAULT true,
  fade_floor         integer NOT NULL DEFAULT 20,
  fade_reach         integer NOT NULL DEFAULT 40,
  fade_intensity     integer NOT NULL DEFAULT 85,
  show_top_fade      boolean NOT NULL DEFAULT false,
  top_fade_floor     integer NOT NULL DEFAULT 20,
  top_fade_reach     integer NOT NULL DEFAULT 40,
  top_fade_intensity integer NOT NULL DEFAULT 85,

  -- ── Background ────────────────────────────────────────────────────────────
  bg_blur_enabled  boolean NOT NULL DEFAULT false,
  bg_blur_amount   integer NOT NULL DEFAULT 10,
  bg_darken_amount integer NOT NULL DEFAULT 0,
  canvas_color     text    NOT NULL DEFAULT '#000000',

  -- ── Headline typography ───────────────────────────────────────────────────
  headline_color  text    NOT NULL DEFAULT '#ffffff',
  font_size       integer NOT NULL DEFAULT 68,
  l_spacing       integer NOT NULL DEFAULT 0,
  l_height        integer NOT NULL DEFAULT 15,
  font_label      text    NOT NULL DEFAULT 'Inter',
  font_weight     integer NOT NULL DEFAULT 700,
  italic          boolean NOT NULL DEFAULT false,
  text_align      text    NOT NULL DEFAULT 'left'
                  CHECK (text_align IN ('left','center','right','justify')),
  all_caps        boolean NOT NULL DEFAULT false,
  headline_shadow jsonb   DEFAULT NULL,
  headline_spans  jsonb   DEFAULT NULL,

  -- ── Sub-headline typography ───────────────────────────────────────────────
  subheadline_color text    NOT NULL DEFAULT '#ffffff',
  sub_font_size     integer NOT NULL DEFAULT 32,
  sub_l_spacing     integer NOT NULL DEFAULT 0,
  sub_l_height      integer NOT NULL DEFAULT 10,
  sub_font_label    text    NOT NULL DEFAULT 'Inter',
  sub_font_weight   integer NOT NULL DEFAULT 400,
  sub_italic        boolean NOT NULL DEFAULT false,
  sub_text_align    text    NOT NULL DEFAULT 'left'
                    CHECK (sub_text_align IN ('left','center','right','justify')),
  sub_all_caps      boolean NOT NULL DEFAULT false,
  sub_shadow        jsonb   DEFAULT NULL,
  sub_spans         jsonb   DEFAULT NULL,

  -- ── Circle 1 ──────────────────────────────────────────────────────────────
  circle_border_color    text    NOT NULL DEFAULT '#ffffff',
  circle_border_width    integer NOT NULL DEFAULT 10,
  circle_border_opacity  integer NOT NULL DEFAULT 100,
  circle_shadow_enabled  boolean NOT NULL DEFAULT false,
  circle_shadow_blur     integer NOT NULL DEFAULT 20,
  circle_shadow_offset_x integer NOT NULL DEFAULT 0,
  circle_shadow_offset_y integer NOT NULL DEFAULT 8,
  circle_shadow_color    text    NOT NULL DEFAULT '#000000',
  circle_shadow_opacity  integer NOT NULL DEFAULT 50,
  circle_lift            integer NOT NULL DEFAULT 0,

  -- ── Circle 2 ──────────────────────────────────────────────────────────────
  circle2_border_color    text    NOT NULL DEFAULT '#ffffff',
  circle2_border_width    integer NOT NULL DEFAULT 10,
  circle2_border_opacity  integer NOT NULL DEFAULT 100,
  circle2_shadow_enabled  boolean NOT NULL DEFAULT false,
  circle2_shadow_blur     integer NOT NULL DEFAULT 20,
  circle2_shadow_offset_x integer NOT NULL DEFAULT 0,
  circle2_shadow_offset_y integer NOT NULL DEFAULT 8,
  circle2_shadow_color    text    NOT NULL DEFAULT '#000000',
  circle2_shadow_opacity  integer NOT NULL DEFAULT 50,
  circle2_lift            integer NOT NULL DEFAULT 0,

  -- ── Layer order (no circles by default — clean starting template) ─────────
  layer_order text[] NOT NULL DEFAULT ARRAY['background','subject'],

  -- ── Quotes shared style ───────────────────────────────────────────────────
  quote_color   text    NOT NULL DEFAULT '#ffffff',
  quote_size    integer NOT NULL DEFAULT 120,
  quote_opacity integer NOT NULL DEFAULT 100,
  quote_gap     integer NOT NULL DEFAULT 8,
  quote_shadow  jsonb   DEFAULT NULL,

  -- ── Default tag style (seed applied to newly dragged tags) ────────────────
  default_tag_style jsonb DEFAULT NULL,

  -- ── Slot arrays (JSONB — see setup.sql for column shape notes) ────────────
  tag_slots         jsonb NOT NULL DEFAULT '[null,null,null]'::jsonb,
  tag_slot_aligns   text[] NOT NULL DEFAULT ARRAY['center','center','center'],
  tag_zone_slots    jsonb NOT NULL DEFAULT '[null,null,null,null,null,null,null,null,null]'::jsonb,
  quote_slots       jsonb NOT NULL DEFAULT '[null,null,null]'::jsonb,
  quote_zone_slots  jsonb NOT NULL DEFAULT '[null,null,null,null,null,null,null,null,null]'::jsonb,
  zone_logo_slots   jsonb NOT NULL DEFAULT '[null,null,null,null,null,null,null,null,null]'::jsonb,
  logo_row_slots    jsonb NOT NULL DEFAULT '[null,null,null]'::jsonb,
  swipe_zone_slots  jsonb NOT NULL DEFAULT '[null,null,null,null,null,null,null,null,null]'::jsonb,
  divider_slots     jsonb NOT NULL DEFAULT '[null,null,null]'::jsonb,
  divider_sub_slots jsonb NOT NULL DEFAULT '[null,null,null]'::jsonb,
  divider_settings  jsonb NOT NULL DEFAULT '[null,null,null]'::jsonb,

  -- ── Free text boxes / image boxes (arrays of positioned elements) ─────────
  text_boxes        jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_boxes       jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT template_editor_post_slides_pkey      PRIMARY KEY (id),
  CONSTRAINT template_editor_post_slides_post_fkey FOREIGN KEY (post_id)
    REFERENCES public.template_editor_posts(id) ON DELETE CASCADE
);

CREATE INDEX template_editor_post_slides_post_position_idx
  ON public.template_editor_post_slides (post_id, position);


-- =============================================================================
-- Triggers (reuse set_updated_at() from setup.sql)
-- =============================================================================
CREATE TRIGGER set_template_editor_posts_updated_at
  BEFORE UPDATE ON public.template_editor_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_template_editor_post_slides_updated_at
  BEFORE UPDATE ON public.template_editor_post_slides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- Row Level Security (same patterns as template_editor_*)
-- =============================================================================
ALTER TABLE public.template_editor_posts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.template_editor_post_slides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner select" ON public.template_editor_posts
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "owner insert" ON public.template_editor_posts
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "owner update" ON public.template_editor_posts
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "owner delete" ON public.template_editor_posts
  FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "owner select" ON public.template_editor_post_slides
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.template_editor_posts p WHERE p.id = post_id AND p.user_id = auth.uid())
  );
CREATE POLICY "owner insert" ON public.template_editor_post_slides
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.template_editor_posts p WHERE p.id = post_id AND p.user_id = auth.uid())
  );
CREATE POLICY "owner update" ON public.template_editor_post_slides
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.template_editor_posts p WHERE p.id = post_id AND p.user_id = auth.uid())
  );
CREATE POLICY "owner delete" ON public.template_editor_post_slides
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.template_editor_posts p WHERE p.id = post_id AND p.user_id = auth.uid())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.template_editor_posts      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.template_editor_post_slides TO authenticated;


-- =============================================================================
-- Drift guard — run after the migration; should return ZERO rows. If it returns
-- any column, the post_slides table has drifted from template_editor_slides.
-- =============================================================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='template_editor_slides' AND column_name <> 'template_id'
-- EXCEPT
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='template_editor_post_slides' AND column_name <> 'post_id';
