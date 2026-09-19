import type { RunOutputs } from './types';

// Shared shape of the per-node section of an automation_runs.log row. Both runners (the manual /run
// route and the cron runner) write it, and the canvas hydrates its run state from it on load — so a
// browser refresh no longer wipes the last run's outputs (and the AI copilot keeps its grounding).
//
// Per port we persist the FIRST item's json, clipped: it's a sample for display/grounding, not an
// archive. Values whose JSON form exceeds the cap are stored as a truncated string instead.

export interface RunLogNode {
  ok: boolean;
  /** Port name → first item's json (clipped). Missing for ports that emitted nothing. */
  ports: Record<string, unknown>;
  /** How many items each port emitted (fan-out visibility beyond the single sample). */
  counts: Record<string, number>;
}

const MAX_VALUE_CHARS = 2_000;
const MAX_TOTAL_CHARS = 48_000;

// Oversized values are stored under this sentinel key. Hydration SKIPS them entirely: a truncated
// string is a shape the real run never produced — feeding it back to the copilot as { value: "…" }
// would make verification reject valid paths against phantom data. No grounding beats wrong grounding.
const CLIPPED_KEY = '__ff_clipped';

function clipValue(v: unknown, budgetLeft: number): unknown {
  let s: string;
  try { s = JSON.stringify(v ?? null) ?? 'null'; } catch { return { [CLIPPED_KEY]: '(unserialisable)' }; }
  const max = Math.min(MAX_VALUE_CHARS, Math.max(0, budgetLeft));
  if (max <= 0) return undefined;
  return s.length > max ? { [CLIPPED_KEY]: s.slice(0, max) + '…(truncated)' } : v;
}

function isClipped(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && CLIPPED_KEY in (v as Record<string, unknown>);
}

/** Per-node output samples for a run-log row, in execution order, under a total size budget. */
export function runLogNodes(outputs: Record<string, RunOutputs>, order: string[]): Record<string, RunLogNode> {
  const log: Record<string, RunLogNode> = {};
  let budget = MAX_TOTAL_CHARS;
  for (const id of order) {
    const out = outputs[id];
    if (!out) continue;
    const ports: Record<string, unknown> = {};
    const counts: Record<string, number> = {};
    for (const [port, items] of Object.entries(out)) {
      counts[port] = items?.length ?? 0;
      if (!items?.length) continue;
      const clipped = clipValue(items[0].json, budget);
      if (clipped === undefined) continue;
      ports[port] = clipped;
      try { budget -= (JSON.stringify(clipped) ?? '').length; } catch { /* counted as free */ }
    }
    log[id] = { ok: true, ports, counts };
  }
  return log;
}

/** Rebuild the canvas's lastRun shape ({ nodeId: { port: [item] } }) from a persisted log row. */
export function lastRunFromLog(nodes: unknown): Record<string, RunOutputs> {
  if (!nodes || typeof nodes !== 'object') return {};
  const out: Record<string, RunOutputs> = {};
  for (const [id, entry] of Object.entries(nodes as Record<string, unknown>)) {
    const ports = (entry as { ports?: unknown })?.ports;
    if (!ports || typeof ports !== 'object') continue;
    const runOut: RunOutputs = {};
    for (const [port, sample] of Object.entries(ports as Record<string, unknown>)) {
      if (isClipped(sample)) continue; // truncated sample — never rehydrate a shape the run didn't produce
      const json = sample && typeof sample === 'object' && !Array.isArray(sample)
        ? (sample as Record<string, unknown>)
        : { value: sample };
      runOut[port] = [{ json }];
    }
    if (Object.keys(runOut).length) out[id] = runOut;
  }
  return out;
}
