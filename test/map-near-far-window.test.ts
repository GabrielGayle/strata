import { describe, expect, it } from 'vitest';
import { loadBuiltinEaFixture } from '../src/core/mapEaLidar.fixtures';
import { buildMapBundle } from '../src/core/mapPipeline';
import { mapPresetSpec } from '../src/core/mapPresets';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { mapDepthToGray, buildMapHeightField } from '../src/core/mapPlateHeight';
import { plateTopHeightRangeMm } from '../src/core/slicer';
import { markDepthSettingOverrides } from '../src/core/depthOverrides';
import { evaluateParams } from '../src/core/params';
import { mapGridToDepth, syntheticConeGrid } from '../src/core/mapToDepth';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

function linearWindow(minM: number, maxM: number, tNear: number, tFar: number) {
  const span = maxM - minM;
  return { near: minM + tNear * span, far: minM + tFar * span };
}

describe('map near/far window keeps plate range', () => {
  it('a 35–65% linear window on Neasden still has height (log 35–65% does not)', async () => {
    const g = loadBuiltinEaFixture();
    expect(g).toBeTruthy();
    const spec = mapPresetSpec('neasden');
    spec.engrave = { enabled: false, features: [] };
    spec.water = 'raw';
    const bundle = await buildMapBundle(spec, {
      eaLoader: async () => g,
      allowOverpassNetwork: false,
      fetch: async () => {
        throw new Error('near/far window test must not mosaic');
      },
    });
    const d = bundle.depth;
    const { near, far } = linearWindow(d.minM, d.maxM, 0.35, 0.65);
    const tuned = {
      ...d,
      settings: { ...d.settings, near, far },
      settingsOverrides: markDepthSettingOverrides(undefined, { near, far }),
    };
    const p = newProject();
    p.params = { ...p.params, insShape: 'none', erosionAmp: '0', crest: '0', slope: '0' };
    p.images.top = { ...bundle.asset, depth: tuned };
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: mapDepthToGray(tuned), insMesh: null, srcMesh: null });
    expect(plateTopHeightRangeMm(m.sliced.plates)).toBeGreaterThan(5);
    expect(near).toBeGreaterThan(d.minM + 0.2 * (d.maxM - d.minM));
    expect(far).toBeLessThan(d.maxM - 0.2 * (d.maxM - d.minM));
  });

  it('height-field min/max include a 1-cell summit the coarse lattice would miss', () => {
    const grid = syntheticConeGrid(64, 24, 12);
    grid.data[17 * grid.w + 23] = 40;
    const { depth } = mapGridToDepth(grid, { exaggeration: 4, bbox: NEASDEN_FAST_BBOX });
    const cap = depth.minM + 0.02 * (depth.maxM - depth.minM);
    depth.settings = { ...depth.settings, near: depth.minM, far: cap };
    const v = evaluateParams({
      baseLength: '400',
      baseWidth: '400',
      stackHeight: '100',
      erosionAmp: '0',
      crest: '0',
      slope: '0',
    }).values;
    const hf = buildMapHeightField(v, depth);
    expect(hf.max).toBeGreaterThan(hf.min + 0.2);
  });
});
