import { describe, it, expect } from 'vitest';
import { parseInline, parseBlocks } from './markdownLite';

describe('parseInline', () => {
  it('returns plain text unchanged as a single token', () => {
    expect(parseInline('just text')).toEqual([{ t: 'text', v: 'just text' }]);
  });

  it('parses bold, italic, and code', () => {
    expect(parseInline('a **b** c')).toEqual([
      { t: 'text', v: 'a ' }, { t: 'bold', v: 'b' }, { t: 'text', v: ' c' },
    ]);
    expect(parseInline('use `code` here')).toEqual([
      { t: 'text', v: 'use ' }, { t: 'code', v: 'code' }, { t: 'text', v: ' here' },
    ]);
    expect(parseInline('_em_')).toEqual([{ t: 'italic', v: 'em' }]);
  });

  it('picks the earliest markup when several are present', () => {
    expect(parseInline('`x` **y**')).toEqual([
      { t: 'code', v: 'x' }, { t: 'text', v: ' ' }, { t: 'bold', v: 'y' },
    ]);
  });

  it('parses a safe link', () => {
    expect(parseInline('see [docs](https://a.com/x)')).toEqual([
      { t: 'text', v: 'see ' }, { t: 'link', v: 'docs', href: 'https://a.com/x' },
    ]);
  });

  it('renders an unsafe link scheme as literal text (no javascript:)', () => {
    const out = parseInline('[click](javascript:alert(1))');
    expect(out).toEqual([{ t: 'text', v: '[click](javascript:alert(1))' }]);
  });

  it('leaves an unclosed bold marker as text (graceful for a mid-stream string)', () => {
    expect(parseInline('half **bold')).toEqual([{ t: 'text', v: 'half **bold' }]);
  });

  it('does not treat bare asterisks with spaces as italic', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ t: 'text', v: '2 * 3 * 4' }]);
  });

  it('does not treat intraword underscores as emphasis', () => {
    expect(parseInline('my_var_name here')).toEqual([{ t: 'text', v: 'my_var_name here' }]);
  });

  it('still parses underscore emphasis at word boundaries', () => {
    expect(parseInline('an _italic_ word')).toEqual([
      { t: 'text', v: 'an ' }, { t: 'italic', v: 'italic' }, { t: 'text', v: ' word' },
    ]);
  });
});

describe('parseBlocks', () => {
  it('makes a single paragraph from a plain line', () => {
    expect(parseBlocks('hello world')).toEqual([{ t: 'p', lines: [[{ t: 'text', v: 'hello world' }]] }]);
  });

  it('splits paragraphs on a blank line', () => {
    const b = parseBlocks('one\n\ntwo');
    expect(b).toHaveLength(2);
    expect(b[0].t).toBe('p');
    expect(b[1].t).toBe('p');
  });

  it('groups bullet lines into one list', () => {
    const b = parseBlocks('- a\n- b\n- c');
    expect(b).toHaveLength(1);
    expect(b[0]).toEqual({ t: 'ul', items: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }], [{ t: 'text', v: 'c' }]] });
  });

  it('groups numbered lines into an ordered list', () => {
    const b = parseBlocks('1. first\n2. second');
    expect(b[0].t).toBe('ol');
    expect((b[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('separates a paragraph followed by a list', () => {
    const b = parseBlocks('Here is what I did:\n- bigger headline\n- darker bg');
    expect(b).toHaveLength(2);
    expect(b[0].t).toBe('p');
    expect(b[1].t).toBe('ul');
  });

  it('parses inline markup inside list items', () => {
    const b = parseBlocks('- made it **bold**');
    expect(b[0]).toEqual({ t: 'ul', items: [[{ t: 'text', v: 'made it ' }, { t: 'bold', v: 'bold' }]] });
  });
});
