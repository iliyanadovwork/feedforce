'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [ready, setReady] = useState(false);
  const [linkError, setLinkError] = useState(false);

  useEffect(() => {
    let resolved = false;
    const markReady = () => { resolved = true; setLinkError(false); setReady(true); };

    // Supabase processes the recovery token from the URL hash and fires PASSWORD_RECOVERY.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') markReady();
    });

    // Fallback for when the recovery session is already established before the
    // listener attaches (the event would otherwise be missed).
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) markReady();
    });

    // Don't spin forever: if nothing resolved, the link is invalid or expired.
    const t = setTimeout(() => { if (!resolved) setLinkError(true); }, 8000);

    return () => { subscription.unsubscribe(); clearTimeout(t); };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setError(null);
    setLoading(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    if (err) { setError(err.message); } else { setDone(true); }
    setLoading(false);
  }

  if (done) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="w-full max-w-sm flex flex-col gap-6 text-center px-4">
          <div>
            <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-4">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <h2 className="text-2xl font-semibold text-white tracking-tight">Password updated</h2>
            <p className="text-sm text-zinc-500 mt-2">Your password has been changed successfully.</p>
          </div>
          <Link href="/" className="w-full py-2.5 rounded-xl bg-white text-black text-sm font-semibold hover:bg-zinc-100 transition-colors text-center block">
            Go to app
          </Link>
        </div>
      </div>
    );
  }

  if (linkError && !ready) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="w-full max-w-sm flex flex-col gap-6 text-center px-4">
          <div>
            <div className="w-12 h-12 rounded-full bg-red-950/40 border border-red-800/50 flex items-center justify-center mx-auto mb-4">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-400">
                <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
            </div>
            <h2 className="text-2xl font-semibold text-white tracking-tight">Reset link invalid or expired</h2>
            <p className="text-sm text-zinc-500 mt-2">Request a new password reset link from the sign-in screen and try again.</p>
          </div>
          <Link href="/" className="w-full py-2.5 rounded-xl bg-white text-black text-sm font-semibold hover:bg-zinc-100 transition-colors text-center block">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-5 h-5 border-2 border-zinc-600 border-t-white rounded-full animate-spin" />
          <p className="text-xs text-zinc-600">Verifying your reset link…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center">
      <div className="w-full max-w-sm flex flex-col gap-6 px-4">
        <div className="text-center">
          <h2 className="text-2xl font-semibold text-white tracking-tight">Set new password</h2>
          <p className="text-sm text-zinc-500 mt-1">Choose a strong password for your account</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider">New password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              className="w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-zinc-600 outline-none transition-colors"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Confirm password</label>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              className="w-full bg-zinc-900 border border-zinc-800 focus:border-zinc-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-zinc-600 outline-none transition-colors"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400 bg-red-950/40 border border-red-800/50 rounded-lg px-3 py-2">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-xl bg-white text-black text-sm font-semibold hover:bg-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}
