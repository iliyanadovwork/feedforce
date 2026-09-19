import { describe, it, expect } from 'vitest';
import { computeCommissionCents } from './affiliates';

describe('computeCommissionCents', () => {
  it('takes the given percent of the gross, rounded to the nearest cent', () => {
    expect(computeCommissionCents(5999, 10)).toBe(600);   // $59.99 → $6.00 (599.9 → 600)
    expect(computeCommissionCents(3000, 10)).toBe(300);   // discounted first month $30 → $3.00
    expect(computeCommissionCents(5999, 15)).toBe(900);   // 899.85 → 900
    expect(computeCommissionCents(1000, 33)).toBe(330);
  });

  it('returns 0 for a zero/free payment', () => {
    expect(computeCommissionCents(0, 10)).toBe(0);        // 100%-off first month earns nothing
  });

  it('returns 0 for a zero or missing rate', () => {
    expect(computeCommissionCents(5999, 0)).toBe(0);
  });

  it('never returns a negative or non-finite amount', () => {
    expect(computeCommissionCents(-100, 10)).toBe(0);
    expect(computeCommissionCents(5999, -10)).toBe(0);
    expect(computeCommissionCents(Number.NaN, 10)).toBe(0);
    expect(computeCommissionCents(5999, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
