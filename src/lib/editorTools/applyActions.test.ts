import { describe, it, expect, vi } from 'vitest';
import { applyCarouselActions, type ApplyDeps } from './applyActions';
import type { AgentAction } from './agentActions';
import type { SlideRow } from '@/app/components/templateEditorRows';
import type { CarouselSettings } from '@/app/components/templateEditorTypes';

// Regression tests for the copilot's deterministic apply core. The point of the working copy is that a
// multi-action turn threads its own edits — so the tests here are written to FAIL against a naive
// "read the original slides for every action" implementation (see the mutation note in each block).

function slide(id: string, settings: Partial<CarouselSettings> = {}): SlideRow {
  return {
    id, templateId: 't1', name: id, position: 0, headline: 'Headline', subheadline: 'Sub',
    settings: { textBoxes: [], imageBoxes: [], freeElements: [], fontSize: 68, ...settings } as CarouselSettings,
  };
}
const act = (o: Record<string, unknown>) => o as unknown as AgentAction;

// Deterministic deps: an id counter (tb-1, tb-2, …) and spies for the editor side-effects.
function makeDeps() {
  let n = 0;
  const updateSlide = vi.fn<(id: string, partial: { settings?: Record<string, unknown>; headline?: string; subheadline?: string }) => void>();
  const addSlide = vi.fn(async (_name?: string) => 'created-slide');
  const renameSlide = vi.fn(async () => {});
  const selectSlide = vi.fn();
  const deps: ApplyDeps = { genId: (p: string) => `${p}-${++n}`, updateSlide, addSlide, renameSlide, selectSlide };
  return { deps, updateSlide, addSlide, renameSlide, selectSlide };
}
// The settings partial sent to updateSlide on the Nth call.
const settingsOnCall = (updateSlide: ReturnType<typeof makeDeps>['updateSlide'], n: number) =>
  (updateSlide.mock.calls[n][1].settings ?? {}) as Record<string, unknown>;

describe('applyCarouselActions — working-copy threading (would fail without it)', () => {
  it('two add_text_box on the SAME slide: the second array includes the first box', async () => {
    const { deps, updateSlide } = makeDeps();
    const actions = [
      act({ type: 'add_text_box', slideId: 's1', textBox: { text: 'A' } }),
      act({ type: 'add_text_box', slideId: 's1', textBox: { text: 'B' } }),
    ];
    const { outcomes } = await applyCarouselActions([slide('s1')], actions, deps);
    expect(outcomes.every(o => o.ok)).toBe(true);
    const boxes = settingsOnCall(updateSlide, 1).textBoxes as Array<{ id: string; text: string }>;
    // Naive (stale-read) impl would send [B] only → length 1. Threaded → both survive.
    expect(boxes).toHaveLength(2);
    expect(boxes.map(b => b.id)).toEqual(['tb-1', 'tb-2']);
  });

  it('two remove_item on the SAME slide: both removals stick', async () => {
    const { deps, updateSlide } = makeDeps();
    const s = slide('s1', { textBoxes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as unknown as CarouselSettings['textBoxes'] });
    const actions = [
      act({ type: 'remove_item', slideId: 's1', field: 'textBoxes', id: 'a' }),
      act({ type: 'remove_item', slideId: 's1', field: 'textBoxes', id: 'b' }),
    ];
    await applyCarouselActions([s], actions, deps);
    const boxes = settingsOnCall(updateSlide, 1).textBoxes as Array<{ id: string }>;
    // Naive impl removes only 'b' from the original → [a, c]. Threaded → [c].
    expect(boxes.map(b => b.id)).toEqual(['c']);
  });

  it('two patches to a nested tagStyle merge instead of clobbering', async () => {
    const { deps, updateSlide } = makeDeps();
    const s = slide('s1', { tagStyle: { text: 'orig', fontSize: 22, textColor: '#fff' } } as unknown as Partial<CarouselSettings>);
    const actions = [
      act({ type: 'patch_slide', slideId: 's1', settings: { tagStyle: { text: 'NEW' } } }),
      act({ type: 'patch_slide', slideId: 's1', settings: { tagStyle: { fontSize: 99 } } }),
    ];
    await applyCarouselActions([s], actions, deps);
    const tag = settingsOnCall(updateSlide, 1).tagStyle as Record<string, unknown>;
    // Naive impl reads the original tagStyle for action 2 → text back to 'orig'. Threaded → keeps 'NEW'.
    expect(tag).toMatchObject({ text: 'NEW', fontSize: 99 });
  });
});

describe('applyCarouselActions — isolation + dispatch', () => {
  it('edits to different slides do not leak into each other', async () => {
    const { deps, updateSlide } = makeDeps();
    const actions = [
      act({ type: 'add_text_box', slideId: 's1', textBox: { text: 'A' } }),
      act({ type: 'add_text_box', slideId: 's2', textBox: { text: 'B' } }),
    ];
    await applyCarouselActions([slide('s1'), slide('s2')], actions, deps);
    expect(updateSlide.mock.calls[0][0]).toBe('s1');
    expect(updateSlide.mock.calls[1][0]).toBe('s2');
    expect((settingsOnCall(updateSlide, 1).textBoxes as unknown[])).toHaveLength(1);   // s2 only has its own box
  });

  it('add_text_box mints the INJECTED id (deterministic) and appends', async () => {
    const { deps, updateSlide } = makeDeps();
    await applyCarouselActions([slide('s1', { textBoxes: [{ id: 'existing' }] as unknown as CarouselSettings['textBoxes'] })], [act({ type: 'add_text_box', slideId: 's1', textBox: { text: 'A' } })], deps);
    const boxes = settingsOnCall(updateSlide, 0).textBoxes as Array<{ id: string }>;
    expect(boxes.map(b => b.id)).toEqual(['existing', 'tb-1']);
  });

  it('structural actions dispatch to the editor', async () => {
    const { deps, addSlide, renameSlide, selectSlide } = makeDeps();
    await applyCarouselActions([slide('s1')], [
      act({ type: 'create_slide', name: 'New' }),
      act({ type: 'rename_slide', slideId: 's1', name: 'Renamed' }),
      act({ type: 'select_slide', slideId: 's1' }),
    ], deps);
    expect(addSlide).toHaveBeenCalledWith('New');
    expect(renameSlide).toHaveBeenCalledWith('s1', 'Renamed');
    expect(selectSlide).toHaveBeenCalledWith('s1');
  });

  it('allows only one create_slide per turn', async () => {
    const { deps, addSlide } = makeDeps();
    const { outcomes } = await applyCarouselActions([slide('s1')], [
      act({ type: 'create_slide', name: 'A' }),
      act({ type: 'create_slide', name: 'B' }),
    ], deps);
    expect(outcomes[0].ok).toBe(true);
    expect(outcomes[1].ok).toBe(false);
    expect(addSlide).toHaveBeenCalledTimes(1);
  });
});

describe('applyCarouselActions — security + resilience', () => {
  it('strips a custom free-element from a whole-array patch_slide.freeElements (defense-in-depth)', async () => {
    const { deps, updateSlide } = makeDeps();
    const actions = [act({ type: 'patch_slide', slideId: 's1', settings: { freeElements: [
      { kind: 'custom', id: 'x', code: 'ctx.fillRect(0,0,1,1)' },
      { kind: 'text', id: 't' },
    ] } })];
    await applyCarouselActions([slide('s1')], actions, deps);
    const fe = settingsOnCall(updateSlide, 0).freeElements as Array<{ kind: string }>;
    expect(fe).toHaveLength(1);
    expect(fe[0].kind).toBe('text');   // the executable 'custom' element never reaches the editor
  });

  it('an invalid item reference fails only that action, and the rest of the batch applies', async () => {
    const { deps, updateSlide } = makeDeps();
    const actions = [
      act({ type: 'patch_text_box', slideId: 's1', id: 'does-not-exist', patch: { fontSize: 40 } }),
      act({ type: 'patch_slide', slideId: 's1', settings: { fontSize: 88 } }),
    ];
    const { outcomes, labels, problems } = await applyCarouselActions([slide('s1')], actions, deps);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[1].ok).toBe(true);
    expect(problems).toHaveLength(1);
    expect(labels).toHaveLength(1);
    expect(updateSlide).toHaveBeenCalledTimes(1);   // only the valid action reached the editor
  });

  it('a missing slide id fails that action without throwing the batch', async () => {
    const { deps } = makeDeps();
    const { outcomes } = await applyCarouselActions([slide('s1')], [act({ type: 'patch_slide', slideId: 'ghost', settings: { fontSize: 80 } })], deps);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].error).toContain('No slide');
  });
});

describe('applyCarouselActions — readable diff labels', () => {
  it('patch_slide reports the actual value change', async () => {
    const { deps } = makeDeps();
    const { labels } = await applyCarouselActions([slide('s1', { fontSize: 68 })], [act({ type: 'patch_slide', slideId: 's1', settings: { fontSize: 88 } })], deps);
    expect(labels[0]).toContain('fontSize 68→88');
  });
});
