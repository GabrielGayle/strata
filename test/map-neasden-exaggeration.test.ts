import { afterEach, describe, expect, it } from 'vitest';
import { computeAutoExaggeration, reliefMetres } from '../src/core/mapExaggeration';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { mapNoticesMatching } from '../src/core/mapNotices';
import { loadBuiltinEaFixture } from '../src/core/mapEaLidar.fixtures';
import { mapPresetSpec } from '../src/core/mapPresets';
import { setMapTileFetcher } from '../src/core/mapTerrarium';
import type { Float32Grid } from '../src/core/mapGrid';
import { fixtureTileFetcher } from './map-cli-fixtures';
import { NEASDEN_BBOX, NEASDEN_FAST_BBOX } from './map-fixtures';

afterEach(() => {
  setMapTileFetcher(null);
});

const VERMILION = { plateCount: 40, thicknessMm: 3, masterWidthMm: 800, layerBudget: 'equal' as const };

/** Linear ramp in EPSG:27700 covering the full Neasden bbox. */
function neasdenRampGrid(minZ: number, maxZ: number): Float32Grid {
  const w = 48;
  const h = 48;
  const west = 519289;
  const east = 522633;
  const south = 184079;
  const north = 187717;
  const pixelW = (east - west) / w;
  const pixelH = (south - north) / h;
  const data = new Float32Array(w * h);
  const last = w * h - 1;
  for (let i = 0; i <= last; i++) data[i] = minZ + ((maxZ - minZ) * i) / last;
  return {
    w,
    h,
    data,
    crs: 'EPSG:27700',
    transform: { originX: west + pixelW / 2, originY: north + pixelH / 2, pixelW, pixelH },
  };
}

describe('Neasden auto exaggeration', () => {
  it('plan stack-height formula lands near ×18–21 for A3 (420 mm) with 30×3 mm plates', () => {
    const factor = computeAutoExaggeration({
      reliefM: 35,
      stackHeightMm: 90,
      mapWidthM: 3250,
      masterWidthMm: 420,
    });
    expect(factor).toBeGreaterThanOrEqual(18);
    expect(factor).toBeLessThanOrEqual(21);
  });

  it('default Vermilion 40 (800 mm, 40×3 mm) is ~×11 for live-scale Neasden relief, not the A3 ×18–21 number', () => {
    // Live EA 1 m over the full Neasden bbox is ~45 m p98−p2 on ~3.25 km.
    // Auto fills the current stack: 120 mm / (45 m × 800/3250 mm per m) ≈ ×10.8.
    const factor = computeAutoExaggeration({
      reliefM: 45,
      stackHeightMm: 120,
      mapWidthM: 3250,
      masterWidthMm: 800,
    });
    expect(factor).toBeGreaterThanOrEqual(10);
    expect(factor).toBeLessThanOrEqual(12);
  });

  it('buildMapBundle auto lands near ×18–21 for Neasden EA clip (not layer-budget ×50 clamp)', async () => {
    setMapTileFetcher(fixtureTileFetcher);
    const bundle = await buildMapBundle(
      defaultMapSpec({
        ...mapPresetSpec('neasden'),
        bbox: NEASDEN_FAST_BBOX,
        source: 'ea-dtm',
        engrave: { enabled: false, features: [] },
      }),
      {
        fetch: fixtureTileFetcher,
        eaLoader: async () => loadBuiltinEaFixture(),
        allowOverpassNetwork: false,
        stack: { plateCount: 30, thicknessMm: 3, masterWidthMm: 420, layerBudget: 'jenks' },
      },
    );
    const factor = bundle.asset.map?.exaggerationFactor;
    expect(factor).toBeGreaterThan(15);
    expect(factor).toBeLessThanOrEqual(21);
    expect(factor).not.toBe(50);
    expect(mapNoticesMatching(bundle.asset.map?.sourceWarnings, /bathymetry/i, 'info')).toBe(true);
  });

  it('auto exaggeration uses the final ea-dtm grid (~45 m → ×11 on Vermilion 40), not a Terrarium pass', async () => {
    const ea = neasdenRampGrid(20, 66.9);
    expect(reliefMetres(ea)).toBeGreaterThan(40);
    expect(reliefMetres(ea)).toBeLessThan(50);
    const bundle = await buildMapBundle(
      defaultMapSpec({
        bbox: NEASDEN_BBOX,
        source: 'ea-dtm',
        exaggeration: 'auto',
        water: 'raw',
        engrave: { enabled: false, features: [] },
      }),
      {
        eaLoader: async () => ea,
        allowOverpassNetwork: false,
        fetch: async () => {
          throw new Error('terrarium must not run when EA succeeds');
        },
        stack: VERMILION,
      },
    );
    expect(bundle.asset.map?.resolvedSource).toBe('ea-dtm');
    expect(mapNoticesMatching(bundle.asset.map?.sourceWarnings, /falling back to terrarium/i)).toBe(false);
    const factor = bundle.asset.map?.exaggerationFactor ?? 0;
    expect(factor).toBeGreaterThanOrEqual(10);
    expect(factor).toBeLessThanOrEqual(12);
    expect(bundle.asset.map?.exaggeration).toBe('auto');
    expect(bundle.asset.map?.exaggerationReadout).toMatch(/×1[0-2]/);
    expect(bundle.asset.map?.exaggerationReadout).toMatch(/4[0-9] m relief/);
    expect(bundle.asset.map?.exaggerationReadout).toMatch(/120 mm stack on 800 mm/);
  });

  it('9 m Terrarium-scale relief on the full Neasden width clamps Vermilion 40 auto to ×50', () => {
    expect(
      computeAutoExaggeration({
        reliefM: 9,
        stackHeightMm: 120,
        mapWidthM: 3250,
        masterWidthMm: 800,
      }),
    ).toBe(50);
  });

  it('labels Terrarium fallback as terrarium and autos from that low-res relief, not ea-dtm', async () => {
    setMapTileFetcher(fixtureTileFetcher);
    const bundle = await buildMapBundle(
      defaultMapSpec({
        bbox: NEASDEN_FAST_BBOX,
        source: 'ea-dtm',
        exaggeration: 'auto',
        water: 'raw',
        engrave: { enabled: false, features: [] },
      }),
      {
        eaLoader: async () => null,
        fetch: fixtureTileFetcher,
        allowOverpassNetwork: false,
        stack: VERMILION,
      },
    );
    expect(bundle.asset.map?.resolvedSource).toBe('terrarium');
    expect(mapNoticesMatching(bundle.asset.map?.sourceWarnings, /falling back to terrarium/i)).toBe(true);
    const readout = bundle.asset.map?.exaggerationReadout ?? '';
    const relief = Number(readout.match(/(\d+) m relief/)?.[1]);
    expect(relief).toBeGreaterThan(0);
    expect(relief).toBeLessThan(25);
    expect(bundle.asset.map?.exaggeration).toBe('auto');
  });

  it('recomputes auto when the used source changes, without clobbering a user-set exaggeration', async () => {
    setMapTileFetcher(fixtureTileFetcher);
    const fallback = await buildMapBundle(
      defaultMapSpec({
        bbox: NEASDEN_FAST_BBOX,
        source: 'ea-dtm',
        exaggeration: 'auto',
        water: 'raw',
        engrave: { enabled: false, features: [] },
      }),
      {
        eaLoader: async () => null,
        fetch: fixtureTileFetcher,
        allowOverpassNetwork: false,
        stack: VERMILION,
      },
    );
    expect(fallback.asset.map?.resolvedSource).toBe('terrarium');
    const low = fallback.asset.map?.exaggerationFactor ?? 0;

    const ea = await buildMapBundle(
      defaultMapSpec({
        ...fallback.asset.map,
        bbox: NEASDEN_BBOX,
        exaggeration: 'auto',
        water: 'raw',
        engrave: { enabled: false, features: [] },
      }),
      {
        eaLoader: async () => neasdenRampGrid(20, 66.9),
        allowOverpassNetwork: false,
        fetch: async () => {
          throw new Error('EA hit must not mosaic tiles');
        },
        stack: VERMILION,
      },
    );
    expect(ea.asset.map?.resolvedSource).toBe('ea-dtm');
    expect(ea.asset.map?.exaggeration).toBe('auto');
    expect(ea.asset.map?.exaggerationFactor).toBeGreaterThanOrEqual(10);
    expect(ea.asset.map?.exaggerationFactor).toBeLessThanOrEqual(12);
    expect(ea.asset.map?.exaggerationFactor).not.toBe(low);

    const locked = await buildMapBundle(
      defaultMapSpec({
        bbox: NEASDEN_BBOX,
        source: 'ea-dtm',
        exaggeration: 21,
        water: 'raw',
        engrave: { enabled: false, features: [] },
      }),
      {
        eaLoader: async () => neasdenRampGrid(20, 66.9),
        allowOverpassNetwork: false,
        fetch: async () => {
          throw new Error('locked exaggeration must not need tiles');
        },
        stack: VERMILION,
      },
    );
    expect(locked.asset.map?.exaggeration).toBe(21);
    expect(locked.asset.map?.exaggerationFactor).toBe(21);
    expect(locked.asset.map?.resolvedSource).toBe('ea-dtm');
  });
});
