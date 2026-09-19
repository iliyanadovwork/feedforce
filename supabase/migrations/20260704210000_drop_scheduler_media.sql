-- scheduler_media was the "Send to scheduler" media-picker table; the feature shipped on
-- scheduled_render_media instead and no code references this table (0 rows on prod). Index,
-- RLS and policies are table-scoped, so the drop removes them too.
drop table if exists public.scheduler_media;
