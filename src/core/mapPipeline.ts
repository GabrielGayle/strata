import type { MapSpec } from './mapSpec';
import { defaultMapSpec, TERRARIUM_ATTRIBUTION } from './mapSpec';
import { fetchTerrariumGrid, getTileFetcher, type TileFetcher } from './mapTerrarium';
import { cachedTileFetch } from './mapCache';
import { reprojectResample } from './mapProject';
import { mapGridToDepth } from './mapToDepth';
import { applyLayerBudget, computeLayerBreaks, injectPinnedBreaks, type LayerBudgetMode } from './mapLayerBudget';
import { formatExaggerationStackReadout, resolveExaggerationFactor } from './mapExaggeration';
import { restoreSummitCells, simplifyMetricGrid } from './mapSimplify';
import { prominentSummitCells } from './mapSummits';
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
import { applySoundingsToGrid, loadWelshHarpSampleSoundings } from './mapBathymetry';
import { applyLocalWaterResult, estimateWaterSurfaceM, restoreWaterSurfaces, waterBodiesFromOverpass, type LocalWaterResult } from './mapWater';
import { buildMapEngraveArt } from './mapEngraveBuild';
import { serializeMapEngraveArt } from './mapOsmEngrave';
import type { OverpassFetcher } from './mapOverpass';
import type { MapSource } from './mapSpec';
import { mapBuildKey } from './mapBuildKey';
import { mapStackFromProject, mapUsesLayerBudget, type MapStackContext } from './mapStack';
import { mapInfo, mapWarn, noticesWithoutStaleEngraveSkip, type MapSourceNotice } from './mapNotices';
import type { DepthData } from './depth';
import type { Float32Grid } from './mapGrid';
import { sanitizeElevationGrid } from './mapElevation';
import type { ImageAsset } from './project';

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



export interface BuildMapImageOptions {
  cacheDir?: string;
  fetch?: TileFetcher;
  stack?: MapStackContext;
  regionalLoader?: RegionalGridLoader;
  eaLoader?: EaGridLoader;
  overpass?: OverpassFetcher;
  /** When true, Overpass may use the network if the cache misses (CLI default). */
  allowOverpassNetwork?: boolean;
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
  notices: MapSourceNotice[],
  opts: BuildMapImageOptions,
): Promise<{ grid: Float32Grid; used: MapSource }> {
  const fetch: TileFetcher = async (url) => {
    const inner = opts.fetch ?? getTileFetcher();
    return cachedTileFetch(spec.cacheDir ?? opts.cacheDir, url, inner);
  };

  const ok = (grid: Float32Grid, used: MapSource) => ({ grid: sanitizeElevationGrid(grid), used });

  if (effective === 'terrarium') {
    return ok(await fetchTerrariumGrid(spec, { fetch }), 'terrarium');
  }

  if (isRegionalLidarSource(effective)) {
    const grid = await fetchRegionalLidarGrid(effective, spec, opts.regionalLoader);
    if (grid) return ok(grid, effective);
    notices.push(mapWarn(`${effective} LiDAR is not supported yet; using terrarium (~30 m).`));
    return ok(await fetchTerrariumGrid(spec, { fetch }), 'terrarium');
  }

  if (isEaLidarSource(effective)) {
    let reason = '';
    const grid = await fetchEaLidarGrid(effective, spec, { loader: opts.eaLoader, onError: (m) => (reason = m) });
    if (grid) return ok(grid, effective);
    const why = reason ? ` (${reason})` : '';
    notices.push(mapWarn(`${effective} LiDAR not available for this bbox${why}; falling back to terrarium (~30 m).`));
    return ok(await fetchTerrariumGrid(spec, { fetch }), 'terrarium');
  }

  if (STUB_SOURCES.has(effective)) {
    notices.push(mapWarn(`${effective} adapter not shipped yet; falling back to terrarium (~30 m).`));
    return ok(await fetchTerrariumGrid(spec, { fetch }), 'terrarium');
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
  const notices: MapSourceNotice[] = resolved.warnings.map(mapWarn);
  const faceW = opts.stack?.masterWidthMm ?? 520;
  const commWarn = spec.commemorativeText ? commemorativeFitWarning(spec.commemorativeText, faceW) : null;
  if (commWarn) notices.push(mapWarn(commWarn));
  const fetchSource = resolveElevationSourceForModel(resolved.effective, spec.model);
  const elevHit = await fetchElevationGrid(spec, fetchSource, notices, opts);
  const elev = elevHit.grid;
  /** Actual raster after fallback — auto exaggeration and the readout source must use this, not the pick. */
  const usedSource = elevHit.used;
  const resampleSpec = { ...spec, model: spec.model === 'dtm+buildings' ? 'dtm' : spec.model };
  let metric = reprojectResample(elev, resampleSpec);
  let dtmMetric = metric;
  if (spec.model === 'dsm' && fetchSource !== resolved.effective) {
    const dtmElev = await fetchElevationGrid(spec, resolved.effective, notices, opts);
    dtmMetric = reprojectResample(dtmElev.grid, { ...spec, model: 'dtm' });
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
      notices.push(mapWarn(`OSM buildings skipped: ${(e as Error).message}`));
    }
  }
  if (spec.model !== 'dtm') {
    metric = clampTowerRise(metric, dtmMetric, buildingClampMetres(spec));
  }
  /** Relief for auto exaggeration uses bare terrain before water flattening (flat water shrinks p98−p2). */
  const metricForExaggeration = metric;
  const rawMetric: Float32Grid = { ...metric, data: new Float32Array(metric.data) };
  let bathyApplied = false;
  let water: LocalWaterResult | null = null;
  if (spec.water === 'bathy') {
    const soundings = loadWelshHarpSampleSoundings(spec.bbox);
    if (soundings.length) {
      const surface = estimateWaterSurfaceM(metric);
      metric = applySoundingsToGrid(metric, soundings, surface);
      bathyApplied = true;
    } else {
      notices.push(mapInfo('No bathymetry for this bbox; falling back to per-lake water surface.'));
    }
  }
  if (spec.water === 'flat' || (spec.water === 'bathy' && !bathyApplied)) {
    try {
      const osm = await fetchOverpass(spec.bbox, {
        cacheDir: spec.cacheDir ?? opts.cacheDir,
        fetch: opts.overpass,
        allowNetwork: opts.allowOverpassNetwork,
        features: ['water'],
      });
      const bodies = waterBodiesFromOverpass(osm as Parameters<typeof waterBodiesFromOverpass>[0], spec, metric.crs ?? 'EPSG:27700');
      if (bodies.length) {
        water = applyLocalWaterResult(metric, bodies);
        metric = water.grid;
      }
    } catch (e) {
      notices.push(mapWarn(`Water flatten skipped: ${(e as Error).message}`));
    }
  }
  const stack = opts.stack ?? { plateCount: 12, thicknessMm: 3, masterWidthMm: 520, layerBudget: 'jenks' as LayerBudgetMode };
  const { factor } = resolveExaggerationFactor(
    { exaggeration: spec.exaggeration },
    metricForExaggeration,
    stack,
  );
  const budgetMode = spec.layerBudget ?? stack.layerBudget ?? 'jenks';
  /** Same classes as water-off, including the max-height class. Lake pins are extra. */
  const landBudget = computeLayerBreaks(rawMetric, stack.plateCount, budgetMode);
  const budget = {
    ...landBudget,
    breaksM: injectPinnedBreaks(landBudget.breaksM, water?.lakeSurfacesM ?? [], stack.plateCount),
  };
  const terraced = mapUsesLayerBudget(spec, stack);
  metric = terraced ? applyLayerBudget(rawMetric, landBudget.breaksM) : rawMetric;
  const simplified = simplifyMetricGrid(metric, {
    kerfMm: stack.kerfMm ?? 0.2,
    pixelSizeM: Math.abs(metric.transform.pixelW),
  });
  const restoredLand = restoreSummitCells(simplified.grid, metric, prominentSummitCells(rawMetric));
  metric = water ? restoreWaterSurfaces(restoredLand, rawMetric, water, terraced ? landBudget.breaksM : []) : restoredLand;
  const { depth } = mapGridToDepth(metric, { exaggeration: factor, resolution: 384, bbox: spec.bbox });
  const ortho = depth.mapOrtho;
  const readout = formatExaggerationStackReadout(
    factor,
    ortho?.reliefM ?? 0,
    ortho?.widthM ?? 1,
    stack.masterWidthMm,
  );
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
      notices.push(mapWarn(`OSM engrave skipped: ${(e as Error).message}`));
    }
  }
  const hasEngraveArt = (engraveArt?.lines?.length ?? 0) > 0;
  const filteredNotices = noticesWithoutStaleEngraveSkip(notices, hasEngraveArt);
  const stored: MapSpec = {
    ...spec,
    buildKey: mapBuildKey(spec, opts.stack),
    crs: metric.crs,
    fetchedAt: new Date().toISOString(),
    layerBudget: budgetMode,
    layerBreaksM: budget.breaksM,
    exaggerationFactor: factor,
    exaggerationReadout: readout,
    exaggeration: spec.exaggeration === 'auto' ? 'auto' : factor,
    simplifyLostFeatures: simplified.lostFeatures,
    resolvedSource: usedSource,
    sourceWarnings: filteredNotices.length ? filteredNotices : undefined,
    attribution: mergeAttribution(spec, usedSource).concat(
      hasEngraveArt ? ['Map features © OpenStreetMap contributors (https://www.openstreetmap.org/copyright), ODbL'] : [],
    ),
  };
  if (engraveArt && hasEngraveArt) stored.engraveArt = engraveArt;
  else delete stored.engraveArt;
  if (!filteredNotices.length) delete stored.sourceWarnings;
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

export type { DepthData, MapStackContext };
export { mapStackFromProject, mapUsesLayerBudget };
