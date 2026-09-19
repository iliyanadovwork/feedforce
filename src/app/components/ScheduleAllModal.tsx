'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Modal, NumberField, SegmentedControl, Spinner } from '@/app/components/ui';
import { DateTimePicker } from './DateTimePicker';
import { authedFetch } from '@/lib/authedFetch';
import { assignScheduleTimes, maxInAnyRolling24h, MAX_SCHEDULED_PER_ACCOUNT, SOFT_DAILY_WARN } from '@/lib/scheduleCadence';
import { classifyReelDuration, effectiveReelDuration, MAX_REEL_S } from '@/lib/reelDuration';
import { AccountPicker, type PickerAccount } from './SocialAccountPicker';
import type { Framing } from './TikTokCanvas/types';

// "Schedule All" picker: choose which reels to bulk-schedule to one Instagram account, on a cadence
// (start time + interval) with per-row overrides. This modal only PLANS the batch, the render/upload/
// submit engine lives in CanvasGrid (onSubmit hands it the chosen items). The per-account cap
// (MAX_SCHEDULED_PER_ACCOUNT) is read up front from the calendar API's pagination.total so the user
// sees how many slots are free before rendering anything; the server re-enforces it (409) at submit.

// Instagram rejects captions past this length; the bulk route 400s the whole call on one long
// caption, so the modal flags such rows and the submit trims to the limit.
const IG_CAPTION_MAX = 2200;

export interface ScheduleAllReelItem {
  id: string;
  number: number;                    // 1-based position in the grid (the strip numbering)
  caption: string;
  framing: Framing | null;           // live/saved framing (trim window) for the duration estimate
  sourceDuration: number | null;     // seconds when known (only the mounted reel has a live <video>)
}

export interface ScheduleAllSubmitArgs {
  accountId: string;
  timezone: string;
  items: { id: string; caption: string; scheduledFor: string }[];   // scheduledFor = ISO UTC
}

const pad = (n: number) => String(n).padStart(2, '0');
function toLocalInput(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type IntervalMode = '24' | '12' | '6' | 'custom';

export function ScheduleAllModal({ open, onClose, reels, onSubmit }: {
  open: boolean;
  onClose: () => void;
  reels: ScheduleAllReelItem[];
  onSubmit: (args: ScheduleAllSubmitArgs) => void;
}) {
  // ── Account + free-slot count ──────────────────────────────────────────────────────────────────
  const [accounts, setAccounts] = useState<PickerAccount[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch('/api/schedule/accounts');
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Failed to load accounts');
        if (cancelled) return;
        const igs = ((json.accounts ?? []) as (PickerAccount & { platform?: string })[])
          .filter((a) => a.platform === 'instagram');
        setAccounts(igs);
        if (igs[0]) setAccountId((prev) => prev || igs[0]._id);
      } catch (e) {
        if (cancelled) return;
        setAccountsError(e instanceof Error ? e.message : 'Failed to load accounts');
        setAccounts([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The account's current scheduled-post backlog, read from pagination.total of a limit-1 listing.
  // null = unknown, which FAILS OPEN (no client cap): the bulk route re-checks and 409s if truly full.
  const [scheduledCount, setScheduledCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  useEffect(() => {
    setScheduledCount(null);
    if (!accountId) return;
    let cancelled = false;
    setCountLoading(true);
    (async () => {
      try {
        const res = await authedFetch(`/api/schedule/posts?status=scheduled&accountId=${encodeURIComponent(accountId)}&limit=1`);
        const json = await res.json().catch(() => ({}));
        const total = json?.pagination?.total;
        if (!cancelled && res.ok && typeof total === 'number') setScheduledCount(total);
      } catch { /* fail open */ }
      if (!cancelled) setCountLoading(false);
    })();
    return () => { cancelled = true; };
  }, [accountId]);
  const slotsFree = scheduledCount === null ? null : Math.max(0, MAX_SCHEDULED_PER_ACCOUNT - scheduledCount);

  // ── Selection + cadence ────────────────────────────────────────────────────────────────────────
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(reels.map(r => [r.id, true])));
  const [start, setStart] = useState(() => {
    const t = new Date();
    return toLocalInput(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 9, 0));   // tomorrow 09:00 local
  });
  const [intervalMode, setIntervalMode] = useState<IntervalMode>('24');
  const [customHours, setCustomHours] = useState(4);
  const [times, setTimes] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const editedRef = useRef<Set<string>>(new Set());   // rows the user hand-edited (cadence skips them)
  const intervalHours = intervalMode === 'custom' ? customHours : Number(intervalMode);

  // Current state mirrored into a ref so handlers/effects can compute against the freshest values
  // without effect-dependency churn.
  const stateRef = useRef({ checked, start, hours: intervalHours });
  stateRef.current = { checked, start, hours: intervalHours };

  // Reflow cadence times over the CHECKED rows in list order. preserveEdits keeps hand-edited rows;
  // a cadence change clears the edits and reassigns every checked row.
  const applyCadence = useCallback((preserveEdits: boolean, checkedNow: Record<string, boolean>, startNow: string, hoursNow: number) => {
    if (!preserveEdits) editedRef.current.clear();
    const ids = reels.filter(r => checkedNow[r.id]).map(r => r.id);
    if (ids.length === 0 || !startNow || !Number.isFinite(hoursNow) || hoursNow <= 0) return;
    const seq = assignScheduleTimes(startNow, hoursNow, ids.length);
    setTimes(prev => {
      const next = { ...prev };
      ids.forEach((id, i) => {
        if (preserveEdits && editedRef.current.has(id)) return;
        // Normalize to a datetime-local value whatever ISO shape the helper returns.
        const d = new Date(seq[i]);
        next[id] = Number.isFinite(d.getTime()) ? toLocalInput(d) : seq[i];
      });
      return next;
    });
  }, [reels]);

  // Initial fill: every eligible reel checked, cadence from the defaults.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    applyCadence(false, stateRef.current.checked, stateRef.current.start, stateRef.current.hours);
  }, [applyCadence]);

  // Once the account's free-slot count arrives, cap the default selection at the slots free
  // (unchecking from the end), then reflow the cadence over what stayed checked.
  useEffect(() => {
    if (slotsFree === null) return;
    const cur = stateRef.current;
    const ids = reels.filter(r => cur.checked[r.id]).map(r => r.id);
    if (ids.length <= slotsFree) return;
    const next = { ...cur.checked };
    ids.slice(slotsFree).forEach(id => { next[id] = false; });
    setChecked(next);
    applyCadence(true, next, cur.start, cur.hours);
  }, [slotsFree, reels, applyCadence]);

  function toggleReel(id: string) {
    const cur = stateRef.current;
    const next = { ...cur.checked, [id]: !cur.checked[id] };
    setChecked(next);
    applyCadence(true, next, cur.start, cur.hours);   // reflow around the change; hand edits stick
  }
  function changeStart(v: string) {
    setStart(v);
    applyCadence(false, stateRef.current.checked, v, stateRef.current.hours);
  }
  function changeIntervalMode(v: IntervalMode) {
    setIntervalMode(v);
    const hours = v === 'custom' ? customHours : Number(v);
    applyCadence(false, stateRef.current.checked, stateRef.current.start, hours);
  }
  function changeCustomHours(v: number) {
    setCustomHours(v);
    applyCadence(false, stateRef.current.checked, stateRef.current.start, v);
  }
  function editTime(id: string, v: string) {
    editedRef.current.add(id);
    setTimes(prev => ({ ...prev, [id]: v }));
  }

  // ── Validation ─────────────────────────────────────────────────────────────────────────────────
  const now = Date.now();
  const checkedIds = useMemo(() => reels.filter(r => checked[r.id]).map(r => r.id), [reels, checked]);
  const isTimeValid = useCallback((id: string) => {
    const t = Date.parse(times[id] ?? '');   // datetime-local strings parse as LOCAL time
    return Number.isFinite(t) && t > now;
  }, [times, now]);
  const allTimesValid = checkedIds.every(isTimeValid);
  const overSlots = slotsFree !== null && checkedIds.length > slotsFree;
  const rolling24 = useMemo(
    () => maxInAnyRolling24h(checkedIds.map(id => times[id]).filter((t): t is string => !!t)),
    [checkedIds, times],
  );

  const timezone = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  }, []);

  const canSubmit = !!accountId && checkedIds.length > 0 && !overSlots && allTimesValid;

  function handleSubmit() {
    setSubmitError(null);
    const nowMs = Date.now();
    const chosen = reels.filter(r => checked[r.id]);
    if (chosen.some(r => { const t = Date.parse(times[r.id] ?? ''); return !Number.isFinite(t) || t <= nowMs; })) {
      setSubmitError('Some schedule times are in the past now. Adjust them and try again.');
      return;
    }
    onSubmit({
      accountId,
      timezone,
      items: chosen.map(r => ({
        id: r.id,
        // Trim on a code-point boundary so the cut never splits an emoji surrogate pair. The length
        // CHECK stays UTF-16 (r.caption.length), so behavior only changes at the cut, not when we trim.
        caption: r.caption.length > IG_CAPTION_MAX ? [...r.caption].slice(0, IG_CAPTION_MAX).join('') : r.caption,
        scheduledFor: new Date(times[r.id]).toISOString(),
      })),
    });
  }

  // Earliest schedulable slot, frozen when the modal opens; floored to the next whole minute so the first
  // option is genuinely in the future (submit re-checks the live clock). The picker forbids anything earlier.
  const scheduleMin = useMemo(() => { const d = new Date(); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1); return d; }, []);
  const noAccounts = accounts !== null && accounts.length === 0;

  return (
    <Modal
      open={open} onClose={onClose} size="xl" dismissOnBackdrop={false} variant="auth"
      title="Schedule all reels"
      description="Render the checked reels and schedule them to Instagram on a cadence."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
            {checkedIds.length === 1 ? 'Schedule 1 reel' : `Schedule ${checkedIds.length} reels`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 py-1">
        {/* Account + free slots */}
        {accounts === null ? (
          <div className="flex items-center gap-2 text-caption text-fg-3"><Spinner size="sm" /> Loading accounts…</div>
        ) : noAccounts ? (
          <Alert tone="info">
            No Instagram account is connected yet. Open the <span className="font-semibold">Post</span> section
            and press Connect Instagram first, then come back here.
          </Alert>
        ) : (
          <div className="flex items-end gap-3 flex-wrap">
            <div className="w-[260px]"><AccountPicker accounts={accounts} value={accountId} onChange={setAccountId} /></div>
            <div className="flex items-center h-9">
              {countLoading ? <Spinner size="sm" /> : slotsFree !== null ? (
                <Badge tone={slotsFree === 0 ? 'danger' : 'neutral'}>
                  {slotsFree} of {MAX_SCHEDULED_PER_ACCOUNT} slots free
                </Badge>
              ) : null}
            </div>
          </div>
        )}
        {accountsError && <Alert tone="danger">{accountsError}</Alert>}

        {/* Cadence controls */}
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1.5 w-[220px]">
            <span className="text-label text-fg-2">Start</span>
            <DateTimePicker value={start} onChange={changeStart} min={scheduleMin} ariaLabel="Start date and time" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-label text-fg-2">Interval</span>
            <SegmentedControl<IntervalMode>
              ariaLabel="Posting interval" emphasis="fill" size="sm"
              items={[{ value: '24', label: '24h' }, { value: '12', label: '12h' }, { value: '6', label: '6h' }, { value: 'custom', label: 'Custom' }]}
              value={intervalMode} onChange={changeIntervalMode}
            />
          </div>
          {intervalMode === 'custom' && (
            <NumberField label="Hours between posts" value={customHours} onChange={changeCustomHours} min={1} max={168} step={1} unit="h" />
          )}
        </div>

        {/* Reel rows */}
        {reels.length === 0 ? (
          <p className="text-caption text-fg-3 py-6 text-center">No reels are ready to schedule yet. Add a video to a reel first.</p>
        ) : (
          <div className="max-h-[300px] overflow-y-auto rounded-md border border-line bg-surface-1 divide-y divide-line">
            {reels.map((r) => {
              const isOn = !!checked[r.id];
              const cls = classifyReelDuration(effectiveReelDuration(r.framing, r.sourceDuration));
              const invalid = isOn && !isTimeValid(r.id);
              return (
                <div key={r.id} className={`flex items-center gap-3 px-3 py-2 ${isOn ? '' : 'opacity-55'}`}>
                  <input
                    type="checkbox" className="accent-[var(--accent)] shrink-0 cursor-pointer"
                    checked={isOn} onChange={() => toggleReel(r.id)} aria-label={`Include reel ${r.number}`}
                  />
                  <span className="w-7 shrink-0 text-label text-fg-2 tabular-nums">#{r.number}</span>
                  <span className="flex-1 min-w-0 truncate text-body text-fg-2">{r.caption.trim() || 'No caption'}</span>
                  {/* Duration chips are an ESTIMATE from the saved trim/source info. Reels without a
                      known duration get no chip; the engine re-checks every reel at render time. */}
                  {cls === 'long' && <Badge tone="warning" className="shrink-0">Over {MAX_REEL_S}s, will post as a video not a Reel</Badge>}
                  {cls === 'short' && <Badge tone="warning" className="shrink-0">Under minimum, may be rejected</Badge>}
                  {r.caption.length > IG_CAPTION_MAX && <Badge tone="warning" className="shrink-0">Caption trimmed to {IG_CAPTION_MAX} chars</Badge>}
                  <div className="shrink-0">
                    <DateTimePicker size="sm" value={times[r.id] ?? ''} onChange={(v) => editTime(r.id, v)}
                      min={scheduleMin} disabled={!isOn} invalid={invalid} placeholder="Set time"
                      ariaLabel={`Schedule time for reel ${r.number}`} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Soft + hard warnings */}
        {overSlots && slotsFree !== null && (
          <Alert tone="warning">
            Only {slotsFree} of {MAX_SCHEDULED_PER_ACCOUNT} schedule slots are free on this account.
            Uncheck {checkedIds.length - slotsFree} {checkedIds.length - slotsFree === 1 ? 'reel' : 'reels'} to continue.
          </Alert>
        )}
        {rolling24 > SOFT_DAILY_WARN && (
          <Alert tone="warning">
            {rolling24} posts land within a single 24 hour window. Posting more than {SOFT_DAILY_WARN} per
            day can look like spam to Instagram. You can still schedule, but consider spacing them out.
          </Alert>
        )}
        {!allTimesValid && checkedIds.length > 0 && (
          <p className="text-caption text-danger-text">Every checked reel needs a schedule time in the future.</p>
        )}
        {submitError && <Alert tone="danger">{submitError}</Alert>}
      </div>
    </Modal>
  );
}
