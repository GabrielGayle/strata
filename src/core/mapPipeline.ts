import type { MapSpec } from './mapSpec';
import { defaultMapSpec, TERRARIUM_ATTRIBUTION } from './mapSpec';
import { fetchTerrariumGrid, getTileFetcher, type TileFetcher } from './mapTerrarium';
import { cachedTileFetch } from './mapCache';
import { reprojectResample } from './mapProject';
import { mapGridToDepth } from './mapToDepth';
import { applyLayerBudget, computeLayerBreaks, type LayerBudgetMode } from './mapLayerBudget';
import { resolveExaggerationFactor } from './mapExaggeration';
import { simplifyMetricGrid } from './mapSimplify';
import { fetchCop30Grid, type Cop30GridLoader } from './mapCopernicus';
import { fetchEaLidarGrid, isEaLidarSource, type EaGridLoader } from './mapEaLidar';
import { fetchRegionalLidarGrid, isRegionalLidarSource, type RegionalGridLoader } from './mapRegionalLidar';
import { pickAutoMapSource, pickExplicitSource } from './mapSourcePick';
import { sourceMeta } from './mapSourceRegistry';
import {
  applyBuildingFootprints,
  buildingClampMetres,
  clampTowerRise,
  footprintsFromOverpass,
  resolveElevationSourceForModel,
} from './mapBuildings';
import { commemorativeFitWarning } from './mapBackPlateEtch';
import { fetchOverpass } from './mapOverpass';
import { applyFlatWater, estimateWaterSurfaceM, waterRingsFromOverpass } from './mapWater';
import { buildMapEngraveArt } from './mapEngraveBuild';
import { serializeMapEngraveArt } from './mapOsmEngrave';
import type { OverpassFetcher } from './mapOverpass';
import type { MapSource } from './mapSpec';
import type { DepthData } from './depth';
import type { ImageAsset, Project } from './project';
import type { RawValue } from './params';

const PLACEHOLDER_TOP = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export class MapSourceNotImplementedError extends Error {
  constructor(source: string) {
    super(`Map source '${source}' is not yet implemented in this release.`);
    this.name = 'MapSourceNotImplementedError';
  }
}

const STUB_SOURCES = new Set<MapSource>([]);

export interface ResolvedMapSource {
  requested: MapSource;
  effective: MapSource;
  warnings: string[];
}

export function resolveMapSource(spec: Pick<MapSpec, 'source' | 'bbox'>): ResolvedMapSource {
  const requested = spec.source;
  if (requested === 'auto') {
    const pick = pickAutoMapSource(spec.bbox);
    return { requested, effective: pick.source, warnings: [...pick.warnings] };
  }
  const pick = pickExplicitSource(requested);
  return { requested, effective: pick.source, warnings: pick.warnings };
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
  regionalLoader?: RegionalGridLoader;
  eaLoader?: EaGridLoader;
  overpass?: OverpassFetcher;
  /** When true, Overpass may use the network if the cache misses (CLI default). */
  allowOverpassNetwork?: boolean;
  cop30Loader?: Cop30GridLoader;
}

export interface MapBuildResult {
  asset: ImageAsset;
  elevation: Awaited<ReturnType<typeof fetchTerrariumGrid>>;
  metric: Awaited<ReturnType<typeof reprojectResample>>;
  depth: DepthData;
}

async function fetchElevationGrid(
  spec: MapSpec,
  effective: MapSource,
  warnings: string[],
  opts: BuildMapImageOptions,
): Promise<Awaited<ReturnType<typeof fetchTerrariumGrid>>> {
  const fetch: TileFetcher = async (url) => {
    const inner = opts.fetch ?? getTileFetcher();
    return cachedTileFetch(spec.cacheDir ?? opts.cacheDir, url, inner);
  };

  if (effective === 'terrarium') {
    return fetchTerrariumGrid(spec, { fetch });
  }

  if (effective === 'cop30') {
    const grid = await fetchCop30Grid(spec, { loader: opts.cop30Loader });
    if (grid) return grid;
    warnings.push('cop30 COG tile unavailable for this bbox; falling back to terrarium (~30 m).');
    return fetchTerrariumGrid(spec, { fetch });
  }

  if (isRegionalLidarSource(effective)) {
    const grid = await fetchRegionalLidarGrid(effective, spec, opts.regionalLoader);
    if (grid) return grid;
    warnings.push(
      `${effective} LiDAR not available for this bbox (no tile coverage or adapter offline); falling back to terrarium (~30 m).`,
    );
    return fetchTerrariumGrid(spec, { fetch });
  }

  if (isEaLidarSource(effective)) {
    const grid = await fetchEaLidarGrid(effective, spec, { loader: opts.eaLoader });
    if (grid) return grid;
    warnings.push(`${effective} LiDAR not available for this bbox; falling back to terrarium (~30 m).`);
    return fetchTerrariumGrid(spec, { fetch });
  }

  if (STUB_SOURCES.has(effective)) {
    warnings.push(`${effective} adapter not shipped yet; falling back to terrarium (~30 m).`);
    return fetchTerrariumGrid(spec, { fetch });
  }

  throw new MapSourceNotImplementedError(effective);
}

function mergeAttribution(spec: MapSpec, effective: MapSource): string[] {
  if (spec.attribution.length) return spec.attribution;
  if (effective === 'terrarium') return [...TERRARIUM_ATTRIBUTION];
  const meta = sourceMeta(effective);
  return meta.attribution.length ? [...meta.attribution] : [`Elevation source: ${meta.portalUrl}`];
}

export async function buildMapTopAsset(spec: MapSpec, opts: BuildMapImageOptions = {}): Promise<ImageAsset> {
  return (await buildMapBundle(spec, opts)).asset;
}

export async function buildMapBundle(spec: MapSpec, opts: BuildMapImageOptions = {}): Promise<MapBuildResult> {
  const resolved = resolveMapSource(spec);
  const warnings = [...resolved.warnings];
  const faceW = opts.stack?.masterWidthMm ?? 520;
  const commWarn = spec.commemorativeText ? commemorativeFitWarning(spec.commemorativeText, faceW) : null;
  if (commWarn) warnings.push(commWarn);
  const fetchSource = resolveElevationSourceForModel(resolved.effective, spec.model);
  const elev = await fetchElevationGrid(spec, fetchSource, warnings, opts);
  const resampleSpec = { ...spec, model: spec.model === 'dtm+buildings' ? 'dtm' : spec.model };
  let metric = reprojectResample(elev, resampleSpec);
  let dtmMetric = metric;
  if (spec.model === 'dsm' && fetchSource !== resolved.effective) {
    const dtmElev = await fetchElevationGrid(spec, resolved.effective, warnings, opts);
    dtmMetric = reprojectResample(dtmElev, { ...spec, model: 'dtm' });
  }
  if (spec.model === 'dtm+buildings') {
    dtmMetric = metric;
    try {
      const osm = await fetchOverpass(spec.bbox, {
        cacheDir: spec.cacheDir ?? opts.cacheDir,
        fetch: opts.overpass,
        allowNetwork: opts.allowOverpassNetwork,
        features: ['buildings'],
      });
      const fps = footprintsFromOverpass(osm as Parameters<typeof footprintsFromOverpass>[0], spec, metric.crs ?? 'EPSG:27700');
      if (fps.length) metric = applyBuildingFootprints(dtmMetric, fps);
    } catch (e) {
      warnings.push(`OSM buildings skipped: ${(e as Error).message}`);
    }
  }
  if (spec.model !== 'dtm') {
    metric = clampTowerRise(metric, dtmMetric, buildingClampMetres(spec));
  }
  if (spec.water === 'flat' || spec.water === 'raw') {
    try {
      const osm = await fetchOverpass(spec.bbox, {
        cacheDir: spec.cacheDir ?? opts.cacheDir,
        fetch: opts.overpass,
        allowNetwork: opts.allowOverpassNetwork,
        features: ['water'],
      });
      const rings = waterRingsFromOverpass(osm as Parameters<typeof waterRingsFromOverpass>[0], spec, metric.crs ?? 'EPSG:27700');
      if (rings.length) {
        const surface = estimateWaterSurfaceM(metric);
        metric = applyFlatWater(metric, rings, surface);
      }
    } catch (e) {
      warnings.push(`Water flatten skipped: ${(e as Error).message}`);
    }
  }
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
  const { depth } = mapGridToDepth(metric, { exaggeration: factor, resolution: 384, bbox: spec.bbox });
  let engraveArt: MapSpec['engraveArt'];
  if (spec.engrave?.enabled) {
    try {
      const art = await buildMapEngraveArt(spec, depth, {
        cacheDir: spec.cacheDir ?? opts.cacheDir,
        overpass: opts.overpass,
        allowNetwork: opts.allowOverpassNetwork,
      });
      if (art) engraveArt = serializeMapEngraveArt(art);
    } catch (e) {
      warnings.push(`OSM engrave skipped: ${(e as Error).message}`);
    }
  }
  const stored: MapSpec = {
    ...spec,
    crs: metric.crs,
    fetchedAt: new Date().toISOString(),
    layerBudget: budgetMode,
    layerBreaksM: budget.breaksM,
    exaggerationFactor: factor,
    exaggerationReadout: readout,
    exaggeration: spec.exaggeration === 'auto' ? 'auto' : factor,
    simplifyLostFeatures: simplified.lostFeatures,
    resolvedSource: resolved.effective,
    sourceWarnings: warnings.length ? warnings : undefined,
    ...(engraveArt ? { engraveArt } : {}),
    attribution: mergeAttribution(spec, resolved.effective).concat(
      engraveArt ? ['Map features © OpenStreetMap contributors (https://www.openstreetmap.org/copyright), ODbL'] : [],
    ),
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
  source: MapSource;
  resM: number;
  exaggeration: MapSpec['exaggeration'];
  engrave: MapSpec['engrave'];
  cacheDir?: string;
  layerBudget?: LayerBudgetMode;
  editionNumber?: number;
  archetypeCard?: Record<string, unknown>;
  commemorativeText?: string;
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
    editionNumber: parts.editionNumber,
    archetypeCard: parts.archetypeCard,
    commemorativeText: parts.commemorativeText,
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
