'use client';

import { useState } from 'react';
import type { SignUpResult } from '../hooks/useAuth';
import { Button, TextField, Alert, EmptyState, cn } from '@/app/components/ui';
import { CheckIcon } from '@/lib/icons';

interface AuthFormProps {
  onSignIn: (email: string, password: string) => Promise<string | null>;
  onSignUp: (email: string, password: string) => Promise<SignUpResult>;
  onResetPassword: (email: string) => Promise<string | null>;
  /** Which screen to open on first render. Defaults to 'login'. */
  initialMode?: 'login' | 'signup';
  /** Overrides the default "...your Brand Kit" copy under the title, for hosts outside the main
   *  app (e.g. the affiliate signup) where that framing doesn't apply. */
  subtitle?: { login: string; signup: string };
  /** Max-width Tailwind class for the form. Defaults to 'max-w-sm' (fits the main app's compact
   *  auth modal); widen it for hosts with more room, e.g. the affiliate apply page. */
  maxWidthClassName?: string;
}

export function AuthForm({ onSignIn, onSignUp, onResetPassword, initialMode = 'login', subtitle, maxWidthClassName = 'max-w-sm' }: AuthFormProps) {
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Which "check your email" confirmation screen to show, if any.
  const [sentScreen, setSentScreen] = useState<null | 'reset' | 'confirm'>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    if (mode === 'forgot') {
      const err = await onResetPassword(email);
      if (err) { setError(err); } else { setSentScreen('reset'); }
      setLoading(false);
      return;
    }

    if (mode === 'login') {
      const err = await onSignIn(email, password);
      if (err) setError(err);
      setLoading(false);
      return;
    }

    // signup
    const res = await onSignUp(email, password);
    if (res.status === 'error') setError(res.message);
    else if (res.status === 'exists') setError('An account with this email already exists — try signing in instead.');
    else if (res.status === 'confirm-email') setSentScreen('confirm');
    // 'signed-in' → onAuthStateChange swaps the UI; nothing to do here.
    setLoading(false);
  }

  function switchMode(next: 'login' | 'signup' | 'forgot') {
    setMode(next);
    setError(null);
    setSentScreen(null);
  }

  if (sentScreen) {
    const isConfirm = sentScreen === 'confirm';
    return (
      <div className={cn('w-full', maxWidthClassName)}>
        <EmptyState
          icon={<CheckIcon size={22} className="text-fg" />}
          title="Check your email"
          description={
            isConfirm ? (
              <>We sent a confirmation link to <span className="text-fg">{email}</span>. Click it to activate your account, then sign in.</>
            ) : (
              <>We sent a password reset link to <span className="text-fg">{email}</span></>
            )
          }
          action={
            <Button variant="ghost" size="sm" onClick={() => switchMode('login')}>
              ← Back to sign in
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className={cn('w-full flex flex-col gap-6', maxWidthClassName)}>
      <div className="text-center">
        <h2 className="text-[20px] leading-tight font-bold tracking-[-0.01em] text-fg">
          {mode === 'login' ? 'Welcome back' : mode === 'signup' ? 'Create account' : 'Reset password'}
        </h2>
        <p className="text-body text-fg-3 mt-1">
          {mode === 'login'
            ? (subtitle?.login ?? 'Sign in to access your Brand Kit')
            : mode === 'signup'
            ? (subtitle?.signup ?? 'Set up your Brand Kit')
            : 'Enter your email to receive a reset link'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
        />

        {mode !== 'forgot' && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label htmlFor="auth-password" className="text-label text-fg-2">Password</label>
              {mode === 'login' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto px-0 text-fg-3 hover:bg-transparent"
                  onClick={() => switchMode('forgot')}
                >
                  Forgot password?
                </Button>
              )}
            </div>
            <TextField
              id="auth-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
            />
          </div>
        )}

        {error && (
          <Alert tone="danger">{error}</Alert>
        )}

        <Button
          type="submit"
          variant="primary"
          fullWidth
          loading={loading}
          disabled={loading}
        >
          {loading
            ? 'Please wait…'
            : mode === 'login'
            ? 'Sign in'
            : mode === 'signup'
            ? 'Create account'
            : 'Send reset link'}
        </Button>
      </form>

      {mode === 'forgot' ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-center"
          onClick={() => switchMode('login')}
        >
          ← Back to sign in
        </Button>
      ) : (
        <p className="text-center text-body text-fg-3">
          {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}
          {' '}
          <button
            onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
            className="text-fg font-medium hover:underline rounded-sm focus-ring"
          >
            {mode === 'login' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      )}
    </div>
  );
}
