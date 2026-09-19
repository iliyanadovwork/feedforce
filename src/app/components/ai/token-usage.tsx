'use client';

// Token-usage displays for the copilot (tokens only — no dollar cost, per the app's "dollars stay internal"
// design). Slimmed from the AI Elements `context` component: no tokenlens (window is passed in), no pricing.
import { cn } from '@/lib/utils';
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export type TokenUsage = { input: number; output: number; contextWindow?: number };

const DEFAULT_WINDOW = 1_048_576;
const fmt = (n: number) => n.toLocaleString('en-US');
/** Compact form for large counts: 1250 → "1.3k", 1_048_576 → "1M". */
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k` : String(n);

/** Smoothly ramps the displayed number from its current value to `value` whenever `value` changes
 * (easeOutCubic). Starts at 0 so a turn's tokens visibly count up; interrupts stay smooth (it eases from
 * wherever it currently is). Honours prefers-reduced-motion by snapping to the value. */
function useAnimatedNumber(value: number, duration = 650) {
  const [display, setDisplay] = useState(0);
  const ref = useRef({ cur: 0 });
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      ref.current.cur = value;
      setDisplay(value);
      return;
    }
    const from = ref.current.cur;
    if (from === value) return;
    let raf = 0;
    let start: number | null = null;
    const tick = (t: number) => {
      start ??= t;
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const cur = Math.round(from + (value - from) * eased);
      ref.current.cur = cur;
      setDisplay(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return display;
}

/** The tokens a single turn consumed — input (prompt) up, output (completion + reasoning) down. The counts
 * animate (count up) whenever they change. */
export function TurnTokens({ usage, className }: { usage: TokenUsage; className?: string }) {
  const inTok = useAnimatedNumber(usage.input);
  const outTok = useAnimatedNumber(usage.output);
  return (
    <span
      className={cn('inline-flex items-center gap-2 text-[10px] tabular-nums text-fg-4', className)}
      title={`${fmt(usage.input)} input + ${fmt(usage.output)} output tokens this turn`}
    >
      <span className="inline-flex items-center gap-0.5"><ArrowUpIcon className="size-2.5" aria-hidden /><span className="inline-block min-w-[4ch] text-right">{compact(inTok)}</span></span>
      <span className="inline-flex items-center gap-0.5"><ArrowDownIcon className="size-2.5" aria-hidden /><span className="inline-block min-w-[4ch] text-right">{compact(outTok)}</span></span>
    </span>
  );
}

/** Running session total — the sum of every turn's tokens so far. Animates as it grows. */
export function TotalTokens({ total, className }: { total: number; className?: string }) {
  const n = useAnimatedNumber(total, 450);
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-[11px] tabular-nums text-fg-3', className)}
      title={`${fmt(total)} tokens used this session`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </svg>
      <span>{fmt(n)} tokens</span>
    </span>
  );
}

/** How full the conversation is against the model's context window (a small bar + %). `used` defaults to
 * the latest turn's input+output, which tracks the growing conversation size. */
export function ContextMeter({ usage, className }: { usage: TokenUsage; className?: string }) {
  const total = usage.contextWindow ?? DEFAULT_WINDOW;
  const used = usage.input + usage.output;
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const label = pct < 1 ? '<1%' : `${Math.round(pct)}%`;
  return (
    <div
      className={cn('inline-flex items-center gap-1.5', className)}
      title={`${fmt(used)} of ${fmt(total)} tokens (${label}) of the context window used`}
    >
      <div className="h-1 w-14 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Context window used">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-fg-4">{label} · {compact(total)} ctx</span>
    </div>
  );
}

/** Context fullness as a small circular ring (Claude-Code style): a faint full track with an accent arc that
 * fills clockwise to the % of the context window used. Sits inline in the composer toolbar next to the +.
 * Tolerates a null usage (renders an empty track at 0%). */
export function ContextRing({ usage, size = 16, className }: { usage?: TokenUsage | null; size?: number; className?: string }) {
  const total = usage?.contextWindow ?? DEFAULT_WINDOW;
  const used = usage ? usage.input + usage.output : 0;
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const label = used === 0 ? '0%' : pct < 1 ? '<1%' : `${Math.round(pct)}%`;
  const SW = 2.4;
  const R = (20 - SW) / 2;
  const C = 2 * Math.PI * R;
  return (
    <span
      className={cn('group relative inline-grid shrink-0 place-items-center', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={`Context window: ${label} used`}
    >
      <svg width={size} height={size} viewBox="0 0 20 20" className="-rotate-90" aria-hidden>
        <circle cx="10" cy="10" r={R} fill="none" stroke="var(--line-strong)" strokeWidth={SW} />
        <circle
          cx="10"
          cy="10"
          r={R}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={SW}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - pct / 100)}
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      {/* Hover readout — pops up above the ring (the Claude-Code context tooltip, adapted: a passive usage
          readout, since this copilot has no auto-compact). */}
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-0 z-20 mb-2 translate-y-1 whitespace-nowrap rounded-lg border border-line-strong bg-surface-2 px-3 py-2 opacity-0 shadow-[0_12px_38px_-8px_rgba(0,0,0,0.85)] transition-[opacity,translate,visibility] transition-discrete duration-150 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100"
      >
        <span className="block text-[13px] text-fg">{label} of context used</span>
        <span className="mt-0.5 block text-[12px] text-fg-2">{compact(used)} / {compact(total)} tokens</span>
      </span>
    </span>
  );
}
