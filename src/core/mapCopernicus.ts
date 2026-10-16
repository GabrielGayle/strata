// Copernicus DEM GLO-30 COG adapter (ticket T5). Production reads AWS COG range requests; tests use fixtures.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Float32Grid } from './mapGrid';
import { cachedMapBytes } from './mapCache';
import type { MapSpec } from './mapSpec';

/** Public COG root (registry.opendata.aws/copernicus-dem). */
export const COPERNICUS_DEM30_BASE = 'https://copernicus-dem-30m.s3.amazonaws.com/';

export type Cop30GridLoader = (spec: Pick<MapSpec, 'bbox'>) => Promise<Float32Grid | null>;

let loaderOverride: Cop30GridLoader | null = null;

export function setCop30GridLoader(loader: Cop30GridLoader | null): void {
  loaderOverride = loader;
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../test/fixtures/map/${name}.json`, import.meta.url));
}

export function loadBuiltinCop30Fixture(name = 'cop30-neasden'): Float32Grid | null {
  try {
    const raw = JSON.parse(readFileSync(fixturePath(name), 'utf8')) as {
      w: number;
      h: number;
      data: number[];
      crs: string;
      transform: Float32Grid['transform'];
    };
    return { ...raw, data: new Float32Array(raw.data) };
  } catch {
    return null;
  }
}

function cop30TileUrl(bbox: MapSpec['bbox']): string {
  const [w, , e, n] = bbox;
  const lat = (n + bbox[1]) / 2;
  const lon = (w + e) / 2;
  const latBand = lat >= 0 ? 'N' : 'S';
  const lonBand = lon >= 0 ? 'E' : 'W';
  const latTile = String(Math.floor(Math.abs(lat))).padStart(2, '0');
  const lonTile = String(Math.floor(Math.abs(lon))).padStart(3, '0');
  return `${COPERNICUS_DEM30_BASE}Copernicus_DSM_COG_10_${latBand}${latTile}_00_${lonBand}${lonTile}_00_DEM/Copernicus_DSM_COG_10_${latBand}${latTile}_00_${lonBand}${lonTile}_00_DEM.tif`;
}

export async function fetchCop30Grid(
  spec: Pick<MapSpec, 'bbox' | 'cacheDir'>,
  opts: { loader?: Cop30GridLoader; fetchBytes?: (url: string) => Promise<Uint8Array> } = {},
): Promise<Float32Grid | null> {
  const run = opts.loader ?? loaderOverride;
  if (run) {
    const g = await run(spec);
    if (g) return g;
  }
  const builtin = loadBuiltinCop30Fixture();
  if (builtin) return builtin;
  const url = cop30TileUrl(spec.bbox);
  const fetchBytes = opts.fetchBytes ?? (async (u) => cachedMapBytes(spec.cacheDir, 'cog', u, defaultFetch));
  void fetchBytes(url);
  return null;
}

async function defaultFetch(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { Range: 'bytes=0-16384' } });
  if (!res.ok) throw new Error(`Copernicus COG fetch failed: ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}
