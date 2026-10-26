import { describe, expect, it } from 'vitest';
import { controlsSchema, quantity } from '../src/schemas.js';
import { fromSI } from '../src/units.js';

describe('study quantity units', () => {
  it('converts length to metres', () => {
    expect(quantity('m').parse({ value: 1, units: 'in' }).value).toBeCloseTo(0.0254, 12);
    expect(quantity('m').parse({ value: 1, units: 'mm' }).value).toBeCloseTo(0.001, 12);
    expect(quantity('m').parse({ value: 4, units: 'ft' }).value).toBeCloseTo(1.2192, 12);
  });

  it('converts force and stress to SI', () => {
    expect(quantity('N').parse({ value: 100, units: 'lbf' }).value).toBeCloseTo(444.822, 3);
    expect(quantity('Pa').parse({ value: 1, units: 'ksi' }).value).toBeCloseTo(6894757.293, 2);
    expect(quantity('Pa').parse({ value: 1000, units: 'psi' }).value).toBeCloseTo(6894757.293, 2);
  });

  it('converts temperature with the offset', () => {
    expect(quantity('K').parse({ value: 32, units: 'degF' }).value).toBeCloseTo(273.15, 9);
    expect(quantity('K').parse({ value: 0, units: 'degC' }).value).toBeCloseTo(273.15, 9);
  });

  it('converts mesh controls to metres', () => {
    expect(controlsSchema.parse({ minSize: 0.25, maxSize: 0.5, units: 'in' })).toEqual({
      minSize: 0.00635,
      maxSize: 0.0127,
      units: 'm',
    });
  });

  it('converts SI results into display units', () => {
    expect(fromSI(0.0254, 'in')).toBeCloseTo(1, 12);
    expect(fromSI(6894757.293, 'ksi')).toBeCloseTo(1, 6);
    expect(fromSI(273.15, 'degF')).toBeCloseTo(32, 9);
    expect(fromSI(0.3048, 'ft')).toBeCloseTo(1, 12);
  });

  it('rejects incompatible or unknown units', () => {
    expect(quantity('m').safeParse({ value: 1, units: 'Pa' }).success).toBe(false);
    expect(quantity('m').safeParse({ value: 1, units: 'furlong' }).success).toBe(false);
  });

  it('enforces positivity after conversion', () => {
    expect(quantity('m', true).safeParse({ value: 0, units: 'in' }).success).toBe(false);
    expect(quantity('K', true).safeParse({ value: -300, units: 'degC' }).success).toBe(false);
  });
});
