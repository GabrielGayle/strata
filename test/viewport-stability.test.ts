import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rect } from '../src/core/geom2d';
import type { Plane } from '../src/core/section';
import type { Part } from '../src/core/slicer';
import {
  etchGeometryKey,
  partGeometryKey,
  releaseEtchGeometry,
  releasePlateGeometry,
  resetViewportChurn,
  resetViewportGeometryCache,
  retainEtchGeometry,
  retainPlateGeometry,
  viewportCacheSize,
  viewportChurn,
} from '../src/ui/viewportStability';

const plane = (z = 0): Plane => ({
  origin: [0, 0, z],
  normal: [0, 0, 1],
  u: [1, 0, 0],
  v: [0, 1, 0],
});

function samplePart(over: Partial<Part> = {}): Part {
  const shape = over.shape ?? rect(0, 0, 40, 80);
  return {
    id: 'P0',
    plateKey: 'P0',
    family: 'P',
    index: 0,
    piece: 0,
    plane: plane(0),
    thickness: 3,
    shape,
    etch: [[[0, 0], [10, 0]]],
    labelPaths: [],
    labelAt: null,
    area: 3200,
    perimeter: 240,
    bbox: { minX: 0, minY: 0, maxX: 40, maxY: 80 },
    anchored: true,
    kind: 'plate',
    ...over,
  };
}

beforeEach(() => {
  resetViewportGeometryCache();
  resetViewportChurn();
});

afterEach(() => {
  resetViewportGeometryCache();
});

describe('viewport geometry keys', () => {
  it('is stable across a cloned Part wrapper with the same cut', () => {
    const a = samplePart();
    const b = structuredClone(a);
    expect(b).not.toBe(a);
    expect(b.shape).not.toBe(a.shape);
    expect(b.plane).not.toBe(a.plane);
    expect(partGeometryKey(b)).toBe(partGeometryKey(a));
    expect(etchGeometryKey([b])).toBe(etchGeometryKey([a]));
  });

  it('changes when the outline, thickness or plane changes', () => {
    const a = samplePart();
    expect(partGeometryKey(samplePart({ thickness: 6 }))).not.toBe(partGeometryKey(a));
    expect(partGeometryKey(samplePart({ shape: rect(0, 0, 41, 80) }))).not.toBe(partGeometryKey(a));
    expect(partGeometryKey(samplePart({ plane: plane(20) }))).not.toBe(partGeometryKey(a));
  });
});

describe('viewport geometry cache', () => {
  it('reuses ExtrudeGeometry instead of allocating on every equivalent part', () => {
    const a = samplePart();
    const g1 = retainPlateGeometry(a);
    const g2 = retainPlateGeometry(structuredClone(a));
    expect(g2).toBe(g1);
    expect(viewportChurn.geometryCreated).toBe(1);
    expect(viewportChurn.geometryReused).toBe(1);
    expect(g1.getAttribute('position').count).toBeGreaterThan(0);
    releasePlateGeometry(a);
    releasePlateGeometry(structuredClone(a));
    expect(viewportCacheSize().plates).toBe(0);
  });

  it('builds a new buffer when the cut actually changes', () => {
    const a = samplePart();
    const g1 = retainPlateGeometry(a);
    const g2 = retainPlateGeometry(samplePart({ thickness: 8 }));
    expect(g2).not.toBe(g1);
    expect(viewportChurn.geometryCreated).toBe(2);
    expect(viewportChurn.geometryReused).toBe(0);
    releasePlateGeometry(a);
    releasePlateGeometry(samplePart({ thickness: 8 }));
  });

  it('reuses etch line buffers across cloned part lists', () => {
    const parts = [samplePart()];
    const g1 = retainEtchGeometry(parts);
    const g2 = retainEtchGeometry(structuredClone(parts));
    expect(g2).toBe(g1);
    expect(viewportChurn.geometryCreated).toBe(1);
    expect(viewportChurn.geometryReused).toBe(1);
    releaseEtchGeometry(parts);
    releaseEtchGeometry(structuredClone(parts));
    expect(viewportCacheSize().etches).toBe(0);
  });
});
