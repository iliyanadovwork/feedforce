'use client';

// Adapted from Vercel AI Elements (elements.ai-sdk.dev) to the app's design tokens.
// Swaps vs. the upstream source:
//   - shadcn <Alert>/<AlertDescription> (no app equivalent) → a token card <div role="alert"> and a muted text block.
//   - shadcn <Button> → the app Button (@/app/components/ui/Button), size mapped to 'sm'.
//   - the `ToolUIPart` type from the 'ai' package → a local `ConfirmationState` string union, so there is no
//     runtime/type dependency on the AI SDK. Because that union already includes the v6 states, the upstream
//     `@ts-expect-error` comments are unnecessary and have been removed.
import { Button, type ButtonProps } from '@/app/components/ui/Button';
import { cn } from '@/lib/utils';
import { type ComponentProps, createContext, type ReactNode, useContext } from 'react';

// Local replacement for `ToolUIPart["state"]` from the 'ai' package (covers AI SDK v5 + v6 approval states).
export type ConfirmationState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-denied'
  | 'output-available'
  | 'output-error';

type ToolUIPartApproval =
  | {
      id: string;
      approved?: never;
      reason?: never;
    }
  | {
      id: string;
      approved: boolean;
      reason?: string;
    }
  | {
      id: string;
      approved: true;
      reason?: string;
    }
  | {
      id: string;
      approved: false;
      reason?: string;
    }
  | undefined;

type ConfirmationContextValue = {
  approval: ToolUIPartApproval;
  state: ConfirmationState;
};

const ConfirmationContext = createContext<ConfirmationContextValue | null>(null);

const useConfirmation = () => {
  const context = useContext(ConfirmationContext);

  if (!context) {
    throw new Error('Confirmation components must be used within Confirmation');
  }

  return context;
};

export type ConfirmationProps = ComponentProps<'div'> & {
  approval?: ToolUIPartApproval;
  state: ConfirmationState;
};

export const Confirmation = ({ className, approval, state, ...props }: ConfirmationProps) => {
  if (!approval || state === 'input-streaming' || state === 'input-available') {
    return null;
  }

  return (
    <ConfirmationContext.Provider value={{ approval, state }}>
      <div
        className={cn(
          'flex flex-col gap-2 rounded-lg border border-line bg-surface-2 px-4 py-3 text-[13px] text-fg',
          className,
        )}
        role="alert"
        {...props}
      />
    </ConfirmationContext.Provider>
  );
};

export type ConfirmationTitleProps = ComponentProps<'div'>;

export const ConfirmationTitle = ({ className, ...props }: ConfirmationTitleProps) => (
  <div className={cn('inline text-[13px] text-fg-3', className)} {...props} />
);

export type ConfirmationRequestProps = {
  children?: ReactNode;
};

export const ConfirmationRequest = ({ children }: ConfirmationRequestProps) => {
  const { state } = useConfirmation();

  // Only show when approval is requested
  if (state !== 'approval-requested') {
    return null;
  }

  return children;
};

export type ConfirmationAcceptedProps = {
  children?: ReactNode;
};

export const ConfirmationAccepted = ({ children }: ConfirmationAcceptedProps) => {
  const { approval, state } = useConfirmation();

  // Only show when approved and in response states
  if (
    !approval?.approved ||
    (state !== 'approval-responded' && state !== 'output-denied' && state !== 'output-available')
  ) {
    return null;
  }

  return children;
};

export type ConfirmationRejectedProps = {
  children?: ReactNode;
};

export const ConfirmationRejected = ({ children }: ConfirmationRejectedProps) => {
  const { approval, state } = useConfirmation();

  // Only show when rejected and in response states
  if (
    approval?.approved !== false ||
    (state !== 'approval-responded' && state !== 'output-denied' && state !== 'output-available')
  ) {
    return null;
  }

  return children;
};

export type ConfirmationActionsProps = ComponentProps<'div'>;

export const ConfirmationActions = ({ className, ...props }: ConfirmationActionsProps) => {
  const { state } = useConfirmation();

  // Only show when approval is requested
  if (state !== 'approval-requested') {
    return null;
  }

  return <div className={cn('flex items-center justify-end gap-2 self-end', className)} {...props} />;
};

export type ConfirmationActionProps = ButtonProps;

export const ConfirmationAction = (props: ConfirmationActionProps) => (
  <Button size="sm" type="button" {...props} />
);
