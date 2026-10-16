import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyFlatWater, waterRingsFromOverpass } from '../src/core/mapWater';
import { syntheticConeGrid } from '../src/core/mapToDepth';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

describe('map water handling (T16)', () => {
  it('sets water polygon pixels to a flat surface level', () => {
    const grid = syntheticConeGrid(40, 30, 12);
    const surface = 8;
    const rings = [{ west: -8, south: -8, east: 8, north: 8 }];
    const flat = applyFlatWater(grid, rings, surface);
    const i = 20 * 40 + 20;
    expect(flat.data[i]).toBe(surface);
  });

  it('reads water rings from the Neasden Overpass fixture', () => {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/map/overpass-neasden.json', import.meta.url)), 'utf8'));
    const rings = waterRingsFromOverpass(raw, { bbox: NEASDEN_FAST_BBOX });
    expect(rings.length).toBeGreaterThan(0);
  });
});
