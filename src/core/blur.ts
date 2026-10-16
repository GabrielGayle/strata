// Image blur types. All work on the small brightness grid the pipeline reads, in
// grid pixels, so they are pure and cheap enough for the background worker.
import { boxBlur, type Gray } from './image';

export type BlurType = 'box' | 'lens' | 'surface' | 'motion' | 'radial' | 'zoom' | 'tilt';

export interface BlurSpec {
  type: BlurType;
  /** Radius in px: Soft, Lens, Surface; the most blur away from the focus band for Tilt-shift. */
  size: number;
  /** Motion: streak length in px. */
  length: number;
  /** Motion: streak direction; Tilt-shift: focus band direction. Degrees, 0 = left–right. */
  angle: number;
  /** Radial: how far each point is swept around the centre, degrees. */
  spin: number;
  /** Zoom: how far each point is streaked toward the centre, % of its distance. */
  zoom: number;
  /** Centre (Radial, Zoom) or focus band position (Tilt-shift), 0..1 across and down. */
  cx: number;
  cy: number;
  /** Tilt-shift: width of the sharp band, 0..1 of the image's height. */
  focus: number;
  /** Surface: tone difference (0..1) that counts as an edge and is kept. */
  edge: number;
}

export const DEFAULT_BLUR: BlurSpec = { type: 'box', size: 1, length: 12, angle: 0, spin: 10, zoom: 20, cx: 0.5, cy: 0.5, focus: 0.3, edge: 0.15 };

/** Max samples along a streak, so huge settings stay quick. */
const MAX_TAPS = 64;

function bilinear(src: Float32Array, w: number, h: number, x: number, y: number): number {
  x = Math.min(w - 1, Math.max(0, x));
  y = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const a = src[y0 * w + x0], b = src[y0 * w + x1];
  const c = src[y1 * w + x0], d = src[y1 * w + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Average along a straight streak through (x, y) from offset -(dx,dy) to +(dx,dy). */
function streak(src: Float32Array, w: number, h: number, x: number, y: number, dx: number, dy: number): number {
  const n = Math.min(MAX_TAPS, Math.max(1, Math.ceil(Math.hypot(dx, dy) * 2)));
  if (n === 1) return src[Math.round(y) * w + Math.round(x)];
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 - 1;
    s += bilinear(src, w, h, x + dx * t, y + dy * t);
  }
  return s / (n + 1);
}

function motion(g: Gray, length: number, angle: number): Float32Array {
  const { w, h, data } = g;
  const a = (angle * Math.PI) / 180;
  const dx = (Math.cos(a) * length) / 2, dy = (-Math.sin(a) * length) / 2;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = streak(data, w, h, x, y, dx, dy);
  return out;
}

function radial(g: Gray, spin: number, cx: number, cy: number): Float32Array {
  const { w, h, data } = g;
  const half = (spin * Math.PI) / 360;
  const ox = cx * (w - 1), oy = cy * (h - 1);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const rx = x - ox, ry = y - oy;
      const r = Math.hypot(rx, ry);
      const n = Math.min(MAX_TAPS, Math.ceil(r * half * 2));
      if (n < 1) {
        out[y * w + x] = data[y * w + x];
        continue;
      }
      const a0 = Math.atan2(ry, rx);
      let s = 0;
      for (let i = 0; i <= n; i++) {
        const a = a0 + half * ((i / n) * 2 - 1);
        s += bilinear(data, w, h, ox + Math.cos(a) * r, oy + Math.sin(a) * r);
      }
      out[y * w + x] = s / (n + 1);
    }
  return out;
}

function zoomBlur(g: Gray, zoom: number, cx: number, cy: number): Float32Array {
  const { w, h, data } = g;
  const k = Math.min(1, zoom / 100);
  const ox = cx * (w - 1), oy = cy * (h - 1);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // streak from the point toward the centre, k of the way there
      const dx = ((ox - x) * k) / 2, dy = ((oy - y) * k) / 2;
      out[y * w + x] = streak(data, w, h, x + dx, y + dy, dx, dy);
    }
  return out;
}

/** Round (disc) kernel: out-of-focus camera blur, crisper-edged than Soft. */
function lens(g: Gray, r: number): Float32Array {
  const { w, h, data } = g;
  const taps: number[] = [];
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r + r) taps.push(i, j);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = 0; t < taps.length; t += 2) {
        const xx = Math.min(w - 1, Math.max(0, x + taps[t]));
        const yy = Math.min(h - 1, Math.max(0, y + taps[t + 1]));
        s += data[yy * w + xx];
      }
      out[y * w + x] = s / (taps.length / 2);
    }
  return out;
}

/** Edge-keeping blur: smooths flat areas but leaves strong tone steps sharp. */
function surface(g: Gray, r: number, edge: number): Float32Array {
  const { w, h, data } = g;
  const inv = 1 / Math.max(1e-3, edge * edge);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = data[y * w + x];
      let s = 0, n = 0;
      for (let j = -r; j <= r; j++) {
        const yy = Math.min(h - 1, Math.max(0, y + j));
        for (let i = -r; i <= r; i++) {
          if (i * i + j * j > r * r + r) continue;
          const v = data[yy * w + Math.min(w - 1, Math.max(0, x + i))];
          const d = v - c;
          const k = Math.exp(-d * d * inv);
          s += v * k;
          n += k;
        }
      }
      out[y * w + x] = s / n;
    }
  return out;
}

/** Sharp band across the picture that blurs more and more away from it, like a miniature photo. */
function tilt(g: Gray, size: number, angle: number, cx: number, cy: number, focus: number): Float32Array {
  const { w, h } = g;
  const levels: Float32Array[] = [g.data];
  for (let r = 1; r <= size; r++) levels.push(boxBlur(g, r).data);
  const a = (angle * Math.PI) / 180;
  // distance across the band, measured in image heights
  const nx = Math.sin(a), ny = Math.cos(a);
  const ox = cx * (w - 1), oy = cy * (h - 1);
  const halfBand = focus / 2;
  const ramp = Math.max(0.05, 0.5 - halfBand);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.abs((x - ox) * nx + (y - oy) * ny) / (h - 1);
      const f = Math.min(1, Math.max(0, (d - halfBand) / ramp)) * size;
      const l0 = Math.floor(f), l1 = Math.min(size, l0 + 1), t = f - l0;
      const i = y * w + x;
      out[i] = levels[l0][i] * (1 - t) + levels[l1][i] * t;
    }
  return out;
}

export function blurImage(g: Gray, b: BlurSpec): Gray {
  const size = Math.max(0, Math.round(b.size));
  const { w, h } = g;
  switch (b.type) {
    case 'lens':
      return size > 0 ? { w, h, data: lens(g, size) } : g;
    case 'surface':
      return size > 0 ? { w, h, data: surface(g, size, b.edge) } : g;
    case 'motion':
      return b.length > 0 ? { w, h, data: motion(g, b.length, b.angle) } : g;
    case 'radial':
      return b.spin > 0 ? { w, h, data: radial(g, b.spin, b.cx, b.cy) } : g;
    case 'zoom':
      return b.zoom > 0 ? { w, h, data: zoomBlur(g, b.zoom, b.cx, b.cy) } : g;
    case 'tilt':
      return size > 0 ? { w, h, data: tilt(g, size, b.angle, b.cx, b.cy, b.focus) } : g;
    default:
      return boxBlur(g, size);
  }
}

const BLUR_TYPES: BlurType[] = ['box', 'lens', 'surface', 'motion', 'radial', 'zoom', 'tilt'];

/** The blur settings from evaluated param values (the imgBlur* params; size comes from imgSmooth). */
export function blurSpec(v: Record<string, any>): BlurSpec {
  const type = BLUR_TYPES.includes(v.imgBlurType) ? (v.imgBlurType as BlurType) : 'box';
  const n = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  return {
    type,
    size: n(v.imgSmooth, DEFAULT_BLUR.size),
    length: n(v.imgBlurLength, DEFAULT_BLUR.length),
    angle: n(v.imgBlurAngle, DEFAULT_BLUR.angle),
    spin: n(v.imgBlurSpin, DEFAULT_BLUR.spin),
    zoom: n(v.imgBlurZoom, DEFAULT_BLUR.zoom),
    cx: n(v.imgBlurX, DEFAULT_BLUR.cx * 100) / 100,
    cy: n(v.imgBlurY, DEFAULT_BLUR.cy * 100) / 100,
    focus: n(v.imgBlurFocus, DEFAULT_BLUR.focus * 100) / 100,
    edge: n(v.imgBlurEdge, DEFAULT_BLUR.edge * 100) / 100,
  };
}
