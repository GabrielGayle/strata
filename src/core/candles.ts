// Candelabra: candlesticks and tealights laid along a curve, a path or a shape,
// with the plates coming up to meet each one. A tealight drops into a round cup
// cut into the plates it crosses. A candlestick is held either by a "target":
// a small ring of fins standing in the concrete like crosshairs, gripping it
// from every side, with the plates around stepping up to meet them; or by a
// socket cut through the plates it stands in, the same way as a tealight.
import type { CutObject } from './objects';
import type { Shape } from './geom2d';
import type { Plane } from './section';

export type CandlePath = 'line' | 'arc' | 'wave' | 'circle' | 'spiral' | 'heart' | 'star' | 'custom' | 'grid' | 'free';

export const PATH_NAMES: Record<CandlePath, string> = {
  line: 'Straight line',
  arc: 'Arc (curve)',
  wave: 'Wave (S curve)',
  circle: 'Circle (ring)',
  spiral: 'Spiral',
  heart: 'Heart',
  star: 'Star',
  custom: 'My own path (typed points)',
  grid: 'Grid (rows and columns)',
  free: 'Free (drag each candle)',
};

export type Holder = 'target' | 'slotted' | 'socket';

/** How a candlestick's fins are cut: one part per fin, or two full-width fins halved into a cross. */
export type FinJoin = 'separate' | 'cross';

export const FIN_JOIN_NAMES: Record<FinJoin, string> = {
  separate: 'Separate fins (one part each)',
  cross: 'Two-piece cross (halving slot)',
};

export const HOLDER_NAMES: Record<Holder, string> = {
  target: 'Target fins (set in the concrete)',
  slotted: 'Slotted fins (keyed into the plates)',
  socket: 'Cup in the plates (like tealights)',
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
  /** The preset it came from ("taper", "tealight"…), when the line named one. */
  preset?: string;
  /** Words typed after a size ("24 x 300 stick" keeps "stick"), so the line can be written back. */
  word?: string;
}

export type Choke = 'off' | 'candles' | 'path';

export const CHOKE_NAMES: Record<Choke, string> = {
  off: 'Plates full length',
  candles: 'Choke round each candle',
  path: 'Choke along the path',
};

export type Sit = 'auto' | 'lift' | 'surface';

export const SIT_NAMES: Record<Sit, string> = {
  auto: 'Height: auto (sit into a map)',
  lift: 'Height: lift above the concrete',
  surface: 'Height: sit into the plates under it',
};

export type Snap = 'off' | 'on' | 'between';

export const SNAP_NAMES: Record<Snap, string> = {
  off: 'Anywhere',
  on: 'Snap onto plates',
  between: 'Snap between plates',
};

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
  /** Grid: columns (across the plates; rows fill up as candles are added), and the spacing between them (mm). */
  cols: number;
  gapX: number;
  gapZ: number;
  /** Line candles up with the plates: centred on one, or midway between two. */
  snap: Snap;
  /** Grid with snapping: columns every this many plates (so the spacing follows the plate pitch). */
  every: number;
  /** Free: where each candle stands, as x, z (mm) in the candelabra's own frame. Filled in when you drag one. */
  spots: [number, number][];
  /** Where the candles stand: at Lift above the concrete, or sunk into whatever plates are under them (auto does that on a map). */
  sit: Sit;
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
  /** Fin holders: separate fins, or two pieces that halve together into a cross (always four arms). */
  finJoin: FinJoin;
  /** Slotted fins: how far each fin and plate overlap where they slot together (mm). */
  engage: number;
  /** Gap around each candle (mm). */
  slack: number;
  /** Plate kept either side of each cup or socket as it steps up (mm). */
  shoulder: number;
  /** Choke the plates in to the candles: off, round each candle, or along the path between them. */
  choke: Choke;
  /** Plate kept beyond each candle (or holder) when choked (mm). */
  pad: number;
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
  cols: 4,
  gapX: 80,
  gapZ: 80,
  snap: 'off',
  every: 4,
  spots: [],
  sit: 'auto',
  lift: 60,
  crown: 60,
  ramp: 0,
  holder: 'target',
  grip: 28,
  cup: 10,
  fins: 4,
  reach: 18,
  spin: 45,
  finJoin: 'separate',
  engage: 16,
  slack: 0.8,
  shoulder: 6,
  choke: 'off',
  pad: 15,
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
    s = s.replace(/\b(target|socket|cup|slotted|slots?|fins?)\b/g, (w) => {
      holder = w === 'socket' || w === 'cup' ? 'socket' : w.startsWith('slot') ? 'slotted' : 'target';
      return '';
    }).trim();
    let count = 1;
    let size: CandleSize | null = null;
    // "3 of 24 x 300 stick": a count in front of a size
    const of = s.match(/^(\d+)\s+of\s+(.*)$/);
    if (of) {
      count = Math.min(60, Math.max(1, parseInt(of[1], 10)));
      s = of[2].trim();
    }
    const dims = s.match(/^(\d+(?:\.\d+)?)\s*(?:mm)?\s*(?:x|×|\*|by)\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*(.*)$/);
    if (dims) {
      const d = parseFloat(dims[1]);
      const h = parseFloat(dims[2]);
      const rest = dims[3].trim();
      if (d >= 5 && h >= 5 && d <= 400 && h <= 1000) {
        const word = rest.replace(/s$/, '');
        const tealight = /tea|cup|votive|mini|maxi|jumbo/.test(word) ? true : /stick|taper|pillar|candle|dinner/.test(word) ? false : h < 2 * d;
        size = { d, h, tealight, name: rest || `${d} × ${h}`, word: rest };
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
        size = { d: p.d, h: p.h, tealight: p.tealight, name: p.label, preset: key };
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

/** One line of the candle list as the picker shows it: what it is and how many. */
export interface CandleRow {
  size: CandleSize;
  count: number;
}

const HOLDER_WORD: Record<Holder, string> = { socket: 'cup', target: 'target', slotted: 'slotted' };

/** A candle line written back as text that parseCandles reads the same way. */
export function candleLine({ size, count }: CandleRow): string {
  const holder = size.holder ? ` ${HOLDER_WORD[size.holder]}` : '';
  if (size.preset) return `${count} ${size.preset}${holder}`;
  let word = (size.word ?? '').replace(/[\n;,]+/g, ' ').trim();
  const kind = /tea|cup|votive|mini|maxi|jumbo/.test(word) ? true : /stick|taper|pillar|candle|dinner/.test(word) ? false : size.h < 2 * size.d;
  if (kind !== size.tealight) word = `${word} ${size.tealight ? 'tealight' : 'candle'}`.trim();
  return `${count > 1 ? `${count} of ` : ''}${+size.d.toFixed(1)} x ${+size.h.toFixed(1)}${word ? ` ${word}` : ''}${holder}`;
}

/** The whole list written back as text, keeping any lines that couldn't be read so nothing typed is lost. */
export function writeCandles(rows: CandleRow[], bad: string[] = []): string {
  return [...rows.map(candleLine), ...bad].join('\n');
}

/** Add one candle of a preset (or a size of your own): one more on a matching line, else a new line at the end. */
export function addCandle(text: string, size: CandleSize): string {
  const { lines, bad } = parseCandles(text);
  const same = lines.find((l) => l.count < 60 && !l.size.holder && (size.preset ? l.size.preset === size.preset : !l.size.preset && l.size.d === size.d && l.size.h === size.h && l.size.tealight === size.tealight));
  if (same) same.count++;
  else lines.push({ size, count: 1 });
  return writeCandles(lines, bad);
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

/** One line of the candle shopping list: candles of one size, how many, and what they sit in. */
export interface CandleBuy {
  name: string;
  d: number;
  h: number;
  tealight: boolean;
  qty: number;
  holder: Holder;
  /** Held by two-piece crossed fins (candlesticks with fins only). */
  cross?: boolean;
  /** The hole they drop into (candle plus the gap all round), mm. */
  hole: number;
}

/** What to buy: the candelabra's candles grouped by size, in the order they first appear in the list. */
export function candleShopping(spec: CandleSpec | null | undefined): CandleBuy[] {
  if (!spec?.on) return [];
  const out = new Map<string, CandleBuy>();
  for (const c of candleList(spec)) {
    const holder: Holder = c.tealight ? c.holder ?? 'socket' : c.holder ?? spec.holder;
    const key = `${c.name.toLowerCase()}|${c.d}|${c.h}|${holder}`;
    const row = out.get(key);
    const cross = !c.tealight && holder !== 'socket' && spec.finJoin === 'cross';
    if (row) row.qty++;
    else out.set(key, { name: c.name, d: c.d, h: c.h, tealight: c.tealight, qty: 1, holder, ...(cross ? { cross } : {}), hole: c.d + 2 * spec.slack });
  }
  return [...out.values()];
}

const HOLDER_SHORT: Record<Holder, string> = { target: 'target fins', slotted: 'slotted fins', socket: 'socket in the plates' };

const heldBy = (b: CandleBuy) => (b.tealight ? 'cup' : `${HOLDER_SHORT[b.holder]}${b.cross ? ' (2-piece cross)' : ''}`);

export function candleNote(b: CandleBuy): string {
  return `${heldBy(b)}, hole Ø${+b.hole.toFixed(1)} mm`;
}

export function candlesCsv(rows: CandleBuy[]): string {
  const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ['candle,diameter_mm,height_mm,qty,kind,held_by,hole_mm'];
  for (const r of rows) lines.push([r.name, String(r.d), String(r.h), String(r.qty), r.tealight ? 'tealight' : 'candlestick', heldBy(r), String(+r.hole.toFixed(1))].map(q).join(','));
  lines.push(['Total', '', '', String(rows.reduce((a, r) => a + r.qty, 0)), '', '', ''].join(','));
  return lines.join('\n') + '\n';
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
    cols: Math.round(num(r.cols, d.cols, 1, 40)),
    gapX: num(r.gapX, d.gapX, 5),
    gapZ: num(r.gapZ, d.gapZ, 5),
    snap: (Object.keys(SNAP_NAMES) as Snap[]).includes(r.snap as Snap) ? (r.snap as Snap) : d.snap,
    every: Math.round(num(r.every, d.every, 1, 100)),
    spots: Array.isArray(r.spots) ? (r.spots as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n))).map(([x, z]) => [x, z] as [number, number]) : [],
    sit: (Object.keys(SIT_NAMES) as Sit[]).includes(r.sit as Sit) ? (r.sit as Sit) : d.sit,
    lift: num(r.lift, d.lift, 0),
    crown: num(r.crown, d.crown),
    ramp: num(r.ramp, d.ramp),
    holder: r.holder === 'socket' || r.holder === 'slotted' ? r.holder : 'target',
    grip: num(r.grip, d.grip, 2),
    cup: num(r.cup, d.cup, 1),
    fins: Math.round(num(r.fins, d.fins, 2, 8)),
    reach: num(r.reach, d.reach, 3),
    spin: num(r.spin, d.spin),
    finJoin: r.finJoin === 'cross' ? 'cross' : 'separate',
    engage: num(r.engage, d.engage, 4),
    slack: num(r.slack, d.slack, 0),
    shoulder: num(r.shoulder, d.shoulder, 0),
    choke: (Object.keys(CHOKE_NAMES) as Choke[]).includes(r.choke as Choke) ? (r.choke as Choke) : d.choke,
    pad: num(r.pad, d.pad, 0),
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
    case 'grid':
    case 'free':
      // laid out in candleObjects; a line stands in for anything that asks for the path itself
      pts = [[-W / 2, 0], [W / 2, 0]];
      break;
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
/** Where the candles stand in the candelabra's own frame, with how far along the run each is (0 to 1). */
export function candleSpots(spec: CandleSpec, n: number, pitch = 0): { p: P2; f: number }[] {
  if (spec.path === 'grid') {
    const cols = Math.max(1, spec.cols);
    const rows = Math.max(1, Math.ceil(n / cols));
    const gx = spec.snap !== 'off' && pitch > 0 ? spec.every * pitch : spec.gapX;
    return Array.from({ length: n }, (_, k) => {
      const i = k % cols;
      const j = Math.floor(k / cols);
      return { p: [(i - (cols - 1) / 2) * gx, (j - (rows - 1) / 2) * spec.gapZ] as P2, f: cols > 1 ? i / (cols - 1) : 0.5 };
    });
  }
  if (spec.path === 'free') {
    // dragged spots first; any candles beyond them line up behind the last one
    const s = spec.spots;
    return Array.from({ length: n }, (_, k) => {
      const p: P2 = k < s.length ? s[k] : [(s[s.length - 1]?.[0] ?? 0) + (k - s.length + 1) * 60, s[s.length - 1]?.[1] ?? 0];
      return { p, f: n > 1 ? k / (n - 1) : 0.5 };
    });
  }
  const { pts, closed } = pathPolyline(spec);
  return spreadAlong(pts, closed, n);
}

/** The world point of a spot in the candelabra frame (before the world origin). */
export function spotToLocal(spec: CandleSpec, p: P2): P2 {
  const turn = spec.turn * D;
  return [spec.x + p[0] * Math.cos(turn) + p[1] * Math.sin(turn), spec.z - p[0] * Math.sin(turn) + p[1] * Math.cos(turn)];
}

/** The candelabra-frame spot of a point measured from the world origin (the inverse of spotToLocal). */
export function localToSpot(spec: CandleSpec, q: P2): P2 {
  const turn = spec.turn * D;
  const dx = q[0] - spec.x;
  const dz = q[1] - spec.z;
  return [dx * Math.cos(turn) - dz * Math.sin(turn), dx * Math.sin(turn) + dz * Math.cos(turn)];
}

/**
 * Line the candles up with the plates: each candle (with its holder) slides along the
 * stack to the nearest plate, or midway between the nearest two. `planes` are the
 * plates' planes (all facing the same way); world coordinates.
 */
export function snapToPlates(objs: CutObject[], planes: { origin: [number, number, number]; normal: [number, number, number] }[], snap: Snap): CutObject[] {
  if (snap === 'off' || planes.length < 2) return objs;
  const n = planes[0].normal;
  const offs = planes.map((p) => p.origin[0] * n[0] + p.origin[2] * n[2]).sort((a, b) => a - b);
  const targets = snap === 'on' ? offs : offs.slice(1).map((s, i) => (s + offs[i]) / 2);
  const shift = new Map<string, number>();
  for (const o of objs) {
    if (!o.id.startsWith('candle')) continue;
    const s = o.x * n[0] + o.z * n[2];
    let best = targets[0];
    for (const t of targets) if (Math.abs(t - s) < Math.abs(best - s)) best = t;
    shift.set(o.id.slice(6), best - s);
  }
  return objs.map((o) => {
    const m = o.id.match(/^(candle|well|pad)(\d+)$/);
    const d = m ? shift.get(m[2]) : undefined;
    return d ? { ...o, x: o.x + d * n[0], z: o.z + d * n[2] } : o;
  });
}

export function candleObjects(spec0: CandleSpec | undefined, baseTop: number, onSurface = false, pitch = 0): CutObject[] {
  if (!spec0?.on) return [];
  // sitting on the plates: heights come later from the plates themselves, and the plates keep their own tops
  const spec = onSurface ? { ...spec0, trim: false } : spec0;
  const list = candleList(spec);
  if (!list.length) return [];
  const closed = spec.path !== 'grid' && spec.path !== 'free' && pathPolyline(spec).closed;
  const spots = candleSpots(spec, list.length, pitch);
  const turn = spec.turn * D;
  const out: CutObject[] = [];
  spots.forEach(({ p, f }, i) => {
    const c = list[i];
    const [bx, bz] = [p[0] * Math.cos(turn) + p[1] * Math.sin(turn), -p[0] * Math.sin(turn) + p[1] * Math.cos(turn)];
    const x = spec.x + bx;
    const z = spec.z + bz;
    const crown = closed ? 0 : 1 - (2 * f - 1) ** 2;
    const yb = baseTop + spec.lift + spec.crown * crown + spec.ramp * f;
    const chosen: Holder = c.tealight ? c.holder ?? 'socket' : c.holder ?? spec.holder;
    // sitting into the plates, target fins can't stand in the concrete: their well would clear a hole
    // through the terrain from the concrete up, so they slot onto the plates instead and the terrain stays whole
    const holder: Holder = onSurface && chosen === 'target' ? 'slotted' : chosen;
    const grip = c.tealight ? Math.min(spec.cup, c.h - 1) : Math.min(spec.grip, c.h - 2);
    const id = `candle${i + 1}`;
    const sink = onSurface ? { sink: grip } : {};
    const choke = spec.choke === 'off' ? {} : { choke: { reach: c.d / 2 + spec.slack + (c.tealight || holder === 'socket' ? 0 : spec.reach) + spec.pad, join: spec.choke === 'path', closed } };
    const base = { kind: 'cylinder' as const, x, z, rx: 0, ry: spec.turn, rz: 0, on: true };
    if (holder === 'socket') {
      out.push({ ...base, id, name: c.name, w: c.d, h: c.h, d: c.d, y: yb + c.h / 2, clearance: spec.slack, look: c.tealight ? 'tealight' : 'candle', ...choke, ...sink, ...(spec.trim ? { seat: grip + spec.slack, shoulder: spec.shoulder } : {}) });
      return;
    }
    const slotted = holder === 'slotted';
    out.push({ ...base, id, name: c.name, w: c.d, h: c.h, d: c.d, y: yb + c.h / 2, clearance: spec.slack, look: c.tealight ? 'tealight' : 'candle', ...choke, ...sink, holder: { fins: spec.fins, reach: spec.reach, grip, spin: spec.spin, ...(spec.finJoin === 'cross' ? { cross: true } : {}), ...(slotted ? { slotted, engage: spec.engage } : {}) } });
    if (slotted && onSurface) return;
    if (slotted) {
      // slotted fins sit in the plates rather than a cleared well: the plates under them only step up to the candle's bottom
      const rp = c.d / 2 + spec.slack + spec.reach;
      const bottom = baseTop + 0.2;
      out.push({ ...base, id: `pad${i + 1}`, name: `${c.name} holder`, w: 2 * rp, h: Math.max(1, yb - bottom), d: 2 * rp, y: (bottom + yb) / 2, clearance: 0, look: 'hidden', noCut: true, ...(spec.trim ? { seat: Math.max(0.5, yb - bottom), shoulder: spec.shoulder } : {}) });
      return;
    }
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
  /** Two-piece cross: the halving slot (u0, y0, u1, y1) where this fin's partner passes through it. */
  notch?: [number, number, number, number];
}

/**
 * Target fins for one candlestick: `fins` small upright plates radiating from
 * its centre like crosshairs. Each stands `embed` mm deep in the concrete, rises
 * under the candle as a pedestal it stands on, and above the candle's bottom
 * hugs its side for `grip` mm, tapering in towards the top.
 */
export function targetFins(
  c: { x: number; z: number; r: number; bottom: number; ry: number },
  h: { fins: number; reach: number; grip: number; spin: number; slotted?: boolean; engage?: number; cross?: boolean },
  o: { t: number; embed: number; baseTop: number; slack: number; minFeature: number; fit?: number },
  index: number,
): CandleFin[] {
  const cross = h.cross ? crossFins(c, h, o, index) : null;
  if (cross) return cross;
  const n = Math.max(2, Math.min(8, Math.round(h.fins)));
  const out: CandleFin[] = [];
  // inner ends meet at the centre without overlapping
  const uIn = n === 2 ? 0.5 : o.t / 2 / Math.tan(Math.PI / n) + 0.2;
  const rc = c.r + o.slack;
  const uOut = rc + Math.max(h.reach, o.minFeature);
  const yb = c.bottom - o.baseTop;
  const yTop = yb + h.grip;
  const tip = Math.min(uOut, rc + Math.max(o.minFeature, 3));
  // target fins stand in the concrete; slotted fins hang down into the plates by their engagement
  const y0 = h.slotted ? Math.max(0, yb - (h.engage ?? 16)) : -o.embed;
  for (let k = 0; k < n; k++) {
    const a = (h.spin + c.ry) * D + (k / n) * 2 * Math.PI;
    const d: P2 = [Math.cos(a), -Math.sin(a)];
    const plane: Plane = { origin: [c.x, o.baseTop, c.z], normal: [-d[1], 0, d[0]], u: [d[0], 0, d[1]], v: [0, 1, 0] };
    const outer: P2[] =
      yb - y0 > 0.5
        ? [[uIn, y0], [uOut, y0], [uOut, yb], [tip, yTop], [rc, yTop], [rc, yb], [uIn, yb]]
        : [[rc, y0], [uOut, y0], [uOut, Math.max(yb, y0)], [tip, yTop], [rc, yTop]];
    out.push({ holder: index, fin: k, plane, shape: [{ outer, holes: [] }], labelAt: h.slotted ? [(rc + uOut) / 2, yb + (yTop - yb) / 3] : [(uIn + uOut) / 2, (y0 + Math.max(yb, 0)) / 2], labelMax: Math.max(2, (h.slotted ? Math.min(uOut - rc, yTop - yb) : Math.min(uOut - uIn, Math.max(yb, 0) - y0)) * 0.5) });
  }
  return out;
}

/** Shortest pedestal (mm) a two-piece cross needs under the candle: each half of the halving joint keeps at least this much. */
export function crossPedestal(minFeature: number): number {
  return 2 * Math.max(minFeature, 3);
}

/**
 * Two-piece target: two full-width fins, each running right across under the
 * candle, that halve together into a cross. The first is slotted from its top
 * down to half the pedestal, the second from its bottom up to the same line,
 * so the second drops onto the first and they lock square, four arms from two
 * parts. Needs a pedestal under the candle tall enough to halve
 * (`crossPedestal`); without one it returns null and the fins stay separate.
 */
function crossFins(
  c: { x: number; z: number; r: number; bottom: number; ry: number },
  h: { reach: number; grip: number; spin: number; slotted?: boolean; engage?: number },
  o: { t: number; embed: number; baseTop: number; slack: number; minFeature: number; fit?: number },
  index: number,
): CandleFin[] | null {
  const rc = c.r + o.slack;
  const uOut = rc + Math.max(h.reach, o.minFeature);
  const yb = c.bottom - o.baseTop;
  const yTop = yb + h.grip;
  const tip = Math.min(uOut, rc + Math.max(o.minFeature, 3));
  const y0 = h.slotted ? Math.max(0, yb - (h.engage ?? 16)) : -o.embed;
  if (yb - y0 < crossPedestal(o.minFeature)) return null;
  const yMid = (y0 + yb) / 2;
  const w = o.t + (o.fit ?? 0.3);
  const outer: P2[] = [[-uOut, y0], [uOut, y0], [uOut, yb], [tip, yTop], [rc, yTop], [rc, yb], [-rc, yb], [-rc, yTop], [-tip, yTop], [-uOut, yb]];
  return [0, 1].map((k) => {
    const a = (h.spin + c.ry) * D + (k * Math.PI) / 2;
    const d: P2 = [Math.cos(a), -Math.sin(a)];
    const plane: Plane = { origin: [c.x, o.baseTop, c.z], normal: [-d[1], 0, d[0]], u: [d[0], 0, d[1]], v: [0, 1, 0] };
    // the label sits on one arm's grip, clear of the middle slot
    return {
      holder: index,
      fin: k,
      plane,
      shape: [{ outer: outer.map(([u, y]) => [u, y] as P2), holes: [] }],
      labelAt: h.slotted ? [(rc + uOut) / 2, yb + (yTop - yb) / 3] : [(rc + uOut) / 2, (y0 + Math.max(yb, 0)) / 2],
      labelMax: Math.max(2, (h.slotted ? Math.min(uOut - rc, yTop - yb) : Math.min(uOut - rc, Math.max(yb, 0) - y0)) * 0.5),
      notch: k === 0 ? [-w / 2, yMid, w / 2, yb + 1] : [-w / 2, y0 - 1, w / 2, yMid],
    };
  });
}

/** Where a slotted fin crosses a plate: the halving slot cut in each, in their own plate coordinates. */
export interface FinSlot {
  /** Plate key and the slot rect in the plate (u0, y0, u1, y1). */
  plate: string;
  plateRect: [number, number, number, number];
  /** Slot rect in the fin. */
  finRect: [number, number, number, number];
}

/**
 * Halving joints between a slotted fin and the plates it crosses: the plate is
 * slotted from its top down to half the engagement, the fin from its bottom up
 * to the same line, so the fin drops onto the plates and they lock square.
 * A fin running nearly along the plates (under 30°) can't be slotted and gets none.
 */
export function finSlots(
  fin: CandleFin,
  plates: { key: string; plane: Plane; u0: number; u1: number }[],
  o: { t: number; candleBottom: number; baseTop: number; engage: number; fit: number },
): FinSlot[] {
  const c = fin.plane.origin;
  const d = fin.plane.u;
  const bb = fin.shape[0].outer.reduce((a, [u]) => [Math.min(a[0], u), Math.max(a[1], u)], [Infinity, -Infinity]);
  const yMid = o.candleBottom - o.baseTop - o.engage / 2;
  const out: FinSlot[] = [];
  for (const p of plates) {
    const n = p.plane.normal;
    if (Math.abs(n[1]) > 0.5) continue; // flat layers
    const dn = d[0] * n[0] + d[2] * n[2];
    if (Math.abs(dn) < 0.5) continue;
    const uf = ((p.plane.origin[0] - c[0]) * n[0] + (p.plane.origin[2] - c[2]) * n[2]) / dn;
    const w = o.t / Math.abs(dn) + o.fit;
    if (uf < bb[0] - w / 2 || uf > bb[1] + w / 2) continue;
    const pu = p.plane.u;
    const up = (c[0] + uf * d[0] - p.plane.origin[0]) * pu[0] + (c[2] + uf * d[2] - p.plane.origin[2]) * pu[2];
    if (up < p.u0 || up > p.u1) continue;
    out.push({ plate: p.key, plateRect: [up - w / 2, yMid, up + w / 2, 20000], finRect: [uf - w / 2, -20000, uf + w / 2, yMid] });
  }
  return out;
}

/** A circle in plan (world x, z) the choked plates keep. */
export type ChokeCircle = [number, number, number];

type Chokeable = Pick<CutObject, 'x' | 'y' | 'z' | 'kind' | 'w' | 'h' | 'rx' | 'ry' | 'rz' | 'choke'>;

const RAD = Math.PI / 180;

/** Where a choked object sits in plan: a point for a candle, its bottom edge (two ends) for a card. */
function chokeEnds(o: Chokeable): [[number, number], [number, number]] {
  if (o.kind !== 'card') return [[o.x, o.z], [o.x, o.z]];
  // the card's own x and up axes after yaw, pitch, roll (YXZ), as objectMatrix turns them
  const [cx, sx] = [Math.cos(o.rx * RAD), Math.sin(o.rx * RAD)];
  const [cy, sy] = [Math.cos(o.ry * RAD), Math.sin(o.ry * RAD)];
  const [cz, sz] = [Math.cos(o.rz * RAD), Math.sin(o.rz * RAD)];
  const ax: [number, number, number] = [cz, sz * cx, sz * sx];
  const up: [number, number, number] = [-sz, cz * cx, cz * sx];
  const plan = (v: [number, number, number]): [number, number] => [v[0] * cy + v[2] * sy, -v[0] * sy + v[2] * cy];
  const [ux, uz] = plan(up);
  const [xx, xz] = plan(ax);
  const bx = o.x - (ux * o.h) / 2;
  const bz = o.z - (uz * o.h) / 2;
  return [
    [bx - (xx * o.w) / 2, bz - (xz * o.w) / 2],
    [bx + (xx * o.w) / 2, bz + (xz * o.w) / 2],
  ];
}

/** Circles of radius `r0` to `r1` spaced along a segment, close enough that the band between them has no gaps. */
function chain(out: ChokeCircle[], a: [number, number], b: [number, number], r0: number, r1: number, ends: boolean) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const k = Math.max(1, Math.ceil(L / Math.max(2, Math.min(r0, r1) / 3)));
  for (let j = ends ? 0 : 1; j <= (ends ? k : k - 1); j++) {
    const f = j / k;
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, r0 + (r1 - r0) * f]);
  }
}

/**
 * The plan area choked plates keep, as circles: round each candle and along
 * each card's bottom edge, and, where the group joins, a chain of circles from
 * each object to the next so the plates follow the line of candles or cards.
 * Candles and shelf cards are separate groups and never join each other.
 */
export function chokeCircles(objects: Chokeable[]): ChokeCircle[] {
  const groups = new Map<string, Chokeable[]>();
  for (const o of objects) if (o.choke) groups.set(o.choke.group ?? 'candles', [...(groups.get(o.choke.group ?? 'candles') ?? []), o]);
  const out: ChokeCircle[] = [];
  for (const cs of groups.values()) {
    const ends = cs.map(chokeEnds);
    cs.forEach((c, i) => chain(out, ends[i][0], ends[i][1], c.choke!.reach, c.choke!.reach, true));
    if (!cs[0].choke!.join) continue;
    const n = cs.length;
    const links = cs[0].choke!.closed && n > 2 ? n : n - 1;
    for (let i = 0; i < links; i++) {
      const j = (i + 1) % n;
      // cards only join their neighbours in a row, not the end of one row to the start of the next
      if (cs[i].kind === 'card' && Math.hypot(ends[j][0][0] - ends[i][1][0], ends[j][0][1] - ends[i][1][1]) > Math.max(cs[i].w, cs[j].w)) continue;
      chain(out, ends[i][1], ends[j][0], cs[i].choke!.reach, cs[j].choke!.reach, false);
    }
  }
  return out;
}

/** The u-spans of a plate inside the choke circles, merged; spans narrower than `min` are dropped. */
export function chokeSpans(plane: Plane, circles: ChokeCircle[], min: number): [number, number][] {
  const o = plane.origin;
  const n = plane.normal;
  const pu = plane.u;
  const raw: [number, number][] = [];
  for (const [x, z, r] of circles) {
    const d = (x - o[0]) * n[0] + (z - o[2]) * n[2];
    if (Math.abs(d) >= r) continue;
    const h = Math.sqrt(r * r - d * d);
    const uc = (x - o[0]) * pu[0] + (z - o[2]) * pu[2];
    raw.push([uc - h, uc + h]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([...s]);
  }
  return out.filter(([a, b]) => b - a >= min);
}

/** The lowest plate top across the plates crossing a circle in plan (world x, z, radius), or null if none cross it. */
export function surfaceTop(parts: { family: string; plane: Plane; shape: Shape }[], x: number, z: number, r: number, cut: (s: Shape, u0: number, u1: number) => number | null): number | null {
  let low = Infinity;
  for (const p of parts) {
    if (p.family !== 'P' && p.family !== 'X' && p.family !== 'R') continue;
    const o = p.plane.origin;
    const n = p.plane.normal;
    if (Math.abs(n[1]) > 0.5) continue;
    const d = (x - o[0]) * n[0] + (z - o[2]) * n[2];
    if (Math.abs(d) >= r) continue;
    const h = Math.sqrt(r * r - d * d);
    const uc = (x - o[0]) * p.plane.u[0] + (z - o[2]) * p.plane.u[2];
    const top = cut(p.shape, uc - h, uc + h);
    if (top !== null) low = Math.min(low, o[1] + top);
  }
  return Number.isFinite(low) ? low : null;
}

/**
 * Candles that sit into the plates: each one's bottom drops (or rises) to its
 * sink depth below the lowest plate top under it, so every plate it crosses is
 * cut to hold it. Its holder (a target well) moves with it.
 */
export function sitOnSurface(objs: CutObject[], topAt: (x: number, z: number, r: number) => number | null): CutObject[] {
  const delta = new Map<string, number>();
  for (const o of objs) {
    if (o.sink === undefined || !o.id.startsWith('candle')) continue;
    const top = topAt(o.x, o.z, o.w / 2 + o.clearance);
    if (top === null) continue;
    delta.set(o.id.slice(6), top - o.sink - (o.y - o.h / 2));
  }
  return objs.map((o) => {
    const k = o.id.replace(/^(candle|well)/, '');
    const dy = delta.get(k);
    if (dy === undefined || (!o.id.startsWith('candle') && !o.id.startsWith('well'))) return o;
    if (o.id.startsWith('candle')) return { ...o, y: o.y + dy };
    // the well keeps its bottom on the concrete and reaches up past the candle
    const bottom = o.y - o.h / 2;
    const h = Math.max(1, o.h + dy);
    return { ...o, h, y: bottom + h / 2 };
  });
}
