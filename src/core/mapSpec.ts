// Map input: open elevation and engraving spec stored on an ImageAsset (like pattern / sound / depth).
export type MapSource = 'auto' | 'ea-dtm' | 'ea-dsm' | 'cop30' | 'terrarium';
export type MapModel = 'dtm' | 'dsm' | 'dtm+buildings';
export type MapWater = 'flat' | 'bathy' | 'raw';

export interface EngraveSpec {
  /** Gabriel 16 Oct 2026: engraving on by default; no-op in the pipeline until OSM engrave lands. */
  enabled: boolean;
  /** Feature groups: roads, water, title, compass, contours, … */
  features: string[];
  /** Typographic preset id (survey, nautical, alpine, city, golf, …). */
  preset?: string;
}

export interface MapSpec {
  kind: 'map';
  /** WGS84 west, south, east, north (degrees). */
  bbox: [number, number, number, number];
  /** Metric CRS used for the depth grid (EPSG:27700 in GB, else UTM). */
  crs?: string;
  source: MapSource;
  model: MapModel;
  /** Target ground metres per depth-grid pixel along the long edge. */
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
    resM: patch.resM ?? 8,
    exaggeration: patch.exaggeration ?? 'auto',
    water: patch.water ?? 'bathy',
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

const SOURCES = new Set<MapSource>(['auto', 'ea-dtm', 'ea-dsm', 'cop30', 'terrarium']);
const MODELS = new Set<MapModel>(['dtm', 'dsm', 'dtm+buildings']);
const WATERS = new Set<MapWater>(['flat', 'bathy', 'raw']);

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
  const source = typeof o.source === 'string' && SOURCES.has(o.source as MapSource) ? (o.source as MapSource) : 'auto';
  const model = typeof o.model === 'string' && MODELS.has(o.model as MapModel) ? (o.model as MapModel) : 'dtm';
  const resM = num(o.resM);
  const water = typeof o.water === 'string' && WATERS.has(o.water as MapWater) ? (o.water as MapWater) : 'bathy';
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
  return {
    kind: 'map',
    bbox,
    ...(crs ? { crs } : {}),
    source,
    model,
    resM: resM != null && resM > 0 ? resM : 8,
    exaggeration,
    water,
    engrave: cleanEngrave(o.engrave),
    ...(title ? { title } : {}),
    ...(fetchedAt ? { fetchedAt } : {}),
    attribution: attribution.length ? attribution : [...TERRARIUM_ATTRIBUTION],
    ...(cacheDir ? { cacheDir } : {}),
  };
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
