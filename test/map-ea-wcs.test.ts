import { describe, expect, it } from 'vitest';
import { buildEaWcsGetCoverageUrl } from '../src/core/mapEaWcs';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

describe('EA WCS URLs (T6 live)', () => {
  it('builds GetCoverage for Neasden ea-dtm', () => {
    const url = buildEaWcsGetCoverageUrl('ea-dtm', NEASDEN_FAST_BBOX);
    expect(url).toMatch(/GetCoverage/);
    expect(url).toMatch(/Lidar_Composite_Elevation_DTM_1m/);
    expect(url).toMatch(/subset=E%28/);
    expect(url).toMatch(/subset=N%28/);
  });
});
