import { defaultMapSpec, type MapSpec } from './mapSpec';

/** Acceptance bbox for Neasden / Brent (WGS84 west, south, east, north). */
export const NEASDEN_MAP_BBOX: MapSpec['bbox'] = [-0.28, 51.543, -0.233, 51.575];

/** Shooters Hill to Thames — Gabriel’s Woolwich wall-relief test map. */
export const WOOLWICH_MAP_BBOX: MapSpec['bbox'] = [-0.03, 51.465, 0.124, 51.505];

/** Welsh Harp (Brent Reservoir) open water — used to expand Neasden pieces (ticket T18). */
export const WELSH_HARP_WATER_BBOX: MapSpec['bbox'] = [-0.275, 51.552, -0.245, 51.572];

/** Kingsbarns (St Andrews) — Scotland LiDAR acceptance bbox. */
export const KINGSBARNS_MAP_BBOX: MapSpec['bbox'] = [-2.655, 56.335, -2.628, 56.352];

/** Royal County Down — Northern Ireland LiDAR acceptance bbox. */
export const ROYAL_COUNTY_DOWN_MAP_BBOX: MapSpec['bbox'] = [-5.808, 54.215, -5.775, 54.238];

/** Neasden clip used by `test/fixtures/map/overpass-ski.json` (ski engrave fixture). */
export const SKI_EXAMPLE_MAP_BBOX: MapSpec['bbox'] = [-0.262, 51.558, -0.252, 51.566];

export function unionMapBbox(a: MapSpec['bbox'], b: MapSpec['bbox']): MapSpec['bbox'] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function bboxContainsPoint(bbox: MapSpec['bbox'], lon: number, lat: number): boolean {
  const [w, s, e, n] = bbox;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

/** Centre of the Welsh Harp reservoir polygon (approximate). */
export const WELSH_HARP_SAMPLE_POINT: [number, number] = [-0.26, 51.562];

export interface MapPresetCatalogEntry {
  id: string;
  label: string;
  note: string;
}

export const MAP_PRESET_CATALOG: MapPresetCatalogEntry[] = [
  { id: 'neasden', label: 'Neasden', note: 'Brent, London — EA LiDAR auto' },
  { id: 'neasden-welsh-harp', label: 'Neasden & Welsh Harp', note: 'Neasden plus Brent Reservoir water' },
  { id: 'kingsbarns', label: 'Kingsbarns', note: 'St Andrews — Scotland 2 m LiDAR' },
  { id: 'royal-county-down', label: 'Royal County Down', note: 'Northern Ireland 1 m LiDAR' },
  { id: 'ski-example', label: 'Ski example', note: 'Offline piste fixture (Neasden clip)' },
];

const MAP_PRESET_IDS = new Set(MAP_PRESET_CATALOG.map((p) => p.id));

export function mapPresetIdList(): string {
  return MAP_PRESET_CATALOG.map((p) => p.id).join(', ');
}

export function parseMapPresetId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!MAP_PRESET_IDS.has(id)) throw new Error(`unknown map preset '${raw}' (valid: ${mapPresetIdList()})`);
  return id;
}

export function neasdenMapSpec(patch: Partial<MapSpec> = {}): MapSpec {
  const bbox = patch.bbox ?? NEASDEN_MAP_BBOX;
  return defaultMapSpec({
    title: 'Neasden',
    source: 'auto',
    engrave: { enabled: true, features: ['roads', 'water', 'title'], preset: 'city' },
    ...patch,
    bbox,
  });
}

function neasdenWelshHarpMapSpec(): MapSpec {
  return defaultMapSpec({
    title: 'Neasden & Welsh Harp',
    bbox: unionMapBbox(NEASDEN_MAP_BBOX, WELSH_HARP_WATER_BBOX),
    source: 'auto',
    engrave: { enabled: true, features: ['roads', 'water', 'title'], preset: 'city' },
  });
}

function kingsbarnsMapSpec(): MapSpec {
  return defaultMapSpec({
    title: 'Kingsbarns',
    bbox: KINGSBARNS_MAP_BBOX,
    source: 'auto',
    engrave: { enabled: true, features: ['roads', 'water', 'title', 'contours'], preset: 'golf' },
  });
}

function royalCountyDownMapSpec(): MapSpec {
  return defaultMapSpec({
    title: 'Royal County Down',
    bbox: ROYAL_COUNTY_DOWN_MAP_BBOX,
    source: 'auto',
    engrave: { enabled: true, features: ['roads', 'water', 'title', 'contours'], preset: 'golf' },
  });
}

function skiExampleMapSpec(): MapSpec {
  return defaultMapSpec({
    title: 'Ski example',
    bbox: SKI_EXAMPLE_MAP_BBOX,
    source: 'auto',
    engrave: { enabled: true, features: ['roads', 'water', 'title', 'ski', 'piste'], preset: 'ski' },
  });
}

/** Shared MapSpec for UI, CLI and design parser. */
export function mapPresetSpec(id: string): MapSpec {
  switch (parseMapPresetId(id)) {
    case 'neasden':
      return neasdenMapSpec();
    case 'neasden-welsh-harp':
      return neasdenWelshHarpMapSpec();
    case 'kingsbarns':
      return kingsbarnsMapSpec();
    case 'royal-county-down':
      return royalCountyDownMapSpec();
    case 'ski-example':
      return skiExampleMapSpec();
    default:
      throw new Error(`unknown map preset '${id}' (valid: ${mapPresetIdList()})`);
  }
}

/**
 * Re-clicking a map preset (Maps menu or Map tab) keeps user-set map fields.
 * Place identity (bbox, title) comes from the preset. Derived build artefacts
 * (buildKey, readout, engraveArt, resolvedSource) are not copied.
 */
export function keepUserMapSettings(prev: MapSpec | undefined, next: MapSpec): MapSpec {
  if (!prev) return next;
  return defaultMapSpec({
    ...next,
    source: prev.source,
    model: prev.model,
    resM: prev.resM,
    exaggeration: prev.exaggeration,
    water: prev.water,
    layerBudget: prev.layerBudget ?? next.layerBudget,
    engrave: { ...prev.engrave, features: [...prev.engrave.features] },
    commemorativeText: prev.commemorativeText,
    editionNumber: prev.editionNumber,
    buildingClampM: prev.buildingClampM,
    sunkenFrame: prev.sunkenFrame ? { ...prev.sunkenFrame } : next.sunkenFrame,
    giftSizeId: prev.giftSizeId,
    bbox: next.bbox,
    title: next.title,
  });
}

export function mapPresetSpecKeepingUser(id: string, prev?: MapSpec): MapSpec {
  return keepUserMapSettings(prev, mapPresetSpec(id));
}
