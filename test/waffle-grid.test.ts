import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { buildZip, buildPackHtmlChecked } from '../src/core/exporters';
import { inAppPlateCount } from '../src/core/buildPackIntegrity';
import { crossingAt, waffleSlotWidth } from '../src/core/slicer';
import { pointInShape, type Shape } from '../src/core/geom2d';
import { planeToWorld } from '../src/core/section';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { mapPresetSpec } from '../src/core/mapPresets';
import { loadBuiltinEaFixture } from '../src/core/mapEaLidar.fixtures';
import { depthToGray } from '../src/core/depth';
import { kerfGapRegions } from '../src/core/fragments';
import { readFileSync } from 'node:fs';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

function grid(params: Record<string, string>) {
  const p = newProject();
  Object.assign(p.params, { sliceMode: 'waffle', waffleLayout: 'grid', insShape: 'none', ...params });
  return { p, m: createPipeline()(p, assets) };
}

const shapeOf = (m: ReturnType<typeof grid>['m'], key: string): Shape => m.sliced.parts.filter((q) => q.plateKey === key).flatMap((q) => q.shape);

/** Every crossing inside both plates is a half lap: the plate keeps its lower half, the cross plate its upper. */
function expectHalfLaps(m: ReturnType<typeof grid>['m']): number {
  const P = m.sliced.plates.filter((pl) => pl.def.family === 'P');
  const X = m.sliced.plates.filter((pl) => pl.def.family === 'X');
  const sw = waffleSlotWidth(m.v);
  let laps = 0;
  for (const p of P)
    for (const x of X) {
      const c = crossingAt(p.def.plane, x.def.plane, 0);
      if (!c || c.ua < p.def.u0 + sw || c.ua > p.def.u1 - sw || c.ub < x.def.u0 + sw || c.ub > x.def.u1 - sw) continue;
      const sp = shapeOf(m, p.def.key), sx = shapeOf(m, x.def.key);
      const lo = Math.min(...[sp, sx].map((s) => Math.max(...s.map((ex) => Math.max(...ex.outer.map((q) => q[1])))))) ;
      if (!pointInShape([c.ua, 2], sp) || !pointInShape([c.ub, lo * 0.9], sx)) continue; // cut away by the terrain
      expect(pointInShape([c.ua, lo * 0.1], sp), `${p.def.key} low at ${x.def.key}`).toBe(true);
      expect(pointInShape([c.ub, lo * 0.1], sx), `${x.def.key} low at ${p.def.key}`).toBe(false);
      laps++;
    }
  return laps;
}

/** Every plate of one set crosses every plate of the other inside both, as a half lap. */
function expectClosedLattice(m: ReturnType<typeof grid>['m']) {
  const P = m.sliced.plates.filter((pl) => pl.def.family === 'P');
  const X = m.sliced.plates.filter((pl) => pl.def.family === 'X');
  expect(P.length).toBeGreaterThanOrEqual(2);
  expect(X.length).toBeGreaterThanOrEqual(2);
  for (const p of P)
    for (const x of X) {
      const c = crossingAt(p.def.plane, x.def.plane, 0)!;
      expect(c, `${p.def.key}×${x.def.key}`).not.toBeNull();
      expect(c.ua).toBeGreaterThan(p.def.u0);
      expect(c.ua).toBeLessThan(p.def.u1);
      expect(c.ub).toBeGreaterThan(x.def.u0);
      expect(c.ub).toBeLessThan(x.def.u1);
      // plate keeps its lower half at the crossing, the cross plate its upper half
      const yTop = m.v.stackHeight;
      expect(pointInShape([c.ua, yTop * 0.1], shapeOf(m, p.def.key)), `${p.def.key} low at ${x.def.key}`).toBe(true);
      expect(pointInShape([c.ua, yTop * 0.9], shapeOf(m, p.def.key)), `${p.def.key} high at ${x.def.key}`).toBe(false);
      expect(pointInShape([c.ub, yTop * 0.1], shapeOf(m, x.def.key)), `${x.def.key} low at ${p.def.key}`).toBe(false);
      expect(pointInShape([c.ub, yTop * 0.9], shapeOf(m, x.def.key)), `${x.def.key} high at ${p.def.key}`).toBe(true);
    }
  // the outer plates frame it: every plate ends at the outer face of the other set's outermost plate
  const t = m.v.thickness;
  const sin = Math.sin((m.v.gridAngle * Math.PI) / 180);
  for (const [set, other] of [[P, X], [X, P]] as const)
    for (const a of set) {
      const us = other.map((b) => crossingAt(a.def.plane, b.def.plane, 0)!.ua);
      expect(Math.min(...us) - a.def.u0).toBeCloseTo(t / 2 / sin, 6);
      expect(a.def.u1 - Math.max(...us)).toBeCloseTo(t / 2 / sin, 6);
    }
}

function expectExportable(m: ReturnType<typeof grid>['m'], p: ReturnType<typeof grid>['p']) {
  expect(m.issues.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([]);
  const zip = unzipSync(buildZip(m, p));
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));
  expect(manifest.plateCount).toBe(inAppPlateCount(m));
  expect(manifest.plateCount).toBe(m.sliced.plates.length);
  buildPackHtmlChecked(p, m);
}

describe('waffle closed grid', { timeout: 120_000 }, () => {
  it('leaves the spread waffle as it was', () => {
    const p = newProject();
    p.params.sliceMode = 'waffle';
    p.params.plateCount = '8';
    const m = createPipeline()(p, assets);
    expect(m.v.waffleLayout).toBe('spread');
    expect(m.ev.overrides.crossCount).toBeUndefined();
    expect(m.sliced.plates.filter((pl) => pl.def.family === 'P').every((pl) => pl.def.u0 === -m.v.plateWidth / 2)).toBe(true);
  });

  it('square cells: the cell size sets both pitches and the plates close at the corners', () => {
    const { p, m } = grid({ cellSize: '40' });
    expect(m.v.pitch).toBe(40);
    expect(m.v.plateCount).toBe(Math.floor((m.v.stackLength - 2 * m.v.endMargin) / 40) + 1);
    const X = m.sliced.plates.filter((pl) => pl.def.family === 'X');
    expect(X.length).toBe(m.v.crossCount);
    const across = X.map((x) => x.def.plane.origin[2]).sort((a, b) => a - b);
    for (let i = 1; i < across.length; i++) expect(across[i] - across[i - 1]).toBeCloseTo(40, 6);
    expect(waffleSlotWidth(m.v)).toBeCloseTo(m.v.thickness + m.v.slotClearance, 9);
    expectClosedLattice(m);
    expectExportable(m, p);
  });

  it('rectangular cells use the cross cell size', () => {
    const { p, m } = grid({ gridCell: 'rect', cellSize: '30', cellCross: '60' });
    const across = m.sliced.plates.filter((pl) => pl.def.family === 'X').map((x) => x.def.plane.origin[2]).sort((a, b) => a - b);
    for (let i = 1; i < across.length; i++) expect(across[i] - across[i - 1]).toBeCloseTo(60, 6);
    expectClosedLattice(m);
    expectExportable(m, p);
  });

  it('angled grid: diamonds, wider slots, still one closed lattice', () => {
    const { p, m } = grid({ cellSize: '45', gridAngle: '60' });
    const t = m.v.thickness;
    const th = Math.PI / 3;
    expect(waffleSlotWidth(m.v)).toBeCloseTo(t / Math.sin(th) + t / Math.tan(th) + m.v.slotClearance, 9);
    // cross plates run at 60° to the plates
    const P0 = m.sliced.plates.find((pl) => pl.def.family === 'P')!.def.plane;
    const X0 = m.sliced.plates.find((pl) => pl.def.family === 'X')!.def.plane;
    const cos = Math.abs(P0.u[0] * X0.u[0] + P0.u[2] * X0.u[2]);
    expect(cos).toBeCloseTo(Math.cos(th), 9);
    expectClosedLattice(m);
    // the whole frame stays on the base
    for (const pl of m.sliced.plates)
      for (const u of [pl.def.u0, pl.def.u1]) {
        const w = planeToWorld(pl.def.plane, u, 0);
        expect(Math.abs(w[0])).toBeLessThanOrEqual(m.v.baseLength / 2);
        expect(Math.abs(w[2])).toBeLessThanOrEqual(m.v.baseWidth / 2);
      }
    expect(m.sliced.brace?.issues.some((i) => /slanted cross plates/.test(i.message)) ?? true).toBe(true);
    expectExportable(m, p);
  });

  it('spread layout with slanted cross plates: corner to corner, cut off at the stack edge', () => {
    const p = newProject();
    Object.assign(p.params, { sliceMode: 'waffle', insShape: 'none', plateCount: '20', crossCount: '9', gridAngle: '45' });
    const m = createPipeline()(p, assets);
    const X = m.sliced.plates.filter((pl) => pl.def.family === 'X');
    expect(X.length).toBe(9);
    const P = m.sliced.plates.filter((pl) => pl.def.family === 'P');
    expect(P.every((pl) => pl.def.u0 === -m.v.plateWidth / 2 && pl.def.u1 === m.v.plateWidth / 2)).toBe(true);
    for (const x of X) {
      expect(x.def.u1 - x.def.u0).toBeGreaterThanOrEqual(2 * m.v.pitch - 1e-6);
      for (const u of [x.def.u0, x.def.u1]) {
        const w = planeToWorld(x.def.plane, u, 0);
        expect(Math.abs(w[2])).toBeLessThanOrEqual(m.v.plateWidth / 2 + 1e-6);
      }
    }
    expect(expectHalfLaps(m)).toBeGreaterThan(20);
    expectExportable(m, p);
  });

  it('slanted closed grid on a map keeps every slot (map plates turn round)', async () => {
    const spec = defaultMapSpec({ ...mapPresetSpec('neasden'), engrave: { enabled: false, features: [] } });
    const bundle = await buildMapBundle(spec, {
      fetch: async () => {
        throw new Error('offline');
      },
      eaLoader: async () => loadBuiltinEaFixture()!,
      allowOverpassNetwork: false,
      stack: { plateCount: 26, thicknessMm: 3, masterWidthMm: 800 },
    });
    const p = newProject();
    // as the Neasden map preset sets it up in the app
    Object.assign(p.params, { sliceMode: 'waffle', waffleLayout: 'grid', cellSize: '40', gridAngle: '60', imgTopMode: 'carve' });
    p.images.top = bundle.asset;
    const m = createPipeline()(p, { ...assets, topImg: depthToGray(bundle.depth) });
    const X = m.sliced.plates.filter((pl) => pl.def.family === 'X');
    const P = m.sliced.plates.filter((pl) => pl.def.family === 'P');
    expect(X.length).toBeGreaterThanOrEqual(3);
    for (const pl of P) for (const x of X) {
      const c = crossingAt(pl.def.plane, x.def.plane, 0)!;
      expect(c.ua).toBeGreaterThan(pl.def.u0);
      expect(c.ua).toBeLessThan(pl.def.u1);
    }
    expect(m.issues.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([]);
  });

  it('a micron of Clipper dust along a long slanted top is not a kerf gap', () => {
    // SX-01 of the Neasden grid at 60°: its closing left a 186 mm sliver a micron wide
    const shape = JSON.parse(readFileSync(new URL('./fixtures/kerf-dust-slanted-cross-plate.json', import.meta.url), 'utf8')) as Shape;
    expect(kerfGapRegions(shape, 0.15)).toEqual([]);
    // a real slit is still found
    const slit: Shape = [{ outer: [[0, 0], [100, 0], [100, 50], [50.05, 50], [50.05, 10], [49.95, 10], [49.95, 50], [0, 50]], holes: [] }];
    expect(kerfGapRegions(slit, 0.15).length).toBe(1);
  });

  it('warns when a shallow angle leaves no steel between slots', () => {
    const { m } = grid({ cellSize: '12', gridAngle: '30', thickness: '6' });
    expect(m.sliced.warnings.some((w) => /Closed grid: the slots/.test(w))).toBe(true);
  });
});
