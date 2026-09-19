-- Free-tier hardening (fixes from the adversarial review of the initial free_tier migration).
--   1. has_active_subscription() was callable by any authenticated user with an arbitrary uuid —
--      a subscription-status oracle (user ids leak via public storage URLs). Revoke it.
--   2. consume_export() becomes key-based: each export names the piece it exports
--      ('carousel:<templateId>' / 'reel:<entryId>'). A key already charged this month re-exports
--      free — so a multi-slide carousel is ONE export (spec: "a carousel's PNG set = 1"), retrying
--      a failed reel doesn't double-charge, and double-clicks are idempotent. An advisory lock
--      makes check-and-charge race-free.
--   3. Both quota triggers had TOCTOU races (concurrent inserts each see the committed state and
--      all pass). Same per-user advisory lock before the count/sum.
-- The storage trigger BINDING is untouched (postgres can CREATE but not DROP triggers on
-- storage.objects — supabase_storage_admin owns it); CREATE OR REPLACE of the function is enough.

revoke execute on function public.has_active_subscription(uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- Export keys: which pieces were charged this month. Consulted by consume_export
-- so re-exporting the same piece (another slide, a retry, a re-download) is free.
-- ---------------------------------------------------------------------------
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

-- Replace the zero-arg counter bump with the key-based charge.
drop function if exists public.consume_export();

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

  -- Serialize this user's charges: the lock is transaction-scoped and per-user, so
  -- concurrent exports can't both read the same count and overshoot the cap.
  perform pg_advisory_xact_lock(hashtext('ff-export:' || uid::text));

  select exports into used from export_usage where user_id = uid and period = cur;
  used := coalesce(used, 0);

  -- Already charged for this piece this month → re-export free.
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

-- ---------------------------------------------------------------------------
-- Race-free template cap: same count logic behind a per-user-per-table lock.
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

-- ---------------------------------------------------------------------------
-- Race-free storage quota: per-user lock before the SUM so parallel uploads
-- can't all read the same stale total and blow past 500MB.
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
