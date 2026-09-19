'use client';

// Adapted from Vercel AI Elements (elements.ai-sdk.dev) to the app's design tokens. The original leaned on
// `use-stick-to-bottom` for the scroll container + stick-to-bottom context; here that's reimplemented with a
// plain scroll ref + an effect that scrolls to bottom when the content changes (mirroring the app's copilot:
// `scrollRef.current?.scrollTo({ top: scrollHeight })`). The shadcn outline icon Button maps to the app's
// secondary Button made square; muted-foreground → text-fg-3.
import { Button } from '@/app/components/ui/Button';
import { cn } from '@/lib/utils';
import { ArrowDownIcon } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react';

type ConversationContextValue = {
  scrollRef: RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  setIsAtBottom: (value: boolean) => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
};

const ConversationContext = createContext<ConversationContextValue | null>(null);

function useConversationContext(): ConversationContextValue {
  const ctx = useContext(ConversationContext);
  if (!ctx) throw new Error('Conversation subcomponents must be used within <Conversation>');
  return ctx;
}

export type ConversationProps = ComponentProps<'div'>;

// The outer, non-scrolling positioning context. Kept `relative` so <ConversationScrollButton> can pin itself
// over the scroll viewport (which lives on <ConversationContent>).
export const Conversation = ({ className, children, ...props }: ConversationProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  return (
    <ConversationContext.Provider value={{ scrollRef, isAtBottom, setIsAtBottom, scrollToBottom }}>
      <div className={cn('relative flex flex-1 flex-col overflow-hidden', className)} role="log" {...props}>
        {children}
      </div>
    </ConversationContext.Provider>
  );
};

export type ConversationContentProps = ComponentProps<'div'>;

// The actual scroll viewport. Auto-scrolls to the newest content whenever `children` change, and reports
// whether the user is pinned to the bottom so the scroll button can show/hide.
export const ConversationContent = ({ className, children, ...props }: ConversationContentProps) => {
  const { scrollRef, setIsAtBottom, scrollToBottom, isAtBottom } = useConversationContext();

  // Track pinned-ness in a ref so the follow-content effect can read it without re-subscribing on every change.
  const atBottomRef = useRef(true);
  useEffect(() => { atBottomRef.current = isAtBottom; }, [isAtBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsAtBottom(distance < 24);
  }, [scrollRef, setIsAtBottom]);

  // Follow new content ONLY when the user is already pinned to the bottom — if they scrolled up to read
  // (e.g. mid-stream), don't yank them back down.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom('auto');
  }, [children, scrollToBottom]);

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
      <div className={cn('flex flex-col gap-8 p-4', className)} {...props}>{children}</div>
    </div>
  );
};

export type ConversationEmptyStateProps = ComponentProps<'div'> & {
  title?: string;
  description?: string;
  icon?: ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = 'No messages yet',
  description = 'Start a conversation to see messages here',
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn('flex size-full flex-col items-center justify-center gap-3 p-8 text-center', className)}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-fg-3">{icon}</div>}
        <div className="space-y-1">
          <h3 className="text-[13px] font-medium text-fg">{title}</h3>
          {description && <p className="text-[13px] text-fg-3">{description}</p>}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({ className, ...props }: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useConversationContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom('smooth');
  }, [scrollToBottom]);

  if (isAtBottom) return null;

  return (
    // shadcn `variant="outline" size="icon"` → app secondary Button squared off via className.
    <Button
      aria-label="Scroll to bottom"
      className={cn('absolute bottom-4 left-[50%] size-8 translate-x-[-50%] rounded-full p-0', className)}
      onClick={handleScrollToBottom}
      size="sm"
      type="button"
      variant="secondary"
      {...props}
    >
      <ArrowDownIcon className="size-4" aria-hidden />
    </Button>
  );
};
