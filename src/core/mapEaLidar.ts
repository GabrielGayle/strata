// Environment Agency LiDAR DTM/DSM adapter (ticket T6). Browser uses `/api/ea-proxy`; tests use fixtures.
import type { Float32Grid } from './mapGrid';
import { cachedMapBytes } from './mapCache';
import type { MapSource, MapSpec } from './mapSpec';
import { fetchEaBytes } from './mapEaFetch';
import { eaWcsUrlForSpec } from './mapEaWcs';
import { parseFloat32Geotiff } from './mapGeotiff';

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
  const wcsUrl = eaWcsUrlForSpec(source, spec);
  if (!wcsUrl) return null;
  const fetchBytes =
    opts.fetchBytes ??
    (async (url: string) => cachedMapBytes(spec.cacheDir, 'cog', url, (u) => fetchEaBytes(u)));
  try {
    const bytes = await fetchBytes(wcsUrl);
    return await parseFloat32Geotiff(bytes);
  } catch {
    return null;
  }
}
