import { describe, it, expect } from 'vitest';
import { findTrigger, filterCommands, applyInsertion, CAROUSEL_COMMANDS } from './slashCommands';

describe('findTrigger', () => {
  it('detects a slash command at the start', () => {
    expect(findTrigger('/dar', 4)).toEqual({ type: '/', query: 'dar', start: 0 });
  });

  it('detects a slash command mid-sentence after a space', () => {
    expect(findTrigger('make it /dar', 12)).toEqual({ type: '/', query: 'dar', start: 8 });
  });

  it('detects an @ mention', () => {
    expect(findTrigger('edit @sl', 8)).toEqual({ type: '@', query: 'sl', start: 5 });
  });

  it('returns the empty query right after the trigger char', () => {
    expect(findTrigger('go /', 4)).toEqual({ type: '/', query: '', start: 3 });
  });

  it('does not trigger mid-word (a/b)', () => {
    expect(findTrigger('a/b', 3)).toBeNull();
  });

  it('does not trigger on an email @', () => {
    expect(findTrigger('me@x.com', 8)).toBeNull();
  });

  it('does not trigger once the token is completed with a space', () => {
    expect(findTrigger('/darker ', 8)).toBeNull();
  });

  it('uses the caret, not the end of the string', () => {
    // caret sits right after "/da" even though more text follows
    expect(findTrigger('/darker rest', 3)).toEqual({ type: '/', query: 'da', start: 0 });
  });
});

describe('filterCommands', () => {
  it('returns all commands for an empty query', () => {
    expect(filterCommands(CAROUSEL_COMMANDS, '')).toHaveLength(CAROUSEL_COMMANDS.length);
  });

  it('matches by command prefix', () => {
    const out = filterCommands(CAROUSEL_COMMANDS, 'dar');
    expect(out).toHaveLength(1);
    expect(out[0].cmd).toBe('/darker');
  });

  it('matches by label substring', () => {
    const out = filterCommands(CAROUSEL_COMMANDS, 'brand');
    expect(out.some(c => c.cmd === '/brand')).toBe(true);
  });
});

describe('applyInsertion', () => {
  it('replaces the trigger token with the insertion plus a trailing space', () => {
    const { text, caret } = applyInsertion('make it /dar', 8, 12, 'Give this slide a darker look');
    expect(text).toBe('make it Give this slide a darker look ');
    expect(caret).toBe(8 + 'Give this slide a darker look'.length + 1);
  });

  it('preserves text after the caret', () => {
    const { text } = applyInsertion('/da done', 0, 3, 'Darken');
    expect(text).toBe('Darken done');
  });

  it('replaces the whole token even when the caret sits mid-token (no leftover tail)', () => {
    // caret is at index 3 inside "/darker"; the whole token must be replaced, not just "/da".
    const { text } = applyInsertion('/darker rest', 0, 3, 'Darken');
    expect(text).toBe('Darken rest');
  });
});
