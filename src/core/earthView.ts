// Google Earth "view from point": parse a web URL (or typed lat/lon/…) and
// turn it into a camera over the current map in Strata's world frame.
//
// Earth web URLs look like:
//   …/@lat,lon,ALTa,DISTd,FOVy,HEADINGh,TILTt,ROLLr
// Every component except lat and lon is optional. Signs may be + or −.
//
// How `a` and `d` are read
// -----------------------
// `@lat,lon,ALTa` is the LOOK-AT target (the point in the middle of the view),
// not the camera. The camera sits `d` metres back along the heading/tilt ray:
//   camera = lookAt − d × forward
// Heading is clockwise from north (−75.96° looks WNW). Tilt 0 looks straight
// down; 90 looks at the horizon. `y` is vertical FOV in degrees (default 35).
//
// If `a` were camera altitude, the Woolwich URL (19.6a, 192.8d, 72.7t) would
// put the look-at ~38 m underground, and `@51.482,0.048,43a,5168.7d,85.33t`
// ~420 m underground. Treating `a` as look-at altitude puts those cameras at
// ~77 m and ~464 m — a hillside and an aerial view, matching "Shooters Hill /
// Woolwich looking toward the Thames".
//
// Typed fields without a distance (lat, lon, altitude, heading, tilt [, FOV])
// place the *camera* at lat/lon/alt and look along heading/tilt.
import { mapGridUvToWorld, mapMasterWidthMm, MAP_HEIGHT_FLOOR_MM, mapScaleMmPerM } from './mapPlateHeight';
import { pickMetricCrs, lonLatToMetric, metricBounds } from './mapProject';
import { bboxContainsPoint } from './mapPresets';
import type { MapSpec } from './mapSpec';
import { defaultMapSpec } from './mapSpec';
import type { Values } from './params';
import { baseTop } from './slicer';

export const EARTH_DEFAULT_FOV = 35;
export const EARTH_DEFAULT_LOOK_M = 250;
/** Far-edge cap when the frustum grazes the horizon, metres on the ground. */
export const EARTH_MAX_GROUND_M = 20_000;

export interface EarthView {
  /** Look-at latitude when `distance` is set; otherwise camera latitude. */
  lat: number;
  lon: number;
  /** Metres. Look-at altitude when `distance` is set; otherwise camera altitude. */
  altitude: number;
  /**
   * Metres from the look-at back along the view ray. Present on Earth web URLs.
   * Missing: lat/lon/altitude is the camera.
   */
  distance?: number;
  /** Degrees, clockwise from north, wrapped to (−180, 180]. */
  heading: number;
  /** Degrees from nadir: 0 straight down, 90 horizon. */
  tilt: number;
  /** Vertical field of view, degrees. */
  fov: number;
  /** Degrees around the view axis; 0 is level. */
  roll: number;
}

export type EarthViewParse =
  | { ok: true; view: EarthView }
  | { ok: false; error: string };

export interface EarthWorldPose {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
}

export interface EnuM {
  east: number;
  north: number;
  up: number;
}

const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const TOKEN = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([adhytr])?$/i;

const PARSE_HINT =
  'Paste a Google Earth URL, or type lat, lon, altitude (m), heading (°) and tilt (°).';

function finite(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Wrap degrees to (−180, 180]. 400 → 40; −75.96 stays −75.96. */
export function wrapHeadingDeg(heading: number): number {
  if (!finite(heading)) return 0;
  const x = ((heading % 360) + 360) % 360;
  return x > 180 ? x - 360 : x;
}

export function cleanEarthView(raw: unknown): EarthView | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  if (!finite(lat) || !finite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;
  const altitude = finite(Number(r.altitude)) ? Number(r.altitude) : 0;
  const heading = wrapHeadingDeg(Number(r.heading));
  const tilt = finite(Number(r.tilt)) ? Number(r.tilt) : 0;
  const fov = finite(Number(r.fov)) && Number(r.fov) > 0 ? Number(r.fov) : EARTH_DEFAULT_FOV;
  const roll = finite(Number(r.roll)) ? Number(r.roll) : 0;
  const distance = finite(Number(r.distance)) && Number(r.distance) > 0 ? Number(r.distance) : undefined;
  const view: EarthView = { lat, lon, altitude, heading, tilt, fov, roll };
  if (distance != null) view.distance = distance;
  return view;
}

function readNumber(s: string): number | null {
  const t = s.trim();
  if (!NUM.test(t)) return null;
  const n = Number(t);
  return finite(n) ? n : null;
}

function withDefaults(partial: Partial<EarthView> & Pick<EarthView, 'lat' | 'lon'>): EarthView {
  return {
    lat: partial.lat,
    lon: partial.lon,
    altitude: partial.altitude ?? 0,
    heading: wrapHeadingDeg(partial.heading ?? 0),
    tilt: partial.tilt ?? 0,
    fov: partial.fov != null && partial.fov > 0 ? partial.fov : EARTH_DEFAULT_FOV,
    roll: partial.roll ?? 0,
    ...(partial.distance != null && partial.distance > 0 ? { distance: partial.distance } : {}),
  };
}

function parseAtBody(body: string): EarthViewParse {
  const parts = body.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) return { ok: false, error: PARSE_HINT };
  const lat = readNumber(parts[0]);
  const lon = readNumber(parts[1]);
  if (lat == null || lon == null) {
    return { ok: false, error: 'Could not read latitude and longitude from that view.' };
  }
  if (lat < -90 || lat > 90) return { ok: false, error: 'Latitude must be between −90 and 90.' };
  if (lon < -180 || lon > 180) return { ok: false, error: 'Longitude must be between −180 and 180.' };

  const assigned: Partial<EarthView> = { lat, lon };
  const positional: Array<keyof Pick<EarthView, 'altitude' | 'distance' | 'fov' | 'heading' | 'tilt' | 'roll'>> = [
    'altitude',
    'distance',
    'fov',
    'heading',
    'tilt',
    'roll',
  ];
  const bySuffix: Record<string, keyof EarthView> = {
    a: 'altitude',
    d: 'distance',
    y: 'fov',
    h: 'heading',
    t: 'tilt',
    r: 'roll',
  };
  let pos = 0;
  for (const part of parts.slice(2)) {
    const m = TOKEN.exec(part);
    if (!m) {
      return { ok: false, error: `Could not read “${part}” in that Google Earth view.` };
    }
    const n = Number(m[1]);
    if (!finite(n)) {
      return { ok: false, error: `Could not read “${part}” in that Google Earth view.` };
    }
    const suffix = m[2]?.toLowerCase();
    if (suffix) {
      const key = bySuffix[suffix];
      (assigned as Record<string, number>)[key] = n;
    } else {
      const key = positional[pos];
      if (!key) {
        return { ok: false, error: 'That view has extra numbers after roll.' };
      }
      (assigned as Record<string, number>)[key] = n;
      pos += 1;
    }
  }
  return { ok: true, view: withDefaults(assigned as EarthView) };
}

function parseTyped(text: string): EarthViewParse {
  const parts = text.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { ok: false, error: PARSE_HINT };
  const nums = parts.map(readNumber);
  if (nums.some((n) => n == null)) {
    return { ok: false, error: PARSE_HINT };
  }
  const [lat, lon, altitude, heading, tilt, fov] = nums as number[];
  if (lat < -90 || lat > 90) return { ok: false, error: 'Latitude must be between −90 and 90.' };
  if (lon < -180 || lon > 180) return { ok: false, error: 'Longitude must be between −180 and 180.' };
  if (parts.length === 4) {
    return { ok: false, error: 'Need heading and tilt together (lat, lon, altitude, heading, tilt).' };
  }
  if (parts.length > 6) {
    return { ok: false, error: 'Too many numbers. Use lat, lon, altitude, heading, tilt, and optional FOV.' };
  }
  return {
    ok: true,
    view: withDefaults({
      lat,
      lon,
      ...(parts.length >= 3 ? { altitude } : {}),
      ...(parts.length >= 5 ? { heading, tilt } : {}),
      ...(parts.length >= 6 ? { fov } : {}),
    }),
  };
}

/** Parse a Google Earth URL, an `@lat,lon,…` fragment, or typed numbers. */
export function parseEarthView(input: string): EarthViewParse {
  const text = input.trim();
  if (!text) return { ok: false, error: PARSE_HINT };
  const at = text.lastIndexOf('@');
  if (at >= 0) {
    let body = text.slice(at + 1);
    const cut = body.search(/[/?#\s]/);
    if (cut >= 0) body = body.slice(0, cut);
    if (!body) return { ok: false, error: 'That URL has no @lat,lon view. Copy the link from Google Earth.' };
    return parseAtBody(body);
  }
  if (/earth\.google\.com/i.test(text) || /^https?:\/\//i.test(text)) {
    return { ok: false, error: 'That URL has no @lat,lon view. Copy the link from Google Earth.' };
  }
  return parseTyped(text);
}

export function earthForwardEnu(headingDeg: number, tiltDeg: number): EnuM {
  const h = (headingDeg * Math.PI) / 180;
  const t = (tiltDeg * Math.PI) / 180;
  const st = Math.sin(t);
  return {
    east: Math.sin(h) * st,
    north: Math.cos(h) * st,
    up: -Math.cos(t),
  };
}

/**
 * Look direction in the map world frame (+X south, +Y up, +Z west).
 * Horizontal metres scale uniformly; vertical is multiplied by exaggeration.
 */
export function lookDirectionWorld(headingDeg: number, tiltDeg: number, exaggeration = 1): { x: number; y: number; z: number } {
  const f = earthForwardEnu(headingDeg, tiltDeg);
  const x = -f.north;
  const y = f.up * Math.max(0, exaggeration);
  const z = -f.east;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

function addEnu(a: EnuM, b: EnuM, k = 1): EnuM {
  return { east: a.east + b.east * k, north: a.north + b.north * k, up: a.up + b.up * k };
}

/** Camera and look-at in a local ENU frame whose origin is the @ lat/lon at 0 m. */
export function earthViewEnu(view: EarthView): { camera: EnuM; lookAt: EnuM } {
  const fwd = earthForwardEnu(view.heading, view.tilt);
  if (view.distance != null && view.distance > 0) {
    const lookAt = { east: 0, north: 0, up: view.altitude };
    return { lookAt, camera: addEnu(lookAt, fwd, -view.distance) };
  }
  const camera = { east: 0, north: 0, up: view.altitude };
  return { camera, lookAt: addEnu(camera, fwd, EARTH_DEFAULT_LOOK_M) };
}

export function offsetLonLat(lon: number, lat: number, eastM: number, northM: number): { lon: number; lat: number } {
  const cos = Math.cos((lat * Math.PI) / 180);
  const lonPerM = 1 / Math.max(1e-6, 111_320 * Math.max(0.05, Math.abs(cos)));
  return { lon: lon + eastM * lonPerM, lat: lat + northM / 110_540 };
}

export function earthViewCameraLonLat(view: EarthView): { lat: number; lon: number; alt: number } {
  const { camera } = earthViewEnu(view);
  const p = offsetLonLat(view.lon, view.lat, camera.east, camera.north);
  return { lat: p.lat, lon: p.lon, alt: camera.up };
}

export function earthViewLookAtLonLat(view: EarthView): { lat: number; lon: number; alt: number } {
  const { lookAt } = earthViewEnu(view);
  const p = offsetLonLat(view.lon, view.lat, lookAt.east, lookAt.north);
  return { lat: p.lat, lon: p.lon, alt: lookAt.up };
}

export interface EarthWorldFrame {
  bbox: MapSpec['bbox'];
  crs: string;
  v: Values;
  exaggeration: number;
  zMinM: number;
  widthM: number;
}

export function mapExaggerationOf(map: MapSpec | undefined): number {
  if (map?.exaggerationFactor != null && map.exaggerationFactor > 0) return map.exaggerationFactor;
  if (typeof map?.exaggeration === 'number' && map.exaggeration > 0) return map.exaggeration;
  return 1;
}

export function earthWorldFrame(
  map: MapSpec | undefined,
  v: Values,
  depth?: { mapOrtho?: { zMinM?: number; widthM?: number } } | null,
): EarthWorldFrame | null {
  if (!map?.bbox) return null;
  const crs = map.crs || pickMetricCrs(map.bbox);
  const b = metricBounds(map.bbox, crs);
  const widthM = Math.max(1e-6, b.east - b.west);
  const zMinM = depth?.mapOrtho?.zMinM;
  const orthoW = depth?.mapOrtho?.widthM;
  return {
    bbox: map.bbox,
    crs,
    v,
    exaggeration: mapExaggerationOf(map),
    zMinM: zMinM != null && Number.isFinite(zMinM) ? zMinM : 0,
    widthM: orthoW != null && orthoW > 0 ? orthoW : widthM,
  };
}

export function lonLatToWorldXz(lon: number, lat: number, frame: EarthWorldFrame): { x: number; z: number } {
  const [mx, my] = lonLatToMetric(lon, lat, frame.crs);
  const b = metricBounds(frame.bbox, frame.crs);
  const spanE = Math.max(1e-9, b.east - b.west);
  const spanN = Math.max(1e-9, b.north - b.south);
  const col01 = (mx - b.west) / spanE;
  const row01 = (b.north - my) / spanN;
  return mapGridUvToWorld(frame.v, col01, row01);
}

export function altitudeToWorldY(altM: number, frame: EarthWorldFrame): number {
  const scale = mapScaleMmPerM(frame.widthM, mapMasterWidthMm(frame.v));
  return baseTop(frame.v) + MAP_HEIGHT_FLOOR_MM + (altM - frame.zMinM) * frame.exaggeration * scale;
}

function rollUp(position: [number, number, number], target: [number, number, number], rollDeg: number): [number, number, number] {
  if (!rollDeg) return [0, 1, 0];
  const fx = target[0] - position[0];
  const fy = target[1] - position[1];
  const fz = target[2] - position[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  const lx = fx / fl;
  const ly = fy / fl;
  const lz = fz / fl;
  const a = (rollDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Rodrigues: rotate world-up around the look axis.
  const ux = 0;
  const uy = 1;
  const uz = 0;
  const cx = ly * uz - lz * uy;
  const cy = lz * ux - lx * uz;
  const cz = lx * uy - ly * ux;
  const dot = lx * ux + ly * uy + lz * uz;
  return [
    ux * c + cx * s + lx * dot * (1 - c),
    uy * c + cy * s + ly * dot * (1 - c),
    uz * c + cz * s + lz * dot * (1 - c),
  ];
}

export function earthViewToWorldPose(view: EarthView, frame: EarthWorldFrame): EarthWorldPose {
  const cam = earthViewCameraLonLat(view);
  const tgt = earthViewLookAtLonLat(view);
  const c = lonLatToWorldXz(cam.lon, cam.lat, frame);
  const t = lonLatToWorldXz(tgt.lon, tgt.lat, frame);
  const position: [number, number, number] = [c.x, altitudeToWorldY(cam.alt, frame), c.z];
  const target: [number, number, number] = [t.x, altitudeToWorldY(tgt.alt, frame), t.z];
  return { position, target, up: rollUp(position, target, view.roll), fov: view.fov };
}

function cross(a: EnuM, b: EnuM): EnuM {
  return {
    east: a.north * b.up - a.up * b.north,
    north: a.up * b.east - a.east * b.up,
    up: a.east * b.north - a.north * b.east,
  };
}

function earthCameraBasis(view: EarthView): { forward: EnuM; right: EnuM; up: EnuM } {
  const h = (view.heading * Math.PI) / 180;
  const forward = earthForwardEnu(view.heading, view.tilt);
  const right: EnuM = { east: Math.cos(h), north: -Math.sin(h), up: 0 };
  const up = cross(right, forward);
  const ul = Math.hypot(up.east, up.north, up.up) || 1;
  return {
    forward,
    right,
    up: { east: up.east / ul, north: up.north / ul, up: up.up / ul },
  };
}

function maxGroundDistanceM(view: EarthView, camera: EnuM, lookAt: EnuM): number {
  const d = view.distance ?? EARTH_DEFAULT_LOOK_M;
  const alt = Math.abs(camera.up - lookAt.up);
  const tilt = (view.tilt * Math.PI) / 180;
  const half = ((view.fov / 2) * Math.PI) / 180;
  const remain = Math.max(0.035, Math.PI / 2 - (tilt + half));
  const fromAlt = alt / Math.tan(remain);
  return Math.min(EARTH_MAX_GROUND_M, Math.max(d * 4, fromAlt, 200));
}

function groundHit(origin: EnuM, dir: EnuM, groundUp: number, maxDist: number): { east: number; north: number } {
  const horiz = Math.hypot(dir.east, dir.north);
  const alongMax = () => {
    if (horiz < 1e-9) return { east: origin.east, north: origin.north };
    const s = maxDist / horiz;
    return { east: origin.east + dir.east * s, north: origin.north + dir.north * s };
  };
  if (dir.up >= -1e-8) return alongMax();
  const t = (groundUp - origin.up) / dir.up;
  if (!(t > 0)) return alongMax();
  const hitE = origin.east + t * dir.east;
  const hitN = origin.north + t * dir.north;
  const dist = Math.hypot(hitE - origin.east, hitN - origin.north);
  if (dist > maxDist) {
    const s = maxDist / Math.max(dist, 1e-9);
    return { east: origin.east + (hitE - origin.east) * s, north: origin.north + (hitN - origin.north) * s };
  }
  return { east: hitE, north: hitN };
}

function padBbox(bbox: MapSpec['bbox'], pad = 0.08): MapSpec['bbox'] {
  const [w, s, e, n] = bbox;
  const dw = (e - w) * pad;
  const dh = (n - s) * pad;
  const west = Math.max(-180, w - dw);
  const east = Math.min(180, e + dw);
  const south = Math.max(-90, s - dh);
  const north = Math.min(90, n + dh);
  if (east <= west || north <= south) return bbox;
  return [west, south, east, north];
}

export interface FitMapBoxOpts {
  aspect?: number;
}

/** Ground footprint of the camera (FOV × aspect × tilt), as a WGS84 bbox. */
export function fitMapBoxToView(view: EarthView, opts: FitMapBoxOpts = {}): MapSpec['bbox'] {
  const aspect = opts.aspect != null && opts.aspect > 0.05 ? opts.aspect : 16 / 9;
  const { camera, lookAt } = earthViewEnu(view);
  const { forward, right, up } = earthCameraBasis(view);
  const th = Math.tan(((view.fov / 2) * Math.PI) / 180);
  const tw = th * aspect;
  const maxDist = maxGroundDistanceM(view, camera, lookAt);
  const ndc: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
    [0, 0],
    [0, -1],
    [0, 1],
  ];
  const hits: { east: number; north: number }[] = [{ east: camera.east, north: camera.north }, { east: lookAt.east, north: lookAt.north }];
  for (const [nx, ny] of ndc) {
    const dir: EnuM = {
      east: forward.east + right.east * tw * nx + up.east * th * ny,
      north: forward.north + right.north * tw * nx + up.north * th * ny,
      up: forward.up + right.up * tw * nx + up.up * th * ny,
    };
    hits.push(groundHit(camera, dir, lookAt.up, maxDist));
  }
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const h of hits) {
    const p = offsetLonLat(view.lon, view.lat, h.east, h.north);
    if (p.lon < west) west = p.lon;
    if (p.lon > east) east = p.lon;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }
  if (!(east > west) || !(north > south)) {
    const cam = earthViewCameraLonLat(view);
    const pad = 0.002;
    return [cam.lon - pad, cam.lat - pad, cam.lon + pad, cam.lat + pad];
  }
  return padBbox([west, south, east, north]);
}

export function pointViewMessage(view: EarthView, bbox: MapSpec['bbox'] | undefined): string | null {
  const cam = earthViewCameraLonLat(view);
  if (!bbox) {
    return 'No map box yet. Fit map box to view, then rebuild.';
  }
  const at = bboxContainsPoint(bbox, view.lon, view.lat);
  const camIn = bboxContainsPoint(bbox, cam.lon, cam.lat);
  if (at && camIn) return null;
  return 'This point is outside the current map box. Fit map box to view so the terrain covers it, then rebuild.';
}

export function mapSpecWithBbox(prev: MapSpec | undefined, bbox: MapSpec['bbox']): MapSpec {
  return defaultMapSpec({ ...prev, bbox, title: prev?.title ?? 'Map terrain' });
}

/** Round-trip helper used by tests: keep only cleaned fields. */
export function earthViewEquals(a: EarthView, b: EarthView, eps = 1e-6): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= eps;
  if (!close(a.lat, b.lat) || !close(a.lon, b.lon) || !close(a.altitude, b.altitude)) return false;
  if (!close(a.heading, b.heading) || !close(a.tilt, b.tilt) || !close(a.fov, b.fov) || !close(a.roll, b.roll)) return false;
  const da = a.distance;
  const db = b.distance;
  if (da == null && db == null) return true;
  if (da == null || db == null) return false;
  return close(da, db);
}
