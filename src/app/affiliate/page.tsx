'use client';

import { useEffect, useState } from 'react';
import { LineChart, Line, CartesianGrid, XAxis, YAxis } from 'recharts';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/app/hooks/useAuth';
import { Badge, BrandLoader, Button, Card, SectionHeader, TextField } from '@/app/components/ui';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/app/components/ui/chart';
import { FeedForceLogo } from '@/app/components/Logo';

// Affiliate-facing dashboard. An affiliate signs in (the account created by their invite) and sees
// only their OWN referrals + earnings — enforced by owner-read RLS on the affiliate tables and the
// SECURITY INVOKER affiliate_self_stats()/affiliate_referred_users()/affiliate_monthly_revenue()
// RPCs. Not linked from the app; affiliates go to /affiliate.

interface Self { name: string; code: string; commissionPct: number; discountPct: number; active: boolean }
interface Stats { referrals: number; earnedCents: number; unpaidCents: number; paidCents: number; clawbackCents: number }
// Anonymized — no referred customer's name/email, just an ordinal by first-referred.
interface ReferredUser { ordinal: number; referredAt: string; status: string | null; renewsAt: string | null; revenueCents: number }
interface MonthlyRevenue { month: string; commissionCents: number }

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'N/A';
const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success', on_trial: 'success', past_due: 'warning', unpaid: 'warning', paused: 'warning', cancelled: 'neutral', expired: 'danger',
};

function Shell({ children, showLogo = true }: { children: React.ReactNode; showLogo?: boolean }) {
  return (
    <div className="min-h-screen bg-page text-fg flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-lg flex flex-col items-center gap-6">
        {showLogo && <FeedForceLogo className="h-8 w-auto" />}
        {children}
      </div>
    </div>
  );
}

export default function AffiliatePage() {
  const { user, loading: authLoading, signIn } = useAuth();
  // The async dashboard load result. 'loading'/'signin' are DERIVED at render from authLoading/user,
  // so nothing sets state synchronously in the effect below (which would cascade a render).
  const [loaded, setLoaded] = useState<'loading' | 'not-affiliate' | 'error' | 'ready'>('loading');
  const [self, setSelf] = useState<Self | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [referredUsers, setReferredUsers] = useState<ReferredUser[] | null>(null);
  const [monthlyRevenue, setMonthlyRevenue] = useState<MonthlyRevenue[] | null>(null);
  const [copied, setCopied] = useState(false);

  // Sign-in form
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;
    (async () => {
      const { data: a, error: aErr } = await supabase.from('affiliates').select('name,code,commission_pct,discount_pct,active').maybeSingle();
      if (cancelled) return;
      if (aErr) { setLoaded('error'); return; }          // transient failure ≠ "not an affiliate"
      if (!a) { setLoaded('not-affiliate'); return; }
      setSelf({
        name: a.name as string, code: a.code as string,
        commissionPct: a.commission_pct as number, discountPct: a.discount_pct as number,
        active: a.active as boolean,
      });
      const { data: s, error: sErr } = await supabase.rpc('affiliate_self_stats');
      if (cancelled) return;
      if (sErr) { setLoaded('error'); return; }
      const row = (Array.isArray(s) ? s[0] : s) as { referrals?: number; earned_cents?: number; unpaid_cents?: number; paid_cents?: number; clawback_cents?: number } | null;
      setStats({
        referrals: Number(row?.referrals ?? 0),
        earnedCents: Number(row?.earned_cents ?? 0),
        unpaidCents: Number(row?.unpaid_cents ?? 0),
        paidCents: Number(row?.paid_cents ?? 0),
        clawbackCents: Number(row?.clawback_cents ?? 0),
      });

      const { data: ru } = await supabase.rpc('affiliate_referred_users');
      if (!cancelled) {
        setReferredUsers(((ru ?? []) as Array<{ ordinal: number; referred_at: string; status: string | null; renews_at: string | null; revenue_cents: number }>).map(r => ({
          ordinal: r.ordinal, referredAt: r.referred_at, status: r.status, renewsAt: r.renews_at, revenueCents: Number(r.revenue_cents ?? 0),
        })));
      }

      const { data: mr } = await supabase.rpc('affiliate_monthly_revenue');
      if (!cancelled) {
        setMonthlyRevenue(((mr ?? []) as Array<{ month: string; commission_cents: number }>).map(m => ({
          month: m.month, commissionCents: Number(m.commission_cents ?? 0),
        })));
      }

      setLoaded('ready');
    })();
    return () => { cancelled = true; };
  }, [authLoading, user]);

  async function submitSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (signingIn) return;
    setSigningIn(true);
    setSignInError(null);
    const err = await signIn(email.trim(), password);
    setSigningIn(false);
    if (err) setSignInError(err); // on success, useAuth flips `user` and the effect loads the dashboard
  }

  async function copyCode(code: string) {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
  }

  if (authLoading) {
    return <Shell showLogo={false}><BrandLoader size={56} /></Shell>;
  }

  if (!user) {
    return (
      <Shell>
        <Card surface={1} padding="md" className="w-full">
          <form onSubmit={submitSignIn} className="flex flex-col gap-3">
            <h1 className="text-label font-semibold text-fg">Affiliate sign in</h1>
            <p className="text-caption text-fg-3 -mt-1">Sign in with the account from your affiliate invite.</p>
            <TextField label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            <TextField label="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
            {signInError && <p className="text-caption text-danger-text">{signInError}</p>}
            <Button type="submit" variant="primary" fullWidth loading={signingIn} disabled={signingIn}>Sign in</Button>
          </form>
        </Card>
      </Shell>
    );
  }

  if (loaded === 'not-affiliate') {
    return (
      <Shell>
        <Card surface={1} padding="md" className="w-full text-center">
          <p className="text-body text-fg-2">This account isn&apos;t an affiliate.</p>
          <p className="text-caption text-fg-3 mt-1">If you were invited to the program, sign in with the invited email.</p>
        </Card>
      </Shell>
    );
  }

  if (loaded === 'error') {
    return (
      <Shell>
        <Card surface={1} padding="md" className="w-full text-center">
          <p className="text-body text-fg-2">Couldn&apos;t load your dashboard.</p>
          <p className="text-caption text-fg-3 mt-1">Please refresh. If it keeps happening, get in touch.</p>
        </Card>
      </Shell>
    );
  }

  if (loaded !== 'ready') {
    return <Shell showLogo={false}><BrandLoader size={56} /></Shell>;
  }

  // ready
  return (
    <Shell>
      <div className="w-full flex flex-col gap-4">
        <div className="text-center">
          <h1 className="text-[20px] font-bold tracking-[-0.01em] text-fg">Affiliate dashboard</h1>
          <p className="text-caption text-fg-3">Hi {self?.name}, here&apos;s how your referrals are doing.</p>
        </div>

        <Card surface={1} padding="md" className="w-full">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-caption text-fg-3">Your code</p>
              <button
                type="button" onClick={() => self && copyCode(self.code)} title="Click to copy"
                className="font-mono text-[18px] font-bold text-fg hover:text-fg focus-ring rounded-xs"
              >
                {self?.code}{copied && <span className="text-fg-3 font-sans text-caption"> · copied</span>}
              </button>
            </div>
            <div className="text-right">
              <p className="text-caption text-fg-3">Your commission</p>
              <p className="text-[18px] font-bold text-fg">{self?.commissionPct}%</p>
            </div>
          </div>
          <p className="text-caption text-fg-3 mt-3">
            Share your code. Customers get {self?.discountPct}% off their first month, and you earn {self?.commissionPct}% of every
            payment they make.{!self?.active && ' (Your code is currently inactive.)'}
          </p>
        </Card>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Referrals', value: String(stats?.referrals ?? 0) },
            { label: 'Total earned', value: usd(stats?.earnedCents ?? 0) },
            { label: 'Pending payout', value: usd(stats?.unpaidCents ?? 0) },
            { label: 'Paid out', value: usd(stats?.paidCents ?? 0) },
          ].map(s => (
            <Card key={s.label} surface={1} padding="md">
              <p className="text-caption text-fg-3">{s.label}</p>
              <p className="text-[18px] font-bold text-fg tracking-[-0.01em]">{s.value}</p>
            </Card>
          ))}
        </div>
        <Card surface={1} padding="md" className="w-full">
          <SectionHeader title="Revenue by month" />
          <div className="h-48 mt-3">
            {monthlyRevenue === null ? (
              <div className="grid h-full place-items-center"><BrandLoader size={28} /></div>
            ) : monthlyRevenue.length === 0 ? (
              <div className="grid h-full place-items-center text-caption text-fg-3">No revenue yet</div>
            ) : (
              <ChartContainer config={{ value: { label: 'Revenue', color: 'var(--accent)' } } satisfies ChartConfig} className="h-full">
                <LineChart
                  data={monthlyRevenue.map(m => ({ month: m.month, value: m.commissionCents / 100 }))}
                  margin={{ left: 4, right: 8, top: 6, bottom: 0 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="month" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28}
                    tickFormatter={v => new Date(v).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })}
                  />
                  <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={v => `$${v}`} />
                  <ChartTooltip content={<ChartTooltipContent
                    labelFormatter={v => new Date(String(v)).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                    valueFormatter={v => `$${Number(v).toFixed(2)}`}
                  />} />
                  <Line dataKey="value" name="value" type="monotone" stroke="var(--color-value)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                </LineChart>
              </ChartContainer>
            )}
          </div>
        </Card>

        <Card surface={1} padding="md" className="w-full">
          <SectionHeader title="Your referrals" />
          <div className="mt-3">
            {referredUsers === null ? (
              <div className="grid place-items-center py-8"><BrandLoader size={28} /></div>
            ) : referredUsers.length === 0 ? (
              <p className="text-caption text-fg-3 py-2">No referrals yet. Share your code to get started.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-caption text-fg-3">
                      <th className="font-normal py-1.5 pr-4">Customer</th>
                      <th className="font-normal py-1.5 pr-4">Status</th>
                      <th className="font-normal py-1.5 pr-4">Revenue</th>
                      <th className="font-normal py-1.5">Next payment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {referredUsers.map(u => (
                      <tr key={u.ordinal} className="border-t border-line text-caption align-middle">
                        <td className="py-2 pr-4 text-fg-2">Customer {u.ordinal}</td>
                        <td className="py-2 pr-4">
                          {u.status ? <Badge tone={STATUS_TONE[u.status] ?? 'neutral'}>{u.status.replace('_', ' ')}</Badge> : <span className="text-fg-4">N/A</span>}
                        </td>
                        <td className="py-2 pr-4 text-fg-2">{usd(u.revenueCents)}</td>
                        <td className="py-2 text-fg-2">{fmtDate(u.renewsAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>

        {(stats?.clawbackCents ?? 0) > 0 && (
          <p className="text-caption text-fg-4 text-center">
            {usd(stats!.clawbackCents)} was reversed after payout (a refunded/disputed payment) and deducted from your balance.
          </p>
        )}

        <p className="text-caption text-fg-4 text-center">Payouts are sent manually. Reach out if you have questions.</p>
      </div>
    </Shell>
  );
}
