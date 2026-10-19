// Image → plate data. Images are reduced to a small brightness grid; all the
// processing here is pure so it can run (and be tested) anywhere.
import type { Path } from './geom2d';
import { blurImage, type BlurSpec } from './blur';

export interface Gray {
  w: number;
  h: number;
  /** Brightness 0 (black) … 1 (white), row-major, row 0 = top of image. */
  data: Float32Array;
  /** Opacity 0..1 per pixel, only present when the source image had transparency. */
  alpha?: Float32Array;
}

export interface ImageOpts {
  contrast: number;
  smooth: number;
  /** Blur type and its settings; without it `smooth` is the plain soft blur. */
  blur?: BlurSpec;
  invert: boolean;
  rotate: number; // 0 | 90 | 180 | 270
  /** Depth maps: contrast eases into black and white instead of clipping, so the highest and lowest forms stay round. */
  soft?: boolean;
}

/**
 * Contrast for a depth map: the straight stretch in the middle, and instead of
 * clipping, a knee at each end that bends the stretched range onto exactly 0..1
 * (rising all the way, level only at the very brightest and darkest point), so
 * the highest and lowest forms keep their shape and the backdrop stays 0.
 */
export function softContrast(v: number, contrast: number): number {
  const c = Math.max(1, contrast);
  const x = (v - 0.5) * c + 0.5;
  if (c === 1) return Math.min(1, Math.max(0, x));
  const w = Math.min(0.5, Math.max(0.1, (c - 1) / 4)); // knee width in the output
  const e = (c - 1) / 2 + w; // the stretched input the knee takes in
  const knee = (d: number) => {
    // cubic Hermite from (0, 0) with slope s to (e, w) with slope 0; s ≤ 3w/e keeps it rising
    const t = Math.min(1, Math.max(0, d / e));
    const m0 = Math.min(1, (3 * w) / e) * e;
    return (t * t * t - 2 * t * t + t) * m0 + (-2 * t * t * t + 3 * t * t) * w;
  };
  if (x > 1 - w) return 1 - w + knee(x - (1 - w));
  if (x < w) return w - knee(w - x);
  return x;
}

/** Longest side capped at `maxSide`, at least 2×2. Same size the browser canvas is drawn at. */
export function scaledSize(sw: number, sh: number, maxSide: number): { w: number; h: number } {
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  return { w: Math.max(2, Math.round(sw * k)), h: Math.max(2, Math.round(sh * k)) };
}

/** Brightness grid from RGBA pixels. Transparent areas read as a white background. */
export function grayFromRgba(px: ArrayLike<number>, w: number, h: number): Gray {
  const data = new Float32Array(w * h);
  const alpha = new Float32Array(w * h);
  let clear = false;
  for (let i = 0; i < w * h; i++) {
    const a = px[i * 4 + 3] / 255;
    const lum = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
    data[i] = lum * a + (1 - a);
    alpha[i] = a;
    if (a < 0.98) clear = true;
  }
  return clear ? { w, h, data, alpha } : { w, h, data };
}

const hasDom = () => typeof document !== 'undefined' && typeof Image !== 'undefined';

type NodeDecode = (dataUrl: string, maxSide: number) => Gray | Promise<Gray>;
let nodeDecode: NodeDecode | undefined;

/**
 * PNG/JPEG decoding for Node (see imageNode.ts). The browser uses canvas.
 * The CLI installs this on startup; keeping the import out of this file means
 * the client bundle does not include it.
 */
export function setNodeImageDecoder(fn: NodeDecode) {
  nodeDecode = fn;
}

async function decodeImageDom(dataUrl: string, maxSide: number): Promise<Gray> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const { w, h } = scaledSize(img.width, img.height, maxSide);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  return grayFromRgba(ctx.getImageData(0, 0, w, h).data, w, h);
}

export async function decodeImage(dataUrl: string, maxSide = 256): Promise<Gray> {
  if (hasDom()) return decodeImageDom(dataUrl, maxSide);
  if (!nodeDecode) throw new Error('No image decoder (browser canvas, or setNodeImageDecoder in Node)');
  return nodeDecode(dataUrl, maxSide);
}

export function rotate(g: Gray, deg: number): Gray {
  const r = ((Math.round(deg / 90) % 4) + 4) % 4;
  if (r === 0) return g;
  const w = r % 2 ? g.h : g.w;
  const h = r % 2 ? g.w : g.h;
  const turn = (src: Float32Array) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++) {
        let nx: number, ny: number;
        if (r === 1) {
          nx = g.h - 1 - y;
          ny = x;
        } else if (r === 2) {
          nx = g.w - 1 - x;
          ny = g.h - 1 - y;
        } else {
          nx = y;
          ny = g.w - 1 - x;
        }
        out[ny * w + nx] = src[y * g.w + x];
      }
    return out;
  };
  return g.alpha ? { w, h, data: turn(g.data), alpha: turn(g.alpha) } : { w, h, data: turn(g.data) };
}

export function boxBlur(g: Gray, r: number): Gray {
  if (r <= 0) return g;
  let src = g.data;
  const { w, h } = g;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = Math.min(w - 1, Math.max(0, x + k));
          s += src[y * w + xx];
          n++;
        }
        tmp[y * w + x] = s / n;
      }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k));
          s += tmp[yy * w + x];
          n++;
        }
        out[y * w + x] = s / n;
      }
    src = out;
  }
  return { w, h, data: src };
}

export function processImage(g: Gray, o: ImageOpts): Gray {
  let r = rotate(g, o.rotate);
  r = o.blur ? blurImage(r, { ...o.blur, size: o.smooth }) : boxBlur(r, Math.round(o.smooth));
  const data = new Float32Array(r.data.length);
  for (let i = 0; i < data.length; i++) {
    let v = r.data[i];
    if (o.invert) v = 1 - v;
    if (o.soft && o.contrast > 1) {
      data[i] = softContrast(v, o.contrast);
      continue;
    }
    v = (v - 0.5) * o.contrast + 0.5;
    data[i] = Math.min(1, Math.max(0, v));
  }
  return { w: r.w, h: r.h, data };
}

/** Bilinear brightness at fractional coordinates (fx, fy in 0..1, fy = 0 at the top). */
export function sample(g: Gray, fx: number, fy: number): number {
  const x = Math.min(g.w - 1, Math.max(0, fx * (g.w - 1)));
  const y = Math.min(g.h - 1, Math.max(0, fy * (g.h - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(g.w - 1, x0 + 1), y1 = Math.min(g.h - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const a = g.data[y0 * g.w + x0], b = g.data[y0 * g.w + x1];
  const c = g.data[y1 * g.w + x0], d = g.data[y1 * g.w + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** For each column, the height (0..1) of the topmost dark pixel: the traced silhouette. */
export function silhouetteProfile(g: Gray, threshold = 0.5): Float32Array {
  const out = new Float32Array(g.w);
  for (let x = 0; x < g.w; x++) {
    let top = g.h;
    for (let y = 0; y < g.h; y++)
      if (g.data[y * g.w + x] < threshold) {
        top = y;
        break;
      }
    out[x] = 1 - top / g.h;
  }
  return out;
}

export function sampleProfile(p: Float32Array, f: number): number {
  const x = Math.min(p.length - 1, Math.max(0, f * (p.length - 1)));
  const x0 = Math.floor(x);
  const x1 = Math.min(p.length - 1, x0 + 1);
  return p[x0] + (p[x1] - p[x0]) * (x - x0);
}

/**
 * Marching squares on a scalar field (rows of values). Returns closed loops around
 * regions where value > 0, in grid coordinates (x = column, y = row). The field
 * is padded with negative values so every contour closes.
 */
export function marchingSquares(field: Float32Array, w: number, h: number): Path[] {
  const W = w + 2;
  const H = h + 2;
  const f = new Float32Array(W * H).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[(y + 1) * W + x + 1] = field[y * w + x] === 0 ? 1e-6 : field[y * w + x];
  const pts = new Map<number, [number, number]>();
  // edge ids: horizontal edge (x,y)-(x+1,y) = 2*(y*W+x), vertical (x,y)-(x,y+1) = 2*(y*W+x)+1
  const point = (id: number) => {
    let p = pts.get(id);
    if (p) return id;
    const cell = id >> 1;
    const x = cell % W;
    const y = (cell - x) / W;
    const a = f[cell];
    if (id & 1) {
      const b = f[cell + W];
      const t = a / (a - b);
      p = [x - 1, y - 1 + t];
    } else {
      const b = f[cell + 1];
      const t = a / (a - b);
      p = [x - 1 + t, y - 1];
    }
    pts.set(id, p);
    return id;
  };
  const next = new Map<number, number>();
  for (let y = 0; y < H - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      const tl = f[i] > 0 ? 1 : 0, tr = f[i + 1] > 0 ? 1 : 0, br = f[i + W + 1] > 0 ? 1 : 0, bl = f[i + W] > 0 ? 1 : 0;
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;
      const top = 2 * i, left = 2 * i + 1, bottom = 2 * (i + W), right = 2 * (i + 1) + 1;
      const seg = (a: number, b: number) => next.set(point(a), point(b));
      // segments oriented so the inside (positive) is on the left
      switch (code) {
        case 1: seg(bottom, left); break;
        case 2: seg(right, bottom); break;
        case 3: seg(right, left); break;
        case 4: seg(top, right); break;
        case 5: {
          const c = (f[i] + f[i + 1] + f[i + W] + f[i + W + 1]) / 4;
          if (c > 0) { seg(top, left); seg(bottom, right); } else { seg(top, right); seg(bottom, left); }
          break;
        }
        case 6: seg(top, bottom); break;
        case 7: seg(top, left); break;
        case 8: seg(left, top); break;
        case 9: seg(bottom, top); break;
        case 10: {
          const c = (f[i] + f[i + 1] + f[i + W] + f[i + W + 1]) / 4;
          if (c > 0) { seg(left, bottom); seg(right, top); } else { seg(left, top); seg(right, bottom); }
          break;
        }
        case 11: seg(right, top); break;
        case 12: seg(left, right); break;
        case 13: seg(bottom, right); break;
        case 14: seg(left, bottom); break;
      }
    }
  const loops: Path[] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: Path = [];
    let cur: number | undefined = start;
    let guard = 0;
    while (cur !== undefined && !seen.has(cur) && guard++ < 1e6) {
      seen.add(cur);
      loop.push(pts.get(cur)!);
      cur = next.get(cur);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Distance (px) from every inside pixel to the nearest outside pixel; outside = 0. Image borders count as outside. */
export function distanceInside(inside: Uint8Array, w: number, h: number): Float32Array {
  const W = w + 2, H = h + 2;
  const INF = 1e20;
  const g = new Float64Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) g[y * W + x] = x > 0 && y > 0 && x <= w && y <= h && inside[(y - 1) * w + (x - 1)] ? INF : 0;
  const n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) g[y * W + x] = d[x];
  }
  const out = new Float32Array(w * h);
  // distance to the boundary sits half a pixel inside the nearest outside pixel centre
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.max(0, Math.sqrt(g[(y + 1) * W + x + 1]) - 0.5);
  return out;
}

/**
 * The shape's silhouette as a 0/1 mask, or null when the image has no
 * background to cut away. 'alpha' only uses PNG transparency; 'matte' falls
 * back to a light background, flood-filled in from the image border so light
 * areas inside the shape stay part of it.
 */
export function silhouetteMask(g: Gray, mode: string, lightBelow = 0.15): Gray | null {
  const n = g.w * g.h;
  const data = new Float32Array(n);
  if (g.alpha) {
    for (let i = 0; i < n; i++) data[i] = g.alpha[i] > 0.5 ? 1 : 0;
  } else if (mode === 'matte') {
    // background = light pixels connected to the border
    const bg = new Uint8Array(n);
    const light = (i: number) => 1 - g.data[i] < lightBelow;
    const stack: number[] = [];
    for (let x = 0; x < g.w; x++) stack.push(x, (g.h - 1) * g.w + x);
    for (let y = 0; y < g.h; y++) stack.push(y * g.w, y * g.w + g.w - 1);
    while (stack.length) {
      const i = stack.pop()!;
      if (bg[i] || !light(i)) continue;
      bg[i] = 1;
      const x = i % g.w;
      if (x > 0) stack.push(i - 1);
      if (x < g.w - 1) stack.push(i + 1);
      if (i >= g.w) stack.push(i - g.w);
      if (i < n - g.w) stack.push(i + g.w);
    }
    for (let i = 0; i < n; i++) data[i] = bg[i] ? 0 : 1;
  } else return null;
  let on = 0;
  for (let i = 0; i < n; i++) on += data[i];
  if (on === 0 || on === n) return null; // nothing, or no background: keep the plain outline
  return { w: g.w, h: g.h, data };
}
