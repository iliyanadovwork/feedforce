import { describe, expect, it } from 'vitest';
import {
  decodeHtmlEntities, cleanDescription, stripSourceCitations, capCaption, buildExtractionPrompt,
} from './sheetCaption';

describe('decodeHtmlEntities', () => {
  it('decodes named, decimal, and hex entities including astral code points', () => {
    expect(decodeHtmlEntities('&quot;a&quot; &amp; b&hellip;')).toBe('"a" & b…');
    expect(decodeHtmlEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeHtmlEntities('&#x1F600;')).toBe('\u{1F600}');
  });

  it('leaves unknown or invalid entities as-is', () => {
    expect(decodeHtmlEntities('&nosuch; &#xZZ;')).toBe('&nosuch; &#xZZ;');
  });
});

describe('cleanDescription', () => {
  it('strips hashtags, @handles, emoji, and promo CTAs into a single-line topic', () => {
    const raw = 'Big news about the album 🔥🔥\nFollow us for more #music #news @somepage\nLink in bio';
    expect(cleanDescription(raw)).toBe('Big news about the album');
  });

  it('never destroys substantive prose that merely resembles promo phrasing', () => {
    const raw = 'The band flew via London and the fans give the rookie credit for the win';
    expect(cleanDescription(raw)).toBe(raw);
  });

  it('drops separator lines and lines with nothing substantive left', () => {
    expect(cleanDescription('———\n#tag #tag2\nReal sentence here.')).toBe('Real sentence here.');
  });

  it('returns empty string for null/undefined/empty input', () => {
    expect(cleanDescription(null)).toBe('');
    expect(cleanDescription(undefined)).toBe('');
    expect(cleanDescription('  ')).toBe('');
  });
});

describe('stripSourceCitations', () => {
  it('removes bracketed domain groups, numbered refs, and footnotes', () => {
    expect(stripSourceCitations('A fact [wikipedia.org]. Another [1] and [1, 2] more [^3].'))
      .toBe('A fact. Another and more.');
  });

  it('leaves years and ordinary bracketed prose intact', () => {
    expect(stripSourceCitations('Released in [2005] to acclaim')).toBe('Released in [2005] to acclaim');
  });
});

describe('capCaption', () => {
  it('returns short text unchanged', () => {
    expect(capCaption('short', 100)).toBe('short');
  });

  it('crops at the last sentence boundary when one lands late enough', () => {
    const text = 'First sentence here. Second sentence here. ' + 'x'.repeat(100);
    expect(capCaption(text, 50)).toBe('First sentence here. Second sentence here.');
  });

  it('falls back to the last space, then a hard slice', () => {
    expect(capCaption('word another finalword', 14)).toBe('word another');
    expect(capCaption('averyverylongsingletoken', 10)).toBe('averyveryl');
  });
});

describe('buildExtractionPrompt', () => {
  it('embeds the frame count and demands verbatim JSON output', () => {
    const p = buildExtractionPrompt(2);
    expect(p).toContain('You are given 2 frame(s)');
    expect(p).toContain('VERBATIM');
    expect(p).toContain('{"caption": null}');
  });
});
