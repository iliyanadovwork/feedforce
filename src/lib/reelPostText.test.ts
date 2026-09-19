import { describe, it, expect } from 'vitest';
import { reelPostText, descriptionSidecar } from './reelPostText';

// The reel DESCRIPTION is the Instagram post caption (Instagram has ONE text field, the caption; there is
// no separate description field). reelPostText encodes that mapping non-breakingly: description wins when
// present, otherwise the on-video caption, otherwise ''. descriptionSidecar is the download .txt export.

describe('reelPostText, description-preferred Instagram post caption', () => {
  it('returns the trimmed description when it has content', () => {
    expect(reelPostText({ description: 'Buy now', caption: 'overlay' })).toBe('Buy now');
    expect(reelPostText({ description: '  spaced out  ', caption: 'overlay' })).toBe('spaced out');
  });

  it('falls back to the caption when the description is empty or whitespace-only', () => {
    expect(reelPostText({ description: '', caption: 'overlay' })).toBe('overlay');
    expect(reelPostText({ description: '   ', caption: 'overlay' })).toBe('overlay');
    expect(reelPostText({ description: '\n\t ', caption: 'overlay' })).toBe('overlay');
  });

  it('returns the caption VERBATIM (untrimmed) on the fallback, only the description is trimmed', () => {
    // The description decides fallback via trim, but the caption is returned as-is (posted exactly as typed).
    expect(reelPostText({ description: '', caption: '  keep my spaces  ' })).toBe('  keep my spaces  ');
  });

  it("returns '' when both are empty", () => {
    expect(reelPostText({ description: '', caption: '' })).toBe('');
    expect(reelPostText({ description: '   ', caption: '' })).toBe('');
  });

  it('is safe for null / undefined inputs and null-ish fields', () => {
    expect(reelPostText(null)).toBe('');
    expect(reelPostText(undefined)).toBe('');
    expect(reelPostText({})).toBe('');
    expect(reelPostText({ description: null, caption: null })).toBe('');
    expect(reelPostText({ description: undefined, caption: undefined })).toBe('');
    expect(reelPostText({ description: null, caption: 'cap' })).toBe('cap');
    expect(reelPostText({ caption: 'only caption' })).toBe('only caption');
    expect(reelPostText({ description: 'only description' })).toBe('only description');
  });
});

describe('descriptionSidecar, download .txt export', () => {
  it('returns null when the description is null, undefined, empty, or whitespace-only', () => {
    expect(descriptionSidecar('01_reel', null)).toBeNull();
    expect(descriptionSidecar('01_reel', undefined)).toBeNull();
    expect(descriptionSidecar('01_reel', '')).toBeNull();
    expect(descriptionSidecar('01_reel', '   ')).toBeNull();
    expect(descriptionSidecar('01_reel', '\n\t  \r')).toBeNull();
  });

  it('names the file stem + ".txt"', () => {
    const out = descriptionSidecar('folder/01_my-reel', 'hello');
    expect(out).not.toBeNull();
    expect(out!.name).toBe('folder/01_my-reel.txt');
  });

  it('writes the description as exact UTF-8 bytes, round-tripping via TextDecoder (emoji + newlines)', () => {
    const description = 'Line one 🎬\nLine two — with an emoji 🚀\nтест';
    const out = descriptionSidecar('02_reel', description);
    expect(out).not.toBeNull();
    expect(out!.bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(out!.bytes)).toBe(description);
  });

  it('does NOT trim the written bytes, leading/trailing whitespace around real content is preserved verbatim', () => {
    const description = '   keep my padding   \n';
    const out = descriptionSidecar('03_reel', description);
    expect(out).not.toBeNull();
    // The emptiness check trimmed to decide it is non-blank, but the bytes are the untrimmed original.
    expect(new TextDecoder().decode(out!.bytes)).toBe(description);
  });
});
