// Image → plate data. Images are reduced to a small brightness grid; all the
// processing here is pure so it can run (and be tested) anywhere.
import type { Path } from './geom2d';

export interface Gray {
  w: number;
  h: number;
  /** Brightness 0 (black) … 1 (white), row-major, row 0 = top of image. */
  data: Float32Array;
}

export interface ImageOpts {
  contrast: number;
  smooth: number;
  invert: boolean;
  rotate: number; // 0 | 90 | 180 | 270
}

export async function decodeImage(dataUrl: string, maxSide = 256): Promise<Gray> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(2, Math.round(img.width * k));
  const h = Math.max(2, Math.round(img.height * k));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
  return { w, h, data };
}

function rotate(g: Gray, deg: number): Gray {
  const r = ((Math.round(deg / 90) % 4) + 4) % 4;
  if (r === 0) return g;
  const w = r % 2 ? g.h : g.w;
  const h = r % 2 ? g.w : g.h;
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
      out[ny * w + nx] = g.data[y * g.w + x];
    }
  return { w, h, data: out };
}

function boxBlur(g: Gray, r: number): Gray {
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
  r = boxBlur(r, Math.round(o.smooth));
  const data = new Float32Array(r.data.length);
  for (let i = 0; i < data.length; i++) {
    let v = r.data[i];
    if (o.invert) v = 1 - v;
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
