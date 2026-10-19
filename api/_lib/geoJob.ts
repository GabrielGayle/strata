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

export type GeoJobRequest = TerrainJobRequest;

/** Status of a job as /api/geo/jobs/:id reports it. */
export type GeoJobStatus =
  | { id: string; status: 'running'; progress: number; stage?: string }
  | { id: string; status: 'done'; key: string; px?: number; ms?: number; cached?: boolean }
  | { id: string; status: 'failed'; error: string; reason?: GeoRestReason }
  | { id: string; status: 'cancelled' };

/** Why the cloud is resting: shown in the status bar as "resting: …". */
export type GeoRestReason = 'not-configured' | 'unreachable' | 'out-of-date' | 'failed' | 'busy';

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

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** Check a request body before anything is spent on it. */
export function validateGeoJobRequest(raw: unknown): Validated<GeoJobRequest> {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return { ok: false, error: 'Request must be a JSON object' };
  if (o.kind !== 'terrain') return { ok: false, error: 'Unknown job kind' };
  if (typeof o.engine !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.engine)) return { ok: false, error: 'Missing engine build' };
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

/** Blob path of a finished job's result (gzip JSON of the asset). */
export function artifactPath(key: string): string {
  if (!GEO_KEY_RE.test(key)) throw new Error('Invalid result key');
  return `${RENDER_CACHE_PREFIX}${key}/asset.json.gz`;
}
