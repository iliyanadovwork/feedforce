'use client';

import { useEffect, useState } from 'react';

// Cycles a list of example prompts as a "Try: …" input placeholder to hint at what the copilot can do.
// Pauses (and resets to the base placeholder) while `paused` — e.g. the user is typing or a turn is
// running — so it never distracts. Returns the base placeholder when paused or the list is empty.
export function useRotatingPlaceholder(base: string, prompts: string[], paused: boolean, intervalMs = 3800): string {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (paused || prompts.length === 0) return;
    const t = setInterval(() => setIdx(i => (i + 1) % prompts.length), intervalMs);
    return () => clearInterval(t);
  }, [paused, prompts.length, intervalMs]);
  if (paused || prompts.length === 0) return base;
  return `Try: ${prompts[idx % prompts.length]}`;
}
