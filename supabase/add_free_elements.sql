-- =============================================================================
-- Migration: freeform elements for the merged skeleton/freeform template editor
-- -----------------------------------------------------------------------------
-- free_elements holds zone-style content (tags / quotes / swipes / logos /
-- dividers) that the user dragged OUT of a skeleton box (or dropped outside
-- one). JSONB array of objects:
--   { "id": "<uuid>", "kind": "tag|quote|swipe|logo|divider",
--     "x": 120, "y": 480, "width": 320, "height": 73, ...kind payload }
--
-- Idempotent — safe to re-run. Run BEFORE deploying the merged-editor build
-- (autosave writes this column).
-- =============================================================================
ALTER TABLE public.template_editor_slides
  ADD COLUMN IF NOT EXISTS free_elements jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.template_editor_post_slides
  ADD COLUMN IF NOT EXISTS free_elements jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Unified layer order (text boxes + freeform elements + images-in-posts + fade),
-- bottom→top by element id. Drives the Layers panel and the canvas draw order.
ALTER TABLE public.template_editor_slides
  ADD COLUMN IF NOT EXISTS layer_order_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.template_editor_post_slides
  ADD COLUMN IF NOT EXISTS layer_order_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
