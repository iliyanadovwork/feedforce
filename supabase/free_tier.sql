-- Free tier enforcement (product spec: FREE_TIER_PLAN.md). Free = no access-granting subscription
-- row. Three quotas are enforced at the database layer because the client writes to these tables /
-- buckets directly (RLS alone can't count):
--   * exports        — 3 finished pieces per UTC month, shared across carousels + reels. Charged
--                      per piece via export keys ('carousel:<templateId>' / 'reel:<entryId>'):
--                      re-exporting an already-charged piece (another slide, a retry, a
--                      re-download) is free within the month.
--   * templates      — 1 carousel (template_editor_templates) + 1 reel (twitter_templates)
--   * storage        — 500MB total, 100MB per file, across the user-content buckets
-- Pro features with real marginal cost (AI, automations, scheduling) are gated in the API routes
-- via requireSubscriber (lib/serverAuth.ts), not here. Quota checks take a per-user advisory lock
-- so concurrent requests can't race past the caps.
--
-- Applied to prod as migrations 20260704220000_free_tier + 20260705001000_free_tier_hardening.
-- Safe to re-run (the storage trigger is created only when absent — postgres can CREATE but not
-- DROP triggers on storage.objects, which supabase_storage_admin owns).
-- Run in: Supabase Dashboard → SQL Editor.

-- ---------------------------------------------------------------------------
-- Access check — SQL mirror of the server's isSubscriber() (lib/serverAuth.ts):
-- a row grants access while active/on-trial, or cancelled but not yet past its
-- paid-through date; a set ends_at in the past is always a hard expiry (how
-- redeemed free-month rows lapse on their own). ANY granting row counts.
-- NOT callable by end users: with public storage URLs embedding user ids, an
-- authenticated-callable version would be a subscription-status oracle.
-- ---------------------------------------------------------------------------
create or replace function public.has_active_subscription(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from subscriptions s
    where s.user_id = p_user
      and (s.ends_at is null or s.ends_at > now())
      and (
        s.status in ('active', 'on_trial')
        or (s.status = 'cancelled' and s.ends_at is not null)
      )
  );
$$;

revoke all on function public.has_active_subscription(uuid) from public, anon, authenticated;
grant execute on function public.has_active_subscription(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Export ledger — one row per (user, UTC month), mirroring ai_usage, plus the
-- keys table recording WHICH pieces were charged. A new month starts fresh:
-- the quota resets on the 1st and never rolls over. Users may READ their own
-- rows (the editor's remaining counter); all writes go through consume_export().
-- ---------------------------------------------------------------------------
create table if not exists public.export_usage (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  period     text        not null,           -- UTC month, 'YYYY-MM'
  exports    integer     not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, period)
);

alter table public.export_usage enable row level security;

drop policy if exists "export_usage_select_own" on public.export_usage;
create policy "export_usage_select_own" on public.export_usage
  for select using (auth.uid() = user_id);

create table if not exists public.export_usage_keys (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  period     text        not null,           -- UTC month, 'YYYY-MM'
  key        text        not null,           -- 'carousel:<templateId>' | 'reel:<entryId>'
  created_at timestamptz not null default now(),
  primary key (user_id, period, key)
);

alter table public.export_usage_keys enable row level security;

drop policy if exists "export_usage_keys_select_own" on public.export_usage_keys;
create policy "export_usage_keys_select_own" on public.export_usage_keys
  for select using (auth.uid() = user_id);

-- Atomically spend one export for the named piece. Subscribers pass through as
-- unlimited. Free users: an advisory lock serializes the user's charges, a key
-- already charged this month re-exports free, otherwise increment-with-cap.
create or replace function public.consume_export(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cap  constant integer := 3;
  uid  uuid := auth.uid();
  cur  text := to_char(now() at time zone 'utc', 'YYYY-MM');
  used integer;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_key is null or length(trim(p_key)) = 0 or length(p_key) > 200 then
    raise exception 'invalid_export_key';
  end if;

  if has_active_subscription(uid) then
    return jsonb_build_object('allowed', true, 'unlimited', true, 'remaining', null);
  end if;

  perform pg_advisory_xact_lock(hashtext('ff-export:' || uid::text));

  select exports into used from export_usage where user_id = uid and period = cur;
  used := coalesce(used, 0);

  if exists (select 1 from export_usage_keys k where k.user_id = uid and k.period = cur and k.key = p_key) then
    return jsonb_build_object('allowed', true, 'unlimited', false, 'remaining', greatest(cap - used, 0));
  end if;

  if used >= cap then
    return jsonb_build_object('allowed', false, 'unlimited', false, 'remaining', 0);
  end if;

  insert into export_usage_keys (user_id, period, key) values (uid, cur, p_key);
  insert into export_usage as eu (user_id, period, exports, updated_at)
  values (uid, cur, used + 1, now())
  on conflict (user_id, period) do update
    set exports = used + 1, updated_at = now();

  return jsonb_build_object('allowed', true, 'unlimited', false, 'remaining', cap - (used + 1));
end $$;

revoke all on function public.consume_export(text) from public, anon;
grant execute on function public.consume_export(text) to authenticated;

-- Read-only quota status for UI (never consumes).
create or replace function public.export_quota()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cap  constant integer := 3;
  uid  uuid := auth.uid();
  cur  text := to_char(now() at time zone 'utc', 'YYYY-MM');
  used integer;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  if has_active_subscription(uid) then
    return jsonb_build_object('unlimited', true, 'cap', null, 'used', null, 'remaining', null);
  end if;
  select exports into used from export_usage where user_id = uid and period = cur;
  used := coalesce(used, 0);
  return jsonb_build_object('unlimited', false, 'cap', cap, 'used', used, 'remaining', greatest(cap - used, 0));
end $$;

revoke all on function public.export_quota() from public, anon;
grant execute on function public.export_quota() to authenticated;

-- ---------------------------------------------------------------------------
-- Template cap — free users hold at most 1 row in each template table. Must be
-- a trigger: template saves go straight from client hooks to PostgREST. The
-- advisory lock closes the count-then-insert race between concurrent requests.
-- The error message is a stable token the client maps to the upgrade prompt.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_free_template_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cnt integer;
begin
  if has_active_subscription(new.user_id) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('ff-tpl:' || tg_table_name || ':' || new.user_id::text));
  execute format('select count(*) from public.%I where user_id = $1', tg_table_name)
    into cnt using new.user_id;
  if cnt >= 1 then
    raise exception 'free_plan_template_limit';
  end if;
  return new;
end $$;

drop trigger if exists free_template_cap on public.template_editor_templates;
create trigger free_template_cap
  before insert on public.template_editor_templates
  for each row execute function public.enforce_free_template_cap();

drop trigger if exists free_template_cap on public.twitter_templates;
create trigger free_template_cap
  before insert on public.twitter_templates
  for each row execute function public.enforce_free_template_cap();

-- Hygiene: strip the default PUBLIC EXECUTE so this trigger function isn't exposed on the REST RPC
-- surface (trigger firing doesn't check EXECUTE, so the cap is unaffected). Silences advisor 0028/0029.
revoke execute on function public.enforce_free_template_cap() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage quota — 500MB total / 100MB per file for free users, across the
-- user-content buckets. Uploads with no resolvable owner (service-role writes,
-- e.g. automation renders) pass through untouched, as do other buckets.
-- Deleting objects frees quota naturally (we sum live rows). The advisory lock
-- closes the sum-then-insert race between parallel uploads.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_free_storage_quota()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  quota_bytes constant bigint := 500 * 1024 * 1024;
  max_file    constant bigint := 100 * 1024 * 1024;
  uid       uuid;
  new_size  bigint;
  used      bigint;
begin
  if new.bucket_id not in ('post-images', 'post-videos', 'brand-kit-logos', 'brand-kit-fonts') then
    return new;
  end if;

  uid := coalesce(new.owner, case when new.owner_id ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$' then new.owner_id::uuid end);
  if uid is null or has_active_subscription(uid) then
    return new;
  end if;

  new_size := coalesce((new.metadata ->> 'size')::bigint, 0);
  if new_size > max_file then
    raise exception 'free_plan_file_too_large';
  end if;

  perform pg_advisory_xact_lock(hashtext('ff-storage:' || uid::text));

  select coalesce(sum((o.metadata ->> 'size')::bigint), 0) into used
  from storage.objects o
  where o.bucket_id in ('post-images', 'post-videos', 'brand-kit-logos', 'brand-kit-fonts')
    and coalesce(o.owner, case when o.owner_id ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$' then o.owner_id::uuid end) = uid;

  if used + new_size > quota_bytes then
    raise exception 'free_plan_storage_quota';
  end if;
  return new;
end $$;

-- postgres holds TRIGGER (create) privilege on storage.objects but NOT ownership, and DROP TRIGGER
-- requires ownership — so create only when absent instead of drop-and-recreate. Changing the
-- trigger's LOGIC only needs the CREATE OR REPLACE FUNCTION above; removing the trigger itself
-- requires the supabase_storage_admin role (Supabase dashboard support).
do $$
begin
  if not exists (
    select 1 from pg_trigger t
    where t.tgname = 'free_storage_quota' and t.tgrelid = 'storage.objects'::regclass and not t.tgisinternal
  ) then
    execute 'create trigger free_storage_quota before insert on storage.objects for each row execute function public.enforce_free_storage_quota()';
  end if;
end $$;

-- Hygiene: strip the default PUBLIC EXECUTE so this trigger function isn't exposed on the REST RPC
-- surface (trigger firing doesn't check EXECUTE, so the quota is unaffected). Silences advisor 0028/0029.
revoke execute on function public.enforce_free_storage_quota() from public, anon, authenticated;

-- Storage usage for UI preflight (bytes used across the user-content buckets).
create or replace function public.storage_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, storage
as $$
declare
  quota_bytes constant bigint := 500 * 1024 * 1024;
  max_file    constant bigint := 100 * 1024 * 1024;
  uid  uuid := auth.uid();
  used bigint;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0) into used
  from storage.objects o
  where o.bucket_id in ('post-images', 'post-videos', 'brand-kit-logos', 'brand-kit-fonts')
    and coalesce(o.owner, case when o.owner_id ~* '^[0-9a-f]{8}-[0-9a-f-]{27}$' then o.owner_id::uuid end) = uid;
  return jsonb_build_object(
    'unlimited', has_active_subscription(uid),
    'used_bytes', used,
    'quota_bytes', quota_bytes,
    'max_file_bytes', max_file
  );
end $$;

revoke all on function public.storage_usage() from public, anon;
grant execute on function public.storage_usage() to authenticated;
