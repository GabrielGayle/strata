// Candelabra: candlesticks and tealights laid along a curve, a path or a shape,
// with the plates coming up to meet each one. A tealight drops into a round cup
// cut into the plates it crosses. A candlestick is held either by a "target":
// a small ring of fins standing in the concrete like crosshairs, gripping it
// from every side, with the plates around stepping up to meet them; or by a
// socket cut through the plates it stands in, the same way as a tealight.
import type { CutObject } from './objects';
import type { Shape } from './geom2d';
import type { Plane } from './section';

export type CandlePath = 'line' | 'arc' | 'wave' | 'circle' | 'spiral' | 'heart' | 'star' | 'custom';

export const PATH_NAMES: Record<CandlePath, string> = {
  line: 'Straight line',
  arc: 'Arc (curve)',
  wave: 'Wave (S curve)',
  circle: 'Circle (ring)',
  spiral: 'Spiral',
  heart: 'Heart',
  star: 'Star',
  custom: 'My own path (typed points)',
};

export type Holder = 'target' | 'socket';

export const HOLDER_NAMES: Record<Holder, string> = {
  target: 'Target (fins around it)',
  socket: 'Socket in the plates',
};

/** Candle presets: diameter × height (mm) and whether it is a tealight (sits in a cup) or a candlestick. */
export interface CandlePreset {
  d: number;
  h: number;
  tealight: boolean;
  label: string;
}

export const PRESETS: Record<string, CandlePreset> = {
  mini: { d: 30, h: 12, tealight: true, label: 'Mini tealight' },
  tealight: { d: 38, h: 16, tealight: true, label: 'Tealight' },
  maxi: { d: 58, h: 24, tealight: true, label: 'Maxi tealight' },
  jumbo: { d: 70, h: 28, tealight: true, label: 'Jumbo tealight' },
  votive: { d: 45, h: 60, tealight: true, label: 'Votive' },
  taper: { d: 22, h: 250, tealight: false, label: 'Dinner candle (taper)' },
  thin: { d: 13, h: 200, tealight: false, label: 'Thin taper' },
  pillar: { d: 60, h: 120, tealight: false, label: 'Pillar' },
};

/** Words that pick a preset (plurals and a few other names work too). */
const ALIASES: Record<string, string> = {
  mini: 'mini',
  'mini tealight': 'mini',
  tealight: 'tealight',
  'tea light': 'tealight',
  maxi: 'maxi',
  'maxi tealight': 'maxi',
  jumbo: 'jumbo',
  'jumbo tealight': 'jumbo',
  xl: 'jumbo',
  votive: 'votive',
  taper: 'taper',
  dinner: 'taper',
  'dinner candle': 'taper',
  candlestick: 'taper',
  'candle stick': 'taper',
  stick: 'taper',
  candle: 'taper',
  thin: 'thin',
  'thin taper': 'thin',
  pillar: 'pillar',
};

export interface CandleSize {
  d: number;
  h: number;
  tealight: boolean;
  /** Holder named on the line ("socket" / "target"), else the candelabra's own choice. */
  holder?: Holder;
  name: string;
}

export interface CandleSpec {
  on: boolean;
  /** One candle per line: "5 taper", "tealight", "40 x 18 tealight", "24 x 300 stick target". */
  candles: string;
  /** Interleave the lines (taper, tealight, taper…) instead of laying them in order. */
  alternate: boolean;
  path: CandlePath;
  /** Overall width of the path (mm): its length for a line, the diameter for a circle. */
  size: number;
  /** Path-specific bend: arc sweep (degrees), wave height (mm), spiral turns, star points. */
  bend: number;
  /** Custom path: "x, z; x, z; …" in mm, smoothed through. */
  points: string;
  /** Custom path: join the last point back to the first. */
  closed: boolean;
  /** Height of the candle bottoms above the concrete (mm). */
  lift: number;
  /** Extra height for the middle candles, like a candelabra's crown (mm). */
  crown: number;
  /** Climb from the first candle to the last (mm). */
  ramp: number;
  /** How candlesticks are held (tealights always sit in a cup). */
  holder: Holder;
  /** How far up a candlestick its holder grips (mm). */
  grip: number;
  /** How deep a tealight sits in its cup (mm). */
  cup: number;
  /** Target: fins around each candlestick, how far they reach out (mm) and their turn (degrees). */
  fins: number;
  reach: number;
  spin: number;
  /** Gap around each candle (mm). */
  slack: number;
  /** Plate kept either side of each cup or socket as it steps up (mm). */
  shoulder: number;
  /** Step the plate tops up to meet the candles (off: plates stay as they are, with just the cuts). */
  trim: boolean;
  x: number;
  z: number;
  turn: number;
}

export const DEFAULT_CANDLES: CandleSpec = {
  on: true,
  candles: '5 taper\n4 tealight',
  alternate: true,
  path: 'arc',
  size: 520,
  bend: 120,
  points: '-250, 0; -120, -80; 0, 0; 120, 80; 250, 0',
  closed: false,
  lift: 60,
  crown: 60,
  ramp: 0,
  holder: 'target',
  grip: 28,
  cup: 10,
  fins: 4,
  reach: 18,
  spin: 45,
  slack: 0.8,
  shoulder: 6,
  trim: true,
  x: 0,
  z: 0,
  turn: 0,
};

/** Candles from typed text, one line each, with an optional count in front ("5 taper"). */
export function parseCandles(text: string): { lines: { size: CandleSize; count: number }[]; bad: string[] } {
  const lines: { size: CandleSize; count: number }[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[\n;,]+/)) {
    let s = raw.trim().toLowerCase();
    if (!s) continue;
    let holder: Holder | undefined;
    s = s.replace(/\b(target|socket|fins?)\b/g, (w) => {
      holder = w === 'socket' ? 'socket' : 'target';
      return '';
    }).trim();
    const dims = s.match(/^(\d+(?:\.\d+)?)\s*(?:mm)?\s*(?:x|×|\*|by)\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*(.*)$/);
    let count = 1;
    let size: CandleSize | null = null;
    if (dims) {
      const d = parseFloat(dims[1]);
      const h = parseFloat(dims[2]);
      const rest = dims[3].trim();
      if (d >= 5 && h >= 5 && d <= 400 && h <= 1000) {
        const word = rest.replace(/s$/, '');
        const tealight = /tea|cup|votive|mini|maxi|jumbo/.test(word) ? true : /stick|taper|pillar|candle|dinner/.test(word) ? false : h < 2 * d;
        size = { d, h, tealight, name: rest || `${d} × ${h}` };
      }
    } else {
      const m = s.match(/^(\d+)\s*(?:×|x|\*)?\s*([a-z].*)$/);
      if (m) {
        count = Math.min(60, Math.max(1, parseInt(m[1], 10)));
        s = m[2].trim();
      }
      const key = ALIASES[s] ?? ALIASES[s.replace(/s$/, '')] ?? ALIASES[s.replace(/es$/, '')];
      if (key) {
        const p = PRESETS[key];
        size = { d: p.d, h: p.h, tealight: p.tealight, name: p.label };
      }
    }
    if (!size) {
      bad.push(raw.trim());
      continue;
    }
    if (holder) size.holder = holder;
    lines.push({ size, count });
  }
  return { lines, bad };
}

/** The candles in the order they go along the path. */
export function candleList(spec: CandleSpec): CandleSize[] {
  const { lines } = parseCandles(spec.candles);
  if (!spec.alternate) return lines.flatMap((l) => Array.from({ length: l.count }, () => l.size));
  // round robin, spreading each line's candles evenly through the run
  const total = lines.reduce((a, l) => a + l.count, 0);
  const slots = lines.flatMap((l) => Array.from({ length: l.count }, (_, k) => ({ at: (k + 0.5) / l.count, size: l.size })));
  return slots
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .slice(0, total)
    .map((x) => x.size);
}

const num = (x: unknown, def: number, lo = -Infinity, hi = Infinity) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def);

export function cleanCandles(raw: unknown): CandleSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_CANDLES;
  return {
    on: r.on !== false,
    candles: typeof r.candles === 'string' ? r.candles : d.candles,
    alternate: r.alternate !== false,
    path: (Object.keys(PATH_NAMES) as CandlePath[]).includes(r.path as CandlePath) ? (r.path as CandlePath) : d.path,
    size: num(r.size, d.size, 20, 5000),
    bend: num(r.bend, d.bend),
    points: typeof r.points === 'string' ? r.points : d.points,
    closed: r.closed === true,
    lift: num(r.lift, d.lift, 0),
    crown: num(r.crown, d.crown),
    ramp: num(r.ramp, d.ramp),
    holder: r.holder === 'socket' ? 'socket' : 'target',
    grip: num(r.grip, d.grip, 2),
    cup: num(r.cup, d.cup, 1),
    fins: Math.round(num(r.fins, d.fins, 2, 8)),
    reach: num(r.reach, d.reach, 3),
    spin: num(r.spin, d.spin),
    slack: num(r.slack, d.slack, 0),
    shoulder: num(r.shoulder, d.shoulder, 0),
    trim: r.trim !== false,
    x: num(r.x, d.x),
    z: num(r.z, d.z),
    turn: num(r.turn, d.turn),
  };
}

type P2 = [number, number];

/** "x, z; x, z" points in mm (any separators between numbers work, pairs split by ; or new lines). */
export function parsePathPoints(text: string): P2[] {
  const out: P2[] = [];
  for (const part of text.split(/[;\n]+/)) {
    const n = part.match(/-?\d+(?:\.\d+)?/g);
    if (n && n.length >= 2) out.push([parseFloat(n[0]), parseFloat(n[1])]);
  }
  return out;
}

/** Catmull-Rom through the points, so a typed path comes out as a smooth curve. */
function smoothThrough(pts: P2[], closed: boolean, per = 24): P2[] {
  if (pts.length < 3) return pts;
  const n = pts.length;
  const at = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const out: P2[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

/**
 * The path in plan as a dense polyline (x, z in mm; front is +z), and whether it closes.
 * Shapes are centred on the middle of their bounding box.
 */
export function pathPolyline(spec: CandleSpec): { pts: P2[]; closed: boolean } {
  const W = spec.size;
  const N = 400;
  const range = (f: (t: number) => P2, closed = false) => Array.from({ length: closed ? N : N + 1 }, (_, i) => f(i / N));
  let pts: P2[];
  let closed = false;
  switch (spec.path) {
    case 'line':
      pts = [[-W / 2, 0], [W / 2, 0]];
      break;
    case 'arc': {
      // bulges away from the viewer, like the postcard fan
      const sweep = (Math.min(350, Math.max(5, spec.bend)) * Math.PI) / 180;
      const R = sweep < Math.PI ? W / 2 / Math.sin(sweep / 2) : W / 2;
      pts = range((t) => {
        const a = (t - 0.5) * sweep;
        return [R * Math.sin(a), -R * Math.cos(a)];
      });
      break;
    }
    case 'wave':
      pts = range((t) => [(t - 0.5) * W, (spec.bend / 2) * Math.sin(t * 2 * Math.PI)]);
      break;
    case 'circle':
      closed = true;
      pts = range((t) => [(W / 2) * Math.sin(t * 2 * Math.PI), (W / 2) * Math.cos(t * 2 * Math.PI)], true);
      break;
    case 'spiral': {
      const turns = Math.max(0.25, Math.min(6, spec.bend));
      pts = range((t) => {
        const r = (W / 2) * (0.15 + 0.85 * t);
        const a = t * turns * 2 * Math.PI;
        return [r * Math.sin(a), r * Math.cos(a)];
      });
      break;
    }
    case 'heart':
      closed = true;
      // the classic heart curve, point towards the viewer
      pts = range((t) => {
        const a = t * 2 * Math.PI;
        const x = 16 * Math.sin(a) ** 3;
        const y = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a);
        return [(x * W) / 34, (-y * W) / 34];
      }, true);
      break;
    case 'star': {
      closed = true;
      const k = Math.max(3, Math.min(12, Math.round(spec.bend)));
      pts = [];
      for (let i = 0; i < 2 * k; i++) {
        const a = (i / (2 * k)) * 2 * Math.PI;
        const r = i % 2 ? W / 4.4 : W / 2;
        pts.push([r * Math.sin(a), -r * Math.cos(a)]);
      }
      break;
    }
    case 'custom': {
      closed = spec.closed;
      const raw = parsePathPoints(spec.points);
      pts = raw.length >= 2 ? smoothThrough(raw, closed) : [[-W / 2, 0], [W / 2, 0]];
      if (raw.length === 2) closed = false;
      // typed points are where they are: no re-centring
      return { pts, closed };
    }
  }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  return { pts: pts.map(([x, z]) => [x - cx, z - cz] as P2), closed };
}

/** Points spread evenly along a polyline by length (closed paths share the gap back to the start too). */
export function spreadAlong(pts: P2[], closed: boolean, n: number): { p: P2; f: number }[] {
  if (!n) return [];
  const ring = closed ? [...pts, pts[0]] : pts;
  const cum = [0];
  for (let i = 1; i < ring.length; i++) cum.push(cum[i - 1] + Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]));
  const L = cum[cum.length - 1];
  const out: { p: P2; f: number }[] = [];
  for (let i = 0; i < n; i++) {
    const f = closed ? i / n : n === 1 ? 0.5 : i / (n - 1);
    const s = f * L;
    let j = 1;
    while (j < cum.length - 1 && cum[j] < s) j++;
    const seg = cum[j] - cum[j - 1] || 1;
    const k = Math.min(1, Math.max(0, (s - cum[j - 1]) / seg));
    out.push({ p: [ring[j - 1][0] + (ring[j][0] - ring[j - 1][0]) * k, ring[j - 1][1] + (ring[j][1] - ring[j - 1][1]) * k], f });
  }
  return out;
}

const D = Math.PI / 180;

/**
 * The candles as placed objects in world mm (y up, base centred on the origin).
 * `baseTop` is the top of the concrete. Each candle stands upright on its bottom;
 * target-held candlesticks also get a hidden "well" that clears the plates for
 * their fins and carries the seat the plates step up to around it.
 */
export function candleObjects(spec: CandleSpec | undefined, baseTop: number): CutObject[] {
  if (!spec?.on) return [];
  const list = candleList(spec);
  if (!list.length) return [];
  const { pts, closed } = pathPolyline(spec);
  const spots = spreadAlong(pts, closed, list.length);
  const turn = spec.turn * D;
  const out: CutObject[] = [];
  spots.forEach(({ p, f }, i) => {
    const c = list[i];
    const [bx, bz] = [p[0] * Math.cos(turn) + p[1] * Math.sin(turn), -p[0] * Math.sin(turn) + p[1] * Math.cos(turn)];
    const x = spec.x + bx;
    const z = spec.z + bz;
    const crown = closed ? 0 : 1 - (2 * f - 1) ** 2;
    const yb = baseTop + spec.lift + spec.crown * crown + spec.ramp * f;
    const holder: Holder = c.tealight ? c.holder ?? 'socket' : c.holder ?? spec.holder;
    const grip = c.tealight ? Math.min(spec.cup, c.h - 1) : Math.min(spec.grip, c.h - 2);
    const id = `candle${i + 1}`;
    const base = { kind: 'cylinder' as const, x, z, rx: 0, ry: spec.turn, rz: 0, on: true };
    if (holder === 'socket') {
      out.push({ ...base, id, name: c.name, w: c.d, h: c.h, d: c.d, y: yb + c.h / 2, clearance: spec.slack, look: c.tealight ? 'tealight' : 'candle', ...(spec.trim ? { seat: grip + spec.slack, shoulder: spec.shoulder } : {}) });
      return;
    }
    out.push({ ...base, id, name: c.name, w: c.d, h: c.h, d: c.d, y: yb + c.h / 2, clearance: spec.slack, look: c.tealight ? 'tealight' : 'candle', holder: { fins: spec.fins, reach: spec.reach, grip, spin: spec.spin } });
    // the well: clears the plates for the fins (a little wider than they reach) from the concrete up past the candle
    const rw = c.d / 2 + spec.slack + spec.reach + Math.max(2, spec.slack * 2);
    const bottom = baseTop + 0.2;
    const top = yb + c.h;
    out.push({ ...base, id: `well${i + 1}`, name: `${c.name} holder`, w: 2 * rw, h: top - bottom, d: 2 * rw, y: (bottom + top) / 2, clearance: 0, look: 'hidden', ...(spec.trim ? { seat: Math.max(0.5, yb - bottom), shoulder: spec.shoulder } : {}) });
  });
  return out;
}

export interface CandleFin {
  /** Holder number (0-based, along the path) and fin within it. */
  holder: number;
  fin: number;
  plane: Plane;
  shape: Shape;
  labelAt: [number, number];
  labelMax: number;
}

/**
 * Target fins for one candlestick: `fins` small upright plates radiating from
 * its centre like crosshairs. Each stands `embed` mm deep in the concrete, rises
 * under the candle as a pedestal it stands on, and above the candle's bottom
 * hugs its side for `grip` mm, tapering in towards the top.
 */
export function targetFins(
  c: { x: number; z: number; r: number; bottom: number; ry: number },
  h: { fins: number; reach: number; grip: number; spin: number },
  o: { t: number; embed: number; baseTop: number; slack: number; minFeature: number },
  index: number,
): CandleFin[] {
  const n = Math.max(2, Math.min(8, Math.round(h.fins)));
  const out: CandleFin[] = [];
  // inner ends meet at the centre without overlapping
  const uIn = n === 2 ? 0.5 : o.t / 2 / Math.tan(Math.PI / n) + 0.2;
  const rc = c.r + o.slack;
  const uOut = rc + Math.max(h.reach, o.minFeature);
  const yb = c.bottom - o.baseTop;
  const yTop = yb + h.grip;
  const tip = Math.min(uOut, rc + Math.max(o.minFeature, 3));
  const y0 = -o.embed;
  for (let k = 0; k < n; k++) {
    const a = (h.spin + c.ry) * D + (k / n) * 2 * Math.PI;
    const d: P2 = [Math.cos(a), -Math.sin(a)];
    const plane: Plane = { origin: [c.x, o.baseTop, c.z], normal: [-d[1], 0, d[0]], u: [d[0], 0, d[1]], v: [0, 1, 0] };
    const outer: P2[] =
      yb > 0.5
        ? [[uIn, y0], [uOut, y0], [uOut, yb], [tip, yTop], [rc, yTop], [rc, yb], [uIn, yb]]
        : [[rc, y0], [uOut, y0], [uOut, Math.max(yb, 0)], [tip, yTop], [rc, yTop]];
    out.push({ holder: index, fin: k, plane, shape: [{ outer, holes: [] }], labelAt: [(uIn + uOut) / 2, (y0 + Math.max(yb, 0)) / 2], labelMax: Math.max(2, Math.min(uOut - uIn, Math.max(yb, 0) - y0) * 0.5) });
  }
  return out;
}
