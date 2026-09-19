-- Live support chat ("Help & support" widget). One conversation per user; messages stream to the
-- user in realtime (postgres_changes, RLS-scoped), admins read/reply via /api/support/inbox
-- (service role, gated by the ADMIN_EMAILS env). Replaces the one-shot support_tickets table.
-- Idempotent; mirrors the other schema files. Run in: Supabase Dashboard → SQL Editor.
--
-- Tracked in the project's migration history as 20260702225727_support_chat plus follow-ups —
-- see supabase/migrations/. Keep this file (fresh-setup reference) and migrations/ in sync:
-- new support schema changes get a migration file AND are folded in here.

create table if not exists public.support_conversations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  email            text not null default '',
  status           text not null default 'open' check (status in ('open', 'closed')),
  last_sender      text not null default 'user' check (last_sender in ('user', 'admin')),
  created_at       timestamptz not null default now(),
  last_message_at  timestamptz not null default now()
);

-- One thread per user (the widget shows a single ongoing conversation).
create unique index if not exists support_conversations_user_uniq on public.support_conversations(user_id);
create index if not exists support_conversations_last_idx on public.support_conversations(last_message_at desc);

create table if not exists public.support_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.support_conversations(id) on delete cascade,
  sender           text not null check (sender in ('user', 'admin')),
  body             text not null,
  created_at       timestamptz not null default now()
);

create index if not exists support_messages_convo_idx on public.support_messages(conversation_id, created_at);

alter table public.support_conversations enable row level security;
alter table public.support_messages enable row level security;

-- Users: read their own conversation, create it, read its messages, and send messages AS 'user'
-- into it. No user update/delete — status changes and admin replies go through the service role
-- in /api/support/inbox.
drop policy if exists "support_convos: owner select" on public.support_conversations;
create policy "support_convos: owner select"
  on public.support_conversations for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "support_convos: owner insert" on public.support_conversations;
create policy "support_convos: owner insert"
  on public.support_conversations for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "support_msgs: owner select" on public.support_messages;
create policy "support_msgs: owner select"
  on public.support_messages for select to authenticated
  using (exists (
    select 1 from public.support_conversations c
    where c.id = conversation_id and c.user_id = auth.uid()
  ));

drop policy if exists "support_msgs: owner insert" on public.support_messages;
create policy "support_msgs: owner insert"
  on public.support_messages for insert to authenticated
  with check (
    sender = 'user'
    and exists (
      select 1 from public.support_conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

-- Every message bumps its conversation's recency + last_sender, and a user message re-opens a
-- closed thread. SECURITY DEFINER so the bump works for user inserts despite no owner-update policy.
create or replace function public.support_msg_bump() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.support_conversations
     set last_message_at = new.created_at,
         last_sender     = new.sender,
         status          = case when new.sender = 'user' then 'open' else status end
   where id = new.conversation_id;
  return new;
end $$;

drop trigger if exists support_msg_bump on public.support_messages;
create trigger support_msg_bump
  after insert on public.support_messages
  for each row execute function public.support_msg_bump();

-- Hygiene: strip the default PUBLIC EXECUTE grant so the trigger function isn't exposed on the
-- REST RPC surface (trigger firing doesn't check EXECUTE, so the trigger is unaffected).
revoke execute on function public.support_msg_bump() from public, anon, authenticated;

-- Realtime: the widget subscribes to INSERTs on support_messages (RLS scopes delivery to the
-- user's own conversation). Publication membership isn't idempotent, hence the guard.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'support_messages'
  ) then
    alter publication supabase_realtime add table public.support_messages;
  end if;
end $$;

-- The one-shot tickets table this chat replaces (created empty earlier the same day).
drop table if exists public.support_tickets;

-- Cross-device read receipts (migration 20260704190218_support_read_receipts).
-- user_last_read_at: the user's read watermark, synced from the widget so the unread badge
-- agrees across devices/browsers.
alter table public.support_conversations
  add column if not exists user_last_read_at timestamptz;

-- Users may update ONLY their read watermark on their own row: column-level grant + owner RLS.
-- Everything else (status, admin replies) still goes through the service role in
-- /api/support/inbox, which is unaffected by these grants.
revoke update on table public.support_conversations from anon, authenticated;
grant update (user_last_read_at) on table public.support_conversations to authenticated;

-- Same hardening for INSERT: the widget only ever supplies (user_id, email), and a broad grant
-- would let a user preset status, last_sender or the timestamps on their own row.
revoke insert on table public.support_conversations from anon, authenticated;
grant insert (user_id, email) on table public.support_conversations to authenticated;

drop policy if exists "support_convos: owner update read mark" on public.support_conversations;
create policy "support_convos: owner update read mark"
  on public.support_conversations for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
