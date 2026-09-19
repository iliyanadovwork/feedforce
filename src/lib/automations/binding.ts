import type { DataType } from './types';

// Type-aware binding: which output→input port pairings the editor allows, and how a value is coerced
// when the engine moves it across an allowed-but-not-identical pairing.

// Allowed implicit coercions (besides 'any' and identical types).
const COERCIONS: Partial<Record<DataType, DataType[]>> = {
  number: ['string'],     // a number can fill a text slot (formatted)
  boolean: ['string'],
  series: ['array'],      // a series is an array of points
};

/** Can a port of type `from` connect into a port of type `to`? */
export function canConnect(from: DataType, to: DataType): boolean {
  if (from === 'any' || to === 'any') return true;
  if (from === to) return true;
  return (COERCIONS[from] ?? []).includes(to);
}

/** Coerce a runtime value to the target port type. Pass-through for structural/media types. */
export function coerce(value: unknown, to: DataType): unknown {
  switch (to) {
    case 'string':
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return Boolean(value);
    default:
      return value; // object | array | image | video | series | any → unchanged
  }
}
