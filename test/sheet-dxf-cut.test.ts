import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { sheetCutDxf, sheetEtchDxf, sheetFiles, buildZip, partDxf } from '../src/core/exporters';
import { dxfCutLength, dxfEntitySummary, listDxfEntities } from '../src/core/dxf';
import { offset, shapeArea, signedArea, type Path, type Vec2 } from '../src/core/geom2d';
import { unzipSync, strFromU8 } from 'fflate';
import { GABRIEL_PARAMS, sliverFrontGray, sliverSideGray } from './image-sliver-fixture';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

describe('sheet DXF cut-only + LWPOLYLINE/CIRCLE', () => {
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
    expect(ents.every((e) => e.layer === 'CUT')).toBe(true);
    expect(ents.some((e) => e.type === 'LWPOLYLINE' || e.type === 'CIRCLE')).toBe(true);
    expect(ents.some((e) => e.type === 'SPLINE')).toBe(false);
    // no 1250×2500 sheet-border rectangle (that would be four 2500/1250 LINEs)
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
    expect(Math.abs(cutLen - kerfPerim)).toBeLessThan(2);
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
    expect(readme).not.toMatch(/1250.×.2500 sheet border/i);
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
});

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
