import { NextResponse } from 'next/server';
import { requireUser, unauthorized } from '@/lib/serverAuth';
import { rateLimit, tooManyRequests } from '@/lib/rateLimit';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { notifySignup } from '@/lib/discord';
import { reportError } from '@/lib/reportError';

export const runtime = 'nodejs';

// Fired by the client the first time a user is authenticated (useAuth's onAuthStateChange → SIGNED_IN).
// Sends ONE Discord "new sign-up" notification per user, ever: deduped via app_metadata.signup_notified
// so re-logins never re-notify. Because it runs on the first authed session (not the raw signUp call), it
// catches BOTH the immediate-session flow and the email-confirmation flow (which has no session until the
// user confirms + logs in). Existing accounts created before this shipped are marked-but-NOT-notified on
// their next login — only accounts created within the recent window count as fresh sign-ups.
const FRESH_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h — absorbs an email-confirmation delay without back-notifying old users

export async function POST(req: Request) {
  // IP-keyed on top of the per-user dedupe below: scripted signups mint a FRESH user each time, so
  // per-user state alone can't stop them spamming the Discord webhook — the caller's IP can.
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  if (!(await rateLimit('notify:signup:' + ip, 5))) return tooManyRequests();

  const user = await requireUser(req);
  if (!user) return unauthorized();

  // Already processed — no send, no write.
  if ((user.app_metadata as { signup_notified?: boolean } | undefined)?.signup_notified) {
    return NextResponse.json({ ok: true, already: true });
  }

  const createdMs = user.created_at ? Date.parse(user.created_at) : 0;
  const isFresh = createdMs > 0 && Date.now() - createdMs < FRESH_WINDOW_MS;
  if (isFresh) {
    const meta = user.user_metadata as { full_name?: string; name?: string } | undefined;
    await notifySignup({ email: user.email ?? '', name: meta?.full_name || meta?.name || '', userId: user.id });
  }

  // Mark processed regardless (so an old account isn't re-checked on every login). Best-effort — a failure
  // here just means we might re-evaluate next login, which is harmless (the window still gates the send).
  try {
    await supabaseAdmin().auth.admin.updateUserById(user.id, {
      app_metadata: { ...(user.app_metadata ?? {}), signup_notified: true },
    });
  } catch (e) {
    reportError('notify/signup mark', e);
  }

  return NextResponse.json({ ok: true, notified: isFresh });
}
