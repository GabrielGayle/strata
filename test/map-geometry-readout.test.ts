import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject, PRESETS } from '../src/core/project';
import { defaultMapSpec } from '../src/core/mapSpec';
import { mapGridToDepth, syntheticConeGrid } from '../src/core/mapToDepth';
import { mapDepthToGray, mapTrueRangePlateMm } from '../src/core/mapPlateHeight';
import { formatExaggerationStackReadout } from '../src/core/mapExaggeration';
import { flatStackIsCapped, formatLiveMapReadout, formatMapHeightCaption, mm0 } from '../src/core/mapGeometryReadout';
import { plateOutlineYRangeMm } from '../src/core/slicer';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

const EX = 21;

function run(presetName: 'Vermilion 40' | 'Stamped stack') {
  const grid = syntheticConeGrid(48, 24, 18);
  const { depth } = mapGridToDepth(grid, { exaggeration: EX, bbox: NEASDEN_FAST_BBOX });
  const preset = PRESETS.find((x) => x.name === presetName)!;
  const p = newProject();
  p.params = {
    ...p.params,
    ...preset.params,
    plateCount: presetName === 'Stamped stack' ? '8' : '12',
    erosionAmp: '0',
    crest: '0',
    slope: '0',
    insShape: 'none',
    imgTopMode: 'carve',
  };
  p.images.top = {
    name: 'Map',
    dataUrl: 'data:image/png;base64,xx',
    map: defaultMapSpec({
      bbox: NEASDEN_FAST_BBOX,
      title: 'Cone',
      exaggeration: EX,
      exaggerationFactor: EX,
      exaggerationReadout: formatExaggerationStackReadout(EX, depth.mapOrtho!.reliefM, depth.mapOrtho!.widthM, 520),
    }),
    depth,
  };
  const gray = mapDepthToGray(depth);
  const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
  const caption = formatMapHeightCaption({
    sliceMode: m.v.sliceMode,
    plates: m.sliced.plates,
    thicknessMm: m.v.thickness,
    mapFace: true,
    bboxMin: 0,
    bboxMax: 0,
  });
  const live = formatLiveMapReadout({
    factor: EX,
    reliefM: depth.mapOrtho!.reliefM,
    sliceMode: m.v.sliceMode,
    plates: m.sliced.plates,
    thicknessMm: m.v.thickness,
    mapFace: true,
  });
  const stale520 = formatExaggerationStackReadout(EX, depth.mapOrtho!.reliefM, depth.mapOrtho!.widthM, 520);
  return { m, depth, caption, live, stale520 };
}

describe('Map readout equals built geometry', () => {
  it('Vermilion (upright) live line matches the 3D terrain caption, not a 520 mm Stamped bake', () => {
    const { m, depth, caption, live, stale520 } = run('Vermilion 40');
    expect(m.v.sliceMode).toBe('parallel');
    const outline = plateOutlineYRangeMm(m.sliced.plates);
    expect(outline).toBeTruthy();
    expect(caption).toBe(`terrain ${mm0(outline!.lo)}–${mm0(outline!.hi)} mm`);
    expect(live).toContain(caption);
    expect(live).toMatch(/^×21 · \d+ m relief → terrain /);
    expect(stale520).toMatch(/on 520 mm/);
    expect(live).not.toContain('on 520 mm');
    const staleMm = stale520.match(/→ (\d+) mm stack/)?.[1];
    expect(staleMm).toBeTruthy();
    expect(live).not.toContain(`${staleMm} mm stack`);
    const currentMaster = mapTrueRangePlateMm(depth, m.v, EX);
    expect(outline!.hi - outline!.lo).toBeGreaterThan(currentMaster * 0.7);
    expect(Number(staleMm)).toBeLessThan(currentMaster * 0.85);
  });

  it('Stamped stack live line is n×thickness, not the plan-scale millimetre figure', () => {
    const { m, depth, caption, live, stale520 } = run('Stamped stack');
    expect(m.v.sliceMode).toBe('flat');
    const stackMm = m.sliced.plates.length * m.v.thickness;
    expect(caption).toBe(`stack height ${mm0(stackMm)} mm`);
    expect(live).toBe(`×21 · ${Math.round(depth.mapOrtho!.reliefM)} m relief → ${caption}`);
    expect(stale520).toMatch(/on 520 mm/);
    const planMm = Number(stale520.match(/→ (\d+) mm stack/)?.[1]);
    expect(planMm).not.toBe(Math.round(stackMm));
    expect(live).not.toContain(`${planMm} mm stack`);
  });

  it('flatStackIsCapped matches the slicer (n×t < top − t)', () => {
    expect(flatStackIsCapped(60, 20, 3)).toBe(false);
    expect(flatStackIsCapped(63, 20, 3)).toBe(false);
    expect(flatStackIsCapped(64, 20, 3)).toBe(true);
    expect(flatStackIsCapped(undefined, 20, 3)).toBe(false);
  });

  it('Stamped caption names the layer cap when the height field is taller than n×thickness', () => {
    const { m, depth } = run('Stamped stack');
    const caption = formatMapHeightCaption({
      sliceMode: m.v.sliceMode,
      plates: m.sliced.plates,
      thicknessMm: m.v.thickness,
      mapFace: true,
      bboxMin: 0,
      bboxMax: 0,
      terrainTopMm: m.sliced.plates.length * m.v.thickness + 80,
    });
    expect(caption).toBe(`stack height ${mm0(m.sliced.plates.length * m.v.thickness)} mm · capped at ${m.sliced.plates.length} layers`);
    const live = formatLiveMapReadout({
      factor: EX,
      reliefM: depth.mapOrtho!.reliefM,
      sliceMode: m.v.sliceMode,
      plates: m.sliced.plates,
      thicknessMm: m.v.thickness,
      mapFace: true,
      terrainTopMm: m.sliced.plates.length * m.v.thickness + 80,
    });
    expect(live).toContain(caption);
  });
});
