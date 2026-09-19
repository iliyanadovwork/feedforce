'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Card, Alert, BrandLoader } from '@/app/components/ui';
import { startCheckout } from '@/lib/billing';

// Contextual upgrade prompt for free users (product spec: FREE_TIER_PLAN.md). Successor to the old
// full-screen Paywall: same card, but dismissable — free users keep the studio, this only appears
// when they hit something Pro (an AI feature, the export quota, the template cap). `reason` is the
// one-line explanation of what was locked.

interface UpgradeModalProps {
  reason: string;
  email?: string;
  onClose: () => void;
  // Called when checkout reveals the account is already subscribed (stale plan snapshot). The host
  // refreshes the plan and dismisses — a subscribed user shouldn't be looking at this modal.
  onSubscribed?: () => void;
}

export function UpgradeModal({ reason, email, onClose, onSubscribed }: UpgradeModalProps) {
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Site-wide launch offer (admin-toggled at /admin). When active we advertise the code here; the
  // user enters it in the "Add promotion code" field on the checkout page.
  const [offer, setOffer] = useState<{ code: string; percentOff: number } | null>(null);
  const [offerCopied, setOfferCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/billing/offer')
      .then(res => (res.ok ? res.json() : null))
      .then(json => {
        if (!cancelled && json?.active && json.code) setOffer({ code: json.code, percentOff: json.percentOff ?? 50 });
      })
      .catch(() => { /* no offer — banner simply doesn't render */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copyOfferCode() {
    if (!offer) return;
    try {
      await navigator.clipboard.writeText(offer.code);
      setOfferCopied(true);
      setTimeout(() => setOfferCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }

  async function handleSubscribe() {
    setError(null);
    setCheckoutLoading(true);
    try {
      await startCheckout(); // redirects the browser to the active provider's checkout on success
    } catch (e) {
      // Already subscribed → the host refreshes the plan and closes; no error to show.
      if ((e as { code?: string })?.code === 'already_subscribed' && onSubscribed) { onSubscribed(); return; }
      setError(e instanceof Error ? e.message : 'Checkout failed');
      setCheckoutLoading(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upgrade to Pro"
      className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto bg-page/60 backdrop-blur-md text-fg px-4 py-8"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md flex flex-col items-center gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/feedforce-logo-white.svg" alt="FeedForce" className="ff-logo h-8 w-auto select-none" />

        <Card surface={1} padding="md" className="relative w-full sm:p-6">
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute right-3 top-3 grid size-8 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-ring"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>

          <div className="flex flex-col gap-5">
            <div className="text-center">
              <h1 className="text-[20px] leading-tight font-bold tracking-[-0.01em] text-fg">Upgrade to Pro</h1>
              <p className="text-body text-fg-3 mt-1">{reason}</p>
            </div>

            <ul className="flex flex-col gap-2 text-body text-fg-2">
              {[
                'Unlimited exports and templates',
                'Build elements and automations using AI',
                'Node automations that run your content on repeat',
                'Schedule and publish across your social accounts',
                'Post analytics in one place',
              ].map(f => (
                <li key={f} className="flex items-start gap-2">
                  <svg viewBox="0 0 16 16" className="h-4 w-4 mt-0.5 shrink-0 text-fg" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 8.5 6.5 12 13 4.5" />
                  </svg>
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            {offer && (
              <div className="rounded-sm border border-accent-border bg-accent-tint px-3 py-2 text-center text-caption text-fg">
                <span className="font-semibold">{offer.percentOff}% off your first month,</span> use code{' '}
                <button
                  type="button"
                  onClick={copyOfferCode}
                  className="font-mono font-semibold underline underline-offset-2 focus-ring rounded-xs"
                  title="Click to copy"
                >
                  {offer.code}
                </button>
                {offerCopied ? ' · copied' : ' on the payment page.'}
              </div>
            )}

            <Button variant="primary" fullWidth loading={checkoutLoading} disabled={checkoutLoading} onClick={handleSubscribe}>
              Subscribe
            </Button>
            {error && <Alert tone="danger">{error}</Alert>}
          </div>
        </Card>

        {email && <p className="text-caption text-fg-3">Signed in as <span className="text-fg-2">{email}</span></p>}
      </div>
    </div>
  );
}

// ── Checkout-return activation ────────────────────────────────────────────────────────────────────
// When the payment provider redirects back with ?checkout=success, the webhook that records the
// subscription may not have landed yet — poll the subscriptions table until it does. Lived in the
// old Paywall; now free users roam the whole studio, so page.tsx mounts this at the top level.

export type ActivationState = 'idle' | 'pending' | 'timeout';

// The pending poll used to live ONLY in React state, and the ?checkout=success param was stripped
// on the first load — so a reload during activation (before the webhook landed) dropped the poll
// and showed a paying customer "subscribe again". We now stamp the activation start in localStorage
// on return from checkout and treat a fresh stamp as "still activating", so a reload RESUMES the
// poll (anchored to the original start, so it can't loop forever) instead of stranding the user.
// The key is per-user so a slow-webhook stamp on a shared browser can't surface a false "payment
// went through" to whoever signs in next. Cleared when the plan flips to pro or the window elapses.
const ACTIVATION_PREFIX = 'ff-checkout-activating:';
const ACTIVATION_WINDOW_MS = 180_000; // 3 min outer bound, spanning reloads

// A non-expired stamp means we're mid-activation; a stale one is swept as it's read.
function readActivationStart(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const started = Number(raw);
    if (!Number.isFinite(started) || Date.now() - started > ACTIVATION_WINDOW_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return started;
  } catch { return null; }
}
function clearActivation(key: string) {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

// `subscribed` is the caller's live plan check — the poll's SUCCESS signal. The old Paywall never
// needed one (its parent unmounted it when the plan flipped); this hook's host stays mounted, so
// without it the pending pill would sit forever and then fire a false "payment not confirmed".
// `userId` scopes the stamp so activation state never leaks across accounts on a shared browser.
export function useCheckoutActivation(refresh: () => Promise<void>, subscribed: boolean, userId: string | null): ActivationState {
  const [state, setState] = useState<ActivationState>('idle');
  // Kept in refs so the polling effect always sees the latest values without resubscribing.
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  const subscribedRef = useRef(subscribed);
  useEffect(() => { subscribedRef.current = subscribed; }, [subscribed]);

  const activationKey = userId ? ACTIVATION_PREFIX + userId : null;

  // Plan flipped to pro → activation done. Drop the stamp so a later normal load never re-enters
  // the waiting state (covers success reached in another tab / on the poll's own refresh).
  useEffect(() => { if (subscribed && activationKey) clearActivation(activationKey); }, [subscribed, activationKey]);

  // Effect-driven (not a mount-time useState) so it runs once we actually know the user — auth
  // restores async after a checkout redirect, so userId is null on the first render. It also means
  // the initial render is always 'idle', identical on server and client (no hydration mismatch).
  useEffect(() => {
    if (!activationKey) return;
    const fromParam = typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).get('checkout') === 'success';
    // A genuine return from checkout starts a FRESH window; a plain reload resumes the persisted
    // one (anchored to that first return, so repeated reloads can't extend it indefinitely).
    const started = fromParam ? Date.now() : readActivationStart(activationKey);
    if (started == null) return;

    // Persist the start (survives reload) then strip the URL param for a clean address bar — the
    // localStorage stamp, not the param, is what resumes the poll after a reload.
    try { localStorage.setItem(activationKey, String(started)); } catch { /* private mode */ }
    if (fromParam) {
      const q = new URLSearchParams(window.location.search);
      q.delete('checkout');
      const rest = q.toString();
      window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
    }

    let cancelled = false;
    // Reveal the pill on the next macrotask, not synchronously in the effect (which would cascade a
    // render) — and only if the webhook hasn't already landed by then.
    const reveal = window.setTimeout(() => { if (!cancelled && !subscribedRef.current) setState('pending'); }, 0);
    const tick = async () => {
      if (cancelled || subscribedRef.current) return; // success — the derived return dismisses the pill
      // Best-effort: a transient refresh failure must not kill the loop — keep polling to the window.
      try { await refreshRef.current(); } catch { /* transient — retry next tick */ }
      if (cancelled || subscribedRef.current) return;
      if (Date.now() - started > ACTIVATION_WINDOW_MS) { clearActivation(activationKey); setState('timeout'); return; }
      timer = window.setTimeout(tick, 2500);
    };
    let timer = window.setTimeout(tick, 1500);
    return () => { cancelled = true; window.clearTimeout(reveal); window.clearTimeout(timer); };
  }, [activationKey]);

  // Success is DERIVED, not stored: the instant the plan flips, the pill dismisses. A premature
  // timeout resolves on the user's next reload (the alert prompts it) — we intentionally stop
  // polling at the window bound rather than run a background poll forever.
  return subscribed ? 'idle' : state;
}

// Floating status for the activation poll — pending pill or timeout alert. Rendered by page.tsx
// while the rest of the studio stays interactive.
export function ActivationToast({ state }: { state: ActivationState }) {
  if (state === 'idle') return null;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[1100] pointer-events-auto">
      {state === 'pending' ? (
        <div className="flex items-center gap-3 rounded-full border border-line bg-surface-1 px-4 py-2 shadow-lg">
          <BrandLoader size={20} />
          <span className="text-caption text-fg-2">Activating your subscription…</span>
        </div>
      ) : (
        <div className="max-w-sm">
          <Alert tone="danger">
            Your payment went through but we haven&apos;t received the confirmation yet. Reload in a
            minute — if this persists, contact support.
          </Alert>
        </div>
      )}
    </div>
  );
}
