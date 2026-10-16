import type { MapSpec } from './mapSpec';
import { defaultMapSpec, TERRARIUM_ATTRIBUTION } from './mapSpec';
import { fetchTerrariumGrid, getTileFetcher, type TileFetcher } from './mapTerrarium';
import { cachedTileFetch } from './mapCache';
import { reprojectResample } from './mapProject';
import { mapGridToDepth } from './mapToDepth';
import { applyLayerBudget, computeLayerBreaks, type LayerBudgetMode } from './mapLayerBudget';
import { resolveExaggerationFactor } from './mapExaggeration';
import { simplifyMetricGrid } from './mapSimplify';
import type { DepthData } from './depth';
import type { ImageAsset, Project } from './project';
import type { RawValue } from './params';

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

export interface MapStackContext {
  plateCount: number;
  thicknessMm: number;
  masterWidthMm: number;
  layerBudget?: LayerBudgetMode;
  kerfMm?: number;
}

export interface BuildMapImageOptions {
  cacheDir?: string;
  fetch?: TileFetcher;
  stack?: MapStackContext;
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
  let metric = reprojectResample(elev, spec);
  const stack = opts.stack ?? { plateCount: 12, thicknessMm: 3, masterWidthMm: 520, layerBudget: 'jenks' as LayerBudgetMode };
  const budgetMode = spec.layerBudget ?? stack.layerBudget ?? 'jenks';
  const budget = computeLayerBreaks(metric, stack.plateCount, budgetMode);
  metric = applyLayerBudget(metric, budget.breaksM);
  const simplified = simplifyMetricGrid(metric, {
    kerfMm: stack.kerfMm ?? 0.2,
    pixelSizeM: Math.abs(metric.transform.pixelW),
  });
  metric = simplified.grid;
  const { factor, readout } = resolveExaggerationFactor(spec, metric, stack);
  const { depth } = mapGridToDepth(metric, { exaggeration: factor, resolution: 384 });
  const stored: MapSpec = {
    ...spec,
    crs: metric.crs,
    fetchedAt: new Date().toISOString(),
    attribution: spec.attribution.length ? spec.attribution : [...TERRARIUM_ATTRIBUTION],
    layerBudget: budgetMode,
    layerBreaksM: budget.breaksM,
    exaggerationFactor: factor,
    exaggerationReadout: readout,
    exaggeration: spec.exaggeration === 'auto' ? 'auto' : factor,
    simplifyLostFeatures: simplified.lostFeatures,
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
  layerBudget?: LayerBudgetMode;
}): MapSpec {
  return defaultMapSpec({
    bbox: parts.bbox,
    source: parts.source,
    resM: parts.resM,
    exaggeration: parts.exaggeration,
    engrave: parts.engrave,
    title: parts.title,
    cacheDir: parts.cacheDir,
    layerBudget: parts.layerBudget,
  });
}

function numParam(raw: Record<string, RawValue>, id: string, fallback: number): number {
  const n = Number(raw[id]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function mapStackFromProject(project: Project, layerBudget?: LayerBudgetMode): MapStackContext {
  const p = project.params;
  return {
    plateCount: Math.round(numParam(p, 'plateCount', 12)),
    thicknessMm: numParam(p, 'thickness', 3),
    masterWidthMm: Math.max(numParam(p, 'baseLength', 520), numParam(p, 'baseWidth', 380)),
    layerBudget,
    kerfMm: numParam(p, 'kerf', 0.2),
  };
}

export type { DepthData };
