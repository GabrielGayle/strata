import { describe, expect, it } from 'vitest';
import { GeometryRangeError } from '../src/core/geom2d';
import {
  MAP_TERRAIN_NETWORK_ERROR,
  MAP_TERRAIN_NO_SAMPLES_ERROR,
  MAP_TERRAIN_RANGE_ERROR,
  MapTerrainBuildError,
  isMapNetworkError,
  userFacingMapBuildError,
} from '../src/core/mapBuildError';

describe('userFacingMapBuildError', () => {
  it('maps network and fetch failures', () => {
    expect(userFacingMapBuildError(new TypeError('Failed to fetch'))).toBe(MAP_TERRAIN_NETWORK_ERROR);
    expect(userFacingMapBuildError(new Error('EA fetch failed (502): https://example'))).toBe(MAP_TERRAIN_NETWORK_ERROR);
    expect(userFacingMapBuildError(new Error('Terrarium tile fetch failed: x (503)'))).toBe(MAP_TERRAIN_NETWORK_ERROR);
    const wrapped = new Error('elevation load', { cause: new TypeError('Failed to fetch') });
    expect(isMapNetworkError(wrapped)).toBe(true);
    expect(userFacingMapBuildError(wrapped)).toBe(MAP_TERRAIN_NETWORK_ERROR);
  });

  it('maps missing elevation samples', () => {
    expect(userFacingMapBuildError(new MapTerrainBuildError('Map grid has no elevation samples'))).toBe(
      MAP_TERRAIN_NO_SAMPLES_ERROR,
    );
  });

  it('maps geometry range without Clipper or stack text', () => {
    const err = new GeometryRangeError('union', 'Coordinate outside allowed range in RangeTest().');
    err.stack = 'GeometryRangeError: Coordinate outside allowed range\n    at Object.union';
    const text = userFacingMapBuildError(err);
    expect(text).toBe(MAP_TERRAIN_RANGE_ERROR);
    expect(text).not.toMatch(/RangeTest|union\(|at Object/);
  });

  it('never returns a stack trace', () => {
    const err = new TypeError('Failed to fetch');
    err.stack = 'TypeError: Failed to fetch\n    at fetchElevationGrid (mapPipeline.ts:99:11)';
    expect(userFacingMapBuildError(err)).toBe(MAP_TERRAIN_NETWORK_ERROR);
    expect(userFacingMapBuildError(err)).not.toMatch(/at fetchElevationGrid|mapPipeline\.ts/);
  });
});
