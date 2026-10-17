// Cut objects: things placed among the plates (postcards, boxes, rods, balls)
// whose shape is subtracted from every plate they pass through, so the plates
// end up notched to hold them. Each is a plain solid; the slicer takes its
// section through each plate exactly as it does for the insert.
import * as THREE from 'three';
import { toIndexedMesh, type IndexedMesh } from './forms';

export type ObjectKind = 'card' | 'box' | 'cylinder' | 'sphere';

export interface CutObject {
  id: string;
  name: string;
  kind: ObjectKind;
  /** Size in mm: width (x), height (y), depth (z). A cylinder uses width as its diameter. */
  w: number;
  h: number;
  d: number;
  /** Centre, in world mm (y up, base centred on the origin). */
  x: number;
  y: number;
  z: number;
  /** Turn in degrees: ry turns it to face a new way, rx tips it back, rz rolls it in its own plane. */
  rx: number;
  ry: number;
  rz: number;
  /** Gap left around it in every plate (mm). */
  clearance: number;
  /** Off keeps it in the list without cutting or showing it. */
  on: boolean;
  /** Shelf cards: trim the plate tops to this far above the card's bottom edge (mm), so it sits in a seat. */
  seat?: number;
  /** Shelf cards: plate kept either side of the notch above the trimmed tops (mm). */
  shoulder?: number;
}

export const KIND_NAMES: Record<ObjectKind, string> = {
  card: 'Postcard',
  box: 'Box',
  cylinder: 'Cylinder',
  sphere: 'Ball',
};

/** A sensible starting size for each kind (mm). Postcards start at A6. */
export const KIND_SIZE: Record<ObjectKind, [number, number, number]> = {
  card: [148, 105, 0.4],
  box: [60, 40, 40],
  cylinder: [30, 120, 30],
  sphere: [50, 50, 50],
};

const num = (x: unknown, def: number) => (typeof x === 'number' && Number.isFinite(x) ? x : def);

export function newObject(kind: ObjectKind, existing: CutObject[], at: { y: number }): CutObject {
  const [w, h, d] = KIND_SIZE[kind];
  let n = existing.length + 1;
  const ids = new Set(existing.map((o) => o.id));
  while (ids.has(`o${n}`)) n++;
  const sameKind = existing.filter((o) => o.kind === kind).length;
  return { id: `o${n}`, name: `${KIND_NAMES[kind]} ${sameKind + 1}`, kind, w, h, d, x: 0, y: at.y + h / 2, z: 0, rx: 0, ry: 0, rz: 0, clearance: kind === 'card' ? 0.5 : 1, on: true };
}

/** Objects read from a file, with anything missing or broken filled in. */
export function cleanObjects(raw: unknown): CutObject[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CutObject[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const kind = (Object.keys(KIND_NAMES) as ObjectKind[]).includes(o.kind as ObjectKind) ? (o.kind as ObjectKind) : 'box';
    const [w, h, d] = KIND_SIZE[kind];
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : `o${out.length + 1}`,
      name: typeof o.name === 'string' ? o.name : KIND_NAMES[kind],
      kind,
      w: Math.max(0.1, num(o.w, w)),
      h: Math.max(0.1, num(o.h, h)),
      d: Math.max(0.1, num(o.d, d)),
      x: num(o.x, 0),
      y: num(o.y, 0),
      z: num(o.z, 0),
      rx: num(o.rx, 0),
      ry: num(o.ry, 0),
      rz: num(o.rz, 0),
      clearance: Math.max(0, num(o.clearance, 0.5)),
      on: o.on !== false,
    });
  }
  return out.length ? out : undefined;
}

/** World transform: yaw, pitch, roll (YXZ), then the centre. Matches the 3D mesh. */
export function objectMatrix(o: CutObject): THREE.Matrix4 {
  const r = (deg: number) => (deg * Math.PI) / 180;
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r(o.rx), r(o.ry), r(o.rz), 'YXZ'));
  m.setPosition(o.x, o.y, o.z);
  return m;
}

/** The object's solid, placed in the world. */
export function objectGeometry(o: CutObject): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  if (o.kind === 'cylinder') g = new THREE.CylinderGeometry(o.w / 2, o.w / 2, o.h, 48);
  else if (o.kind === 'sphere') {
    g = new THREE.SphereGeometry(0.5, 40, 24);
    g.scale(o.w, o.h, o.d);
  } else g = new THREE.BoxGeometry(o.w, o.h, o.d);
  g.applyMatrix4(objectMatrix(o));
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

export interface ObjectBuild {
  object: CutObject;
  geometry: THREE.BufferGeometry;
  mesh: IndexedMesh;
}

// one build per object value, so an unchanged object keeps its cached sections
const builds = new WeakMap<CutObject, ObjectBuild>();

/** The solids that cut the plates: one per object that is switched on. */
export function buildObjects(objects: CutObject[] | undefined): ObjectBuild[] {
  if (!objects) return [];
  return objects
    .filter((o) => o.on)
    .map((o) => {
      let b = builds.get(o);
      if (!b) {
        const geometry = objectGeometry(o);
        b = { object: o, geometry, mesh: toIndexedMesh(geometry) };
        builds.set(o, b);
      }
      return b;
    });
}
