import { describe, expect, it } from 'vitest';
import { buildMapBundle, resolveMapSource } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { cropRegionalGridToBbox, loadBuiltinRegionalFixture } from '../src/core/mapRegionalLidar';
import { pickAutoMapSource, isHighResSource } from '../src/core/mapSourcePick';
import { sourceMeta } from '../src/core/mapSourceRegistry';
import { KINGSBARNS_BBOX, ROYAL_COUNTY_DOWN_BBOX, NEASDEN_BBOX } from './map-fixtures';

describe('map source auto-pick (T23)', () => {
  it('picks ≤2 m Scotland LiDAR for Kingsbarns', () => {
    const { source, warnings } = pickAutoMapSource(KINGSBARNS_BBOX);
    expect(source).toBe('scot-dtm');
    expect(isHighResSource(source)).toBe(true);
    expect(sourceMeta(source).resolutionM).toBeLessThanOrEqual(2);
    expect(warnings).toHaveLength(0);
  });

  it('picks ≤2 m NI LiDAR for Royal County Down', () => {
    const { source, warnings } = pickAutoMapSource(ROYAL_COUNTY_DOWN_BBOX);
    expect(source).toBe('ni-dtm');
    expect(sourceMeta(source).resolutionM).toBeLessThanOrEqual(2);
    expect(warnings).toHaveLength(0);
  });

  it('picks EA DTM for England (Neasden) with no auto warnings', () => {
    const { source } = pickAutoMapSource(NEASDEN_BBOX);
    expect(source).toBe('ea-dtm');
  });

  it('warns when auto is outside UK heuristics', () => {
    const { source, warnings } = pickAutoMapSource([2.3, 48.8, 2.35, 48.85]);
    expect(source).toBe('terrarium');
    expect(warnings.some((w) => /too coarse/i.test(w))).toBe(true);
  });

  it('loads offline fixtures and resolves auto to regional sources', () => {
    const scot = loadBuiltinRegionalFixture('scot-dtm');
    expect(scot).not.toBeNull();
    const cropped = cropRegionalGridToBbox(scot!, KINGSBARNS_BBOX);
    expect(cropped.w).toBeGreaterThan(0);
    const resolvedScot = resolveMapSource({ source: 'auto', bbox: KINGSBARNS_BBOX });
    expect(resolvedScot.effective).toBe('scot-dtm');

    const ni = loadBuiltinRegionalFixture('ni-dtm');
    expect(ni).not.toBeNull();
    const resolvedNi = resolveMapSource({ source: 'auto', bbox: ROYAL_COUNTY_DOWN_BBOX });
    expect(resolvedNi.effective).toBe('ni-dtm');
  });

  it('buildMapBundle uses regional fixture grid when loader supplies data', async () => {
    const regionalLoader = async (source: string) => loadBuiltinRegionalFixture(source as 'scot-dtm');
    const bundle = await buildMapBundle(
      defaultMapSpec({ bbox: KINGSBARNS_BBOX, source: 'auto', resM: 12 }),
      { regionalLoader },
    );
    expect(bundle.asset.map?.resolvedSource).toBe('scot-dtm');
    expect(bundle.elevation.crs).toBe('EPSG:27700');
    expect(bundle.depth.w).toBeGreaterThan(0);
  });
});
