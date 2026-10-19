import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, newProject } from '../src/core/project';
import { sheetCutDxf, sheetEtchDxf, sheetFiles, buildZip, partDxf, segsAsCircle, fitShape } from '../src/core/exporters';
import { DxfWriter, LAYERS, dxfCutCircles, dxfCutLwPolylines, dxfCutLength, dxfCutStructure, dxfEntitySummary, dxfHasSheetBorder, listDxfEntities } from '../src/core/dxf';
import { circlePath, offset, pointInPath, rect, shapeArea, signedArea, type Path, type Vec2 } from '../src/core/geom2d';
import { fitArcs } from '../src/core/arcs';
import { unzipSync, strFromU8 } from 'fflate';
import { GABRIEL_PARAMS, sliverFrontGray, sliverSideGray } from './image-sliver-fixture';

const COMMISSARY = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/commissary');
const COMMISSARY_FILES = ['coarse-cut-only.dxf', 'medium-cut-only.dxf', 'fine-cut-only.dxf'] as const;

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

describe('sheet DXF cut-only + LWPOLYLINE/CIRCLE', () => {
  it('flags a 1250×2500 rectangle as a sheet border', () => {
    const lines = new DxfWriter([LAYERS.CUT]);
    lines.line('CUT', 0, 0, 2500, 0);
    lines.line('CUT', 2500, 0, 2500, 1250);
    lines.line('CUT', 2500, 1250, 0, 1250);
    lines.line('CUT', 0, 1250, 0, 0);
    expect(dxfHasSheetBorder(lines.toString())).toBe(true);
    const poly = new DxfWriter([LAYERS.CUT]);
    poly.lwpolyline(
      'CUT',
      [
        { kind: 'line', a: [0, 0], b: [2500, 0] },
        { kind: 'line', a: [2500, 0], b: [2500, 1250] },
        { kind: 'line', a: [2500, 1250], b: [0, 1250] },
        { kind: 'line', a: [0, 1250], b: [0, 0] },
      ],
      true,
    );
    expect(dxfHasSheetBorder(poly.toString())).toBe(true);
  });

  it('emits LWPOLYLINE and CIRCLE, never SPLINE, on part DXFs', () => {
    const m = createPipeline()(newProject(), assets);
    const withHole = m.sliced.parts.find((p) => p.shape[0].holes.length > 0);
    expect(withHole).toBeTruthy();
    const text = partDxf(withHole!, m.v);
    const sum = dxfEntitySummary(text);
    expect(sum.types.LWPOLYLINE).toBeGreaterThan(0);
    expect(sum.types.CIRCLE).toBeGreaterThan(0);
    expect(sum.types.POLYLINE).toBeUndefined();
    expect(sum.types.SPLINE).toBeUndefined();
    expect(text).toContain('AC1015');
  });

  it('cut sheet has no border rectangle and no etch, cut length = part perimeters', () => {
    const m = createPipeline()(newProject(), assets);
    expect(m.nested.sheets.length).toBeGreaterThan(0);
    const text = sheetCutDxf(m, 0);
    const ents = listDxfEntities(text);
    const st = dxfCutStructure(text);
    expect(st.cutOnly).toBe(true);
    expect(st.hasBorder).toBe(false);
    expect(st.hasEtch).toBe(false);
    expect(st.hasForbidden).toBe(false);
    expect(st.extraTypes).toEqual([]);
    expect(ents.every((e) => e.layer === 'CUT')).toBe(true);
    expect(ents.some((e) => e.type === 'LWPOLYLINE' || e.type === 'CIRCLE')).toBe(true);
    expect(ents.some((e) => e.type === 'SPLINE')).toBe(false);
    const lines = ents.filter((e) => e.type === 'LINE');
    expect(lines).toHaveLength(0);
    expect(text).not.toContain('\nETCH\n');
    expect(text).not.toContain('\nSHEET\n');

    const sheet = m.nested.sheets[0];
    const parts = m.sliced.parts.filter((p) => sheet.placements.some((pl) => pl.id === p.id));
    const cutLen = dxfCutLength(text);
    const perimeters = parts.reduce((a, p) => a + p.perimeter, 0);
    // kerf offset changes length slightly; still within a few millimetres per part
    expect(Math.abs(cutLen - perimeters)).toBeLessThan(parts.length * 8 + 20);
    // with kerf-compensated perimeters the match is tight
    const kerfPerim = parts.reduce((a, p) => {
      const off = offset(p.shape, m.v.kerf / 2);
      return a + off.reduce((s, e) => {
        let L = 0;
        const ring = (q: Path) => {
          for (let i = 0; i < q.length; i++) {
            const b = q[(i + 1) % q.length];
            L += Math.hypot(b[0] - q[i][0], b[1] - q[i][1]);
          }
        };
        ring(e.outer);
        e.holes.forEach(ring);
        return s + L;
      }, 0);
    }, 0);
    // each round hole is written as a CIRCLE at its fitted radius, which can sit ~0.01 mm off
    // the polygon Clipper made of it (0.05 mm of perimeter)
    const circles = ents.filter((e) => e.type === 'CIRCLE').length;
    expect(Math.abs(cutLen - kerfPerim)).toBeLessThan(2 + 0.1 * circles);
  });

  it('each nested sheet outline set matches the parts list in count and area', () => {
    const m = createPipeline()(newProject(), assets);
    m.nested.sheets.forEach((_, si) => {
      const text = sheetCutDxf(m, si);
      const sum = dxfEntitySummary(text);
      const sheet = m.nested.sheets[si];
      const parts = m.sliced.parts.filter((p) => sheet.placements.some((pl) => pl.id === p.id));
      const expectedContours = parts.reduce((a, p) => a + 1 + p.shape[0].holes.length, 0);
      const got = (sum.types.LWPOLYLINE ?? 0) + (sum.types.CIRCLE ?? 0) + (sum.types.POLYLINE ?? 0);
      expect(got, `sheet ${si} contour count`).toBe(expectedContours);

      // area from fitted contours (kerf-compensated) vs DXF closed paths
      const expectedArea = parts.reduce((a, p) => a + shapeArea(offset(p.shape, m.v.kerf / 2)), 0);
      expect(Math.abs(fitAndAreaFromDxf(text) - expectedArea)).toBeLessThan(Math.max(5, expectedArea * 0.02));
    });
  });

  it('zip names cut/etch files and README explains them', () => {
    const m = createPipeline()(newProject(), assets);
    const files = unzipSync(buildZip(m, newProject()));
    const names = Object.keys(files);
    expect(names).toContain('laser/sheets/sheet-01-cut.dxf');
    expect(names).toContain('manifest.json');
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    expect(manifest.plateCount).toBe(m.bom.plateCount);
    expect(manifest.partCount).toBe(m.bom.partCount);
    expect(manifest.partCount).toBe(m.sliced.parts.length);
    expect(names).toContain('README.txt');
    const readme = strFromU8(files['README.txt']);
    expect(readme).toMatch(/CUT ONLY/);
    expect(readme).toMatch(/sheet-NN-cut\.dxf/);
    expect(readme).toMatch(/sheet-NN-etch\.dxf/);
    expect(readme).toMatch(/no 1250×2500 sheet border/i);
    const etch = sheetEtchDxf(m, 0);
    if (etch) {
      expect(names).toContain('laser/sheets/sheet-01-etch.dxf');
      const eSum = dxfEntitySummary(etch);
      expect(eSum.layers.CUT).toBeUndefined();
      expect(eSum.layers.ETCH || eSum.layers.ENGRAVE).toBeTruthy();
    }
    expect(Object.keys(sheetFiles(m)).some((n) => n.endsWith('-cut.dxf'))).toBe(true);
  });

  it('Gabriel nested sheets still match the (cleaned) parts list', () => {
    const p = newProject();
    p.params = { ...p.params, ...GABRIEL_PARAMS, fragmentMode: 'auto' };
    const m = createPipeline()(p, { ...assets, frontImg: sliverFrontGray(), sideImg: sliverSideGray() });
    expect(m.sliced.parts).toHaveLength(6);
    m.nested.sheets.forEach((_, si) => {
      const text = sheetCutDxf(m, si);
      const sum = dxfEntitySummary(text);
      const sheet = m.nested.sheets[si];
      const parts = m.sliced.parts.filter((q) => sheet.placements.some((pl) => pl.id === q.id));
      const expected = parts.reduce((a, q) => a + 1 + q.shape[0].holes.length, 0);
      const got = (sum.types.LWPOLYLINE ?? 0) + (sum.types.CIRCLE ?? 0);
      expect(got).toBe(expected);
      const partArea = parts.reduce((a, q) => a + q.area, 0);
      const dxfArea = fitAndAreaFromDxf(text);
      expect(dxfArea).toBeGreaterThan(partArea * 0.9);
      expect(dxfArea).toBeLessThan(partArea * 1.15);
    });
  });

  it('matches Commissary cut-only refs (CUT layer, closed LWPOLYLINE, no border/etch)', () => {
    const refs = COMMISSARY_FILES.map((name) => {
      const text = readFileSync(join(COMMISSARY, name), 'utf8');
      return { name, text, st: dxfCutStructure(text) };
    });
    for (const { name, st } of refs) {
      expect(st.typeNames, name).toEqual(['LWPOLYLINE']);
      expect(st.layers, name).toEqual(['CUT']);
      expect(st.cutOnly, name).toBe(true);
      expect(st.hasBorder, name).toBe(false);
      expect(st.hasEtch, name).toBe(false);
      expect(st.hasForbidden, name).toBe(false);
    }

    const m = createPipeline()(newProject(), assets);
    const ours = sheetCutDxf(m, 0);
    const st = dxfCutStructure(ours);
    expect(st.layers).toEqual(['CUT']);
    expect(st.cutOnly).toBe(true);
    expect(st.hasBorder).toBe(false);
    expect(st.hasEtch).toBe(false);
    expect(st.hasForbidden).toBe(false);
    expect(st.extraTypes).toEqual([]);
    // Commissary tessellates round holes as LWPOLYLINE; we keep CIRCLE for CAM.
    const extraVsRef = st.typeNames.filter((t) => t !== 'LWPOLYLINE');
    expect(extraVsRef.every((t) => t === 'CIRCLE')).toBe(true);

    const report = commissaryDiffReport(refs.map((r) => ({ name: r.name, st: r.st })), st);
    expect(report).toMatch(/Commissary coarse-cut-only\.dxf: LWPOLYLINE \d+ on CUT/);
    expect(report).toMatch(/ours extra vs Commissary: CIRCLE|ours extra vs Commissary: \(none\)/);
    expect(report).toMatch(/both: CUT-only, no sheet border, no ETCH\/SHEET\/LINE\/POLYLINE\/SPLINE/);
  });

  it('does not treat a rectangle or mixed blob as a CIRCLE', () => {
    const tol = 0.1;
    const square = fitArcs(rect(0, 0, 40, 40)[0].outer, 0.05);
    expect(segsAsCircle(square, tol)).toBeNull();
    const blob = fitShape([{ outer: circlePath(0, 0, 50), holes: [rect(-20, -8, 20, 8)[0].outer] }], {
      kerf: 0.2,
      arcTolerance: 0.05,
      dxfMode: 'polyline',
    } as never);
    const hole = blob.find((c) => c.hole);
    expect(hole).toBeTruthy();
    expect(segsAsCircle(hole!.segs, tol)).toBeNull();
    const round = fitArcs(circlePath(10, 20, 5), 0.05);
    expect(segsAsCircle(round, tol)?.r).toBeGreaterThan(4);
  });

  it('every CUT CIRCLE lies inside exactly one nested part outline', () => {
    const check = (m: ReturnType<ReturnType<typeof createPipeline>>) => {
      m.nested.sheets.forEach((_, si) => {
        const text = sheetCutDxf(m, si);
        const circles = dxfCutCircles(text);
        const polys = dxfCutLwPolylines(text);
        const areas = polys.map((p) => Math.abs(signedArea(p)));
        const outers = polys.filter((poly, i) => !polys.some((other, j) => j !== i && areas[j] > areas[i] && pointInPath(poly[0], other)));
        for (const c of circles) {
          const owners: number[] = [];
          outers.forEach((outer, i) => {
            const samples: Vec2[] = [[c.cx, c.cy]];
            for (let k = 0; k < 16; k++) {
              const a = (k / 16) * Math.PI * 2;
              samples.push([c.cx + c.r * Math.cos(a), c.cy + c.r * Math.sin(a)]);
            }
            if (samples.every((p) => pointInPath(p, outer))) owners.push(i);
          });
          expect(owners, `sheet ${si} CIRCLE r=${c.r.toFixed(2)} at ${c.cx.toFixed(1)},${c.cy.toFixed(1)}`).toEqual([owners[0]]);
          expect(owners).toHaveLength(1);
        }
      });
    };
    check(createPipeline()(newProject(), assets));
    const p = newProject();
    p.params = { ...p.params, ...GABRIEL_PARAMS, fragmentMode: 'auto' };
    check(createPipeline()(p, { ...assets, frontImg: sliverFrontGray(), sideImg: sliverSideGray() }));
  });
});

function commissaryDiffReport(
  refs: { name: string; st: ReturnType<typeof dxfCutStructure> }[],
  ours: ReturnType<typeof dxfCutStructure>,
): string {
  const lines = ['Commissary cut-only vs Strata sheet-NN-cut.dxf', ''];
  for (const { name, st } of refs) {
    const n = st.types.LWPOLYLINE ?? 0;
    lines.push(`Commissary ${name}: LWPOLYLINE ${n} on CUT; types=${JSON.stringify(st.types)}; layers=${st.layers.join(',')}; border=${st.hasBorder}; etch=${st.hasEtch}`);
  }
  lines.push(`Strata cut: types=${JSON.stringify(ours.types)}; layers=${ours.layers.join(',')}; border=${ours.hasBorder}; etch=${ours.hasEtch}`);
  const extra = ours.typeNames.filter((t) => t !== 'LWPOLYLINE');
  lines.push(`ours extra vs Commissary: ${extra.length ? extra.join(', ') : '(none)'} (CIRCLE = round holes; Commissary tessellates those as LWPOLYLINE)`);
  lines.push('both: CUT-only, no sheet border, no ETCH/SHEET/LINE/POLYLINE/SPLINE');
  return lines.join('\n') + '\n';
}

function bulgePoints(p1: Vec2, p2: Vec2, b: number): Vec2[] {
  if (Math.abs(b) < 1e-12) return [p1];
  const th = 4 * Math.atan(b);
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const L = Math.hypot(dx, dy);
  const h = L / 2 / Math.tan(th / 2);
  const c: Vec2 = [(p1[0] + p2[0]) / 2 - (dy / L) * h, (p1[1] + p2[1]) / 2 + (dx / L) * h];
  const r = Math.hypot(p1[0] - c[0], p1[1] - c[1]);
  const a0 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
  const n = Math.max(4, Math.ceil(Math.abs(th) * r / 0.4));
  const pts: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const a = a0 + (th * k) / n;
    pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return pts;
}

function fitAndAreaFromDxf(text: string): number {
  const lines = text.split(/\r?\n/);
  const P: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) P.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  let i = P.findIndex(([c, v], k) => c === 2 && v === 'ENTITIES' && P[k - 1]?.[1] === 'SECTION');
  i++;
  let area = 0;
  while (i < P.length && !(P[i][0] === 0 && P[i][1] === 'ENDSEC')) {
    const type = P[i][1];
    const f: Record<number, string> = {};
    let k = i + 1;
    while (k < P.length && P[k][0] !== 0) {
      f[P[k][0]] = P[k][1];
      k++;
    }
    if ((f[8] ?? '0') !== 'CUT') {
      i = k;
      continue;
    }
    if (type === 'CIRCLE') {
      const r = +f[40];
      area -= Math.PI * r * r;
    } else if (type === 'LWPOLYLINE') {
      const verts: { p: Vec2; b: number }[] = [];
      let x = 0, y = 0, bulge = 0, have = false;
      let j = i + 1;
      const flush = () => {
        if (have) verts.push({ p: [x, y], b: bulge });
        bulge = 0;
        have = false;
      };
      while (j < P.length && P[j][0] !== 0) {
        if (P[j][0] === 10) {
          flush();
          x = +P[j][1];
          have = true;
        } else if (P[j][0] === 20) y = +P[j][1];
        else if (P[j][0] === 42) bulge = +P[j][1];
        j++;
      }
      flush();
      const pts: Vec2[] = [];
      for (let n = 0; n < verts.length; n++) pts.push(...bulgePoints(verts[n].p, verts[(n + 1) % verts.length].p, verts[n].b));
      area += signedArea(pts);
      i = j;
      continue;
    }
    i = k;
  }
  return Math.abs(area);
}

describe('sheet DXF cut on a cloud nest (plan PR 10)', () => {
  it('every sheet of the server nest holds each part once, cut-only, at the right area', async () => {
    const { runNestJob } = await import('../src/cloudJobs');
    const { loadAssets } = await import('../src/packNode');
    const { nestClearanceProblems } = await import('../src/core/nestCheck');
    const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/projects/buttermere-terrarium-77.strata.json');
    const text = readFileSync(fixture, 'utf8');
    const saved = await runNestJob({ kind: 'nest', engine: 'test', input: { sha: '0'.repeat(64), parts: 1 }, budget: 'default' }, text, { maxTries: 8 });
    const project = { ...deserialize(text), nest: saved };
    const m = createPipeline()(project, await loadAssets(project));
    expect(m.nested.source).toBe('saved');
    expect(m.nested.sheets.some((s) => s.placements.some((pl) => (pl.turn ?? 0) >= 2))).toBe(true);
    expect(nestClearanceProblems(m.sliced.parts, m.nested, m.v.partSpacing)).toEqual([]);
    let placed = 0;
    m.nested.sheets.forEach((sheet, si) => {
      const text = sheetCutDxf(m, si);
      const st = dxfCutStructure(text);
      expect(st.cutOnly).toBe(true);
      expect(st.hasBorder).toBe(false);
      const parts = m.sliced.parts.filter((p) => sheet.placements.some((pl) => pl.id === p.id));
      placed += parts.length;
      const sum = dxfEntitySummary(text);
      const expectedContours = parts.reduce((a, p) => a + 1 + p.shape[0].holes.length, 0);
      expect((sum.types.LWPOLYLINE ?? 0) + (sum.types.CIRCLE ?? 0) + (sum.types.POLYLINE ?? 0), `sheet ${si} contours`).toBe(expectedContours);
      const expectedArea = parts.reduce((a, p) => a + shapeArea(offset(p.shape, m.v.kerf / 2)), 0);
      expect(Math.abs(fitAndAreaFromDxf(text) - expectedArea)).toBeLessThan(Math.max(5, expectedArea * 0.02));
      // every contour lies on the sheet
      for (const e of listDxfEntities(text)) expect(e.layer).toBe('CUT');
    });
    expect(placed).toBe(m.sliced.parts.length);
  }, 180_000);
});
