import { describe, it, expect } from 'vitest';
import { flattenKeys, lastSegment, extractPlaceholders, autoMatch, collectStrings, getAtPath, fillText } from './mapping';

describe('flattenKeys', () => {
  it('flattens nested objects and arrays to leaf paths', () => {
    const r = flattenKeys({ status: 200, data: { markets: [{ ticker: 'AAPL', last: 5 }] } });
    const map = Object.fromEntries(r.map(k => [k.path, k.value]));
    expect(map['status']).toBe(200);
    expect(map['data.markets.0.ticker']).toBe('AAPL');
    expect(map['data.markets.0.last']).toBe(5);
  });
  it('caps entries', () => {
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(flattenKeys(big, { maxEntries: 10 })).toHaveLength(10);
  });
});

describe('lastSegment', () => {
  it('returns the final path segment', () => {
    expect(lastSegment('data.markets.0.ticker')).toBe('ticker');
    expect(lastSegment('price')).toBe('price');
  });
});

describe('extractPlaceholders', () => {
  it('finds unique single-brace tokens', () => {
    expect(extractPlaceholders('Hi {name}, {ticker} is {price}. Again {name}.').sort()).toEqual(['name', 'price', 'ticker']);
  });
  it('returns [] when none', () => {
    expect(extractPlaceholders('no placeholders here')).toEqual([]);
  });
});

describe('autoMatch', () => {
  it('matches placeholder to a key by last segment, case-insensitive', () => {
    const m = autoMatch(['ticker', 'price', 'missing'], ['data.0.Ticker', 'data.0.price', 'data.0.volume']);
    expect(m).toEqual({ ticker: 'data.0.Ticker', price: 'data.0.price' });
  });
  it('first matching key wins', () => {
    const m = autoMatch(['ticker'], ['a.ticker', 'b.ticker']);
    expect(m.ticker).toBe('a.ticker');
  });
});

describe('getAtPath', () => {
  it('reads nested values by path', () => {
    const root = { data: { markets: [{ ticker: 'AAPL' }] } };
    expect(getAtPath(root, 'data.markets.0.ticker')).toBe('AAPL');
    expect(getAtPath(root, '')).toBe(root);
    expect(getAtPath(root, 'data.nope.x')).toBeUndefined();
  });
});

describe('fillText', () => {
  it('replaces mapped placeholders and keeps unmapped ones', () => {
    expect(fillText('{ticker} is {price}, {missing}', { ticker: 'AAPL', price: '228' }))
      .toBe('AAPL is 228, {missing}');
  });
});

describe('collectStrings', () => {
  it('gathers strings recursively', () => {
    expect(collectStrings({ a: 'x', b: { c: 'y', d: 3 }, e: ['z'] }).sort()).toEqual(['x', 'y', 'z']);
  });
});
