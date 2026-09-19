-- public_elements has `updated_at timestamptz not null default now()` but no update trigger, so the
-- DEFAULT only fires on INSERT — any admin/service-role edit to a public element leaves updated_at
-- showing the creation time (misleading audit/debug data). Attach the shared set_updated_at() trigger.
--
-- set_updated_at() is defined out-of-band in supabase/setup.sql; (re)create it here so this migration is
-- self-contained and idempotent against either a live DB or a fresh one.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_public_elements_updated_at on public.public_elements;
create trigger trg_public_elements_updated_at
  before update on public.public_elements
  for each row execute function public.set_updated_at();
