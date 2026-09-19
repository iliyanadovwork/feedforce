-- =============================================================================
-- Sonotool — FULL Supabase setup (consolidated, idempotent, non-destructive)
-- =============================================================================
-- One script that creates EVERYTHING the app needs:
--
--   Tables   : brand_kit, brand_kit_logos, brand_kit_fonts,
--              template_editor_templates, template_editor_slides,
--              template_editor_posts, template_editor_post_slides,
--   Storage  : brand-kit-logos, brand-kit-fonts, post-images (public buckets,
--              owner-folder writes: files live under "<auth.uid()>/...")
--   Plus     : RLS policies, updated_at triggers, indexes, grants.
--
-- SAFE TO RE-RUN on a live project:
--   * CREATE TABLE IF NOT EXISTS — never drops tables or data.
--   * Every policy/trigger is DROPped IF EXISTS before being created.
--   * Bucket inserts use ON CONFLICT DO NOTHING.
--
-- Supersedes: setup.sql, template_editor_schema.sql,
--             template_editor_posts_schema.sql, brand_kit_fonts.sql,
--             post_images_storage.sql
--
-- Dashboard prerequisites (cannot be done in SQL):
--   * Authentication → Email provider enabled
--   * Authentication → Site URL + Redirect URLs configured for your domain
-- =============================================================================


-- =============================================================================
-- 0) Shared trigger function: updated_at
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- =============================================================================
-- 1) BRANDING — brand_kit + brand_kit_logos + brand_kit_fonts
-- -----------------------------------------------------------------------------
-- One brand_kit per signed-in user. Logos/fonts are 1-N children whose files
-- live in the "brand-kit-logos" / "brand-kit-fonts" buckets; the rows store the
-- full public URL.
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

CREATE TABLE IF NOT EXISTS public.brand_kit_fonts (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  brand_kit_id uuid        NOT NULL,
  label        text        NOT NULL,
  url          text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_kit_fonts_pkey              PRIMARY KEY (id),
  CONSTRAINT brand_kit_fonts_brand_kit_id_fkey FOREIGN KEY (brand_kit_id)
    REFERENCES public.brand_kit(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS brand_kit_logos_brand_kit_id_idx
  ON public.brand_kit_logos(brand_kit_id, position);
CREATE INDEX IF NOT EXISTS brand_kit_fonts_brand_kit_id_idx
  ON public.brand_kit_fonts(brand_kit_id);

DROP TRIGGER IF EXISTS set_brand_kit_updated_at ON public.brand_kit;
CREATE TRIGGER set_brand_kit_updated_at
  BEFORE UPDATE ON public.brand_kit
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.brand_kit       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_kit_logos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_kit_fonts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner select" ON public.brand_kit;
DROP POLICY IF EXISTS "owner insert" ON public.brand_kit;
DROP POLICY IF EXISTS "owner update" ON public.brand_kit;
DROP POLICY IF EXISTS "owner delete" ON public.brand_kit;
CREATE POLICY "owner select" ON public.brand_kit
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "owner insert" ON public.brand_kit
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "owner update" ON public.brand_kit
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "owner delete" ON public.brand_kit
  FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner select" ON public.brand_kit_logos;
DROP POLICY IF EXISTS "owner insert" ON public.brand_kit_logos;
DROP POLICY IF EXISTS "owner update" ON public.brand_kit_logos;
DROP POLICY IF EXISTS "owner delete" ON public.brand_kit_logos;
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

DROP POLICY IF EXISTS "brand_kit_fonts: owner all" ON public.brand_kit_fonts;
CREATE POLICY "brand_kit_fonts: owner all"
  ON public.brand_kit_fonts FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.brand_kit k WHERE k.id = brand_kit_id AND k.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.brand_kit k WHERE k.id = brand_kit_id AND k.user_id = auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_kit       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_kit_logos TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_kit_fonts TO authenticated;


-- =============================================================================
-- 2) TEMPLATE EDITOR — template_editor_templates + template_editor_slides
-- -----------------------------------------------------------------------------
-- N templates per user (renamable, reorderable), N slides per template.
-- Styling columns cover the full slide look (fonts, fades, tags, dividers,
-- swipe indicators) PLUS canvas_color, text_boxes and image_boxes (free
-- positioned elements).
--
-- JSONB column shapes
-- -------------------
-- shadow columns (logo_shadow, headline_shadow, sub_shadow, quote_shadow):
--   { "enabled": bool, "color": "#000000", "blur": 16,
--     "offsetX": 0, "offsetY": 6, "opacity": 60, "lift": 0 }
--
-- tag_slots (3 entries — index = slot position 0-2):
--   [ { "text": "BREAKING", "style": { ...TagStyle } } | null, ... ]
--   TagStyle keys: bgColor, bgOpacity, borderColor, borderWidth, borderOpacity,
--     cornerRadius, textColor, fontSize, fontWeight, italic, fontLabel,
--     paddingX, paddingY, letterSpacing, textCase, shadow (optional ShadowStyle)
--
-- tag_zone_slots   (9 entries — index = row*3 + zone): same shape as tag_slots
-- quote_slots      (3 entries): [ "curly-open" | null, ... ]  -- QUOTE_STYLES ids
-- quote_zone_slots (9 entries): same shape as quote_slots
-- zone_logo_slots  (9 entries): [ "https://…/logo-a.png" | null, ... ]
-- logo_row_slots   (3 entries): [ "https://…/logo-b.png" | null, ... ]
-- swipe_zone_slots (9 entries):
--   [ { "text": "SWIPE", "allCaps": true, "fontLabel": "Inter", "fontWeight": 700,
--       "fontSize": 22, "textColor": "#ffffff", "letterSpacing": 3,
--       "arrowType": "line", "arrowLength": 55, "arrowColor": "#ffffff",
--       "arrowWeight": 2, "arrowHeadSize": 10, "direction": "right",
--       "layout": "text-arrow", "gap": 12, "opacity": 100,
--       "shadow": null | ShadowStyle } | null, ... ]
-- divider_slots     (3 entries): [ "logo-left-fade" | null, ... ]
-- divider_sub_slots (3 entries — content embedded inside a divider):
--   [ { "type": "tag", "text": "ALERT", "style": { ...TagStyle } }
--   | { "type": "swipe", "style": { ...SwipeStyle } } | null, ... ]
--   ("type": "image" entries are stripped to null on save — blob URLs ephemeral)
-- divider_settings  (3 entries — per-slot visual overrides; see editor types)
-- headline_spans / sub_spans:
--   [ { "text": "hello", "color": "#ff0000", "bold": true, "italic": false } ] | null
-- default_tag_style (TagStyle — seed copied onto every newly dragged tag)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.template_editor_templates (
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

CREATE INDEX IF NOT EXISTS template_editor_templates_user_position_idx
  ON public.template_editor_templates (user_id, position);

CREATE TABLE IF NOT EXISTS public.template_editor_slides (
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

  -- ── Slot arrays (JSONB — see the shape notes in the TEMPLATE EDITOR header) ─────────────────
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

  -- ── Freeform zone-style elements (tags/quotes/swipes/logos/dividers that
  --    escaped a skeleton box; see add_free_elements.sql) ────────────────────
  free_elements     jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- ── Unified layer order (bottom→top element ids; Layers panel + draw order) ─
  layer_order_ids   jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT template_editor_slides_pkey          PRIMARY KEY (id),
  CONSTRAINT template_editor_slides_template_fkey FOREIGN KEY (template_id)
    REFERENCES public.template_editor_templates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS template_editor_slides_template_position_idx
  ON public.template_editor_slides (template_id, position);

DROP TRIGGER IF EXISTS set_template_editor_templates_updated_at ON public.template_editor_templates;
CREATE TRIGGER set_template_editor_templates_updated_at
  BEFORE UPDATE ON public.template_editor_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_template_editor_slides_updated_at ON public.template_editor_slides;
CREATE TRIGGER set_template_editor_slides_updated_at
  BEFORE UPDATE ON public.template_editor_slides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.template_editor_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.template_editor_slides    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner select" ON public.template_editor_templates;
DROP POLICY IF EXISTS "owner insert" ON public.template_editor_templates;
DROP POLICY IF EXISTS "owner update" ON public.template_editor_templates;
DROP POLICY IF EXISTS "owner delete" ON public.template_editor_templates;
CREATE POLICY "owner select" ON public.template_editor_templates
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "owner insert" ON public.template_editor_templates
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "owner update" ON public.template_editor_templates
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "owner delete" ON public.template_editor_templates
  FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner select" ON public.template_editor_slides;
DROP POLICY IF EXISTS "owner insert" ON public.template_editor_slides;
DROP POLICY IF EXISTS "owner update" ON public.template_editor_slides;
DROP POLICY IF EXISTS "owner delete" ON public.template_editor_slides;
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


-- =============================================================================
-- 3) MEDIA POSTS — template_editor_posts + template_editor_post_slides
-- -----------------------------------------------------------------------------
-- A post is an INDEPENDENT SNAPSHOT of a template: on creation the template's
-- slides are deep-copied into post slides; afterwards the post is edited freely
-- and decoupled. Columns mirror template_editor_* 1:1 so the same persistence
-- layer (rowToSettings/slideToRow in useTemplateEditor.ts) works unchanged —
-- only the table names and the parent FK (post_id) differ. Posts add `status`
-- and a soft `source_template_id` breadcrumb (NULLed if the template is gone).
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.template_editor_posts (
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

CREATE INDEX IF NOT EXISTS template_editor_posts_user_position_idx
  ON public.template_editor_posts (user_id, position);
CREATE INDEX IF NOT EXISTS template_editor_posts_source_template_idx
  ON public.template_editor_posts (source_template_id);

CREATE TABLE IF NOT EXISTS public.template_editor_post_slides (
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

  -- ── Slot arrays (JSONB — see the shape notes in the TEMPLATE EDITOR header) ─────────────────
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

  -- ── Freeform zone-style elements (tags/quotes/swipes/logos/dividers that
  --    escaped a skeleton box; see add_free_elements.sql) ────────────────────
  free_elements     jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- ── Unified layer order (bottom→top element ids; Layers panel + draw order) ─
  layer_order_ids   jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT template_editor_post_slides_pkey      PRIMARY KEY (id),
  CONSTRAINT template_editor_post_slides_post_fkey FOREIGN KEY (post_id)
    REFERENCES public.template_editor_posts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS template_editor_post_slides_post_position_idx
  ON public.template_editor_post_slides (post_id, position);

DROP TRIGGER IF EXISTS set_template_editor_posts_updated_at ON public.template_editor_posts;
CREATE TRIGGER set_template_editor_posts_updated_at
  BEFORE UPDATE ON public.template_editor_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_template_editor_post_slides_updated_at ON public.template_editor_post_slides;
CREATE TRIGGER set_template_editor_post_slides_updated_at
  BEFORE UPDATE ON public.template_editor_post_slides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.template_editor_posts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.template_editor_post_slides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner select" ON public.template_editor_posts;
DROP POLICY IF EXISTS "owner insert" ON public.template_editor_posts;
DROP POLICY IF EXISTS "owner update" ON public.template_editor_posts;
DROP POLICY IF EXISTS "owner delete" ON public.template_editor_posts;
CREATE POLICY "owner select" ON public.template_editor_posts
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "owner insert" ON public.template_editor_posts
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "owner update" ON public.template_editor_posts
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "owner delete" ON public.template_editor_posts
  FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner select" ON public.template_editor_post_slides;
DROP POLICY IF EXISTS "owner insert" ON public.template_editor_post_slides;
DROP POLICY IF EXISTS "owner update" ON public.template_editor_post_slides;
DROP POLICY IF EXISTS "owner delete" ON public.template_editor_post_slides;
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.template_editor_posts       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.template_editor_post_slides TO authenticated;


-- =============================================================================
-- 4) STORAGE — buckets + policies
-- -----------------------------------------------------------------------------
-- Three public buckets. The app uploads to "<auth.uid()>/<timestamp>_<file>" —
-- the first folder segment is the user's UID, so each user can write/delete
-- only inside their own folder. Reads are public (assets are referenced by
-- their public URL inside slide rows).
--   brand-kit-logos : Brand Kit logo images
--   brand-kit-fonts : Brand Kit custom font files
--   post-images     : images uploaded/pasted while editing a post (referenced
--                     only from image_boxes JSONB; never shown in Branding)
-- =============================================================================
INSERT INTO storage.buckets (id, name, public) VALUES
  ('brand-kit-logos', 'brand-kit-logos', true),
  ('brand-kit-fonts', 'brand-kit-fonts', true),
  ('post-images',     'post-images',     true)
ON CONFLICT (id) DO NOTHING;

-- ── brand-kit-logos ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "brand-kit-logos public read"  ON storage.objects;
DROP POLICY IF EXISTS "brand-kit-logos owner insert" ON storage.objects;
DROP POLICY IF EXISTS "brand-kit-logos owner update" ON storage.objects;
DROP POLICY IF EXISTS "brand-kit-logos owner delete" ON storage.objects;
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

-- ── brand-kit-fonts ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "fonts: public read"   ON storage.objects;
DROP POLICY IF EXISTS "fonts: owner upload"  ON storage.objects;
DROP POLICY IF EXISTS "fonts: owner update"  ON storage.objects;
DROP POLICY IF EXISTS "fonts: owner delete"  ON storage.objects;
CREATE POLICY "fonts: public read" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'brand-kit-fonts');
CREATE POLICY "fonts: owner upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'brand-kit-fonts' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "fonts: owner update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'brand-kit-fonts' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "fonts: owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'brand-kit-fonts' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ── post-images ──────────────────────────────────────────────────────────────
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


-- =============================================================================
-- 5) Verification — run after the script; both queries should return ZERO rows.
-- =============================================================================
-- a) Any public table missing RLS?
-- SELECT tablename FROM pg_tables
--   WHERE schemaname = 'public' AND rowsecurity = false;
--
-- b) Drift guard: post_slides columns must mirror template_editor_slides 1:1.
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='template_editor_slides' AND column_name <> 'template_id'
-- EXCEPT
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='template_editor_post_slides' AND column_name <> 'post_id';
