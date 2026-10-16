// Environment Agency LiDAR DTM/DSM adapter (ticket T6). Browser uses `/api/ea-proxy`; tests use fixtures.
import type { Float32Grid } from './mapGrid';
import { cachedMapBytes } from './mapCache';
import type { MapSource, MapSpec } from './mapSpec';
import { fetchEaBytes } from './mapEaFetch';
import { EA_DSM_WCS_BASE, EA_DTM_WCS_BASE, eaWcsUrlForSpec } from './mapEaWcs';
import { parseFloat32Geotiff } from './mapGeotiff';

/** Live Environment Agency WCS 2.0.1 — LiDAR composite DTM 1 m (OGL v3). */
export const EA_LIDAR_DTM_CATALOG = EA_DTM_WCS_BASE;
/** Live Environment Agency WCS 2.0.1 — LiDAR composite DSM 1 m (OGL v3). */
export const EA_LIDAR_DSM_CATALOG = EA_DSM_WCS_BASE;

export type EaGridLoader = (source: MapSource, spec: Pick<MapSpec, 'bbox'> & { resM?: number }) => Promise<Float32Grid | null>;

let loaderOverride: EaGridLoader | null = null;

export function setEaGridLoader(loader: EaGridLoader | null): void {
  loaderOverride = loader;
}

export function isEaLidarSource(source: MapSource): boolean {
  return source === 'ea-dtm' || source === 'ea-dsm';
}

export async function fetchEaLidarGrid(
  source: MapSource,
  spec: Pick<MapSpec, 'bbox' | 'cacheDir'> & { resM?: number },
  opts: { loader?: EaGridLoader; fetchBytes?: (url: string) => Promise<Uint8Array> } = {},
): Promise<Float32Grid | null> {
  if (!isEaLidarSource(source)) return null;
  const run = opts.loader ?? loaderOverride;
  if (run) return run(source, spec);
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
