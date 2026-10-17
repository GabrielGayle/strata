import { beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyProjectPatch, parseDesign } from '../src/core/design';
import { createPipeline } from '../src/core/pipeline';
import { buildMapBundle, mapStackFromProject } from '../src/core/mapPipeline';
import { mapPresetSpec, MAP_PRESET_CATALOG, NEASDEN_MAP_BBOX } from '../src/core/mapPresets';
import { applyQuickMapToProject, mapOutlineForBbox, quickMapPlateCount, quickMapSpecKeepingUser, QUICK_MAP_ENGRAVE_PRESET } from '../src/core/quickMap';
import { mapBuildKey } from '../src/core/mapBuildKey';
import { mapGridToDepth, syntheticConeGrid } from '../src/core/mapToDepth';
import { projectWithTopMapSpec } from '../src/core/mapTopAsset';
import { mapDepthToGray } from '../src/core/mapPlateHeight';
import { metricBounds } from '../src/core/mapProject';
import type { Float32Grid } from '../src/core/mapGrid';
import { loadBuiltinRegionalFixture } from '../src/core/mapRegionalLidar.fixtures';
import { markDepthSettingOverrides } from '../src/core/depthOverrides';
import { applyPreset, newProject, PRESETS } from '../src/core/project';
import { buildZip, buildPackHtmlChecked, assertExportable } from '../src/core/exporters';
import { assertHtmlBuildPackIntegrity, assertZipBuildPackIntegrity } from '../src/core/buildPackIntegrity';
import { useStore } from '../src/state/store';
import { NEASDEN_BBOX } from './map-fixtures';

const overpassFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/map/overpass-neasden.json', import.meta.url)), 'utf8'),
);

function liveLikeNeasdenGrid(): Float32Grid {
  const b = metricBounds(NEASDEN_MAP_BBOX, 'EPSG:27700');
  const w = 96;
  const h = 96;
  const pixelW = (b.east - b.west) / w;
  const pixelH = (b.north - b.south) / h;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const v = y / (h - 1);
      let z = 35 + 4 * Math.sin(u * 8) * Math.cos(v * 6);
      const hill = Math.exp(-((u - 0.75) ** 2 + (v - 0.8) ** 2) / 0.04);
      const dip = Math.exp(-((u - 0.2) ** 2 + (v - 0.2) ** 2) / 0.05);
      z = z + hill * (86 - z) + dip * (18.8 - z);
      data[y * w + x] = z;
    }
  }
  return {
    w,
    h,
    data,
    crs: 'EPSG:27700',
    transform: { originX: b.west + pixelW / 2, originY: b.south + pixelH / 2, pixelW, pixelH },
  };
}

function downsampleGrid(g: Float32Grid, maxDim: number): Float32Grid {
  const scale = Math.max(g.w, g.h) / maxDim;
  if (scale <= 1) return g;
  const w = Math.max(8, Math.round(g.w / scale));
  const h = Math.max(8, Math.round(g.h / scale));
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(g.w - 1, Math.round((x / Math.max(1, w - 1)) * (g.w - 1)));
      const sy = Math.min(g.h - 1, Math.round((y / Math.max(1, h - 1)) * (g.h - 1)));
      data[y * w + x] = g.data[sy * g.w + sx];
    }
  }
  return {
    ...g,
    w,
    h,
    data,
    transform: {
      ...g.transform,
      pixelW: g.transform.pixelW * (g.w / w),
      pixelH: g.transform.pixelH * (g.h / h),
    },
  };
}

function mustRegional(source: 'scot-dtm' | 'ni-dtm'): Float32Grid {
  const g = loadBuiltinRegionalFixture(source);
  if (!g) throw new Error(`missing ${source} fixture`);
  return downsampleGrid(g, 96);
}

let kingsGrid: Float32Grid | undefined;
let rcdGrid: Float32Grid | undefined;

function loadersFor(id: string) {
  if (id === 'kingsbarns') {
    kingsGrid ??= mustRegional('scot-dtm');
    return { regionalLoader: async () => kingsGrid!, eaLoader: async () => null };
  }
  if (id === 'royal-county-down') {
    rcdGrid ??= mustRegional('ni-dtm');
    return { regionalLoader: async () => rcdGrid!, eaLoader: async () => null };
  }
  const g = liveLikeNeasdenGrid();
  return { eaLoader: async () => g, regionalLoader: async () => null };
}

async function projectQuickMap(id: string) {
  let p = newProject();
  p = projectWithTopMapSpec(p, mapPresetSpec(id));
  p = applyQuickMapToProject(p);
  const spec = p.images.top!.map!;
  const bundle = await buildMapBundle(spec, {
    ...loadersFor(id),
    overpass: async () => overpassFixture,
    allowOverpassNetwork: false,
    fetch: () => Promise.reject(new Error('tiles disabled in quick-map tests')),
    stack: mapStackFromProject(p, spec.layerBudget),
  });
  p = { ...p, images: { ...p.images, top: bundle.asset } };
  const gray = mapDepthToGray(bundle.depth);
  const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
  return { p, m, spec: p.images.top!.map! };
}

function issueTally(m: { issues: { severity: string; type: string; message: string }[] }) {
  const errors = m.issues.filter((i) => i.severity === 'error');
  const thin = m.issues.filter((i) => i.type === 'thin' && /narrower than 2 mm/.test(i.message));
  return { errors, thin };
}

describe('Quick map mode', () => {
  it('sets dense pitch from the current outline without clobbering user sizes', () => {
    const p = newProject();
    expect(quickMapPlateCount(p.params)).toBe(49);
    const mini = { ...p.params, baseLength: '90', baseWidth: '40', endMargin: '6' };
    expect(quickMapPlateCount(mini)).toBeGreaterThanOrEqual(8);
    expect(quickMapPlateCount(mini)).toBeLessThan(20);
  });

  it('keeps the long millimetre as the stack for portrait places', () => {
    const p = newProject();
    expect(mapOutlineForBbox(NEASDEN_BBOX, p.params)).toEqual({});
    expect(mapOutlineForBbox(NEASDEN_BBOX, { ...p.params, baseLength: '300', baseWidth: '800' })).toEqual({
      baseLength: '800',
      baseWidth: '300',
    });
  });

  it('keeps user exaggeration and frame via keepUserMapSettings', () => {
    const prev = mapPresetSpec('neasden');
    prev.exaggeration = 21;
    prev.sunkenFrame = { enabled: true, wallMm: 18 };
    prev.giftSizeId = 'a6';
    prev.water = 'raw';
    const next = quickMapSpecKeepingUser(prev)!;
    expect(next.exaggeration).toBe(21);
    expect(next.sunkenFrame).toEqual({ enabled: true, wallMm: 18 });
    expect(next.giftSizeId).toBe('a6');
    expect(next.bbox).toEqual(NEASDEN_BBOX);
    expect(next.title).toBe('Neasden');
    expect(next.water).toBe('bathy');
    expect(next.engrave.enabled).toBe(true);
    expect(next.engrave.preset).toBe(QUICK_MAP_ENGRAVE_PRESET);
    expect(next.engrave.features).toContain('labels');
    expect(next.buildKey).toBeUndefined();
  });

  it('keeps golf/ski extras and Survey fonts on those place presets', () => {
    const golf = quickMapSpecKeepingUser(mapPresetSpec('kingsbarns'))!;
    expect(golf.engrave.preset).toBe(QUICK_MAP_ENGRAVE_PRESET);
    expect(golf.engrave.features).toEqual(expect.arrayContaining(['labels', 'contours', 'golf', 'compass']));
    const ski = quickMapSpecKeepingUser(mapPresetSpec('ski-example'))!;
    expect(ski.engrave.features).toEqual(expect.arrayContaining(['labels', 'ski', 'piste']));
  });

  it.each(MAP_PRESET_CATALOG.map((p) => p.id))(
    '%s: 0 fit errors, 0 thin-2mm, export counts match',
    async (id) => {
      const { p, m } = await projectQuickMap(id);
      const t = issueTally(m);
      expect(t.errors, t.errors.map((e) => e.message).join(' | ')).toHaveLength(0);
      expect(t.thin, t.thin.map((e) => e.message).join(' | ')).toHaveLength(0);
      expect(m.insert).toBeNull();
      expect(m.v.insShape).toBe('none');
      expect(m.v.sliceMode).toBe('parallel');
      expect(m.v.imgFrontMode).toBe('off');
      expect(m.v.imgSideMode).toBe('off');
      expect(p.images.top?.map?.engrave.enabled).toBe(true);
      expect(p.images.top?.map?.engrave.preset).toBe(QUICK_MAP_ENGRAVE_PRESET);
      expect(p.images.top?.map?.water).toBe('bathy');
      expect(p.images.top?.map?.engrave.features).toContain('labels');
      assertExportable(m);
      const zip = unzipSync(buildZip(m, p));
      const manifest = assertZipBuildPackIntegrity(m, p, zip);
      expect(manifest.plateCount).toBe(m.sliced.plates.length);
      expect(Object.keys(zip).filter((n) => n.startsWith('plates/') && n.endsWith('.dxf'))).toHaveLength(m.sliced.plates.length);
      expect(Object.keys(zip).filter((n) => n.startsWith('laser/parts/') && n.endsWith('.dxf'))).toHaveLength(m.sliced.parts.length);
      const html = strFromU8(zip['build-pack.html']);
      assertHtmlBuildPackIntegrity(p, m, html);
      buildPackHtmlChecked(p, m);
    },
    120_000,
  );

  it('does not overwrite user plate count, sizes, or near/far', () => {
    let p = newProject();
    p = projectWithTopMapSpec(p, mapPresetSpec('neasden'));
    p.params = { ...p.params, plateCount: '18', baseLength: '640', baseWidth: '210', erosionAmp: '12' };
    p.userParamOverrides = { plateCount: true, baseLength: true, baseWidth: true, erosionAmp: true };
    const depth = {
      w: 2,
      h: 2,
      minM: 1,
      maxM: 80,
      nearM: 2,
      farM: 70,
      data: 'AAAA',
      settings: {
        near: 5,
        far: 40,
        spacing: 'linear' as const,
        curve: 1,
        flatten: 0,
        matte: false,
        resolution: 64,
        invert: false,
        flatLevelMode: 'auto' as const,
      },
      settingsOverrides: markDepthSettingOverrides(undefined, { near: 5, far: 40 }),
    };
    p.images.top = { ...p.images.top!, depth };
    p.images.top.map = { ...p.images.top.map!, exaggeration: 21 };
    const next = applyQuickMapToProject(p);
    expect(next.params.plateCount).toBe('18');
    expect(next.params.baseLength).toBe('640');
    expect(next.params.baseWidth).toBe('210');
    expect(next.params.erosionAmp).toBe('12');
    expect(next.images.top?.map?.exaggeration).toBe(21);
    expect(next.images.top?.depth?.settings.near).toBe(5);
    expect(next.images.top?.depth?.settings.far).toBe(40);
    expect(next.images.top?.depth?.settings.flatLevelMode).toBe('off');
    expect(next.params.insShape).toBe('none');
  });

  it('clears Image cliff faces and the Vermilion fin', () => {
    let p = applyPreset(newProject(), PRESETS.find((x) => x.name === 'Image cliff')!);
    p = projectWithTopMapSpec(p, mapPresetSpec('neasden'));
    const next = applyQuickMapToProject(p);
    expect(next.params.imgFrontMode).toBe('off');
    expect(next.params.imgSideMode).toBe('off');
    expect(next.params.etchMode).toBe('off');
    expect(next.params.insShape).toBe('none');
    expect(next.params.sliceMode).toBe('parallel');
    expect(next.params.topFloor).toBe('follow');
  });

  it('store applyQuickMap is one undo step', () => {
    const p = projectWithTopMapSpec(newProject(), mapPresetSpec('neasden'));
    useStore.setState({
      project: p,
      past: [],
      future: [],
      mapTerrain: { phase: 'idle', message: '' },
    });
    const beforeCount = String(useStore.getState().project.params.plateCount ?? '40');
    const beforeIns = useStore.getState().project.params.insShape;
    useStore.getState().applyQuickMap();
    expect(useStore.getState().project.params.insShape).toBe('none');
    expect(String(useStore.getState().project.params.plateCount)).not.toBe(beforeCount);
    expect(useStore.getState().project.images.top?.map?.engrave.preset).toBe(QUICK_MAP_ENGRAVE_PRESET);
    useStore.getState().undo();
    expect(useStore.getState().project.params.plateCount).toBe(beforeCount);
    expect(useStore.getState().project.params.insShape).toBe(beforeIns);
    expect(useStore.getState().project.images.top?.map?.engrave.preset).toBe('city');
  });

  it('terrain finish does not add a second undo step', () => {
    const p = projectWithTopMapSpec(newProject(), mapPresetSpec('neasden'));
    useStore.setState({
      project: p,
      past: [],
      future: [],
      mapTerrain: { phase: 'idle', message: '' },
    });
    useStore.getState().applyQuickMap();
    const pastLen = useStore.getState().past.length;
    const spec = useStore.getState().project.images.top!.map!;
    const { depth } = mapGridToDepth(syntheticConeGrid(16), { exaggeration: 8, bbox: spec.bbox });
    useStore.getState().finishMapTerrainBuild({
      name: 'Map',
      dataUrl: 'data:image/png;base64,abc',
      map: { ...spec, buildKey: mapBuildKey(spec) },
      depth,
    });
    expect(useStore.getState().past).toHaveLength(pastLen);
    useStore.getState().undo();
    expect(useStore.getState().project.params.insShape).toBe('fin');
    expect(useStore.getState().project.images.top?.map?.engrave.preset).toBe('city');
  });

  it('design parser understands quick map after a place', () => {
    const r = parseDesign('neasden map, quick map', { project: newProject() });
    expect(r.patch.map?.title).toBe('Neasden');
    expect(r.patch.quickMap).toBe(true);
    const project = applyProjectPatch(newProject(), r.patch);
    expect(project.images.top?.map?.bbox).toEqual(NEASDEN_BBOX);
    expect(project.params.insShape).toBe('none');
    expect(project.images.top?.map?.engrave.features).toContain('labels');
  });
});

describe('store isolation for quick map undo', () => {
  beforeEach(() => {
    useStore.setState({
      project: newProject(),
      past: [],
      future: [],
      mapTerrain: { phase: 'idle', message: '' },
    });
  });

  it('setTopMap and applyQuickMap bump mapRebuildEpoch so a failed build can retry', () => {
    const p = projectWithTopMapSpec(newProject(), mapPresetSpec('neasden'));
    useStore.setState({
      project: p,
      past: [],
      future: [],
      mapTerrain: { phase: 'error', message: "Couldn't build plates", error: 'gap' },
      mapRebuildEpoch: 4,
    });
    useStore.getState().applyQuickMap();
    expect(useStore.getState().mapRebuildEpoch).toBe(5);
    expect(useStore.getState().mapTerrain).toMatchObject({
      phase: 'working',
      message: 'Queued terrain build…',
    });
    const spec = useStore.getState().project.images.top!.map!;
    useStore.getState().setTopMap(spec);
    expect(useStore.getState().mapRebuildEpoch).toBe(6);
    expect(useStore.getState().mapTerrain.message).toBe('Queued terrain build…');
  });

  it('redo restores Quick map after undo', () => {
    useStore.getState().setTopMap(mapPresetSpec('neasden'));
    useStore.getState().applyQuickMap();
    const after = useStore.getState().project.params.plateCount;
    useStore.getState().undo();
    useStore.getState().redo();
    expect(useStore.getState().project.params.plateCount).toBe(after);
    expect(useStore.getState().project.params.insShape).toBe('none');
  });
});
