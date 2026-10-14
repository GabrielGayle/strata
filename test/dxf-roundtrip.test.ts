// Reads the DXF text back the way a CAD program does (POLYLINE bulges, LINE,
// ARC) and checks the result against the true part outlines. This is what
// Illustrator / LightBurn will draw, so it must match within the arc tolerance.
import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, newProject, PRESETS } from '../src/core/project';
import { mouldPartDxf, partDxf, sheetDxf, unfoldDxf } from '../src/core/exporters';
import { offset, type Path, type Vec2 } from '../src/core/geom2d';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

interface Contour {
  layer: string;
  pts: Vec2[]; // densely sampled
}

function pairs(text: string): [number, string][] {
  const l = text.split(/\r?\n/);
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < l.length; i += 2) out.push([parseInt(l[i].trim(), 10), l[i + 1].trim()]);
  return out;
}

function arcPoints(c: Vec2, r: number, a0: number, sweep: number): Vec2[] {
  const n = Math.max(4, Math.ceil(Math.abs(sweep) * r / 0.5));
  const pts: Vec2[] = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return pts;
}

/** Dense points for a bulged segment p1→p2 (DXF semantics: bulge = tan(sweep/4), + = CCW). */
function bulgeSeg(p1: Vec2, p2: Vec2, b: number): Vec2[] {
  if (Math.abs(b) < 1e-12) return [p1, p2];
  const th = 4 * Math.atan(b);
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const L = Math.hypot(dx, dy);
  const h = L / 2 / Math.tan(th / 2);
  const c: Vec2 = [(p1[0] + p2[0]) / 2 - (dy / L) * h, (p1[1] + p2[1]) / 2 + (dx / L) * h];
  const r = Math.hypot(p1[0] - c[0], p1[1] - c[1]);
  return arcPoints(c, r, Math.atan2(p1[1] - c[1], p1[0] - c[0]), th);
}

function readDxf(text: string): Contour[] {
  const P = pairs(text);
  const out: Contour[] = [];
  let i = P.findIndex(([c, v], k) => c === 2 && v === 'ENTITIES' && P[k - 1]?.[1] === 'SECTION');
  expect(i).toBeGreaterThan(0);
  i++;
  const fields = (start: number) => {
    const f: Record<number, string> = {};
    let k = start + 1;
    while (k < P.length && P[k][0] !== 0) {
      f[P[k][0]] = P[k][1];
      k++;
    }
    return { f, next: k };
  };
  while (i < P.length && !(P[i][0] === 0 && P[i][1] === 'ENDSEC')) {
    const type = P[i][1];
    const { f, next } = fields(i);
    if (type === 'POLYLINE') {
      const closed = (parseInt(f[70] ?? '0', 10) & 1) === 1;
      const verts: { p: Vec2; b: number }[] = [];
      let k = next;
      while (P[k][1] === 'VERTEX') {
        const vf = fields(k);
        verts.push({ p: [+vf.f[10], +vf.f[20]], b: +(vf.f[42] ?? 0) });
        k = vf.next;
      }
      expect(P[k][1]).toBe('SEQEND');
      const pts: Vec2[] = [];
      const n = closed ? verts.length : verts.length - 1;
      for (let j = 0; j < n; j++) pts.push(...bulgeSeg(verts[j].p, verts[(j + 1) % verts.length].p, verts[j].b));
      out.push({ layer: f[8], pts });
      i = fields(k).next;
      continue;
    }
    if (type === 'LINE') out.push({ layer: f[8], pts: [[+f[10], +f[20]], [+f[11], +f[21]]] });
    if (type === 'ARC') {
      const a0 = (+f[50] * Math.PI) / 180;
      let a1 = (+f[51] * Math.PI) / 180;
      while (a1 <= a0) a1 += 2 * Math.PI;
      out.push({ layer: f[8], pts: arcPoints([+f[10], +f[20]], +f[40], a0, a1 - a0) });
    }
    if (type === 'SPLINE' || type === 'ELLIPSE' || type === 'TEXT') throw new Error(`Unexpected ${type}`);
    i = next;
  }
  return out;
}

function segDist(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function distToPaths(p: Vec2, paths: Path[], closed: boolean) {
  let best = Infinity;
  for (const q of paths) {
    const n = closed ? q.length : q.length - 1;
    for (let k = 0; k < n; k++) best = Math.min(best, segDist(p, q[k], q[(k + 1) % q.length]));
  }
  return best;
}

/** Max deviation both ways between the DXF cut geometry and the expected outlines. */
function deviation(dxf: Contour[], expected: Path[]) {
  const cut = dxf.filter((c) => c.layer === 'CUT').map((c) => c.pts);
  let out = 0;
  for (const c of cut) for (const p of c) out = Math.max(out, distToPaths(p, expected, true));
  let back = 0;
  for (const q of expected) for (const p of q) back = Math.max(back, distToPaths(p, cut, false));
  return { out, back, contours: cut.length };
}

describe('DXF round trip', () => {
  for (const preset of PRESETS) {
    it(`plate DXFs match their outlines: ${preset.name}`, () => {
      const m = createPipeline()(applyPreset(newProject(), preset), assets);
      const v = m.v;
      const tol = v.arcTolerance + 0.002;
      const parts = m.sliced.parts.filter((_, i) => i % 4 === 0 || i === m.sliced.parts.length - 1);
      for (const mode of ['polyline', 'lines'] as const) {
        for (const part of parts) {
          const dxf = readDxf(partDxf(part, { ...v, dxfMode: mode }));
          const sx = part.bbox.minX - v.kerf, sy = part.bbox.minY - v.kerf;
          const expected = offset(part.shape, v.kerf / 2).flatMap((e) => [e.outer, ...e.holes]).map((p) => p.map(([x, y]) => [x - sx, y - sy] as Vec2));
          const d = deviation(dxf, expected);
          expect(d.out, `${part.id} ${mode}: DXF strays from outline`).toBeLessThan(tol);
          expect(d.back, `${part.id} ${mode}: outline not covered by DXF`).toBeLessThan(tol);
          if (mode === 'polyline') expect(d.contours).toBe(expected.length);
        }
      }
    });
  }

  it('nested sheets keep every part inside its placement', () => {
    const m = createPipeline()(newProject(), assets);
    const v = m.v;
    m.nested.sheets.forEach((sheet, si) => {
      const cut = readDxf(sheetDxf(m, si)).filter((c) => c.layer === 'CUT');
      const parts = m.sliced.parts.filter((p) => sheet.placements.some((pl) => pl.id === p.id));
      const expectedContours = parts.reduce((a, p) => a + 1 + p.shape[0].holes.length, 0);
      expect(cut.length).toBe(expectedContours);
      for (const c of cut) {
        const xs = c.pts.map((p) => p[0]), ys = c.pts.map((p) => p[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const pl = sheet.placements.find((q) => cx >= q.x - 1 && cx <= q.x + q.w + 1 && cy >= q.y - 1 && cy <= q.y + q.h + 1);
        expect(pl, 'contour belongs to a placement').toBeTruthy();
        const pad = v.kerf + v.arcTolerance + 0.01;
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(pl!.x - pad);
        expect(Math.max(...xs)).toBeLessThanOrEqual(pl!.x + pl!.w + pad);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(pl!.y - pad);
        expect(Math.max(...ys)).toBeLessThanOrEqual(pl!.y + pl!.h + pad);
      }
    });
  });

  it('mould and unfold DXFs match their outlines', () => {
    const m = createPipeline()(newProject(), assets);
    const v = m.v;
    const tol = v.arcTolerance + 0.002;
    for (const mp of m.moulds.parts.filter((_, i) => i % 5 === 0)) {
      const xs = mp.shape[0].outer.map((p) => p[0]), ys = mp.shape[0].outer.map((p) => p[1]);
      const sx = Math.min(...xs), sy = Math.min(...ys);
      const expected = mp.shape.flatMap((e) => [e.outer, ...e.holes]).map((p) => p.map(([x, y]) => [x - sx, y - sy] as Vec2));
      const d = deviation(readDxf(mouldPartDxf(mp, v)), expected);
      expect(d.out, mp.id).toBeLessThan(tol);
      expect(d.back, mp.id).toBeLessThan(tol);
    }
    const u = createPipeline()(applyPreset(newProject(), PRESETS[1]), assets).unfolded; // cone: developable
    expect(u.developable).toBe(true);
    const pieces = [...u.pieces, ...u.caps];
    const expected = pieces.flatMap((p) => offset([{ outer: p.outline, holes: [] }], v.kerf / 2).map((e) => e.outer));
    const d = deviation(readDxf(unfoldDxf(pieces, v)), expected);
    expect(d.out).toBeLessThan(tol);
    expect(d.back).toBeLessThan(tol);
  });
});
