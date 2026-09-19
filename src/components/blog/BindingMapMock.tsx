// Illustration of the Apply Template node's binding panel: each row maps a template
// placeholder (or chart/table element input) to a JSON path from upstream data. Styled
// to echo the real config-panel chip rows (AutomationsSection.tsx) in the blog's own
// dark palette. Deliberately only includes binding kinds that actually work today —
// text placeholders and chart/table element inputs — no image-URL binding, since that
// isn't a real feature yet (see the ultimate-guide article for the callout).

export interface Binding {
  target: string; // e.g. "{headline}" or "chart.prices"
  source: string; // e.g. "News.title" or "Prices.history"
  kind: 'text' | 'chart';
}

const KIND_COLOR: Record<Binding['kind'], string> = {
  text: '#60a5fa',
  chart: '#a78bfa',
};

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="rounded-md border px-2 py-1 font-mono text-xs"
      style={{ borderColor: `${color}40`, backgroundColor: `${color}14`, color }}
    >
      {label}
    </span>
  );
}

export function BindingMapMock({ bindings }: { bindings: Binding[] }) {
  return (
    <div className="not-prose my-10 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="mb-3 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
        Apply Template — bindings
      </div>
      <div className="flex flex-col gap-2">
        {bindings.map((b, i) => (
          <div
            key={i}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-zinc-950/60 px-3 py-2"
          >
            <Pill label={b.target} color={KIND_COLOR[b.kind]} />
            <svg width="20" height="12" viewBox="0 0 20 12" fill="none" aria-hidden>
              <path d="M0 6h16M12 1l6 5-6 5" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <Pill label={b.source} color="rgba(228,228,231,0.9)" />
          </div>
        ))}
      </div>
    </div>
  );
}
