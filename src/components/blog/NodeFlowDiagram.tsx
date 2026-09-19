import { NodeIcon } from '@/app/components/automations/nodeIcons';
import { NODE_DESCRIPTORS, type NodeGroup } from '@/lib/automations/descriptors';

// Blog illustration for automation workflows — reuses the REAL node icons and labels from
// src/lib/automations/descriptors.ts (the same data the in-app canvas renders from), so a
// diagram in an article can never drift out of sync with what the product actually ships.
// Deliberately only accepts real node types: no fictitious "Gate" or other invented steps.

const GROUP_COLOR: Record<NodeGroup, string> = {
  Trigger: '#34d399',
  Source: '#60a5fa',
  Logic: '#f472b6',
  Transform: '#fbbf24',
  Render: '#a78bfa',
  Output: '#f87171',
};

export interface NodeFlowSingle {
  /** Key into NODE_DESCRIPTORS — the real node type. */
  nodeType: keyof typeof NODE_DESCRIPTORS;
  /** Short caption under the card, e.g. "polls the news source every hour". */
  note?: string;
}

/** Two or more nodes feeding the same next step at once — rendered side by side, not in sequence. */
export interface NodeFlowParallel {
  parallel: NodeFlowSingle[];
}

export type NodeFlowStep = NodeFlowSingle | NodeFlowParallel;

function isParallel(step: NodeFlowStep): step is NodeFlowParallel {
  return 'parallel' in step;
}

function Arrow() {
  return (
    <svg width="16" height="28" viewBox="0 0 16 28" fill="none" className="mx-auto shrink-0" aria-hidden>
      <path d="M8 0v20" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" />
      <path d="M2 18l6 8 6-8" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NodeCard({ nodeType, note }: NodeFlowSingle) {
  const desc = NODE_DESCRIPTORS[nodeType];
  const color = GROUP_COLOR[desc.group];
  return (
    <div className="flex w-full max-w-xs flex-col items-center">
      <div className="flex w-full items-center gap-3 rounded-xl border border-white/15 bg-zinc-950/80 p-3.5 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg" style={{ backgroundColor: `${color}1a`, color }}>
          <NodeIcon name={desc.icon} size={16} />
        </span>
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color }}>{desc.group}</div>
          <div className="truncate text-sm font-semibold text-white">{desc.label}</div>
        </div>
      </div>
      {note && <p className="mt-1.5 max-w-xs text-center text-xs leading-5 text-zinc-500">{note}</p>}
    </div>
  );
}

export function NodeFlowDiagram({ steps }: { steps: NodeFlowStep[] }) {
  return (
    <div className="not-prose my-10 flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.02] px-6 py-8">
      {steps.map((step, i) => (
        <div key={i} className="flex w-full flex-col items-center">
          {isParallel(step) ? (
            <div className="flex w-full flex-wrap items-start justify-center gap-4">
              {step.parallel.map((sub, j) => (
                <NodeCard key={j} {...sub} />
              ))}
            </div>
          ) : (
            <NodeCard {...step} />
          )}
          {i < steps.length - 1 && <Arrow />}
        </div>
      ))}
    </div>
  );
}
