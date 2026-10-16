// "Depth from photo": sends a photo to the Depth Pro endpoint (Modal worker in
// promptda-depth-generator) and gets back a grey relief plate in Strata's
// convention: near subject = dark, background = white. When the service sends
// the metric depth too, it is kept on the image and turned into the grey grid
// here, so near / far / curve / resolution can change without asking again.
import type { Gray } from './image';

export type DepthMode = 'relief' | 'depth';

/** Endpoint URL, e.g. https://<workspace>--strata-depth.modal.run/strata. Unset = feature off. */
export const DEPTH_URL: string | undefined = (import.meta.env?.VITE_DEPTH_URL as string | undefined)?.trim() || undefined;

/** How the metric depth becomes a brightness grid. Distances in metres. */
export interface DepthSettings {
  /** Anything nearer than this is full height. */
  near: number;
  /** Anything farther than this is background (white, left uncut). */
  far: number;
  /** perspective = even in 1/distance (like the eye sees; detail up close), linear = even in metres. */
  spacing: 'perspective' | 'linear';
  /** Exponent on the 0..1 height: below 1 lifts the low parts, above 1 sinks them. */
  curve: number;
  /** 0..1 bas-relief squash: flattens big shapes while keeping fine detail. */
  flatten: number;
  /** Use the service's subject cut-out (background left white). */
  matte: boolean;
  /** Longest side of the grid the pipeline sees, in pixels. */
  resolution: number;
  /** near = light instead of dark (the side profile reads bright as high). */
  invert: boolean;
}

/** Metric depth as sent by the service: uint16 per pixel, 0 = no depth, 1..65535 linear over minM..maxM. */
export interface DepthData {
  w: number;
  h: number;
  minM: number;
  maxM: number;
  /** The window the service's own grey plate used, for "Auto". */
  nearM: number;
  farM: number;
  /** base64 little-endian uint16 */
  data: string;
  /** base64 uint8 subject matte (255 = keep), when the service made one */
  mask?: string;
  settings: DepthSettings;
}

export const DEPTH_RESOLUTIONS = [128, 256, 384, 512];

export interface DepthResult {
  png: string;
  width: number;
  height: number;
  coldStart: boolean;
  depth?: Omit<DepthData, 'settings'>;
}

export function defaultDepthSettings(d: Pick<DepthData, 'nearM' | 'farM'>, invert = false): DepthSettings {
  return { near: d.nearM, far: d.farM, spacing: 'perspective', curve: 1, flatten: 0, matte: true, resolution: 256, invert };
}

function parseDepthData(raw: unknown): Omit<DepthData, 'settings'> | undefined {
  const d = (raw ?? null) as Record<string, unknown> | null;
  if (!d || typeof d.data !== 'string') return undefined;
  const w = Number(d.w);
  const h = Number(d.h);
  const minM = Number(d.min_m);
  const maxM = Number(d.max_m);
  if (!(w >= 1 && h >= 1 && maxM > minM && minM >= 0)) return undefined;
  const nearM = Number(d.near_m) || minM;
  const farM = Number(d.far_m) || maxM;
  return { w, h, minM, maxM, nearM, farM, data: d.data, ...(typeof d.mask === 'string' ? { mask: d.mask } : {}) };
}

export function parseDepthResponse(body: unknown): DepthResult {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.png !== 'string' || !b.png.startsWith('data:image/png;base64,')) {
    throw new Error(typeof b.detail === 'string' ? b.detail : 'Depth service returned no image');
  }
  const depth = parseDepthData(b.depth);
  return { png: b.png, width: Number(b.width) || 0, height: Number(b.height) || 0, coldStart: !!b.cold_start, ...(depth ? { depth } : {}) };
}

export async function depthFromPhoto(
  photo: string,
  opts: { mode?: DepthMode; url?: string; signal?: AbortSignal } = {},
): Promise<DepthResult> {
  const url = opts.url ?? DEPTH_URL;
  if (!url) throw new Error('Depth service not configured (set VITE_DEPTH_URL)');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: photo, mode: opts.mode ?? 'relief', max_side: 512, return_depth: true, depth_side: 512 }),
    signal: opts.signal,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // fall through to the status error
  }
  if (!res.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail;
    throw new Error(typeof detail === 'string' ? detail : `Depth service error ${res.status}`);
  }
  return parseDepthResponse(body);
}

// The service's container takes ~45 s to boot cold and stays up 5 min after its
// last request (scaledown_window=300 in modal_app/worker.py).
const WAKE_EVERY = 4 * 60_000;
let wokeAt = -Infinity;

/**
 * Nudge the depth service awake so its cold start overlaps with picking a photo.
 * The endpoint only answers POST /strata, but any request boots the container,
 * so this is a plain no-cors GET (no preflight, opaque answer, a 405 is fine).
 * At most once every few minutes; never throws, never waits.
 */
export function wakeDepth(url: string | undefined = DEPTH_URL, now = Date.now()): boolean {
  if (!url || typeof fetch === 'undefined' || now - wokeAt < WAKE_EVERY) return false;
  wokeAt = now;
  try {
    fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit', keepalive: true }).catch(() => {});
  } catch {
    // a bad URL or a browser without fetch options: nothing to wake
  }
  return true;
}

/** Flip a grey PNG (near = dark → near = bright), for slots that read bright as high. */
export async function invertDataUrl(dataUrl: string): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height);
  for (let i = 0; i < px.data.length; i += 4) {
    px.data[i] = 255 - px.data[i];
    px.data[i + 1] = 255 - px.data[i + 1];
    px.data[i + 2] = 255 - px.data[i + 2];
  }
  ctx.putImageData(px, 0, 0);
  return cv.toDataURL('image/png');
}

function b64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const decoded = new Map<string, { metres: Float32Array; mask: Float32Array | null }>();

/** Metres per pixel (NaN = no depth) and the 0..1 matte, decoded once per depth map. */
function decodeDepth(d: DepthData) {
  const key = `${d.w}x${d.h}:${d.data.length}:${d.data.slice(0, 48)}${d.data.slice(-48)}:${d.mask?.length ?? 0}:${d.mask?.slice(0, 48) ?? ''}${d.mask?.slice(-48) ?? ''}`;
  let hit = decoded.get(key);
  if (!hit) {
    const bytes = b64Bytes(d.data);
    const n = d.w * d.h;
    const metres = new Float32Array(n);
    const k = (d.maxM - d.minM) / 65534;
    for (let i = 0; i < n; i++) {
      const q = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
      metres[i] = q === 0 ? NaN : d.minM + (q - 1) * k;
    }
    let mask: Float32Array | null = null;
    if (d.mask) {
      const mb = b64Bytes(d.mask);
      mask = new Float32Array(n);
      for (let i = 0; i < n; i++) mask[i] = (mb[i] ?? 255) / 255;
    }
    hit = { metres, mask };
    if (decoded.size > 6) decoded.delete(decoded.keys().next().value!);
    decoded.set(key, hit);
  }
  return hit;
}

/** Area-average a w×h field down so its longest side is at most `side`. */
function shrink(src: Float32Array, w: number, h: number, side: number): { w: number; h: number; data: Float32Array } {
  const k = Math.min(1, side / Math.max(w, h));
  if (k >= 1) return { w, h, data: src };
  const ow = Math.max(2, Math.round(w * k));
  const oh = Math.max(2, Math.round(h * k));
  const out = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor((y * h) / oh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / oh));
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor((x * w) / ow);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / ow));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src[yy * w + xx];
      out[y * ow + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return { w: ow, h: oh, data: out };
}

/** Separable box blur, radius r px, three passes (close to a gaussian). */
function blur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src;
  let a = src;
  for (let pass = 0; pass < 3; pass++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / (2 * r + 1);
        acc += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    a = out;
  }
  return a;
}

/**
 * The depth map as Strata's brightness grid: near = dark (or light when
 * inverted), farther than `far`, no depth or cut out by the matte = white.
 */
export function depthToGray(d: DepthData, s: DepthSettings = d.settings): Gray {
  const { metres, mask } = decodeDepth(d);
  const n = d.w * d.h;
  const near = Math.max(1e-3, Math.min(s.near, s.far - 1e-3));
  const far = Math.max(near + 1e-3, s.far);
  const persp = s.spacing !== 'linear';
  const hNear = persp ? 1 / near : -near;
  const hFar = persp ? 1 / far : -far;
  const height = new Float32Array(n);
  const keep = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = metres[i];
    if (!(m > 0) || m > far) continue;
    const v = persp ? 1 / m : -m;
    height[i] = Math.min(1, Math.max(0, (v - hFar) / (hNear - hFar)));
    keep[i] = s.matte && mask ? mask[i] : 1;
  }
  const side = Math.max(16, Math.round(s.resolution) || 256);
  const H = shrink(height, d.w, d.h, side);
  const K = shrink(keep, d.w, d.h, side);
  const { w, h } = H;
  let data = H.data;
  const curve = s.curve > 0 ? s.curve : 1;
  if (curve !== 1) data = data.map((v) => Math.pow(v, curve));
  if (s.flatten > 0) {
    // squash the broad shape, lift what sits on it, then stretch back to 0..1 over the subject
    // blur over the subject only, so the background doesn't drag its edges down
    const r = Math.max(2, Math.round(Math.max(w, h) / 12));
    const inside = K.data.map((k) => (k > 0.5 ? 1 : 0));
    const num = blur(data.map((v, i) => v * inside[i]), w, h, r);
    const den = blur(inside, w, h, r);
    const base = num.map((v, i) => (den[i] > 1e-6 ? v / den[i] : 0));
    const f = Math.min(1, s.flatten);
    const out = new Float32Array(w * h);
    let hi = 0;
    for (let i = 0; i < out.length; i++) {
      out[i] = K.data[i] > 0.5 ? Math.max(0, (1 - f) * base[i] + (data[i] - base[i]) * (1 + 2 * f)) : 0;
      if (out[i] > hi) hi = out[i];
    }
    if (hi > 1e-6) for (let i = 0; i < out.length; i++) out[i] = Math.min(1, out[i] / hi);
    data = out;
  }
  const grey = new Float32Array(w * h);
  for (let i = 0; i < grey.length; i++) {
    const v = data[i] * Math.min(1, K.data[i]);
    grey[i] = s.invert ? v : 1 - v;
  }
  return { w, h, data: grey };
}
