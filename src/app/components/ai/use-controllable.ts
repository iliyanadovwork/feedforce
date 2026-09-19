import { useCallback, useState } from 'react';

// Minimal replacement for @radix-ui/react-use-controllable-state (same {prop, defaultProp, onChange} API),
// so the adapted AI Elements need no radix dependency. Controlled when `prop` is defined; else internal.
export function useControllableState<T>({
  prop,
  defaultProp,
  onChange,
}: {
  prop?: T;
  defaultProp?: T;
  onChange?: (value: T) => void;
}): [T | undefined, (value: T) => void] {
  const [uncontrolled, setUncontrolled] = useState<T | undefined>(defaultProp);
  const isControlled = prop !== undefined;
  const value = isControlled ? prop : uncontrolled;
  const setValue = useCallback(
    (next: T) => {
      if (!isControlled) setUncontrolled(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );
  return [value, setValue];
}
