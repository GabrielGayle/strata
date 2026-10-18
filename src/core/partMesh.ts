// The 3D mesh of each cut part. The engine worker extrudes parts off the main
// thread and hands their meshes over; anything it didn't (the first frame, or no
// worker) is extruded here on first use. One mesh per part object, so a part an
// edit didn't change keeps its mesh.
import type * as THREE from 'three';
import { extrudeOnPlane } from './geometry3d';
import type { Part } from './slicer';

const meshes = new WeakMap<Part, THREE.BufferGeometry>();

export function partGeometry(part: Part): THREE.BufferGeometry {
  let g = meshes.get(part);
  if (!g) meshes.set(part, (g = extrudeOnPlane(part.shape, part.thickness, part.plane)));
  return g;
}

/** Records a mesh built elsewhere (the engine worker) for this part. */
export function setPartGeometry(part: Part, g: THREE.BufferGeometry) {
  meshes.set(part, g);
}
