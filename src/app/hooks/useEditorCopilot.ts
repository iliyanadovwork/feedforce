'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { useTemplateEditor } from './useTemplateEditor';
import type { CarouselSettings } from '@/app/components/templateEditorTypes';
import { compactCarouselSettings } from '@/lib/editorTools/compact';
import type { AgentAction } from '@/lib/editorTools/agentActions';
import { applyCarouselActions, type ApplyOutcome } from '@/lib/editorTools/applyActions';

// The copilot ↔ editor bridge: turns validated agent actions into calls on the editor hook, so
// every AI edit flows through the SAME updateSlide() funnel a slider drag uses — one undo step
// per action, autosaved by the normal debounce. Nothing here talks to the DB directly.

export interface CopilotTemplateState {
  id?: string;
  name?: string;
  activeSlideId: string | null;
  slides: {
    id: string;
    name: string;
    position: number;
    headline: string;
    subheadline: string;
    settings: Partial<CarouselSettings>;
  }[];
}

export type { ApplyOutcome };   // re-exported from applyActions (the apply core lives there now)

export interface EditorCopilot {
  getState: () => CopilotTemplateState | null;
  /** Brand grounding for the agent (palette + identity + logo), when the host has a brand kit. */
  getBrand: () => { displayName?: string; colors?: string[]; logoUrl?: string } | undefined;
  /** Make `slideId` the active/on-screen slide (so an edit is visible AND ⌘Z targets it — the
   *  editor's undo pops the ACTIVE slide's history). No-op if it's already active or gone. */
  focusSlide: (slideId: string) => void;
  /** Apply a batch of actions in order (one editor undo step each). Returns a per-action outcome
   *  array aligned with the input (so callers know exactly which succeeded), plus the flattened
   *  labels/problems. generate_element is NOT handled here — the panel owns that pipeline. */
  applyAll: (actions: AgentAction[]) => Promise<{ outcomes: ApplyOutcome[]; labels: string[]; problems: string[] }>;
}

function genId(prefix: string): string {
  return (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${prefix}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

type Editor = ReturnType<typeof useTemplateEditor>;

export function useEditorCopilot(
  editor: Editor,
  opts?: {
    /** Called once before a batch applies — the grid uses it to commit/exit any inline text editor
     *  (the canvas editors commit by INDEX on blur, so mutating arrays under them corrupts boxes). */
    onBeforeApply?: () => void;
    /** Brand kit grounding forwarded to the agent (palette colors + identity). */
    brand?: { displayName?: string; colors?: string[]; logoUrl?: string };
    /** Called once after a batch applies ≥1 change — the grid uses it to pulse the canvas so the
     *  user sees the AI touched their work. */
    onApplied?: () => void;
  },
): EditorCopilot {
  // The editor object is a fresh literal each render; hold it in a ref so getState/apply stay
  // referentially stable (the panel keeps them in callbacks) yet always see current slides.
  // Synced in an effect (not during render); both consumers run on user interaction, after commit.
  const editorRef = useRef(editor);
  useEffect(() => { editorRef.current = editor; });
  const onBeforeApplyRef = useRef(opts?.onBeforeApply);
  useEffect(() => { onBeforeApplyRef.current = opts?.onBeforeApply; });
  const brandRef = useRef(opts?.brand);
  useEffect(() => { brandRef.current = opts?.brand; });
  const onAppliedRef = useRef(opts?.onApplied);
  useEffect(() => { onAppliedRef.current = opts?.onApplied; });

  const getBrand = useCallback(() => {
    const b = brandRef.current;
    if (!b || (!b.displayName && !(b.colors && b.colors.length > 0) && !b.logoUrl)) return undefined;
    return { displayName: b.displayName || undefined, colors: b.colors?.slice(0, 12), logoUrl: b.logoUrl || undefined };
  }, []);

  const focusSlide = useCallback((slideId: string) => {
    const ed = editorRef.current;
    if (ed.activeSlideId !== slideId && ed.slides.some(s => s.id === slideId)) ed.selectSlide(slideId);
  }, []);

  const getState = useCallback((): CopilotTemplateState | null => {
    const ed = editorRef.current;
    if (!ed.activeTemplateId || ed.slides.length === 0) return null;
    return {
      id: ed.activeTemplateId,
      name: ed.activeTemplate?.name,
      activeSlideId: ed.activeSlideId,
      slides: ed.slides.map(s => ({
        id: s.id,
        name: s.name,
        position: s.position,
        headline: s.headline,
        subheadline: s.subheadline,
        settings: compactCarouselSettings(s.settings),
      })),
    };
  }, []);

  const applyAll = useCallback(async (actions: AgentAction[]): Promise<{ outcomes: ApplyOutcome[]; labels: string[]; problems: string[] }> => {
    // Commit/exit any inline text editor first — the canvas editors commit by index on blur, so
    // mutating the arrays underneath one would write the user's in-flight text into the wrong box.
    onBeforeApplyRef.current?.();
    const ed = editorRef.current;
    // The whole deterministic apply core (working-copy threading, dispatch, id minting, the security
    // strip, diff labels, outcomes) lives in applyCarouselActions — unit-tested there. This hook only
    // wires the editor's real side-effects + the id source in, and fires the pulse.
    const result = await applyCarouselActions(ed.slides, actions, {
      genId,
      updateSlide: ed.updateSlide,
      addSlide: ed.addSlide,
      renameSlide: ed.renameSlide,
      selectSlide: ed.selectSlide,
    });
    if (result.outcomes.some(o => o.ok)) onAppliedRef.current?.();
    return result;
  }, []);

  return useMemo(() => ({ getState, getBrand, focusSlide, applyAll }), [getState, getBrand, focusSlide, applyAll]);
}
