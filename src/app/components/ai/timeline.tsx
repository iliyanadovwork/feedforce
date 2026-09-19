'use client';

// A single entry on the copilot's timeline rail: a vertical line (an upper segment joins the previous node,
// a lower segment reaches the next) with a node marker centred on it, and the entry's content to the right.
// `showTop` / `showBottom` are driven by neighbours so the rail can BREAK around off-rail entries (e.g. the
// user's own messages); `spaced` adds the inter-row gap for everything but the final entry.
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export type TimelineRowProps = {
  node: ReactNode;
  showTop: boolean;
  showBottom: boolean;
  spaced: boolean;
  children: ReactNode;
};

export function TimelineRow({ node, showTop, showBottom, spaced, children }: TimelineRowProps) {
  return (
    <div className="relative flex gap-3">
      <div className="relative w-4 shrink-0" aria-hidden>
        {showTop && <span className="absolute left-1/2 top-0 h-[11px] w-px -translate-x-1/2 bg-line" />}
        {showBottom && <span className="absolute bottom-0 left-1/2 top-[11px] w-px -translate-x-1/2 bg-line" />}
        <span className="absolute left-1/2 top-[11px] z-10 grid -translate-x-1/2 -translate-y-1/2 place-items-center">{node}</span>
      </div>
      <div className={cn('min-w-0 flex-1', spaced && 'pb-6')}>{children}</div>
    </div>
  );
}
