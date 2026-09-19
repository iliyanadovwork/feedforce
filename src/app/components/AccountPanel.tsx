'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Avatar, Button, TextField, Alert, Card, SectionHeader, ProgressBar } from '@/app/components/ui';
import { authedFetch } from '@/lib/authedFetch';
import { supabase } from '@/lib/supabase';
import { clearTwitterTemplatesCache } from '@/app/hooks/useTwitterTemplates';
import { clearTemplateEditorCache } from '@/app/hooks/useTemplateEditor';
import { useSubscription } from '@/app/hooks/useSubscription';
import { startCheckout } from '@/lib/billing';
import { useTheme, setTheme, THEMES } from '@/lib/theme';

interface AccountPanelProps {
  user: { id: string; email?: string } | null;
  onChangePassword: (current: string, next: string) => Promise<string | null>;
  onSignOut: () => void | Promise<void>;
}

// Dedicated account page: profile summary, change-password (moved here from the Branding page),
// and sign out. Reached from the sidebar's account button.
export function AccountPanel({ user, onChangePassword, onSignOut }: AccountPanelProps) {
  const theme = useTheme();
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwLoading, setPwLoading] = useState(false);
  const [pwDone, setPwDone] = useState(false);

  // ── Billing (Lemon Squeezy) ────────────────────────────────────────────────
  const { subscription, isActive, loading: subLoading, refresh: refreshSubscription } = useSubscription(user?.id);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  async function handleUpgrade() {
    setCheckoutError(null);
    setCheckoutLoading(true);
    try {
      await startCheckout(); // redirects the browser to the active provider's checkout on success
    } catch (e) {
      // The checkout was blocked because this account already subscribed (a stale plan snapshot —
      // e.g. paid in another tab, or the webhook landed after this panel mounted). Refresh so the
      // card flips to the subscribed/"Manage subscription" state the message points at.
      if ((e as { code?: string })?.code === 'already_subscribed') void refreshSubscription();
      setCheckoutError(e instanceof Error ? e.message : 'Checkout failed');
      setCheckoutLoading(false);
    }
  }

  // "Manage subscription" mints a portal URL at click time — both providers' portal links are
  // short-lived, so the mirrored row can't be linked to directly.
  const [portalLoading, setPortalLoading] = useState(false);
  async function handleManage() {
    setCheckoutError(null);
    setPortalLoading(true);
    try {
      const res = await authedFetch('/api/billing/portal', { method: 'POST' });
      const { url, error } = await res.json().catch(() => ({ url: null, error: 'Could not open the billing portal' }));
      if (!res.ok || !url) throw new Error(error || 'Could not open the billing portal');
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setCheckoutError(e instanceof Error ? e.message : 'Could not open the billing portal');
    } finally {
      setPortalLoading(false);
    }
  }

  // ── Monthly AI credit meter (see lib/aiBudget.ts / api/billing/ai-usage) ──
  const [aiUsage, setAiUsage] = useState<{ spentMicros: number; budgetMicros: number; resetsAt: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    authedFetch('/api/billing/ai-usage')
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (!cancelled && data) setAiUsage(data); })
      .catch(() => { /* meter is informational — fail silent */ });
    return () => { cancelled = true; };
  }, []);
  const aiPct = aiUsage && aiUsage.budgetMicros > 0
    ? Math.min(100, (aiUsage.spentMicros / aiUsage.budgetMicros) * 100)
    : 0;

  // ── Debug: delete all of the user's templates ──────────────────────────────
  const [delConfirm, setDelConfirm] = useState(false);
  const [delLoading, setDelLoading] = useState(false);
  const [delDone, setDelDone] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

  async function handleChangePw(e: FormEvent) {
    e.preventDefault();
    if (pwNew !== pwConfirm) { setPwError('New passwords do not match'); return; }
    setPwError(null);
    setPwLoading(true);
    const err = await onChangePassword(pwCurrent, pwNew);
    if (err) { setPwError(err); } else { setPwDone(true); setPwCurrent(''); setPwNew(''); setPwConfirm(''); }
    setPwLoading(false);
  }

  // DEBUG: wipe every template the signed-in user owns — carousel (template editor), reels/twitter
  // templates, and posts. Their slide rows cascade-delete via FK, so only these parent tables need
  // deleting. Branding (brand_kit, brand_kit_logos, brand_kit_fonts) is intentionally NOT touched.
  // RLS + the user_id filter mean this can only ever delete the current user's own rows.
  async function handleDeleteTemplates() {
    if (!user?.id) return;
    setDelLoading(true);
    setDelError(null);
    const uid = user.id;
    // Posts before templates (deleting a template only SET NULLs posts.source_template_id; it doesn't
    // cascade-delete the post). Order is otherwise unimportant.
    for (const table of ['template_editor_posts', 'template_editor_templates', 'twitter_templates']) {
      const { error } = await supabase.from(table).delete().eq('user_id', uid);
      if (error) { setDelError(`Failed deleting ${table}: ${error.message}`); setDelLoading(false); setDelConfirm(false); return; }
    }
    // The rows are gone from the DB, but the editors' in-memory caches still mirror the old data. Clear
    // them (and the reels selection) so navigating to a posting/editor page shows the empty state right
    // away instead of flashing the stale template (the posting animation) until the refetch returns empty.
    clearTwitterTemplatesCache(uid);
    clearTemplateEditorCache(uid);
    try { localStorage.removeItem(`de:reeltpl:${uid}`); } catch { /* ignore */ }
    setDelLoading(false);
    setDelConfirm(false);
    setDelDone(true);
  }

  return (
    <div className="flex flex-col items-center pt-10 gap-10">
      <div className="w-full max-w-2xl flex flex-col gap-6">
        <div>
          <h2 className="text-[20px] leading-tight font-bold tracking-[-0.01em] text-fg mb-1">Account</h2>
          <p className="text-body text-fg-3">Manage your account and security</p>
        </div>

        {/* Profile summary */}
        <Card surface={1} padding="md">
          <div className="flex items-center gap-3">
            <Avatar fallback={(user?.email ?? '?').charAt(0)} size={40} />
            <div className="min-w-0">
              <p className="text-label text-fg">Signed in</p>
              <p className="text-body text-fg-3 truncate">{user?.email ?? '—'}</p>
            </div>
          </div>
        </Card>

        {/* Appearance — theme picker (moved here from the sidebar). */}
        <Card surface={1} padding="md">
          <div className="flex flex-col gap-3">
            <SectionHeader title="Appearance" />
            <p className="text-caption text-fg-3 -mt-1">Choose how the studio looks. Applies instantly and is remembered on this device.</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="radiogroup" aria-label="Theme">
              {THEMES.map(t => {
                const selected = theme === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setTheme(t.value)}
                    className={`flex flex-col items-stretch gap-2 rounded-lg border p-2.5 text-left transition-colors focus-ring ${selected ? 'border-accent bg-accent-tint' : 'border-line hover:border-line-strong hover:bg-hover'}`}
                  >
                    {/* Swatch = the theme's page background, so each tile previews the option. */}
                    <span aria-hidden className="h-9 w-full rounded-md border border-line-strong" style={{ background: t.swatch }} />
                    <span className="flex items-center gap-1.5 text-label text-fg">
                      <span className="flex-1 truncate">{t.label}</span>
                      {selected && (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent" aria-hidden>
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </Card>

        {/* Billing (Lemon Squeezy subscription) */}
        <Card surface={1} padding="md">
          <div className="flex flex-col gap-3">
            <SectionHeader title="Billing" />
            {subLoading ? (
              <p className="text-caption text-fg-3">Loading…</p>
            ) : isActive && subscription ? (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-label text-fg">
                    {subscription.plan_name || 'Subscribed'} · <span className="text-fg-2 capitalize">{subscription.status.replace(/_/g, ' ')}</span>
                  </p>
                  <p className="text-caption text-fg-3">
                    {/* ends_at set = access has an end date (cancelled, or Stripe's cancel-at-period-end
                        where the status stays active until the period lapses). */}
                    {subscription.ends_at
                      ? `Access ends ${new Date(subscription.ends_at).toLocaleDateString()}`
                      : subscription.renews_at
                      ? `Renews ${new Date(subscription.renews_at).toLocaleDateString()}`
                      : ''}
                  </p>
                </div>
                {/* Comp (redeem-code) access has no billing portal to manage. */}
                {subscription.provider !== 'redeem' && (
                  <Button variant="secondary" size="sm" className="shrink-0" loading={portalLoading} disabled={portalLoading} onClick={handleManage}>
                    Manage subscription
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-label text-fg">Upgrade to Pro</p>
                  <p className="text-caption text-fg-3">Subscribe to unlock the full studio.</p>
                </div>
                <Button variant="primary" size="sm" loading={checkoutLoading} disabled={checkoutLoading} onClick={handleUpgrade}>Upgrade</Button>
              </div>
            )}
            {checkoutError && <Alert tone="danger">{checkoutError}</Alert>}

            {/* AI credit: % of the monthly allowance used (dollar amounts stay internal — users buy
                a subscription in GBP, so surfacing a USD figure would only confuse). */}
            {aiUsage && (
              <div className="flex flex-col gap-1.5 pt-1">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-label text-fg">AI credits</p>
                  <p className="text-caption text-fg-3">
                    {Math.round(aiPct)}% used · resets {new Date(aiUsage.resetsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  </p>
                </div>
                <ProgressBar value={aiPct} label="Monthly AI credit used" />
                {aiPct >= 100 && (
                  <p className="text-caption text-fg-3">You’ve used this month’s AI credit — features that use AI are paused until it resets.</p>
                )}
              </div>
            )}
          </div>
        </Card>

        {/* Change password */}
        <Card surface={1} padding="md">
          {pwDone ? (
            <div className="flex items-center justify-between gap-3">
              <Alert tone="success" className="flex-1">Password updated successfully.</Alert>
              <Button variant="ghost" size="sm" onClick={() => setPwDone(false)}>Done</Button>
            </div>
          ) : (
            <form onSubmit={handleChangePw} className="flex flex-col gap-3">
              <SectionHeader title="Change password" />
              <TextField type="password" value={pwCurrent} onChange={e => setPwCurrent(e.target.value)} placeholder="Current password" required />
              <TextField type="password" value={pwNew} onChange={e => setPwNew(e.target.value)} placeholder="New password" required minLength={6} />
              <TextField type="password" value={pwConfirm} onChange={e => setPwConfirm(e.target.value)} placeholder="Confirm new password" required minLength={6} />
              {pwError && <Alert tone="danger">{pwError}</Alert>}
              <Button type="submit" variant="primary" fullWidth loading={pwLoading} disabled={pwLoading}>Update password</Button>
            </form>
          )}
        </Card>

        {/* Sign out */}
        <Card surface={1} padding="md">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-label text-fg">Sign out</p>
              <p className="text-caption text-fg-3">End your session on this device.</p>
            </div>
            <Button variant="danger" size="sm" onClick={() => onSignOut()}>Sign out</Button>
          </div>
        </Card>

        {/* Debug: delete all templates (branding is kept) */}
        <Card surface={1} padding="md">
          <div className="flex flex-col gap-3">
            <SectionHeader title="Debug" />
            {delDone ? (
              <div className="flex items-center justify-between gap-3">
                <Alert tone="success" className="flex-1">All templates deleted. Reload to refresh the editors.</Alert>
                <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>Reload</Button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-label text-fg">Delete all my templates</p>
                    <p className="text-caption text-fg-3">Removes every carousel, reel, and post template (and their slides). Your branding, brand kit, logos, and fonts are kept.</p>
                  </div>
                  {!delConfirm && (
                    <Button variant="danger" size="sm" onClick={() => { setDelError(null); setDelConfirm(true); }}>Delete templates</Button>
                  )}
                </div>
                {delConfirm && (
                  <div className="flex items-center justify-between gap-3">
                    <Alert tone="danger" className="flex-1">This permanently deletes all your templates and cannot be undone.</Alert>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button variant="ghost" size="sm" onClick={() => setDelConfirm(false)} disabled={delLoading}>Cancel</Button>
                      <Button variant="danger" size="sm" loading={delLoading} disabled={delLoading} onClick={handleDeleteTemplates}>Yes, delete everything</Button>
                    </div>
                  </div>
                )}
                {delError && <Alert tone="danger">{delError}</Alert>}
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
