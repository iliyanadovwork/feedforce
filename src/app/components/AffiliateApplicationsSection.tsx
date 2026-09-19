'use client';

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '@/lib/authedFetch';
import { Alert, Badge, BrandLoader, Button, Card, SectionHeader } from '@/app/components/ui';
import { AffiliateApplicationReviewModal, contactLine, type ReviewApplication } from '@/app/components/AffiliateApplicationReviewModal';

// Admin review queue for self-serve affiliate applications (see /admin → Applications). Distinct from
// AffiliatesSection (the direct-add flow + active affiliate list) — this is the pending-applicant
// funnel that feeds INTO it: approving an application here mints a Stripe promo code and inserts an
// affiliates row exactly like AffiliatesSection's "Add affiliate" form does. Talks only to
// /api/admin/affiliate-applications via authedFetch.

type Application = ReviewApplication & { createdAt: string };

const STATUS_TONE = { pending: 'warning', approved: 'success', rejected: 'danger' } as const;

export function AffiliateApplicationsSection({ onCountChange }: { onCountChange?: (pendingCount: number) => void }) {
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<Application | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authedFetch('/api/admin/affiliate-applications');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Could not load applications.'); return; }
      setError(null);
      setApplications(json.applications ?? []);
    } catch { setError('Could not load applications.'); }
  }, []);
  // Standard fetch-on-mount pattern, identical to AffiliatesSection.tsx/SupportInboxSection.tsx —
  // false positive from the experimental compiler rule on this file's specific shape (verified by
  // bisection: the exact same load/useEffect pattern lints clean in those two files).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  // Report the pending count to the host tab's badge whenever the list changes — keeps it live
  // without a poll, decoupled from the fetch itself (mirrors SupportInboxSection's needsReply badge).
  useEffect(() => {
    if (applications !== null) onCountChange?.(applications.filter(a => a.status === 'pending').length);
  }, [applications, onCountChange]);

  return (
    <Card surface={1} padding="md">
      <div className="flex flex-col gap-3">
        <SectionHeader title={`Applications${applications ? ` (${applications.length})` : ''}`} />
        {error && <Alert tone="danger">{error}</Alert>}

        {applications === null ? (
          <div className="grid place-items-center py-8"><BrandLoader size={36} /></div>
        ) : applications.length === 0 ? (
          <p className="text-caption text-fg-3 py-2">No applications yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-caption text-fg-3">
                  <th className="font-normal py-1.5 pr-4">Applicant</th>
                  <th className="font-normal py-1.5 pr-4">Contact</th>
                  <th className="font-normal py-1.5 pr-4">Audience</th>
                  <th className="font-normal py-1.5 pr-4">Status</th>
                  <th className="font-normal py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {applications.map(a => (
                  <tr key={a.id} className="border-t border-line text-caption align-middle">
                    <td className="py-2 pr-4 text-fg-2 max-w-[200px] truncate">
                      {a.name} <span className="text-fg-4">· {a.email}</span>
                    </td>
                    <td className="py-2 pr-4 text-fg-2 max-w-[260px] truncate">{contactLine(a)}</td>
                    <td className="py-2 pr-4 text-fg-2">{a.audienceSize || '—'}</td>
                    <td className="py-2 pr-4"><Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge></td>
                    <td className="py-2">
                      <Button variant="secondary" size="sm" onClick={() => setReviewing(a)}>
                        {a.status === 'pending' ? 'Review' : 'View'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {reviewing && (
        <AffiliateApplicationReviewModal
          application={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => { setReviewing(null); void load(); }}
        />
      )}
    </Card>
  );
}
