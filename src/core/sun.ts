// Where the sun is, for the sun study: NOAA's general solar position
// formulas (good to a fraction of a degree), plus the mapping from compass
// bearings onto the design's world axes.
import type { Values } from './params';
import { stackFrame } from './heightfield';

export interface Site {
  /** Degrees north (negative south). */
  lat: number;
  /** Degrees east (negative west). */
  lon: number;
  /** Clock offset from UTC in hours (1 for British Summer Time). */
  utc: number;
  month: number; // 1–12
  day: number; // 1–31
}

export interface SunPos {
  /** Degrees above the horizon (negative below). */
  elevation: number;
  /** Compass bearing in degrees, clockwise from north. */
  azimuth: number;
}

const RAD = Math.PI / 180;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Day of the year (1–365) for a month and day, clamped to real dates. */
export function dayOfYear(month: number, day: number): number {
  const m = Math.min(12, Math.max(1, Math.round(month)));
  const d = Math.min(DAYS[m - 1], Math.max(1, Math.round(day)));
  let n = d;
  for (let i = 0; i < m - 1; i++) n += DAYS[i];
  return n;
}

/** Declination and equation of time (minutes) for a day of the year and UTC hour. */
function solarTerms(doy: number, utcHour: number) {
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (utcHour - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  return { eqTime, decl };
}

/** Sun position at a clock time (hours, local to the site's UTC offset). */
export function sunPosition(site: Site, clockHours: number): SunPos {
  const doy = dayOfYear(site.month, site.day);
  const utcHour = clockHours - site.utc;
  const { eqTime, decl } = solarTerms(doy, utcHour);
  const trueSolarMin = utcHour * 60 + eqTime + 4 * site.lon;
  const ha = (trueSolarMin / 4 - 180) * RAD;
  const phi = site.lat * RAD;
  const cosZ = Math.min(1, Math.max(-1, Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha)));
  const zen = Math.acos(cosZ);
  // azimuth clockwise from north
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / RAD + 180;
  return { elevation: 90 - zen / RAD, azimuth: ((az % 360) + 360) % 360 };
}

/** Clock times of sunrise, solar noon and sunset; rise/set are null in polar day or night. */
export function sunTimes(site: Site): { rise: number | null; noon: number; set: number | null } {
  const doy = dayOfYear(site.month, site.day);
  const { eqTime, decl } = solarTerms(doy, 12 - site.utc);
  const noon = (720 - 4 * site.lon - eqTime) / 60 + site.utc;
  const phi = site.lat * RAD;
  // 90.833° allows for refraction and the sun's disc
  const c = Math.cos(90.833 * RAD) / (Math.cos(phi) * Math.cos(decl)) - Math.tan(phi) * Math.tan(decl);
  if (c > 1 || c < -1) return { rise: null, noon, set: null };
  const h = Math.acos(c) / RAD / 15;
  return { rise: noon - h, noon, set: noon + h };
}

/** The site, date and facing from the parameters. */
export function siteOf(v: Values): Site {
  return { lat: Number(v.sunLat) || 0, lon: Number(v.sunLon) || 0, utc: Number(v.sunUtc) || 0, month: Number(v.sunMonth) || 6, day: Number(v.sunDay) || 21 };
}

/**
 * Horizontal world direction (x, z) of a compass bearing. `facing` is the
 * bearing the front of the piece looks out to; the front is the end the Front
 * view looks at, so its outward normal runs against the stack direction.
 */
export function bearingToWorld(v: Values, bearing: number): [number, number] {
  const f = stackFrame(v);
  const fx = -f.stack[0];
  const fz = -f.stack[1];
  // turn clockwise (seen from above, y up) by the difference
  const t = (bearing - (Number(v.sunFacing) || 0)) * RAD;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [fx * c - fz * s, fx * s + fz * c];
}

/** Unit vector (world x, y, z) pointing toward the sun. */
export function sunVector(v: Values, pos: SunPos): [number, number, number] {
  const [hx, hz] = bearingToWorld(v, pos.azimuth);
  const ce = Math.cos(pos.elevation * RAD);
  return [hx * ce, Math.sin(pos.elevation * RAD), hz * ce];
}

/** "14:05" from decimal hours. */
export function clock(hours: number): string {
  const m = Math.round((((hours % 24) + 24) % 24) * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
