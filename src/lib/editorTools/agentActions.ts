// The copilot action protocol — what the editor agent (/api/editor/agent) may ask the client to
// do. Shared by the route (validates the model's output) and the panel/grid (applies actions
// through the editor hook, so every AI edit lands in the normal autosave + undo pipeline).
//
// Actions are deliberately CLIENT-applied: the editor stays the single source of truth, ⌘Z undoes
// an AI step like any user edit, and nothing writes the DB behind the open editor's back. The
// /api/editor/tools verbs are the headless twin for automations/MCP.

import { z } from 'zod';
import {
  zCarouselSettingsPatch, zTagStylePatch, zSwipeStylePatch, zNullableShadowPatch,
  zTextBoxPatch, zImageBoxPatch,
  zTextBoxStyle, zImageBox, zFreeElement, zDividerStyleSettings,
} from './carouselSchema';
import { defaultTagStyle, defaultSwipeStyle, defaultTextBox } from '@/app/components/templateEditorTypes';

// New items are stored WITHOUT a caller-supplied id (the client assigns one at apply time). But the
// model, mirroring the state JSON it was shown (where everything HAS an id), routinely echoes an "id"
// on the new item — which the strict branch rejected as an unknown key, silently dropping the whole add.
// Strip it. Shared by the text/image/free-element add paths.
function withoutId(v: Record<string, unknown>): Record<string, unknown> {
  const { id: _drop, ...rest } = v;
  return rest;
}

// A NEW text box: fill the many required style fields the model tends to omit (opacity, lineHeight,
// letterSpacing…) from the editor's OWN default box, then drop the id. If the model wrote real text,
// switch OFF the placeholder-filler default so its words actually render (the box otherwise shows lorem).
function normalizeNewTextBox(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const tb = v as Record<string, unknown>;
  const merged = withoutId({ ...defaultTextBox(), ...tb });
  if ('spans' in merged) merged.spans = normalizeSpans(merged.spans);   // rich runs use "weight", not "fontWeight"
  const wroteText = typeof tb.text === 'string' && tb.text.trim().length > 0;
  if (wroteText && !('fillPlaceholder' in tb)) merged.fillPlaceholder = false;
  return merged;
}
const zNewTextBoxStrict = zTextBoxStyle.omit({ id: true });
const zNewTextBox = z.preprocess(normalizeNewTextBox, zNewTextBoxStrict) as unknown as typeof zNewTextBoxStrict;

// A NEW image box: only strip the id. Deliberately NOT default-filled — an image box is defined by its
// `url`, which we can't invent; a box with a placeholder/missing url must FAIL, not materialize broken
// content. (The copilot can only reference urls already in the state — see the ATTACHED IMAGE prompt rule.)
const zNewImageBoxStrict = zImageBox.omit({ id: true });
const zNewImageBox = z.preprocess(v => (v && typeof v === 'object' && !Array.isArray(v) ? withoutId(v as Record<string, unknown>) : v), zNewImageBoxStrict) as unknown as typeof zNewImageBoxStrict;

// .omit over the union's branches — the per-branch shapes differ, so TS can't type the mapped
// call; each branch IS a ZodObject, so the runtime is sound and we re-type the result.
// SECURITY: the 'custom' branch is EXCLUDED — copilot actions must never author sandbox-bypassing
// element code. Charts/tables go through generate_element (the gated /api/elements pipeline).
const zNewFreeElementStrict = z.discriminatedUnion(
  'kind',
  zFreeElement.options
    .filter(o => o.shape.kind.value !== 'custom')
    .map(o => (o as z.ZodObject<z.ZodRawShape>).omit({ id: true })) as never,
) as unknown as z.ZodType<Omit<Exclude<z.infer<typeof zFreeElement>, { kind: 'custom' }>, 'id'>>;

// A NEW tag/swipe from the copilot almost always arrives with only the fields the model cares about
// (a tag's bgColor + text, say) and OMITS the boilerplate the full style requires (border, italic,
// letterSpacing…). Those omissions used to fail the strict branch and the whole action was silently
// dropped — so "add a NEWS tag" did nothing. Fill the missing fields from the editor's OWN defaults
// (the same factories the UI uses) BEFORE the strict branch validates, and strip any echoed id. Merge is
// default←model, so any field the model actually sent wins; genuinely bad VALUES (fontSize:"big") still
// fail zod afterward. (logo/quote/divider aren't filled — a logo needs a url we can't invent, the rest
// carry no required style.)
function normalizeNewFreeElement(el: unknown): unknown {
  if (!el || typeof el !== 'object' || Array.isArray(el)) return el;
  const e = withoutId(el as Record<string, unknown>);
  const style = e.style && typeof e.style === 'object' && !Array.isArray(e.style)
    ? (e.style as Record<string, unknown>) : {};
  if (e.kind === 'tag') return { ...e, style: { ...defaultTagStyle(), ...style } };
  if (e.kind === 'swipe') return { ...e, style: { ...defaultSwipeStyle(), ...style } };
  return e;
}
const zNewFreeElement = z.preprocess(normalizeNewFreeElement, zNewFreeElementStrict) as unknown as typeof zNewFreeElementStrict;

// The model hand-writes span runs (rich text) with "fontWeight" — the skeleton/box key — instead of the
// span key "weight". Rename it so the run validates instead of the whole spans array being rejected.
function normalizeSpans(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return v.map(s => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
    const run = s as Record<string, unknown>;
    if (!('fontWeight' in run)) return s;
    const { fontWeight, ...rest } = run;   // strip the wrong key; map it to weight only if weight is unset
    return run.weight === undefined ? { ...rest, weight: fontWeight } : rest;
  });
}

// The same rich-run shape also lives INSIDE text boxes (spans). Route a text box's spans through the
// same rename so an add_text_box / patch_text_box / settings.textBoxes[] run written with "fontWeight"
// isn't dropped — or, worst case on the whole-array path, silently pruned while the action reports success.
function normalizeTextBoxSpans(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const tb = v as Record<string, unknown>;
  return 'spans' in tb ? { ...tb, spans: normalizeSpans(tb.spans) } : v;
}

// A resilient settings patch: KEEP every field the model got right and DROP only the ones it invented or
// mistyped, rather than the strict schema rejecting the ENTIRE restyle over one bad key (the model
// routinely sprinkles in a hallucinated "fadeColor", or sends "fadeFloor" as a string). One dropped tweak
// beats a dropped restyle. Spans are renamed first so a fontWeight→weight run survives the field check.
//
// SECURITY — fail closed on freeElements: it is the ONE settings field that can carry element draw-code,
// and the patch union deliberately drops the 'custom' branch (customElements/runtime.ts runs code via
// `new Function`). If freeElements is present but does NOT validate, we must NOT silently prune it and let
// the rest through — that would quietly swallow a code-injection attempt. Instead return the raw object so
// the strict schema rejects the WHOLE action (loud, fail-closed), preserving the code-injection guard.
function sanitizeSettingsPatch(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const shape = zCarouselSettingsPatch.shape as Record<string, z.ZodTypeAny>;
  const src: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if ('headlineSpans' in src) src.headlineSpans = normalizeSpans(src.headlineSpans);
  if ('subSpans' in src) src.subSpans = normalizeSpans(src.subSpans);
  if (Array.isArray(src.textBoxes)) src.textBoxes = src.textBoxes.map(normalizeTextBoxSpans);
  // SECURITY fail-closed: a NON-NULL freeElements that fails validation may carry excluded custom
  // draw-code, so reject the whole action rather than silently pruning it. null/absent carries no code —
  // let it fall through and be pruned like any other invalid field (don't over-reject a benign clear).
  if ('freeElements' in src && src.freeElements != null && !shape.freeElements.safeParse(src.freeElements).success) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(src)) {
    // Object.hasOwn, NOT `shape[k]` truthiness: a key like "toString"/"constructor"/"__proto__" resolves
    // to an Object.prototype MEMBER (truthy, no .safeParse) and would throw. Own-key check drops those.
    if (!Object.hasOwn(shape, k)) continue;
    if (shape[k].safeParse(val).success) out[k] = val;   // known key, valid value → keep; else drop
  }
  return out;
}
const zSettingsPatch = z.preprocess(sanitizeSettingsPatch, zCarouselSettingsPatch) as unknown as typeof zCarouselSettingsPatch;

export const zAgentAction = z.discriminatedUnion('type', [
  // Style/content changes on one slide. `settings` is a top-level-partial patch: nested objects
  // merge deep, arrays replace whole (mergePatch semantics).
  z.strictObject({
    type: z.literal('patch_slide'),
    slideId: z.string(),
    headline: z.string().optional(),
    subheadline: z.string().optional(),
    settings: zSettingsPatch.optional(),
  }),
  // Targeted single-item patches — cheaper and safer than resending whole arrays.
  z.strictObject({ type: z.literal('patch_text_box'), slideId: z.string(), id: z.string(), patch: z.preprocess(normalizeTextBoxSpans, zTextBoxPatch) as unknown as typeof zTextBoxPatch }),
  z.strictObject({ type: z.literal('patch_image_box'), slideId: z.string(), id: z.string(), patch: zImageBoxPatch }),
  // Free elements are a discriminated union; `kind` cannot be patched. The patch is validated
  // against the matched element's kind branch at apply time.
  z.strictObject({ type: z.literal('patch_free_element'), slideId: z.string(), id: z.string(), patch: z.record(z.string(), z.unknown()) }),
  z.strictObject({ type: z.literal('add_text_box'), slideId: z.string(), textBox: zNewTextBox }),
  z.strictObject({ type: z.literal('add_image_box'), slideId: z.string(), imageBox: zNewImageBox }),
  z.strictObject({ type: z.literal('add_free_element'), slideId: z.string(), element: zNewFreeElement }),
  z.strictObject({
    type: z.literal('remove_item'),
    slideId: z.string(),
    field: z.enum(['textBoxes', 'imageBoxes', 'freeElements']),
    id: z.string(),
  }),
  z.strictObject({ type: z.literal('create_slide'), name: z.string().optional() }),
  z.strictObject({ type: z.literal('rename_slide'), slideId: z.string(), name: z.string().min(1) }),
  z.strictObject({ type: z.literal('select_slide'), slideId: z.string() }),
  // Hand off to the specialized custom-element generator (charts/tables/etc. — the existing
  // /api/elements/generate pipeline with vision grounding). refine=true continues the previous
  // element's code; default is a FRESH element (no cross-element refine contamination).
  z.strictObject({ type: z.literal('generate_element'), prompt: z.string().min(1), refine: z.boolean().optional() }),
]);

export type AgentAction = z.infer<typeof zAgentAction>;

// The full agent response envelope.
export const zAgentResponse = z.object({
  reply: z.string(),
  actions: z.array(z.unknown()).optional(),
});

// Per-kind deep-partial overrides so nested style patches ({style:{textColor}}) validate.
const FREE_ELEMENT_PATCH_OVERRIDES: Record<string, z.ZodRawShape> = {
  tag: { style: zTagStylePatch.optional() },
  swipe: { style: zSwipeStylePatch.optional() },
  logo: { shadow: zNullableShadowPatch.optional() },
  divider: { settings: zDividerStyleSettings.partial().nullable().optional() },
};

/** Validate a free-element patch against the branch schema for the element's kind. */
export function validateFreeElementPatch(kind: string, patch: Record<string, unknown>): string | null {
  if ('kind' in patch) return "an element's kind cannot be changed — remove it and add a new one";
  // SECURITY: custom elements carry executable draw-code. The copilot may move/resize/hide them,
  // never rewrite their code, schema or data — that's the gated element-generator's job.
  if (kind === 'custom') {
    const banned = ['code', 'inputSchema', 'data', 'elementId'].filter(k => k in patch);
    if (banned.length > 0) return `custom elements can only be moved/resized/renamed here (not: ${banned.join(', ')}) — regenerate via the element builder instead`;
  }
  const branch = zFreeElement.options.find(o => o.shape.kind.value === kind);
  if (!branch) return `unknown element kind "${kind}"`;
  const schema = (branch as z.ZodObject<z.ZodRawShape>)
    .omit({ id: true })
    .partial()
    .extend(FREE_ELEMENT_PATCH_OVERRIDES[kind] ?? {});
  const res = schema.safeParse(patch);
  if (!res.success) return res.error.issues.map((i: z.core.$ZodIssue) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return null;
}

/** Compact per-action label for the applied-changes chips in the chat. */
export function describeAction(action: AgentAction): string {
  switch (action.type) {
    case 'patch_slide': {
      const keys = Object.keys(action.settings ?? {});
      const parts = [
        action.headline !== undefined && 'headline',
        action.subheadline !== undefined && 'sub-headline',
        keys.length > 0 && (keys.length <= 3 ? keys.join(', ') : `${keys.length} settings`),
      ].filter(Boolean);
      return `Updated ${parts.join(' + ') || 'slide'}`;
    }
    case 'patch_text_box': return 'Updated a text box';
    case 'patch_image_box': return 'Updated an image box';
    case 'patch_free_element': return 'Updated an element';
    case 'add_text_box': return 'Added a text box';
    case 'add_image_box': return 'Added an image';
    case 'add_free_element': return `Added a ${action.element.kind} element`;
    case 'remove_item': return 'Removed an element';
    case 'create_slide': return `Added slide${action.name ? ` "${action.name}"` : ''}`;
    case 'rename_slide': return `Renamed slide to "${action.name}"`;
    case 'select_slide': return 'Switched slide';
    case 'generate_element': return 'Generating a custom element…';
  }
}
