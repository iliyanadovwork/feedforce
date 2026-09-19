// Zod schemas mirroring the carousel editor's settings types (templateEditorTypes.ts) — the
// validation gate for the editor tools API (AI copilot / MCP / automations). Framework-neutral.
//
// Design rules:
//   * `zCarouselSettings` is STRICT: unknown keys are rejected, so a model that hallucinates a
//     field name gets a fixable error instead of silently writing junk.
//   * Patches are `zCarouselSettingsPatch` (deep-partial at the TOP level only): any subset of
//     top-level fields; nested objects/arrays are sent WHOLE and replace the current value
//     (predictable merge semantics — see mergePatch in compact.ts).
//   * Constraints mirror the documented ranges only where a wrong value would corrupt rendering
//     (opacities 0-100, enums, weight steps). Sizes/positions stay loose — the canvas clamps.
//   * Drift guard: editorTools.test.ts asserts mutual type assignability with CarouselSettings
//     and that defaultCarouselSettings() parses. If templateEditorTypes.ts gains a field, the
//     test fails until it's added here.
//
// NB: the hidden-flag fields (tagSlotsHidden, tagZoneHidden, quoteSlotsHidden, quoteZoneHidden,
// swipeZoneHidden) are part of CarouselSettings but are NOT persisted by slideToRow (no DB
// columns) — patches to them validate but do not survive a reload. Kept for parity with the type.

import { z } from 'zod';
import type { CarouselFontWeight } from '@/app/components/templateEditorTypes';

const pct = z.number().min(0).max(100);

// Font weights are exactly the 100-step values 100..900 — validated numerically but typed as the
// literal union so z.infer stays assignable to CarouselFontWeight.
export const zFontWeight = z.custom<CarouselFontWeight>(
  v => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 900 && v % 100 === 0,
  { message: 'fontWeight must be one of 100,200,…,900' },
);

export const zTextAlign = z.enum(['left', 'center', 'right', 'justify']);
export const zShape = z.enum(['rect', 'circle']);

export const zShadowStyle = z.strictObject({
  enabled: z.boolean(),
  color: z.string(),
  blur: z.number(),
  offsetX: z.number(),
  offsetY: z.number(),
  opacity: pct,
  lift: z.number(),
});

export const zTagStyle = z.strictObject({
  bgColor: z.string(),
  bgOpacity: pct,
  borderColor: z.string(),
  borderWidth: z.number(),
  borderOpacity: pct,
  cornerRadius: z.number(),
  textColor: z.string(),
  fontSize: z.number(),
  fontWeight: zFontWeight,
  italic: z.boolean(),
  fontLabel: z.string(),
  paddingX: z.number(),
  paddingY: z.number(),
  letterSpacing: z.number(),
  textCase: z.enum(['none', 'upper', 'smallcaps']),
  shadow: zShadowStyle.optional(),
});

export const zSwipeStyle = z.strictObject({
  text: z.string(),
  allCaps: z.boolean(),
  fontLabel: z.string(),
  fontWeight: zFontWeight,
  fontSize: z.number(),
  textColor: z.string(),
  letterSpacing: z.number(),
  arrowType: z.enum(['line', 'triangle', 'chevron', 'double-chevron', 'curved']),
  arrowLength: z.number(),
  arrowColor: z.string(),
  arrowWeight: z.number(),
  arrowHeadSize: z.number(),
  direction: z.enum(['left', 'right']),
  layout: z.enum(['text-arrow', 'arrow-text', 'stacked', 'arrow-only', 'text-only']),
  gap: z.number(),
  opacity: pct,
  shadow: zShadowStyle.optional(),
});

export const zTextSpan = z.strictObject({
  text: z.string(),
  color: z.string().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  weight: z.number().optional(),
});

export const zSlotCrop = z.strictObject({
  x: z.number().optional(),
  y: z.number().optional(),
  zoom: z.number().optional(),
});

export const zDividerSubSlotContent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('image'), url: z.string(), crop: zSlotCrop.optional() }),
  z.strictObject({ type: z.literal('tag'), text: z.string(), style: zTagStyle }),
  z.strictObject({ type: z.literal('swipe'), style: zSwipeStyle }),
]);

export const zDividerStyleSettings = z.strictObject({
  lineColor: z.string(),
  lineOpacity: pct,
  lineWeight: z.number(),
  dashLen: z.number(),
  dashGap: z.number(),
  dotSize: z.number(),
  dotSpacing: z.number(),
  doubleSpacing: z.number(),
  tripleSpacing: z.number(),
  centerWeight: z.number(),
  dotRadius: z.number(),
  dotGap: z.number(),
  taperHeight: z.number(),
  shortLength: z.number(),
  waveAmplitude: z.number(),
  bracketWidth: z.number(),
  bracketMargin: z.number(),
  contentGap: z.number(),
  fadeSpread: z.number(),
  shadow: zShadowStyle.optional(),
});

export const zTextBoxStyle = z.strictObject({
  id: z.string(),
  text: z.string(),
  x: z.number(),
  y: z.number(),
  fontLabel: z.string(),
  fontSize: z.number(),
  fontWeight: zFontWeight,
  secondaryWeight: zFontWeight.optional(),
  italic: z.boolean(),
  allCaps: z.boolean().optional(),
  spans: z.array(zTextSpan).optional(),
  fillPlaceholder: z.boolean().optional(),
  placeholderWords: z.number().optional(),
  color: z.string(),
  align: zTextAlign,
  fitToWidth: z.boolean().optional(),
  vAlign: z.enum(['top', 'middle', 'bottom']),
  width: z.number(),
  height: z.number(),
  letterSpacing: z.number(),
  lineHeight: z.number(),
  opacity: pct,
  shadow: zShadowStyle.optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  label: z.string().optional(),
});

export const zFadeStop = z.strictObject({
  loc: z.number(),
  opacity: pct,
  mid: z.number().optional(),
});

export const zImageBoxFade = z.strictObject({
  enabled: z.boolean().optional(),
  top: z.number(),
  bottom: z.number(),
  left: z.number(),
  right: z.number(),
  color: z.string().optional(),
  stops: z
    .object({
      top: z.array(zFadeStop).optional(),
      bottom: z.array(zFadeStop).optional(),
      left: z.array(zFadeStop).optional(),
      right: z.array(zFadeStop).optional(),
    })
    .optional(),
});

export const zImageBoxCrop = z.strictObject({
  top: z.number(),
  bottom: z.number(),
  left: z.number(),
  right: z.number(),
});

export const zImageEffects = z.strictObject({
  brightness: z.number().optional(),
  blur: z.number().optional(),
  noise: z.number().optional(),
  blurEdgeFade: z.boolean().optional(),
});

export const zImageBoxPerspective = z.strictObject({
  tl: z.strictObject({ x: z.number(), y: z.number() }),
  tr: z.strictObject({ x: z.number(), y: z.number() }),
  br: z.strictObject({ x: z.number(), y: z.number() }),
  bl: z.strictObject({ x: z.number(), y: z.number() }),
});

export const zImageBox = z.strictObject({
  id: z.string(),
  url: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  opacity: pct,
  cornerRadius: z.number(),
  shape: zShape.optional(),
  aspect: z.number().optional(),
  shadow: zShadowStyle.optional(),
  fade: zImageBoxFade.optional(),
  bgFade: zImageBoxFade.optional(),
  crop: zImageBoxCrop.optional(),
  circleCrop: zSlotCrop.optional(),
  perspective: zImageBoxPerspective.optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  blend: z.string().optional(),
  isOverlay: z.boolean().optional(),
  videoUrl: z.string().optional(),
  videoMuted: z.boolean().optional(),
  splitEnabled: z.boolean().optional(),
  fgUrl: z.string().optional(),
  fgEffects: zImageEffects.optional(),
  bgEffects: zImageEffects.optional(),
});

// AI custom elements carry a typed data-binding schema (same shape as ElementInput in
// customElements/runtime.ts).
export const zElementInput = z.strictObject({
  key: z.string(),
  label: z.string(),
  dataType: z.enum(['number', 'string', 'array', 'object', 'series', 'ohlc']),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

const freeElementBase = {
  id: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  hidden: z.boolean().optional(),
};

export const zFreeElement = z.discriminatedUnion('kind', [
  z.strictObject({ ...freeElementBase, kind: z.literal('tag'), text: z.string(), style: zTagStyle }),
  z.strictObject({ ...freeElementBase, kind: z.literal('quote'), styleId: z.string() }),
  z.strictObject({ ...freeElementBase, kind: z.literal('swipe'), style: zSwipeStyle }),
  z.strictObject({
    ...freeElementBase,
    kind: z.literal('logo'),
    url: z.string(),
    opacity: z.number().optional(),
    scale: z.number().optional(),
    cornerRadius: z.number().optional(),
    shape: zShape.optional(),
    shadow: zShadowStyle.optional(),
  }),
  z.strictObject({
    ...freeElementBase,
    kind: z.literal('divider'),
    dividerId: z.string(),
    settings: zDividerStyleSettings.partial().nullable().optional(),
    sub: zDividerSubSlotContent.nullable().optional(),
  }),
  z.strictObject({
    ...freeElementBase,
    kind: z.literal('custom'),
    elementId: z.string(),
    name: z.string(),
    code: z.string(),
    inputSchema: z.array(zElementInput).optional(),
    data: z.unknown().optional(),
  }),
]);

export const zZoneLogoStyle = z.strictObject({
  opacity: z.number().optional(),
  scale: z.number().optional(),
  cornerRadius: z.number().optional(),
  shape: zShape.optional(),
  shadow: zShadowStyle.optional(),
  hidden: z.boolean().optional(),
});

const zTagSlot = z.strictObject({ text: z.string(), style: zTagStyle });
const zRowAlign = z.enum(['left', 'center', 'right']);
export const zLayerId = z.enum(['background', 'circle', 'circle2', 'subject']);

// ── The full settings object ─────────────────────────────────────────────────
export const zCarouselSettings = z.strictObject({
  showFade: z.boolean(),
  fadeReach: z.number(),
  fadeIntensity: z.number(),
  fadeFloor: z.number(),
  showTopFade: z.boolean(),
  topFadeReach: z.number(),
  topFadeIntensity: z.number(),
  topFadeFloor: z.number(),
  fontSize: z.number(),
  lSpacing: z.number(),
  lHeight: z.number(),
  fontLabel: z.string(),
  fontWeight: zFontWeight,
  italic: z.boolean(),
  textAlign: zTextAlign,
  allCaps: z.boolean(),
  subFontSize: z.number(),
  subLSpacing: z.number(),
  subLHeight: z.number(),
  subFontLabel: z.string(),
  subFontWeight: zFontWeight,
  subItalic: z.boolean(),
  subTextAlign: zTextAlign,
  subAllCaps: z.boolean(),
  headSubGap: z.number(),
  aboveLogoGap: z.number(),
  logoOpacity: pct,
  logoScale: z.number(),
  logoCornerRadius: z.number(),
  logoShape: zShape.optional(),
  imageShape: zShape.optional(),
  contentPadding: z.number(),
  tagStyle: zTagStyle,
  tagSlots: z.array(zTagSlot.nullable()).max(3),
  tagSlotsHidden: z.array(z.boolean().nullable()).optional(),
  tagSlotAligns: z.array(zRowAlign).optional(),
  logoSlotAligns: z.array(zRowAlign).optional(),
  tagZoneSlots: z.array(zTagSlot.nullable()).max(9).optional(),
  tagZoneHidden: z.array(z.boolean().nullable()).optional(),
  quoteZoneSlots: z.array(z.string().nullable()).max(9).optional(),
  quoteZoneHidden: z.array(z.boolean().nullable()).optional(),
  zoneLogoSlots: z.array(z.string().nullable()).max(9).optional(),
  zoneLogoStyles: z.array(zZoneLogoStyle.nullable()).max(9).optional(),
  logoRowSlots: z.array(z.string().nullable()).max(3).optional(),
  swipeZoneSlots: z.array(zSwipeStyle.nullable()).max(9).optional(),
  swipeZoneHidden: z.array(z.boolean().nullable()).optional(),
  freeElements: z.array(zFreeElement).optional(),
  bgBlurEnabled: z.boolean(),
  bgBlurAmount: z.number(),
  bgDarkenAmount: z.number(),
  canvasColor: z.string(),
  canvasTransparent: z.boolean().optional(),
  textBoxes: z.array(zTextBoxStyle),
  imageBoxes: z.array(zImageBox),
  layerOrderIds: z.array(z.string()).optional(),
  fadeHidden: z.boolean().optional(),
  headlineHidden: z.boolean().optional(),
  subHidden: z.boolean().optional(),
  layerOrder: z.array(zLayerId),
  circleBorderWidth: z.number(),
  circleBorderColor: z.string(),
  circleBorderOpacity: pct,
  circleShadowEnabled: z.boolean(),
  circleShadowBlur: z.number(),
  circleShadowOffsetX: z.number(),
  circleShadowOffsetY: z.number(),
  circleShadowColor: z.string(),
  circleShadowOpacity: pct,
  circleLift: z.number(),
  quoteSlots: z.array(z.string().nullable()).max(3),
  quoteSlotsHidden: z.array(z.boolean().nullable()).optional(),
  dividerSlots: z.array(z.string().nullable()).max(3).optional(),
  dividerSubSlots: z.array(zDividerSubSlotContent.nullable()).max(3).optional(),
  dividerSettings: z.array(zDividerStyleSettings.partial().nullable()).max(3).optional(),
  quoteColor: z.string(),
  quoteSize: z.number(),
  quoteOpacity: pct,
  quoteGap: z.number(),
  headlineColor: z.string(),
  subheadlineColor: z.string(),
  headlineShadow: zShadowStyle.optional(),
  subShadow: zShadowStyle.optional(),
  logoShadow: zShadowStyle.optional(),
  quoteShadow: zShadowStyle.optional(),
  headlineSpans: z.array(zTextSpan).nullable(),
  subSpans: z.array(zTextSpan).nullable(),
  circle2BorderWidth: z.number(),
  circle2BorderColor: z.string(),
  circle2BorderOpacity: pct,
  circle2ShadowEnabled: z.boolean(),
  circle2ShadowBlur: z.number(),
  circle2ShadowOffsetX: z.number(),
  circle2ShadowOffsetY: z.number(),
  circle2ShadowColor: z.string(),
  circle2ShadowOpacity: pct,
  circle2Lift: z.number(),
});

// ── Deep-partial patch schemas ────────────────────────────────────────────────
// zod's .partial() is SHALLOW: a present nested object would have to be complete. Patch consumers
// (the tools verbs and the copilot actions) promise deep-merge with null-clears on optional
// objects, so the patch schemas accept nested partials — {tagStyle:{bgColor}} and {shadow:null}
// are the mainline restyle shapes. Arrays still travel WHOLE (items are complete objects).
export const zShadowPatch = zShadowStyle.partial();
export const zNullableShadowPatch = zShadowPatch.nullable();
export const zTagStylePatch = zTagStyle.partial().extend({ shadow: zNullableShadowPatch.optional() });
export const zSwipeStylePatch = zSwipeStyle.partial().extend({ shadow: zNullableShadowPatch.optional() });

export const zTextBoxPatch = zTextBoxStyle.omit({ id: true }).partial().extend({
  shadow: zNullableShadowPatch.optional(),
  spans: z.array(zTextSpan).nullable().optional(),
});
export const zImageBoxPatch = zImageBox.omit({ id: true }).partial().extend({
  shadow: zNullableShadowPatch.optional(),
  fade: zImageBoxFade.partial().nullable().optional(),
  bgFade: zImageBoxFade.partial().nullable().optional(),
  crop: zImageBoxCrop.partial().nullable().optional(),
  circleCrop: zSlotCrop.nullable().optional(),
  perspective: zImageBoxPerspective.partial().nullable().optional(),
  fgEffects: zImageEffects.nullable().optional(),
  bgEffects: zImageEffects.nullable().optional(),
});

// SECURITY: a patch must never introduce or alter custom-element DRAW CODE. Custom elements render
// via `new Function` (an unsandboxed code sink — see customElements/runtime.ts), so their `code` is
// only ever created through the gated element pipeline and moved/removed via the targeted
// patch_free_element / remove_item actions (both guarded). A whole-array `patch_slide.settings.
// freeElements` is the one path that would otherwise bypass those guards, so the patch's
// freeElements union DROPS the 'custom' branch: a patch carrying custom code fails validation and is
// rejected (at the agent route, the client re-validation, AND the headless verbs — all share this
// schema). Non-custom free elements (tag/quote/swipe/logo/divider) still validate normally.
const zFreeElementNoCustom = z.discriminatedUnion(
  'kind',
  zFreeElement.options.filter(o => o.shape.kind.value !== 'custom') as never,
) as unknown as z.ZodType<Exclude<z.infer<typeof zFreeElement>, { kind: 'custom' }>>;

// A settings patch: any subset of top-level fields, deep-partial on nested objects.
export const zCarouselSettingsPatch = zCarouselSettings.partial().extend({
  tagStyle: zTagStylePatch.optional(),
  headlineShadow: zNullableShadowPatch.optional(),
  subShadow: zNullableShadowPatch.optional(),
  logoShadow: zNullableShadowPatch.optional(),
  quoteShadow: zNullableShadowPatch.optional(),
  freeElements: z.array(zFreeElementNoCustom).optional(),
});

export type CarouselSettingsPatch = z.infer<typeof zCarouselSettingsPatch>;
