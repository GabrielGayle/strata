import type { Float32Grid } from './mapGrid';
import type { MapSource, MapSpec } from './mapSpec';
import type { EaGridLoader } from './mapEaLidar';
import type { RegionalGridLoader } from './mapRegionalLidar';
import { cropRegionalGridToBbox } from './mapRegionalLidar';
import type { OverpassFetcher } from './mapOverpass';
import { metricBounds } from './mapProject';
import { cachedMapBytes } from './mapCache';

function gridOverlapsBbox(grid: Float32Grid, bbox: MapSpec['bbox']): boolean {
  if (grid.crs !== 'EPSG:27700') return true;
  const b = metricBounds(bbox, 'EPSG:27700');
  const t = grid.transform;
  const absW = Math.abs(t.pixelW);
  const absH = Math.abs(t.pixelH);
  const gridWest = t.originX - absW / 2;
  const gridEast = t.originX + (grid.w - 1) * t.pixelW + (t.pixelW > 0 ? absW / 2 : -absW / 2);
  const west = Math.min(gridWest, gridEast);
  const east = Math.max(gridWest, gridEast);
  const gridNorth = t.originY + (t.pixelH < 0 ? absH / 2 : -absH / 2);
  const gridSouth = t.originY + (grid.h - 1) * t.pixelH + (t.pixelH < 0 ? -absH / 2 : absH / 2);
  const south = Math.min(gridSouth, gridNorth);
  const north = Math.max(gridSouth, gridNorth);
  return b.east >= west && b.west <= east && b.north >= south && b.south <= north;
}

/** Stretch a fixture grid over `bbox` so offline e2e can use any UK place. */
export function retargetGridToBbox(grid: Float32Grid, bbox: MapSpec['bbox']): Float32Grid {
  const crs = grid.crs || 'EPSG:27700';
  const b = metricBounds(bbox, crs);
  const pixelW = (b.east - b.west) / Math.max(1, grid.w);
  const pixelH = -(b.north - b.south) / Math.max(1, grid.h);
  return {
    ...grid,
    transform: {
      originX: b.west + pixelW / 2,
      originY: b.north + pixelH / 2,
      pixelW,
      pixelH,
    },
  };
}

function coverBbox(grid: Float32Grid, bbox: MapSpec['bbox']): Float32Grid {
  return gridOverlapsBbox(grid, bbox) ? cropRegionalGridToBbox(grid, bbox) : retargetGridToBbox(grid, bbox);
}

/** Through the map cache like a real EA raster, so e2e can check a rebuild stays off the network. */
async function fetchJsonGrid(path: string): Promise<Float32Grid | null> {
  let bytes: Uint8Array;
  try {
    bytes = await cachedMapBytes(undefined, 'bytes', path, async (u) => {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`fixture ${u} (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    });
  } catch {
    return null;
  }
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as {
    w: number;
    h: number;
    data: number[];
    crs: string;
    transform: Float32Grid['transform'];
  };
  return { ...raw, data: new Float32Array(raw.data) };
}

export function browserEaGridLoader(): EaGridLoader {
  return async (_source, spec) => {
    const g = await fetchJsonGrid('/map-fixtures/regional/neasden-ea-dtm.json');
    return g ? coverBbox(g, spec.bbox) : null;
  };
}

export function browserRegionalGridLoader(): RegionalGridLoader {
  const files: Partial<Record<MapSource, string>> = {
    'scot-dtm': '/map-fixtures/regional/kingsbarns-scot-dtm.json',
    'ni-dtm': '/map-fixtures/regional/royal-county-down-ni-dtm.json',
  };
  return async (source, spec) => {
    const path = files[source];
    if (!path) return null;
    const g = await fetchJsonGrid(path);
    return g ? coverBbox(g, spec.bbox) : null;
  };
}

export function browserOverpassFetcher(): OverpassFetcher {
  return async () => {
    const res = await fetch('/map-fixtures/overpass-neasden.json');
    if (!res.ok) throw new Error(`Overpass fixture missing (${res.status})`);
    return res.json();
  };
}
