-- Brand colors for the brand kit: an ordered jsonb array of hex strings (e.g. ["#0f172a","#22d3ee"]).
-- Powers the editor copilot's palette grounding and the upcoming brand-consistency lint.
-- Applied to prod 2026-07-05.
alter table public.brand_kit add column if not exists colors jsonb not null default '[]'::jsonb;
