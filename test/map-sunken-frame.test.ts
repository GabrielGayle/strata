import { describe, expect, it } from 'vitest';
import { buildMapSunkenFrameMould, DEFAULT_FRAME_CAST_TOLERANCE_MM } from '../src/core/mapSunkenFrame';
import { rect, type BBox, type Shape } from '../src/core/geom2d';
import type { SliceResult } from '../src/core/slicer';

function mockSliced(shapes: Shape[]): SliceResult {
  return {
    plates: [],
    parts: shapes.map((shape, i) => ({
      id: `P${i}`,
      plateKey: `P${i}`,
      family: 'P',
      index: i,
      piece: 0,
      plane: { origin: [0, 0, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
      thickness: 3,
      shape,
      etch: [],
      labelPaths: [],
      labelAt: null,
      area: 1000,
      perimeter: 200,
      bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 } as BBox,
      anchored: false,
      kind: 'plate',
    })),
    warnings: [],
    fragments: [],
    front: null,
    top: null,
    support: null,
    tuning: null,
    brace: null,
  };
}

describe('map sunken concrete frame (T28)', () => {
  it('gives every plate a seat depth and an outer mould outline', () => {
    const sliced = mockSliced([rect(0, 0, 80, 80), rect(10, 10, 70, 70)]);
    const mould = buildMapSunkenFrameMould(sliced, { sunkenFrame: { enabled: true } }, 3);
    expect(mould.parts.length).toBe(1);
    expect(mould.notes.some((n) => /P0 seat/.test(n))).toBe(true);
    expect(mould.notes.some((n) => /P1 seat/.test(n))).toBe(true);
    expect(mould.notes.some((n) => /kg/.test(n))).toBe(true);
    expect(DEFAULT_FRAME_CAST_TOLERANCE_MM).toBeGreaterThan(0);
  });
});
