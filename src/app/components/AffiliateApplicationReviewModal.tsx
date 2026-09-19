'use client';

import { useState } from 'react';
import { authedFetch } from '@/lib/authedFetch';
import { Alert, Button, Modal, NumberField, Select, TextField } from '@/app/components/ui';
import { DURATION_OPTIONS, durationToMonths } from '@/app/components/AffiliatesSection';

// The "review a pending application, configure the deal, approve/reject" modal, split out of
// AffiliateApplicationsSection so each file holds one component.

export interface ReviewApplication {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  name: string;
  email: string;
  website: string;
  instagramHandle: string;
  tiktokHandle: string;
  youtubeHandle: string;
  twitterHandle: string;
  audienceSize: string;
  promotionPlan: string;
  rejectReason: string | null;
}

export function contactLine(a: ReviewApplication): string {
  const parts = [
    a.website,
    a.instagramHandle && `IG @${a.instagramHandle}`,
    a.tiktokHandle && `TikTok @${a.tiktokHandle}`,
    a.youtubeHandle && `YouTube @${a.youtubeHandle}`,
    a.twitterHandle && `X @${a.twitterHandle}`,
  ].filter(Boolean);
  return parts.join(' · ') || '—';
}

export function AffiliateApplicationReviewModal({ application: a, onClose, onDone }: { application: ReviewApplication; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState(a.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase());
  const [commissionPct, setCommissionPct] = useState(10);
  const [discountPct, setDiscountPct] = useState(50);
  const [discountDuration, setDiscountDuration] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = a.status === 'pending';

  async function approve() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/api/admin/affiliate-applications/${a.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, commissionPct, discountPct, discountDurationMonths: durationToMonths(discountDuration) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Could not approve.'); return; }
      onDone();
    } catch {
      setError('Could not approve.');
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (busy) return;
    const reason = window.prompt(`Reject ${a.name}'s application? Optional reason (shown to them):`, '');
    if (reason === null) return; // cancelled
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/api/admin/affiliate-applications/${a.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Could not reject.'); return; }
      onDone();
    } catch {
      setError('Could not reject.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open onClose={onClose} size="md"
      title={a.name}
      description={a.email}
      footer={pending ? (
        <>
          <Button variant="secondary" size="sm" onClick={reject} disabled={busy}>Reject</Button>
          <Button variant="primary" size="sm" onClick={approve} loading={busy} disabled={busy}>Approve</Button>
        </>
      ) : undefined}
    >
      <div className="flex flex-col gap-4 pb-2">
        <div className="flex flex-col gap-1 text-caption">
          <p><span className="text-fg-3">Website / handles: </span><span className="text-fg-2">{contactLine(a)}</span></p>
          <p><span className="text-fg-3">Audience: </span><span className="text-fg-2">{a.audienceSize || '—'}</span></p>
          {a.promotionPlan && <p><span className="text-fg-3">Promotion plan: </span><span className="text-fg-2">{a.promotionPlan}</span></p>}
          {a.status === 'rejected' && a.rejectReason && <p><span className="text-fg-3">Rejected: </span><span className="text-fg-2">{a.rejectReason}</span></p>}
        </div>

        {pending && (
          <>
            <TextField
              label="Referral code" value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              helper="3–20 letters/numbers; customers type this at checkout." required
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-label text-fg-2">Commission %</span>
                <NumberField label="Commission %" value={commissionPct} onChange={setCommissionPct} min={0} max={100} step={1} unit="%" />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-label text-fg-2">First-month discount %</span>
                <NumberField label="First-month discount %" value={discountPct} onChange={setDiscountPct} min={0} max={100} step={1} unit="%" />
              </div>
              <Select label="Discount duration" value={discountDuration} onChange={e => setDiscountDuration(e.target.value)} className="sm:col-span-2">
                {DURATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </div>
          </>
        )}

        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
