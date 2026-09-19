'use client';

import { useSyncExternalStore } from 'react';

// Fast "is someone probably signed in?" hint read synchronously from localStorage
// (supabase-js persists sessions under `sb-<project-ref>-auth-token`). The server
// snapshot is false, so SSR emits the logged-out view — the crawlable marketing
// page — instead of a loading spinner; returning users flip to true during
// hydration (before paint) and see the loader until getSession() resolves.
const noopSubscribe = () => () => {};

function readStoredSessionHint(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) return true;
    }
  } catch {
    // Storage unavailable (private mode / blocked) — treat as signed out.
  }
  return false;
}

export function useStoredSessionHint(): boolean {
  return useSyncExternalStore(noopSubscribe, readStoredSessionHint, () => false);
}
