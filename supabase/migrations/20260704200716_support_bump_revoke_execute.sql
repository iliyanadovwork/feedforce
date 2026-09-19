-- support_msg_bump is a trigger function — nothing should be able to invoke it through the REST
-- RPC surface (Postgres grants EXECUTE to PUBLIC on new functions by default). Postgres already
-- refuses to run trigger functions outside a trigger, so this is pure hygiene: it removes the
-- grant and silences the Supabase security advisor (lint 0028/0029). Trigger firing is unaffected
-- — EXECUTE privilege is not checked when a trigger fires.
revoke execute on function public.support_msg_bump() from public, anon, authenticated;
