import proj4 from 'proj4';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Float32Grid } from '../src/core/mapGrid';
import { gridSampleBicubic } from '../src/core/mapGrid';
import { metricBounds, pickMetricCrs, projectionLattice, reprojectResample } from '../src/core/mapProject';
import { simplifyMetricGrid } from '../src/core/mapSimplify';
import { reliefMetres } from '../src/core/mapExaggeration';
import { applyLayerBudget, computeLayerBreaks } from '../src/core/mapLayerBudget';
import { fetchTerrariumGrid, fetchTileWithTimeout, MapTileTimeoutError, terrariumUrl } from '../src/core/mapTerrarium';
import { sanitizeElevationGrid } from '../src/core/mapElevation';
import { cachedMapBytes, cachedMapJson } from '../src/core/mapCache.client';
import { clearInMemoryMapCache, useInMemoryMapCache } from '../src/core/mapCacheBrowser';
import { defaultMapSpec } from '../src/core/mapSpec';
import { fixtureTileFetcher } from './map-cli-fixtures';
import { BUTTERMERE_BBOX, NEASDEN_BBOX } from './map-fixtures';
import { simplifyMetricGridReference } from './map-simplify-reference';

async function neasdenSource(): Promise<Float32Grid> {
  return sanitizeElevationGrid(await fetchTerrariumGrid({ bbox: NEASDEN_BBOX }, { fetch: fixtureTileFetcher }));
}

/** Worst gap between reprojectResample and proj4 called for every sample (as before the lattice), on every 7th cell. */
function worstVsExact(source: Float32Grid, dest: Float32Grid, useMax: boolean): number {
  const { pixelW } = dest.transform;
  const pixelH = Math.abs(dest.transform.pixelH);
  const west = dest.transform.originX - pixelW / 2;
  const north = dest.transform.originY + pixelH / 2;
  const at = (x: number, y: number) => {
    const [lon, lat] = proj4(dest.crs, 'EPSG:4326', [x, y]);
    const [mx, my] = proj4('EPSG:4326', 'EPSG:3857', [lon, lat]);
    return gridSampleBicubic(source, mx, my, true);
  };
  const diffs: number[] = [];
  for (let row = 0; row < dest.h; row += 7) {
    for (let col = 0; col < dest.w; col += 7) {
      const cx = west + (col + 0.5) * pixelW;
      const cy = north - (row + 0.5) * pixelH;
      const corners = [
        at(cx - pixelW / 2, cy - pixelH / 2),
        at(cx + pixelW / 2, cy - pixelH / 2),
        at(cx + pixelW / 2, cy + pixelH / 2),
        at(cx - pixelW / 2, cy + pixelH / 2),
      ].filter(Number.isFinite);
      const want = useMax ? (corners.length ? Math.max(...corners) : NaN) : at(cx, cy);
      const got = dest.data[row * dest.w + col];
      if (Number.isNaN(want) && Number.isNaN(got)) continue;
      diffs.push(Math.abs(want - got));
    }
  }
  // stampSourceMaxima may lift the summit cell; ignore the single largest gap.
  diffs.sort((x, y) => y - x);
  return diffs[1] ?? 0;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]) && Number.isNaN(b[i])) continue;
    d = Math.max(d, Math.abs(a[i] - b[i]));
  }
  return d;
}

describe('projection lattice', () => {
  it('stays within 5 cm of proj4 across the Buttermere bbox and past its edges', () => {
    const crs = pickMetricCrs(BUTTERMERE_BBOX);
    const b = metricBounds(BUTTERMERE_BBOX, crs);
    const lattice = projectionLattice(crs, 'EPSG:3857', b);
    const out: [number, number] = [0, 0];
    let worst = 0;
    for (let k = 0; k <= 400; k++) {
      const u = -0.02 + (1.04 * ((k * 37) % 401)) / 400;
      const v = -0.02 + (1.04 * ((k * 91) % 401)) / 400;
      const x = b.west + u * (b.east - b.west);
      const y = b.north - v * (b.north - b.south);
      lattice(x, y, out);
      const exact = proj4(crs, 'EPSG:3857', [x, y]);
      worst = Math.max(worst, Math.hypot(out[0] - exact[0], out[1] - exact[1]));
    }
    // A Terrarium pixel here is ~19 m; EA grids share the metric CRS and skip the lattice.
    expect(worst).toBeLessThan(0.05);
  });

  it('resamples Neasden the same as per-cell proj4, for bicubic and max-pool', async () => {
    const source = await neasdenSource();
    const spec = defaultMapSpec({ bbox: NEASDEN_BBOX, source: 'terrarium' });
    const dtm = reprojectResample(source, { ...spec, model: 'dtm' });
    const dsm = reprojectResample(source, { ...spec, model: 'dsm' });
    expect(worstVsExact(source, dtm, false)).toBeLessThan(0.01);
    expect(worstVsExact(source, dsm, true)).toBeLessThan(0.01);
  });
});

describe('simplify rewrite', () => {
  it('matches the old simplifier on the terraced Neasden grid', async () => {
    const source = await neasdenSource();
    const metric = reprojectResample(source, defaultMapSpec({ bbox: NEASDEN_BBOX, source: 'terrarium' }));
    const snapped = applyLayerBudget(metric, computeLayerBreaks(metric, 40, 'jenks').breaksM);
    for (const g of [metric, snapped]) {
      const opts = { kerfMm: 0.2, pixelSizeM: Math.abs(g.transform.pixelW) };
      const now = simplifyMetricGrid(g, opts);
      const was = simplifyMetricGridReference(g, opts);
      expect(now.lostFeatures).toBe(was.lostFeatures);
      expect(maxAbsDiff(now.grid.data, was.grid.data)).toBeLessThan(1e-3);
    }
  });

  it('handles NaN holes and a wider blur like the old one', () => {
    const w = 60;
    const h = 45;
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = ((i * 7919) % 13) * 0.4 + (i % w) * 0.1;
    for (let i = 300; i < 340; i++) data[i] = NaN;
    const g: Float32Grid = { w, h, data, crs: 'EPSG:27700', transform: { originX: 0, originY: 0, pixelW: 2, pixelH: -2 } };
    const opts = { minIslandAreaPx: 6, minHoleAreaPx: 5, smoothRadiusPx: 2 };
    const now = simplifyMetricGrid(g, opts);
    const was = simplifyMetricGridReference(g, opts);
    expect(now.lostFeatures).toBe(was.lostFeatures);
    expect(maxAbsDiff(now.grid.data, was.grid.data)).toBeLessThan(1e-3);
  });

  it('relief percentiles match a plain sort', () => {
    const data = new Float32Array(1000).map((_, i) => ((i * 31) % 997) / 10);
    data[5] = NaN;
    const finite = Array.from(data).filter(Number.isFinite).sort((a, b) => a - b);
    const p = (q: number) => finite[Math.floor((q / 100) * finite.length)];
    const g: Float32Grid = { w: 1000, h: 1, data, crs: 'EPSG:27700', transform: { originX: 0, originY: 0, pixelW: 1, pixelH: -1 } };
    expect(reliefMetres(g)).toBe(p(98) - p(2));
  });
});

describe('terrarium tile fetch', () => {
  it('fetches at most four tiles at once and assembles the same mosaic', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async (url: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return fixtureTileFetcher(url);
    };
    const serial = await fetchTerrariumGrid({ bbox: NEASDEN_BBOX }, { fetch: fixtureTileFetcher, concurrency: 1 });
    const parallel = await fetchTerrariumGrid({ bbox: NEASDEN_BBOX }, { fetch: slow });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(maxAbsDiff(serial.data, parallel.data)).toBe(0);
  });

  it('fails a tile that takes longer than the timeout, even if the fetcher ignores the signal', async () => {
    const never = () => new Promise<Uint8Array>(() => {});
    await expect(fetchTileWithTimeout(never, terrariumUrl(13, 1, 1), 20)).rejects.toBeInstanceOf(MapTileTimeoutError);
  });

  it('aborts outstanding tiles when the build is cancelled', async () => {
    const ctrl = new AbortController();
    const seen: AbortSignal[] = [];
    const hang = (_url: string, signal?: AbortSignal) => {
      if (signal) seen.push(signal);
      return new Promise<Uint8Array>(() => {});
    };
    const run = fetchTerrariumGrid({ bbox: NEASDEN_BBOX }, { fetch: hang, signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    await expect(run).rejects.toThrow();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.aborted)).toBe(true);
  });
});

describe('browser map cache', () => {
  afterEach(() => clearInMemoryMapCache());

  it('serves a repeat tile and Overpass answer without the network', async () => {
    useInMemoryMapCache();
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0];
    const tile = vi.fn(async () => new Uint8Array(png));
    const url = terrariumUrl(13, 4090, 2721);
    await cachedMapBytes(undefined, 'terrarium', url, tile);
    await Promise.resolve();
    expect(Array.from(await cachedMapBytes(undefined, 'terrarium', url, tile))).toEqual(png);
    expect(tile).toHaveBeenCalledTimes(1);

    const overpass = vi.fn(async () => ({ elements: [{ id: 1 }] }));
    await cachedMapJson(undefined, 'overpass', 'q', overpass);
    await Promise.resolve();
    expect(await cachedMapJson(undefined, 'overpass', 'q', overpass)).toEqual({ elements: [{ id: 1 }] });
    expect(overpass).toHaveBeenCalledTimes(1);
  });

  it('does not keep an error page served in place of a raster', async () => {
    useInMemoryMapCache();
    const xml = new TextEncoder().encode('<?xml version="1.0"?><ows:ExceptionReport/>');
    const wcs = vi.fn(async () => xml);
    await cachedMapBytes(undefined, 'cog', 'https://example.com/wcs', wcs);
    await cachedMapBytes(undefined, 'cog', 'https://example.com/wcs', wcs);
    expect(wcs).toHaveBeenCalledTimes(2);
  });

  it('does not keep an Overpass runtime error', async () => {
    useInMemoryMapCache();
    const overpass = vi.fn(async () => ({ elements: [], remark: 'runtime error: timeout' }));
    await cachedMapJson(undefined, 'overpass', 'q2', overpass);
    await cachedMapJson(undefined, 'overpass', 'q2', overpass);
    expect(overpass).toHaveBeenCalledTimes(2);
  });
});
