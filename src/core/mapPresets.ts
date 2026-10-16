import { defaultMapSpec, type MapSpec } from './mapSpec';

/** Acceptance bbox for Neasden / Brent (WGS84 west, south, east, north). */
export const NEASDEN_MAP_BBOX: MapSpec['bbox'] = [-0.28, 51.543, -0.233, 51.575];

/** Welsh Harp (Brent Reservoir) open water — used to expand Neasden pieces (ticket T18). */
export const WELSH_HARP_WATER_BBOX: MapSpec['bbox'] = [-0.275, 51.552, -0.245, 51.572];

export function unionMapBbox(a: MapSpec['bbox'], b: MapSpec['bbox']): MapSpec['bbox'] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function bboxContainsPoint(bbox: MapSpec['bbox'], lon: number, lat: number): boolean {
  const [w, s, e, n] = bbox;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

/** Centre of the Welsh Harp reservoir polygon (approximate). */
export const WELSH_HARP_SAMPLE_POINT: [number, number] = [-0.26, 51.562];

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
