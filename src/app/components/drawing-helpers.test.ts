import { describe, it, expect } from 'vitest';
import { hexToRgba, wrapText } from './TemplateEditorCanvas/drawing/helpers';
import { rgbToHex } from './TemplateEditorCanvas/drawing/spans';
import { parseFontName } from './customFonts';

// Mock canvas context: width = chars × charW. Lets us test wrapText deterministically without a DOM.
const mockCtx = (charW = 10) =>
  ({ measureText: (s: string) => ({ width: s.length * charW }) } as unknown as CanvasRenderingContext2D);

// Pure color/font helpers on the rendering path — a bug here shows up as wrong colors or wrong font
// weights on every exported slide.

describe('hexToRgba', () => {
  it('converts #rrggbb + alpha to rgba() with 3-dp alpha', () => {
    expect(hexToRgba('#ff0000', 1)).toBe('rgba(255,0,0,1.000)');
    expect(hexToRgba('#000000', 0.5)).toBe('rgba(0,0,0,0.500)');
    expect(hexToRgba('#1a2b3c', 0)).toBe('rgba(26,43,60,0.000)');
  });
  it('tolerates a missing leading #', () => {
    expect(hexToRgba('ffffff', 0.25)).toBe('rgba(255,255,255,0.250)');
  });
});

describe('rgbToHex', () => {
  it('converts rgb() to #rrggbb (zero-padded)', () => {
    expect(rgbToHex('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(rgbToHex('rgb(26, 43, 60)')).toBe('#1a2b3c');
    expect(rgbToHex('rgb(0,0,0)')).toBe('#000000');
  });
  it('returns the input unchanged when it is not an rgb() string', () => {
    expect(rgbToHex('#abcdef')).toBe('#abcdef');
    expect(rgbToHex('nonsense')).toBe('nonsense');
  });
});

describe('parseFontName', () => {
  it('strips variable-font markers and keeps a clean family', () => {
    expect(parseFontName('Geist-VariableFont_wght.ttf')).toMatchObject({
      family: 'Geist', weight: 400, style: 'normal', variable: true,
    });
  });
  it('peels a single weight word off the end', () => {
    expect(parseFontName('Roboto-Bold.ttf')).toMatchObject({ family: 'Roboto', weight: 700, weightLabel: 'Bold' });
    expect(parseFontName('Inter-SemiBold')).toMatchObject({ family: 'Inter', weight: 600, weightLabel: 'SemiBold' });
  });
  it('peels a compound weight (Extra Bold) but keeps a family word', () => {
    expect(parseFontName('Roboto-Extra-Bold')).toMatchObject({ family: 'Roboto', weight: 800, weightLabel: 'Extra Bold' });
  });
  it('detects italic and combines weight + style', () => {
    expect(parseFontName('Open-Sans-Italic.otf')).toMatchObject({ family: 'Open Sans', style: 'italic', weight: 400 });
    expect(parseFontName('Lato-Bold-Italic')).toMatchObject({ family: 'Lato', weight: 700, style: 'italic' });
  });
  it('leaves a plain family untouched (defaults 400/normal)', () => {
    expect(parseFontName('My-Cool-Font')).toMatchObject({ family: 'My Cool Font', weight: 400, style: 'normal', variable: false });
    expect(parseFontName('Custom')).toMatchObject({ family: 'Custom', weight: 400, style: 'normal' });
  });
});

describe('wrapText', () => {
  it('keeps text on one line when it fits', () => {
    expect(wrapText(mockCtx(10), 'ab cd', 100)).toEqual(['ab cd']); // 5 chars × 10 = 50 ≤ 100
  });
  it('greedily wraps words that overflow the width', () => {
    // "ab cd" = 50 (fits 50); adding " ef" = 80 > 50 → new line
    expect(wrapText(mockCtx(10), 'ab cd ef', 50)).toEqual(['ab cd', 'ef']);
  });
  it('does NOT break a single word wider than maxWidth (overflows on its own line)', () => {
    expect(wrapText(mockCtx(10), 'supercalifragilistic', 50)).toEqual(['supercalifragilistic']);
    expect(wrapText(mockCtx(10), 'tiny enormousword', 50)).toEqual(['tiny', 'enormousword']);
  });
  it('returns an empty array for empty text', () => {
    expect(wrapText(mockCtx(10), '', 100)).toEqual([]);
  });
});
