'use client';

// Adapted from Vercel AI Elements (elements.ai-sdk.dev) to the app's design tokens and local primitives:
// the radix use-controllable-state + shadcn collapsible are swapped for the app's ./use-controllable and
// ./collapsible, and Streamdown is swapped for MarkdownLite (the app's safe tiny-Markdown renderer). Colors
// use --fg / --fg-3 tokens instead of shadcn's foreground/muted-foreground. Structure, exports, prop names,
// and the streaming duration / auto-open-close behavior are preserved.
import { cn } from '@/lib/utils';
import { MarkdownLite } from '@/app/components/MarkdownLite';
import { BrainIcon, ChevronDownIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, memo, useContext, useEffect, useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible';
import { useControllableState } from './use-controllable';
import { Shimmer } from './shimmer';

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error('Reasoning components must be used within Reasoning');
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = true,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen = false, setIsOpen] = useControllableState<boolean>({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      prop: durationProp,
      defaultProp: undefined,
    });

    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const [startTime, setStartTime] = useState<number | null>(null);

    // Track duration when streaming starts and ends
    useEffect(() => {
      if (isStreaming) {
        if (startTime === null) {
          // eslint-disable-next-line react-hooks/set-state-in-effect -- deriving start time from the isStreaming prop transition; intended effect-driven state, guarded so it runs once
          setStartTime(Date.now());
        }
      } else if (startTime !== null) {
        setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S));
        setStartTime(null);
      }
    }, [isStreaming, startTime, setDuration]);

    // Auto-open when streaming starts, auto-close a short beat after it ends (once only).
    useEffect(() => {
      if (isStreaming && !isOpen) {
        setIsOpen(true);
      } else if (defaultOpen && !isStreaming && isOpen && !hasAutoClosed) {
        // Delay before closing so the user can glimpse the final reasoning.
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, defaultOpen, setIsOpen, hasAutoClosed]);

    const handleOpenChange = (newOpen: boolean) => {
      setIsOpen(newOpen);
    };

    return (
      <ReasoningContext.Provider value={{ isStreaming, isOpen, setIsOpen, duration }}>
        <Collapsible
          className={cn('not-prose mb-4', className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    return <Shimmer duration={1}>Thinking...</Shimmer>;
  }
  if (duration === undefined) {
    return <p>Thought for a few seconds</p>;
  }
  return <p>Thought for {duration} seconds</p>;
};

export const ReasoningTrigger = memo(
  ({ className, children, getThinkingMessage = defaultGetThinkingMessage, ...props }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 text-[13px] text-fg-3 transition-colors hover:text-fg',
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4" />
            {getThinkingMessage(isStreaming, duration)}
            <ChevronDownIcon
              className={cn('size-4 transition-transform', isOpen ? 'rotate-180' : 'rotate-0')}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      className={cn('mt-4 text-[13px] text-fg-3 outline-none', className)}
      {...props}
    >
      <MarkdownLite text={children} />
    </CollapsibleContent>
  )
);

Reasoning.displayName = 'Reasoning';
ReasoningTrigger.displayName = 'ReasoningTrigger';
ReasoningContent.displayName = 'ReasoningContent';
