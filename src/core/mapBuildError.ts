import { isGeometryRangeError } from './geom2d';

/** Thrown when a map DEM has no usable elevation samples. */
export class MapTerrainBuildError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MapTerrainBuildError';
  }
}

/** No usable DEM samples after nodata / plausibility masking. */
export const MAP_TERRAIN_NO_SAMPLES_ERROR =
  "Couldn't build plates: the elevation data has a gap or bad value near this area. Try a slightly different bbox, another Source, or Quick map again.";

/** Fetch / TypeError / HTTP failure talking to an elevation service. */
export const MAP_TERRAIN_NETWORK_ERROR =
  "Couldn't reach the elevation service. Check your connection and press Quick map again.";

/** Clipper RangeTest / non-finite plate coordinates. */
export const MAP_TERRAIN_RANGE_ERROR =
  "Couldn't build plates: a height for this landscape is out of range. Try another Source or a slightly different bbox, then press Quick map again.";

export const MAP_TERRAIN_USER_ERROR = MAP_TERRAIN_NO_SAMPLES_ERROR;

const NETWORK_MESSAGE =
  /failed to fetch|networkerror|network request failed|load failed|fetch failed|ea fetch failed|terrarium tile fetch failed|copernicus cog fetch failed|overpass (?:proxy failed|unavailable)|enotfound|econnrefused|econnreset|etimedout|err_network|err_internet|err_connection/i;

function errorChain(err: unknown): Error[] {
  const out: Error[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = cur.cause;
  }
  return out;
}

export function isMapNetworkError(err: unknown): boolean {
  for (const e of errorChain(err)) {
    if (e.name === 'AbortError') return true;
    if (e.name === 'TypeError' && /fetch|network|load failed/i.test(e.message)) return true;
    if (NETWORK_MESSAGE.test(e.message)) return true;
  }
  return false;
}

export function isMapTerrainFailure(err: unknown): boolean {
  if (isGeometryRangeError(err)) return true;
  if (err instanceof MapTerrainBuildError) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === 'MapTerrainBuildError' || err.name === 'GeometryRangeError') return true;
  return /RangeTest|Coordinate outside allowed range|no elevation samples/i.test(err.message);
}

/** Plain-English Map tab / toast copy. Never a stack trace or Clipper RangeTest string. */
export function userFacingMapBuildError(err: unknown): string {
  if (isGeometryRangeError(err) || (err instanceof Error && /RangeTest|Coordinate outside allowed range/i.test(err.message))) {
    return MAP_TERRAIN_RANGE_ERROR;
  }
  if (isMapNetworkError(err)) return MAP_TERRAIN_NETWORK_ERROR;
  if (
    err instanceof MapTerrainBuildError ||
    (err instanceof Error && /no elevation samples/i.test(err.message))
  ) {
    return MAP_TERRAIN_NO_SAMPLES_ERROR;
  }
  return MAP_TERRAIN_NO_SAMPLES_ERROR;
}
