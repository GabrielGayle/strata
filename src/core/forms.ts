// Parametric 3D forms. Every form is built as a stack of rings (a loft), so
// the same data drives rendering, slicing and unrolling.
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Values } from './params';

export type ShapeKind = 'none' | 'fin' | 'cone' | 'cylinder' | 'box' | 'loft' | 'revolve' | 'extrude' | 'mesh';

export interface FormSpec {
  shape: ShapeKind;
  x: number;
  y: number;
  z: number;
  rot: number;
  length: number;
  width: number;
  height: number;
  taper: number;
  sweep: number;
  camber: number;
  bend: number;
  twist: number;
  scale: number;
}

export interface Form {
  spec: FormSpec;
  geometry: THREE.BufferGeometry;
  /** Rings in world space (levels x points), used for unrolling. */
  rings: THREE.Vector3[][];
  /** Straight-line rulings between consecutive rings? */
  ruledLevels: boolean;
  bbox: THREE.Box3;
}

export function formSpec(v: Values, prefix: 'ins' | 'src'): FormSpec {
  return {
    shape: v[`${prefix}Shape`] as ShapeKind,
    x: v[`${prefix}X`],
    y: v[`${prefix}Y`],
    z: v[`${prefix}Z`],
    rot: v[`${prefix}Rot`],
    length: v[`${prefix}Length`],
    width: v[`${prefix}Width`],
    height: v[`${prefix}Height`],
    taper: v[`${prefix}Taper`],
    sweep: v[`${prefix}Sweep`],
    camber: v[`${prefix}Camber`],
    bend: v[`${prefix}Bend`],
    twist: v[`${prefix}Twist`],
    scale: v[`${prefix}Scale`],
  };
}

type Ring2 = [number, number][]; // local (x, z)

function nacaHalfThickness(c: number): number {
  // NACA 4-digit thickness distribution, normalised so the max is ~0.5
  return 5 * (0.2969 * Math.sqrt(c) - 0.126 * c - 0.3516 * c * c + 0.2843 * c ** 3 - 0.1036 * c ** 4);
}

function finRing(L: number, W: number, camber: number, n: number): Ring2 {
  const half = Math.floor(n / 2);
  const pts: Ring2 = [];
  // upper surface from leading edge to trailing edge, then lower back
  for (let i = 0; i < half; i++) {
    const c = (1 - Math.cos((Math.PI * i) / half)) / 2;
    const t = nacaHalfThickness(c) * W;
    const mc = camber * 4 * c * (1 - c);
    pts.push([-L / 2 + c * L, mc + t]);
  }
  for (let i = half; i > 0; i--) {
    const c = (1 - Math.cos((Math.PI * i) / half)) / 2;
    const t = nacaHalfThickness(c) * W;
    const mc = camber * 4 * c * (1 - c);
    pts.push([-L / 2 + c * L, mc - t]);
  }
  return pts;
}

function ellipseRing(rx: number, rz: number, n: number): Ring2 {
  const pts: Ring2 = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([Math.cos(a) * rx, Math.sin(a) * rz]);
  }
  return pts;
}

function roundedRectRing(L: number, W: number, r: number, n: number): Ring2 {
  // sample a rounded rectangle uniformly by arc length so every ring has n points
  const rr = Math.max(0.01, Math.min(Math.abs(r), L / 2 - 0.01, W / 2 - 0.01));
  const hx = L / 2 - rr;
  const hz = W / 2 - rr;
  const segs: { len: number; at: (t: number) => [number, number] }[] = [];
  const corner = (cx: number, cz: number, a0: number) => ({
    len: (Math.PI / 2) * rr,
    at: (t: number) => [cx + Math.cos(a0 + (t * Math.PI) / 2) * rr, cz + Math.sin(a0 + (t * Math.PI) / 2) * rr] as [number, number],
  });
  const line = (x0: number, z0: number, x1: number, z1: number) => ({
    len: Math.hypot(x1 - x0, z1 - z0),
    at: (t: number) => [x0 + (x1 - x0) * t, z0 + (z1 - z0) * t] as [number, number],
  });
  segs.push(line(hx + rr, -hz, hx + rr, hz), corner(hx, hz, 0), line(hx, hz + rr, -hx, hz + rr), corner(-hx, hz, Math.PI / 2));
  segs.push(line(-hx - rr, hz, -hx - rr, -hz), corner(-hx, -hz, Math.PI), line(-hx, -hz - rr, hx, -hz - rr), corner(hx, -hz, (3 * Math.PI) / 2));
  const total = segs.reduce((s, g) => s + g.len, 0);
  const pts: Ring2 = [];
  for (let i = 0; i < n; i++) {
    let d = (i / n) * total;
    let k = 0;
    while (k < segs.length - 1 && d > segs[k].len) {
      d -= segs[k].len;
      k++;
    }
    pts.push(segs[k].at(segs[k].len > 0 ? Math.min(1, d / segs[k].len) : 0));
  }
  return pts;
}

function boxRing(L: number, W: number, n: number): Ring2 {
  // corners land exactly on ring points so they unroll as clean bends
  const corners: [number, number][] = [[L / 2, -W / 2], [L / 2, W / 2], [-L / 2, W / 2], [-L / 2, -W / 2]];
  const per = 2 * (L + W);
  const counts = [W, L, W, L].map((s) => Math.max(1, Math.round((s / per) * n)));
  const pts: Ring2 = [];
  for (let k = 0; k < 4; k++) {
    const a = corners[k], b = corners[(k + 1) % 4];
    for (let i = 0; i < counts[k]; i++) pts.push([a[0] + ((b[0] - a[0]) * i) / counts[k], a[1] + ((b[1] - a[1]) * i) / counts[k]]);
  }
  return pts;
}

/** Ring at height fraction t for a given spec, in local coordinates. */
function ringAt(spec: FormSpec, t: number, n: number): Ring2 {
  const { length: L, width: W, taper, sweep, camber, bend, twist } = spec;
  const s = 1 + (taper - 1) * t;
  let ring: Ring2;
  let dx = 0;
  let dz = 0;
  switch (spec.shape) {
    case 'fin':
      ring = finRing(Math.max(0.5, L * s), Math.max(0.2, W * s), camber * s, n);
      dx = sweep * t + (L * (1 - s)) / 2; // keep the leading edge raked back
      dz = bend * Math.sin(Math.PI * t);
      break;
    case 'cone':
      ring = ellipseRing(Math.max(0.05, (W / 2) * s), Math.max(0.05, (W / 2) * s), n);
      dx = sweep * t;
      break;
    case 'cylinder':
      ring = ellipseRing(W / 2, W / 2, n);
      break;
    case 'loft':
      ring = ellipseRing(Math.max(0.05, (L / 2) * s), Math.max(0.05, (W / 2) * s), n);
      dx = sweep * t;
      dz = bend * Math.sin(Math.PI * t);
      break;
    case 'revolve': {
      const r = Math.max(0.05, (W / 2) * (1 + (taper - 1) * t) + camber * Math.sin(Math.PI * t));
      ring = ellipseRing(r, r, n);
      break;
    }
    case 'extrude':
      ring = roundedRectRing(L, W, camber, n);
      break;
    case 'box':
    default:
      ring = boxRing(L, W, n);
  }
  const tw = (twist * t * Math.PI) / 180;
  const c = Math.cos(tw);
  const si = Math.sin(tw);
  return ring.map(([x, z]) => [x * c - z * si + dx, x * si + z * c + dz]);
}

function levelsFor(spec: FormSpec): number {
  switch (spec.shape) {
    case 'fin':
      return 28;
    case 'revolve':
      return Math.abs(spec.camber) > 0.01 ? 36 : 2;
    case 'loft':
      return Math.abs(spec.bend) > 0.01 || Math.abs(spec.twist) > 0.01 ? 28 : 2;
    case 'extrude':
      return Math.abs(spec.twist) > 0.01 ? 28 : 2;
    default:
      return 2;
  }
}

function placeMatrix(spec: FormSpec): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationY((-spec.rot * Math.PI) / 180);
  m.setPosition(spec.x, spec.y, spec.z);
  return m;
}

/** Build the closed solid for a ring loft. Side vertices are shared (smooth); caps have their own vertices (sharp edge). */
function loftGeometry(rings: THREE.Vector3[][]): THREE.BufferGeometry {
  const L = rings.length;
  const N = rings[0].length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const ring of rings) for (const p of ring) pos.push(p.x, p.y, p.z);
  for (let i = 0; i < L - 1; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * N + j;
      const b = i * N + ((j + 1) % N);
      const c = (i + 1) * N + j;
      const d = (i + 1) * N + ((j + 1) % N);
      idx.push(a, c, b, b, c, d);
    }
  }
  // caps
  const cap = (ring: THREE.Vector3[], top: boolean) => {
    const base = pos.length / 3;
    for (const p of ring) pos.push(p.x, p.y, p.z);
    const contour = ring.map((p) => new THREE.Vector2(p.x, p.z));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const ccw = THREE.ShapeUtils.isClockWise(contour) === false;
    for (const [a, b, c] of tris) {
      // bottom cap faces down, top cap faces up
      const flip = top ? !ccw : ccw;
      if (flip) idx.push(base + a, base + b, base + c);
      else idx.push(base + a, base + c, base + b);
    }
  };
  cap(rings[0], false);
  cap(rings[L - 1], true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  // ensure outward winding for side faces: test volume sign
  let vol = 0;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), Cc = new THREE.Vector3();
  const pa = g.getAttribute('position');
  for (let t = 0; t < idx.length; t += 3) {
    A.fromBufferAttribute(pa, idx[t]);
    B.fromBufferAttribute(pa, idx[t + 1]);
    Cc.fromBufferAttribute(pa, idx[t + 2]);
    vol += A.dot(B.clone().cross(Cc));
  }
  if (vol < 0) {
    for (let t = 0; t < idx.length; t += 3) {
      const tmp = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = tmp;
    }
    g.setIndex(idx);
  }
  g.computeVertexNormals();
  return g;
}

export function prepareMesh(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  // centre on X/Z, sit on Y = 0
  const g = geo.clone();
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  return g;
}

export function buildForm(spec: FormSpec, mesh?: THREE.BufferGeometry | null): Form | null {
  if (spec.shape === 'none') return null;
  const m = placeMatrix(spec);
  if (spec.shape === 'mesh') {
    if (!mesh) return null;
    const g = mesh.clone();
    g.scale(spec.scale, spec.scale, spec.scale);
    g.applyMatrix4(m);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g.computeBoundingBox();
    return { spec, geometry: g, rings: [], ruledLevels: false, bbox: g.boundingBox!.clone() };
  }
  const N = spec.shape === 'box' ? 64 : 96;
  const levels = levelsFor(spec);
  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i < levels; i++) {
    const t = i / (levels - 1);
    const r = ringAt(spec, t, N);
    rings.push(r.map(([x, z]) => new THREE.Vector3(x, t * spec.height, z).applyMatrix4(m)));
  }
  let geometry: THREE.BufferGeometry;
  if (spec.shape === 'box') {
    geometry = new THREE.BoxGeometry(spec.length, spec.height, spec.width);
    geometry.translate(0, spec.height / 2, 0);
    geometry.applyMatrix4(m);
  } else {
    geometry = loftGeometry(rings);
  }
  geometry.computeBoundingBox();
  return { spec, geometry, rings, ruledLevels: levels === 2, bbox: geometry.boundingBox!.clone() };
}

/** Rebuild rings with a specific point count (e.g. a faceted version for press-brake unrolling). */
export function ringsWithCount(spec: FormSpec, n: number): THREE.Vector3[][] {
  const m = placeMatrix(spec);
  const levels = levelsFor(spec);
  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i < levels; i++) {
    const t = i / (levels - 1);
    rings.push(ringAt(spec, t, n).map(([x, z]) => new THREE.Vector3(x, t * spec.height, z).applyMatrix4(m)));
  }
  return rings;
}

export interface IndexedMesh {
  pos: Float32Array;
  index: Uint32Array;
  vertexCount: number;
}

/** Weld vertices so plane sections can be chained by shared edges. */
export function toIndexedMesh(geo: THREE.BufferGeometry): IndexedMesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geo.getAttribute('position').clone());
  if (geo.index) g.setIndex(geo.index.clone());
  const merged = mergeVertices(g, 1e-4);
  const pos = merged.getAttribute('position').array as Float32Array;
  let index: Uint32Array;
  if (merged.index) index = new Uint32Array(merged.index.array);
  else {
    index = new Uint32Array(pos.length / 3);
    for (let i = 0; i < index.length; i++) index[i] = i;
  }
  return { pos: new Float32Array(pos), index, vertexCount: pos.length / 3 };
}

export function meshVolume(mesh: IndexedMesh): number {
  const { pos, index } = mesh;
  let v = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    v +=
      pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
      pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
      pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return Math.abs(v / 6);
}
