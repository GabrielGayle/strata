import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { buildPackHtmlChecked } from '../src/core/exporters';
import { baseGeometry, baseVolumeBetween } from '../src/core/base';
import { pointInShape, shapeArea } from '../src/core/geom2d';

const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };

function project(params: Record<string, string | boolean>) {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', mouldOn: true, ...params };
  return p;
}
const run = (params: Record<string, string | boolean>) => {
  const p = project(params);
  return { p, m: createPipeline()(p, assets) };
};
const errors = (m: ReturnType<typeof run>['m']) => m.issues.filter((i) => i.severity === 'error').map((i) => i.message);

/** Signed volume of a triangle mesh: positive when its faces point out. */
function meshVolume(g: THREE.BufferGeometry): number {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let vol = 0;
  for (let i = 0; i < n; i += 3) {
    const at = (k: number) => (idx ? idx.getX(i + k) : i + k);
    a.fromBufferAttribute(pos, at(0));
    b.fromBufferAttribute(pos, at(1));
    c.fromBufferAttribute(pos, at(2));
    vol += a.dot(b.clone().cross(c)) / 6;
  }
  return vol;
}

describe('concrete base that follows the plates', () => {
  const radial = { sliceMode: 'radial', baseEdgeChamfer: '6' };

  it('stays a rectangle unless asked', () => {
    expect(run(radial).m.sliced.baseOutline ?? null).toBeNull();
  });

  it('casts less concrete, round every plate, with outward faces and matching moulds', () => {
    const rect = run(radial);
    const follow = run({ ...radial, baseOutline: 'follow' });
    const wrap = run({ ...radial, baseOutline: 'wrap' });
    for (const { p, m } of [follow, wrap]) {
      const out = m.sliced.baseOutline!;
      expect(out.length).toBe(1);
      expect(errors(m)).toEqual([]);
      // every plate's foot is inside the concrete
      for (const part of m.sliced.parts.filter((q) => q.family === 'P')) {
        const P = part.plane;
        const u = (part.bbox.minX + part.bbox.maxX) / 2;
        expect(pointInShape([P.origin[0] + P.u[0] * u, -(P.origin[2] + P.u[2] * u)], out), part.id).toBe(true);
      }
      // the mesh is closed the right way round and holds the same concrete the pour plan does
      const g = baseGeometry(m.v, out);
      const vol = meshVolume(g);
      expect(vol).toBeGreaterThan(0);
      expect(vol / baseVolumeBetween(m.v, 0, m.v.baseHeight, out)).toBeCloseTo(1, 1);
      // the mould rings are cut to the same outline
      const cavity = (mm: typeof m) => {
        // the floor is the whole board; the bottom ring is that board less the cavity
        const floor = mm.moulds.parts.filter((q) => q.id === 'MB-FLOOR').reduce((a, q) => a + q.area, 0);
        return floor - mm.moulds.parts.filter((q) => q.id.startsWith('MB-L01')).reduce((a, q) => a + q.area, 0);
      };
      expect(cavity(m) / shapeArea(out)).toBeCloseTo(1, 1);
      expect(cavity(m)).toBeLessThan(cavity(rect.m));
      expect(buildPackHtmlChecked(p, m)).toContain('<svg');
    }
    expect(follow.m.bom.concreteMass).toBeLessThan(wrap.m.bom.concreteMass);
    expect(wrap.m.bom.concreteMass).toBeLessThan(rect.m.bom.concreteMass);
    expect(follow.m.pour.rows.reduce((a, r) => a + r.volume, 0)).toBeLessThan(rect.m.pour.rows.reduce((a, r) => a + r.volume, 0));
  });
});
