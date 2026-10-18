// Runs the whole regeneration pipeline (front and deferred stages) off the main
// thread. The page posts only the parts of the project and assets that changed
// since its last post; the worker keeps its own copies and stage caches, runs
// either a coarse preview (while a slider or gizmo is held) or the full model,
// and replies with only the parts of the model that changed since its last
// reply. The page folds each reply into the model it holds, so anything an edit
// didn't touch keeps its identity and the 3D view skips it.
import * as THREE from 'three';
import { assemble, createDeferredPipeline, createFrontPipeline, deferredInput, type Assets, type FormBuild, type FrontModel, type Model } from './pipeline';
import type { HeightField } from './heightfield';
import type { ObjectBuild } from './objects';
import type { Project } from './project';
import { isMapTerrainFailure, userFacingMapBuildError } from './mapBuildError';
import { partGeometry, setPartGeometry } from './partMesh';
import type { Part } from './slicer';

export type EngineMode = 'preview' | 'full';

/**
 * Runs a front pass; if map terrain can't be built, reports why and runs again
 * without the map's depth so the rest of the design still shows.
 */
export function frontWithMapFallback(front: (project: Project, assets: Assets) => FrontModel, project: Project, assets: Assets, onMapError: (message: string, err: unknown) => void): FrontModel {
  try {
    return front(project, assets);
  } catch (e) {
    if (!isMapTerrainFailure(e)) throw e;
    onMapError(userFacingMapBuildError(e), e);
    const top = project.images.top;
    if (top?.map && top.depth) return front({ ...project, images: { ...project.images, top: { ...top, depth: undefined } } }, assets);
    throw e;
  }
}

// ---- plain data both ways (no THREE objects, no functions) ----

export interface PlainGeometry {
  attributes: Record<string, { array: ArrayLike<number>; itemSize: number; normalized: boolean }>;
  index: ArrayLike<number> | null;
  groups: { start: number; count: number; materialIndex?: number }[];
  /** Bounds, worked out on the sending side: [min x, y, z, max x, y, z] and [centre x, y, z, radius]. */
  box: number[];
  sphere: number[];
}

export function geometryToPlain(g: THREE.BufferGeometry): PlainGeometry {
  const attributes: PlainGeometry['attributes'] = {};
  for (const [name, a] of Object.entries(g.attributes)) {
    const attr = a as THREE.BufferAttribute;
    attributes[name] = { array: attr.array, itemSize: attr.itemSize, normalized: attr.normalized };
  }
  if (!g.boundingBox) g.computeBoundingBox();
  if (!g.boundingSphere) g.computeBoundingSphere();
  const { min, max } = g.boundingBox!;
  const { center, radius } = g.boundingSphere!;
  return { attributes, index: g.index ? g.index.array : null, groups: g.groups.map((x) => ({ ...x })), box: [min.x, min.y, min.z, max.x, max.y, max.z], sphere: [center.x, center.y, center.z, radius] };
}

export function geometryFromPlain(p: PlainGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(p.attributes)) g.setAttribute(name, new THREE.BufferAttribute(a.array as THREE.TypedArray, a.itemSize, a.normalized));
  if (p.index) g.setIndex(new THREE.BufferAttribute(p.index as THREE.TypedArray, 1));
  for (const x of p.groups) g.addGroup(x.start, x.count, x.materialIndex);
  const b = p.box, c = p.sphere;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(c[0], c[1], c[2]), c[3]);
  return g;
}

type V3 = [number, number, number];
interface PlainFormBuild {
  form: { spec: FormBuild['form']['spec']; geometry: PlainGeometry; rings: V3[][]; ruledLevels: boolean; bbox: { min: V3; max: V3 } };
  mesh: FormBuild['mesh'];
  volume: number;
}
interface PlainObjectBuild {
  object: ObjectBuild['object'];
  geometry: PlainGeometry;
  mesh: ObjectBuild['mesh'];
}
interface PlainHeightField {
  min: number;
  max: number;
  heightCapScale?: number;
}

/**
 * A model as it crosses from the worker: forms, objects and the height field as
 * plain data, plus each part's 3D mesh (aligned with sliced.parts) so the page
 * doesn't extrude them itself.
 */
export type PlainModel = Omit<Model, 'insert' | 'source' | 'objects' | 'hf'> & {
  insert: PlainFormBuild | null;
  source: PlainFormBuild | null;
  objects: PlainObjectBuild[];
  hf: PlainHeightField | null;
  partMeshes: PlainGeometry[];
};

const v3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
// one plain copy per built object, so an unchanged form or object keeps its identity across replies
const plainForms = new WeakMap<FormBuild, PlainFormBuild>();
const plainObjects = new WeakMap<ObjectBuild, PlainObjectBuild>();
const plainFields = new WeakMap<HeightField, PlainHeightField>();
const plainParts = new WeakMap<Part, PlainGeometry>();

function formToPlain(b: FormBuild): PlainFormBuild {
  let p = plainForms.get(b);
  if (!p) {
    const f = b.form;
    p = { form: { spec: f.spec, geometry: geometryToPlain(f.geometry), rings: f.rings.map((r) => r.map(v3)), ruledLevels: f.ruledLevels, bbox: { min: v3(f.bbox.min), max: v3(f.bbox.max) } }, mesh: b.mesh, volume: b.volume };
    plainForms.set(b, p);
  }
  return p;
}

function objectToPlain(o: ObjectBuild): PlainObjectBuild {
  let p = plainObjects.get(o);
  if (!p) plainObjects.set(o, (p = { object: o.object, geometry: geometryToPlain(o.geometry), mesh: o.mesh }));
  return p;
}

function fieldToPlain(hf: HeightField): PlainHeightField {
  let p = plainFields.get(hf);
  if (!p) plainFields.set(hf, (p = { min: hf.min, max: hf.max, heightCapScale: hf.heightCapScale }));
  return p;
}

function partToPlain(p: Part): PlainGeometry {
  let g = plainParts.get(p);
  if (!g) plainParts.set(p, (g = geometryToPlain(partGeometry(p))));
  return g;
}

export function modelToPlain(m: Model): PlainModel {
  return { ...m, insert: m.insert && formToPlain(m.insert), source: m.source && formToPlain(m.source), objects: m.objects.map(objectToPlain), hf: m.hf && fieldToPlain(m.hf), partMeshes: m.sliced.parts.map(partToPlain) };
}

const vec = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);
const hydratedForms = new WeakMap<PlainFormBuild, FormBuild>();
const hydratedObjects = new WeakMap<PlainObjectBuild, ObjectBuild>();
const hydratedFields = new WeakMap<PlainHeightField, HeightField>();
const hydratedParts = new WeakMap<PlainGeometry, THREE.BufferGeometry>();

function formFromPlain(p: PlainFormBuild): FormBuild {
  let b = hydratedForms.get(p);
  if (!b) {
    const f = p.form;
    b = { form: { spec: f.spec, geometry: geometryFromPlain(f.geometry), rings: f.rings.map((r) => r.map(vec)), ruledLevels: f.ruledLevels, bbox: new THREE.Box3(vec(f.bbox.min), vec(f.bbox.max)) }, mesh: p.mesh, volume: p.volume };
    hydratedForms.set(p, b);
  }
  return b;
}

function objectFromPlain(p: PlainObjectBuild): ObjectBuild {
  let o = hydratedObjects.get(p);
  if (!o) hydratedObjects.set(p, (o = { object: p.object, geometry: geometryFromPlain(p.geometry), mesh: p.mesh }));
  return o;
}

function fieldFromPlain(p: PlainHeightField): HeightField {
  let hf = hydratedFields.get(p);
  if (!hf) {
    hf = {
      ...p,
      at() {
        throw new Error('The height field is only sampled inside the engine worker');
      },
    };
    hydratedFields.set(p, hf);
  }
  return hf;
}

export function modelFromPlain(p: PlainModel): Model {
  const { partMeshes, ...rest } = p;
  p.sliced.parts.forEach((part, i) => {
    const plain = partMeshes[i];
    let g = hydratedParts.get(plain);
    if (!g) hydratedParts.set(plain, (g = geometryFromPlain(plain)));
    setPartGeometry(part, g);
  });
  return { ...rest, insert: p.insert && formFromPlain(p.insert), source: p.source && formFromPlain(p.source), objects: p.objects.map(objectFromPlain), hf: p.hf && fieldFromPlain(p.hf) };
}

// ---- point lists as flat arrays ----
// Outlines are arrays of [x, y] pairs, which are slow to copy between threads one
// small array at a time; they cross as one Float64Array each (exact, no rounding).

const PTS = '__strataPoints';
const packedLists = new WeakMap<object, unknown>();

const isPointList = (a: unknown[]) => {
  if (a.length < 2) return false;
  for (const p of a) if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') return false;
  return true;
};

/** Swaps every list of [x, y] pairs in `x` for a flat array. Unchanged values pack to the same object every time. */
export function packPoints<T>(x: T): T {
  const pack = (v: unknown): unknown => {
    if (typeof v !== 'object' || v === null || ArrayBuffer.isView(v)) return v;
    if (packedLists.has(v)) return packedLists.get(v);
    let out: unknown = v;
    if (Array.isArray(v)) {
      if (isPointList(v)) {
        const flat = new Float64Array(v.length * 2);
        v.forEach((p, i) => ((flat[i * 2] = p[0]), (flat[i * 2 + 1] = p[1])));
        out = { [PTS]: flat };
      } else {
        const m = v.map(pack);
        if (m.some((e, i) => e !== v[i])) out = m;
      }
    } else if (isPlainObject(v)) {
      let o: Record<string, unknown> | null = null;
      for (const [k, e] of Object.entries(v)) {
        const pe = pack(e);
        if (pe !== e) (o ??= { ...v })[k] = pe;
      }
      if (o) out = o;
    }
    packedLists.set(v, out);
    return out;
  };
  return pack(x) as T;
}

/** Turns the flat arrays back into [x, y] lists, in place (the value is fresh off the wire). */
function unpackPoints(x: unknown, done: Map<object, unknown>): unknown {
  if (typeof x !== 'object' || x === null || ArrayBuffer.isView(x)) return x;
  if (done.has(x)) return done.get(x);
  if (isPlainObject(x) && PTS in x) {
    const flat = x[PTS] as Float64Array;
    const pts: [number, number][] = new Array(flat.length / 2);
    for (let i = 0; i < pts.length; i++) pts[i] = [flat[i * 2], flat[i * 2 + 1]];
    done.set(x, pts);
    return pts;
  }
  done.set(x, x);
  if (Array.isArray(x)) for (let i = 0; i < x.length; i++) x[i] = unpackPoints(x[i], done);
  else if (isPlainObject(x)) for (const k of Object.keys(x)) x[k] = unpackPoints(x[k], done);
  return x;
}

// ---- identity deltas ----

/** How deep a reply is compared by identity: model › sliced › parts › part › fields. */
const DELTA_DEPTH = 4;
const TAG = '__strataDelta';
type Delta = { [TAG]: 'same' } | { [TAG]: 'obj'; v: Record<string, unknown> } | { [TAG]: 'arr'; v: unknown[] };

const isPlainObject = (x: unknown): x is Record<string, unknown> => {
  if (typeof x !== 'object' || x === null || Array.isArray(x) || ArrayBuffer.isView(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};
const isDelta = (x: unknown): x is Delta => isPlainObject(x) && TAG in x;

/**
 * Encodes `next` against `prev`: anything still identical to its counterpart
 * becomes a "same" marker, containers holding some of both become patches, and
 * new data is passed as it is. One object reached twice is encoded once, so the
 * page rebuilds it once and shared references stay shared.
 */
export function encodeDelta(prev: unknown, next: unknown): unknown {
  const seen = new Map<object, unknown>();
  const enc = (a: unknown, b: unknown, depth: number): unknown => {
    if (typeof b !== 'object' || b === null) return b;
    if (a === b) return { [TAG]: 'same' };
    if (depth <= 0 || typeof a !== 'object' || a === null) return b;
    if (seen.has(b)) return seen.get(b);
    let out: unknown = b;
    if (Array.isArray(a) && Array.isArray(b)) {
      const v = b.map((x, i) => enc(a[i], x, depth - 1));
      if (v.some((x, i) => x !== b[i])) out = { [TAG]: 'arr', v };
    } else if (isPlainObject(a) && isPlainObject(b)) {
      const v: Record<string, unknown> = {};
      let changed = false;
      for (const k of Object.keys(b)) {
        v[k] = enc(a[k], b[k], depth - 1);
        if (v[k] !== b[k]) changed = true;
      }
      if (changed) out = { [TAG]: 'obj', v };
    }
    seen.set(b, out);
    return out;
  };
  return enc(prev, next, DELTA_DEPTH + 1);
}

/** Rebuilds the value `encodeDelta` encoded, reusing `prev` for everything marked the same (and unpacking point lists in what's new). */
export function applyDelta(prev: unknown, delta: unknown): unknown {
  const seen = new Map<object, unknown>();
  const unpacked = new Map<object, unknown>();
  const dec = (a: unknown, d: unknown): unknown => {
    if (!isDelta(d)) return unpackPoints(d, unpacked);
    if (d[TAG] === 'same') return a;
    if (seen.has(d)) return seen.get(d);
    let out: unknown;
    if (d[TAG] === 'arr') {
      const pa = Array.isArray(a) ? a : [];
      out = d.v.map((x, i) => dec(pa[i], x));
    } else {
      const pa = isPlainObject(a) ? a : {};
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(d.v)) o[k] = dec(pa[k], x);
      out = o;
    }
    seen.set(d, out);
    return out;
  };
  return dec(prev, delta);
}

// ---- the worker's side ----

const ASSET_KEYS = ['sideImg', 'frontImg', 'topImg', 'insMesh', 'srcMesh', 'shadowFrames'] as const;
type MeshKey = 'insMesh' | 'srcMesh';
/** Assets as posted: meshes as plain geometry. */
export type PlainAssets = Omit<Assets, MeshKey> & { insMesh: PlainGeometry | null; srcMesh: PlainGeometry | null };

export interface EngineRequest {
  id: number;
  mode: EngineMode;
  /** Top-level project fields that changed since the previous request. */
  project: Partial<Project>;
  /** Project fields that no longer exist. */
  dropped: string[];
  /** Assets that changed since the previous request. */
  assets: Partial<PlainAssets>;
}

export type EngineReply =
  | { id: number; mode: EngineMode; model: unknown; mapError?: string; ms: number }
  | { id: number; error: string };

/**
 * The worker's side: keeps the inputs, the stage caches and the last reply between
 * requests. Takes every request that arrived while it was busy, applies their
 * changes in order and builds only the newest.
 */
export function createEngineHandler() {
  const front = { preview: createFrontPipeline({ preview: true }), full: createFrontPipeline() };
  const deferred = createDeferredPipeline();
  let project = {} as Project;
  const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };
  let lastSent: PlainModel | undefined;
  const apply = (req: EngineRequest) => {
    project = { ...project, ...req.project };
    for (const k of req.dropped) delete (project as unknown as Record<string, unknown>)[k];
    for (const k of ASSET_KEYS) {
      if (!(k in req.assets)) continue;
      if (k === 'insMesh' || k === 'srcMesh') {
        const g = req.assets[k];
        assets[k] = g ? geometryFromPlain(g) : null;
      } else (assets as unknown as Record<string, unknown>)[k] = req.assets[k];
    }
  };
  return (reqs: EngineRequest[]): EngineReply => {
    const t0 = performance.now();
    const { id, mode } = reqs[reqs.length - 1];
    try {
      reqs.forEach(apply);
      let mapError: string | undefined;
      const f = frontWithMapFallback(front[mode], project, assets, (m) => (mapError = m));
      const model = packPoints(modelToPlain(assemble(f, deferred(deferredInput(f, project), mode === 'preview' ? 'fast' : 'full'))));
      const delta = encodeDelta(lastSent, model);
      lastSent = model;
      return { id, mode, model: delta, mapError, ms: performance.now() - t0 };
    } catch (e) {
      lastSent = undefined; // the page drops its copy too
      return { id, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

// ---- the page's side ----

const plainMeshes = new WeakMap<THREE.BufferGeometry, PlainGeometry>();
const plainMesh = (g: THREE.BufferGeometry | null | undefined) => {
  if (!g) return null;
  let p = plainMeshes.get(g);
  if (!p) plainMeshes.set(g, (p = geometryToPlain(g)));
  return p;
};

export interface EngineJob {
  id: number;
  mode: EngineMode;
  project: Project;
  assets: Assets;
}

/**
 * Posts engine work to a worker as each edit happens; the worker builds only the
 * newest of whatever arrived while it was busy, so a dragged slider never builds
 * a queue, and it starts on the latest edit without waiting for this thread.
 */
export class EngineWorker {
  /** Posted and not yet answered, oldest first. */
  private jobs: EngineJob[] = [];
  private sentProject: Partial<Project> | null = null;
  private sentAssets: Partial<Assets> | null = null;
  private nextId = 1;
  private plain: unknown;

  constructor(
    private worker: Worker,
    private onResult: (job: EngineJob, model: Model, reply: { mapError?: string; ms: number }) => void,
    /** The worker couldn't do this job (fatal: it died, so stop using it). */
    private onFail: (job: EngineJob, fatal: boolean, error: string) => void,
  ) {
    worker.onmessage = (e: MessageEvent<EngineReply>) => {
      const reply = e.data;
      const job = this.jobs.find((j) => j.id === reply.id);
      // that job and everything posted before it are answered
      this.jobs = this.jobs.filter((j) => j.id > reply.id);
      if (!job) return;
      if ('error' in reply) {
        this.plain = undefined;
        this.sentProject = this.sentAssets = null; // resend everything next time
        if (!this.jobs.length) this.onFail(job, false, reply.error);
      } else {
        this.plain = applyDelta(this.plain, reply.model);
        this.onResult(job, modelFromPlain(this.plain as PlainModel), reply);
      }
    };
    worker.onerror = (e) => {
      const job = this.jobs[this.jobs.length - 1];
      this.jobs = [];
      this.sentProject = this.sentAssets = null;
      if (job) this.onFail(job, true, e.message ?? 'engine worker failed');
    };
  }

  run(project: Project, assets: Assets, mode: EngineMode): EngineJob {
    const job = { id: this.nextId++, mode, project, assets };
    const changes: Partial<Project> = {};
    const last = this.sentProject;
    for (const [k, x] of Object.entries(project)) if (!last || !(k in last) || (last as Record<string, unknown>)[k] !== x) (changes as Record<string, unknown>)[k] = x;
    const dropped = last ? Object.keys(last).filter((k) => !(k in project)) : [];
    const plainAssets: Partial<PlainAssets> = {};
    for (const k of ASSET_KEYS) {
      const x = assets[k];
      if (this.sentAssets && this.sentAssets[k] === x) continue;
      if (k === 'insMesh' || k === 'srcMesh') plainAssets[k] = plainMesh(x as THREE.BufferGeometry | null);
      else (plainAssets as Record<string, unknown>)[k] = x ?? null;
    }
    this.sentProject = { ...project };
    this.sentAssets = { ...assets };
    this.jobs.push(job);
    this.worker.postMessage({ id: job.id, mode, project: changes, dropped, assets: plainAssets } satisfies EngineRequest);
    return job;
  }

  /** True while an edit has been posted and not answered. */
  get working() {
    return this.jobs.length > 0;
  }

  terminate() {
    this.worker.terminate();
  }
}
