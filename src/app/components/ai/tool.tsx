'use client';

// Adapted from Vercel AI Elements (elements.ai-sdk.dev) to the app's design tokens. Swaps: shadcn
// Collapsible → ./collapsible; shadcn Badge → a token <span>; the `ai` ToolUIPart type → a local
// ToolUIState union + plain props; and the AI-Elements ./code-block (not yet adapted) → a minimal
// inline <pre> CodeBlock in tokens. Status icons map the original green/red/blue/yellow to the app's
// success/danger/info/warning text tokens.
import { cn } from '@/lib/utils';
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react';
import { isValidElement, type ComponentProps, type ReactNode } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './collapsible';

// Local replacement for the AI SDK's ToolUIPart["state"] union (the `ai` import is removed).
export type ToolUIState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied';

// Minimal token-styled code block standing in for the not-yet-adapted ./code-block AI Element.
// Renders JSON / text output as monospace; `language` is accepted for call-site parity but unused
// (no syntax highlighter is bundled).
const CodeBlock = ({ code }: { code: string; language?: string }) => (
  <pre className="overflow-x-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-relaxed">
    <code>{code}</code>
  </pre>
);

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn(
      'not-prose mb-4 w-full overflow-hidden rounded-md border border-line bg-surface-2',
      className,
    )}
    {...props}
  />
);

export type ToolHeaderProps = {
  title?: string;
  type: string;
  state: ToolUIState;
  className?: string;
};

const getStatusBadge = (status: ToolUIState) => {
  const labels: Record<ToolUIState, string> = {
    'input-streaming': 'Pending',
    'input-available': 'Running',
    'approval-requested': 'Awaiting Approval',
    'approval-responded': 'Responded',
    'output-available': 'Completed',
    'output-error': 'Error',
    'output-denied': 'Denied',
  };

  const icons: Record<ToolUIState, ReactNode> = {
    'input-streaming': <CircleIcon className="size-4 text-fg-3" />,
    'input-available': <ClockIcon className="size-4 animate-pulse text-fg-3" />,
    'approval-requested': <ClockIcon className="size-4 text-warning-text" />,
    'approval-responded': <CheckCircleIcon className="size-4 text-info-text" />,
    'output-available': <CheckCircleIcon className="size-4 text-success-text" />,
    'output-error': <XCircleIcon className="size-4 text-danger-text" />,
    'output-denied': <XCircleIcon className="size-4 text-warning-text" />,
  };

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-3 px-2 py-0.5 text-[11px] text-fg-3">
      {icons[status]}
      {labels[status]}
    </span>
  );
};

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  ...props
}: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      'group flex w-full items-center justify-between gap-4 p-3 text-left focus-ring hover:bg-hover',
      className,
    )}
    {...props}
  >
    <div className="flex items-center gap-2">
      <WrenchIcon className="size-4 text-fg-3" />
      <span className="font-medium text-[13px] text-fg">
        {title ?? type.split('-').slice(1).join('-')}
      </span>
      {getStatusBadge(state)}
    </div>
    <ChevronDownIcon className="size-4 text-fg-3 transition-transform group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn('border-t border-line text-fg outline-none', className)}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<'div'> & {
  input: unknown;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn('space-y-2 overflow-hidden p-4', className)} {...props}>
    <h4 className="font-medium text-fg-3 text-[11px] uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-surface-3">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<'div'> & {
  output: unknown;
  errorText: string | undefined;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === 'object' && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === 'string') {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn('space-y-2 p-4', className)} {...props}>
      <h4 className="font-medium text-fg-3 text-[11px] uppercase tracking-wide">
        {errorText ? 'Error' : 'Result'}
      </h4>
      <div
        className={cn(
          'overflow-x-auto rounded-md text-xs [&_table]:w-full',
          errorText
            ? 'bg-danger-tint text-danger-text'
            : 'bg-surface-3 text-fg',
        )}
      >
        {errorText && <div className="p-3">{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
