import { describe, it, expect } from 'vitest';
import { isParamVisible, defaultConfig, missingRequired, type NodeParam } from './params';

const p = (over: Partial<NodeParam> & Pick<NodeParam, 'name' | 'type'>): NodeParam => ({
  displayName: over.name, ...over,
});

describe('isParamVisible', () => {
  it('always visible without displayOptions', () => {
    expect(isParamVisible(p({ name: 'url', type: 'string' }), {})).toBe(true);
  });
  it('show: visible only when the referenced value matches', () => {
    const body = p({ name: 'body', type: 'json', displayOptions: { show: { method: ['POST', 'PUT'] } } });
    expect(isParamVisible(body, { method: 'POST' })).toBe(true);
    expect(isParamVisible(body, { method: 'GET' })).toBe(false);
    expect(isParamVisible(body, {})).toBe(false);
  });
  it('show with multiple keys is ANDed', () => {
    const fld = p({ name: 'x', type: 'string', displayOptions: { show: { a: [true], b: ['json'] } } });
    expect(isParamVisible(fld, { a: true, b: 'json' })).toBe(true);
    expect(isParamVisible(fld, { a: true, b: 'form' })).toBe(false);
  });
  it('hide: hidden when the hide group fully matches', () => {
    const fld = p({ name: 'x', type: 'string', displayOptions: { hide: { mode: ['simple'] } } });
    expect(isParamVisible(fld, { mode: 'simple' })).toBe(false);
    expect(isParamVisible(fld, { mode: 'advanced' })).toBe(true);
  });
});

describe('defaultConfig', () => {
  it('collects defaults, skipping notice/hidden', () => {
    const params: NodeParam[] = [
      p({ name: 'method', type: 'options', default: 'GET' }),
      p({ name: 'info', type: 'notice', default: 'hello' }),
      p({ name: 'secret', type: 'hidden', default: 'x' }),
      p({ name: 'url', type: 'string' }), // no default → absent
    ];
    expect(defaultConfig(params)).toEqual({ method: 'GET' });
  });
});

describe('missingRequired', () => {
  it('lists required, visible, empty params only', () => {
    const params: NodeParam[] = [
      p({ name: 'url', type: 'string', required: true }),
      p({ name: 'body', type: 'json', required: true, displayOptions: { show: { method: ['POST'] } } }),
      p({ name: 'note', type: 'string' }), // not required
    ];
    expect(missingRequired(params, { method: 'GET' })).toEqual(['url']);      // body hidden → not counted
    expect(missingRequired(params, { method: 'POST', url: 'x' }).sort()).toEqual(['body']);
    expect(missingRequired(params, { method: 'GET', url: 'x' })).toEqual([]);
  });
});
