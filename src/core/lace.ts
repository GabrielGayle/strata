// Lace plates: a stack drawn in lace (lace.cockpit.yoga) used as the plates themselves. Lace
// writes a `.lace-loft.json` (lace docs/SLICER_INTEGRATION.md): each plate's outline, bottom
// first, as closed contours in mm, y up, outers anticlockwise and holes clockwise, no kerf, and
// a link that opens the frame in lace. With Slicer › Slice what on Lace plates, plate i is lace
// plate i, centred across the stack and standing on the concrete line, so the plates line up
// through space as they did in lace; the slicer then cuts, tabs and checks them like any other.
import { union, rect, shapeBBox, intersection, unionShapes, type Path, type Shape } from './geom2d';

export interface LacePlate {
  name: string;
  /** The plate's layer id in lace (for Open in lace). */
  layer: string;
  contours: [number, number][][];
}

export interface LaceLoft {
  format: 'lace-loft';
  version: 1;
  name: string;
  /** Sheet thickness lace drew it for (mm). */
  thickness: number;
  metal?: string;
  /** Opens the frame in lace. */
  link: string;
  plates: LacePlate[];
}

const LACE_HOSTS = /^https:\/\/([a-z0-9-]+\.)*cockpit\.yoga\/|^http:\/\/localhost(:\d+)?\//;

const isPoint = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** A lace loft from parsed JSON, or null when it isn't one. Throws on a damaged one. */
export function readLaceLoft(raw: unknown): LaceLoft | null {
  const r = raw as Partial<LaceLoft> | null;
  if (!r || r.format !== 'lace-loft') return null;
  if (r.version !== 1) throw new Error(`lace loft version ${String(r.version)} is newer than this Strata reads`);
  if (!Array.isArray(r.plates) || !r.plates.length) throw new Error('the lace loft has no plates');
  const plates = r.plates.map((p, i) => ({
    name: String(p?.name ?? `plate ${i + 1}`),
    layer: String(p?.layer ?? ''),
    contours: (Array.isArray(p?.contours) ? p.contours : []).map((c) => (Array.isArray(c) ? c.filter(isPoint).map(([x, y]) => [x, y] as [number, number]) : [])).filter((c) => c.length >= 3),
  }));
  const T = Number(r.thickness);
  return {
    format: 'lace-loft',
    version: 1,
    name: String(r.name ?? 'lace'),
    thickness: Number.isFinite(T) && T > 0 ? T : 1.5,
    ...(r.metal ? { metal: String(r.metal) } : {}),
    // only ever a link to lace itself
    link: typeof r.link === 'string' && LACE_HOSTS.test(r.link) ? r.link : '',
    plates,
  };
}

/** The whole stack's box in lace's frame, so every plate is placed the same way. */
export function laceBox(loft: LaceLoft): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of loft.plates)
    for (const c of p.contours)
      for (const [x, y] of c) (minX = Math.min(minX, x)), (maxX = Math.max(maxX, x)), (minY = Math.min(minY, y)), (maxY = Math.max(maxY, y));
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : { minX: 0, maxX: 0, minY: 0, maxY: 0 };
}

/**
 * Plate `index`'s outline in plate coordinates (u across, v up): centred across the stack, its
 * foot on v = 0 (a flat layer is centred both ways). An embedded tab `embed` deep runs under its
 * foot, `inset` in from each end, as on a sliced source form.
 */
export function laceOutline(loft: LaceLoft, index: number, opts: { flat: boolean; embed: number; inset: number }): Shape {
  const p = loft.plates[index];
  if (!p) return [];
  const b = laceBox(loft);
  const cx = (b.minX + b.maxX) / 2;
  const oy = opts.flat ? (b.minY + b.maxY) / 2 : b.minY;
  const paths: Path[] = p.contours.map((c) => c.map(([x, y]) => [x - cx, y - oy]));
  const sec = union(paths, 'nonzero');
  if (opts.flat || opts.embed <= 0 || !sec.length) return sec;
  const band = intersection(sec, rect(-1e6, 0, 1e6, 0.3));
  if (!band.length) return sec;
  const bb = shapeBBox(band);
  const inset = Math.max(0, Math.min(opts.inset, (bb.maxX - bb.minX) / 2 - 3));
  return unionShapes(sec, rect(bb.minX + inset, -opts.embed, bb.maxX - inset, 0.15));
}

/** The link that opens plate `index` in lace (empty when the loft has no link). */
export function laceLink(loft: LaceLoft, index: number): string {
  const p = loft.plates[index];
  if (!loft.link || !p) return '';
  return p.layer ? `${loft.link}&layer=${encodeURIComponent(p.layer)}` : loft.link;
}
