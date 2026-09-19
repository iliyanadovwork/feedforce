'use client';

// Adapted from Vercel AI Elements (elements.ai-sdk.dev). A spoked spinner in currentColor, so callers
// set the tint with a text-* token (e.g. text-fg-3). No external deps.
import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'react';

export type LoaderProps = HTMLAttributes<HTMLDivElement> & { size?: number };

export const Loader = ({ size = 16, className, ...props }: LoaderProps) => (
  <div
    className={cn('inline-flex items-center justify-center text-fg-3', className)}
    role="status"
    aria-label="Loading"
    {...props}
  >
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className="animate-spin motion-reduce:animate-none"
      style={{ color: 'currentcolor' }}
      aria-hidden
    >
      <path d="M8 0V4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 16V12" opacity="0.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.3 1.53 5.65 4.76" opacity="0.9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12.7 14.47 10.35 11.24" opacity="0.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M0 8H4" opacity="0.8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16 8H12" opacity="0.3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M1.53 12.7 4.76 10.35" opacity="0.7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M14.47 3.3 11.24 5.65" opacity="0.6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  </div>
);
