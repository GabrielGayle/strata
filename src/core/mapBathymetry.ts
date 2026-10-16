// Lake bathymetry import: CSV soundings, DXF contours, GeoTIFF stub (ticket T24).
import type { Float32Grid } from './mapGrid';
import { lonLatToMetric } from './mapProject';
import type { MapSpec } from './mapSpec';
import { WELSH_HARP_WATER_BBOX } from './mapPresets';

export interface Sounding {
  easting: number;
  northing: number;
  bedM: number;
}

export function parseSoundingsCsv(text: string): Sounding[] {
  const rows: Sounding[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    const easting = Number(parts[0]);
    const northing = Number(parts[1]);
    const bedM = Number(parts[2]);
    if ([easting, northing, bedM].every(Number.isFinite)) rows.push({ easting, northing, bedM });
  }
  return rows;
}

/** IDW from soundings onto the metric grid (true depth below surface). */
export function applySoundingsToGrid(grid: Float32Grid, soundings: Sounding[], surfaceM: number): Float32Grid {
  if (!soundings.length) return grid;
  const out = { ...grid, data: new Float32Array(grid.data) };
  const { w, h, data, transform: t } = out;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const x = t.originX + col * t.pixelW;
      const y = t.originY + row * t.pixelH;
      let wSum = 0;
      let zSum = 0;
      for (const s of soundings) {
        const d2 = (x - s.easting) ** 2 + (y - s.northing) ** 2;
        if (d2 < 1e-6) {
          data[row * w + col] = s.bedM;
          wSum = 0;
          break;
        }
        const wgt = 1 / d2;
        wSum += wgt;
        zSum += wgt * s.bedM;
      }
      if (wSum > 0) data[row * w + col] = zSum / wSum;
      else if (Number.isFinite(data[row * w + col])) {
        const surface = Number.isFinite(surfaceM) ? surfaceM : data[row * w + col];
        data[row * w + col] = Math.min(data[row * w + col], surface);
      }
    }
  }
  return out;
}

export function parseDxfContourZ(lines: string): number[] {
  const zs: number[] = [];
  const re = /^\s*0\s*$/m;
  for (const block of lines.split(re)) {
    const m = block.match(/(?:^|\n)\s*38\s*\n\s*([-\d.]+)/);
    if (m) zs.push(Number(m[1]));
  }
  return zs.filter(Number.isFinite);
}

/** GeoTIFF bathymetry is CLI-only in this ticket; browser uses imported soundings. */
export async function loadGeoTiffBathymetryStub(_path: string): Promise<Sounding[]> {
  return [];
}

export function soundingFromLonLat(lon: number, lat: number, bedM: number, crs = 'EPSG:27700'): Sounding {
  const [easting, northing] = lonLatToMetric(lon, lat, crs);
  return { easting, northing, bedM };
}

function bboxIntersects(a: MapSpec['bbox'], b: MapSpec['bbox']): boolean {
  const [aw, as, ae, an] = a;
  const [bw, bs, be, bn] = b;
  return aw <= be && ae >= bw && as <= bn && an >= bs;
}

/** Offline Welsh Harp sample (CLI/tests: `mapBathymetry.fixtures.ts`). */
export function loadWelshHarpSampleSoundings(bbox: MapSpec['bbox']): Sounding[] {
  if (!bboxIntersects(bbox, WELSH_HARP_WATER_BBOX)) return [];
  return [];
}
