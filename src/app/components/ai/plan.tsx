'use client';

// Adapted from Vercel AI Elements (elements.ai-sdk.dev) to the app's design system. Changes from source:
// - shadcn Card/CardHeader/CardTitle/CardDescription/CardAction/CardContent/CardFooter have no app
//   equivalent, so each is inlined as a token-styled <div> (card → rounded-lg border border-line bg-surface-2).
// - `@/components/ui/collapsible` → `./collapsible` (headless, no radix; no `asChild`, so the Collapsible
//   carries the card classes directly and PlanContent renders CollapsibleContent itself).
// - PlanTrigger's shadcn Button is dropped: our CollapsibleTrigger is already a <button> and owns the toggle,
//   so it's styled directly as a bare icon button in tokens (avoids a nested button).
// - `./shimmer` kept as-is.
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './collapsible';
import { cn } from '@/lib/utils';
import { ChevronsUpDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { createContext, useContext } from 'react';
import { Shimmer } from './shimmer';

type PlanContextValue = {
  isStreaming: boolean;
};

const PlanContext = createContext<PlanContextValue | null>(null);

const usePlan = () => {
  const context = useContext(PlanContext);
  if (!context) {
    throw new Error('Plan components must be used within Plan');
  }
  return context;
};

export type PlanProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
};

export const Plan = ({
  className,
  isStreaming = false,
  children,
  ...props
}: PlanProps) => (
  <PlanContext.Provider value={{ isStreaming }}>
    <Collapsible
      className={cn('rounded-lg border border-line bg-surface-2', className)}
      data-slot="plan"
      {...props}
    >
      {children}
    </Collapsible>
  </PlanContext.Provider>
);

export type PlanHeaderProps = ComponentProps<'div'>;

export const PlanHeader = ({ className, ...props }: PlanHeaderProps) => (
  <div
    className={cn('flex items-start justify-between gap-3 p-4', className)}
    data-slot="plan-header"
    {...props}
  />
);

export type PlanTitleProps = Omit<ComponentProps<'div'>, 'children'> & {
  children: string;
};

export const PlanTitle = ({ className, children, ...props }: PlanTitleProps) => {
  const { isStreaming } = usePlan();

  return (
    <div
      className={cn('text-[13px] font-semibold leading-none text-fg', className)}
      data-slot="plan-title"
      {...props}
    >
      {isStreaming ? <Shimmer>{children}</Shimmer> : children}
    </div>
  );
};

export type PlanDescriptionProps = Omit<ComponentProps<'div'>, 'children'> & {
  children: string;
};

export const PlanDescription = ({
  className,
  children,
  ...props
}: PlanDescriptionProps) => {
  const { isStreaming } = usePlan();

  return (
    <div
      className={cn('text-balance text-[12px] text-fg-3', className)}
      data-slot="plan-description"
      {...props}
    >
      {isStreaming ? <Shimmer>{children}</Shimmer> : children}
    </div>
  );
};

export type PlanActionProps = ComponentProps<'div'>;

export const PlanAction = ({ className, ...props }: PlanActionProps) => (
  <div
    className={cn('flex shrink-0 items-center', className)}
    data-slot="plan-action"
    {...props}
  />
);

export type PlanContentProps = ComponentProps<'div'>;

export const PlanContent = ({ className, ...props }: PlanContentProps) => (
  <CollapsibleContent
    className={cn('px-4 pb-4 text-[13px] text-fg-2', className)}
    data-slot="plan-content"
    {...props}
  />
);

export type PlanFooterProps = ComponentProps<'div'>;

export const PlanFooter = ({ className, ...props }: PlanFooterProps) => (
  <div
    className={cn('flex items-center px-4 pb-4', className)}
    data-slot="plan-footer"
    {...props}
  />
);

export type PlanTriggerProps = ComponentProps<typeof CollapsibleTrigger>;

export const PlanTrigger = ({ className, ...props }: PlanTriggerProps) => (
  <CollapsibleTrigger
    className={cn(
      'inline-flex size-8 shrink-0 items-center justify-center rounded-md',
      'text-fg-2 transition-colors hover:bg-hover hover:text-fg active:bg-active',
      'focus-ring',
      className,
    )}
    data-slot="plan-trigger"
    {...props}
  >
    <ChevronsUpDownIcon className="size-4" />
    <span className="sr-only">Toggle plan</span>
  </CollapsibleTrigger>
);
