import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applySoundingsToGrid, parseSoundingsCsv } from '../src/core/mapBathymetry';
import { syntheticConeGrid } from '../src/core/mapToDepth';

describe('map lake bathymetry (T24)', () => {
  it('parses CSV soundings and lowers bed below surface', () => {
    const csv = readFileSync(fileURLToPath(new URL('./fixtures/map/welsh-harp-soundings.csv', import.meta.url)), 'utf8');
    const soundings = parseSoundingsCsv(csv);
    expect(soundings.length).toBe(4);
    const grid = syntheticConeGrid(32, 30, 10);
    grid.transform.originX = 520080;
    grid.transform.originY = 185820;
    const bed = applySoundingsToGrid(grid, soundings, 45);
    const i = 16 * 32 + 16;
    expect(bed.data[i]).toBeLessThan(45);
  });
});
