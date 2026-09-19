import { useRef, useEffect } from 'react';
import type { MutableRefObject } from 'react';

/**
 * A ref that tracks the latest `value`, so effects, event handlers, and callbacks can read the current
 * value without listing it as a dependency — the standard fix for stale closures.
 *
 * Centralizes the hand-written `const xRef = useRef(x); useEffect(() => { xRef.current = x; })` pattern
 * that recurs ~36× across the editor components. The sync happens in an effect (not during render) to
 * match that existing pattern and satisfy the React-Compiler lint rules.
 */
export function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; });
  return ref;
}
