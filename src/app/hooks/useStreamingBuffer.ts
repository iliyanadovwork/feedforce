'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Coalesces streamed reply tokens into ONE throttled string state (at most one update per animation
// frame), so a live assistant bubble renders smoothly without a setState per token. Deliberately kept
// OUT of the panel's `messages` array — appending each token there would refire the per-message
// localStorage-persist and message-list reconciliation on every token.
export function useStreamingBuffer() {
  const [text, setText] = useState('');
  const bufRef = useRef('');
  const rafRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    rafRef.current = null;
    setText(bufRef.current);
  }, []);

  const append = useCallback((chunk: string) => {
    bufRef.current += chunk;
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush);
  }, [flush]);

  const reset = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    bufRef.current = '';
    setText('');
  }, []);

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  return { text, append, reset };
}
