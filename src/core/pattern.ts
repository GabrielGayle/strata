// Graphic input: parametric patterns rendered to the same brightness grid an
// uploaded image becomes, so every image mode (carve, raise, billow, front
// layers, side profile) works on a pattern unchanged. Pure, so it can be tested.
//
// Every layer is a signed distance field: symmetry folds the plane, tiling
// repeats it, a motif's SDF gives the distance to its edge, and the edge style
// turns distance into darkness (dark = cut deepest).
import type { Gray } from './image';
import { mulberry32 } from './rng';
import { strokeTextCentered } from './strokefont';

export type PatternShape = 'circle' | 'square' | 'polygon' | 'star' | 'superformula' | 'rose' | 'text';
export type PatternTiling = 'single' | 'grid' | 'brick' | 'hex';
export type PatternSymmetry = 'none' | 'radial' | 'kaleido';

export interface PatternLayer {
  shape: PatternShape;
  /** Motif radius: of the frame half-height when single, of the half-cell when tiled. */
  size: number;
  /** Degrees. */
  rotate: number;
  /** Polygon sides / star points. */
  sides: number;
  /** Star inner radius as a fraction of the outer. */
  inner: number;
  /** Superformula: symmetry m and exponents n1, n2, n3. */
  m: number;
  n1: number;
  n2: number;
  n3: number;
  petals: number;
  text: string;
  tiling: PatternTiling;
  /** Cells across the frame height when tiled. */
  cells: number;
  symmetry: PatternSymmetry;
  /** Copies around the centre (radial) or mirror segments (kaleidoscope). */
  folds: number;
  /** Distance of the motif from the centre under radial / kaleidoscope (frame half-heights). */
  offset: number;
  /** 0 = filled; otherwise the outline width as a fraction of the motif radius. */
  outline: number;
  /** Concentric echo rings around the motif. */
  echoes: number;
  /** Gap between echo rings, as a fraction of the motif radius. */
  echoGap: number;
  edge: 'solid' | 'soft';
  /** Soft edge: how far in (fraction of motif radius) the darkness takes to reach full. */
  softness: number;
  /** Darkness 0..1 (how deep this layer cuts). */
  strength: number;
  /** add = darken; cut = erase what the layers below drew. */
  blend: 'add' | 'cut';
}

export interface PatternSpec {
  kind: 'pattern';
  /** Width / height of the graphic. */
  aspect: number;
  invert: boolean;
  layers: PatternLayer[];
}

export const SHAPES: { value: PatternShape; label: string }[] = [
  { value: 'circle', label: 'Circle' },
  { value: 'square', label: 'Square' },
  { value: 'polygon', label: 'Polygon' },
  { value: 'star', label: 'Star' },
  { value: 'superformula', label: 'Superformula' },
  { value: 'rose', label: 'Rose' },
  { value: 'text', label: 'Text' },
];

export function makeLayer(patch: Partial<PatternLayer> = {}): PatternLayer {
  return {
    shape: 'circle',
    size: 0.6,
    rotate: 0,
    sides: 6,
    inner: 0.45,
    m: 6,
    n1: 0.6,
    n2: 1,
    n3: 1,
    petals: 5,
    text: 'STRATA',
    tiling: 'grid',
    cells: 4,
    symmetry: 'none',
    folds: 6,
    offset: 0.45,
    outline: 0,
    echoes: 0,
    echoGap: 0.3,
    edge: 'solid',
    softness: 0.6,
    strength: 1,
    blend: 'add',
    ...patch,
  };
}

export function makePattern(layers: Partial<PatternLayer>[] = [{}], aspect = 1): PatternSpec {
  return { kind: 'pattern', aspect, invert: false, layers: layers.map((l) => makeLayer(l)) };
}

export const PATTERN_PRESETS: { name: string; spec: () => PatternSpec }[] = [
  { name: 'Dots', spec: () => makePattern([{ shape: 'circle', tiling: 'hex', cells: 6, size: 0.55, edge: 'soft', softness: 1 }]) },
  { name: 'Squares', spec: () => makePattern([{ shape: 'square', tiling: 'grid', cells: 5, size: 0.6, rotate: 45, echoes: 1, echoGap: 0.35, outline: 0 }]) },
  {
    name: 'Kaleidoscope',
    spec: () => makePattern([{ shape: 'star', sides: 5, inner: 0.4, tiling: 'grid', cells: 3, size: 0.7, symmetry: 'kaleido', folds: 8, outline: 0.25 }]),
  },
  {
    name: 'Petal ring',
    spec: () =>
      makePattern([
        { shape: 'circle', tiling: 'single', size: 0.88, outline: 0.08, echoes: 0 },
        { shape: 'rose', petals: 3, tiling: 'single', size: 0.32, symmetry: 'radial', folds: 8, offset: 0.5 },
      ]),
  },
  { name: 'Bloom', spec: () => makePattern([{ shape: 'superformula', m: 7, n1: 0.35, n2: 1.2, n3: 1.2, tiling: 'single', size: 0.8, echoes: 3, echoGap: 0.16, outline: 0.1 }]) },
  { name: 'Honeycomb', spec: () => makePattern([{ shape: 'polygon', sides: 6, rotate: 30, tiling: 'hex', cells: 5, size: 0.95, outline: 0.18 }]) },
  {
    name: 'Text',
    spec: () =>
      makePattern(
        [
          { shape: 'text', text: 'STRATA', tiling: 'single', size: 0.5, outline: 0.3 },
          { shape: 'circle', tiling: 'grid', cells: 14, size: 0.35, strength: 0.6 },
          { shape: 'text', text: 'STRATA', tiling: 'single', size: 0.5, outline: 0.7, blend: 'cut' },
        ],
        2,
      ),
  },
];

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- distances

function sdBox(x: number, y: number, r: number): number {
  const dx = Math.abs(x) - r, dy = Math.abs(y) - r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

function sdPolygon(x: number, y: number, r: number, n: number): number {
  const sector = TAU / n;
  const a = Math.atan2(x, y);
  const k = Math.floor(0.5 + a / sector) * sector - a;
  return Math.cos(k) * Math.hypot(x, y) - r * Math.cos(sector / 2);
}

function superformula(t: number, m: number, n1: number, n2: number, n3: number): number {
  const a = Math.abs(Math.cos((m * t) / 4)) ** n2;
  const b = Math.abs(Math.sin((m * t) / 4)) ** n3;
  const s = a + b;
  return s <= 1e-9 ? 0 : s ** (-1 / n1);
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const l = vx * vx + vy * vy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l)) : 0;
  return Math.hypot(px - ax - vx * t, py - ay - vy * t);
}

/** A layer prepared for per-pixel evaluation (expensive per-layer work done once). */
interface Prepared {
  l: PatternLayer;
  cos: number;
  sin: number;
  sfMax: number;
  segs: Float64Array; // text strokes as x0 y0 x1 y1, cap height 1
  segR: number; // text bounding radius (for skipping far cells)
}

function prepare(l: PatternLayer): Prepared {
  const rad = (-l.rotate * Math.PI) / 180;
  let sfMax = 1;
  if (l.shape === 'superformula') {
    sfMax = 0;
    for (let i = 0; i < 720; i++) sfMax = Math.max(sfMax, Math.min(1e3, superformula((i / 720) * TAU, l.m, l.n1, l.n2, l.n3)));
    sfMax = sfMax || 1;
  }
  const flat: number[] = [];
  let segR = 0;
  if (l.shape === 'text') {
    const lines = l.text.split('\n').filter((s) => s.trim());
    lines.forEach((line, i) => {
      const cy = ((lines.length - 1) / 2 - i) * 1.6; // line pitch 1.6 cap heights, centred
      for (const p of strokeTextCentered(line, 0, cy, 1))
        for (let k = 0; k + 1 < p.length; k++) {
          flat.push(p[k][0], p[k][1], p[k + 1][0], p[k + 1][1]);
          segR = Math.max(segR, Math.hypot(p[k][0], p[k][1]), Math.hypot(p[k + 1][0], p[k + 1][1]));
        }
    });
  }
  return { l, cos: Math.cos(rad), sin: Math.sin(rad), sfMax, segs: new Float64Array(flat), segR };
}

/** Signed distance (motif radius units: the edge of a size-1 circle is at 1) to the motif. */
function motifDist(P: Prepared, x0: number, y0: number): number {
  const l = P.l;
  const x = x0 * P.cos - y0 * P.sin;
  const y = x0 * P.sin + y0 * P.cos;
  const r = Math.hypot(x, y);
  const t = Math.atan2(y, x);
  let d: number;
  switch (l.shape) {
    case 'circle':
      d = r - 1;
      break;
    case 'square':
      d = sdBox(x, y, 0.85);
      break;
    case 'polygon':
      d = sdPolygon(x, y, 1, Math.max(3, Math.round(l.sides)));
      break;
    case 'star': {
      const n = Math.max(2, Math.round(l.sides));
      const sector = TAU / n;
      const f = Math.abs((((t + Math.PI / 2) % sector) + sector) % sector - sector / 2) / (sector / 2); // 0 at a point, 1 between
      d = (r - (1 - (1 - l.inner) * f)) * 0.75;
      break;
    }
    case 'superformula':
      d = (r - Math.min(1e3, superformula(t + Math.PI / 2, l.m, l.n1, l.n2, l.n3)) / P.sfMax) * 0.7;
      break;
    case 'rose': {
      const n = Math.max(1, Math.round(l.petals));
      d = (r - (0.18 + 0.82 * Math.max(0, Math.cos(n * (t - Math.PI / 2))))) * 0.6;
      break;
    }
    case 'text': {
      // size = cap height; stroke weight from the outline value
      let m = Infinity;
      const s = P.segs;
      for (let i = 0; i < s.length; i += 4) m = Math.min(m, segDist(x, y, s[i], s[i + 1], s[i + 2], s[i + 3]));
      return m - Math.max(0.04, l.outline || 0.18) / 2;
    }
  }
  if (l.outline > 0) d = Math.abs(d + l.outline / 2) - l.outline / 2;
  if (l.echoes > 0 && d > 0) {
    const gap = Math.max(0.02, l.echoGap);
    const w = Math.max(0.05, l.outline || 0.08);
    const k = Math.min(l.echoes, Math.max(1, Math.round(d / gap)));
    d = Math.min(d, Math.abs(d - k * gap) - w / 2);
  }
  return d;
}

/** Signed distance in frame units (frame half-height = 1) at frame point (x, y). */
function layerDist(P: Prepared, x: number, y: number): number {
  const l = P.l;
  if (l.symmetry !== 'none') {
    const n = Math.max(1, Math.round(l.folds));
    const sector = TAU / n;
    const r = Math.hypot(x, y);
    let a = ((Math.atan2(y, x) - Math.PI / 2) % sector + sector) % sector; // fold from straight up
    if (l.symmetry === 'kaleido') {
      if (a > sector / 2) a = sector - a; // mirror each half segment
    } else a -= sector / 2;
    x = r * Math.sin(a);
    y = r * Math.cos(a) - l.offset;
  }
  if (l.tiling === 'single') {
    const R = Math.max(1e-3, l.size);
    return motifDist(P, x / R, y / R) * R;
  }
  const c = 2 / Math.max(1, l.cells);
  const rowH = l.tiling === 'hex' ? (c * Math.sqrt(3)) / 2 : c;
  const R = Math.max(1e-3, (l.size * c) / 2);
  const j0 = Math.round(y / rowH);
  const reach = (l.shape === 'text' ? P.segR + 0.2 : 1.6 + l.echoes * l.echoGap) * R;
  let best = Infinity;
  for (let j = j0 - 1; j <= j0 + 1; j++) {
    const shift = l.tiling !== 'grid' && j & 1 ? c / 2 : 0;
    const i0 = Math.round((x - shift) / c);
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      const dx = x - (i * c + shift), dy = y - j * rowH;
      if ((i !== i0 || j !== j0) && Math.hypot(dx, dy) - reach > best) continue;
      best = Math.min(best, motifDist(P, dx / R, dy / R) * R);
    }
  }
  return best;
}

function motifScale(l: PatternLayer): number {
  return l.tiling === 'single' ? l.size : (l.size * 2) / Math.max(1, l.cells) / 2;
}

/** Render to a brightness grid (0 = black = cut deepest), row 0 at the top. */
export function renderPattern(spec: PatternSpec, w: number, h: number): Gray {
  const data = new Float32Array(w * h);
  const prepared = spec.layers.map(prepare);
  const px = 2 / h; // frame units per pixel
  const dark = new Float32Array(w * h);
  for (const P of prepared) {
    const l = P.l;
    const soft = Math.max(px, l.softness * motifScale(l));
    for (let y = 0; y < h; y++) {
      const fy = 1 - (y + 0.5) * px;
      for (let x = 0; x < w; x++) {
        const fx = (x + 0.5 - w / 2) * px;
        const d = layerDist(P, fx, fy);
        let k: number;
        if (l.edge === 'soft') {
          const t = Math.min(1, Math.max(0, -d / soft));
          k = Math.sqrt(1 - (1 - t) * (1 - t)); // dome: steep at the edge, flat on top
        } else k = Math.min(1, Math.max(0, 0.5 - d / px));
        k *= l.strength;
        const i = y * w + x;
        dark[i] = l.blend === 'cut' ? dark[i] * (1 - k) : Math.max(dark[i], k);
      }
    }
  }
  for (let i = 0; i < data.length; i++) data[i] = spec.invert ? dark[i] : 1 - dark[i];
  return { w, h, data };
}

/** Pixel size for a render whose longer side is `long`. */
export function patternSize(spec: PatternSpec, long: number): { w: number; h: number } {
  const a = Math.max(0.1, spec.aspect);
  return a >= 1 ? { w: long, h: Math.max(2, Math.round(long / a)) } : { w: Math.max(2, Math.round(long * a)), h: long };
}

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

/** A random layer, repeatable from its seed. */
export function randomLayer(seed: number, base?: Partial<PatternLayer>): PatternLayer {
  const r = mulberry32(seed);
  const shape = pick(r, ['circle', 'square', 'polygon', 'star', 'superformula', 'rose'] as const);
  const symmetry = pick(r, ['none', 'none', 'radial', 'kaleido', 'kaleido'] as const);
  const tiling = symmetry === 'radial' ? 'single' : pick(r, ['single', 'grid', 'brick', 'hex'] as const);
  return makeLayer({
    ...base,
    shape,
    tiling,
    symmetry,
    size: tiling === 'single' ? (symmetry === 'none' ? 0.5 + r() * 0.4 : 0.15 + r() * 0.25) : 0.4 + r() * 0.5,
    rotate: Math.round(r() * 8) * 15,
    sides: 3 + Math.floor(r() * 6),
    inner: 0.3 + r() * 0.4,
    m: 2 + Math.floor(r() * 9),
    n1: 0.2 + r() * 1.2,
    n2: 0.5 + r() * 1.5,
    n3: 0.5 + r() * 1.5,
    petals: 2 + Math.floor(r() * 6),
    cells: 2 + Math.floor(r() * 6),
    folds: 4 + Math.floor(r() * 9),
    offset: 0.2 + r() * 0.5,
    outline: r() < 0.5 ? 0 : 0.1 + r() * 0.25,
    echoes: r() < 0.6 ? 0 : 1 + Math.floor(r() * 3),
    echoGap: 0.2 + r() * 0.3,
    edge: r() < 0.5 ? 'solid' : 'soft',
    softness: 0.3 + r() * 0.7,
  });
}
