// Plane sections of a triangle mesh. Each plate's cut comes from intersecting
// the 3D form with the plate's plane: a pure 2D outline, never a bevel.
import type { IndexedMesh } from './forms';
import { signedArea, union, type Path, type Shape } from './geom2d';

export type V3 = [number, number, number];

export interface Plane {
  origin: V3;
  normal: V3; // unit
  u: V3; // unit, in-plane
  v: V3; // unit, in-plane (up)
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface Prepared {
  mesh: IndexedMesh;
  normal: V3;
  vd: Float32Array; // vertex distance along normal
  triMin: Float32Array;
  triMax: Float32Array;
}

const prepCache = new WeakMap<IndexedMesh, Map<string, Prepared>>();

function prepare(mesh: IndexedMesh, normal: V3): Prepared {
  let m = prepCache.get(mesh);
  if (!m) {
    m = new Map();
    prepCache.set(mesh, m);
  }
  const key = normal.map((x) => x.toFixed(6)).join(',');
  let p = m.get(key);
  if (p) return p;
  const { pos, index, vertexCount } = mesh;
  const vd = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) vd[i] = pos[i * 3] * normal[0] + pos[i * 3 + 1] * normal[1] + pos[i * 3 + 2] * normal[2];
  const nt = index.length / 3;
  const triMin = new Float32Array(nt);
  const triMax = new Float32Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = vd[index[t * 3]], b = vd[index[t * 3 + 1]], c = vd[index[t * 3 + 2]];
    triMin[t] = Math.min(a, b, c);
    triMax[t] = Math.max(a, b, c);
  }
  p = { mesh, normal, vd, triMin, triMax };
  if (m.size > 64) m.clear();
  m.set(key, p);
  return p;
}

/** Closed loops (in plane u/v coordinates) where the mesh crosses the plane. */
export function sectionLoops(mesh: IndexedMesh, plane: Plane): Path[] {
  const prep = prepare(mesh, plane.normal);
  const { pos, index } = mesh;
  let d0 = dot(plane.origin, plane.normal);
  const EPS = 1e-5;
  const nt = index.length / 3;

  // nudge the plane off any vertex to avoid degenerate cases
  for (let tries = 0; tries < 4; tries++) {
    let hit = false;
    for (let t = 0; t < nt && !hit; t++) {
      if (prep.triMin[t] > d0 + EPS || prep.triMax[t] < d0 - EPS) continue;
      for (let k = 0; k < 3; k++) if (Math.abs(prep.vd[index[t * 3 + k]] - d0) < EPS) hit = true;
    }
    if (!hit) break;
    d0 += 3.7e-5;
  }

  const pointOnEdge = new Map<number, [number, number]>();
  const segs: [number, number][] = [];
  const nv = mesh.vertexCount;
  const edgeKey = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const [ox, oy, oz] = plane.origin;
  const addPoint = (a: number, b: number) => {
    const k = edgeKey(a, b);
    if (!pointOnEdge.has(k)) {
      const da = prep.vd[a] - d0;
      const db = prep.vd[b] - d0;
      const t = da / (da - db);
      const x = pos[a * 3] + (pos[b * 3] - pos[a * 3]) * t - ox;
      const y = pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * t - oy;
      const z = pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * t - oz;
      pointOnEdge.set(k, [x * plane.u[0] + y * plane.u[1] + z * plane.u[2], x * plane.v[0] + y * plane.v[1] + z * plane.v[2]]);
    }
    return k;
  };

  for (let t = 0; t < nt; t++) {
    if (prep.triMin[t] > d0 || prep.triMax[t] < d0) continue;
    const i0 = index[t * 3], i1 = index[t * 3 + 1], i2 = index[t * 3 + 2];
    const s0 = prep.vd[i0] > d0, s1 = prep.vd[i1] > d0, s2 = prep.vd[i2] > d0;
    const ks: number[] = [];
    if (s0 !== s1) ks.push(addPoint(i0, i1));
    if (s1 !== s2) ks.push(addPoint(i1, i2));
    if (s2 !== s0) ks.push(addPoint(i2, i0));
    if (ks.length === 2) segs.push([ks[0], ks[1]]);
  }
  if (!segs.length) return [];

  // chain segments by shared edge keys
  const adj = new Map<number, number[]>();
  segs.forEach(([a, b], i) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(i);
    adj.get(b)!.push(i);
  });
  const used = new Uint8Array(segs.length);
  const loops: Path[] = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const start = segs[s][0];
    let cur = segs[s][1];
    const keys = [start, cur];
    let guard = 0;
    while (cur !== start && guard++ < segs.length + 2) {
      const next = adj.get(cur)!.find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = 1;
      cur = segs[next][0] === cur ? segs[next][1] : segs[next][0];
      if (cur !== start) keys.push(cur);
    }
    if (keys.length >= 3) loops.push(keys.map((k) => pointOnEdge.get(k)!));
  }
  return loops;
}

/** The filled section region (outer boundaries with holes). */
export function sectionShape(mesh: IndexedMesh, plane: Plane): Shape {
  const loops = sectionLoops(mesh, plane);
  if (!loops.length) return [];
  if (loops.length === 1) {
    // fast path: a single simple loop needs no boolean clean-up
    const l = loops[0];
    if (Math.abs(signedArea(l)) < 1e-6) return [];
    return [{ outer: signedArea(l) > 0 ? l : [...l].reverse(), holes: [], depth: 0 }];
  }
  return union(loops, 'evenodd');
}

export function offsetPlane(p: Plane, d: number): Plane {
  return {
    ...p,
    origin: [p.origin[0] + p.normal[0] * d, p.origin[1] + p.normal[1] * d, p.origin[2] + p.normal[2] * d],
  };
}

export function planeToWorld(p: Plane, u: number, v: number, w = 0): V3 {
  return [
    p.origin[0] + p.u[0] * u + p.v[0] * v + p.normal[0] * w,
    p.origin[1] + p.u[1] * u + p.v[1] * v + p.normal[1] * w,
    p.origin[2] + p.u[2] * u + p.v[2] * v + p.normal[2] * w,
  ];
}
