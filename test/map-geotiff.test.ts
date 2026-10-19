import { describe, expect, it } from 'vitest';
import { FLOAT32_NODATA } from '../src/core/mapElevation';
import { parseFloat32Geotiff } from '../src/core/mapGeotiff';
import { encodeFloat32Geotiff } from './float32-geotiff';

describe('parseFloat32Geotiff nodata', () => {
  it('masks blended nodata in a synthetic >512² Float32 raster', async () => {
    const w = 640;
    const h = 640;
    expect(w * h).toBeGreaterThan(512 * 512);
    const data = new Float32Array(w * h);
    const nodataCols = 48;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        data[y * w + x] = x < nodataCols ? FLOAT32_NODATA : 82.5;
      }
    }
    const buf = encodeFloat32Geotiff(w, h, data, FLOAT32_NODATA);
    const grid = await parseFloat32Geotiff(buf);
    expect(grid.w * grid.h).toBeLessThanOrEqual(514 * 514);
    expect(grid.w).toBeGreaterThan(8);
    expect(grid.h).toBeGreaterThan(8);

    let nNan = 0;
    let nHuge = 0;
    let nOk = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const z of grid.data) {
      if (!Number.isFinite(z)) {
        nNan++;
        continue;
      }
      if (Math.abs(z) > 1e4) nHuge++;
      else nOk++;
      if (z < min) min = z;
      if (z > max) max = z;
    }
    expect(nHuge, 'bilinear-blended nodata (~1e38) must not survive').toBe(0);
    expect(nNan).toBeGreaterThan(0);
    expect(nOk).toBeGreaterThan(0);
    expect(min).toBeGreaterThan(50);
    expect(max).toBeLessThan(120);
  });
});
