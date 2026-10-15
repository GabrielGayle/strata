// Appearance: plates sorted into material buckets, so one piece can mix metals
// (Corten plates with aluminium fins, say). Plates in no bucket are the main
// material (Plates › Material). Each bucket has a metal and a finish; the
// metal drives everything physical (mass, cut files, nesting, price, tuning),
// the finish only how it looks.
import { mulberry32 } from './rng';

export const METAL_NAMES: Record<string, string> = { corten: 'Corten steel', steel: 'Mild steel', aluminium: 'Aluminium' };
export const METAL_IDS = Object.keys(METAL_NAMES);

export interface Look {
  color: string;
  metalness: number;
  roughness: number;
}

export interface Finish {
  id: string;
  label: string;
  look: Look;
  /** The colour is the user's (anodising, powder coat). */
  coloured?: boolean;
}

export const FINISHES: Record<string, Finish[]> = {
  corten: [
    { id: 'weathered', label: 'Weathered', look: { color: '#8b4a2a', metalness: 0.35, roughness: 0.82 } },
    { id: 'fresh', label: 'Fresh (mill scale)', look: { color: '#4a4b4d', metalness: 0.6, roughness: 0.55 } },
    { id: 'deep', label: 'Deep rust', look: { color: '#5e2a17', metalness: 0.2, roughness: 0.92 } },
  ],
  steel: [
    { id: 'mill', label: 'Mill', look: { color: '#5f666b', metalness: 0.85, roughness: 0.42 } },
    { id: 'brushed', label: 'Brushed', look: { color: '#8a9095', metalness: 0.9, roughness: 0.3 } },
    { id: 'blackened', label: 'Blackened', look: { color: '#26282a', metalness: 0.7, roughness: 0.5 } },
    { id: 'powder', label: 'Powder coat', look: { color: '#2f5f9e', metalness: 0.05, roughness: 0.6 }, coloured: true },
  ],
  aluminium: [
    { id: 'brushed', label: 'Brushed', look: { color: '#c3c7cb', metalness: 0.9, roughness: 0.3 } },
    { id: 'polished', label: 'Polished', look: { color: '#e4e6e8', metalness: 1, roughness: 0.12 } },
    { id: 'anodised', label: 'Anodised', look: { color: '#b8862e', metalness: 0.75, roughness: 0.35 }, coloured: true },
    { id: 'powder', label: 'Powder coat', look: { color: '#2f5f9e', metalness: 0.05, roughness: 0.6 }, coloured: true },
  ],
};

export interface Bucket {
  id: string;
  name: string;
  material: string;
  finish?: string;
  /** For coloured finishes. */
  color?: string;
}

export interface Appearance {
  /** Finish of the main material (plates in no bucket). */
  main?: { finish?: string; color?: string };
  buckets: Bucket[];
  /** Plate key (P3, X1, C2…) → bucket id. */
  assign: Record<string, string>;
}

export const MAIN = 'main';

export function finishOf(material: string, finish?: string): Finish {
  const list = FINISHES[material] ?? FINISHES.steel;
  return list.find((f) => f.id === finish) ?? list[0];
}

export function lookOf(material: string, finish?: string, color?: string): Look {
  const f = finishOf(material, finish);
  return f.coloured && color ? { ...f.look, color } : f.look;
}

export function bucketOf(app: Appearance | undefined, key: string): Bucket | null {
  const id = app?.assign[key];
  return (id && app!.buckets.find((b) => b.id === id)) || null;
}

/** The metal a plate is cut from. */
export function materialOf(app: Appearance | undefined, key: string, main: string): string {
  return bucketOf(app, key)?.material ?? main;
}

/** Whether any plate is in a bucket whose metal differs from the main one. */
export function isMixed(app: Appearance | undefined, main: string): boolean {
  if (!app) return false;
  return Object.values(app.assign).some((id) => {
    const b = app.buckets.find((x) => x.id === id);
    return b && b.material !== main;
  });
}

/** A key that changes only when some plate's metal does (for pipeline caching). */
export function materialKey(app: Appearance | undefined, main: string): string {
  if (!app) return main;
  return (
    main +
    '|' +
    Object.keys(app.assign)
      .sort()
      .map((k) => `${k}=${materialOf(app, k, main)}`)
      .filter((s) => !s.endsWith(`=${main}`))
      .join(',')
  );
}

export function defaultAppearance(): Appearance {
  return { buckets: [{ id: 'b1', name: 'Aluminium', material: 'aluminium', finish: 'brushed' }], assign: {} };
}

export function newBucketId(app: Appearance): string {
  let i = app.buckets.length + 1;
  while (app.buckets.some((b) => b.id === `b${i}`)) i++;
  return `b${i}`;
}

/** Put plates in a bucket (MAIN takes them out of every bucket). */
export function assignPlates(app: Appearance, keys: string[], bucket: string): Appearance {
  const assign = { ...app.assign };
  for (const k of keys) {
    if (bucket === MAIN) delete assign[k];
    else assign[k] = bucket;
  }
  return { ...app, assign };
}

export function removeBucket(app: Appearance, id: string): Appearance {
  const assign = Object.fromEntries(Object.entries(app.assign).filter(([, b]) => b !== id));
  return { ...app, buckets: app.buckets.filter((b) => b.id !== id), assign };
}

export function cleanAppearance(raw: unknown): Appearance | undefined {
  const r = raw as Partial<Appearance> | null | undefined;
  if (!r || !Array.isArray(r.buckets)) return undefined;
  const buckets: Bucket[] = r.buckets
    .filter((b) => b && typeof b.id === 'string' && b.id !== MAIN)
    .map((b) => ({
      id: b.id,
      name: String(b.name ?? b.id),
      material: METAL_NAMES[b.material] ? b.material : 'steel',
      ...(typeof b.finish === 'string' ? { finish: b.finish } : {}),
      ...(typeof b.color === 'string' ? { color: b.color } : {}),
    }));
  const ids = new Set(buckets.map((b) => b.id));
  const assign: Record<string, string> = {};
  for (const [k, id] of Object.entries(r.assign ?? {})) if (typeof id === 'string' && ids.has(id)) assign[k] = id;
  const main = r.main && typeof r.main === 'object' ? { finish: r.main.finish, color: r.main.color } : undefined;
  return { ...(main ? { main } : {}), buckets, assign };
}

// ── quick fills ────────────────────────────────────────────────────────────

/** A plate as the quick fills see it: its key and how tall it stands. */
export interface FillPlate {
  key: string;
  height: number;
}

export type FillPattern = 'all' | 'nth' | 'firstHalf' | 'secondHalf' | 'middle' | 'ends' | 'tallest' | 'shortest' | 'random' | 'fade';

export const FILLS: { id: FillPattern; label: string; title: string }[] = [
  { id: 'all', label: 'All', title: 'Every plate in the group' },
  { id: 'nth', label: 'Every Nth', title: 'Every Nth plate, starting from the offset' },
  { id: 'firstHalf', label: 'First half', title: 'The front half of the stack (bottom half of a flat stack)' },
  { id: 'secondHalf', label: 'Second half', title: 'The back half of the stack (top half of a flat stack)' },
  { id: 'middle', label: 'Middle', title: 'The middle third' },
  { id: 'ends', label: 'Ends', title: 'The first and last sixth' },
  { id: 'tallest', label: 'Tallest', title: 'The tallest third of the plates' },
  { id: 'shortest', label: 'Shortest', title: 'The shortest third of the plates' },
  { id: 'random', label: 'Scatter', title: 'A random third of the plates (press again for another)' },
  { id: 'fade', label: 'Fade', title: 'Sparse at the front, dense at the back (press again for another)' },
];

/** Which of `plates` (in stack order) a pattern picks. */
export function pickPlates(plates: FillPlate[], pattern: FillPattern, opts: { n?: number; offset?: number; seed?: number } = {}): string[] {
  const n = plates.length;
  if (!n) return [];
  const third = Math.max(1, Math.round(n / 3));
  const rnd = mulberry32((opts.seed ?? 1) >>> 0);
  const byHeight = () => plates.map((p, i) => ({ h: p.height, i })).sort((a, b) => b.h - a.h || a.i - b.i);
  let pick: (p: FillPlate, i: number) => boolean;
  switch (pattern) {
    case 'all':
      pick = () => true;
      break;
    case 'nth': {
      const every = Math.max(2, Math.round(opts.n ?? 2));
      const off = (((Math.round(opts.offset ?? 0) % every) + every) % every);
      pick = (_, i) => i % every === off;
      break;
    }
    case 'firstHalf':
      pick = (_, i) => i < Math.ceil(n / 2);
      break;
    case 'secondHalf':
      pick = (_, i) => i >= Math.floor(n / 2);
      break;
    case 'middle': {
      const a = Math.floor((n - third) / 2);
      pick = (_, i) => i >= a && i < a + third;
      break;
    }
    case 'ends': {
      const e = Math.max(1, Math.round(n / 6));
      pick = (_, i) => i < e || i >= n - e;
      break;
    }
    case 'tallest': {
      const s = new Set(byHeight().slice(0, third).map((x) => x.i));
      pick = (_, i) => s.has(i);
      break;
    }
    case 'shortest': {
      const s = new Set(byHeight().slice(-third).map((x) => x.i));
      pick = (_, i) => s.has(i);
      break;
    }
    case 'random': {
      // exactly a third, so a scatter always reads as a mix
      const order = plates.map((_, i) => ({ i, r: rnd() })).sort((a, b) => a.r - b.r);
      const s = new Set(order.slice(0, third).map((x) => x.i));
      pick = (_, i) => s.has(i);
      break;
    }
    case 'fade':
      pick = (_, i) => rnd() < (n === 1 ? 1 : i / (n - 1));
      break;
  }
  return plates.filter((p, i) => pick(p, i)).map((p) => p.key);
}

/**
 * Run a fill over a group of plates: the picked ones go in `bucket`, and the
 * group's other plates that were in `bucket` go back to the main material, so
 * trying one pattern after another doesn't pile them up.
 */
export function applyFill(app: Appearance, group: FillPlate[], bucket: string, picked: string[]): Appearance {
  const chosen = new Set(picked);
  const assign = { ...app.assign };
  for (const p of group) {
    const cur = assign[p.key] ?? MAIN;
    if (chosen.has(p.key)) {
      if (bucket === MAIN) delete assign[p.key];
      else assign[p.key] = bucket;
    } else if (cur === bucket && bucket !== MAIN) delete assign[p.key];
  }
  return { ...app, assign };
}

/** The keys from `a` to `b` inclusive in stack order, for shift-click runs. */
export function runBetween(order: string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}
