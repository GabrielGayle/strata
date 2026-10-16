import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyBuildingFootprints,
  buildingHeightFromTags,
  clampTowerRise,
  DEFAULT_BUILDING_CLAMP_M,
  footprintsFromOverpass,
} from '../src/core/mapBuildings';
import { syntheticConeGrid } from '../src/core/mapToDepth';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

describe('map buildings / DSM (T15)', () => {
  it('parses OSM building height and levels', () => {
    expect(buildingHeightFromTags({ 'building:levels': '8' })).toBe(24);
    expect(buildingHeightFromTags({ height: '12' })).toBe(12);
  });

  it('raises DSM pixels above DTM inside footprints', () => {
    const dtm = syntheticConeGrid(32, 20, 10);
    const fps = [{ west: -5, south: -5, east: 5, north: 5, heightM: 15, relative: true }];
    const dsm = applyBuildingFootprints(dtm, fps);
    const i = 16 * 32 + 16;
    expect(dsm.data[i]).toBeGreaterThanOrEqual(dtm.data[i]);
    expect(dsm.data[i]).toBeGreaterThanOrEqual(dtm.data[i] + 14);
  });

  it('clamps tower rise to the configured maximum', () => {
    const dtm = syntheticConeGrid(32, 20, 10);
    const dsm = applyBuildingFootprints(dtm, [{ west: -5, south: -5, east: 5, north: 5, heightM: 80, relative: true }]);
    const capped = clampTowerRise(dsm, dtm, 12);
    const i = 16 * 32 + 16;
    expect(capped.data[i] - dtm.data[i]).toBeLessThanOrEqual(12.01);
    expect(DEFAULT_BUILDING_CLAMP_M).toBe(25);
  });

  it('reads building footprints from the Neasden Overpass fixture', () => {
    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL('./fixtures/map/overpass-buildings-neasden.json', import.meta.url)), 'utf8'),
    );
    const fps = footprintsFromOverpass(raw, { bbox: NEASDEN_FAST_BBOX });
    expect(fps.length).toBeGreaterThan(0);
  });
});
