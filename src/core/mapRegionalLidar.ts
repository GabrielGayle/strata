// UK regional LiDAR DTM adapters (Scotland / Wales / NI). Production reads COG/WMS; tests inject fixtures.
import type { Float32Grid } from './mapGrid';
import { metricBounds } from './mapProject';
import type { MapSource, MapSpec } from './mapSpec';
import { REGIONAL_LIDAR_SOURCES, sourceMeta } from './mapSourceRegistry';

export type RegionalGridLoader = (source: MapSource, spec: Pick<MapSpec, 'bbox'>) => Promise<Float32Grid | null>;

let regionalLoaderOverride: RegionalGridLoader | null = null;

/** Test hook: supply offline regional grids without network. */
export function setRegionalGridLoader(loader: RegionalGridLoader | null): void {
  regionalLoaderOverride = loader;
}

export function isRegionalLidarSource(source: MapSource): boolean {
  return (REGIONAL_LIDAR_SOURCES as string[]).includes(source);
}

/**
 * Fetch a regional LiDAR grid for the bbox. Returns null when no adapter data is available
 * (caller should warn and fall back to terrarium / cop30).
 */
export async function fetchRegionalLidarGrid(
  source: MapSource,
  spec: Pick<MapSpec, 'bbox'>,
  loader?: RegionalGridLoader,
): Promise<Float32Grid | null> {
  if (!isRegionalLidarSource(source)) return null;
  const run = loader ?? regionalLoaderOverride;
  if (run) {
    const g = await run(source, spec);
    if (g) return g;
  }
  // Production path: COG/WMS range reads land in tickets 5/6; browser may need CORS proxy (see docs/map-sources.md).
  void sourceMeta(source).serviceUrl;
  return null;
}

/**
 * Trim a regional grid to the metric extent of `bbox`.
 * Offline fixtures are generated for acceptance bboxes and are returned unchanged when already contained.
 */
export function cropRegionalGridToBbox(grid: Float32Grid, bbox: MapSpec['bbox']): Float32Grid {
  if (grid.crs !== 'EPSG:27700') return grid;
  const b = metricBounds(bbox, 'EPSG:27700');
  const { w, h, data, transform: t } = grid;
  const absW = Math.abs(t.pixelW);
  const absH = Math.abs(t.pixelH);
  const gridWest = t.originX - absW / 2;
  const gridEast = t.originX + (w - 1) * t.pixelW + (t.pixelW > 0 ? absW / 2 : -absW / 2);
  const gridNorth = t.originY + (t.pixelH < 0 ? absH / 2 : -absH / 2);
  const gridSouth = t.originY + (h - 1) * t.pixelH + (t.pixelH < 0 ? -absH / 2 : absH / 2);
  if (b.west >= gridWest - absW && b.east <= gridEast + absW && b.north <= gridNorth + absH && b.south >= gridSouth - absH) {
    return grid;
  }
  const col0 = Math.max(0, Math.floor((b.west - t.originX) / t.pixelW));
  const col1 = Math.min(w - 1, Math.ceil((b.east - t.originX) / t.pixelW));
  const row0 = Math.max(0, Math.floor((b.north - t.originY) / t.pixelH));
  const row1 = Math.min(h - 1, Math.ceil((b.south - t.originY) / t.pixelH));
  if (col1 < col0 || row1 < row0) return grid;
  const cw = col1 - col0 + 1;
  const ch = row1 - row0 + 1;
  const cropped = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      cropped[y * cw + x] = data[(row0 + y) * w + col0 + x];
    }
  }
  const originX = t.originX + col0 * t.pixelW;
  const originY = t.originY + row0 * t.pixelH;
  return { w: cw, h: ch, data: cropped, crs: grid.crs, transform: { ...t, originX, originY } };
}
