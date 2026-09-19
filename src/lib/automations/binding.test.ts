import { describe, it, expect } from 'vitest';
import { canConnect, coerce } from './binding';

describe('canConnect', () => {
  it('identical types connect', () => {
    expect(canConnect('string', 'string')).toBe(true);
    expect(canConnect('series', 'series')).toBe(true);
  });
  it('any connects in either direction', () => {
    expect(canConnect('any', 'number')).toBe(true);
    expect(canConnect('image', 'any')).toBe(true);
  });
  it('allows declared coercions', () => {
    expect(canConnect('number', 'string')).toBe(true);
    expect(canConnect('boolean', 'string')).toBe(true);
    expect(canConnect('series', 'array')).toBe(true);
  });
  it('rejects unsupported pairings', () => {
    expect(canConnect('string', 'number')).toBe(false);
    expect(canConnect('image', 'string')).toBe(false);
    expect(canConnect('array', 'series')).toBe(false);
    expect(canConnect('object', 'image')).toBe(false);
  });
});

describe('coerce', () => {
  it('to string', () => {
    expect(coerce(42, 'string')).toBe('42');
    expect(coerce(null, 'string')).toBe('');
    expect(coerce(undefined, 'string')).toBe('');
    expect(coerce({ a: 1 }, 'string')).toBe('{"a":1}');
    expect(coerce(true, 'string')).toBe('true');
  });
  it('to number', () => {
    expect(coerce('3.5', 'number')).toBe(3.5);
    expect(coerce(7, 'number')).toBe(7);
    expect(coerce('not-a-number', 'number')).toBe(null);
    expect(coerce(Infinity, 'number')).toBe(null);
  });
  it('to boolean', () => {
    expect(coerce(0, 'boolean')).toBe(false);
    expect(coerce('', 'boolean')).toBe(false);
    expect(coerce('yes', 'boolean')).toBe(true);
    expect(coerce(1, 'boolean')).toBe(true);
  });
  it('passes structural/media types through unchanged', () => {
    const obj = { a: 1 };
    expect(coerce(obj, 'object')).toBe(obj);
    const arr = [1, 2];
    expect(coerce(arr, 'array')).toBe(arr);
    expect(coerce('https://x/y.png', 'image')).toBe('https://x/y.png');
  });
});
