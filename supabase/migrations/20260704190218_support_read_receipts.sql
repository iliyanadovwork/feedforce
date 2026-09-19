-- Cross-device read receipts for the support chat.
-- user_last_read_at: the user's read watermark, synced from the widget so the unread badge agrees
-- across devices/browsers (previously localStorage-only).

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
