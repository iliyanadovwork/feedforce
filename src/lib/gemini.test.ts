import { describe, it, expect } from 'vitest';
import { parseJson } from './gemini';

// parseJson sits on the path of EVERY AI feature (it parses Gemini's JSON replies, which often arrive
// wrapped in a ```json fence). A regression here silently breaks article/news/person extraction, so pin it.
describe('parseJson', () => {
  it('parses bare JSON', () => {
    expect(parseJson('{"picks":[1,2]}')).toEqual({ picks: [1, 2] });
  });

  it('strips a ```json fence', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips a bare ``` fence (no language tag)', () => {
    expect(parseJson('```\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });

  it('is case-insensitive on the JSON tag and tolerates surrounding whitespace', () => {
    expect(parseJson('```JSON\n   {"ok":true}   \n```')).toEqual({ ok: true });
  });

  it('handles nested objects/arrays', () => {
    const src = '```json\n{"items":[{"i":0,"t":"a"},{"i":1,"t":"b"}]}\n```';
    expect(parseJson(src)).toEqual({ items: [{ i: 0, t: 'a' }, { i: 1, t: 'b' }] });
  });

  it('throws on malformed JSON (caller can fall back)', () => {
    expect(() => parseJson('not json at all')).toThrow();
    expect(() => parseJson('```json\n{"a":}\n```')).toThrow();
  });
});
