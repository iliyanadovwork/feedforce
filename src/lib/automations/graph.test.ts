import { describe, it, expect } from 'vitest';
import { topoSort, resolveInputs } from './graph';
import type { Graph, FlowNode, Edge, RunOutputs } from './types';

const node = (id: string, type = 'x'): FlowNode => ({ id, type, inputs: [], outputs: [] });
const edge = (from: string, fp: string, to: string, tp: string): Edge => ({
  id: `${from}.${fp}->${to}.${tp}`, from: { node: from, port: fp }, to: { node: to, port: tp },
});

describe('topoSort', () => {
  it('orders a linear chain', () => {
    const g: Graph = { nodes: [node('c'), node('a'), node('b')], edges: [edge('a', 'o', 'b', 'i'), edge('b', 'o', 'c', 'i')] };
    const order = topoSort(g);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });
  it('orders a diamond (a→b, a→c, b→d, c→d)', () => {
    const g: Graph = {
      nodes: ['a', 'b', 'c', 'd'].map(id => node(id)),
      edges: [edge('a', 'o', 'b', 'i'), edge('a', 'o', 'c', 'i'), edge('b', 'o', 'd', 'i'), edge('c', 'o', 'd', 'i')],
    };
    const order = topoSort(g);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });
  it('includes isolated nodes', () => {
    const g: Graph = { nodes: [node('a'), node('iso')], edges: [] };
    expect([...topoSort(g)].sort()).toEqual(['a', 'iso']);
  });
  it('ignores dangling edges to missing nodes', () => {
    const g: Graph = { nodes: [node('a')], edges: [edge('a', 'o', 'ghost', 'i')] };
    expect(topoSort(g)).toEqual(['a']);
  });
  it('throws on a 2-node cycle', () => {
    const g: Graph = { nodes: [node('a'), node('b')], edges: [edge('a', 'o', 'b', 'i'), edge('b', 'o', 'a', 'i')] };
    expect(() => topoSort(g)).toThrow(/cycle/i);
  });
  it('throws on a self-loop', () => {
    const g: Graph = { nodes: [node('a')], edges: [edge('a', 'o', 'a', 'i')] };
    expect(() => topoSort(g)).toThrow(/cycle/i);
  });
});

describe('resolveInputs', () => {
  it('pulls upstream port items', () => {
    const cache: Record<string, RunOutputs> = { a: { o: [{ json: { v: 1 } }] } };
    const inputs = resolveInputs(node('b'), [edge('a', 'o', 'b', 'in')], cache);
    expect(inputs.in).toEqual([{ json: { v: 1 } }]);
  });
  it('fans in multiple edges into one input port', () => {
    const cache: Record<string, RunOutputs> = { a: { o: [{ json: { v: 1 } }] }, b: { o: [{ json: { v: 2 } }] } };
    const edges = [edge('a', 'o', 'c', 'in'), edge('b', 'o', 'c', 'in')];
    const inputs = resolveInputs(node('c'), edges, cache);
    expect(inputs.in).toEqual([{ json: { v: 1 } }, { json: { v: 2 } }]);
  });
  it('returns empty object when no edges target the node', () => {
    expect(resolveInputs(node('z'), [], {})).toEqual({});
  });
  it('treats a missing upstream value as empty', () => {
    const inputs = resolveInputs(node('b'), [edge('a', 'o', 'b', 'in')], {});
    expect(inputs.in).toEqual([]);
  });
});
