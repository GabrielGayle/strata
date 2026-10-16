import { describe, expect, it } from 'vitest';
import { buildEaWcsGetCoverageUrl, EA_DSM_WCS_BASE, EA_DTM_WCS_BASE, eaWcsScaleFactor } from '../src/core/mapEaWcs';
import { sourceMeta } from '../src/core/mapSourceRegistry';
import { NEASDEN_BBOX, NEASDEN_FAST_BBOX } from './map-fixtures';

const live = process.env.LIVE_MAP === '1';

function isGeoTiff(bytes: Uint8Array, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes('tiff') || ct.includes('geotiff')) return true;
  return (bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d);
}

describe('EA WCS URLs (T6 live)', () => {
  it('builds GetCoverage for Neasden ea-dtm and ea-dsm', () => {
    const dtm = buildEaWcsGetCoverageUrl('ea-dtm', NEASDEN_FAST_BBOX);
    expect(dtm).toMatch(/GetCoverage/);
    expect(dtm).toMatch(/Lidar_Composite_Elevation_DTM_1m/);
    expect(dtm).toMatch(/subset=E%28/);
    expect(dtm).toMatch(/subset=N%28/);
    expect(dtm).toMatch(/SCALEFACTOR=/);
    expect(dtm?.startsWith(EA_DTM_WCS_BASE)).toBe(true);
    const dsm = buildEaWcsGetCoverageUrl('ea-dsm', NEASDEN_FAST_BBOX);
    expect(dsm).toMatch(/Lidar_Composite_Elevation_LZ_DSM_1m/);
    expect(dsm).toMatch(/SCALEFACTOR=/);
    expect(dsm?.startsWith(EA_DSM_WCS_BASE)).toBe(true);
  });

  it('registry DTM and DSM service URLs are the live WCS endpoints', () => {
    expect(sourceMeta('ea-dtm').serviceUrl).toBe(EA_DTM_WCS_BASE);
    expect(sourceMeta('ea-dsm').serviceUrl).toBe(EA_DSM_WCS_BASE);
    expect(sourceMeta('ea-dtm').serviceUrl).not.toMatch(/DefraDataDownload/);
    expect(sourceMeta('ea-dsm').serviceUrl).not.toMatch(/DefraDataDownload/);
  });

  it('asks WCS for ~8 m cells on the full Neasden preset bbox', () => {
    expect(eaWcsScaleFactor(NEASDEN_BBOX, 8)).toBeCloseTo(0.125, 3);
    const url = buildEaWcsGetCoverageUrl('ea-dtm', NEASDEN_BBOX, 8);
    expect(url).toMatch(/SCALEFACTOR=0\.125/);
  });
});

describe.skipIf(!live)('live EA WCS GetCoverage (LIVE_MAP=1)', () => {
  it('returns 200 GeoTIFF for a Neasden DTM subset', async () => {
    const url = buildEaWcsGetCoverageUrl('ea-dtm', NEASDEN_BBOX, 8);
    expect(url).toBeTruthy();
    expect(url).toMatch(/SCALEFACTOR=/);
    const res = await fetch(url!, { signal: AbortSignal.timeout(90_000) });
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.byteLength).toBeGreaterThan(100);
    expect(buf.byteLength).toBeLessThan(20_000_000);
    expect(isGeoTiff(buf, res.headers.get('content-type') ?? '')).toBe(true);
  }, 120_000);
});
