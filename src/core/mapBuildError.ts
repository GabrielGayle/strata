import { isGeometryRangeError } from './geom2d';

/** Thrown when a map DEM has no usable elevation samples. */
export class MapTerrainBuildError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MapTerrainBuildError';
  }
}

export const MAP_TERRAIN_USER_ERROR =
  "Couldn't build plates: the elevation data has a gap or bad value near this area. Try a slightly different bbox, another Source, or Quick map again.";

export function isMapTerrainFailure(err: unknown): boolean {
  if (isGeometryRangeError(err)) return true;
  if (err instanceof MapTerrainBuildError) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === 'MapTerrainBuildError' || err.name === 'GeometryRangeError') return true;
  return /RangeTest|Coordinate outside allowed range|no elevation samples/i.test(err.message);
}

export function userFacingMapBuildError(_err: unknown): string {
  return MAP_TERRAIN_USER_ERROR;
}
