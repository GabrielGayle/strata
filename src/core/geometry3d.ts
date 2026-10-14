// 2D shapes → three.js geometry (straight extrusions only).
import * as THREE from 'three';
import type { Path, Shape } from './geom2d';
import type { Plane } from './section';

function toThreeShapes(shape: Shape): THREE.Shape[] {
  return shape.map((ex) => {
    const s = new THREE.Shape(ex.outer.map(([x, y]) => new THREE.Vector2(x, y)));
    s.holes = ex.holes.map((h) => new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
    return s;
  });
}

export function planeMatrix(p: Plane): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...p.u), new THREE.Vector3(...p.v), new THREE.Vector3(...p.normal));
  m.setPosition(p.origin[0], p.origin[1], p.origin[2]);
  return m;
}

/** Extrude a flat part through its thickness, centred on its plane. */
export function extrudeOnPlane(shape: Shape, thickness: number, plane: Plane): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(toThreeShapes(shape), { depth: thickness, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -thickness / 2);
  g.applyMatrix4(planeMatrix(plane));
  return g;
}

/** Extrude a plan shape (x, -z) upwards from height y0. */
export function extrudePlan(shape: Shape, thickness: number, y0: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(toThreeShapes(shape), { depth: thickness, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}

/** Line segments lying just proud of both faces of a plate (for etch preview). */
export function etchSegments(paths: Path[], thickness: number, plane: Plane): THREE.BufferGeometry {
  const pos: number[] = [];
  const m = planeMatrix(plane);
  const v = new THREE.Vector3();
  for (const w of [-thickness / 2 - 0.08, thickness / 2 + 0.08]) {
    for (const p of paths) {
      for (let i = 0; i < p.length - 1; i++) {
        v.set(p[i][0], p[i][1], w).applyMatrix4(m);
        pos.push(v.x, v.y, v.z);
        v.set(p[i + 1][0], p[i + 1][1], w).applyMatrix4(m);
        pos.push(v.x, v.y, v.z);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

export function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // simple non-indexed merge of position + normal
  let count = 0;
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of parts) count += g.getAttribute('position').count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  let o = 0;
  for (const g of parts) {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    pos.set(g.getAttribute('position').array as Float32Array, o * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, o * 3);
    o += g.getAttribute('position').count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}
