'use client';

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '@/lib/authedFetch';
import { Alert, Badge, BrandLoader, Button, Card, NumberField, SectionHeader, Select, Spinner, TextField } from '@/app/components/ui';

// Admin affiliates view: create an affiliate (invites their account + mints their Stripe promo code),
// list everyone with their referral count / lifetime earnings / unpaid balance, and mark an
// affiliate paid (manual payout). Talks only to /api/admin/affiliates via authedFetch.

interface Affiliate {
  id: string;
  name: string;
  email: string;
  code: string;
  commissionPct: number;
  discountPct: number;
  discountDurationMonths: number | null;
  active: boolean;
  userId: string | null;
  createdAt: string;
  referrals: number;
  earnedCents: number;
  unpaidCents: number;
  clawbackCents: number;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// Native <select> values are always strings — 'forever' maps to null months. Shared shape with
// AffiliateApplicationReviewModal's duration picker.
export const DURATION_OPTIONS = [
  { value: '1', label: '1 month' },
  { value: '3', label: '3 months' },
  { value: '6', label: '6 months' },
  { value: '12', label: '12 months' },
  { value: 'forever', label: 'Forever' },
];
export const durationToMonths = (v: string): number | null => (v === 'forever' ? null : Number(v));
export const monthsToDuration = (m: number | null): string => (m === null ? 'forever' : String(m));
export const formatDuration = (m: number | null): string => (m === null ? 'forever' : m === 1 ? '1 month' : `${m} months`);

export function AffiliatesSection() {
  const [affiliates, setAffiliates] = useState<Affiliate[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pct, setPct] = useState(10);
  const [discountPct, setDiscountPct] = useState(50);
  const [discountDuration, setDiscountDuration] = useState('1');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdNote, setCreatedNote] = useState<string | null>(null);

  const [payingId, setPayingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authedFetch('/api/admin/affiliates');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Could not load affiliates.'); return; }
      setError(null);
      setAffiliates(json.affiliates ?? []);
      setAsOf(json.asOf ?? null);
    } catch { setError('Could not load affiliates.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function createAffiliate(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    setCreatedNote(null);
    try {
      const res = await authedFetch('/api/admin/affiliates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, code, commissionPct: pct, discountPct, discountDurationMonths: durationToMonths(discountDuration) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setCreateError(json.error || 'Could not create affiliate.'); return; }
      setCreatedNote(`Created ${json.code}${json.invited ? ' — account invite sent.' : '.'}`);
      setName(''); setEmail(''); setCode(''); setPct(10); setDiscountPct(50); setDiscountDuration('1');
      await load();
    } catch {
      setCreateError('Could not create affiliate.');
    } finally {
      setCreating(false);
    }
  }

  async function payout(a: Affiliate) {
    if (payingId) return;
    if (!window.confirm(`Mark ${usd(a.unpaidCents)} to ${a.name} as paid? This only records that you've sent it.`)) return;
    setPayingId(a.id);
    try {
      const res = await authedFetch(`/api/admin/affiliates/${a.id}/payout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ before: asOf }), // only mark what was shown as of this load
      });
      if (res.ok) await load();
    } finally {
      setPayingId(null);
    }
  }

  async function copyCode(c: string) {
    try {
      await navigator.clipboard.writeText(c);
      setCopied(c);
      setTimeout(() => setCopied(x => (x === c ? null : x)), 1500);
    } catch { /* clipboard unavailable */ }
  }

  const totalUnpaid = (affiliates ?? []).reduce((s, a) => s + a.unpaidCents, 0);

  return (
    <div className="flex flex-col gap-6">
      {/* Create */}
      <Card surface={1} padding="md">
        <form onSubmit={createAffiliate} className="flex flex-col gap-3">
          <SectionHeader title="Add affiliate" />
          <p className="text-caption text-fg-3 -mt-1">
            Their code gives customers a first-month discount; they earn a recurring commission on every
            payment. Creating one invites a free account (for their dashboard) and mints the Stripe code.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <TextField label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="Pressi" required />
            <TextField label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="pressi@example.com" required />
            <TextField
              label="Referral code" value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="PRESSI50" helper="3–20 letters/numbers; customers type this at checkout." required
              containerClassName="sm:col-span-2"
            />
            <div className="flex flex-col gap-1">
              <span className="text-label text-fg-2">Commission %</span>
              <NumberField label="Commission %" value={pct} onChange={setPct} min={0} max={100} step={1} unit="%" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-label text-fg-2">First-month discount %</span>
              <NumberField label="First-month discount %" value={discountPct} onChange={setDiscountPct} min={0} max={100} step={1} unit="%" />
            </div>
            <Select label="Discount duration" value={discountDuration} onChange={e => setDiscountDuration(e.target.value)}>
              {DURATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </div>
          {createError && <Alert tone="danger">{createError}</Alert>}
          {createdNote && <Alert tone="success">{createdNote}</Alert>}
          <div>
            <Button type="submit" variant="primary" size="sm" loading={creating} disabled={creating}>Add affiliate</Button>
          </div>
        </form>
      </Card>

      {/* List */}
      <Card surface={1} padding="md">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <SectionHeader title={`Affiliates${affiliates ? ` (${affiliates.length})` : ''}`} />
            {totalUnpaid > 0 && <span className="text-caption text-fg-3">{usd(totalUnpaid)} unpaid total</span>}
          </div>
          {error && <Alert tone="danger">{error}</Alert>}

          {affiliates === null ? (
            <div className="grid place-items-center py-8"><BrandLoader size={36} /></div>
          ) : affiliates.length === 0 ? (
            <p className="text-caption text-fg-3 py-2">No affiliates yet — add one above.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-caption text-fg-3">
                    <th className="font-normal py-1.5 pr-4">Code</th>
                    <th className="font-normal py-1.5 pr-4">Affiliate</th>
                    <th className="font-normal py-1.5 pr-4">Commission</th>
                    <th className="font-normal py-1.5 pr-4">Discount</th>
                    <th className="font-normal py-1.5 pr-4">Referrals</th>
                    <th className="font-normal py-1.5 pr-4">Earned</th>
                    <th className="font-normal py-1.5 pr-4">Unpaid</th>
                    <th className="font-normal py-1.5">Payout</th>
                  </tr>
                </thead>
                <tbody>
                  {affiliates.map(a => (
                    <tr key={a.id} className="border-t border-line text-caption align-middle">
                      <td className="py-2 pr-4">
                        <button
                          type="button" onClick={() => copyCode(a.code)} title="Click to copy"
                          className="font-mono text-fg hover:text-fg focus-ring rounded-xs"
                        >
                          {a.code}{copied === a.code && <span className="text-fg-3 font-sans"> · copied</span>}
                        </button>
                        {!a.active && <span className="ml-2"><Badge tone="neutral">inactive</Badge></span>}
                      </td>
                      <td className="py-2 pr-4 text-fg-2 max-w-[200px] truncate">
                        {a.name} <span className="text-fg-4">· {a.email}</span>
                      </td>
                      <td className="py-2 pr-4 text-fg-2">{a.commissionPct}%</td>
                      <td className="py-2 pr-4 text-fg-2">{a.discountPct}% <span className="text-fg-4">· {formatDuration(a.discountDurationMonths)}</span></td>
                      <td className="py-2 pr-4 text-fg-2">{a.referrals}</td>
                      <td className="py-2 pr-4 text-fg-2">
                        {usd(a.earnedCents)}
                        {a.clawbackCents > 0 && <span className="block text-[10px] text-danger-text">−{usd(a.clawbackCents)} clawed back</span>}
                      </td>
                      <td className="py-2 pr-4 text-fg">{usd(a.unpaidCents)}</td>
                      <td className="py-2">
                        <Button
                          variant="secondary" size="sm"
                          disabled={a.unpaidCents <= 0 || payingId === a.id}
                          loading={payingId === a.id}
                          onClick={() => payout(a)}
                        >
                          {a.unpaidCents > 0 ? 'Mark paid' : 'Paid up'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {payingId && <div className="flex items-center gap-2 text-caption text-fg-3"><Spinner size="sm" /> Recording payout…</div>}
        </div>
      </Card>
    </div>
  );
}
