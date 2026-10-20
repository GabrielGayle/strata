import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, newProject } from '../src/core/project';
import { loadAssets } from '../src/packNode';
import { buildZip, buildPackHtmlChecked } from '../src/core/exporters';
import { cutListCsv } from '../src/core/bom';
import { estimateMix } from '../src/core/price';
import { evaluateParams } from '../src/core/params';
import { planeToWorld } from '../src/core/section';
import { pointInShape } from '../src/core/geom2d';
import { fixingHoles, tabLayout, weldOrder, steelBaseSpec } from '../src/core/steelBase';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

function project(params: Record<string, string | boolean>) {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', ...params };
  return p;
}
const run = (params: Record<string, string | boolean>) => {
  const p = project(params);
  return { p, m: createPipeline()(p, assets) };
};
const steel = { baseMaterial: 'steel' };
const errors = (m: ReturnType<typeof run>['m']) => m.issues.filter((i) => i.severity === 'error').map((i) => i.message);

describe('steel base', () => {
  it('leaves the concrete base alone by default', () => {
    const { m } = run({});
    expect(m.v.baseOn).toBe(true);
    expect(m.v.steelBaseOn).toBe(false);
    expect(m.sliced.steelBase ?? null).toBeNull();
    expect(m.sliced.parts.some((p) => p.family === 'B')).toBe(false);
  });

  it('stands in for the concrete: no pour, no mould, plates on a 3 mm base plate', () => {
    const { m } = run(steel);
    expect(m.v.baseOn).toBe(false);
    expect(m.v.steelBaseOn).toBe(true);
    expect(m.bom.concreteMass).toBe(0);
    expect(m.moulds.parts).toHaveLength(0);
    const base = m.sliced.parts.filter((p) => p.family === 'B');
    expect(base).toHaveLength(1);
    expect(base[0].thickness).toBe(3);
    // plates stand on top of the base plate
    const p0 = m.sliced.plates.find((pl) => pl.def.family === 'P')!;
    expect(p0.def.plane.origin[1]).toBeCloseTo(3, 6);
    expect(errors(m)).toEqual([]);
  });

  it('gives every plate tabs that drop through a slot and stop short of the underside', () => {
    const { m } = run(steel);
    const sb = m.sliced.steelBase!;
    const base = m.sliced.parts.find((p) => p.family === 'B')!;
    const plates = m.sliced.plates.filter((pl) => pl.def.family === 'P' && pl.parts.length);
    for (const pl of plates) {
      const n = sb.tabs.filter((t) => t.plateKey === pl.def.key).length;
      expect(n, pl.def.key).toBeGreaterThanOrEqual(2);
      // tabs reach 2.5 mm into the 3 mm base (0.5 mm weld recess)
      expect(Math.min(...pl.parts.map((p) => p.bbox.minY))).toBeCloseTo(-2.5, 3);
    }
    expect(sb.bare).toEqual([]);
    expect(base.shape[0].holes).toHaveLength(sb.tabs.length);
    // each tab's middle lies in a slot (a hole), not on the base plate's steel
    for (const t of sb.tabs) expect(pointInShape(t.at, base.shape), `${t.partId}`).toBe(false);
    // slot = plate thickness + clearance either side
    const hole = base.shape[0].holes[0];
    const xs = hole.map((q) => q[0]), ys = hole.map((q) => q[1]);
    const narrow = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    expect(narrow).toBeCloseTo(m.v.thickness + 2 * 0.15, 2);
  });

  it('twist tabs poke out underneath', () => {
    const { m } = run({ ...steel, steelFixing: 'twist', steelTwist: '8' });
    const p = m.sliced.parts.find((q) => q.family === 'P')!;
    expect(p.bbox.minY).toBeCloseTo(-11, 3);
  });

  it('keys the cross plates of a waffle grid too, clear of the crossings', () => {
    const { m } = run({ ...steel, sliceMode: 'waffle' });
    const sb = m.sliced.steelBase!;
    expect(sb.bare).toEqual([]);
    const keys = new Set(sb.tabs.map((t) => t.plateKey));
    for (const pl of m.sliced.plates.filter((q) => q.parts.length)) expect(keys.has(pl.def.key), pl.def.key).toBe(true);
    const base = m.sliced.parts.find((p) => p.family === 'B')!;
    expect(base.shape).toHaveLength(1);
  });

  it('cuts the base plate with the plates when they share a thickness', () => {
    const { m } = run(steel);
    expect(m.v.thickness).toBe(3);
    expect(m.nested.sheets.every((s) => s.thickness == null)).toBe(true);
    expect(m.bom.byMaterial.filter((g) => g.partCount)).toHaveLength(1);
  });

  it('puts a thicker base plate on its own sheet and prices it at its own thickness', () => {
    const { m } = run({ ...steel, thickness: '1.5' });
    const sheets = m.nested.sheets.filter((s) => s.thickness === 3);
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.flatMap((s) => s.placements.map((pl) => pl.id))).toEqual([m.sliced.steelBase!.partId]);
    expect(m.nested.unplaced).toEqual([]);
    const g = m.bom.byMaterial.find((x) => x.thickness === 3)!;
    expect(g.partCount).toBe(1);
    const est = estimateMix(m.bom, m.v.thickness);
    expect(est.lines.some((l) => /3 mm/.test(l.label))).toBe(true);
    const csv = cutListCsv(m.v, m.bom).split('\n');
    expect(csv.find((l) => l.startsWith(m.sliced.steelBase!.partId))!.split(',')[8]).toBe('3');
  });

  it('weld order spreads out: the first round tacks one end of every plate, middle outwards', () => {
    const { m } = run(steel);
    const sb = m.sliced.steelBase!;
    expect(sb.tabs.map((t) => t.order)).toEqual(sb.tabs.map((_, i) => i + 1));
    const plates = new Set(sb.tabs.map((t) => t.plateKey));
    const first = sb.tabs.slice(0, plates.size);
    expect(new Set(first.map((t) => t.plateKey)).size).toBe(plates.size);
    // starts near the middle of the base
    const x = (k: string) => m.sliced.plates.find((pl) => pl.def.key === k)!.def.plane.origin[0];
    const xs = [...plates].map(x);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    expect(Math.abs(x(sb.tackOrder[0]) - mid)).toBeLessThan(m.v.pitch * 1.01);
  });

  it('slots follow a plate moved by hand', () => {
    const p = project(steel);
    p.moves = { P3: { t: [0, 0, 12], q: [0, 0, 0, 1] } };
    const m = createPipeline()(p, assets);
    const base = m.sliced.parts.find((q) => q.family === 'B')!;
    const plate = m.sliced.plates.find((pl) => pl.def.key === 'P3')!;
    const part = plate.parts[0];
    const tab = m.sliced.steelBase!.tabs.find((t) => t.plateKey === 'P3')!;
    const w = planeToWorld(part.plane, (tab.u0 + tab.u1) / 2, -1);
    expect(pointInShape([w[0], -w[2]], base.shape)).toBe(false);
    expect(errors(m)).toEqual([]);
  });

  it('adds corner fixing holes', () => {
    const { m } = run({ ...steel, steelHoles: '4' });
    const base = m.sliced.parts.find((q) => q.family === 'B')!;
    expect(base.shape[0].holes).toHaveLength(m.sliced.steelBase!.tabs.length + 4);
  });

  it('puts a row of holes along the chosen edge at the chosen distance', () => {
    const { m } = run({ ...steel, steelHoles: 'edge', steelHoleCount: '3', steelHoleSide: 'left', steelHoleInset: '20' });
    const holes = fixingHoles(m.v, m.sliced.steelBase!.spec);
    expect(holes).toHaveLength(3);
    // left side is plan +y (the base is 300 wide)
    for (const h of holes) expect(h.at[1]).toBeCloseTo(150 - 20, 6);
    expect(holes.map((h) => h.at[0])).toEqual([expect.closeTo(-380, 6), expect.closeTo(0, 6), expect.closeTo(380, 6)]);
    const base = m.sliced.parts.find((q) => q.family === 'B')!;
    expect(base.shape[0].holes).toHaveLength(m.sliced.steelBase!.tabs.length + 3);
    const rows = run({ ...steel, steelHoles: 'rows', steelHoleCount: '2', steelHoleSide: 'back' }).m;
    expect(fixingHoles(rows.v, rows.sliced.steelBase!.spec)).toHaveLength(4);
  });

  it('cuts keyholes with the slot pointing at the top edge', () => {
    const { p, m } = run({ ...steel, steelHoles: 'edge', steelHoleCount: '2', steelHoleSide: 'back', steelHoleStyle: 'keyhole', steelKeyHead: '9', steelKeySlot: '4.5', steelKeyLength: '10' });
    const sb = m.sliced.steelBase!;
    const holes = fixingHoles(m.v, sb.spec);
    expect(holes).toHaveLength(2);
    for (const h of holes) {
      // back is +x: the round end sits 10 mm below the screw point, towards the front
      expect(h.head![0]).toBeCloseTo(h.at[0] - 10, 6);
      expect(h.head![1]).toBeCloseTo(h.at[1], 6);
    }
    const base = m.sliced.parts.find((q) => q.family === 'B')!;
    const key = base.shape[0].holes.find((ring) => ring.some(([x]) => x > 380))!;
    const xs = key.map((q) => q[0]);
    // round end Ø9 plus 10 mm of slot plus the slot's rounded top
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4.5 + 10 + 2.25, 0);
    // one clean opening: the head, the slot and the rounded top are all cut, overlaps included
    expect(base.shape[0].holes.filter((ring) => ring.some(([x]) => x > 380))).toHaveLength(2);
    for (const h of holes)
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const q: [number, number] = [h.head![0] + (h.at[0] - h.head![0]) * f, h.head![1]];
        expect(pointInShape(q, base.shape)).toBe(false);
      }
    expect(pointInShape([holes[0].head![0] - 4, holes[0].head![1]], base.shape)).toBe(false);
    expect(pointInShape([holes[0].at[0], holes[0].at[1] + 3], base.shape)).toBe(true);
    expect(m.sliced.warnings).toEqual([]);
    expect(buildPackHtmlChecked(p, m)).toContain('<b>Hang it.</b>');
  });

  it('zig-zag tabs let tightly packed plates keep a whole base plate', () => {
    const tight = { ...steel, thickness: '1.5', plateCount: '60', pitch: '3.4', steelStagger: false };
    const off = run(tight).m;
    expect(off.sliced.warnings.join(' ')).toMatch(/between neighbouring slots/);
    const on = run({ ...tight, steelZigzag: true }).m;
    expect(on.sliced.warnings.join(' ')).not.toMatch(/slots/);
    const tabs = on.sliced.steelBase!.tabs;
    const byPlate = new Map<string, number[]>();
    for (const tb of tabs) byPlate.set(tb.plateKey, [...(byPlate.get(tb.plateKey) ?? []), tb.u0]);
    expect(byPlate.size).toBeGreaterThan(50);
    // the base is one piece and every slot is its own hole
    const base = on.sliced.parts.find((q) => q.family === 'B')!;
    expect(base.shape.filter((ex) => (ex.depth ?? 0) === 0)).toHaveLength(1);
    expect(base.shape[0].holes).toHaveLength(tabs.length);
    expect(buildPackHtmlChecked(project({ ...tight, steelZigzag: true }), on)).toContain('The tabs zig-zag');
  });

  it('cuts the base round the plates: follow, wrap and fill the middle', () => {
    const radial = { ...steel, sliceMode: 'radial', steelHoles: '4' };
    const area = (m: ReturnType<typeof run>['m']) => m.sliced.parts.filter((q) => q.family === 'B').reduce((a, q) => a + q.area, 0);
    const rect = run(radial).m;
    const follow = run({ ...radial, baseOutline: 'follow' }).m;
    const wrap = run({ ...radial, baseOutline: 'wrap' }).m;
    expect(area(follow)).toBeLessThan(area(wrap));
    expect(area(wrap)).toBeLessThan(area(rect));
    for (const m of [follow, wrap]) {
      const sb = m.sliced.steelBase!;
      const base = m.sliced.parts.filter((q) => q.family === 'B');
      expect(base).toHaveLength(1);
      expect(m.sliced.warnings.filter((w) => /Steel base/.test(w))).toEqual([]);
      expect(errors(m)).toEqual([]);
      // every slot is a hole inside the plate, with the edge margin kept round it
      expect(base[0].shape[0].holes).toHaveLength(sb.tabs.length + 4);
      for (const tb of sb.tabs) expect(pointInShape(tb.at, base[0].shape), tb.partId).toBe(false);
      for (const tb of sb.tabs) expect(pointInShape(tb.at, sb.outline)).toBe(true);
      // the four fixing holes slid in onto steel
      const holes = fixingHoles(m.v, sb.spec, sb.outline, m.v.minFeature);
      expect(holes).toHaveLength(4);
      for (const h of holes) {
        expect(pointInShape(h.at, sb.outline)).toBe(true);
        expect(pointInShape(h.at, base[0].shape)).toBe(false);
      }
    }
    // a ring of plates: the middle is filled unless asked not to
    const ring = { ...steel, sliceMode: 'radial', radialHub: '120', baseOutline: 'follow', baseBridge: '40' };
    const filled = run(ring).m.sliced.steelBase!.outline;
    const open = run({ ...ring, baseFillMiddle: false }).m.sliced.steelBase!.outline;
    expect(filled.every((e) => e.holes.length === 0)).toBe(true);
    expect(pointInShape([0, 0], filled)).toBe(true);
    expect(pointInShape([0, 0], open)).toBe(false);
  });

  it('slides fixing holes clear of the plates, so a keyhole never hides under a plate', () => {
    // a wall piece with level plates every 29 mm right out to the top edge and across the base: a 20 mm
    // keyhole where Distance from edge puts it would have a plate standing over it
    const wall = { ...steel, mount: 'wall', strataOn: false, thickness: '1.5', endMargin: '6', sideMargin: '0', plateCount: '11', baseLength: '300', steelHoles: 'edge', steelHoleCount: '2', steelHoleSide: 'back', steelHoleStyle: 'keyhole' };
    for (const baseOutline of ['rect', 'follow']) {
      const { m } = run({ ...wall, baseOutline });
      const sb = m.sliced.steelBase!;
      expect(sb.fixings).toHaveLength(2);
      const plates = m.sliced.parts.filter((q) => q.family === 'P').map((q) => q.plane.origin[0]);
      for (const h of sb.fixings) {
        // the keyhole from the bottom of its round end to the top of its slot, and the head where it hangs
        const lo = h.head![0] - sb.spec.keyHead / 2, hi = h.at[0] + sb.spec.keyHead / 2;
        for (const x of plates) expect(x + m.v.thickness / 2 <= lo || x - m.v.thickness / 2 >= hi, `plate at ${x.toFixed(1)} over a hole ${lo.toFixed(1)}..${hi.toFixed(1)}`).toBe(true);
      }
      expect(m.sliced.warnings.filter((w) => /fixing hole/.test(w))).toEqual([]);
      // the base cut and the build pack use the same holes
      const base = m.sliced.parts.find((q) => q.family === 'B')!;
      for (const h of sb.fixings) expect(pointInShape(h.at, base.shape)).toBe(false);
    }
    // plates too close together for a keyhole between them: the holes are left out, and it says why
    const tight = run({ ...wall, plateCount: '22' }).m;
    expect(tight.sliced.steelBase!.fixings).toHaveLength(0);
    expect(tight.sliced.warnings.join(' ')).toMatch(/2 fixing holes found no steel clear of the plates/);
  });

  it('hangs a wall piece of level plates on keyholes between them, with no pinholes in its outline', async () => {
    // a ribcage sconce: level plates every 13 mm, ribs and hose segments with gaps between, the base cut round them
    const p = deserialize(readFileSync('test/fixtures/projects/vertebra-sconce.strata.json', 'utf8'));
    const m = createPipeline()(p, await loadAssets(p));
    const sb = m.sliced.steelBase!;
    expect(sb.fixings).toHaveLength(2);
    expect(m.sliced.warnings.filter((w) => /fixing hole/.test(w))).toEqual([]);
    expect(errors(m)).toEqual([]);
    // the outline's curves used to just miss each other and leave a 0.02 mm hole the checks flagged
    expect(m.issues.filter((i) => i.partId === sb.partId && i.type === 'hole')).toEqual([]);
    // the openings between the ribs stay open
    expect(sb.outline.flatMap((ex) => ex.holes).length).toBeGreaterThan(0);
  });

  it('warns when a hole sits too close to the edge', () => {
    const { m } = run({ ...steel, steelHoles: '4', steelHoleInset: '2' });
    expect(m.sliced.warnings.join(' ')).toMatch(/closer than .* to the edge/);
  });

  it('writes the base plate DXF, a weld map and welding steps', () => {
    const { p, m } = run({ ...steel, thickness: '1.5' });
    const files = unzipSync(buildZip(m, p));
    const id = m.sliced.steelBase!.partId;
    expect(Object.keys(files).some((n) => n.startsWith('laser/parts/') && n.endsWith(`/${id}.dxf`))).toBe(true);
    expect(Object.keys(files).some((n) => /^laser\/sheets\/steel-3mm\/sheet-01-cut\.dxf$/.test(n))).toBe(true);
    const html = buildPackHtmlChecked(p, m);
    expect(html).toContain('id="weld"');
    expect((html.match(/class="weld" data-order=/g) ?? []).length).toBe(m.sliced.steelBase!.tabs.length);
    expect(html).toContain('Weld the slots from the back');
    expect(html).not.toContain('Pour plan');
    expect(strFromU8(files['manifest.json'])).toBeTruthy();
  });

  it('hides the concrete settings and shows the steel ones', () => {
    const ev = evaluateParams({ ...newProject().params, baseMaterial: 'steel' });
    expect(ev.values.baseOn).toBe(false);
    expect(ev.values.steelBaseOn).toBe(true);
    // turning the whole base off turns the steel base off too
    expect(evaluateParams({ ...newProject().params, baseMaterial: 'steel', baseOn: false }).values.steelBaseOn).toBe(false);
  });
});

describe('tab layout', () => {
  const s = steelBaseSpec({ steelBaseOn: true, steelThickness: 3, steelFixing: 'weld', steelRecess: 0.5, steelTabLength: 15, steelTabPitch: 80, steelClearance: 0.15, steelEdge: 8, steelStagger: true, steelHoles: '0', steelHoleDia: 6.5 })!;
  it('puts two tabs near the ends of a short plate', () => {
    const t = tabLayout([[0, 60]], s, 4, false);
    expect(t.map((x) => x.c)).toEqual([7.5, 52.5]);
  });
  it('about one per pitch along a long plate, half a pitch over on the next', () => {
    const a = tabLayout([[0, 400]], s, 4, false).map((x) => x.c);
    const b = tabLayout([[0, 400]], s, 4, true).map((x) => x.c);
    expect(a.length).toBe(5);
    expect(b.length).toBe(4);
    for (const c of b) expect(Math.min(...a.map((x) => Math.abs(x - c)))).toBeGreaterThan(30);
  });
  it('zig-zag: neighbouring plates take alternate halves, never side by side', () => {
    for (const L of [60, 140, 400]) {
      const a = tabLayout([[0, L]], s, 4, false, 0);
      const b = tabLayout([[0, L]], s, 4, true, 1);
      expect(a.length).toBe(b.length);
      for (const x of a) for (const y of b) expect(Math.abs(x.c - y.c)).toBeGreaterThanOrEqual((x.len + y.len) / 2 + 2);
      for (const x of [...a, ...b]) {
        expect(x.c - x.len / 2).toBeGreaterThanOrEqual(0);
        expect(x.c + x.len / 2).toBeLessThanOrEqual(L);
      }
    }
    // a short plate: one tab each, one up and one down
    expect(tabLayout([[0, 60]], s, 4, false, 0).map((x) => x.c)).toEqual([15]);
    expect(tabLayout([[0, 60]], s, 4, false, 1).map((x) => x.c)).toEqual([45]);
  });
  it('orders every tab once', () => {
    const tabs = [0, 1, 2].flatMap((k) => [0, 1, 2].map((i) => ({ partId: `P${k}`, plateKey: `P${k}`, u0: i * 50, u1: i * 50 + 15, at: [k * 20, i * 50] as [number, number], dir: [0, 1] as [number, number], length: 15 })));
    const { tabs: out, plates } = weldOrder(tabs);
    expect(out).toHaveLength(9);
    expect(plates[0]).toBe('P1');
    expect(out.slice(0, 3).map((t) => t.plateKey).sort()).toEqual(['P0', 'P1', 'P2']);
  });
});
