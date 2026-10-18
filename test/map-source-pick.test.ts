import { describe, expect, it } from 'vitest';
import { buildMapBundle, resolveMapSource } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { cropRegionalGridToBbox } from '../src/core/mapRegionalLidar';
import { loadBuiltinRegionalFixture } from '../src/core/mapRegionalLidar.fixtures';
import { WORKING_MAP_SOURCES, isHighResSource, isWorkingMapSource, pickAutoMapSource } from '../src/core/mapSourcePick';
import { sourceMeta } from '../src/core/mapSourceRegistry';
import { KINGSBARNS_BBOX, ROYAL_COUNTY_DOWN_BBOX, NEASDEN_BBOX } from './map-fixtures';

describe('map source auto-pick (T23)', () => {
  it('uses terrarium with an honest warning for Scotland until its LiDAR adapter ships', () => {
    const { source, warnings } = pickAutoMapSource(KINGSBARNS_BBOX);
    expect(source).toBe('terrarium');
    expect(warnings.join(' ')).toMatch(/Scottish LiDAR is not supported yet; using terrarium/);
  });

  it('uses terrarium for Northern Ireland and Wales', () => {
    expect(pickAutoMapSource(ROYAL_COUNTY_DOWN_BBOX).source).toBe('terrarium');
    expect(pickAutoMapSource([-3.84, 52.41, -3.8, 52.43]).source).toBe('terrarium');
  });

  it('picks EA DTM for England (Neasden) with no auto warnings', () => {
    const { source, warnings } = pickAutoMapSource(NEASDEN_BBOX);
    expect(source).toBe('ea-dtm');
    expect(warnings).toHaveLength(0);
  });

  it('warns when auto is outside UK heuristics', () => {
    const { source, warnings } = pickAutoMapSource([2.3, 48.8, 2.35, 48.85]);
    expect(source).toBe('terrarium');
    expect(warnings.some((w) => /too coarse/i.test(w))).toBe(true);
  });

  it('auto only ever resolves to a source the Map tab offers', () => {
    const boxes: [number, number, number, number][] = [
      KINGSBARNS_BBOX,
      ROYAL_COUNTY_DOWN_BBOX,
      NEASDEN_BBOX,
      [-3.84, 52.41, -3.8, 52.43],
      [2.3, 48.8, 2.35, 48.85],
      [-122.5, 37.7, -122.4, 37.8],
    ];
    for (const bbox of boxes) {
      const { effective, warnings } = resolveMapSource({ source: 'auto', bbox });
      expect(isWorkingMapSource(effective)).toBe(true);
      for (const id of ['scot-dtm', 'wales-dtm', 'ni-dtm', 'cop30']) expect(warnings.join(' ')).not.toContain(id);
    }
    expect(WORKING_MAP_SOURCES).toEqual(['auto', 'ea-dtm', 'ea-dsm', 'terrarium']);
  });

  it('still reports EA DTM as high resolution', () => {
    expect(isHighResSource('ea-dtm')).toBe(true);
    expect(sourceMeta('ea-dtm').resolutionM).toBeLessThanOrEqual(2);
    expect(isHighResSource('terrarium')).toBe(false);
  });

  it('crops the offline regional fixtures', () => {
    const scot = loadBuiltinRegionalFixture('scot-dtm');
    expect(scot).not.toBeNull();
    expect(cropRegionalGridToBbox(scot!, KINGSBARNS_BBOX).w).toBeGreaterThan(0);
    expect(loadBuiltinRegionalFixture('ni-dtm')).not.toBeNull();
  });

  it('buildMapBundle uses a regional fixture grid only when the source is explicit and a loader supplies data', async () => {
    const regionalLoader = async (source: string) => loadBuiltinRegionalFixture(source as 'scot-dtm');
    const bundle = await buildMapBundle(
      defaultMapSpec({ bbox: KINGSBARNS_BBOX, source: 'scot-dtm', resM: 12, engrave: { enabled: false, features: [] } }),
      { regionalLoader },
    );
    expect(bundle.asset.map?.resolvedSource).toBe('scot-dtm');
    expect(bundle.elevation.crs).toBe('EPSG:27700');
    expect(bundle.depth.w).toBeGreaterThan(0);
  });
});
