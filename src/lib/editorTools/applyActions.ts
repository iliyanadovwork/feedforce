import type { SlideRow } from '@/app/components/templateEditorRows';
import type { CarouselSettings, TextBoxStyle, ImageBox, FreeElement } from '@/app/components/templateEditorTypes';
import { mergePatch } from './compact';
import { describeAction, validateFreeElementPatch, type AgentAction } from './agentActions';
import { summarizeDiff, diffLabel } from './changeDiff';

// The deterministic core of the copilot's apply step, extracted OUT of useEditorCopilot so it can be
// unit-tested against the exact path prod runs. It owns everything that decides correctness — the
// per-turn working copy (so two edits to the same slide in one turn don't clobber each other), action
// dispatch, id minting, the custom-element security strip, validation, diff labels, and per-action
// outcomes. The editor's side-effects (updateSlide/addSlide/renameSlide/selectSlide) and the id source
// are INJECTED as `deps`, so tests can pass a deterministic id counter + spies. The hook wires the real
// editor methods in and does nothing else — if any of this logic lived in the hook, the tests would lie.

export interface ApplyOutcome { ok: boolean; label?: string; error?: string }

export interface ApplyDeps {
  /** Mint an id for a newly-added item. Injected so add_* stays deterministic under test. */
  genId: (prefix: string) => string;
  /** The editor's shallow-merge update funnel — one undo step + autosave per call, exactly as a drag. */
  updateSlide: (id: string, partial: { headline?: string; subheadline?: string; settings?: Partial<CarouselSettings> }) => void;
  addSlide: (name?: string) => Promise<string | null>;
  renameSlide: (id: string, name: string) => Promise<unknown>;
  selectSlide: (id: string) => void;
}

export async function applyCarouselActions(
  slides: SlideRow[],
  actions: AgentAction[],
  deps: ApplyDeps,
): Promise<{ outcomes: ApplyOutcome[]; labels: string[]; problems: string[] }> {
  // React batches renders, so the caller's `slides` would be STALE between sequential applies in one
  // turn (two patches to the same slide would clobber each other's arrays). Thread a per-turn working
  // copy: every read comes from it, every apply writes the merged slide back into it, while updateSlide
  // still fires per action (one undo step each, normal autosave).
  const working = new Map(slides.map(s => [s.id, s] as const));

  const slideOf = (slideId: string) => {
    const slide = working.get(slideId);
    if (!slide) throw new Error(`No slide with id ${slideId}`);
    return slide;
  };

  // Apply a slide partial through the editor AND mirror it into the working copy (matching updateSlide's
  // shallow settings merge).
  const applySlidePartial = (
    slideId: string,
    partial: { headline?: string; subheadline?: string; settings?: Partial<CarouselSettings> },
  ) => {
    const slide = slideOf(slideId);
    deps.updateSlide(slideId, partial);
    working.set(slideId, {
      ...slide,
      headline: partial.headline ?? slide.headline,
      subheadline: partial.subheadline ?? slide.subheadline,
      settings: partial.settings ? { ...slide.settings, ...partial.settings } : slide.settings,
    });
  };

  // Replace one item of an id-keyed settings array (whole array travels as that key's new value).
  const replaceItem = <T extends { id: string }>(
    slideId: string,
    field: 'textBoxes' | 'imageBoxes' | 'freeElements',
    id: string,
    transform: (item: T) => T,
  ) => {
    const slide = slideOf(slideId);
    const arr = (slide.settings[field] ?? []) as unknown as T[];
    const idx = arr.findIndex(item => item.id === id);
    if (idx < 0) throw new Error(`No ${field} item with id ${id} on that slide`);
    const next = [...arr];
    next[idx] = transform(arr[idx]);
    applySlidePartial(slideId, { settings: { [field]: next } as Partial<CarouselSettings> });
  };

  let createdSlideThisTurn = false;

  const applyOne = async (action: AgentAction): Promise<string> => {
    switch (action.type) {
      case 'patch_slide': {
        const slide = slideOf(action.slideId);
        const partial: { headline?: string; subheadline?: string; settings?: Partial<CarouselSettings> } = {};
        if (action.headline !== undefined) partial.headline = action.headline;
        if (action.subheadline !== undefined) partial.subheadline = action.subheadline;
        if (action.settings && Object.keys(action.settings).length > 0) {
          // updateSlide merges settings SHALLOWLY — pre-merge nested objects here so a partial tagStyle
          // patch doesn't wipe the other tag fields.
          const merged = mergePatch(
            slide.settings as unknown as Record<string, unknown>,
            action.settings as Record<string, unknown>,
          );
          const top: Record<string, unknown> = {};
          for (const key of Object.keys(action.settings)) top[key] = merged[key];
          // Defense-in-depth for the custom-element code sink (customElements render via new Function):
          // the patch schema already rejects a freeElements array carrying a 'custom' element, but strip
          // any here too so a future path that reaches here with an unvalidated patch can never introduce
          // executable draw-code through a whole-array patch.
          if (Array.isArray(top.freeElements)) {
            top.freeElements = (top.freeElements as { kind?: string }[]).filter(el => el?.kind !== 'custom');
          }
          partial.settings = top as Partial<CarouselSettings>;
        }
        applySlidePartial(action.slideId, partial);
        // Readable diff: headline/subheadline text + the scalar settings the AI actually changed, e.g.
        // "Set fontSize 68→88 · color #fff→#111"; falls back to the generic label otherwise. `slide`
        // still references the pre-apply state (applySlidePartial swaps in a new object).
        const textDiff = summarizeDiff(
          { headline: slide.headline, subheadline: slide.subheadline },
          {
            ...(action.headline !== undefined ? { headline: action.headline } : {}),
            ...(action.subheadline !== undefined ? { subheadline: action.subheadline } : {}),
          },
        );
        const settingsDiff = summarizeDiff(slide.settings as unknown as Record<string, unknown>, (action.settings ?? {}) as Record<string, unknown>);
        const parts = [...textDiff, ...settingsDiff].slice(0, 4);
        return parts.length ? `Set ${parts.join(' · ')}` : describeAction(action);
      }
      case 'patch_text_box': {
        const before = (slideOf(action.slideId).settings.textBoxes ?? []).find(b => b.id === action.id) as Record<string, unknown> | undefined;
        replaceItem<TextBoxStyle>(action.slideId, 'textBoxes', action.id, box =>
          ({ ...mergePatch(box as unknown as Record<string, unknown>, action.patch as Record<string, unknown>), id: box.id }) as unknown as TextBoxStyle);
        return diffLabel(before, action.patch as Record<string, unknown>, describeAction(action));
      }
      case 'patch_image_box': {
        const before = (slideOf(action.slideId).settings.imageBoxes ?? []).find(b => b.id === action.id) as Record<string, unknown> | undefined;
        replaceItem<ImageBox>(action.slideId, 'imageBoxes', action.id, box =>
          ({ ...mergePatch(box as unknown as Record<string, unknown>, action.patch as Record<string, unknown>), id: box.id }) as unknown as ImageBox);
        return diffLabel(before, action.patch as Record<string, unknown>, describeAction(action));
      }
      case 'patch_free_element': {
        const slide = slideOf(action.slideId);
        const el = (slide.settings.freeElements ?? []).find(item => item.id === action.id);
        if (!el) throw new Error(`No element with id ${action.id} on that slide`);
        const problem = validateFreeElementPatch(el.kind, action.patch);
        if (problem) throw new Error(`Invalid element patch: ${problem}`);
        replaceItem<FreeElement>(action.slideId, 'freeElements', action.id, item =>
          ({ ...mergePatch(item as unknown as Record<string, unknown>, action.patch), id: item.id, kind: item.kind }) as unknown as FreeElement);
        return diffLabel(el as unknown as Record<string, unknown>, action.patch as Record<string, unknown>, describeAction(action));
      }
      case 'add_text_box': {
        const slide = slideOf(action.slideId);
        const box = { ...action.textBox, id: deps.genId('tb') } as TextBoxStyle;
        applySlidePartial(action.slideId, { settings: { textBoxes: [...slide.settings.textBoxes, box] } });
        return describeAction(action);
      }
      case 'add_image_box': {
        const slide = slideOf(action.slideId);
        const box = { ...action.imageBox, id: deps.genId('ib') } as ImageBox;
        applySlidePartial(action.slideId, { settings: { imageBoxes: [...slide.settings.imageBoxes, box] } });
        return describeAction(action);
      }
      case 'add_free_element': {
        const slide = slideOf(action.slideId);
        const el = { ...action.element, id: deps.genId('fe') } as FreeElement;
        applySlidePartial(action.slideId, { settings: { freeElements: [...(slide.settings.freeElements ?? []), el] } });
        return describeAction(action);
      }
      case 'remove_item': {
        const slide = slideOf(action.slideId);
        const arr = (slide.settings[action.field] ?? []) as { id: string }[];
        if (!arr.some(item => item.id === action.id)) throw new Error(`No ${action.field} item with id ${action.id}`);
        applySlidePartial(action.slideId, {
          settings: { [action.field]: arr.filter(item => item.id !== action.id) } as Partial<CarouselSettings>,
        });
        return describeAction(action);
      }
      case 'create_slide': {
        // addSlide computes position/name from the last-RENDER slides closure, so a second create in the
        // same turn would insert a duplicate position (nondeterministic order after reload).
        if (createdSlideThisTurn) throw new Error('Only one slide can be created per request — ask again for the next one.');
        createdSlideThisTurn = true;
        const id = await deps.addSlide(action.name);
        if (!id) throw new Error('Could not create the slide');
        return describeAction(action);
      }
      case 'rename_slide':
        slideOf(action.slideId);
        await deps.renameSlide(action.slideId, action.name);
        return describeAction(action);
      case 'select_slide':
        slideOf(action.slideId);
        deps.selectSlide(action.slideId);
        return describeAction(action);
      case 'generate_element':
        // Handled by the panel (it owns the element-generation pipeline) — reaching here is a bug.
        throw new Error('generate_element must be handled by the panel');
    }
  };

  const outcomes: ApplyOutcome[] = [];
  for (const action of actions) {
    try {
      outcomes.push({ ok: true, label: await applyOne(action) });
    } catch (e) {
      outcomes.push({ ok: false, error: e instanceof Error ? e.message : 'A change failed to apply.' });
    }
  }
  return {
    outcomes,
    labels: outcomes.filter(o => o.ok).map(o => o.label!),
    problems: outcomes.filter(o => !o.ok).map(o => o.error!),
  };
}
