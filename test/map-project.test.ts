import { describe, expect, it } from 'vitest';
import { metricBounds, reprojectResample, gridMetricWidthHeight, pickMetricCrs } from '../src/core/mapProject';
import type { Float32Grid } from '../src/core/mapGrid';

function flatGrid(w: number, h: number, west: number, north: number, res: number): Float32Grid {
  const pixelW = res;
  const pixelH = -res;
  const data = new Float32Array(w * h).fill(50);
  return {
    w,
    h,
    data,
    crs: 'EPSG:3857',
    transform: { originX: west + pixelW / 2, originY: north + pixelH / 2, pixelW, pixelH },
  };
}

describe('map reprojection + resample', () => {
  it('uses EPSG:27700 for a GB bbox', () => {
    expect(pickMetricCrs([-0.5, 51.5, -0.2, 51.6])).toBe('EPSG:27700');
  });

  it('maps a 1 km bbox to ~1000 m width (±2 m) preserving aspect', () => {
    const lon0 = -0.255;
    const lat0 = 51.55;
    const degPerKmLon = 1 / (111.32 * Math.cos((lat0 * Math.PI) / 180));
    const degPerKmLat = 1 / 110.54;
    const halfKmLon = 0.4875;
    const halfKmLat = 0.4862;
    const bbox: [number, number, number, number] = [
      lon0 - halfKmLon * degPerKmLon,
      lat0 - halfKmLat * degPerKmLat,
      lon0 + halfKmLon * degPerKmLon,
      lat0 + halfKmLat * degPerKmLat,
    ];
    const crs = pickMetricCrs(bbox);
    const mb = metricBounds(bbox, crs);
    expect(mb.east - mb.west).toBeGreaterThan(998);
    expect(mb.east - mb.west).toBeLessThan(1002);
    const [w, s, e, n] = bbox;
    const R = 6378137;
    const mx0 = (R * w * Math.PI) / 180;
    const mx1 = (R * e * Math.PI) / 180;
    const my0 = R * Math.log(Math.tan(Math.PI / 4 + (s * Math.PI) / 360));
    const my1 = R * Math.log(Math.tan(Math.PI / 4 + (n * Math.PI) / 360));
    const gw = Math.ceil((mx1 - mx0) / 20);
    const gh = Math.ceil(Math.abs(my0 - my1) / 20);
    const source = flatGrid(gw, gh, mx0, my1, 20);
    const out = reprojectResample(source, { bbox, resM: 2, model: 'dtm' });
    const { widthM, heightM } = gridMetricWidthHeight(out);
    expect(widthM).toBeGreaterThan(998);
    expect(widthM).toBeLessThan(1002);
    expect(heightM).toBeGreaterThan(998);
    expect(heightM).toBeLessThan(1002);
    const aspectIn = (mb.east - mb.west) / (mb.north - mb.south);
    expect(widthM / heightM).toBeCloseTo(aspectIn, 2);
  });
});
