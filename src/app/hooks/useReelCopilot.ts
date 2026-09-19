'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TwitterTemplateSettings } from '@/app/components/twitterTemplateTypes';
import { resolveTwitterTemplateSettings } from '@/app/components/twitterTemplateTypes';
import { compactReelSettings, mergePatch } from '@/lib/editorTools/compact';
import { summarizeDiff } from '@/lib/editorTools/changeDiff';

// The reels copilot ↔ editor bridge: exposes the active reel template's compact settings and applies
// a validated patch through updateSettings — the same funnel the panels use, so AI edits autosave
// and are one ⌘Z step. Deep-merges nested objects (cells, banner, textStyle) before the shallow
// updateSettings, so a partial nested patch doesn't wipe its siblings.

export interface ReelCopilotState {
  id: string;
  name: string;
  settings: Partial<TwitterTemplateSettings>;   // compact (diff vs defaults)
}

export interface ReelCopilot {
  getState: () => ReelCopilotState | null;
  getBrand: () => { displayName?: string; colors?: string[]; logoUrl?: string } | undefined;
  /** Apply a settings patch to the reel identified by `expectedId` (the one captured when the
   *  request was sent). No-ops if that reel is no longer active/present — so a template switch
   *  mid-call can't silently patch the wrong reel. Returns a human "what changed" summary (computed
   *  against the LIVE pre-apply settings, so it's accurate even after a mid-turn manual edit), or
   *  null if it didn't apply. */
  applyPatch: (patch: Partial<TwitterTemplateSettings>, expectedId: string) => string[] | null;
}

interface ActiveReel { id: string; name: string; settings: TwitterTemplateSettings }

export function useReelCopilot(
  active: ActiveReel | null,
  updateSettings: (id: string, partial: Partial<TwitterTemplateSettings>) => void,
  brand?: { displayName?: string; colors?: string[]; logoUrl?: string },
  onApplied?: () => void,   // fired after a patch actually applies — the editor pulses the preview
): ReelCopilot {
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; });
  const updateRef = useRef(updateSettings);
  useEffect(() => { updateRef.current = updateSettings; });
  const brandRef = useRef(brand);
  useEffect(() => { brandRef.current = brand; });
  const onAppliedRef = useRef(onApplied);
  useEffect(() => { onAppliedRef.current = onApplied; });

  const getState = useCallback((): ReelCopilotState | null => {
    const a = activeRef.current;
    if (!a) return null;
    // Resolve over defaults first so the compact diff is computed against the true baseline (a
    // stored blob may already be partial).
    const full = resolveTwitterTemplateSettings(a.settings);
    return { id: a.id, name: a.name, settings: compactReelSettings(full) };
  }, []);

  const getBrand = useCallback(() => {
    const b = brandRef.current;
    if (!b || (!b.displayName && !(b.colors && b.colors.length > 0) && !b.logoUrl)) return undefined;
    return { displayName: b.displayName || undefined, colors: b.colors?.slice(0, 12), logoUrl: b.logoUrl || undefined };
  }, []);

  const applyPatch = useCallback((patch: Partial<TwitterTemplateSettings>, expectedId: string): string[] | null => {
    const a = activeRef.current;
    // Pin to the reel the request was about — if the user switched templates while the model was
    // thinking, drop the stale result rather than merge A's patch into B.
    if (!a || a.id !== expectedId || !patch || Object.keys(patch).length === 0) return null;
    const full = resolveTwitterTemplateSettings(a.settings);
    // Human "what changed" summary against the LIVE pre-apply settings (full, not the compact
    // turn-start snapshot) — accurate even if the user nudged a setting mid-turn.
    const changes = summarizeDiff(full as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    // Deep-merge the patch, then hand updateSettings only the touched top-level keys (their
    // already-merged values) so its shallow merge produces the deep result.
    const merged = mergePatch(full as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    const top: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) top[key] = (merged as Record<string, unknown>)[key];
    updateRef.current(a.id, top as Partial<TwitterTemplateSettings>);
    onAppliedRef.current?.();
    return changes;
  }, []);

  return useMemo(() => ({ getState, getBrand, applyPatch }), [getState, getBrand, applyPatch]);
}
