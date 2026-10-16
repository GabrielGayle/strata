// Environment Agency LiDAR DTM/DSM adapter (ticket T6). Browser may use the EA CORS proxy; tests use fixtures.
import type { Float32Grid } from './mapGrid';
import { cachedMapBytes } from './mapCache';
import type { MapSource, MapSpec } from './mapSpec';
/** Defra Data Services Platform — LiDAR composite DTM 1 m (OGL v3). */
export const EA_LIDAR_DTM_CATALOG =
  'https://environment.data.gov.uk/DefraDataDownload/?mapService=EA/LIDARCompositeDTM1m';

export type EaGridLoader = (source: MapSource, spec: Pick<MapSpec, 'bbox'>) => Promise<Float32Grid | null>;

let loaderOverride: EaGridLoader | null = null;

export function setEaGridLoader(loader: EaGridLoader | null): void {
  loaderOverride = loader;
}

export function isEaLidarSource(source: MapSource): boolean {
  return source === 'ea-dtm' || source === 'ea-dsm';
}

function catalogUrlFor(source: MapSource): string {
  return source === 'ea-dsm'
    ? 'https://environment.data.gov.uk/DefraDataDownload/?mapService=EA/LIDARCompositeDSM1m'
    : EA_LIDAR_DTM_CATALOG;
}

export async function fetchEaLidarGrid(
  source: MapSource,
  spec: Pick<MapSpec, 'bbox' | 'cacheDir'>,
  opts: { loader?: EaGridLoader; fetchBytes?: (url: string) => Promise<Uint8Array> } = {},
): Promise<Float32Grid | null> {
  if (!isEaLidarSource(source)) return null;
  const run = opts.loader ?? loaderOverride;
  if (run) {
    const g = await run(source, spec);
    if (g) return g;
  }
  const url = catalogUrlFor(source);
  const fetchBytes = opts.fetchBytes ?? (async (u) => cachedMapBytes(spec.cacheDir, 'cog', u, defaultFetch));
  try {
    await fetchBytes(url);
  } catch {
    return null;
  }
  return null;
}

async function defaultFetch(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { Range: 'bytes=0-4096' } });
  if (!res.ok) throw new Error(`EA LiDAR catalog fetch failed: ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}
