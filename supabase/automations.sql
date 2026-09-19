-- Automations (node flows). Phase 1: just the flow graph. Credentials + run state come in later
-- phases (see production/AUTOMATIONS_DESIGN.md §9). Idempotent; mirrors the other schema files.
-- Run in: Supabase Dashboard → SQL Editor.

create table if not exists public.automations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null default 'Untitled automation',
  graph       jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  enabled     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists automations_user_id_idx on public.automations(user_id);

alter table public.automations enable row level security;

-- Owner can do everything with their own flows.
drop policy if exists "automations: owner all" on public.automations;
create policy "automations: owner all"
  on public.automations for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── Credentials (§9, §11) ─────────────────────────────────────────────────────
-- Secret material is encrypted with a server key (lib/automations/credentials.ts) before insert and is
-- NEVER selected client-side. The secret_encrypted column is readable only by the service role.
create table if not exists public.automation_credentials (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  label            text not null,
  kind             text not null,
  secret_encrypted text not null,
  created_at       timestamptz not null default now()
);

create index if not exists automation_credentials_user_id_idx on public.automation_credentials(user_id);

alter table public.automation_credentials enable row level security;

-- The owner may read metadata and delete their credentials, but NOT read the secret column or write it
-- directly — inserts/secret access go through the service role (server). A column-restricted select
-- policy isn't expressible in RLS, so we grant select to the owner and rely on the server never
-- selecting the secret column for the client. (The browser code in this app only ever selects id,label,kind.)
drop policy if exists "automation_credentials: owner read" on public.automation_credentials;
create policy "automation_credentials: owner read"
  on public.automation_credentials for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "automation_credentials: owner delete" on public.automation_credentials;
create policy "automation_credentials: owner delete"
  on public.automation_credentials for delete to authenticated
  using (user_id = auth.uid());

-- ── Run history (§9) ──────────────────────────────────────────────────────────
-- One row per flow run for the UI run log. (Durable pause/resume columns come in the final phase.)
create table if not exists public.automation_runs (
  id             uuid primary key default gen_random_uuid(),
  automation_id  uuid references public.automations(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  status         text not null,                 -- running | ok | error
  log            jsonb,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz
);

create index if not exists automation_runs_user_idx on public.automation_runs(user_id, started_at desc);

alter table public.automation_runs enable row level security;

drop policy if exists "automation_runs: owner all" on public.automation_runs;
create policy "automation_runs: owner all"
  on public.automation_runs for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
