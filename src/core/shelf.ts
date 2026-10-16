// Postcard shelf: a list of card sizes laid edge to edge along an arc, each
// card standing in a notch cut into the plates it crosses. The plate tops are
// trimmed down to just above each card's bottom edge (its "seat"), so every
// card is held and none is hidden behind plates.
import type { CutObject } from './objects';

export type ShelfLayout = 'fan' | 'bands' | 'arch' | 'spiral';

export const LAYOUT_NAMES: Record<ShelfLayout, string> = {
  fan: 'Fan (one curved row)',
  bands: 'Bands (rows rising behind)',
  arch: 'Arch (rainbow standing up)',
  spiral: 'Spiral (climbing curve)',
};

export interface ShelfSpec {
  on: boolean;
  /** One card per line (or separated by commas/semicolons): "148 x 105 Venice". */
  cards: string;
  layout: ShelfLayout;
  /** Radius of the arc (mm): in plan for fan, bands and spiral, upright for the arch. */
  radius: number;
  /** Space between neighbouring cards along the arc (mm). */
  gap: number;
  /** Bands: how many rows. */
  rows: number;
  /** Bands and spiral: how far each row (or each turn) steps out (mm). */
  rowStep: number;
  /** Bands: how much higher each row behind stands (mm). Spiral: total climb. */
  rowRise: number;
  /** How deep each card's bottom edge sits in the plates (mm). */
  seat: number;
  /** Lean back from upright (degrees). */
  lean: number;
  /** Card thickness (mm). */
  thick: number;
  /** Gap around each card in its notch (mm). */
  clearance: number;
  /** Width of plate kept either side of each notch (mm). */
  shoulder: number;
  /** Where the arc sits (mm from the centre of the base) and which way it faces (degrees). */
  x: number;
  z: number;
  turn: number;
  /** Lowest seat height above the concrete (mm). */
  lift: number;
  /** Trim the plate tops down to the cards' seats. */
  trim: boolean;
}

export const DEFAULT_SHELF: ShelfSpec = {
  on: true,
  cards: '148 x 105\n148 x 105\n150 x 100\n105 x 148\n148 x 105\n152 x 102\n148 x 105',
  layout: 'fan',
  radius: 450,
  gap: 6,
  rows: 2,
  rowStep: 60,
  rowRise: 50,
  seat: 18,
  lean: 8,
  thick: 0.4,
  clearance: 0.5,
  shoulder: 5,
  x: 0,
  z: 0,
  turn: 0,
  lift: 40,
  trim: true,
};

export interface CardSize {
  w: number;
  h: number;
  name: string;
}

/** Card sizes from typed text: "148 x 105 Venice", "150×100", "105 by 148"… one per line, comma or semicolon. */
export function parseCards(text: string): { cards: CardSize[]; bad: string[] } {
  const cards: CardSize[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[\n;,]+/)) {
    const s = raw.trim();
    if (!s) continue;
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(?:mm)?\s*(?:x|×|\*|by)\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*(.*)$/i);
    if (!m) {
      bad.push(s);
      continue;
    }
    const w = parseFloat(m[1]);
    const h = parseFloat(m[2]);
    if (!(w >= 10 && h >= 10 && w <= 2000 && h <= 2000)) {
      bad.push(s);
      continue;
    }
    cards.push({ w, h, name: m[3].trim() || `Card ${cards.length + 1}` });
  }
  return { cards, bad };
}

const num = (x: unknown, def: number, lo = -Infinity, hi = Infinity) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def);

export function cleanShelf(raw: unknown): ShelfSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_SHELF;
  return {
    on: r.on !== false,
    cards: typeof r.cards === 'string' ? r.cards : d.cards,
    layout: (Object.keys(LAYOUT_NAMES) as ShelfLayout[]).includes(r.layout as ShelfLayout) ? (r.layout as ShelfLayout) : d.layout,
    radius: num(r.radius, d.radius, 20),
    gap: num(r.gap, d.gap, 0),
    rows: Math.round(num(r.rows, d.rows, 1, 12)),
    rowStep: num(r.rowStep, d.rowStep, 0),
    rowRise: num(r.rowRise, d.rowRise),
    seat: num(r.seat, d.seat, 1),
    lean: num(r.lean, d.lean, -45, 45),
    thick: num(r.thick, d.thick, 0.1),
    clearance: num(r.clearance, d.clearance, 0),
    shoulder: num(r.shoulder, d.shoulder, 0),
    x: num(r.x, d.x),
    z: num(r.z, d.z),
    turn: num(r.turn, d.turn),
    lift: num(r.lift, d.lift, 0),
    trim: r.trim !== false,
  };
}

/** Split the cards into rows whose lengths grow with each row's radius, keeping their order. */
function splitRows(cards: CardSize[], gap: number, radii: number[]): CardSize[][] {
  const total = cards.reduce((a, c) => a + c.w + gap, 0);
  const rsum = radii.reduce((a, r) => a + r, 0);
  const rows: CardSize[][] = radii.map(() => []);
  let row = 0;
  let acc = 0;
  let target = (total * radii[0]) / rsum;
  for (const c of cards) {
    if (row < radii.length - 1 && acc + (c.w + gap) / 2 > target && rows[row].length) {
      row++;
      target += (total * radii[row]) / rsum;
    }
    rows[row].push(c);
    acc += c.w + gap;
  }
  return rows;
}

const D = Math.PI / 180;

/**
 * The cards as placed objects, in world mm (y up, base centred on the origin).
 * `baseTop` is the top of the concrete. Each card carries `seat`, so the slicer
 * trims the plates down to it.
 */
export function shelfCards(spec: ShelfSpec | undefined, baseTop: number): CutObject[] {
  if (!spec?.on) return [];
  const { cards } = parseCards(spec.cards);
  if (!cards.length) return [];
  const out: CutObject[] = [];
  const turn = spec.turn * D;
  // place a card by its bottom-edge centre (px, py, pz), facing yaw (radians) and rolled by roll (radians)
  const put = (c: CardSize, i: number, px: number, py: number, pz: number, yaw: number, roll: number) => {
    // the card stands on its bottom edge, leaning back by `lean` and rolled by `roll` in its own plane
    const lean = spec.lean * D;
    // centre = bottom + (h/2) along the card's own up direction
    const upLocal: [number, number, number] = [-Math.sin(roll), Math.cos(roll), 0];
    // lean about the card's local x axis (tips its top backwards, away from the viewer)
    const ul: [number, number, number] = [upLocal[0], upLocal[1] * Math.cos(lean), upLocal[1] * Math.sin(lean)];
    // then yaw about y, then the shelf's own turn
    const a = yaw + turn;
    const up: [number, number, number] = [ul[0] * Math.cos(a) + ul[2] * Math.sin(a), ul[1], -ul[0] * Math.sin(a) + ul[2] * Math.cos(a)];
    const [bx, bz] = [px * Math.cos(turn) + pz * Math.sin(turn), -px * Math.sin(turn) + pz * Math.cos(turn)];
    out.push({
      id: `shelf${i + 1}`,
      name: c.name,
      kind: 'card',
      w: c.w,
      h: c.h,
      d: spec.thick,
      x: spec.x + bx + (up[0] * c.h) / 2,
      y: py + (up[1] * c.h) / 2,
      z: spec.z + bz + (up[2] * c.h) / 2,
      rx: spec.lean,
      ry: a / D,
      rz: roll / D,
      clearance: spec.clearance,
      on: true,
      ...(spec.trim ? { seat: spec.seat, shoulder: spec.shoulder } : {}),
    });
  };
  const y0 = baseTop + spec.lift - spec.seat;

  if (spec.layout === 'arch') {
    // a rainbow standing up: bottom edges follow a semicircle in the front plane, cards facing the viewer (+z) and leaning back
    const R = spec.radius;
    const L = cards.reduce((a, c) => a + c.w, 0) + spec.gap * (cards.length - 1);
    const span = Math.min(L / R, Math.PI * 0.98);
    const k = span / L; // radians per mm of arc
    const cy = y0 - R * Math.cos(span / 2);
    let s = -L / 2;
    cards.forEach((c, i) => {
      const th = (s + c.w / 2) * k;
      s += c.w + spec.gap;
      put(c, i, R * Math.sin(th), cy + R * Math.cos(th), 0, Math.PI, th);
    });
    return out;
  }

  // plan arcs: the arc bulges away from the viewer (towards -z), cards face its centre and lean back
  const fanRow = (row: CardSize[], R: number, y: number, z0: number, start: number) => {
    const L = row.reduce((a, c) => a + c.w, 0) + spec.gap * Math.max(0, row.length - 1);
    const span = L / R;
    const cz = z0 - R + (R * (1 - Math.cos(Math.min(span, 2 * Math.PI) / 2))) / 2;
    let s = -L / 2;
    row.forEach((c, j) => {
      const th = (s + c.w / 2) / R;
      s += c.w + spec.gap;
      put(c, start + j, R * Math.sin(th), y, -(cz + R * Math.cos(th)), Math.PI - th, 0);
    });
  };

  if (spec.layout === 'fan') fanRow(cards, spec.radius, y0, 0, 0);
  else if (spec.layout === 'bands') {
    const n = Math.min(spec.rows, cards.length);
    const radii = Array.from({ length: n }, (_, r) => spec.radius + r * spec.rowStep);
    let start = 0;
    splitRows(cards, spec.gap, radii).forEach((row, r) => {
      // each row stands further back and higher, like seats in a theatre
      fanRow(row, radii[r], y0 + r * spec.rowRise, (r - (n - 1) / 2) * spec.rowStep, start);
      start += row.length;
    });
  } else {
    // spiral: the radius grows by rowStep and the cards climb rowRise over the whole run
    const L = cards.reduce((a, c) => a + c.w, 0) + spec.gap * (cards.length - 1);
    let s = 0;
    let th = 0;
    cards.forEach((c, i) => {
      const f = (s + c.w / 2) / L;
      const R = spec.radius + spec.rowStep * f * 2;
      th += c.w / 2 / R;
      put(c, i, R * Math.sin(th), y0 + spec.rowRise * f, spec.radius - R * Math.cos(th), Math.PI - th, 0);
      th += (c.w / 2 + spec.gap) / R;
      s += c.w + spec.gap;
    });
  }
  return out;
}
