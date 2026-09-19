'use client';

// Adapted from Vercel AI Elements (elements.ai-sdk.dev) to the app's design tokens: the shimmer sweeps
// the app's --fg over a muted --fg-3 base (the original used shadcn's --color-background/--color-muted-foreground).
import { cn } from '@/lib/utils';
import { motion } from 'motion/react';
import { type CSSProperties, memo, useMemo } from 'react';

// motion.create() mints a component, which must NOT happen during render — so the motion elements are made
// once at module scope. `as` is a plain HTML tag (this app only ever uses the default 'span').
const MOTION_TAGS = { span: motion.span, div: motion.div, p: motion.p } as const;

export type ShimmerProps = {
  children: string;
  as?: keyof typeof MOTION_TAGS;
  className?: string;
  duration?: number;
  spread?: number;
};

const ShimmerComponent = ({ children, as = 'span', className, duration = 2, spread = 2 }: ShimmerProps) => {
  const MotionComponent = MOTION_TAGS[as] ?? MOTION_TAGS.span;
  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

  return (
    <MotionComponent
      animate={{ backgroundPosition: '0% center' }}
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent',
        '[--shimmer:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--fg),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]',
        className,
      )}
      initial={{ backgroundPosition: '100% center' }}
      style={{
        '--spread': `${dynamicSpread}px`,
        backgroundImage: 'var(--shimmer), linear-gradient(var(--fg-3), var(--fg-3))',
      } as CSSProperties}
      transition={{ repeat: Number.POSITIVE_INFINITY, duration, ease: 'linear' }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
