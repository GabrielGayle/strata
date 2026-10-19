// Runs the whole regeneration pipeline (front and deferred stages) off the main
// thread. The page posts only the parts of the project and assets that changed
// since its last post; the worker keeps its own copies and stage caches, runs
// either a coarse preview (while a slider or gizmo is held) or the full model,
// and replies with only the parts of the model that changed since its last
// reply. The page folds each reply into the model it holds, so anything an edit
// didn't touch keeps its identity and the 3D view skips it.
import * as THREE from 'three';
import { ASSET_KEYS, assemble, createDeferredPipeline, createFrontPipeline, deferredInput, type Assets, type FormBuild, type FrontModel, type Model } from './pipeline';
import type { HeightField } from './heightfield';
import type { ObjectBuild } from './objects';
import type { Project } from './project';
import { isMapTerrainFailure, userFacingMapBuildError } from './mapBuildError';
import { partGeometry, setPartGeometry } from './partMesh';
import type { Part } from './slicer';
import { isPlainObject, packPoints, unpackPoints } from './packPoints';
import { resultKey, type CacheSource, type ResultCache } from './resultCache';
import type { ShadowClient } from './shadowJob';

export { packPoints };

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

// ---- identity deltas ----

/** How deep a reply is compared by identity: model › sliced › parts › part › fields. */
const DELTA_DEPTH = 4;
const TAG = '__strataDelta';
type Delta = { [TAG]: 'same' } | { [TAG]: 'obj'; v: Record<string, unknown> } | { [TAG]: 'arr'; v: unknown[] };

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
  | {
      id: number;
      /** 'full' also when a preview request was answered from the result cache. */
      mode: EngineMode;
      model: unknown;
      mapError?: string;
      ms: number;
      /** Taken from the result cache instead of built. */
      cached?: CacheSource;
      /** The shadow carve is still running: a second reply for the same request follows with the carved plates. */
      carving?: boolean;
    }
  | { id: number; error: string };

export type EngineResult = Exclude<EngineReply, { error: string }>;

/** Messages to the engine worker besides requests. */
export type EngineControl = { type: 'shadow-port'; port: MessagePort } | { type: 'clear-cache' };

export interface EngineOptions {
  /** Finished models by what they were built from (see resultCache.ts). */
  cache?: ResultCache;
  /** Carves shadows on the shadow worker (see shadowJob.ts); without it they are carved inline. */
  shadow?: ShadowClient;
}

/** A finished model as the cache keeps it, checked before use: one mesh per part. */
export const validCachedModel = (m: unknown) => {
  const p = m as PlainModel | undefined;
  return !!p && Array.isArray(p.partMeshes) && !!p.sliced && Array.isArray(p.sliced.parts) && p.partMeshes.length === p.sliced.parts.length && !p.shadowPending;
};

/**
 * The worker's side: keeps the inputs, the stage caches and the last reply between
 * requests. Takes every request that arrived while it was busy, applies their
 * changes in order and builds only the newest. A full build of something it
 * has built before comes from the result cache.
 */
export function createEngineHandler(opts: EngineOptions = {}) {
  const { cache, shadow } = opts;
  const front = { preview: createFrontPipeline({ preview: true }), full: createFrontPipeline({ carve: shadow?.carve }) };
  const deferred = createDeferredPipeline();
  let project = {} as Project;
  const assets: Assets = { sideImg: null, frontImg: null, insMesh: null, srcMesh: null };
  let lastSent: PlainModel | undefined;
  let key: string | null = null;
  // the stage caches are cold until a build has run (a reply from the cache doesn't fill them)
  let built = false;
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
    key = null;
  };
  /** The result-cache key of the inputs as they stand. */
  const currentKey = () => (cache ? (key ??= resultKey(project, assets)) : null);
  const compute = (mode: EngineMode) => {
    let mapError: string | undefined;
    const f = frontWithMapFallback(front[mode], project, assets, (m) => (mapError = m));
    // while the carve runs, the checks and nesting wait for the carved plates
    const model = packPoints(modelToPlain(assemble(f, deferred(deferredInput(f, project), mode === 'preview' || f.shadowPending ? 'fast' : 'full'))));
    built = true;
    return { model, mapError, carving: !!f.shadowPending };
  };
  const build = (id: number, mode: EngineMode): EngineReply => {
    const t0 = performance.now();
    try {
      const k = mode === 'full' ? currentKey() : null;
      const hit = k ? cache!.peek(k) : undefined;
      if (hit) {
        const m = hit.model as PlainModel;
        const ms = performance.now() - t0;
        const model: PlainModel = { ...m, stages: [{ name: `Result cache (${hit.source})`, ms, cached: true }, ...m.stages.map((s) => ({ ...s, cached: true }))], totalMs: ms, stale: false };
        const delta = encodeDelta(lastSent, model);
        lastSent = model;
        return { id, mode: 'full', model: delta, ms, cached: hit.source };
      }
      if (mode === 'preview') shadow?.cancel();
      const { model, mapError, carving } = compute(mode);
      // only finished models: no preview, no carve still running, no stand-in for a map that failed
      if (k && !carving && !mapError) cache!.put(k, model);
      const delta = encodeDelta(lastSent, model);
      lastSent = model;
      return { id, mode, model: delta, mapError, ms: performance.now() - t0, ...(carving ? { carving } : {}) };
    } catch (e) {
      lastSent = undefined; // the page drops its copy too
      return { id, error: e instanceof Error ? e.message : String(e) };
    }
  };
  /** Fills the stage caches after a reply from the cache, so the next edit only rebuilds what it changes. */
  const warm = () => {
    if (built) return;
    if (shadow) shadow.quiet = true;
    try {
      compute('full');
    } catch {
      /* the next edit reports it */
    } finally {
      if (shadow) shadow.quiet = false;
    }
  };
  const handle = (reqs: EngineRequest[]): EngineReply => {
    reqs.forEach(apply);
    const { id, mode } = reqs[reqs.length - 1];
    return build(id, mode);
  };
  return Object.assign(handle, {
    apply,
    build,
    warm,
    key: currentKey,
    /** False until a build has filled the stage caches. */
    built: () => built,
  });
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
  /** The newest job answered: a carve that lands later answers it again. */
  private answered: EngineJob | null = null;

  constructor(
    private worker: Worker,
    private onResult: (job: EngineJob, model: Model, reply: EngineResult) => void,
    /** The worker couldn't do this job (fatal: it died, so stop using it). */
    private onFail: (job: EngineJob, fatal: boolean, error: string) => void,
  ) {
    worker.onmessage = (e: MessageEvent<EngineReply>) => {
      const reply = e.data;
      const job = this.jobs.find((j) => j.id === reply.id) ?? (this.answered?.id === reply.id ? this.answered : undefined);
      // that job and everything posted before it are answered
      this.jobs = this.jobs.filter((j) => j.id > reply.id);
      if ('error' in reply) {
        this.plain = undefined;
        this.sentProject = this.sentAssets = null; // resend everything next time
        if (job && !this.jobs.length) this.onFail(job, false, reply.error);
      } else {
        // every reply is a change to the one before, so each is folded in, shown or not
        this.plain = applyDelta(this.plain, reply.model);
        if (!job) return;
        this.answered = job;
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

  /** Hands the engine a shadow worker to carve on: the two talk directly over a channel of their own. */
  attachShadow(shadow: Worker) {
    const ch = new MessageChannel();
    shadow.postMessage({ port: ch.port2 }, [ch.port2]);
    this.worker.postMessage({ type: 'shadow-port', port: ch.port1 } satisfies EngineControl, [ch.port1]);
  }

  /** Forgets the results the engine keeps in memory (browser storage is cleared by the caller). */
  clearCache() {
    this.worker.postMessage({ type: 'clear-cache' } satisfies EngineControl);
  }

  /** True while an edit has been posted and not answered. */
  get working() {
    return this.jobs.length > 0;
  }

  terminate() {
    this.worker.terminate();
  }
}
