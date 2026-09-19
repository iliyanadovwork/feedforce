'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { authedFetch } from '@/lib/authedFetch';
import type { User } from '@supabase/supabase-js';

export type SignUpResult =
  | { status: 'signed-in' }      // session created immediately (email confirmation off)
  | { status: 'confirm-email' }  // account created, confirmation email sent
  | { status: 'exists' }         // an account with this email already exists
  | { status: 'error'; message: string };

// Non-sensitive presence hint the SERVER can read (getSession's session lives in localStorage,
// which SSR can't see). page.tsx reads this to paint the loader instead of the marketing landing
// for returning users — no refresh flash. It holds NO token and grants nothing: a forged value
// only changes loader-vs-landing for one paint before getSession() decides for real. Kept in sync
// with the actual session below so it can't outlive a sign-out for more than a stale beat.
const AUTH_HINT_COOKIE = 'ff-auth';
function syncAuthHintCookie(hasSession: boolean): void {
  if (typeof document === 'undefined') return;
  if (hasSession) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    // 30-day hint, refreshed on every auth event; SameSite=Lax so it rides top-level navigations.
    document.cookie = `${AUTH_HINT_COOKIE}=1; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax${secure}`;
  } else {
    document.cookie = `${AUTH_HINT_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  }
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      syncAuthHintCookie(!!session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      syncAuthHintCookie(!!session);
      // First-auth "new sign-up" Discord ping. Fires on genuine sign-in/up (SIGNED_IN), not page reloads
      // (INITIAL_SESSION) or token refreshes; the server dedups so it notifies exactly once per user and
      // ignores existing accounts. Deferred out of the callback — Supabase warns against calling auth
      // methods (authedFetch reads the session) synchronously inside onAuthStateChange.
      if (event === 'SIGNED_IN' && session) {
        setTimeout(() => { authedFetch('/api/notify/signup', { method: 'POST' }).catch(() => { /* best-effort */ }); }, 0);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function signIn(email: string, password: string): Promise<string | null> {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error?.message ?? null;
  }

  async function signUp(email: string, password: string): Promise<SignUpResult> {
    // emailRedirectTo pins the confirmation-email link to the origin the user
    // signed up from. Without it Supabase falls back to the dashboard Site URL,
    // which is exactly what broke prod signups (Site URL pointed at localhost,
    // so confirmation links sent prod users there). The origin must also be in
    // the dashboard redirect allow-list — same constraint resetPassword below
    // already relies on.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) return { status: 'error', message: error.message };
    // With email-enumeration protection on, Supabase returns a decoy user with
    // an empty identities array when the email is already registered.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      return { status: 'exists' };
    }
    if (data.session) return { status: 'signed-in' };
    return { status: 'confirm-email' };
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  async function resetPassword(email: string): Promise<string | null> {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    return error?.message ?? null;
  }

  async function updatePassword(password: string): Promise<string | null> {
    const { error } = await supabase.auth.updateUser({ password });
    return error?.message ?? null;
  }

  async function changePassword(currentPassword: string, newPassword: string): Promise<string | null> {
    if (!user?.email) return 'No user email found';
    const { error: verifyErr } = await supabase.auth.signInWithPassword({ email: user.email, password: currentPassword });
    if (verifyErr) return 'Current password is incorrect';
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    return error?.message ?? null;
  }

  return { user, loading, signIn, signUp, signOut, resetPassword, updatePassword, changePassword };
}
