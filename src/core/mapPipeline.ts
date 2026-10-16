import type { MapSpec } from './mapSpec';
import { defaultMapSpec, TERRARIUM_ATTRIBUTION } from './mapSpec';
import { fetchTerrariumGrid, getTileFetcher, type TileFetcher } from './mapTerrarium';
import { cachedTileFetch } from './mapCache';
import { reprojectResample } from './mapProject';
import { mapGridToDepth } from './mapToDepth';
import type { DepthData } from './depth';
import type { ImageAsset } from './project';

const PLACEHOLDER_TOP = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export class MapSourceNotImplementedError extends Error {
  constructor(source: string) {
    super(`Map source '${source}' is not yet implemented in this release (terrarium only for now).`);
    this.name = 'MapSourceNotImplementedError';
  }
}

/** Wave 1: auto and terrarium → terrarium tiles; other names are accepted at parse time but fail here. */
export function resolveMapSource(source: MapSpec['source']): 'terrarium' {
  if (source === 'terrarium' || source === 'auto') return 'terrarium';
  throw new MapSourceNotImplementedError(source);
}

export interface BuildMapImageOptions {
  cacheDir?: string;
  fetch?: TileFetcher;
  exaggeration?: number;
}

export interface MapBuildResult {
  asset: ImageAsset;
  elevation: Awaited<ReturnType<typeof fetchTerrariumGrid>>;
  metric: Awaited<ReturnType<typeof reprojectResample>>;
  depth: DepthData;
}

export async function buildMapTopAsset(spec: MapSpec, opts: BuildMapImageOptions = {}): Promise<ImageAsset> {
  return (await buildMapBundle(spec, opts)).asset;
}

export async function buildMapBundle(spec: MapSpec, opts: BuildMapImageOptions = {}): Promise<MapBuildResult> {
  const resolved = resolveMapSource(spec.source);
  if (resolved !== 'terrarium') throw new MapSourceNotImplementedError(spec.source);
  const fetch: TileFetcher = async (url) => {
    const inner = opts.fetch ?? getTileFetcher();
    return cachedTileFetch(spec.cacheDir ?? opts.cacheDir, url, inner);
  };
  const elev = await fetchTerrariumGrid(spec, { fetch });
  const metric = reprojectResample(elev, spec);
  const ex = typeof spec.exaggeration === 'number' ? spec.exaggeration : 1;
  const { depth } = mapGridToDepth(metric, { exaggeration: ex, resolution: 384 });
  const stored: MapSpec = {
    ...spec,
    crs: metric.crs,
    fetchedAt: new Date().toISOString(),
    attribution: spec.attribution.length ? spec.attribution : [...TERRARIUM_ATTRIBUTION],
  };
  const asset: ImageAsset = {
    name: spec.title?.trim() || 'Map terrain',
    dataUrl: PLACEHOLDER_TOP,
    map: stored,
    depth,
  };
  return { asset, elevation: elev, metric, depth };
}

export function mapSpecFromCli(parts: {
  title?: string;
  bbox: MapSpec['bbox'];
  source: MapSpec['source'];
  resM: number;
  exaggeration: MapSpec['exaggeration'];
  engrave: MapSpec['engrave'];
  cacheDir?: string;
}): MapSpec {
  return defaultMapSpec({
    bbox: parts.bbox,
    source: parts.source,
    resM: parts.resM,
    exaggeration: parts.exaggeration,
    engrave: parts.engrave,
    title: parts.title,
    cacheDir: parts.cacheDir,
  });
}

export type { DepthData };
