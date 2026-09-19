-- Cap the reels grid at 50 per user WITHOUT ever rejecting or shrinking existing data.
--
-- A plain CHECK (jsonb_array_length(reels) <= 50) is unsafe here: one existing row already holds 486
-- reels, and the grid autosave upserts the WHOLE array on every edit — a CHECK would reject every one
-- of that user's saves (a broken save / apparent data loss). Instead, a BEFORE UPDATE trigger blocks
-- only writes that GROW the array past 50. An over-cap grid can still be saved as-is, shrunk, reordered
-- or edited — it just can't grow; a normal grid is capped at 50.
--
-- UPDATE only (not INSERT) is guarded on purpose: the client writes via INSERT ... ON CONFLICT DO
-- UPDATE, and a BEFORE INSERT check would fire on the insert-attempt phase of the existing over-cap
-- user's upsert and wrongly reject it. A brand-new user can't reach >50 without the client (which
-- blocks adds at 50); once their row exists, this trigger caps further growth. Safe to re-run.

create or replace function public.enforce_reel_cap() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_array_length(coalesce(new.reels, '[]'::jsonb)) > 50
     and jsonb_array_length(coalesce(new.reels, '[]'::jsonb)) > jsonb_array_length(coalesce(old.reels, '[]'::jsonb)) then
    raise exception 'Reel limit reached (max 50 per grid)' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists reel_cap on public.video_reels;
create trigger reel_cap before update on public.video_reels
  for each row execute function public.enforce_reel_cap();
