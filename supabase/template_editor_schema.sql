-- =============================================================================
-- Template editor schema (v2 — multi-template + dynamic slides)
-- -----------------------------------------------------------------------------
-- These tables back the Template editor section. Shape differs from the
-- (since-removed) legacy carousel_* tables it replaced:
--   * N templates per user (not just 1) — `UNIQUE(user_id)` dropped, `name`
--     and `position` columns added so users can have e.g. "News card",
--     "Quote post", etc. and reorder them.
--   * N slides per template (not fixed 3) — `slide_type` CHECK replaced with
--     a free-text `name` (default "main"); `position` added for drag-reorder.
--   * All styling/JSONB columns carried over unchanged — the editor
--     remaster is about architecture (templates, slides, autosave), not the
--     per-slide feature set.
--
-- Run this in the Supabase SQL editor after setup.sql. This drops and
-- recreates the v1 template_editor_* tables — safe because no data had
-- been written to them yet when this migration ran.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Drop v1 tables (CASCADE removes the FK from slides → templates)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.template_editor_slides    CASCADE;
DROP TABLE IF EXISTS public.template_editor_templates CASCADE;


-- =============================================================================
-- template_editor_templates  (N per user; reorderable; renamable)
-- =============================================================================
CREATE TABLE public.template_editor_templates (
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL,
  name       text        NOT NULL DEFAULT 'Untitled template',
  position   integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT template_editor_templates_pkey         PRIMARY KEY (id),
  CONSTRAINT template_editor_templates_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE INDEX template_editor_templates_user_position_idx
  ON public.template_editor_templates (user_id, position);


-- =============================================================================
-- template_editor_slides  (N per template; reorderable; renamable)
-- -----------------------------------------------------------------------------
-- JSONB column shapes: see the TEMPLATE EDITOR section header in
-- full_setup.sql for the full reference.
-- =============================================================================
CREATE TABLE public.template_editor_slides (
  id          uuid    NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid    NOT NULL,
  name        text    NOT NULL DEFAULT 'main',
  position    integer NOT NULL DEFAULT 0,

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

  CONSTRAINT template_editor_slides_pkey          PRIMARY KEY (id),
  CONSTRAINT template_editor_slides_template_fkey FOREIGN KEY (template_id)
    REFERENCES public.template_editor_templates(id) ON DELETE CASCADE
);

CREATE INDEX template_editor_slides_template_position_idx
  ON public.template_editor_slides (template_id, position);


-- =============================================================================
-- Triggers (reuses the set_updated_at() function from setup.sql)
-- =============================================================================
CREATE TRIGGER set_template_editor_templates_updated_at
  BEFORE UPDATE ON public.template_editor_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_template_editor_slides_updated_at
  BEFORE UPDATE ON public.template_editor_slides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- Row Level Security
-- =============================================================================
ALTER TABLE public.template_editor_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.template_editor_slides    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner select" ON public.template_editor_templates
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "owner insert" ON public.template_editor_templates
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "owner update" ON public.template_editor_templates
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "owner delete" ON public.template_editor_templates
  FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "owner select" ON public.template_editor_slides
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.template_editor_templates t WHERE t.id = template_id AND t.user_id = auth.uid())
  );
CREATE POLICY "owner insert" ON public.template_editor_slides
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.template_editor_templates t WHERE t.id = template_id AND t.user_id = auth.uid())
  );
CREATE POLICY "owner update" ON public.template_editor_slides
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.template_editor_templates t WHERE t.id = template_id AND t.user_id = auth.uid())
  );
CREATE POLICY "owner delete" ON public.template_editor_slides
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.template_editor_templates t WHERE t.id = template_id AND t.user_id = auth.uid())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.template_editor_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.template_editor_slides    TO authenticated;
