'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlan } from './PlanContext';
import { consumeExport, fetchExportQuota, ExportBlockedError, EXPORTS_EXHAUSTED_REASON } from '@/lib/exportQuota';

// Shared free-tier export guard for every download button (FREE_TIER_PLAN.md). One hook instance
// per editor keeps a single "N left" counter that all of that editor's export paths update.
// Charging is per PIECE, not per click: callers pass a stable key for what's being exported
// ('carousel:<templateId>' / 'reel:<entryId>'), and the consume_export RPC only charges a key the
// first time it appears in a month — so re-downloading another slide of the same carousel, retrying
// a failed reel, or double-clicking never double-spends. For Pro users guard() is a pass-through
// and the chip renders nothing.

export function useExportGuard() {
  const { plan, openUpgrade } = usePlan();
  const [remaining, setRemaining] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // transient quota-check failure
  // One export interaction at a time: a second click while a consume+render is in flight no-ops
  // instead of racing it (key-charging makes replays free, but the render itself shouldn't overlap).
  const busyRef = useRef(false);

  useEffect(() => {
    if (plan !== 'free') {
      setRemaining(null); // e.g. the user upgraded mid-session — drop the stale counter
      return;
    }
    let cancelled = false;
    fetchExportQuota().then(q => {
      // Fill only if nothing fresher landed meanwhile (a consume can resolve before this fetch).
      if (!cancelled && q && !q.unlimited) setRemaining(prev => (prev === null ? q.remaining : prev));
    });
    return () => { cancelled = true; };
  }, [plan]);

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 4000);
  }, []);

  const spend = useCallback(async (key: string): Promise<boolean> => {
    try {
      const rem = await consumeExport(plan, key);
      if (rem !== null) setRemaining(rem);
      return true;
    } catch (e) {
      if (e instanceof ExportBlockedError) {
        setRemaining(0);
        openUpgrade(EXPORTS_EXHAUSTED_REASON);
      } else {
        flashNotice(e instanceof Error ? e.message : 'Could not verify your export quota — try again.');
      }
      return false;
    }
  }, [plan, openUpgrade, flashNotice]);

  // Spend the key (free if already charged this month), then run the actual download. Returns
  // false — with the UX handled (upgrade modal or failure flash) — when the export must not run.
  const guard = useCallback(async (key: string, run: () => void | Promise<void>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    try {
      if (!(await spend(key))) return false;
      await run();
      return true;
    } finally {
      busyRef.current = false;
    }
  }, [spend]);

  // Batch flavor for download-all loops: spend the NEXT item's key or stop the batch. Same UX
  // handling as guard(); callers break their loop on false. No busy lock — the batch loop is
  // already sequential and holds the UI's disabled state itself.
  const consumeOne = useCallback((key: string): Promise<boolean> => spend(key), [spend]);

  return { plan, remaining, notice, guard, consumeOne };
}

// "N left this month" chip beside a download button — free plan only, quiet otherwise.
export function ExportQuotaChip({ remaining, notice }: { remaining: number | null; notice: string | null }) {
  const { plan } = usePlan();
  if (plan !== 'free') return null;
  if (notice) return <span className="text-caption text-danger-text whitespace-nowrap">{notice}</span>;
  if (remaining === null) return null;
  return (
    <span
      className="text-caption text-fg-3 tabular-nums whitespace-nowrap select-none"
      title="Free plan: 3 exports per month, resets on the 1st. Re-exporting the same piece doesn't count twice."
    >
      {remaining} export{remaining === 1 ? '' : 's'} left
    </span>
  );
}
