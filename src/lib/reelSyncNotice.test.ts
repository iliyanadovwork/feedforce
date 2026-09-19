import { describe, it, expect } from 'vitest';
import { describeReelSyncChange } from './reelSyncNotice';

// Regression lock for the "toast fired but nothing visibly changed" report (E2E-verified 2026-07-19):
// sync worked end-to-end, but a description edit renders nowhere at rest, so the generic toast read as
// a broken sync. The toast must NAME the reel and field so the user can find the (invisible) change.

const reel = (id: string, over: Partial<{ caption: string; description: string; url: string }> = {}) =>
  ({ id, caption: 'c', description: 'd', url: 'https://x/1', ...over });

describe('describeReelSyncChange', () => {
  it('names the reel (with its name) and the field for a single description change', () => {
    const prev = [reel('a'), reel('b')];
    const next = [reel('a'), reel('b', { description: 'NEW' })];
    expect(describeReelSyncChange(prev, next, { b: 'Promo' }))
      .toBe('Reel 2 (Promo): description updated in another tab.');
    expect(describeReelSyncChange(prev, next))
      .toBe('Reel 2: description updated in another tab.');
  });

  it('joins multiple changed fields on one reel', () => {
    const prev = [reel('a')];
    const next = [reel('a', { caption: 'X', description: 'Y' })];
    expect(describeReelSyncChange(prev, next)).toBe('Reel 1: caption + description updated in another tab.');
  });

  it('labels a url change as the video link', () => {
    expect(describeReelSyncChange([reel('a')], [reel('a', { url: 'https://x/2' })]))
      .toBe('Reel 1: video link updated in another tab.');
  });

  it('reports added and removed reels', () => {
    expect(describeReelSyncChange([reel('a')], [reel('a'), reel('b')])).toBe('A reel was added in another tab.');
    expect(describeReelSyncChange([reel('a'), reel('b')], [reel('a')])).toBe('A reel was removed in another tab.');
    expect(describeReelSyncChange([reel('a')], [reel('a'), reel('b'), reel('c')])).toBe('2 reels were added in another tab.');
  });

  it('summarises multi-reel edits and falls back to the generic notice when nothing textual changed', () => {
    const prev = [reel('a'), reel('b')];
    expect(describeReelSyncChange(prev, [reel('a', { caption: 'X' }), reel('b', { description: 'Y' })]))
      .toBe('2 reels updated in another tab.');
    expect(describeReelSyncChange(prev, [reel('a'), reel('b')])).toBe('Reels updated in another tab.');
  });

  it('treats undefined and empty string as equal (normalizeReel defaults)', () => {
    expect(describeReelSyncChange([{ id: 'a', caption: 'c' }], [{ id: 'a', caption: 'c', description: '' }]))
      .toBe('Reels updated in another tab.');
  });
});
