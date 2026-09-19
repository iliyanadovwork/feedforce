'use client';

// Adapted from Vercel AI Elements (elements.ai-sdk.dev) to the app's design system. The horizontal
// ScrollArea/ScrollBar pair is replaced with a plain overflow-x-auto div (no @radix scroll-area dep), and
// the shadcn Button becomes the app Button — the original "outline" default maps to the 'secondary' variant.
import { Button } from '@/app/components/ui/Button';
import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';

export type SuggestionsProps = ComponentProps<'div'>;

export const Suggestions = ({
  className,
  children,
  ...props
}: SuggestionsProps) => (
  <div className="w-full overflow-x-auto whitespace-nowrap" {...props}>
    <div className={cn('flex w-max flex-nowrap items-center gap-2', className)}>
      {children}
    </div>
  </div>
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = 'secondary',
  size = 'sm',
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = () => {
    onClick?.(suggestion);
  };

  return (
    <Button
      className={cn('cursor-pointer rounded-full px-4', className)}
      onClick={handleClick}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {children || suggestion}
    </Button>
  );
};
