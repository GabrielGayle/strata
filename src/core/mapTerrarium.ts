// AWS Mapzen Terrarium PNG tiles → elevation grid (metres).
import { PNG } from 'pngjs';
import type { Float32Grid, GridTransform } from './mapGrid';
import type { MapSpec } from './mapSpec';

export const TERRARIUM_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export type TileFetcher = (url: string) => Promise<Uint8Array>;

export function terrariumUrl(z: number, x: number, y: number): string {
  return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
}

/** Decode terrarium RGB to elevation metres. */
export function decodeTerrariumMetres(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export function decodeTerrariumPng(buf: Uint8Array): { w: number; h: number; data: Float32Array } {
  const png = PNG.sync.read(Buffer.from(buf));
  const n = png.width * png.height;
  const data = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const m = decodeTerrariumMetres(png.data[p], png.data[p + 1], png.data[p + 2]);
    data[i] = m < -1000 || m > 9000 ? NaN : m;
  }
  return { w: png.width, h: png.height, data };
}

const R = 6378137;

export function lonLatToMercator(lon: number, lat: number): [number, number] {
  const x = (R * lon * Math.PI) / 180;
  const clampLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const y = R * Math.log(Math.tan(Math.PI / 4 + (clampLat * Math.PI) / 360));
  return [x, y];
}

export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

export function tileMercatorBounds(z: number, x: number, y: number): { west: number; north: number; east: number; south: number } {
  const n = 2 ** z;
  const lonWest = (x / n) * 360 - 180;
  const lonEast = ((x + 1) / n) * 360 - 180;
  const latNorth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const latSouth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  const [west] = lonLatToMercator(lonWest, 0);
  const [east] = lonLatToMercator(lonEast, 0);
  const [, north] = lonLatToMercator(0, latNorth);
  const [, south] = lonLatToMercator(0, latSouth);
  return { west, north, east, south };
}

/** Zoom so the long edge of the bbox is at least ~512 px at tile resolution. */
export function pickTerrariumZoom(bbox: MapSpec['bbox'], maxZoom = 15): number {
  const [w, s, e, n] = bbox;
  const [mx0, my0] = lonLatToMercator(w, s);
  const [mx1, my1] = lonLatToMercator(e, n);
  const span = Math.max(Math.abs(mx1 - mx0), Math.abs(my1 - my0));
  for (let z = maxZoom; z >= 0; z--) {
    const res = (2 * Math.PI * R) / (256 * 2 ** z);
    if (span / res >= 64) return z;
  }
  return 0;
}

export interface TerrariumMosaicOptions {
  fetch?: TileFetcher;
  zoom?: number;
}

export async function fetchTerrariumGrid(spec: Pick<MapSpec, 'bbox'>, opts: TerrariumMosaicOptions = {}): Promise<Float32Grid> {
  const [west, south, east, north] = spec.bbox;
  const z = opts.zoom ?? pickTerrariumZoom(spec.bbox);
  const tl = lonLatToTile(west, north, z);
  const br = lonLatToTile(east, south, z);
  const tileSize = 256;
  const cols = br.x - tl.x + 1;
  const rows = br.y - tl.y + 1;
  const mw = cols * tileSize;
  const mh = rows * tileSize;
  const mosaic = new Float32Array(mw * mh).fill(NaN);
  const fetch = opts.fetch ?? defaultTileFetcher;

  for (let tx = tl.x; tx <= br.x; tx++) {
    for (let ty = tl.y; ty <= br.y; ty++) {
      const buf = await fetch(terrariumUrl(z, tx, ty));
      const tile = decodeTerrariumPng(buf);
      const ox = (tx - tl.x) * tileSize;
      const oy = (ty - tl.y) * tileSize;
      for (let y = 0; y < tile.h; y++) {
        for (let x = 0; x < tile.w; x++) {
          mosaic[(oy + y) * mw + ox + x] = tile.data[y * tile.w + x];
        }
      }
    }
  }

  const tileWest = tileMercatorBounds(z, tl.x, tl.y).west;
  const tileNorth = tileMercatorBounds(z, tl.x, tl.y).north;
  const pixelW = (tileMercatorBounds(z, tl.x + 1, tl.y).west - tileWest) / tileSize;
  const pixelH = (tileMercatorBounds(z, tl.x, tl.y + 1).south - tileNorth) / tileSize;

  const [bboxWest, bboxSouth] = lonLatToMercator(west, south);
  const [bboxEast, bboxNorth] = lonLatToMercator(east, north);

  const col0 = Math.max(0, Math.floor(((bboxWest - tileWest) / pixelW)));
  const col1 = Math.min(mw - 1, Math.ceil(((bboxEast - tileWest) / pixelW)));
  const row0 = Math.max(0, Math.floor(((bboxNorth - tileNorth) / pixelH)));
  const row1 = Math.min(mh - 1, Math.ceil(((bboxSouth - tileNorth) / pixelH)));
  const cw = col1 - col0 + 1;
  const ch = row1 - row0 + 1;
  const cropped = new Float32Array(cw * ch).fill(NaN);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const cx = tileWest + (col0 + x + 0.5) * pixelW;
      const cy = tileNorth + (row0 + y + 0.5) * pixelH;
      if (cx < bboxWest || cx > bboxEast || cy < bboxSouth || cy > bboxNorth) continue;
      cropped[y * cw + x] = mosaic[(row0 + y) * mw + col0 + x];
    }
  }

  const originX = tileWest + (col0 + 0.5) * pixelW;
  const originY = tileNorth + (row0 + 0.5) * pixelH;
  const transform: GridTransform = { originX, originY, pixelW, pixelH };
  return { w: cw, h: ch, data: cropped, crs: 'EPSG:3857', transform };
}

export async function defaultTileFetcher(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Terrarium tile fetch failed: ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export function gridElevationRange(g: Float32Grid): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of g.data) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** Percentile band of finite elevations (for noisy terrarium DSM spikes in tests). */
export function gridPercentileRange(g: Float32Grid, lowPct = 2, highPct = 96): { min: number; max: number } {
  const vals: number[] = [];
  for (const v of g.data) if (Number.isFinite(v)) vals.push(v);
  vals.sort((a, b) => a - b);
  if (!vals.length) return { min: NaN, max: NaN };
  const lo = Math.min(vals.length - 1, Math.max(0, Math.floor((lowPct / 100) * vals.length)));
  const hi = Math.min(vals.length - 1, Math.max(lo, Math.floor((highPct / 100) * vals.length)));
  return { min: vals[lo], max: vals[hi] };
}
