'use client';

import { useCallback, useEffect, useState } from 'react';
import { authedFetch } from '@/lib/authedFetch';
import { Alert, Badge, BrandLoader, Button, Card, SectionHeader, TextField } from '@/app/components/ui';

// Admin rewards view: pick a month, see its pool + full leaderboard + enrollments + tracked sticker
// posts, finalize a closed month into rewards_payouts, and mark each payout paid after the manual
// PayPal transfer. Talks only to /api/admin/rewards via authedFetch.

interface RewardsPool { revenueCents: number; poolCents: number; computedAt: string; cached: boolean }
interface Standing { userId: string; email: string | null; views: number; rank: number; tier: 'top' | 'rest'; amountCents: number; paypalEmail: string }
interface Enrollment { userId: string; email: string | null; paypalEmail: string; createdAt: string }
interface RewardsPost { userId: string; email: string | null; zernioPostId: string; stickerEnabled: boolean; viewsTotal: number; viewsSyncedAt: string | null; removedAt: string | null; createdAt: string }
interface Payout { id: string; month: string; user_id: string; views: number; tier: 'top' | 'rest'; pool_cents: number; amount_cents: number; paypal_email: string; paid_at: string | null }

interface RewardsAdmin { month: string; pool: RewardsPool | null; poolError?: string; standings: Standing[]; enrollments: Enrollment[]; posts: RewardsPost[]; payouts: Payout[] }

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const fmtViews = (n: number) => n.toLocaleString();
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const currentMonthKey = () => new Date().toISOString().slice(0, 7);

export function AdminRewardsSection() {
  const [month, setMonth] = useState(currentMonthKey());
  const [data, setData] = useState<RewardsAdmin | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Finalize returns `warnings` (already-paid drift, an exhausted pool, rows left untouched). They
  // describe real money and were previously discarded by this caller, so nothing surfaced them at all.
  const [warnings, setWarnings] = useState<string[]>([]);

  const load = useCallback(async (m: string) => {
    setData(null);
    setWarnings([]); // a previous month's finalize warnings must not linger over new data
    try {
      const res = await authedFetch(`/api/admin/rewards?month=${encodeURIComponent(m)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Could not load rewards.'); return; }
      setError(null);
      setData(json);
    } catch { setError('Could not load rewards.'); }
  }, []);
  useEffect(() => { void load(month); }, [month, load]);

  // ── Finalize month → rewards_payouts (idempotent server-side) ──────────────
  const [finalizing, setFinalizing] = useState(false);
  // Mirrors the server's rule exactly: finalizable only from the 2nd of the FOLLOWING month (UTC) —
  // the month-end baselines are written by the next month's first cron run, so the 1st is too early.
  const canFinalize = (() => {
    const [y, m] = month.split('-').map(Number);
    return Number.isFinite(y) && Number.isFinite(m) && Date.now() >= Date.UTC(y, m, 2);
  })();
  async function finalize() {
    if (finalizing || !canFinalize) return;
    if (!window.confirm(`Finalize ${month}? This computes the pool fresh and writes the payout rows.`)) return;
    setFinalizing(true);
    setError(null);
    try {
      const res = await authedFetch('/api/admin/rewards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'finalize', month }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Finalize failed.'); return; }
      await load(month);
      // AFTER load: it resets warnings for the incoming month, which would otherwise wipe these.
      setWarnings(Array.isArray(json.warnings) ? json.warnings : []);
    } catch {
      setError('Finalize failed.');
    } finally {
      setFinalizing(false);
    }
  }

  // ── Mark a payout row paid (after the manual PayPal transfer) ──────────────
  const [payingId, setPayingId] = useState<string | null>(null);
  async function markPaid(p: Payout) {
    if (payingId) return;
    if (!window.confirm(`Mark ${usd(p.amount_cents)} to ${p.paypal_email} as paid? This only records that you've sent it.`)) return;
    setPayingId(p.id);
    setError(null);
    try {
      const res = await authedFetch('/api/admin/rewards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_paid', payoutId: p.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Could not mark paid.'); return; }
      await load(month);
    } catch {
      setError('Could not mark paid.');
    } finally {
      setPayingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Month + pool */}
      <Card surface={1} padding="md">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <SectionHeader title="Rewards pool" />
            <TextField
              label="Month"
              type="month"
              value={month}
              onChange={e => { if (e.target.value) setMonth(e.target.value); }}
              max={currentMonthKey()}
              className="w-44"
            />
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          {warnings.length > 0 && (
            <Alert tone="warning">
              <span className="font-semibold">Finalize completed with warnings</span>
              <ul className="mt-1 list-disc pl-4 flex flex-col gap-0.5">
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </Alert>
          )}
          {data === null ? (
            <div className="grid place-items-center py-8"><BrandLoader size={36} /></div>
          ) : (
            <>
              {data.pool === null ? (
                <Alert tone="danger">
                  Pool unavailable{data.poolError ? ` (${data.poolError})` : ''}. Leaderboard amounts below assume a $0 pool.
                </Alert>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  <div>
                    <p className="text-caption text-fg-3">Revenue ({data.month})</p>
                    <p className="text-[18px] font-bold text-fg tracking-[-0.01em]">{usd(data.pool.revenueCents)}</p>
                  </div>
                  <div>
                    <p className="text-caption text-fg-3">Pool (50%)</p>
                    <p className="text-[18px] font-bold text-fg tracking-[-0.01em]">{usd(data.pool.poolCents)}</p>
                  </div>
                  <div>
                    <p className="text-caption text-fg-3">Computed</p>
                    <p className="text-[18px] font-bold text-fg tracking-[-0.01em]">
                      {new Date(data.pool.computedAt).toLocaleTimeString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      {data.pool.cached && <span className="ml-2 align-middle"><Badge tone="neutral">cached</Badge></span>}
                    </p>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-caption text-fg-3">Stripe only. Lemon Squeezy revenue is not included.</p>
                <Button
                  variant="primary" size="sm"
                  disabled={!canFinalize || finalizing}
                  loading={finalizing}
                  onClick={finalize}
                  title={canFinalize ? undefined : 'Finalize from the 2nd of the following month (UTC)'}
                >
                  Finalize month
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>

      {data !== null && (
        <>
          {/* Payouts (only after finalize) */}
          {data.payouts.length > 0 && (
            <Card surface={1} padding="md">
              <div className="flex flex-col gap-3">
                <SectionHeader title={`Payouts (${data.payouts.length})`} />
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-caption text-fg-3">
                        <th className="font-normal py-1.5 pr-4">PayPal</th>
                        <th className="font-normal py-1.5 pr-4">Views</th>
                        <th className="font-normal py-1.5 pr-4">Amount</th>
                        <th className="font-normal py-1.5">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.payouts.map(p => (
                        <tr key={p.id} className="border-t border-line text-caption align-middle">
                          <td className="py-2 pr-4 text-fg max-w-[220px] truncate">{p.paypal_email}</td>
                          <td className="py-2 pr-4 text-fg-2">{fmtViews(p.views)}</td>
                          <td className="py-2 pr-4 text-fg">{usd(p.amount_cents)}</td>
                          <td className="py-2">
                            {p.paid_at ? (
                              <span className="text-fg-3">paid {fmtDate(p.paid_at)}</span>
                            ) : (
                              <Button variant="secondary" size="sm" loading={payingId === p.id} disabled={payingId === p.id} onClick={() => markPaid(p)}>
                                Mark paid
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </Card>
          )}

          {/* Leaderboard */}
          <Card surface={1} padding="md">
            <div className="flex flex-col gap-3">
              <SectionHeader title={`Leaderboard (${data.standings.length})`} />
              {data.standings.length === 0 ? (
                <p className="text-caption text-fg-3 py-2">Nobody has qualified views this month.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-caption text-fg-3">
                        <th className="font-normal py-1.5 pr-4">#</th>
                        <th className="font-normal py-1.5 pr-4">Email</th>
                        <th className="font-normal py-1.5 pr-4">Views</th>
                        <th className="font-normal py-1.5 pr-4">Amount</th>
                        <th className="font-normal py-1.5">PayPal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.standings.map(s => (
                        <tr key={s.userId} className="border-t border-line text-caption">
                          <td className="py-2 pr-4 text-fg-2">{s.rank}</td>
                          <td className="py-2 pr-4 text-fg max-w-[220px] truncate">{s.email ?? s.userId}</td>
                          <td className="py-2 pr-4 text-fg-2">{fmtViews(s.views)}</td>
                          <td className="py-2 pr-4 text-fg">{usd(s.amountCents)}</td>
                          <td className="py-2 text-fg-2 max-w-[200px] truncate">{s.paypalEmail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>

          {/* Enrollments */}
          <Card surface={1} padding="md">
            <div className="flex flex-col gap-3">
              <SectionHeader title={`Enrollments (${data.enrollments.length})`} />
              {data.enrollments.length === 0 ? (
                <p className="text-caption text-fg-3 py-2">Nobody has joined the program yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-caption text-fg-3">
                        <th className="font-normal py-1.5 pr-4">Email</th>
                        <th className="font-normal py-1.5 pr-4">PayPal</th>
                        <th className="font-normal py-1.5">Joined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.enrollments.map(e => (
                        <tr key={e.userId} className="border-t border-line text-caption">
                          <td className="py-2 pr-4 text-fg max-w-[220px] truncate">{e.email ?? e.userId}</td>
                          <td className="py-2 pr-4 text-fg-2 max-w-[200px] truncate">{e.paypalEmail}</td>
                          <td className="py-2 text-fg-3 whitespace-nowrap">{fmtDate(e.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>

          {/* Tracked sticker posts */}
          <Card surface={1} padding="md">
            <div className="flex flex-col gap-3">
              <SectionHeader title={`Sticker posts (${data.posts.length})`} />
              {data.posts.length === 0 ? (
                <p className="text-caption text-fg-3 py-2">No sticker reels published yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="text-caption text-fg-3">
                        <th className="font-normal py-1.5 pr-4">Email</th>
                        <th className="font-normal py-1.5 pr-4">Post</th>
                        <th className="font-normal py-1.5 pr-4">Views</th>
                        <th className="font-normal py-1.5 pr-4">Synced</th>
                        <th className="font-normal py-1.5">Published</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.posts.map(p => (
                        <tr key={p.zernioPostId} className="border-t border-line text-caption">
                          <td className="py-2 pr-4 text-fg max-w-[200px] truncate">{p.email ?? p.userId}</td>
                          <td className="py-2 pr-4 text-fg-2 font-mono max-w-[160px] truncate">
                            {p.zernioPostId}
                            {p.removedAt && <span className="ml-2 font-sans"><Badge tone="neutral">removed</Badge></span>}
                          </td>
                          <td className="py-2 pr-4 text-fg-2">{fmtViews(p.viewsTotal)}</td>
                          <td className="py-2 pr-4 text-fg-3 whitespace-nowrap">{fmtDate(p.viewsSyncedAt)}</td>
                          <td className="py-2 text-fg-3 whitespace-nowrap">{fmtDate(p.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
