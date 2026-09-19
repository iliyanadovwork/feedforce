import { describe, it, expect } from 'vitest';
import { proxyStreamUrl, clampZoom, fmtTime, bestVideoUrl } from './utils';

describe('proxyStreamUrl', () => {
  it('encodes the target url so query/separators cannot break out', () => {
    const out = proxyStreamUrl('https://cdn.example.com/v.mp4?a=1&b=2');
    expect(out).toBe('/api/proxy?stream=1&url=https%3A%2F%2Fcdn.example.com%2Fv.mp4%3Fa%3D1%26b%3D2');
    expect(out).not.toContain('&b=2');          // the inner & must be encoded, not a real param
  });
});

describe('clampZoom', () => {
  it('passes values within range untouched', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
  });
  it('clamps to the default [0.5, 3] bounds', () => {
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(10)).toBe(3);
  });
  it('honours custom bounds', () => {
    expect(clampZoom(5, 1, 4)).toBe(4);
    expect(clampZoom(0, 1, 4)).toBe(1);
  });
});

describe('fmtTime', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [65, '1:05'],
    [600, '10:00'],
    [3661, '61:01'],
  ])('formats %i seconds as %s', (secs, expected) => {
    expect(fmtTime(secs)).toBe(expected);
  });
});

describe('bestVideoUrl', () => {
  it('prefers hdplay (HD), then play, then wmplay', () => {
    expect(bestVideoUrl({ play: 'P', hdplay: 'HD', wmplay: 'WM' })).toContain(encodeURIComponent('HD'));
    expect(bestVideoUrl({ play: 'P', wmplay: 'WM' })).toContain(encodeURIComponent('P'));
    expect(bestVideoUrl({ wmplay: 'WM' })).toContain(encodeURIComponent('WM'));
  });
  it('falls back to an empty proxied url when no source is present', () => {
    expect(bestVideoUrl({})).toBe('/api/proxy?stream=1&url=');
  });
});
