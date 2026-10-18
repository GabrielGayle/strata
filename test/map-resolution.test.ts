// Map grid size (plan PR 7): EA LiDAR is cut at 0.5 mm per cell up to 1024 px, Terrarium and
// any fallback stay at 512 px, and a 1024 px project stays under 4 MB.
import { describe, expect, it } from 'vitest';
import { eaWcsScaleFactor } from '../src/core/mapEaWcs';
import { parseFloat32Geotiff } from '../src/core/mapGeotiff';
import type { Float32Grid } from '../src/core/mapGrid';
import { buildMapBundle } from '../src/core/mapPipeline';
import { MAP_FALLBACK_MAX_PX, MAP_LOCAL_MAX_PX, mapGridSize, metricBounds } from '../src/core/mapProject';
import { defaultMapSpec, cleanMapSpec } from '../src/core/mapSpec';
import { b64FromU16 } from '../src/core/mapToDepth';
import { formatMapGridReadout } from '../src/core/mapGeometryReadout';
import { newProject, serialize } from '../src/core/project';
import { encodeFloat32Geotiff } from './float32-geotiff';
import { BUTTERMERE_BBOX, NEASDEN_BBOX } from './map-fixtures';

/** Rolling fells on the EPSG:27700 grid an EA WCS reply would have at `cellM`. */
function fells(bbox: [number, number, number, number], cellM: number): Float32Grid {
  const b = metricBounds(bbox, 'EPSG:27700');
  const w = Math.ceil((b.east - b.west) / cellM);
  const h = Math.ceil((b.north - b.south) / cellM);
  const data = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const x = (c * cellM) / 900;
      const y = (r * cellM) / 700;
      data[r * w + c] = 300 + 200 * Math.sin(x) * Math.cos(y) + 40 * Math.sin(3.1 * x + 1.7 * y);
    }
  }
  return {
    w,
    h,
    data,
    crs: 'EPSG:27700',
    transform: { originX: b.west + cellM / 2, originY: b.north - cellM / 2, pixelW: cellM, pixelH: -cellM },
  };
}

const stack = { plateCount: 77, thicknessMm: 1.5, masterWidthMm: 500, kerfMm: 0.15, layerBudget: 'jenks' as const };

describe('map grid size', () => {
  it('cuts EA LiDAR at 0.5 mm per cell, up to 1024 px, when Ground resolution is auto', () => {
    const spec = defaultMapSpec({ bbox: BUTTERMERE_BBOX, source: 'ea-dtm' });
    expect(spec.resM).toBe(0);
    const size = mapGridSize(spec, 'ea-dtm', 500);
    expect(size.maxSide).toBe(MAP_LOCAL_MAX_PX);
    // 8.2 km across 500 mm: 0.5 mm is 8.2 m of ground
    expect(size.resM).toBeCloseTo(8.2, 1);
    // a small bbox never asks for finer than the 1 m LiDAR
    expect(mapGridSize(defaultMapSpec({ bbox: [-0.2575, 51.5605, -0.2565, 51.5612], source: 'ea-dtm' }), 'ea-dtm', 500).resM).toBe(1);
  });

  it('keeps Terrarium and fallbacks at 8 m and 512 px', () => {
    const spec = defaultMapSpec({ bbox: BUTTERMERE_BBOX, source: 'terrarium' });
    expect(mapGridSize(spec, 'terrarium', 500)).toEqual({ resM: 8, maxSide: MAP_FALLBACK_MAX_PX });
  });

  it('uses a typed Ground resolution as given', () => {
    expect(mapGridSize(defaultMapSpec({ bbox: BUTTERMERE_BBOX, resM: 32 }), 'ea-dtm', 500)).toEqual({ resM: 32, maxSide: MAP_LOCAL_MAX_PX });
    expect(mapGridSize(defaultMapSpec({ bbox: BUTTERMERE_BBOX, resM: 32 }), 'terrarium', 500).resM).toBe(32);
  });

  it('old projects keep their saved Ground resolution', () => {
    expect(cleanMapSpec({ kind: 'map', bbox: BUTTERMERE_BBOX, source: 'terrarium', resM: 8 })?.resM).toBe(8);
    expect(cleanMapSpec({ kind: 'map', bbox: BUTTERMERE_BBOX, source: 'terrarium' })?.resM).toBe(0);
  });

  it('asks the WCS for the build grid and decodes it at that size', async () => {
    const size = mapGridSize(defaultMapSpec({ bbox: NEASDEN_BBOX, source: 'ea-dtm' }), 'ea-dtm', 520);
    // Neasden is ~3.6 km tall: 1024 px is ~3.6 m cells, against 7.1 m before
    expect(1 / eaWcsScaleFactor(NEASDEN_BBOX, size.resM, size.maxSide)).toBeCloseTo(3.6, 0);
    expect(1 / eaWcsScaleFactor(NEASDEN_BBOX, 8)).toBeCloseTo(8, 3);

    const w = 1100;
    const h = 1000;
    const tif = encodeFloat32Geotiff(w, h, new Float32Array(w * h).fill(42), -9999);
    const big = await parseFloat32Geotiff(tif, 1024);
    expect(Math.max(big.w, big.h)).toBeGreaterThan(1000);
    expect(big.w * big.h).toBeLessThanOrEqual(1026 * 1026);
    const small = await parseFloat32Geotiff(tif);
    expect(small.w * small.h).toBeLessThanOrEqual(514 * 514);
  });

  it('builds Buttermere from EA at 1024 px with 8 m cells end to end, under 4 MB', async () => {
    const spec = defaultMapSpec({
      bbox: BUTTERMERE_BBOX,
      source: 'ea-dtm',
      water: 'raw',
      exaggeration: 4,
      engrave: { enabled: false, features: [] },
    });
    let asked: { resM?: number; maxSide?: number } = {};
    const bundle = await buildMapBundle(spec, {
      stack,
      allowOverpassNetwork: false,
      eaLoader: async (_source, sized) => {
        asked = sized;
        return fells(BUTTERMERE_BBOX, 1 / eaWcsScaleFactor(sized.bbox, sized.resM, sized.maxSide));
      },
      fetch: async () => {
        throw new Error('EA build must not mosaic Terrarium tiles');
      },
    });
    expect(asked.maxSide).toBe(1024);
    expect(Math.max(bundle.metric.w, bundle.metric.h)).toBe(1024);
    expect(Math.max(bundle.depth.w, bundle.depth.h)).toBe(1024);
    expect(Math.abs(bundle.metric.transform.pixelW)).toBeCloseTo(8, 0);
    expect(formatMapGridReadout(bundle.depth)).toMatch(/^grid 10\d\d × 10\d\d px, 8\.0 m cells$/);
    expect(bundle.asset.map?.resM).toBe(0);

    const p = newProject();
    p.images.top = bundle.asset;
    expect(serialize(p).length).toBeLessThan(4e6);
  });

  it('writes depth base64 the same as the platform encoder', () => {
    for (const n of [1, 2, 3, 7, 1000]) {
      const words = new Uint16Array(n).map((_, i) => (i * 7919 + 13) & 0xffff);
      const expected = Buffer.from(words.buffer, words.byteOffset, words.byteLength).toString('base64');
      expect(b64FromU16(words)).toBe(expected);
    }
  });
});
