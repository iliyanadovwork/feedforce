'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { useAuth } from '@/app/hooks/useAuth';
import { grantsAccess } from '@/app/hooks/useSubscription';
import { authedFetch } from '@/lib/authedFetch';
import { Alert, BrandLoader, Button, Card, NumberField, SectionHeader, SegmentedControl, SelectableCard, Switch } from '@/app/components/ui';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/app/components/ui/chart';
import { FeedForceLogo } from '@/app/components/Logo';
import { SupportInboxSection } from '@/app/components/SupportInboxSection';
import { AffiliatesSection } from '@/app/components/AffiliatesSection';
import { AffiliateApplicationsSection } from '@/app/components/AffiliateApplicationsSection';
import { AdminRewardsSection } from '@/app/components/AdminRewardsSection';

type Provider = 'stripe' | 'lemonsqueezy';

interface BillingAdmin {
  provider: Provider;
  counts: Record<string, Record<string, number>>; // provider → status → n
  mrr: Record<string, number>;                    // provider → USD/month
  planPriceUsd: number;
}

// Actual revenue collected, queried live from Stripe — NOT the MRR run-rate estimate above.
interface MonthlyRevenue { month: string; revenueCents: number }
interface RevenueAdmin { monthly: MonthlyRevenue[]; thisMonthCents: number; totalCents: number }

interface AdminUser {
  id: string;
  email: string | null;
  signedUpAt: string | null;
  lastSignInAt: string | null;
  provider: string | null;
  status: string | null;
  planName: string | null;
  renewsAt: string | null;
  endsAt: string | null;
  aiSpentMicros: number;
  aiCalls: number;
}

// Site-wide launch offer (WELCOME50 — 50% off the first month) — see /api/admin/offer.
interface LaunchOffer {
  code: string;
  active: boolean;
  timesRedeemed: number;
}

// Single-use Stripe promotion code (first month free at checkout) — see /api/admin/promo-codes.
interface StripePromo {
  code: string;
  active: boolean;
  created: number;              // unix seconds
  timesRedeemed: number;
  maxRedemptions: number | null;
}

const PROVIDERS: Array<{ id: Provider; label: string; description: string }> = [
  { id: 'stripe', label: 'Stripe', description: 'New checkouts open Stripe Checkout.' },
  { id: 'lemonsqueezy', label: 'Lemon Squeezy', description: 'New checkouts open Lemon Squeezy (merchant of record — handles VAT).' },
];

// THE client access predicate (useSubscription.grantsAccess) — not a local mirror that could drift.
function isLive(status: string | null, endsAt: string | null): boolean {
  return !!status && grantsAccess({ status, ends_at: endsAt });
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const usd = (n: number) => `$${n.toFixed(2)}`;

const PROVIDER_LABEL: Record<string, string> = { stripe: 'Stripe', lemonsqueezy: 'Lemon Squeezy', redeem: 'Code' };

// Must match COMP_PLAN_NAME in /api/admin/users/[id]/comp.
const COMP_PLAN_NAME = 'Comp (admin-granted)';

// Operator panel (not linked from the app — go to /admin directly). Server-enforced via ADMIN_EMAILS;
// this page just renders what the /api/admin/* routes allow. Switching the billing provider ONLY
// affects new checkouts: existing subscribers keep billing on their original provider until they
// churn, which is why both providers' numbers stay visible side by side.
export default function AdminPage() {
  const { user, loading: authLoading } = useAuth();
  const [state, setState] = useState<'loading' | 'forbidden' | 'error' | 'ready'>('loading');
  const [billing, setBilling] = useState<BillingAdmin | null>(null);
  const [revenue, setRevenue] = useState<RevenueAdmin | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [aiBudgetMicros, setAiBudgetMicros] = useState(15_000_000);
  const [promoCodes, setPromoCodes] = useState<StripePromo[]>([]);
  const [offer, setOffer] = useState<LaunchOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'support' | 'affiliates' | 'applications' | 'rewards'>('overview');
  const [pendingApplications, setPendingApplications] = useState(0);

  // Needs-reply badge on the Support tab: open threads where the user spoke last. Polled every 15s
  // so the count stays honest while the operator sits on the Overview tab (SupportInboxSection has
  // its own 5s poll once the tab is open).
  const [needsReply, setNeedsReply] = useState(0);
  useEffect(() => {
    if (authLoading || !user || state !== 'ready') return;
    let cancelled = false;
    let stopped = false;   // flipped on 401/403 — authorization revoked mid-session, stop asking
    const poll = async () => {
      if (stopped) return;
      try {
        const res = await authedFetch('/api/support/inbox?count=1');
        if (res.status === 401 || res.status === 403) { stopped = true; return; }
        if (!res.ok) return;   // transient — keep the last count
        const json = await res.json().catch(() => null) as { needsReply?: number } | null;
        if (!cancelled && json) setNeedsReply(json.needsReply ?? 0);
      } catch { /* transient — keep the last count */ }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 15_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [authLoading, user, state]);

  const reloadUsers = useCallback(async () => {
    const res = await authedFetch('/api/admin/users');
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      setUsers((json.users ?? []).sort((a: AdminUser, b: AdminUser) => (b.signedUpAt ?? '').localeCompare(a.signedUpAt ?? '')));
    }
  }, []);

  const loadAll = useCallback(async () => {
    const [billingRes, usersRes, promoRes, offerRes, applicationsRes, revenueRes] = await Promise.all([
      authedFetch('/api/admin/billing'),
      authedFetch('/api/admin/users'),
      authedFetch('/api/admin/promo-codes'),
      authedFetch('/api/admin/offer'),
      authedFetch('/api/admin/affiliate-applications'),
      authedFetch('/api/admin/revenue'),
    ]);
    if (billingRes.status === 403 || billingRes.status === 401) { setState('forbidden'); return; }
    const [billingJson, usersJson, promoJson, offerJson, applicationsJson, revenueJson] = await Promise.all([
      billingRes.json().catch(() => ({})), usersRes.json().catch(() => ({})),
      promoRes.json().catch(() => ({})), offerRes.json().catch(() => ({})),
      applicationsRes.json().catch(() => ({})),
      revenueRes.json().catch(() => ({})),
    ]);
    setBilling(billingRes.ok ? billingJson : null);
    setUsers((usersJson.users ?? []).sort((a: AdminUser, b: AdminUser) => (b.signedUpAt ?? '').localeCompare(a.signedUpAt ?? '')));
    if (usersJson.aiBudgetMicros) setAiBudgetMicros(usersJson.aiBudgetMicros);
    setPromoCodes(promoRes.ok ? (promoJson.codes ?? []) : []);   // best-effort: Stripe may be unconfigured
    setOffer(offerRes.ok ? (offerJson.offer ?? null) : null);    // same best-effort
    if (applicationsRes.ok) setPendingApplications(applicationsJson.pendingCount ?? 0); // best-effort
    setRevenue(revenueRes.ok ? revenueJson : null);               // same best-effort
    // Core data failing (billing/users 5xx) still renders the panel, but says so instead of
    // silently showing zeros and an empty user table.
    const failed = [!billingRes.ok && 'billing overview', !usersRes.ok && 'user list'].filter(Boolean);
    if (failed.length > 0) setError(`Failed to load the ${failed.join(' and ')} — refresh to retry.`);
    setState('ready');
  }, []);

  useEffect(() => {
    if (authLoading || !user) return;
    // A network failure is NOT "you're not an admin" — that verdict only comes from a 401/403
    // above. Anything thrown here (fetch failure, JSON parse) gets its own retryable state.
    loadAll().catch(() => setState('error'));
  }, [authLoading, user, loadAll]);

  // ── Provider switch ────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  async function switchProvider(provider: Provider) {
    if (!billing || provider === billing.provider || saving) return;
    setSaving(true);
    setError(null);
    const prev = billing;
    setBilling({ ...billing, provider }); // optimistic
    try {
      const res = await authedFetch('/api/admin/billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: 'Save failed' }));
        throw new Error(msg || 'Save failed');
      }
    } catch (e) {
      setBilling(prev);
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const [copied, setCopied] = useState<string | null>(null);
  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied(c => (c === code ? null : c)), 1500);
    } catch { /* clipboard unavailable */ }
  }

  // ── Launch offer toggle (WELCOME50 — 50% off first month, works for everyone) ─
  const [offerSaving, setOfferSaving] = useState(false);
  async function toggleOffer(active: boolean) {
    if (offerSaving) return;
    setOfferSaving(true);
    setError(null);
    try {
      const res = await authedFetch('/api/admin/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Save failed');
      setOffer(json.offer ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setOfferSaving(false);
    }
  }

  // ── Per-user comp toggle (free access without paying, no ends_at — revoke any time) ─
  const [compSaving, setCompSaving] = useState<Set<string>>(new Set());
  async function toggleComp(userId: string, active: boolean) {
    if (compSaving.has(userId)) return;
    setCompSaving(prev => new Set(prev).add(userId));
    setError(null);
    try {
      const res = await authedFetch(`/api/admin/users/${userId}/comp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Save failed');
      await reloadUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setCompSaving(prev => { const next = new Set(prev); next.delete(userId); return next; });
    }
  }

  // ── Stripe promo-code generation (single-use, first month free at checkout) ─
  const [promoGenCount, setPromoGenCount] = useState(5);
  const [promoGenLoading, setPromoGenLoading] = useState(false);
  async function generatePromoCodes() {
    if (promoGenLoading) return;
    setPromoGenLoading(true);
    setError(null);
    try {
      const res = await authedFetch('/api/admin/promo-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: promoGenCount }),
      });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: 'Generation failed' }));
        throw new Error(msg || 'Generation failed');
      }
      const listRes = await authedFetch('/api/admin/promo-codes');
      setPromoCodes((await listRes.json()).codes ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setPromoGenLoading(false);
    }
  }

  if (authLoading || (user && state === 'loading')) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-page text-fg">
        <BrandLoader size={64} />
      </div>
    );
  }

  if (!user || state === 'forbidden' || state === 'error') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-page text-fg gap-4 px-4 text-center">
        <FeedForceLogo className="h-9 w-auto" />
        <p className="text-body text-fg-3">
          {!user
            ? 'Sign in to the app first, then open /admin again.'
            : state === 'error'
              ? 'Could not load the admin panel — check your connection.'
              : 'This account is not an admin.'}
        </p>
        {user && state === 'error' && (
          <Button variant="primary" size="sm" onClick={() => { setState('loading'); loadAll().catch(() => setState('error')); }}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  const liveByProvider = (p: string) => users.filter(u => u.provider === p && isLive(u.status, u.endsAt)).length;
  const totalMrr = (billing?.mrr?.stripe ?? 0) + (billing?.mrr?.lemonsqueezy ?? 0);
  // Live subscription AND an actual upcoming charge (excludes comp/free accounts, which have no
  // renewsAt, and cancelled-but-not-yet-ended ones, which won't bill again).
  const activeSubscribers = users
    .filter(u => isLive(u.status, u.endsAt) && u.renewsAt)
    .sort((a, b) => (a.renewsAt ?? '').localeCompare(b.renewsAt ?? ''));

  return (
    <div className="flex flex-col items-center min-h-screen bg-page text-fg py-16 px-4">
      <div className="w-full max-w-4xl flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[20px] leading-tight font-bold tracking-[-0.01em] text-fg mb-1">Admin</h1>
            <p className="text-body text-fg-3">Operator controls — users never see this page.</p>
          </div>
          <SegmentedControl
            ariaLabel="Admin section"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'overview', label: 'Overview' },
              { value: 'support', label: needsReply > 0 ? `Support inbox (${needsReply})` : 'Support inbox' },
              { value: 'affiliates', label: 'Affiliates' },
              { value: 'applications', label: pendingApplications > 0 ? `Applications (${pendingApplications})` : 'Applications' },
              { value: 'rewards', label: 'Rewards' },
            ]}
          />
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        {tab === 'support' && <SupportInboxSection onNeedsReplyChange={setNeedsReply} />}

        {tab === 'affiliates' && <AffiliatesSection />}

        {tab === 'applications' && <AffiliateApplicationsSection onCountChange={setPendingApplications} />}

        {tab === 'rewards' && <AdminRewardsSection />}

        {tab === 'overview' && <>

        {/* Actual revenue — real money collected, queried live from Stripe (no local ledger),
            distinct from the MRR run-rate estimate below. A subscriber on a free/discounted promo
            month shows $0 here even though they still count toward MRR (they're an active
            subscription, just not one that paid anything that month). */}
        <Card surface={1} padding="md">
          <div className="flex flex-col gap-3">
            <SectionHeader title="Actual revenue" />
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-caption text-fg-3">This month</p>
                <p className="text-[18px] font-bold text-fg tracking-[-0.01em]">{usd((revenue?.thisMonthCents ?? 0) / 100)}</p>
              </div>
              <div>
                <p className="text-caption text-fg-3">Total revenue</p>
                <p className="text-[18px] font-bold text-fg tracking-[-0.01em]">{usd((revenue?.totalCents ?? 0) / 100)}</p>
              </div>
            </div>
            <div className="h-56">
              {revenue === null ? (
                <div className="grid h-full place-items-center"><BrandLoader size={28} /></div>
              ) : revenue.monthly.length === 0 ? (
                <div className="grid h-full place-items-center text-caption text-fg-3">No revenue recorded yet</div>
              ) : (
                <ChartContainer config={{ value: { label: 'Revenue', color: 'var(--accent)' } } satisfies ChartConfig} className="h-full">
                  <BarChart data={revenue.monthly.map(m => ({ month: m.month, value: m.revenueCents / 100 }))} margin={{ left: 4, right: 8, top: 6, bottom: 0 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="month" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28}
                      tickFormatter={v => new Date(v).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })}
                    />
                    <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={v => `$${v}`} />
                    <ChartTooltip content={<ChartTooltipContent
                      labelFormatter={v => new Date(String(v)).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                      valueFormatter={v => `$${Number(v).toFixed(2)}`}
                    />} />
                    <Bar dataKey="value" name="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ChartContainer>
              )}
            </div>
            <p className="text-caption text-fg-3">
              Actual payments collected, from Stripe (a $0 promo-code month records as $0, not a full charge).
            </p>
          </div>
        </Card>

        {/* Recurring revenue (MRR) — a run-rate ESTIMATE from currently-active subscription prices,
            not real money collected (see Actual revenue above for that). */}
        <Card surface={1} padding="md">
          <div className="flex flex-col gap-3">
            <SectionHeader title="Recurring revenue (MRR)" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: 'MRR', value: usd(totalMrr) },
                { label: 'Stripe MRR', value: usd(billing?.mrr?.stripe ?? 0) },
                { label: 'Lemon Squeezy MRR', value: usd(billing?.mrr?.lemonsqueezy ?? 0) },
                { label: 'Free (codes)', value: String(liveByProvider('redeem')) },
              ].map(s => (
                <div key={s.label}>
                  <p className="text-caption text-fg-3">{s.label}</p>
                  <p className="text-[18px] font-bold text-fg tracking-[-0.01em]">{s.value}</p>
                </div>
              ))}
            </div>
            <p className="text-caption text-fg-3">
              MRR counts subscribers who will bill again (active, not scheduled to cancel) at {usd(billing?.planPriceUsd ?? 59.99)}/month.
            </p>
          </div>
        </Card>

        {/* Billing provider switch */}
        <Card surface={1} padding="md">
          <div className="flex flex-col gap-4">
            <SectionHeader title="Billing provider" />
            <p className="text-caption text-fg-3 -mt-2">
              Where NEW subscriptions are created. Existing subscribers are untouched: they keep billing
              through the provider they signed up with (both webhooks stay active) until they cancel.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" role="radiogroup" aria-label="Billing provider">
              {PROVIDERS.map(p => (
                <SelectableCard
                  key={p.id}
                  selected={billing?.provider === p.id}
                  onClick={() => switchProvider(p.id)}
                  label={p.label}
                  description={p.description}
                >
                  <span className="px-3 pt-3 text-caption text-fg-3">
                    {liveByProvider(p.id)} live subscriber{liveByProvider(p.id) === 1 ? '' : 's'} · {usd(billing?.mrr?.[p.id] ?? 0)}/mo
                  </span>
                </SelectableCard>
              ))}
            </div>
          </div>
        </Card>

        {/* Active subscribers — who's actually paying and when they're charged next. Pulled out of the
            full Users table below since this is the number that matters day-to-day (retention/MRR
            forecasting), not buried among free/comp/no-subscription accounts. */}
        <Card surface={1} padding="md">
          <div className="flex flex-col gap-3">
            <SectionHeader title={`Active subscribers (${activeSubscribers.length})`} />
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-caption text-fg-3">
                    <th className="font-normal py-1.5 pr-4">Email</th>
                    <th className="font-normal py-1.5 pr-4">Plan</th>
                    <th className="font-normal py-1.5">Next payment</th>
                  </tr>
                </thead>
                <tbody>
                  {activeSubscribers.map(u => (
                    <tr key={u.id} className="border-t border-line text-caption">
                      <td className="py-2 pr-4 text-fg max-w-[220px] truncate">{u.email ?? u.id}</td>
                      <td className="py-2 pr-4 text-fg-2">
                        {u.provider ? `${PROVIDER_LABEL[u.provider] ?? u.provider}${u.planName ? ` · ${u.planName}` : ''}` : '—'}
                      </td>
                      <td className="py-2 text-fg-2 whitespace-nowrap">{fmtDate(u.renewsAt)}</td>
                    </tr>
                  ))}
                  {activeSubscribers.length === 0 && (
                    <tr><td colSpan={3} className="py-3 text-caption text-fg-3">No active subscribers yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </Card>

        {/* Users */}
        <Card surface={1} padding="md">
          <div className="flex flex-col gap-3">
            <SectionHeader title={`Users (${users.length})`} />
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-caption text-fg-3">
                    <th className="font-normal py-1.5 pr-4">Email</th>
                    <th className="font-normal py-1.5 pr-4">Plan</th>
                    <th className="font-normal py-1.5 pr-4">Status</th>
                    <th className="font-normal py-1.5 pr-4">Next payment / ends</th>
                    <th className="font-normal py-1.5 pr-4">AI credits</th>
                    <th className="font-normal py-1.5 pr-4">Signed up</th>
                    <th className="font-normal py-1.5">Comp</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => {
                    const aiPct = Math.min(100, (u.aiSpentMicros / aiBudgetMicros) * 100);
                    const isComp = u.provider === 'redeem' && u.planName === COMP_PLAN_NAME;
                    return (
                      <tr key={u.id} className="border-t border-line text-caption">
                        <td className="py-2 pr-4 text-fg max-w-[220px] truncate">{u.email ?? u.id}</td>
                        <td className="py-2 pr-4 text-fg-2">
                          {u.provider ? `${PROVIDER_LABEL[u.provider] ?? u.provider}${u.planName ? ` · ${u.planName}` : ''}` : '—'}
                        </td>
                        <td className="py-2 pr-4">
                          <span className={isLive(u.status, u.endsAt) ? 'text-fg' : 'text-fg-3'}>
                            {u.status ? u.status.replace(/_/g, ' ') : 'no subscription'}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-fg-2">
                          {u.endsAt ? `ends ${fmtDate(u.endsAt)}` : u.renewsAt ? fmtDate(u.renewsAt) : '—'}
                        </td>
                        <td className="py-2 pr-4 text-fg-2 whitespace-nowrap">
                          {u.aiCalls > 0 ? `${Math.round(aiPct)}% · ${u.aiCalls} calls` : '—'}
                        </td>
                        <td className="py-2 pr-4 text-fg-3 whitespace-nowrap">{fmtDate(u.signedUpAt)}</td>
                        <td className="py-2">
                          <Switch
                            checked={isComp}
                            onChange={active => toggleComp(u.id, active)}
                            disabled={compSaving.has(u.id)}
                            label={`Comp access for ${u.email ?? u.id}`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                  {users.length === 0 && (
                    <tr><td colSpan={7} className="py-3 text-caption text-fg-3">No users yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </Card>

        {/* Launch offer — one shareable code, 50% off the first month */}
        <Card surface={1} padding="md">
          <div className="flex flex-col gap-3">
            <SectionHeader title="Launch offer — 50% off first month" />
            <p className="text-caption text-fg-3 -mt-1">
              One shareable Stripe code with unlimited redemptions: every new subscriber who enters it
              at checkout pays half price for month one, then bills normally. Deactivating stops new
              redemptions instantly; anyone who already redeemed keeps their discount. Stripe checkout only.
            </p>
            {offer ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Switch
                    checked={offer.active}
                    onChange={toggleOffer}
                    label="Launch offer active"
                    disabled={offerSaving}
                  />
                  <button
                    type="button"
                    onClick={() => copyCode(offer.code)}
                    className="font-mono text-caption text-fg hover:text-fg focus-ring rounded-xs"
                    title="Click to copy"
                  >
                    {offer.code}{copied === offer.code && <span className="text-fg-3 font-sans"> · copied</span>}
                  </button>
                </div>
                <span className="text-caption text-fg-3">
                  {offer.active ? 'active' : 'inactive'} · redeemed {offer.timesRedeemed} time{offer.timesRedeemed === 1 ? '' : 's'}
                </span>
              </div>
            ) : (
              <p className="text-caption text-fg-3">Unavailable — Stripe is not configured.</p>
            )}
          </div>
        </Card>

        {/* Stripe promo codes — single-use, first month free at checkout */}
        <Card surface={1} padding="md">
          <div className="flex flex-col gap-3">
            <SectionHeader title="Stripe promo codes" />
            <p className="text-caption text-fg-3 -mt-1">
              Single-use codes entered on the Stripe checkout page: the subscriber pays $0 for the first
              month (card on file), then bills normally from month two. Each code dies after one redemption.
            </p>
            <div className="flex items-center gap-2">
              <NumberField value={promoGenCount} onChange={v => setPromoGenCount(Math.min(20, Math.max(1, Math.round(v || 1))))} min={1} max={20} className="w-20" />
              <Button variant="primary" size="sm" loading={promoGenLoading} disabled={promoGenLoading} onClick={generatePromoCodes}>
                Generate promo codes
              </Button>
            </div>
            {promoCodes.length > 0 && (
              <div className="flex flex-col divide-y divide-line">
                {promoCodes.map(p => {
                  const used = p.timesRedeemed >= (p.maxRedemptions ?? 1) || !p.active;
                  return (
                    <div key={p.code} className="flex items-center justify-between gap-3 py-2">
                      <button
                        type="button"
                        onClick={() => copyCode(p.code)}
                        className="font-mono text-caption text-fg hover:text-fg focus-ring rounded-xs text-left"
                        title="Click to copy"
                      >
                        {p.code}{copied === p.code && <span className="text-fg-3 font-sans"> · copied</span>}
                      </button>
                      <span className="text-caption text-fg-3 text-right">
                        {used ? 'redeemed' : `unused · created ${fmtDate(new Date(p.created * 1000).toISOString())}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        </>}
      </div>
    </div>
  );
}
