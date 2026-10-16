// 3D viewport identity: keep the WebGL renderer and extruded plate buffers
// across React re-renders. The pipeline already shares unchanged Part objects,
// but a new wrapper object, a tab switch, or a deferred assemble() still used
// to throw the geometry (and on tab change, the whole Canvas) away.
import { createContext } from 'react';
import * as THREE from 'three';
import type { Path, Shape } from '../core/geom2d';
import type { Plane } from '../core/section';
import { etchSegments, extrudeOnPlane } from '../core/geometry3d';
import type { Part } from '../core/slicer';

/** Parked = the 3D tab is in this pane but another view is in front. */
export const ViewportParkedContext = createContext(false);

/** Stable Canvas config. Inline `{ gl: {…} }` / `dpr={[1,2]}` on every parent
 *  render used to make R3F re-run configure() with a fresh object. */
export const VIEWPORT_GL = {
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance' as const,
};
export const VIEWPORT_DPR: [number, number] = [1, 2];
export const VIEWPORT_CAM_POS: [number, number, number] = [1500, 1100, 1800];
export const VIEWPORT_GRID_ARGS: [number, number] = [20000, 20000];
export const VIEWPORT_SHADOW_MAP: [number, number] = [2048, 2048];
/** Drop the floor grid a millimetre so it does not z-fight the base at y = 0. */
export const VIEWPORT_GRID_Y = -1;

export interface ViewportChurn {
  rendererCreated: number;
  geometryCreated: number;
  geometryReused: number;
}

export const viewportChurn: ViewportChurn = {
  rendererCreated: 0,
  geometryCreated: 0,
  geometryReused: 0,
};

export function resetViewportChurn(): void {
  viewportChurn.rendererCreated = 0;
  viewportChurn.geometryCreated = 0;
  viewportChurn.geometryReused = 0;
}

export function noteRendererCreated(): void {
  viewportChurn.rendererCreated += 1;
  publishChurn();
}

function publishChurn(): void {
  if (typeof window !== 'undefined') {
    (window as Window & { __STRATA_VIEWPORT_CHURN?: ViewportChurn }).__STRATA_VIEWPORT_CHURN = viewportChurn;
  }
}

function planeKey(p: Plane): string {
  return `${p.origin[0]},${p.origin[1]},${p.origin[2]}|${p.u[0]},${p.u[1]},${p.u[2]}|${p.v[0]},${p.v[1]},${p.v[2]}|${p.normal[0]},${p.normal[1]},${p.normal[2]}`;
}

function pathKey(path: Path): string {
  let s = '';
  for (const [x, y] of path) s += `${x},${y};`;
  return s;
}

function shapeKey(shape: Shape): string {
  let s = '';
  for (const ex of shape) {
    s += pathKey(ex.outer) + '/';
    for (const h of ex.holes) s += pathKey(h) + '/';
    s += '|';
  }
  return s;
}

const partKeyMemo = new WeakMap<object, string>();

/** Content identity of a plate extrusion. Same outline + plane + thickness → same key,
 *  even when the pipeline allocated a new Part wrapper. */
export function partGeometryKey(part: Pick<Part, 'id' | 'thickness' | 'plane' | 'shape'>): string {
  const hit = partKeyMemo.get(part);
  if (hit) return hit;
  const key = `${part.id}#${part.thickness}#${planeKey(part.plane)}#${shapeKey(part.shape)}`;
  partKeyMemo.set(part, key);
  return key;
}

export function etchGeometryKey(parts: Part[]): string {
  let s = '';
  for (const p of parts) {
    if (!p.etch.length && !p.labelPaths.length) continue;
    s += `${p.id}#${p.thickness}#${planeKey(p.plane)}#`;
    for (const path of p.etch) s += pathKey(path) + '!';
    for (const path of p.labelPaths) s += pathKey(path) + '!';
    s += ';';
  }
  return s;
}

interface CachedGeo {
  geo: THREE.BufferGeometry;
  refs: number;
}

const plateGeos = new Map<string, CachedGeo>();
const etchGeos = new Map<string, CachedGeo>();

function retain(map: Map<string, CachedGeo>, key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const rec = map.get(key);
  if (rec) {
    rec.refs += 1;
    viewportChurn.geometryReused += 1;
    publishChurn();
    return rec.geo;
  }
  viewportChurn.geometryCreated += 1;
  publishChurn();
  const geo = build();
  map.set(key, { geo, refs: 1 });
  return geo;
}

function release(map: Map<string, CachedGeo>, key: string): void {
  const rec = map.get(key);
  if (!rec) return;
  rec.refs -= 1;
  if (rec.refs > 0) return;
  rec.geo.dispose();
  map.delete(key);
}

export function retainPlateGeometry(part: Part): THREE.BufferGeometry {
  return retain(plateGeos, partGeometryKey(part), () => extrudeOnPlane(part.shape, part.thickness, part.plane));
}

export function releasePlateGeometry(part: Pick<Part, 'id' | 'thickness' | 'plane' | 'shape'>): void {
  release(plateGeos, partGeometryKey(part));
}

export function retainEtchGeometry(parts: Part[]): THREE.BufferGeometry {
  return retain(etchGeos, etchGeometryKey(parts), () => {
    const geos = parts.filter((p) => p.etch.length || p.labelPaths.length).map((p) => etchSegments([...p.etch, ...p.labelPaths], p.thickness, p.plane));
    const n = geos.reduce((a, g) => a + g.getAttribute('position').count, 0);
    const pos = new Float32Array(n * 3);
    let o = 0;
    for (const g of geos) {
      pos.set(g.getAttribute('position').array as Float32Array, o);
      o += g.getAttribute('position').array.length;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return out;
  });
}

export function releaseEtchGeometry(parts: Part[]): void {
  release(etchGeos, etchGeometryKey(parts));
}

/** Test helper: drop every cached buffer. */
export function resetViewportGeometryCache(): void {
  for (const rec of plateGeos.values()) rec.geo.dispose();
  for (const rec of etchGeos.values()) rec.geo.dispose();
  plateGeos.clear();
  etchGeos.clear();
}

export function viewportCacheSize(): { plates: number; etches: number } {
  return { plates: plateGeos.size, etches: etchGeos.size };
}
