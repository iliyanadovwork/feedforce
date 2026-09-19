'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { authedFetch } from '@/lib/authedFetch';
import { invalidateRewardsEnrollment } from '@/app/hooks/useRewardsEnrollment';
import { Alert, Badge, BrandLoader, Button, Card, ProgressBar, SectionHeader, TextField } from '@/app/components/ui';
import { lottieJoin, lottiePayout, lottiePool, lottieToggle, lottieViews } from './rewards/rewardsLotties';

// Creator Rewards page (Pro-only, see the sidebar gate): explains the program, handles joining /
// leaving (PayPal payout email), and shows the caller's OWN standing this month. Talks to
// /api/rewards/summary (one-shot payload) and /api/rewards/enrollment; the per-reel sticker toggle
// itself lives in the reels editor, not here.

// lottie-web touches the DOM on init — keep it out of SSR.
const Lottie = dynamic(() => import('lottie-react'), { ssr: false });

interface RewardsSummary {
  enrolled: boolean;
  paypalEmail: string | null;
  month: string; // 'YYYY-MM'
  monthViews: number;
  minReelViews: number;
  rank: number | null;
  rankedCount: number;
  tier: 'top' | 'rest' | null;
  estimatedCents: number | null;
  postCount: number;
  qualifiedPosts: number;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const fmtViews = (n: number) => n.toLocaleString();

const HOW_IT_WORKS: { anim: object; title: string; body: string }[] = [
  { anim: lottieJoin, title: 'Join the program', body: 'Sign up with the PayPal email your payouts should go to. It takes a minute.' },
  { anim: lottieToggle, title: 'Toggle the sticker', body: 'Flip the FeedForce sticker on for any reel in the reels editor before you publish.' },
  { anim: lottieViews, title: 'Hit 10,000 views', body: 'A reel starts earning once it passes 10k lifetime views.' },
  { anim: lottiePool, title: 'The pool fills', body: 'Every month, 50% of FeedForce subscription revenue goes straight into the pool.' },
  { anim: lottiePayout, title: 'Get paid', body: 'Your share of the pool matches your share of all qualified views.' },
];

function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card surface={2} padding="sm" className="flex flex-col gap-1 min-w-0">
      <p className="text-caption text-fg-3">{label}</p>
      <p className="text-[22px] leading-tight font-bold text-fg tracking-[-0.01em] truncate">{value}</p>
      {hint && <p className="text-caption text-fg-4">{hint}</p>}
    </Card>
  );
}

/** The payout rule stated plainly: one flat pool, split in proportion to qualified views. No tiers. */
function PoolFormula() {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-2.5">
      <p className="text-caption text-fg-2">
        <span className="font-semibold text-fg">Your payout</span> = pool ×{' '}
        <span className="whitespace-nowrap">(your qualified views ÷ all qualified views)</span>
      </p>
      <p className="text-caption text-fg-4">
        Everyone is paid the same way, with no tiers or bonuses: earn a fifth of the month&rsquo;s
        qualified views and you take a fifth of the pool. Your leaderboard position is for show, it
        never changes what you are paid.
      </p>
    </div>
  );
}

/** A miniature reel showing where the sticker sits (below the crop, above the safe margin). Shows
    just the lockup — the real sticker adds the tagline underneath. */
function StickerPreview() {
  return (
    <div className="relative mx-auto w-[190px] aspect-[9/16] rounded-2xl border border-white/10 bg-gradient-to-b from-zinc-800 to-zinc-950 overflow-hidden shadow-2">
      <div className="absolute inset-x-3 top-3 bottom-[64px] rounded-xl border border-white/5 bg-gradient-to-br from-zinc-600/50 via-zinc-700/40 to-zinc-900/60 grid place-items-center">
        <svg viewBox="0 0 24 24" className="size-8 text-white/30" fill="currentColor" aria-hidden><path d="M8 5.5v13l11-6.5-11-6.5Z" /></svg>
      </div>
      <div className="absolute inset-x-0 bottom-6 flex flex-col items-center px-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- static local SVG inside a fixed-size mock */}
        <img src="/feedforce-logo-white.svg" alt="FeedForce" className="h-[18px] w-auto" />
      </div>
    </div>
  );
}

export function RewardsSection({ userId }: { userId: string }) {
  const [summary, setSummary] = useState<RewardsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authedFetch('/api/rewards/summary');
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) { setError('Could not load your rewards. Please refresh.'); return; }
      setError(null);
      setSummary(json);
    } catch { setError('Could not load your rewards. Please refresh.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // ── Enrollment (join / edit payout email / leave) ──────────────────────────
  const [emailInput, setEmailInput] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [leaving, setLeaving] = useState(false);

  async function handleJoin(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await authedFetch('/api/rewards/enrollment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paypalEmail: emailInput }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setSaveError(json.error || 'Could not save. Please try again.'); return; }
      // Drop the session-cached "not enrolled" answer so the reels editor's sticker toggle
      // appears on its next mount without a hard reload.
      invalidateRewardsEnrollment(userId);
      setEditing(false);
      setEmailInput('');
      await load();
    } catch {
      setSaveError('Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleLeave() {
    if (leaving) return;
    setLeaving(true);
    setSaveError(null);
    try {
      const res = await authedFetch('/api/rewards/enrollment', { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setSaveError(json.error || 'Could not leave. Please try again.');
        return;
      }
      invalidateRewardsEnrollment(userId);   // sticker toggle disappears on the editor's next mount
      setLeaveConfirm(false);
      await load();
    } catch {
      setSaveError('Could not leave. Please try again.');
    } finally {
      setLeaving(false);
    }
  }

  const minViews = summary?.minReelViews ?? 10_000;

  return (
    <div className="flex flex-col items-center pt-10 pb-16 gap-10">
      <div className="w-full max-w-5xl flex flex-col gap-6 px-2">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-[22px] leading-tight font-bold tracking-[-0.01em] text-fg">Creator rewards</h2>
              <Badge>Paid monthly</Badge>
            </div>
            <p className="text-body text-fg-3 max-w-xl">
              Earn a share of FeedForce revenue for the reels you publish with the FeedForce sticker.
            </p>
          </div>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        {/* How it works: five animated steps */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {HOW_IT_WORKS.map((step, i) => (
            <Card key={step.title} surface={1} padding="sm" className="flex flex-col gap-3 h-full">
              <div className="flex-1 min-h-[104px] grid place-items-center">
                <div className="size-[84px] rounded-xl bg-zinc-900 border border-white/5 p-1.5">
                  <Lottie animationData={step.anim} loop autoplay className="size-full" />
                </div>
              </div>
              <div className="mt-auto flex flex-col gap-1">
                <p className="text-label text-fg">{i + 1}. {step.title}</p>
                <p className="text-caption text-fg-3">{step.body}</p>
              </div>
            </Card>
          ))}
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_240px] gap-6 items-start">
          <div className="flex flex-col gap-6 min-w-0">
            {/* This month */}
            <Card surface={1} padding="md">
              <div className="flex flex-col gap-4">
                <SectionHeader title="This month" />
                {summary === null ? (
                  <div className="grid place-items-center py-6"><BrandLoader size={32} /></div>
                ) : !summary.enrolled ? (
                  <p className="text-caption text-fg-3 py-1">Join the program below to start earning from your sticker reels.</p>
                ) : summary.postCount === 0 ? (
                  <p className="text-caption text-fg-3 py-1">
                    No sticker reels yet. Enable the FeedForce sticker on a reel in the reels editor and it&rsquo;ll show up here once published.
                  </p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <StatTile label="Qualified views" value={fmtViews(summary.monthViews)} />
                      <StatTile
                        label="Leaderboard"
                        value={summary.rank !== null ? `#${summary.rank}` : '—'}
                        hint={summary.rank !== null ? `of ${summary.rankedCount} creator${summary.rankedCount === 1 ? '' : 's'}` : 'not ranked yet'}
                      />
                      <StatTile
                        label="Estimated earnings"
                        value={summary.estimatedCents !== null ? usd(summary.estimatedCents) : '—'}
                        hint="finalized after month end"
                      />
                      <StatTile
                        label="Sticker reels"
                        value={`${summary.qualifiedPosts} / ${summary.postCount}`}
                        hint={`past ${fmtViews(minViews)} views`}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <ProgressBar
                        tone="neutral"
                        value={summary.postCount > 0 ? (summary.qualifiedPosts / summary.postCount) * 100 : 0}
                        label="Sticker reels past the qualification line"
                      />
                      <p className="text-caption text-fg-3">
                        {summary.qualifiedPosts === 0
                          ? `None of your ${summary.postCount} sticker reel${summary.postCount === 1 ? '' : 's'} has reached ${fmtViews(minViews)} views yet. A reel joins the payout once it crosses that line, and its views to date count with it.`
                          : `${summary.qualifiedPosts} of ${summary.postCount} sticker reel${summary.postCount === 1 ? '' : 's'} ${summary.qualifiedPosts === 1 ? 'has' : 'have'} passed ${fmtViews(minViews)} views and count${summary.qualifiedPosts === 1 ? 's' : ''} toward the pool.`}
                      </p>
                    </div>
                  </>
                )}
              </div>
            </Card>

            {/* Pool */}
            <Card surface={1} padding="md">
              <div className="flex flex-col gap-3">
                <SectionHeader title="How the pool splits" />
                <PoolFormula />
                <p className="text-caption text-fg-4">
                  The pool is 50% of FeedForce&rsquo;s subscription revenue each month, and it is split
                  between every creator in proportion to their qualified views. Two creators with the
                  same views always earn the same amount, however many creators are on the leaderboard.
                </p>
              </div>
            </Card>

            {/* Enrollment */}
            <Card surface={1} padding="md">
              <div className="flex flex-col gap-3">
                <SectionHeader title="Enrollment" />
                {summary === null ? (
                  <div className="grid place-items-center py-6"><BrandLoader size={32} /></div>
                ) : !summary.enrolled || editing ? (
                  <form onSubmit={handleJoin} className="flex flex-col gap-3">
                    <p className="text-caption text-fg-3 -mt-1">
                      {editing
                        ? 'Update the PayPal address your payouts are sent to.'
                        : 'Enter the PayPal email your payouts should be sent to. You can leave and rejoin any time. Your reels and views are kept.'}
                    </p>
                    <TextField
                      label="PayPal email"
                      type="email"
                      value={emailInput}
                      onChange={e => setEmailInput(e.target.value)}
                      placeholder="you@example.com"
                      required
                    />
                    {saveError && <Alert tone="danger">{saveError}</Alert>}
                    <div className="flex items-center gap-2">
                      <Button type="submit" variant="primary" size="sm" loading={saving} disabled={saving}>
                        {editing ? 'Save' : 'Join the program'}
                      </Button>
                      {editing && (
                        <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setSaveError(null); }} disabled={saving}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-label text-fg">You&rsquo;re in the program</p>
                        <p className="text-caption text-fg-3 truncate">Payouts go to {summary.paypalEmail}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button variant="secondary" size="sm" onClick={() => { setEmailInput(summary.paypalEmail ?? ''); setEditing(true); setSaveError(null); }}>
                          Edit email
                        </Button>
                        {!leaveConfirm && (
                          <Button variant="danger" size="sm" onClick={() => { setLeaveConfirm(true); setSaveError(null); }}>Leave</Button>
                        )}
                      </div>
                    </div>
                    {leaveConfirm && (
                      <div className="flex items-center justify-between gap-3">
                        <Alert tone="danger" className="flex-1">Leave the rewards program? You won&rsquo;t appear in this month&rsquo;s payout; your reels and views are kept if you rejoin.</Alert>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button variant="ghost" size="sm" onClick={() => setLeaveConfirm(false)} disabled={leaving}>Cancel</Button>
                          <Button variant="danger" size="sm" loading={leaving} disabled={leaving} onClick={handleLeave}>Yes, leave</Button>
                        </div>
                      </div>
                    )}
                    {saveError && <Alert tone="danger">{saveError}</Alert>}
                    <p className="text-caption text-fg-3">
                      Turn the FeedForce sticker on per reel in the reels editor. Only sticker reels count toward rewards.
                    </p>
                  </>
                )}
              </div>
            </Card>
          </div>

          {/* Sticker preview */}
          <Card surface={1} padding="md" className="lg:sticky lg:top-6">
            <div className="flex flex-col gap-3">
              <SectionHeader title="The sticker" />
              <StickerPreview />
              <p className="text-caption text-fg-4 text-center">
                Baked into the exported video, just below your reel&rsquo;s crop, exactly as previewed in the editor.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
