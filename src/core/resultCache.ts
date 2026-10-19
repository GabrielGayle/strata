// Finished models remembered by what they were built from, so undo, redo, compare
// and reopening a design show the result without running the pipeline again.
//
// The key is a 128-bit hash over the engine build, every project field the
// engine reads, and the decoded assets. Fields are hashed one at a time and
// remembered by identity, so an edit only hashes what it changed. Models are
// kept as the engine worker posts them (plain data, point lists packed): a
// few in memory for undo and redo, and more in browser storage (see
// resultCacheIdb.ts) for reloads and reopened designs.
import type { Project } from './project';
import { ASSET_KEYS, type Assets } from './pipeline';

declare const __STRATA_ENGINE__: string | undefined;

/** The engine's own version: a hash of src/core and the locked dependencies, set at build time. A new engine never reads an old result. */
export const ENGINE_BUILD = typeof __STRATA_ENGINE__ === 'string' ? __STRATA_ENGINE__ : 'dev';

/** Project fields the engine never reads: renaming, locking a value or saving a variant keeps the result. */
export const UNKEYED_FIELDS: readonly string[] = ['name', 'locks', 'variants', 'composition', 'savedView', 'hero'];

// ---- a 128-bit hash (MurmurHash3 x86_128 over 32-bit words; not for secrets) ----

const C1 = 0x239b961b;
const C2 = 0xab0e9789;
const C3 = 0x38b34ae5;
const C4 = 0xa1e38b93;
const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));
const fmix = (h: number) => {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
};
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

export class Hash128 {
  private h1 = 0x5f3759df;
  private h2 = 0x2545f491;
  private h3 = 0x9e3779b9;
  private h4 = 0x7f4a7c15;
  private k = [0, 0, 0, 0];
  private n = 0;
  private words = 0;

  word(w: number) {
    this.k[this.n++] = w | 0;
    this.words++;
    if (this.n === 4) this.block();
  }

  private block() {
    let [k1, k2, k3, k4] = this.k;
    let { h1, h2, h3, h4 } = this;
    k1 = Math.imul(rotl(Math.imul(k1, C1), 15), C2);
    h1 ^= k1;
    h1 = (Math.imul(rotl(h1, 19) + h2, 5) + 0x561ccd1b) | 0;
    k2 = Math.imul(rotl(Math.imul(k2, C2), 16), C3);
    h2 ^= k2;
    h2 = (Math.imul(rotl(h2, 17) + h3, 5) + 0x0bcaa747) | 0;
    k3 = Math.imul(rotl(Math.imul(k3, C3), 17), C4);
    h3 ^= k3;
    h3 = (Math.imul(rotl(h3, 15) + h4, 5) + 0x96cd1c35) | 0;
    k4 = Math.imul(rotl(Math.imul(k4, C4), 18), C1);
    h4 ^= k4;
    h4 = (Math.imul(rotl(h4, 13) + h1, 5) + 0x32ac3b17) | 0;
    Object.assign(this, { h1, h2, h3, h4 });
    this.k.fill(0);
    this.n = 0;
  }

  num(x: number) {
    f64[0] = x;
    this.word(u32[0]);
    this.word(u32[1]);
  }

  str(s: string) {
    this.word(s.length);
    const n = s.length;
    let i = 0;
    for (; i + 1 < n; i += 2) this.word(s.charCodeAt(i) | (s.charCodeAt(i + 1) << 16));
    if (i < n) this.word(s.charCodeAt(i));
  }

  bytes(v: ArrayBufferView) {
    this.word(v.byteLength);
    const whole = v.byteLength >> 2;
    if (v.byteOffset % 4 === 0) {
      const w = new Int32Array(v.buffer, v.byteOffset, whole);
      for (let i = 0; i < whole; i++) this.word(w[i]);
    } else {
      const b = new Uint8Array(v.buffer, v.byteOffset, whole * 4);
      for (let i = 0; i < b.length; i += 4) this.word(b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));
    }
    const tail = new Uint8Array(v.buffer, v.byteOffset + whole * 4, v.byteLength - whole * 4);
    let t = 0;
    tail.forEach((x, i) => (t |= x << (i * 8)));
    if (tail.length) this.word(t);
  }

  digest(): string {
    if (this.n) this.block();
    let { h1, h2, h3, h4 } = this;
    h1 ^= this.words;
    h2 ^= this.words;
    h3 ^= this.words;
    h4 ^= this.words;
    h1 = (h1 + h2 + h3 + h4) | 0;
    h2 = (h2 + h1) | 0;
    h3 = (h3 + h1) | 0;
    h4 = (h4 + h1) | 0;
    h1 = fmix(h1);
    h2 = fmix(h2);
    h3 = fmix(h3);
    h4 = fmix(h4);
    h1 = (h1 + h2 + h3 + h4) | 0;
    h2 = (h2 + h1) | 0;
    h3 = (h3 + h1) | 0;
    h4 = (h4 + h1) | 0;
    return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
  }
}

// ---- hashing values ----

const digests = new WeakMap<object, string>();

/** Feeds a value into `h`: key order doesn't matter, undefined properties are skipped (as in a saved file), typed arrays go in as bytes. */
function feed(h: Hash128, x: unknown) {
  if (x === undefined || x === null) return h.word(x === null ? 1 : 0);
  switch (typeof x) {
    case 'boolean':
      return h.word(x ? 3 : 2);
    case 'number':
      h.word(4);
      return h.num(x);
    case 'string':
      h.word(5);
      return h.str(x);
    case 'object':
      break;
    default:
      throw new Error(`Can't key a ${typeof x}`);
  }
  // big parts are hashed once each and remembered (an image, a mesh, a field the edit didn't touch)
  h.word(6);
  h.str(digestOf(x as object));
}

function feedObject(h: Hash128, x: object) {
  if (ArrayBuffer.isView(x)) {
    h.str(x.constructor.name);
    return h.bytes(x);
  }
  if (Array.isArray(x)) {
    h.word(7);
    h.word(x.length);
    for (const e of x) feed(h, e);
    return;
  }
  // a mesh: only what it is made of (not its id or name)
  const g = x as { isBufferGeometry?: boolean; attributes?: Record<string, { array: ArrayLike<number>; itemSize: number }>; index?: { array: ArrayLike<number> } | null };
  if (g.isBufferGeometry) {
    h.word(8);
    for (const k of Object.keys(g.attributes!).sort()) {
      h.str(k);
      h.word(g.attributes![k].itemSize);
      feed(h, g.attributes![k].array);
    }
    return feed(h, g.index ? g.index.array : null);
  }
  h.word(9);
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o).sort()) {
    if (o[k] === undefined) continue;
    h.str(k);
    feed(h, o[k]);
  }
}

/** The hash of one value, remembered for as long as the object lives. */
export function digestOf(x: object): string {
  let d = digests.get(x);
  if (!d) {
    const h = new Hash128();
    feedObject(h, x);
    digests.set(x, (d = h.digest()));
  }
  return d;
}

/** The cache key for building `project` with `assets` on this engine build. */
export function resultKey(project: Project, assets: Assets): string {
  const h = new Hash128();
  h.str(ENGINE_BUILD);
  const p = project as unknown as Record<string, unknown>;
  for (const k of Object.keys(p).sort()) {
    if (p[k] === undefined || UNKEYED_FIELDS.includes(k)) continue;
    h.str(k);
    feed(h, p[k]);
  }
  for (const k of ASSET_KEYS) {
    h.str(k);
    feed(h, (assets as unknown as Record<string, unknown>)[k] ?? null);
  }
  return h.digest();
}

// ---- size ----

/** Roughly how many bytes a model takes (typed arrays exactly, the rest estimated). */
export function approxBytes(x: unknown): number {
  const seen = new Set<object>();
  let n = 0;
  const walk = (v: unknown) => {
    if (typeof v === 'string') n += 16 + v.length * 2;
    else if (typeof v !== 'object' || v === null) n += 8;
    else if (!seen.has(v)) {
      seen.add(v);
      if (ArrayBuffer.isView(v)) n += 64 + v.byteLength;
      else if (Array.isArray(v)) {
        n += 32;
        for (const e of v) walk(e);
      } else {
        n += 32;
        for (const k in v) {
          n += 8;
          walk((v as Record<string, unknown>)[k]);
        }
      }
    }
  };
  walk(x);
  return n;
}

// ---- the store ----

/** Where results outlive the page (IndexedDB in the browser; see resultCacheIdb.ts). */
export interface DiskStore {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, model: unknown, bytes: number): Promise<void>;
  clear(): Promise<void>;
  usage(): Promise<{ entries: number; bytes: number }>;
}

export type CacheSource = 'memory' | 'disk';

/** In memory, most recent last, within a byte budget; and on disk when there is one. */
export class ResultCache {
  private mem = new Map<string, { model: unknown; bytes: number; source: CacheSource }>();
  private memBytes = 0;
  readonly disk: DiskStore | null;
  private memoryBudget: number;
  /** Plain-data check of a cached model before it is used (a damaged entry is dropped). */
  private valid: (model: unknown) => boolean;

  constructor(opts: { disk?: DiskStore | null; memoryBytes?: number; valid?: (model: unknown) => boolean } = {}) {
    this.disk = opts.disk ?? null;
    this.memoryBudget = opts.memoryBytes ?? 160e6;
    this.valid = opts.valid ?? (() => true);
  }

  has(key: string) {
    return this.mem.has(key);
  }

  /** The model for `key` if it is in memory, and where it first came from (once: after that it counts as memory). */
  peek(key: string): { model: unknown; source: CacheSource } | undefined {
    const e = this.mem.get(key);
    if (!e) return undefined;
    this.mem.delete(key);
    this.mem.set(key, { ...e, source: 'memory' });
    return { model: e.model, source: e.source };
  }

  /** Brings a model in from disk; true when it was there. */
  async load(key: string): Promise<boolean> {
    if (this.mem.has(key)) return true;
    if (!this.disk) return false;
    try {
      const model = await this.disk.get(key);
      if (model === undefined || !this.valid(model)) return false;
      this.remember(key, model, approxBytes(model), 'disk');
      return true;
    } catch {
      return false;
    }
  }

  /** Keeps a finished model, in memory now and on disk in the background. */
  put(key: string, model: unknown) {
    const bytes = approxBytes(model);
    this.remember(key, model, bytes, 'memory');
    this.disk?.put(key, model, bytes).catch(() => {
      /* storage full or unavailable: memory still has it */
    });
  }

  clearMemory() {
    this.mem.clear();
    this.memBytes = 0;
  }

  private remember(key: string, model: unknown, bytes: number, source: CacheSource) {
    const old = this.mem.get(key);
    if (old) this.memBytes -= old.bytes;
    this.mem.delete(key);
    this.mem.set(key, { model, bytes, source });
    this.memBytes += bytes;
    for (const [k, e] of this.mem) {
      if (this.memBytes <= this.memoryBudget || this.mem.size <= 1) break;
      this.mem.delete(k);
      this.memBytes -= e.bytes;
    }
  }
}
