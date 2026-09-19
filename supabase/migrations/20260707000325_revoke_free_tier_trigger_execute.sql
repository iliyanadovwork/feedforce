-- Hygiene: enforce_free_storage_quota and enforce_free_template_cap are TRIGGER functions — nothing
-- should reach them through the REST RPC surface, but Postgres grants EXECUTE to PUBLIC by default,
-- so the Supabase security advisor flags them (lint 0028/0029). Trigger firing does not check
-- EXECUTE, so the caps keep working; this only strips the unneeded public grant (matching the
-- earlier support_msg_bump fix). Idempotent — revoke is a no-op once the grant is gone.
revoke execute on function public.enforce_free_storage_quota() from public, anon, authenticated;
revoke execute on function public.enforce_free_template_cap() from public, anon, authenticated;
