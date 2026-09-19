import { describe, it, expect } from 'vitest';
import { reelTextBoxHeight } from './TikTokCanvas/drawing/drawReelCell';

// reelTextBoxHeight is the reels text-box auto-fit: a box hugs its wrapped content (lines × lineHeight).
// Assertions are RELATIVE (ratios, not pixel constants) so they pin the behavior without coupling to the
// exact line-height formula. Mock ctx: text width = chars × charW; property sets/save/restore are no-ops.
const mockCtx = (charW = 20) => {
  const ctx = {
    font: '',
    measureText: (s: string) => ({ width: s.length * charW }),
    save() {}, restore() {},
  };
  return ctx as unknown as Parameters<typeof reelTextBoxHeight>[0];
};

describe('reelTextBoxHeight (auto-fit)', () => {
  it('empty text occupies exactly one line', () => {
    const ctx = mockCtx();
    const oneWord = reelTextBoxHeight(ctx, 'word', 5000, undefined);   // wide → single line
    expect(reelTextBoxHeight(ctx, '', 5000, undefined)).toBe(oneWord);
    expect(reelTextBoxHeight(ctx, '   ', 5000, undefined)).toBe(oneWord);
  });

  it('grows by one line per explicit newline', () => {
    const ctx = mockCtx();
    const one = reelTextBoxHeight(ctx, 'a', 5000, undefined);
    expect(reelTextBoxHeight(ctx, 'a\nb', 5000, undefined)).toBe(one * 2);
    expect(reelTextBoxHeight(ctx, 'a\nb\nc', 5000, undefined)).toBe(one * 3);
  });

  it('grows when text wraps because the box is narrow', () => {
    const ctx = mockCtx();
    const one = reelTextBoxHeight(ctx, 'word', 5000, undefined);
    const many = reelTextBoxHeight(ctx, Array(40).fill('word').join(' '), 150, undefined);
    expect(many).toBeGreaterThan(one);
  });
});
