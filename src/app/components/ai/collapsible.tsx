'use client';

// Headless collapsible with the same API as shadcn's (Collapsible / CollapsibleTrigger / CollapsibleContent,
// open|defaultOpen|onOpenChange), but no @radix-ui dependency — so the adapted AI Elements (reasoning, plan,
// task, tool) just swap `@/components/ui/collapsible` → `./collapsible`. Content is conditionally rendered.
import { cn } from '@/lib/utils';
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { useControllableState } from './use-controllable';

type CollapsibleCtx = { open: boolean; setOpen: (v: boolean) => void; disabled?: boolean };
const CollapsibleContext = createContext<CollapsibleCtx | null>(null);
function useCollapsible(): CollapsibleCtx {
  const ctx = useContext(CollapsibleContext);
  if (!ctx) throw new Error('CollapsibleTrigger / CollapsibleContent must be used within <Collapsible>');
  return ctx;
}

export type CollapsibleProps = ComponentProps<'div'> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
};

export function Collapsible({ open, defaultOpen, onOpenChange, disabled, className, children, ...props }: CollapsibleProps) {
  const [isOpen = false, setOpen] = useControllableState<boolean>({ prop: open, defaultProp: defaultOpen ?? false, onChange: onOpenChange });
  return (
    <CollapsibleContext.Provider value={{ open: isOpen, setOpen, disabled }}>
      <div data-state={isOpen ? 'open' : 'closed'} className={className} {...props}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

export function CollapsibleTrigger({ className, children, onClick, ...props }: ComponentProps<'button'>) {
  const { open, setOpen, disabled } = useCollapsible();
  return (
    <button
      type="button"
      aria-expanded={open}
      disabled={disabled}
      data-state={open ? 'open' : 'closed'}
      onClick={(e) => { onClick?.(e); if (!disabled) setOpen(!open); }}
      className={cn(className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function CollapsibleContent({ className, children, ...props }: ComponentProps<'div'>) {
  const { open } = useCollapsible();
  if (!open) return null;
  return (
    <div data-state="open" className={cn(className)} {...props}>
      {children}
    </div>
  );
}
