// Map input: open elevation and engraving spec stored on an ImageAsset (like pattern / sound / depth).
import type { SerializedMapEngraveArt } from './mapOsmEngrave';
import { normalizeSourceNotices, type MapSourceNotice } from './mapNotices';
export type MapSource =
  | 'auto'
  | 'scot-dtm'
  | 'wales-dtm'
  | 'ni-dtm'
  | 'ea-dtm'
  | 'ea-dsm'
  | 'terrarium';
export type MapModel = 'dtm' | 'dsm' | 'dtm+buildings';
export type MapWater = 'flat' | 'bathy' | 'raw';
export type LayerBudgetMode = 'equal' | 'quantile' | 'jenks';

export interface EngraveSpec {
  /** Engraving on by default when map mode is used. */
  enabled: boolean;
  /** Feature groups: roads, water, title, compass, contours, … */
  features: string[];
  /** Typographic preset id (survey, nautical, alpine, city, golf, …). */
  preset?: string;
}

/** `MapSpec.resM` value that sizes the grid from the source and the model. */
export const MAP_RES_AUTO = 0;

/** Default Gaussian width (sigma, mm on the model) for the map elevation grid: about what the old 3×3 box gave at 1 mm per cell. */
export const MAP_SMOOTH_MM = 0.75;

export interface MapSpec {
  kind: 'map';
  /** WGS84 west, south, east, north (degrees). */
  bbox: [number, number, number, number];
  /** Metric CRS used for the depth grid (EPSG:27700 in GB, else UTM). */
  crs?: string;
  source: MapSource;
  model: MapModel;
  /**
   * Target ground metres per depth-grid pixel along the long edge. MAP_RES_AUTO (0) picks it from
   * the source and the model size (see mapGridSize).
   */
  resM: number;
  exaggeration: number | 'auto';
  water: MapWater;
  engrave: EngraveSpec;
  title?: string;
  fetchedAt?: string;
  /** Licence lines for BOM / back-plate etch. */
  attribution: string[];
  /** CLI / browser cache directory override. */
  cacheDir?: string;
  /** How elevation plateaus are chosen per plate (default jenks). */
  layerBudget?: LayerBudgetMode;
  /**
   * Snap upright map faces to the layer budget (the old terraced look).
   * Flat stacks always snap; upright stacks keep continuous heights unless this is on.
   */
  terraced?: boolean;
  /**
   * Gaussian smoothing of the elevation grid, as a width (sigma) in millimetres on
   * the model, so it smooths the same amount at any grid size. Default MAP_SMOOTH_MM.
   */
  smoothMm?: number;
  /** Resolved vertical exaggeration factor when auto was requested. */
  exaggerationFactor?: number;
  /** Human readout, e.g. "×21". */
  exaggerationReadout?: string;
  /** Elevation breaks (metres) used for the layer budget. */
  layerBreaksM?: number[];
  /** Features dropped by auto-simplify (islands/holes below min area). */
  simplifyLostFeatures?: number;
  /** Source actually used after auto-pick / fallbacks. */
  resolvedSource?: MapSource;
  /** Non-fatal fetch / resolution warnings for the UI or CLI. */
  sourceWarnings?: MapSourceNotice[];
  /** OSM vector engrave linework in depth-image pixel space (ticket 13). */
  engraveArt?: SerializedMapEngraveArt;
  /** Limited-edition number etched on the back plate (ticket 25). */
  editionNumber?: number;
  /** JSON metadata shipped as `map/archetype-card.json` in the build pack (ticket 25). */
  archetypeCard?: Record<string, unknown>;
  /** Short dedication etched on the back plate when it fits (ticket 26). */
  commemorativeText?: string;
  /** Max DSM − DTM rise in metres before exaggeration (ticket 15, default 25). */
  buildingClampM?: number;
  /** Sunken concrete-frame surround (ticket 28). */
  sunkenFrame?: { enabled: boolean; castToleranceMm?: number; wallMm?: number };
  /** Gift / map face sizing hint for pricing (ticket 27). */
  giftSizeId?: string;
  /** Matches `mapBuildKey` when depth grid was last built in the browser/CLI. */
  buildKey?: string;
  /**
   * Build this map on the cloud at up to 2048 px when Boost is on ("High resolution (cloud)").
   * With Boost off, or when the cloud is unavailable, the local 1024 px build is used.
   */
  cloudRes?: boolean;
  /**
   * Set when the depth came from the cloud terrain job: the result's key in the cloud cache and
   * its long edge. Saved projects keep a 1024 px copy; the full grid is fetched again by key.
   */
  cloudBuilt?: { key: string; px: number };
}

export const TERRARIUM_ATTRIBUTION = [
  'Terrain tiles © Mapzen / AWS Terrain Tiles (https://registry.opendata.aws/terrain-tiles/)',
  'See https://github.com/tilezen/joerd/blob/master/docs/attribution.md for source contributors',
];

export const DEFAULT_ENGRAVE_FEATURES = ['roads', 'water', 'title', 'compass'];

export function defaultEngrave(enabled = true): EngraveSpec {
  return { enabled, features: [...DEFAULT_ENGRAVE_FEATURES] };
}

export function defaultMapSpec(patch: Partial<MapSpec> & { bbox: MapSpec['bbox'] }): MapSpec {
  const engrave = patch.engrave ?? defaultEngrave(true);
  const attribution = patch.attribution ?? [...TERRARIUM_ATTRIBUTION];
  return {
    kind: 'map',
    source: patch.source ?? 'auto',
    model: patch.model ?? 'dtm',
    resM: patch.resM ?? MAP_RES_AUTO,
    exaggeration: patch.exaggeration ?? 'auto',
    water: patch.water ?? 'flat',
    title: patch.title,
    crs: patch.crs,
    fetchedAt: patch.fetchedAt,
    cacheDir: patch.cacheDir,
    ...patch,
    bbox: patch.bbox,
    engrave,
    attribution,
  };
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function bboxOf(raw: unknown): MapSpec['bbox'] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const w = num(raw[0]);
  const s = num(raw[1]);
  const e = num(raw[2]);
  const n = num(raw[3]);
  if (w == null || s == null || e == null || n == null) return null;
  if (e <= w || n <= s) return null;
  if (w < -180 || e > 180 || s < -90 || n > 90) return null;
  return [w, s, e, n];
}

const SOURCES = new Set<MapSource>([
  'auto',
  'scot-dtm',
  'wales-dtm',
  'ni-dtm',
  'ea-dtm',
  'ea-dsm',
  'terrarium',
]);
/** Ids older saves may carry: the Copernicus stub was removed and always fell back to Terrarium. */
const RETIRED_SOURCES: Record<string, MapSource> = { cop30: 'terrarium' };
const MODELS = new Set<MapModel>(['dtm', 'dsm', 'dtm+buildings']);
const WATERS = new Set<MapWater>(['flat', 'bathy', 'raw']);
const BUDGETS = new Set<LayerBudgetMode>(['equal', 'quantile', 'jenks']);

function cleanEngrave(raw: unknown): EngraveSpec {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return defaultEngrave(true);
  const enabled = o.enabled === false ? false : true;
  const features: string[] = [];
  if (Array.isArray(o.features)) {
    for (const f of o.features) if (typeof f === 'string' && f.trim()) features.push(f.trim());
  }
  if (!features.length) features.push(...DEFAULT_ENGRAVE_FEATURES);
  const preset = typeof o.preset === 'string' && o.preset.trim() ? o.preset.trim() : undefined;
  return { enabled, features, ...(preset ? { preset } : {}) };
}

/** Drop invalid map specs; normalise enums and defaults. */
export function cleanMapSpec(raw: unknown): MapSpec | undefined {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || o.kind !== 'map') return undefined;
  const bbox = bboxOf(o.bbox);
  if (!bbox) return undefined;
  const source =
    typeof o.source !== 'string'
      ? 'auto'
      : SOURCES.has(o.source as MapSource)
        ? (o.source as MapSource)
        : (RETIRED_SOURCES[o.source] ?? 'auto');
  const model = typeof o.model === 'string' && MODELS.has(o.model as MapModel) ? (o.model as MapModel) : 'dtm';
  const resM = num(o.resM);
  const water = typeof o.water === 'string' && WATERS.has(o.water as MapWater) ? (o.water as MapWater) : 'flat';
  let exaggeration: number | 'auto' = 'auto';
  if (o.exaggeration === 'auto') exaggeration = 'auto';
  else {
    const ex = num(o.exaggeration);
    if (ex != null && ex > 0) exaggeration = ex;
  }
  const attribution = Array.isArray(o.attribution)
    ? o.attribution.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    : [...TERRARIUM_ATTRIBUTION];
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : undefined;
  const crs = typeof o.crs === 'string' && o.crs.trim() ? o.crs.trim() : undefined;
  const fetchedAt = typeof o.fetchedAt === 'string' ? o.fetchedAt : undefined;
  const cacheDir = typeof o.cacheDir === 'string' && o.cacheDir.trim() ? o.cacheDir.trim() : undefined;
  const layerBudget =
    typeof o.layerBudget === 'string' && BUDGETS.has(o.layerBudget as LayerBudgetMode) ? (o.layerBudget as LayerBudgetMode) : undefined;
  const exaggerationFactor = num(o.exaggerationFactor);
  const exaggerationReadout = typeof o.exaggerationReadout === 'string' ? o.exaggerationReadout : undefined;
  const layerBreaksM = Array.isArray(o.layerBreaksM)
    ? o.layerBreaksM.map((x) => Number(x)).filter((x) => Number.isFinite(x))
    : undefined;
  const simplifyLostFeatures = num(o.simplifyLostFeatures);
  const resolvedSource =
    typeof o.resolvedSource === 'string' && SOURCES.has(o.resolvedSource as MapSource) ? (o.resolvedSource as MapSource) : undefined;
  const sourceWarnings = normalizeSourceNotices(o.sourceWarnings);
  const engraveArt = cleanEngraveArt(o.engraveArt);
  const editionNumber = num(o.editionNumber);
  const archetypeCard = cleanArchetypeCard(o.archetypeCard);
  const commemorativeText =
    typeof o.commemorativeText === 'string' && o.commemorativeText.trim() ? o.commemorativeText.trim() : undefined;
  const buildingClampM = num(o.buildingClampM);
  const smoothMm = num(o.smoothMm);
  const sunkenFrame = cleanSunkenFrame(o.sunkenFrame);
  const giftSizeId = typeof o.giftSizeId === 'string' && o.giftSizeId.trim() ? o.giftSizeId.trim() : undefined;
  const cloudBuilt = cleanCloudBuilt(o.cloudBuilt);
  return {
    kind: 'map',
    bbox,
    ...(crs ? { crs } : {}),
    source,
    model,
    resM: resM != null && resM >= 0 ? resM : MAP_RES_AUTO,
    exaggeration,
    water,
    engrave: cleanEngrave(o.engrave),
    ...(title ? { title } : {}),
    ...(fetchedAt ? { fetchedAt } : {}),
    attribution: attribution.length ? attribution : [...TERRARIUM_ATTRIBUTION],
    ...(cacheDir ? { cacheDir } : {}),
    ...(layerBudget ? { layerBudget } : {}),
    ...(o.terraced === true ? { terraced: true } : {}),
    ...(smoothMm != null && smoothMm >= 0 ? { smoothMm } : {}),
    ...(exaggerationFactor != null && exaggerationFactor > 0 ? { exaggerationFactor } : {}),
    ...(exaggerationReadout ? { exaggerationReadout } : {}),
    ...(layerBreaksM?.length ? { layerBreaksM } : {}),
    ...(simplifyLostFeatures != null && simplifyLostFeatures >= 0 ? { simplifyLostFeatures } : {}),
    ...(resolvedSource ? { resolvedSource } : {}),
    ...(sourceWarnings?.length ? { sourceWarnings } : {}),
    ...(engraveArt ? { engraveArt } : {}),
    ...(editionNumber != null && editionNumber >= 1 ? { editionNumber: Math.round(editionNumber) } : {}),
    ...(archetypeCard ? { archetypeCard } : {}),
    ...(commemorativeText ? { commemorativeText } : {}),
    ...(buildingClampM != null && buildingClampM > 0 ? { buildingClampM } : {}),
    ...(sunkenFrame ? { sunkenFrame } : {}),
    ...(giftSizeId ? { giftSizeId } : {}),
    ...(o.cloudRes === true ? { cloudRes: true } : {}),
    ...(cloudBuilt ? { cloudBuilt } : {}),
  };
}

function cleanCloudBuilt(raw: unknown): MapSpec['cloudBuilt'] | undefined {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || typeof o.key !== 'string' || !/^[0-9a-f]{32,64}$/.test(o.key)) return undefined;
  const px = num(o.px);
  return px != null && px > 0 ? { key: o.key, px: Math.round(px) } : undefined;
}

function cleanSunkenFrame(raw: unknown): MapSpec['sunkenFrame'] | undefined {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return undefined;
  if (o.enabled === false) return { enabled: false };
  const castToleranceMm = num(o.castToleranceMm);
  const wallMm = num(o.wallMm);
  return {
    enabled: true,
    ...(castToleranceMm != null && castToleranceMm > 0 ? { castToleranceMm } : {}),
    ...(wallMm != null && wallMm > 0 ? { wallMm } : {}),
  };
}

function cleanArchetypeCard(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function cleanEngraveArt(raw: unknown): SerializedMapEngraveArt | undefined {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return undefined;
  const imageW = num(o.imageW);
  const imageH = num(o.imageH);
  if (imageW == null || imageH == null || imageW < 1 || imageH < 1) return undefined;
  const lines: SerializedMapEngraveArt['lines'] = [];
  if (Array.isArray(o.lines)) {
    for (const ln of o.lines) {
      if (!ln || typeof ln !== 'object') continue;
      const rec = ln as Record<string, unknown>;
      const kind =
        rec.kind === 'road' ||
          rec.kind === 'water' ||
          rec.kind === 'rail' ||
          rec.kind === 'golf' ||
          rec.kind === 'piste' ||
          rec.kind === 'other'
          ? rec.kind
          : 'other';
      const path: [number, number][] = [];
      if (Array.isArray(rec.path)) {
        for (const pt of rec.path) {
          if (!Array.isArray(pt) || pt.length < 2) continue;
          const x = num(pt[0]);
          const y = num(pt[1]);
          if (x != null && y != null) path.push([x, y]);
        }
      }
      if (path.length >= 2) lines.push({ kind, path });
    }
  }
  const texts: SerializedMapEngraveArt['texts'] = [];
  if (Array.isArray(o.texts)) {
    for (const t of o.texts) {
      if (!t || typeof t !== 'object') continue;
      const rec = t as Record<string, unknown>;
      const text = typeof rec.text === 'string' ? rec.text : '';
      const nx = num(rec.nx);
      const ny = num(rec.ny);
      if (text && nx != null && ny != null) texts.push({ text, nx, ny });
    }
  }
  const osmAttribution = typeof o.osmAttribution === 'string' ? o.osmAttribution : '© OpenStreetMap contributors (ODbL)';
  return { imageW, imageH, lines, texts, osmAttribution };
}

export function parseLayerBudget(text: string): LayerBudgetMode {
  const s = text.trim().toLowerCase();
  if (!BUDGETS.has(s as LayerBudgetMode)) throw new Error(`unknown layer budget '${text}' (equal, quantile, jenks)`);
  return s as LayerBudgetMode;
}

export function parseBbox(text: string): MapSpec['bbox'] {
  const parts = text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 4) throw new Error('bbox expects west,south,east,north (four numbers)');
  const bbox = bboxOf(parts.map(Number));
  if (!bbox) throw new Error('invalid bbox: need west<south east, south<north, WGS84 degrees');
  return bbox;
}

export function parseMapSource(text: string): MapSource {
  const s = text.trim().toLowerCase();
  if (!SOURCES.has(s as MapSource)) throw new Error(`unknown map source '${text}'`);
  return s as MapSource;
}

export function parseExaggeration(text: string): number | 'auto' {
  const s = text.trim().toLowerCase();
  if (s === 'auto') return 'auto';
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new Error('exaggeration must be a positive number or auto');
  return n;
}

export function parseEngraveFlag(text: string | undefined, enabledDefault = true): EngraveSpec {
  if (text == null || text === '') return defaultEngrave(enabledDefault);
  const lower = text.toLowerCase();
  if (lower === 'off' || lower === 'false' || lower === 'none') return { enabled: false, features: [] };
  if (lower === 'on' || lower === 'true') return defaultEngrave(true);
  const features = text.split(',').map((s) => s.trim()).filter(Boolean);
  return { enabled: enabledDefault, features: features.length ? features : [...DEFAULT_ENGRAVE_FEATURES] };
}
