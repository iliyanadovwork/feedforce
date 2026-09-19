'use client';

// Adapted from Vercel AI Elements (elements.ai-sdk.dev) to this app's design tokens and primitives.
// Swaps vs. the upstream source:
//   - shadcn Button (@/components/ui/button)      → app Button (@/app/components/ui/Button); variants/sizes remapped.
//   - shadcn Tooltip                              → dropped wrapper, kept trigger child + a `title=` attribute.
//   - shadcn ButtonGroup / ButtonGroupText        → plain token <div> / <span> (no app equivalent).
//   - streamdown <Streamdown>{content}</Streamdown> → <MarkdownLite text={content} /> (the app's safe MD subset).
//   - `UIMessage["role"]` / `FileUIPart` from 'ai' → local MessageRole / MessageFilePart types (dep removed).
// Structure, exports, prop names and behaviour are preserved — only imports and styling changed.
import { Button, type ButtonProps } from '@/app/components/ui/Button';
import { MarkdownLite } from '@/app/components/MarkdownLite';
import { cn } from '@/lib/utils';
import { ChevronLeftIcon, ChevronRightIcon, PaperclipIcon, XIcon } from 'lucide-react';
import type { ComponentProps, HTMLAttributes, ReactElement } from 'react';
import { createContext, memo, useContext, useEffect, useState } from 'react';

// Local stand-ins for the 'ai' package types the upstream file imported.
export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageFilePart = {
  filename?: string;
  mediaType?: string;
  url?: string;
};

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full max-w-[95%] flex-col gap-2',
      from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant',
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      'flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-[13px]',
      'group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-surface-2 group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-fg',
      'group-[.is-assistant]:text-fg',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<'div'>;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn('flex items-center gap-1', className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ButtonProps & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = 'ghost',
  size = 'sm',
  className,
  ...props
}: MessageActionProps) => (
  // Tooltip wrapper dropped — the accessible name lives in `title` + the sr-only span.
  <Button
    size={size}
    type="button"
    variant={variant}
    title={tooltip}
    className={cn('w-8 px-0', className)}
    {...props}
  >
    {children}
    <span className="sr-only">{label || tooltip}</span>
  </Button>
);

type MessageBranchContextType = {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
};

const MessageBranchContext = createContext<MessageBranchContextType | null>(null);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error('MessageBranch components must be used within MessageBranch');
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = (newBranch: number) => {
    setCurrentBranch(newBranch);
    onBranchChange?.(newBranch);
  };

  const goToPrevious = () => {
    const newBranch = currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  };

  const goToNext = () => {
    const newBranch = currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  };

  const contextValue: MessageBranchContextType = {
    currentBranch,
    totalBranches: branches.length,
    goToPrevious,
    goToNext,
    branches,
    setBranches,
  };

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div className={cn('grid w-full gap-2 [&>div]:pb-0', className)} {...props} />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({ children, ...props }: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = Array.isArray(children) ? children : [children];

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        'grid gap-2 overflow-hidden [&>div]:pb-0',
        index === currentBranch ? 'block' : 'hidden',
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

export const MessageBranchSelector = ({ className, from, ...props }: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  // shadcn ButtonGroup → a plain token row (children keep their own rounded corners).
  return (
    <div
      className={cn('inline-flex items-center gap-0.5 rounded-md border border-line bg-surface-2 p-0.5', className)}
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ButtonProps;

export const MessageBranchPrevious = ({
  children,
  className,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="sm"
      type="button"
      variant="ghost"
      className={cn('w-8 px-0', className)}
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ButtonProps;

export const MessageBranchNext = ({ children, className, ...props }: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="sm"
      type="button"
      variant="ghost"
      className={cn('w-8 px-0', className)}
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({ className, ...props }: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  // shadcn ButtonGroupText → a plain token label.
  return (
    <span
      className={cn('inline-flex items-center px-2 text-[12px] tabular-nums text-fg-3', className)}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </span>
  );
};

export type MessageResponseProps = {
  children: string;
  className?: string;
};

export const MessageResponse = memo(
  ({ className, children }: MessageResponseProps) => (
    // Streamdown → MarkdownLite (the app's safe Markdown subset). MarkdownLite requires a string `text`.
    <MarkdownLite
      text={children}
      className={cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = 'MessageResponse';

export type MessageAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: MessageFilePart;
  className?: string;
  onRemove?: () => void;
};

export function MessageAttachment({ data, className, onRemove, ...props }: MessageAttachmentProps) {
  const filename = data.filename || '';
  const mediaType = data.mediaType?.startsWith('image/') && data.url ? 'image' : 'file';
  const isImage = mediaType === 'image';
  const attachmentLabel = filename || (isImage ? 'Image' : 'Attachment');

  return (
    <div className={cn('group relative size-24 overflow-hidden rounded-lg', className)} {...props}>
      {isImage ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={filename || 'attachment'}
            className="size-full object-cover"
            height={100}
            src={data.url}
            width={100}
          />
          {onRemove && (
            <button
              aria-label="Remove attachment"
              className="focus-ring absolute top-2 right-2 inline-flex size-6 items-center justify-center rounded-full bg-surface-1/80 text-fg-2 opacity-0 backdrop-blur-sm transition-opacity hover:bg-surface-1 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
            >
              <XIcon />
              <span className="sr-only">Remove</span>
            </button>
          )}
        </>
      ) : (
        <>
          {/* Tooltip wrapper dropped — filename surfaced via `title`. */}
          <div
            className="flex size-full shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-3"
            title={attachmentLabel}
          >
            <PaperclipIcon className="size-4" />
          </div>
          {onRemove && (
            <button
              aria-label="Remove attachment"
              className="focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded-full text-fg-2 opacity-0 transition-opacity hover:bg-hover hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
            >
              <XIcon />
              <span className="sr-only">Remove</span>
            </button>
          )}
        </>
      )}
    </div>
  );
}

export type MessageAttachmentsProps = ComponentProps<'div'>;

export function MessageAttachments({ children, className, ...props }: MessageAttachmentsProps) {
  if (!children) {
    return null;
  }

  return (
    <div className={cn('ml-auto flex w-fit flex-wrap items-start gap-2', className)} {...props}>
      {children}
    </div>
  );
}

export type MessageToolbarProps = ComponentProps<'div'>;

export const MessageToolbar = ({ className, children, ...props }: MessageToolbarProps) => (
  <div className={cn('mt-4 flex w-full items-center justify-between gap-4', className)} {...props}>
    {children}
  </div>
);
