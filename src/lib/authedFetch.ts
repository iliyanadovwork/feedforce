import { supabase } from './supabase';
import { requestUpgrade } from './upgradePrompt';

// fetch() wrapper for calls to our own /api routes: attaches the signed-in
// user's Supabase access token so the server (lib/serverAuth.ts) can verify
// the caller before hitting paid external APIs.
export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  const headers = new Headers(init.headers);
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 403) {
    // Peek on a clone — callers still get an unread body.
    try {
      const body = await res.clone().json();
      // A free user reached a Pro-only route (requireSubscriber) — pop the upgrade modal
      // so every Pro fetch in the app gets the prompt without each button wiring it up.
      if (body?.code === 'subscription_required') requestUpgrade();
    } catch { /* non-JSON 403 — not ours */ }
  }
  return res;
}
