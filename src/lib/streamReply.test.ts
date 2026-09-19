import { describe, it, expect } from 'vitest';
import { createReplyExtractor } from './streamReply';

// Feed a full document one character at a time — the extractor must reconstruct the reply exactly,
// regardless of where chunk boundaries fall (including mid-escape).
function streamCharByChar(doc: string): { reply: string; done: boolean } {
  const ex = createReplyExtractor();
  let reply = '';
  for (const ch of doc) reply += ex.push(ch);
  return { reply, done: ex.done() };
}

// Feed a document as a given list of chunks.
function streamChunks(chunks: string[]): { reply: string; done: boolean } {
  const ex = createReplyExtractor();
  let reply = '';
  for (const c of chunks) reply += ex.push(c);
  return { reply, done: ex.done() };
}

describe('createReplyExtractor', () => {
  it('extracts a simple reply delivered whole', () => {
    const ex = createReplyExtractor();
    expect(ex.push('{"reply":"Made the headline bigger.","actions":[]}')).toBe('Made the headline bigger.');
    expect(ex.done()).toBe(true);
  });

  it('reconstructs the reply when streamed one character at a time', () => {
    const { reply, done } = streamCharByChar('{"reply":"Darkened the slide and added a swipe cue.","actions":[{"type":"patch_slide"}]}');
    expect(reply).toBe('Darkened the slide and added a swipe cue.');
    expect(done).toBe(true);
  });

  it('decodes escaped quotes and backslashes', () => {
    const { reply } = streamCharByChar('{"reply":"He said \\"hi\\" and used a \\\\ mark.","actions":[]}');
    expect(reply).toBe('He said "hi" and used a \\ mark.');
  });

  it('decodes newline and tab escapes', () => {
    const { reply } = streamCharByChar('{"reply":"line one\\nline two\\tindented","actions":[]}');
    expect(reply).toBe('line one\nline two\tindented');
  });

  it('decodes unicode escapes', () => {
    const { reply } = streamCharByChar('{"reply":"caf\\u00e9 \\u2014 nice","actions":[]}');
    expect(reply).toBe('café — nice');
  });

  it('never emits a half-received escape (split mid-\\uXXXX)', () => {
    // Boundary falls in the middle of é — the char must only appear once fully known.
    const { reply } = streamChunks(['{"reply":"caf\\u00', 'e9 done","actions":[]}']);
    expect(reply).toBe('café done');
  });

  it('handles a boundary right after a lone backslash', () => {
    const { reply } = streamChunks(['{"reply":"a\\', 'nb","actions":[]}']);
    expect(reply).toBe('a\nb');
  });

  it('handles an empty reply', () => {
    const ex = createReplyExtractor();
    const out = ex.push('{"reply":"","actions":[{"type":"patch_slide"}]}');
    expect(out).toBe('');
    expect(ex.done()).toBe(true);
  });

  it('tolerates whitespace around the key and colon', () => {
    const { reply } = streamCharByChar('{ "reply" :  "spaced out" , "actions": [] }');
    expect(reply).toBe('spaced out');
  });

  it('extracts reply even when it is not the first field', () => {
    const { reply } = streamCharByChar('{"actions":[],"reply":"still found me"}');
    expect(reply).toBe('still found me');
  });

  it('does not mistake a longer key like "replies" for "reply"', () => {
    const { reply } = streamCharByChar('{"replies":3,"reply":"the real one"}');
    expect(reply).toBe('the real one');
  });

  it('stops at the closing quote and ignores trailing structured JSON', () => {
    const ex = createReplyExtractor();
    let out = ex.push('{"reply":"done","actions":[{"type":"patch_slide","settings":{');
    out += ex.push('"headline":{"fontSize":88}}}]}');
    expect(out).toBe('done');
    expect(ex.done()).toBe(true);
  });

  it('waits without emitting until the reply key arrives', () => {
    const ex = createReplyExtractor();
    expect(ex.push('{"rep')).toBe('');
    expect(ex.push('ly":"h')).toBe('h');
    expect(ex.push('ere"}')).toBe('ere');
    expect(ex.done()).toBe(true);
  });

  it('reconstructs a reply containing JSON-ish characters', () => {
    const { reply } = streamCharByChar('{"reply":"Set width to {100} and kept [a,b]","actions":[]}');
    expect(reply).toBe('Set width to {100} and kept [a,b]');
  });
});
