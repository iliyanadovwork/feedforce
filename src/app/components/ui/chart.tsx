'use client';

import * as React from 'react';
import { ResponsiveContainer, Tooltip } from 'recharts';
import { cn } from './cn';

// shadcn/ui-style chart primitives, adapted to this app's tokens + cn and compatible with Recharts 3.
// ChartContainer injects per-series CSS vars (--color-<key>) from a ChartConfig and wraps a Recharts
// chart in a ResponsiveContainer; ChartTooltipContent renders a themed tooltip.

export type ChartConfig = Record<string, { label?: React.ReactNode; color?: string }>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);
function useChart() {
  const ctx = React.useContext(ChartContext);
  if (!ctx) throw new Error('useChart must be used within <ChartContainer>');
  return ctx;
}

export function ChartContainer({ id, className, children, config }: {
  id?: string; className?: string; config: ChartConfig; children: React.ReactElement;
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${(id || uniqueId).replace(/:/g, '')}`;
  const colorVars = Object.entries(config).filter(([, c]) => c.color);
  return (
    <ChartContext.Provider value={{ config }}>
      {colorVars.length > 0 && (
        <style dangerouslySetInnerHTML={{ __html: `[data-chart=${chartId}]{${colorVars.map(([k, c]) => `--color-${k}:${c.color};`).join('')}}` }} />
      )}
      <div
        data-chart={chartId}
        className={cn(
          'w-full text-caption [&_.recharts-cartesian-axis-tick_text]:fill-[var(--fg-3)] [&_.recharts-cartesian-grid_line]:stroke-[var(--line)] [&_.recharts-cartesian-grid_line]:opacity-60 [&_.recharts-layer]:outline-none [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none',
          className,
        )}
      >
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = Tooltip;

interface TooltipItem { dataKey?: string; name?: string; value?: number | string; color?: string }
export function ChartTooltipContent({ active, payload, label, labelFormatter, hideLabel, valueFormatter }: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: string | number;
  labelFormatter?: (v: string | number) => React.ReactNode;
  hideLabel?: boolean;
  valueFormatter?: (v: number | string) => React.ReactNode;
}) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-[8rem] rounded-xl border border-line bg-page px-3 py-2 shadow-3">
      {!hideLabel && label != null && (
        <div className="mb-1 text-caption font-medium text-fg">{labelFormatter ? labelFormatter(label) : label}</div>
      )}
      <div className="flex flex-col gap-1">
        {payload.map((item, i) => {
          const key = (item.dataKey ?? item.name) as string;
          const cfg = config[key];
          const color = item.color ?? cfg?.color ?? 'var(--accent)';
          const v = item.value;
          return (
            <div key={i} className="flex items-center gap-2 text-caption">
              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: color }} aria-hidden />
              <span className="text-fg-3">{cfg?.label ?? item.name ?? key}</span>
              <span className="ml-auto font-medium tabular-nums text-fg">
                {valueFormatter ? valueFormatter(v as number) : typeof v === 'number' ? v.toLocaleString() : v}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
