import { describe, expect, it } from 'vitest';
import { evaluate, parse } from '../src/core/expr';
import { defaultRaw, evaluateParams } from '../src/core/params';

describe('expressions', () => {
  it('evaluates arithmetic and functions', () => {
    expect(evaluate(parse('2 + 3 * 4'), {})).toBe(14);
    expect(evaluate(parse('floor(baseLength / pitch)'), { baseLength: 800, pitch: 6 })).toBe(133);
    expect(evaluate(parse('x > 2 ? 10 : 20'), { x: 3 })).toBe(10);
    expect(evaluate(parse('-2^2'), {})).toBe(-4);
    expect(evaluate(parse('max(1, 5, 3)'), {})).toBe(5);
  });
  it('rejects junk', () => {
    expect(() => parse('2 +')).toThrow();
    expect(() => parse('alert(1)')).toThrow();
    expect(() => parse('a; b')).toThrow();
  });
});

describe('parameter graph', () => {
  it('evaluates linked parameters in dependency order', () => {
    const raw = { ...defaultRaw(), thickness: '3', pitch: 'thickness * 2', plateCount: 'floor(stackLength / pitch)' };
    const r = evaluateParams(raw);
    expect(r.values.pitch).toBe(6);
    expect(r.values.plateCount).toBe(133);
    expect(r.errors).toEqual({});
  });
  it('detects cycles and unknown names', () => {
    const raw = { ...defaultRaw(), pitch: 'plateCount * 2', plateCount: 'pitch / 2' };
    const r = evaluateParams(raw);
    expect(r.errors.pitch || r.errors.plateCount).toBeTruthy();
    const r2 = evaluateParams({ ...defaultRaw(), thickness: 'nope + 1' });
    expect(r2.errors.thickness).toMatch(/Unknown/);
    expect(r2.values.thickness).toBe(3);
  });
  it('uses slicing-direction flags', () => {
    const r = evaluateParams({ ...defaultRaw(), sliceAxis: 'width' });
    expect(r.values.stackLength).toBe(300);
    expect(r.values.plateWidth).toBe(800 - 40);
  });
});
