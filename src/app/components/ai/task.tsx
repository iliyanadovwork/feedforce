'use client';

// Adapted from Vercel AI Elements (elements.ai-sdk.dev) to the app's design tokens. Swaps the shadcn
// collapsible for the local headless `./collapsible` and maps shadcn utility classes to app tokens
// (bg-secondary→bg-surface-2, text-foreground→text-fg, text-muted-foreground→text-fg-3, border→border-line,
// border-muted→border-line, text-popover-foreground→text-fg). The animate-in/slide utilities come from
// tw-animate-css (imported in globals.css); closed-state variants are inert since the content unmounts.
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './collapsible';
import { cn } from '@/lib/utils';
import { ChevronDownIcon, SearchIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

export type TaskItemFileProps = ComponentProps<'div'>;

export const TaskItemFile = ({
  children,
  className,
  ...props
}: TaskItemFileProps) => (
  <div
    className={cn(
      'inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-fg text-[12px]',
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type TaskItemProps = ComponentProps<'div'>;

export const TaskItem = ({ children, className, ...props }: TaskItemProps) => (
  <div className={cn('text-fg-3 text-[13px]', className)} {...props}>
    {children}
  </div>
);

export type TaskProps = ComponentProps<typeof Collapsible>;

export const Task = ({
  defaultOpen = true,
  className,
  ...props
}: TaskProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
};

export const TaskTrigger = ({
  children,
  className,
  title,
  ...props
}: TaskTriggerProps) => (
  <CollapsibleTrigger className={cn('group', className)} {...props}>
    {children ?? (
      <div className="flex w-full cursor-pointer items-center gap-2 text-fg-3 text-[13px] transition-colors hover:text-fg">
        <SearchIcon className="size-4" />
        <p className="text-[13px]">{title}</p>
        <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      </div>
    )}
  </CollapsibleTrigger>
);

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;

export const TaskContent = ({
  children,
  className,
  ...props
}: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-fg outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className
    )}
    {...props}
  >
    <div className="mt-4 space-y-2 border-line border-l-2 pl-4">
      {children}
    </div>
  </CollapsibleContent>
);
