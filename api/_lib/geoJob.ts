/**
 * Cloud job requests (Boost), shared by the browser, the /api/geo routes and the
 * Modal worker bundle. Plain TypeScript with no Node imports, so all three load it.
 *
 * A job's key is a hash of the engine build and the request, so the same design at
 * the same engine is built once and then read from the cloud cache.
 */

/** Long edges the terrain job builds at. 2048 is the cloud size; 1024 matches the local build. */
export const TERRAIN_JOB_SIZES = [1024, 2048] as const;
export type TerrainJobSize = (typeof TERRAIN_JOB_SIZES)[number];

/** Largest bbox side the cloud builds, in degrees (about 35 km), so one job stays one job. */
export const TERRAIN_MAX_BBOX_DEG = 0.5;

/** Request bodies are a map spec and a few numbers; anything bigger is refused. */
export const GEO_JOB_MAX_BODY_BYTES = 64 * 1024;

/** Where results live in the private Blob store. */
export const RENDER_CACHE_PREFIX = 'render-cache/v1/';

/** Each artifact download is cut into parts under Vercel's 4.5 MB response limit. */
export const ARTIFACT_PART_BYTES = 3 * 1024 * 1024;

export interface TerrainJobStack {
  plateCount: number;
  thicknessMm: number;
  masterWidthMm: number;
  baseLengthMm?: number;
  baseWidthMm?: number;
  kerfMm?: number;
  sliceMode?: string;
  layerBudget?: string;
}

export interface TerrainJobRequest {
  kind: 'terrain';
  /** Engine build of the app that asked; the worker refuses a job from another build. */
  engine: string;
  /** The map spec without its build outputs (see `terrainJobSpec`). */
  spec: Record<string, unknown>;
  stack: TerrainJobStack;
  maxPx: TerrainJobSize;
}

/** A design uploaded for a pack or nest job: SHA-256 of the project file, sent gzipped in parts. */
export interface JobInput {
  sha: string;
  parts: number;
}

/** The fabrication zip, exactly as `cli export --zip` makes it. */
export interface PackJobRequest {
  kind: 'pack';
  engine: string;
  input: JobInput;
  /** Date on the build pack and the zip's files, YYYY-MM-DD. */
  date: string;
  /** The price rates the app uses (Settings), so the estimate in the pack matches. */
  rates?: Record<string, unknown>;
  /** Development only: the worker drops a plate from the zip when STRATA_ALLOW_FAULTS=1, to prove the app refuses it. */
  fault?: 'drop-plate';
}

/** A tight nest of the metal parts, for 30 s ('default') or 90 s ('tight'). */
export interface NestJobRequest {
  kind: 'nest';
  engine: string;
  input: JobInput;
  budget: 'default' | 'tight';
  seed?: number;
}

/** A camera in the 3D view's world (millimetres, y up), as src/core/hero.ts takes it. */
export interface HeroJobCamera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  aspect: number;
}

/** A photograph of the finished piece: Blender Cycles on the design's model.glb (Modal app strata-hero, an L4). */
export interface HeroJobRequest {
  kind: 'hero';
  engine: string;
  input: JobInput;
  camera: HeroJobCamera;
  light: 'studio' | 'daylight' | 'candle';
  /** Long edge of the picture in pixels. */
  px: number;
}

export type GeoJobRequest = TerrainJobRequest | PackJobRequest | NestJobRequest | HeroJobRequest;
export type GeoJobKind = GeoJobRequest['kind'];

export const NEST_BUDGET_MS: Record<NestJobRequest['budget'], number> = { default: 30_000, tight: 90_000 };

/** Uploads go in parts under Vercel's 4.5 MB request limit (base64 in JSON adds a third). */
export const INPUT_PART_BYTES = 2.5 * 1024 * 1024;
/** 40 MB of gzipped project is far beyond any design so far (Buttermere at 8 m is 2.8 MB before gzip). */
export const MAX_INPUT_PARTS = 16;
/** Largest upload request body. */
export const INPUT_MAX_BODY_BYTES = Math.ceil((INPUT_PART_BYTES * 4) / 3) + 1024;

export const SHA_RE = /^[0-9a-f]{64}$/;

/** What each kind of job leaves in the result store. */
export const ARTIFACT_FILES: Record<GeoJobKind, string> = { terrain: 'asset.json.gz', pack: 'pack.zip', nest: 'nest.json.gz', hero: 'hero.png' };

/** Hero renders a day (UTC), counted by the worker; a render answered from the cloud cache is free. */
export const HERO_DAILY_LIMIT = 10;
/** Long edge of a hero render. */
export const HERO_PX = 1600;
export const HERO_SAMPLES = 256;
/** Modal's 17 Oct 2026 rates: an L4 ($0.000222/s) with 4 cores and 16 GB, per second. worker/hero.py matches. */
export const HERO_RATE_PER_SECOND = 0.00031;
/** The render function's time limit, so the most one render can cost. */
export const HERO_MAX_SECONDS = 300;
/** A render with its start-up, as planned: a cold start of the Blender image, the scene, about a minute of Cycles. */
export const HERO_TYPICAL_SECONDS = 150;

/** What a hero render costs before it runs: the usual, and the most (its time limit). */
export function heroPrice(): { typicalUsd: number; maxUsd: number } {
  return { typicalUsd: HERO_TYPICAL_SECONDS * HERO_RATE_PER_SECOND, maxUsd: HERO_MAX_SECONDS * HERO_RATE_PER_SECOND };
}

/** Status of a job as /api/geo/jobs/:id reports it. */
export type GeoJobStatus =
  | { id: string; status: 'running'; progress: number; stage?: string }
  | { id: string; status: 'done'; key: string; px?: number; ms?: number; cached?: boolean; seconds?: number; costUsd?: number; meta?: Record<string, number>; fingerprint?: string }
  | { id: string; status: 'failed'; error: string; reason?: GeoRestReason }
  | { id: string; status: 'cancelled' };

/** Why the cloud is resting: shown in the status bar as "resting: …". */
export type GeoRestReason = 'not-configured' | 'unreachable' | 'out-of-date' | 'failed' | 'busy' | 'needs-input' | 'limit';

/** Build outputs and local-only fields that never go to the cloud or into the key. */
const SPEC_OUTPUT_FIELDS = new Set([
  'buildKey',
  'fetchedAt',
  'exaggerationFactor',
  'exaggerationReadout',
  'layerBreaksM',
  'simplifyLostFeatures',
  'resolvedSource',
  'sourceWarnings',
  'engraveArt',
  'cloudBuilt',
  'cloudRes',
  'cacheDir',
  'crs',
]);

/** The parts of a map spec the build reads. */
export function terrainJobSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) if (!SPEC_OUTPUT_FIELDS.has(k) && v !== undefined) out[k] = v;
  return out;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const vec3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(finite) && v.every((x) => Math.abs(x) < 1e7);

function validateCamera(raw: unknown): HeroJobCamera | null {
  const c = raw as Record<string, unknown> | null;
  if (!c || typeof c !== 'object' || !vec3(c.position) || !vec3(c.target) || !vec3(c.up)) return null;
  if (!finite(c.fov) || c.fov < 5 || c.fov > 120 || !finite(c.aspect) || c.aspect < 0.25 || c.aspect > 4) return null;
  const [px, py, pz] = c.position;
  const [tx, ty, tz] = c.target;
  if (Math.hypot(px - tx, py - ty, pz - tz) < 1e-3 || Math.hypot(...c.up) < 1e-6) return null;
  // rounded so a camera nudged by a rounding error still finds the cached render
  const r = (v: [number, number, number]) => v.map((x) => Math.round(x * 100) / 100) as [number, number, number];
  return { position: r(c.position), target: r(c.target), up: r(c.up), fov: Math.round(c.fov * 100) / 100, aspect: Math.round(c.aspect * 1000) / 1000 };
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function validateInput(raw: unknown): JobInput | null {
  const i = raw as Record<string, unknown> | null;
  if (!i || typeof i !== 'object' || typeof i.sha !== 'string' || !SHA_RE.test(i.sha)) return null;
  if (!Number.isInteger(i.parts) || (i.parts as number) < 1 || (i.parts as number) > MAX_INPUT_PARTS) return null;
  return { sha: i.sha, parts: i.parts as number };
}

/** Check a request body before anything is spent on it. */
export function validateGeoJobRequest(raw: unknown): Validated<GeoJobRequest> {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return { ok: false, error: 'Request must be a JSON object' };
  if (o.kind !== 'terrain' && o.kind !== 'pack' && o.kind !== 'nest' && o.kind !== 'hero') return { ok: false, error: 'Unknown job kind' };
  if (typeof o.engine !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.engine)) return { ok: false, error: 'Missing engine build' };
  if (o.kind === 'pack' || o.kind === 'nest' || o.kind === 'hero') {
    const input = validateInput(o.input);
    if (!input) return { ok: false, error: `input must be {sha, parts} with 1 to ${MAX_INPUT_PARTS} parts` };
    if (o.kind === 'hero') {
      const camera = validateCamera(o.camera);
      if (!camera) return { ok: false, error: 'camera must be {position, target, up, fov, aspect}' };
      if (o.light !== 'studio' && o.light !== 'daylight' && o.light !== 'candle') return { ok: false, error: "light must be 'studio', 'daylight' or 'candle'" };
      if (!Number.isInteger(o.px) || (o.px as number) < 256 || (o.px as number) > 2400) return { ok: false, error: 'px must be 256 to 2400' };
      return { ok: true, value: { kind: 'hero', engine: o.engine, input, camera, light: o.light, px: o.px as number } };
    }
    if (o.kind === 'nest') {
      if (o.budget !== 'default' && o.budget !== 'tight') return { ok: false, error: "budget must be 'default' or 'tight'" };
      if (o.seed != null && !(Number.isInteger(o.seed) && (o.seed as number) >= 0 && (o.seed as number) < 2 ** 31)) return { ok: false, error: 'seed out of range' };
      return { ok: true, value: { kind: 'nest', engine: o.engine, input, budget: o.budget, ...(o.seed != null ? { seed: o.seed as number } : {}) } };
    }
    if (typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.date) || Number.isNaN(Date.parse(`${o.date}T00:00:00Z`))) return { ok: false, error: 'date must be YYYY-MM-DD' };
    if (o.rates != null && (typeof o.rates !== 'object' || Array.isArray(o.rates))) return { ok: false, error: 'rates must be an object' };
    if (o.fault != null && o.fault !== 'drop-plate') return { ok: false, error: 'Unknown fault' };
    return {
      ok: true,
      value: {
        kind: 'pack',
        engine: o.engine,
        input,
        date: o.date,
        ...(o.rates ? { rates: o.rates as Record<string, unknown> } : {}),
        ...(o.fault ? { fault: o.fault as 'drop-plate' } : {}),
      },
    };
  }
  if (!TERRAIN_JOB_SIZES.includes(o.maxPx as TerrainJobSize)) return { ok: false, error: `maxPx must be one of ${TERRAIN_JOB_SIZES.join(', ')}` };
  const spec = o.spec as Record<string, unknown> | null;
  if (!spec || typeof spec !== 'object' || spec.kind !== 'map') return { ok: false, error: 'spec must be a map spec' };
  const bbox = spec.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(finite)) return { ok: false, error: 'spec.bbox must be four numbers' };
  const [w, s, e, n] = bbox as number[];
  if (!(w < e && s < n && w >= -180 && e <= 180 && s >= -85 && n <= 85)) return { ok: false, error: 'spec.bbox is not a west, south, east, north box' };
  if (e - w > TERRAIN_MAX_BBOX_DEG || n - s > TERRAIN_MAX_BBOX_DEG) return { ok: false, error: `The cloud builds areas up to ${TERRAIN_MAX_BBOX_DEG}° across` };
  const st = o.stack as Record<string, unknown> | null;
  if (!st || typeof st !== 'object') return { ok: false, error: 'Missing plate stack' };
  if (!finite(st.plateCount) || st.plateCount < 1 || st.plateCount > 2000) return { ok: false, error: 'stack.plateCount out of range' };
  if (!finite(st.thicknessMm) || st.thicknessMm <= 0) return { ok: false, error: 'stack.thicknessMm out of range' };
  if (!finite(st.masterWidthMm) || st.masterWidthMm <= 0) return { ok: false, error: 'stack.masterWidthMm out of range' };
  return {
    ok: true,
    value: { kind: 'terrain', engine: o.engine, spec: terrainJobSpec(spec), stack: st as unknown as TerrainJobStack, maxPx: o.maxPx as TerrainJobSize },
  };
}

/** JSON with object keys sorted, so equal requests hash equally. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** The cache key of a job: 32 hex characters of SHA-256 over the engine build and the request. */
export async function geoJobKey(req: GeoJobRequest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ v: 1, ...req }));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export const GEO_KEY_RE = /^[0-9a-f]{32}$/;

/** Blob path of a finished job's result: the terrain asset (gzip JSON) unless another file is named. */
export function artifactPath(key: string, file = ARTIFACT_FILES.terrain): string {
  if (!GEO_KEY_RE.test(key)) throw new Error('Invalid result key');
  if (!Object.values(ARTIFACT_FILES).includes(file)) throw new Error('Invalid result file');
  return `${RENDER_CACHE_PREFIX}${key}/${file}`;
}

/** Blob path of one part of an uploaded design. */
export function inputPartPath(input: JobInput, part: number): string {
  if (!SHA_RE.test(input.sha)) throw new Error('Invalid input');
  if (!Number.isInteger(part) || part < 0 || part >= input.parts || input.parts > MAX_INPUT_PARTS) throw new Error('Invalid input part');
  return `${RENDER_CACHE_PREFIX}inputs/${input.sha}/${part}-of-${input.parts}`;
}
