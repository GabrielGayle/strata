// The build pack: one printable document to tape to the workshop wall. The
// numbered plate layout, a plate schedule, the assembly order, rod and spacer
// positions, the glue-up order for a flat stack, the pour plan and the
// bought-in parts, all read off the model the pipeline already built. It opens
// as a page; Print (or Save as PDF) gives clean A4 pages.
import type { Model } from './pipeline';
import type { Project } from './project';
import type { Part, PlateInfo } from './slicer';
import { embedOf } from './slicer';
import { stackFrame } from './heightfield';
import { planeToWorld, type V3 } from './section';
import type { Shape } from './geom2d';
import { basePlan } from './base';
import { bucketOf, finishOf, METAL_NAMES } from './appearance';
import { isIdentity } from './moves';
import { DEFAULT_RATES, estimateMix, withHardware, type PriceRates } from './price';
import type { Rod, RodPlan } from './brace';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** A length in mm: whole numbers stay whole, anything else gets one decimal. */
const n1 = (x: number) => (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : x.toFixed(1));
const mm = (x: number) => `${n1(x)} mm`;
const px = (x: number) => x.toFixed(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type P2 = [number, number];

export interface BuildPackOptions {
  /** Rates for the cost line (the user's edited ones, when the UI has them). */
  rates?: PriceRates;
  /** Printed on the cover; today when left out. */
  date?: Date;
}

// --- views ---------------------------------------------------------------------

/** Seen from the front: world x/z of "right" and of "towards the back". The front is the -stack end (the Front view's end). */
function viewOf(m: Model) {
  const f = stackFrame(m.v);
  const back: P2 = [f.stack[0], f.stack[1]];
  const right: P2 = [-f.stack[1], f.stack[0]];
  const plan = (w: V3): P2 => [w[0] * right[0] + w[2] * right[1], w[0] * back[0] + w[2] * back[1]];
  return { back, right, plan, stackLen: f.stackLen, acrossLen: f.acrossLen };
}
type View = ReturnType<typeof viewOf>;

const upright = (p: Part) => Math.abs(p.plane.normal[1]) < 0.5;
const isMain = (p: Part) => p.family === 'P' || p.family === 'X' || p.family === 'R';

/** A part's footprint seen from above, in plan coords (right, back). */
function footprint(p: Part, view: View): P2[][] {
  if (upright(p)) {
    const y = Math.max(p.bbox.minY, Math.min(0, p.bbox.maxY));
    const h = p.thickness / 2;
    const c = (u: number, w: number) => view.plan(planeToWorld(p.plane, u, y, w));
    return [[c(p.bbox.minX, -h), c(p.bbox.maxX, -h), c(p.bbox.maxX, h), c(p.bbox.minX, h)]];
  }
  return p.shape.flatMap((ex) => [ex.outer, ...ex.holes]).map((path) => path.map(([a, b]) => view.plan(planeToWorld(p.plane, a, b))));
}

/** A part's outline seen in elevation: x along `right` (world x/z), y up. */
function elevation(p: Part, right: P2): P2[] {
  const at = (w: V3): P2 => [w[0] * right[0] + w[2] * right[1], w[1]];
  if (upright(p)) return p.shape[0].outer.map(([a, b]) => at(planeToWorld(p.plane, a, b)));
  // flat parts read as a bar the sheet's thickness
  const xs = p.shape[0].outer.map(([a, b]) => at(planeToWorld(p.plane, a, b))[0]);
  const y = p.plane.origin[1], h = p.thickness / 2;
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  return [[x0, y - h], [x1, y - h], [x1, y + h], [x0, y + h]];
}

function hull(pts: P2[]): P2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [], hi: P2[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

/** The insert's points in world space, thinned (only for outlines). */
function insertPoints(m: Model): V3[] {
  const pos = m.insert && m.v.insShape !== 'none' ? m.insert.mesh.pos : null;
  if (!pos) return [];
  const step = Math.max(1, Math.floor(pos.length / 3 / 4000));
  const out: V3[] = [];
  for (let i = 0; i + 2 < pos.length; i += 3 * step) out.push([pos[i], pos[i + 1], pos[i + 2]]);
  return out;
}

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}
const boxOf = (pts: P2[]): Box =>
  pts.reduce((b, [x, y]) => ({ minX: Math.min(b.minX, x), maxX: Math.max(b.maxX, x), minY: Math.min(b.minY, y), maxY: Math.max(b.maxY, y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

/** Fit a box of drawing units into W × H px, with margins (left, right, top, bottom); y runs up. */
function fitBox(b: Box, maxW: number, maxH: number, m: [number, number, number, number]) {
  const bw = Math.max(1e-6, b.maxX - b.minX), bh = Math.max(1e-6, b.maxY - b.minY);
  const s = Math.min((maxW - m[0] - m[1]) / bw, (maxH - m[2] - m[3]) / bh);
  const w = bw * s + m[0] + m[1], h = bh * s + m[2] + m[3];
  return { s, w, h, X: (x: number) => m[0] + (x - b.minX) * s, Y: (y: number) => m[2] + (b.maxY - y) * s };
}

/** Polyline path data in px, dropping points that land on the same tenth of a pixel. */
function pathD(pts: P2[], X: (x: number) => number, Y: (y: number) => number, close = true): string {
  let d = '', last = '';
  for (const [x, y] of pts) {
    const k = `${px(X(x))},${px(Y(y))}`;
    if (k === last) continue;
    d += (d ? 'L' : 'M') + k;
    last = k;
  }
  return d + (close && d ? 'Z' : '');
}

/** A round number for a scale bar about a fifth of `span`. */
function niceLength(span: number): number {
  const raw = span / 5;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((k) => k * p).reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
}

function scaleBar(x: number, y: number, s: number, span: number): string {
  const L = niceLength(span);
  return `<g class="dim"><line x1="${px(x)}" y1="${px(y)}" x2="${px(x + L * s)}" y2="${px(y)}" stroke-width="2"/><line x1="${px(x)}" y1="${px(y - 4)}" x2="${px(x)}" y2="${px(y + 4)}"/><line x1="${px(x + L * s)}" y1="${px(y - 4)}" x2="${px(x + L * s)}" y2="${px(y + 4)}"/><text x="${px(x + L * s + 6)}" y="${px(y + 4)}" font-size="11">${L} mm</text></g>`;
}

/** A dimension line between two points with the text beside it. */
function dim(x1: number, y1: number, x2: number, y2: number, label: string, side: 'above' | 'below' | 'left' | 'right'): string {
  const tick = (x: number, y: number) => (y1 === y2 ? `<line x1="${px(x)}" y1="${px(y - 5)}" x2="${px(x)}" y2="${px(y + 5)}"/>` : `<line x1="${px(x - 5)}" y1="${px(y)}" x2="${px(x + 5)}" y2="${px(y)}"/>`);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const t =
    side === 'above' ? `<text x="${px(mx)}" y="${px(my - 6)}" text-anchor="middle">${label}</text>`
    : side === 'below' ? `<text x="${px(mx)}" y="${px(my + 15)}" text-anchor="middle">${label}</text>`
    : side === 'left' ? `<text x="${px(mx - 8)}" y="${px(my + 4)}" text-anchor="end">${label}</text>`
    : `<text x="${px(mx + 8)}" y="${px(my + 4)}">${label}</text>`;
  return `<g class="dim"><line x1="${px(x1)}" y1="${px(y1)}" x2="${px(x2)}" y2="${px(y2)}"/>${tick(x1, y1)}${tick(x2, y2)}${t}</g>`;
}

/** A small outline of a part, for the tables. */
function thumb(shape: Shape, w = 76, h = 42): string {
  const outers = shape.map((e) => e.outer);
  if (!outers.length) return '';
  const b = boxOf(outers.flat());
  const f = fitBox(b, w, h, [2, 2, 2, 2]);
  const d = shape.map((e) => [e.outer, ...e.holes].map((p) => pathD(p, f.X, f.Y)).join('')).join('');
  return `<svg class="thumb" width="${px(f.w)}" height="${px(f.h)}" viewBox="0 0 ${px(f.w)} ${px(f.h)}"><path d="${d}" fill="#d9d9d9" stroke="#000" stroke-width="0.7" fill-rule="evenodd"/></svg>`;
}

// --- naming ----------------------------------------------------------------------

/** One name for all the pieces of a plate: S-05, or S-05a,b when it comes in pieces. */
function plateName(parts: Part[]): string {
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].id;
  const stem = parts[0].id.slice(0, -1);
  return parts.every((p) => p.id.slice(0, -1) === stem) ? `${stem}${parts.map((p) => p.id.slice(-1)).join(',')}` : parts.map((p) => p.id).join(', ');
}

const keyNames = (m: Model) => {
  const out = new Map<string, string>();
  for (const pl of m.sliced.plates) if (pl.parts.length) out.set(pl.def.key, plateName(pl.parts));
  for (const p of m.sliced.parts) if (!out.has(p.plateKey)) out.set(p.plateKey, p.id);
  return out;
};

/** "S-01 … S-40" for a run of names. */
const run = (names: string[]) => (names.length > 2 ? `${names[0]} … ${names[names.length - 1]}` : names.join(' and '));

function metalOf(project: Project, m: Model, key: string) {
  const b = bucketOf(project.appearance, key);
  const material = b?.material ?? String(m.v.plateMaterial);
  const f = finishOf(material, b ? b.finish : project.appearance?.main?.finish);
  const color = b ? b.color : project.appearance?.main?.color;
  return { material, label: `${METAL_NAMES[material] ?? material}, ${f.label.toLowerCase()}${f.coloured && color ? ` ${color}` : ''}` };
}

function moveText(project: Project, view: View, key: string): string {
  const mv = project.moves?.[key];
  if (!mv || isIdentity(mv)) return '';
  const along = mv.t[0] * view.back[0] + mv.t[2] * view.back[1];
  const across = mv.t[0] * view.right[0] + mv.t[2] * view.right[1];
  const turn = (2 * Math.acos(Math.min(1, Math.abs(mv.q[3]))) * 180) / Math.PI;
  const bits = [
    Math.abs(along) >= 0.5 && `${n1(Math.abs(along))} mm ${along > 0 ? 'back' : 'forward'}`,
    Math.abs(across) >= 0.5 && `${n1(Math.abs(across))} mm ${across > 0 ? 'right' : 'left'}`,
    Math.abs(mv.t[1]) >= 0.5 && `${n1(Math.abs(mv.t[1]))} mm ${mv.t[1] > 0 ? 'up' : 'down'}`,
    turn >= 0.5 && `turned ${n1(turn)}°`,
  ].filter(Boolean);
  return bits.length ? bits.join(', ') : 'nudged';
}

/** Where a part sits, in words a tape measure can check. */
function positionText(m: Model, view: View, p: Part): string {
  const o = p.plane.origin;
  const [x, b] = view.plan(o);
  if (m.v.sliceMode === 'flat' && p.family === 'P') {
    const y0 = p.index * p.thickness;
    return `layer ${p.index + 1}: ${n1(y0)}–${mm(y0 + p.thickness)} up`;
  }
  if (p.family === 'P') return `${mm(b + view.stackLen / 2)} from front`;
  if (p.family === 'X') return `${mm(x + view.acrossLen / 2)} from left`;
  if (p.family === 'R') {
    const [ux, ub] = [p.plane.u[0] * view.right[0] + p.plane.u[2] * view.right[1], p.plane.u[0] * view.back[0] + p.plane.u[2] * view.back[1]];
    const deg = ((Math.atan2(-ux, -ub) * 180) / Math.PI + 360) % 360;
    return `${n1(deg)}° clockwise from front`;
  }
  if (p.family === 'C' || p.family === 'T') return Math.abs(x) < 0.5 ? 'on the centre line' : `${mm(Math.abs(x))} ${x > 0 ? 'right' : 'left'} of centre`;
  return 'cast in';
}

// --- drawings --------------------------------------------------------------------

function planSvg(m: Model, view: View, names: Map<string, string>): string {
  const v = m.v;
  const flat = v.sliceMode === 'flat';
  const parts = m.sliced.parts;
  const basePts: P2[] = v.baseOn ? basePlan(v).map(([x, pz]) => view.plan([x, 0, -pz])) : [];
  const foot = new Map(parts.map((p) => [p, footprint(p, view)]));
  const ins = insertPoints(m).map((w) => view.plan(w));
  const all = [...basePts, ...[...foot.values()].flat(2), ...ins];
  if (!all.length) return '';
  const b = boxOf(all);
  const radial = v.sliceMode === 'radial';
  const f = fitBox(b, 690, 880, radial ? [70, 70, 50, 70] : [92, 92, 54, 72]);
  const font = 11;
  const out: string[] = [];
  if (basePts.length) out.push(`<path d="${pathD(basePts, f.X, f.Y)}" fill="#efefef" stroke="#000" stroke-width="1.4"/>`);
  if (ins.length > 2) out.push(`<path d="${pathD(hull(ins), f.X, f.Y)}" fill="#fff" stroke="#000" stroke-dasharray="5 3" stroke-width="1"/>`);
  // support ring and flat layers: outlines; plates: solid
  for (const p of parts.filter((q) => q.family === 'S')) out.push(`<path d="${foot.get(p)!.map((pl) => pathD(pl, f.X, f.Y)).join('')}" fill="none" stroke="#555" stroke-dasharray="4 3" fill-rule="evenodd"/>`);
  if (flat) {
    const layers = parts.filter((q) => q.family === 'P').sort((a, c) => a.index - c.index);
    for (const p of layers) out.push(`<path d="${foot.get(p)!.map((pl) => pathD(pl, f.X, f.Y)).join('')}" fill="none" stroke="${p.index === 0 ? '#000' : '#888'}" stroke-width="${p.index === 0 ? 1.3 : 0.5}" fill-rule="evenodd"/>`);
  } else {
    for (const p of parts.filter(isMain)) out.push(`<path d="${foot.get(p)!.map((pl) => pathD(pl, f.X, f.Y)).join('')}" fill="#111" stroke="#111" stroke-width="0.6"/>`);
  }
  for (const p of parts.filter((q) => q.family === 'C' || q.family === 'T'))
    out.push(`<path d="${foot.get(p)!.map((pl) => pathD(pl, f.X, f.Y)).join('')}" fill="#fff" fill-opacity="0.6" stroke="#000" stroke-width="1.1" stroke-dasharray="${p.family === 'C' ? '6 3' : '2 2'}"/>`);

  // labels
  const labels: string[] = [];
  const leftEdge = f.X(b.minX), rightEdge = f.X(b.maxX), topEdge = f.Y(b.maxY);
  if (!flat) {
    const byKey = new Map<string, Part[]>();
    for (const p of parts.filter(isMain)) byKey.set(p.plateKey, [...(byKey.get(p.plateKey) ?? []), p]);
    const P = [...byKey.values()].filter((ps) => ps[0].family === 'P').sort((a, c) => a[0].index - c[0].index);
    const spacing = P.length > 1 ? Math.abs(f.Y(view.plan(P[1][0].plane.origin)[1]) - f.Y(view.plan(P[0][0].plane.origin)[1])) : 99;
    const alternate = spacing < font + 3;
    P.forEach((ps, i) => {
      const pts = ps.flatMap((p) => foot.get(p)!.flat()).map(([x, y]) => [f.X(x), f.Y(y)] as P2);
      const y = pts.reduce((a, q) => a + q[1], 0) / pts.length;
      const left = alternate && i % 2 === 1;
      const end = left ? Math.min(...pts.map((q) => q[0])) : Math.max(...pts.map((q) => q[0]));
      const lx = left ? leftEdge - 8 : rightEdge + 8;
      labels.push(`<line x1="${px(end + (left ? -2 : 2))}" y1="${px(y)}" x2="${px(lx + (left ? 2 : -2))}" y2="${px(y)}" stroke="#999" stroke-width="0.5"/><text x="${px(lx + (left ? -2 : 2))}" y="${px(y + 3.8)}" text-anchor="${left ? 'end' : 'start'}" font-size="${font}" font-weight="600">${esc(names.get(ps[0].plateKey) ?? ps[0].id)}</text>`);
    });
    for (const ps of byKey.values()) {
      const p0 = ps[0];
      if (p0.family === 'X') {
        const pts = ps.flatMap((p) => foot.get(p)!.flat());
        const x = pts.reduce((a, q) => a + q[0], 0) / pts.length;
        labels.push(`<text x="${px(f.X(x))}" y="${px(topEdge - 8)}" text-anchor="middle" font-size="${font}" font-weight="600">${esc(names.get(p0.plateKey) ?? p0.id)}</text>`);
      } else if (p0.family === 'R') {
        const o = view.plan(planeToWorld(p0.plane, Math.max(...ps.map((p) => p.bbox.maxX)), 0));
        const c = view.plan(p0.plane.origin);
        const d = Math.hypot(o[0] - c[0], o[1] - c[1]) || 1;
        const dx = (o[0] - c[0]) / d, dy = (o[1] - c[1]) / d;
        // out along the plate's line until clear of the drawing's box
        const cx = f.X(c[0]), cy = f.Y(c[1]);
        const bottomEdge = f.Y(b.minY);
        const k = Math.min(dx > 1e-6 ? (rightEdge - cx) / dx : dx < -1e-6 ? (leftEdge - cx) / dx : Infinity, dy > 1e-6 ? (cy - topEdge) / dy : dy < -1e-6 ? (cy - bottomEdge) / dy : Infinity);
        const tx = cx + dx * (k + 8), ty = cy - dy * (k + 8) + (dy > 0.35 ? -4 : dy < -0.35 ? 8 : 0);
        labels.push(`<text x="${px(tx)}" y="${px(ty + 4)}" text-anchor="${dx > 0.35 ? 'start' : dx < -0.35 ? 'end' : 'middle'}" font-size="${font}" font-weight="600">${esc(names.get(p0.plateKey) ?? p0.id)}</text>`);
      }
    }
  } else {
    const layers = m.sliced.plates.filter((pl) => pl.parts.length);
    labels.push(`<text x="${px(rightEdge + 8)}" y="${px(topEdge + 14)}" font-size="${font}">${plural(layers.length, 'layer')}</text><text x="${px(rightEdge + 8)}" y="${px(topEdge + 28)}" font-size="${font}">bold: ${esc(plateName(layers[0]?.parts ?? []))}</text><text x="${px(rightEdge + 8)}" y="${px(topEdge + 42)}" font-size="${font}">(bottom)</text>`);
  }
  // cross pieces and templates: labelled at their back end, above the base
  parts
    .filter((q) => q.family === 'C' || q.family === 'T')
    .forEach((p) => {
      const pts = foot.get(p)!.flat();
      const x = pts.reduce((a, q) => a + q[0], 0) / pts.length;
      labels.push(`<text x="${px(f.X(x))}" y="${px(topEdge - (v.sliceMode === 'waffle' ? 24 : 8) - (p.family === 'T' ? 13 : 0))}" text-anchor="middle" font-size="${font}" font-style="italic">${esc(p.id)}</text>`);
    });
  if (ins.length > 2) {
    labels.push(`<text x="${px(f.w - 12)}" y="${px(f.h - 10)}" text-anchor="end" font-size="11">dashed outline: insert</text>`);
  }
  // the front
  const fy = f.Y(b.minY);
  const front = basePts.length ? `<line x1="${px(f.X(b.minX))}" y1="${px(fy + 3)}" x2="${px(f.X(b.maxX))}" y2="${px(fy + 3)}" stroke="#000" stroke-width="5"/>` : '';
  const frontText = `<text x="${px(f.w / 2)}" y="${px(fy + 22)}" text-anchor="middle" font-size="15" font-weight="800" letter-spacing="3">FRONT</text>`;
  const backText = `<text x="${px(f.w / 2)}" y="${px(topEdge - (radial ? 30 : v.sliceMode === 'waffle' || parts.some((q) => q.family === 'C' || q.family === 'T') ? 40 : 14))}" text-anchor="middle" font-size="11" fill="#444" letter-spacing="2">BACK</text>`;
  const bar = scaleBar(12, f.h - 14, f.s, b.maxX - b.minX);
  return `<svg class="drawing" width="${px(f.w)}" height="${px(f.h)}" viewBox="0 0 ${px(f.w)} ${px(f.h)}" role="img" aria-label="Plate layout seen from above, front at the bottom">${out.join('')}${labels.join('')}${front}${frontText}${backText}${bar}</svg>`;
}

function elevationSvg(m: Model, right: P2, title: string, opts: { labels?: boolean; maxH?: number } = {}): string {
  const v = m.v;
  const parts = m.sliced.parts;
  const outl = new Map(parts.map((p) => [p, elevation(p, right)]));
  const at = (w: V3): P2 => [w[0] * right[0] + w[2] * right[1], w[1]];
  const basePts: P2[] = v.baseOn ? basePlan(v).map(([x, pz]) => at([x, 0, -pz])) : [];
  const baseBox = basePts.length ? boxOf(basePts) : null;
  const ins = insertPoints(m).map(at);
  const all = [...[...outl.values()].flat(), ...(baseBox ? [[baseBox.minX, 0], [baseBox.maxX, v.baseHeight]] as P2[] : []), ...ins];
  if (!all.length) return '';
  const b = boxOf(all);
  b.minY = Math.min(b.minY, 0);
  const f = fitBox(b, 690, opts.maxH ?? 400, [70, 80, opts.labels ? 46 : 18, 44]);
  const out: string[] = [];
  if (baseBox) out.push(`<rect x="${px(f.X(baseBox.minX))}" y="${px(f.Y(v.baseHeight))}" width="${px((baseBox.maxX - baseBox.minX) * f.s)}" height="${px(v.baseHeight * f.s)}" fill="#e4e4e4" stroke="#000" stroke-width="1.2"/>`);
  if (ins.length > 2) out.push(`<path d="${pathD(hull(ins), f.X, f.Y)}" fill="none" stroke="#000" stroke-dasharray="5 3"/>`);
  // many plates lined up one behind another: outlines only, or the stack prints solid black
  const dense = parts.filter((p) => upright(p)).length > 12 && Math.abs(right[0] * stackFrame(v).stack[0] + right[1] * stackFrame(v).stack[1]) < 0.5;
  const order = [...parts].sort((a, c) => (a.family === 'S' ? -1 : 0) - (c.family === 'S' ? -1 : 0));
  for (const p of order)
    out.push(`<path d="${pathD(outl.get(p)!, f.X, f.Y)}" fill="${p.family === 'C' || p.family === 'T' ? 'none' : '#fff'}" fill-opacity="${dense ? 0 : 0.9}" stroke="#000" stroke-width="${p.family === 'C' || p.family === 'T' ? 0.9 : dense ? 0.45 : 0.8}"${p.family === 'C' || p.family === 'T' || p.family === 'S' ? ' stroke-dasharray="4 2"' : ''}/>`);
  // dimensions: overall width under, overall height on the right, base height on the left
  const g: string[] = [];
  const yb = f.Y(b.minY) + 22;
  g.push(dim(f.X(b.minX), yb, f.X(b.maxX), yb, mm(b.maxX - b.minX), 'below'));
  const xr = f.X(b.maxX) + 22;
  g.push(dim(xr, f.Y(Math.max(0, b.minY)), xr, f.Y(b.maxY), mm(b.maxY - Math.max(0, b.minY)), 'right'));
  if (baseBox) g.push(dim(f.X(b.minX) - 18, f.Y(0), f.X(b.minX) - 18, f.Y(v.baseHeight), mm(v.baseHeight), 'left'));
  // part names along the top, when asked (side elevation of an upright stack)
  if (opts.labels) {
    const P = parts.filter((p) => p.family === 'P' && upright(p)).sort((a, c) => a.index - c.index);
    const seen = new Set<string>();
    const xs: { x: number; top: number; key: string }[] = [];
    for (const p of P) {
      if (seen.has(p.plateKey)) continue;
      seen.add(p.plateKey);
      const pts = parts.filter((q) => q.plateKey === p.plateKey).flatMap((q) => outl.get(q)!);
      xs.push({ x: pts.reduce((a, q) => a + q[0], 0) / pts.length, top: Math.max(...pts.map((q) => q[1])), key: p.plateKey });
    }
    const gap = xs.length > 1 ? Math.abs(f.X(xs[1].x) - f.X(xs[0].x)) : 99;
    const every = gap >= 26 ? 1 : gap >= 13 ? 1 : Math.ceil(13 / Math.max(gap, 0.1)) * 2;
    const names = keyNames(m);
    xs.forEach((q, i) => {
      if (i % every && i !== xs.length - 1) return;
      const row = gap >= 26 || every > 1 ? 0 : i % 2;
      const ty = f.Y(b.maxY) - 8 - row * 14;
      g.push(`<line x1="${px(f.X(q.x))}" y1="${px(f.Y(q.top) - 2)}" x2="${px(f.X(q.x))}" y2="${px(ty + 3)}" stroke="#bbb" stroke-width="0.5"/><text x="${px(f.X(q.x))}" y="${px(ty)}" text-anchor="middle" font-size="10" font-weight="600">${esc((names.get(q.key) ?? q.key).replace(/^.*?-/, ''))}</text>`);
    });
  }
  return `<svg class="drawing" width="${px(f.w)}" height="${px(f.h)}" viewBox="0 0 ${px(f.w)} ${px(f.h)}" role="img" aria-label="${esc(title)}">${out.join('')}${g.join('')}</svg>`;
}

// --- sections -----------------------------------------------------------------------

function modeText(m: Model, mains: PlateInfo[]): string {
  const v = m.v;
  const n = mains.length;
  switch (v.sliceMode) {
    case 'radial':
      return `Radial: ${n} plates round a ${mm(v.radialHub)} hub`;
    case 'waffle':
      return `Waffle: ${mains.filter((p) => p.def.family === 'P').length} plates interlocking with ${mains.filter((p) => p.def.family === 'X').length} cross plates`;
    case 'flat':
      return `Flat stack: ${n} layers glued face to face`;
    default:
      return `Row: ${n} plates standing at ${mm(v.pitch)} pitch`;
  }
}

function scheduleRows(project: Project, m: Model, view: View, parts: Part[], tunes: Map<string, string>): string {
  return parts
    .map((p, i) => {
      const metal = metalOf(project, m, p.plateKey);
      const mv = moveText(project, view, p.plateKey);
      const note = tunes.get(p.plateKey);
      return `<tr><td class="n">${i + 1}</td><td class="id">${esc(p.id)}</td><td>${esc(metal.label)}</td><td class="nw">${n1(p.bbox.maxX - p.bbox.minX)} × ${n1(p.bbox.maxY - p.bbox.minY)}</td><td class="nw">${n1(p.thickness)}</td><td>${esc(positionText(m, view, p))}${note ? `<br><small>rings ${esc(note)}</small>` : ''}</td><td>${mv ? `<b>${esc(mv)}</b>` : '—'}</td><td>${thumb(p.shape)}</td></tr>`;
    })
    .join('\n');
}

function assemblySteps(project: Project, m: Model, view: View, names: Map<string, string>): string[] {
  const v = m.v;
  const steps: string[] = [];
  const parts = m.sliced.parts;
  const plates = m.sliced.plates.filter((pl) => pl.parts.length);
  const P = plates.filter((pl) => pl.def.family === 'P').sort((a, b) => a.def.index - b.def.index);
  const X = plates.filter((pl) => pl.def.family === 'X').sort((a, b) => a.def.index - b.def.index);
  const R = plates.filter((pl) => pl.def.family === 'R').sort((a, b) => a.def.index - b.def.index);
  const nm = (pl: PlateInfo) => `<b>${esc(names.get(pl.def.key) ?? pl.def.key)}</b>`;
  const rods = m.sliced.brace?.rods?.rods.length ? m.sliced.brace.rods : null;
  const cross = parts.filter((p) => p.family === 'C');
  const tmpl = parts.filter((p) => p.family === 'T');
  const ring = parts.filter((p) => p.family === 'S');
  const e = embedOf(v);
  const slot = v.embedMode === 'slot' && e > 0;
  const base = m.moulds.parts.filter((p) => p.body === 'base');
  const rings = base.filter((p) => p.kind === 'ring');
  const jig = base.filter((p) => p.kind === 'jig');
  const insMould = m.moulds.parts.filter((p) => p.body === 'insert');
  const insert = m.insert && v.insShape !== 'none' ? String(v.insMaterial) : null;
  const flat = v.sliceMode === 'flat';
  const ids = (ps: { id: string }[]) => ps.map((p) => `<b>${esc(p.id)}</b>`).join(', ');
  const metals = [...new Set(parts.map((p) => metalOf(project, m, p.plateKey).material))];
  // back to front: the back plate goes in first so you never reach over a plate you've set
  const back = P[P.length - 1], front = P[0];

  steps.push(
    `<b>Check the parts.</b> Lay out all ${parts.length} laser-cut parts${metals.length > 1 ? `, sorted by metal (${metals.map((x) => METAL_NAMES[x] ?? x).join(', ')})` : ''}. Deburr the edges and match each part's etched number against the plate schedule.${flat ? ' Stack the layers in order, bottom layer first.' : ''}`,
  );
  if (insert === 'concrete' && insMould.length)
    steps.push(`<b>Cast the insert first.</b> Build its mould from the ${insMould.length} MI- parts, cast it upside down through the open bottom face, cure it, then sand the steps back to the form.`);
  else if (insert === 'metal') steps.push(`<b>Have the metal insert ready.</b> It stands in the middle and the plates slide over it through their cavities.`);
  if (v.baseOn) {
    if (rings.length) {
      const floor = base.find((p) => p.kind === 'floor');
      const notes = m.moulds.notes.filter((n) => /^(Base|Top edge)/.test(n));
      steps.push(
        `<b>Build the base mould.</b> Stack the ${rings.length} MB- ply layers${floor ? ` on the floor board <b>${esc(floor.id)}</b>` : ''}, line them up on the dowels${m.moulds.dowels ? ` (${m.moulds.dowels})` : ''}${m.moulds.bolts ? ` and bolt the tabs (${m.moulds.bolts} bolts)` : ''}. Seal the joints and wipe the inside with release agent. ${notes.map(esc).join(' ')}`,
      );
    } else steps.push(`<b>Make the base mould</b>: ${n1(v.baseLength)} × ${n1(v.baseWidth)} mm inside, ${mm(v.baseHeight)} deep. Seal it and wipe it with release agent.`);
  }

  if (flat) {
    const pins = Math.round(v.flatPins);
    if (v.baseOn)
      steps.push(`<b>Cast the base</b> (see the pour plan)${pins ? `. While it is still wet, set ${pins} pins or lengths of threaded rod (Ø${n1(v.pinDia)} mm) at the registration holes, using the bottom layer ${P[0] ? nm(P[0]) : ''} as a template` : ''}. Let it cure at least two days, then split the mould to release the base, before you glue anything to it.`);
    if (P.length)
      steps.push(
        `<b>Glue the layers up from the bottom</b>, in the glue-up order: ${nm(P[0])} first${v.baseOn ? ' (onto the base)' : ''}, ${nm(P[P.length - 1])} last. ${v.flatGuides ? 'Each layer sits on the outline etched into the one below' : 'Line each layer up with the one below'}${pins ? ' and drops over the pins' : ''}. Spread the adhesive thinly, keep it out of the cut-outs, and clamp or weight the stack evenly.`,
      );
    steps.push('<b>Leave the adhesive to cure fully</b> before moving the piece.');
  } else {
    const ringStep = () => {
      const sup = m.sliced.support;
      if (!sup || !ring.length || !v.baseOn) return;
      steps.push(`<b>First pour: ${mm(Math.max(0, v.baseHeight + sup.tenonBottom))}.</b> Let it stiffen, then lower the plates with the support ring ${ids(ring)} on their tenons, so the ring's top face sits ${mm(sup.depth)} below the finished surface.`);
    };
    const crossStep = () => {
      if (!cross.length || !v.baseOn) return;
      const first = Math.max(0, v.baseHeight + Math.min(...cross.map((p) => p.bbox.minY)));
      steps.push(`<b>First pour: ${mm(first)}.</b> Stand the cross piece${cross.length > 1 ? 's' : ''} ${ids(cross)} on it where the layout shows (dashed), and drop every plate's tab into its slots. They stay in the concrete.`);
    };
    const into = slot ? '' : e > 0 ? `, tabs ${mm(e)} into the concrete` : '';
    const jigText = jig.length && !slot ? `, each through its slot in the jig board ${ids(jig)} laid across the top of the mould` : '';
    const overInsert = insert ? ', sliding each over the insert through its cavity' : '';
    if (rods)
      steps.push(
        `<b>Make up the rod cage.</b> Thread the plates onto the ${rods.rods.length} × ${esc(rods.size)} rods from the back plate ${nm(back)} to the front plate ${nm(front)}, putting each nut and washer where the rod table says. Square the stack and tighten the nuts.`,
      );
    if (slot)
      steps.push(`<b>Set slot formers</b> ${mm(v.thickness + v.slotGap)} wide and ${mm(e)} deep at every plate position (the layout gives each one)${jig.length ? `, held at pitch by the jig board ${ids(jig)}` : ''}.`);
    else {
      ringStep();
      crossStep();
    }
    if (!slot) {
      if (v.sliceMode === 'waffle') {
        steps.push(
          `<b>Assemble the grid off the base.</b> Stand the ${P.length} long plates (${nm(P[0])} … ${nm(P[P.length - 1])}) in order, then lower the ${X.length} cross plates (${X.length ? `${nm(X[0])} … ${nm(X[X.length - 1])}` : ''}) over them from above so each pair of slots meets half way. Check it square.`,
        );
        steps.push(`<b>Lower the grid into the mould</b> as one piece${into}${insert ? ', over the insert' : ''}. There is no jig board for a waffle: prop or clamp it level until the concrete takes it.`);
      } else if (v.sliceMode === 'radial') {
        if (insert) steps.push(`<b>Stand the insert</b> in the middle of the mould.`);
        // the plate pointing most nearly at the front
        const toFront = (pl: PlateInfo) => {
          const u = pl.def.plane.u;
          return -(u[0] * view.back[0] + u[2] * view.back[1]);
        };
        const start = R.reduce((best, pl, i) => (toFront(pl) > toFront(R[best]) + 1e-9 ? i : best), 0);
        if (R.length) steps.push(`<b>Set the ${R.length} radial plates</b> round the hub in number order: start with ${nm(R[start])} at the front and go on clockwise seen from above${start ? ` (${nm(R[R.length - 1])} is followed by ${nm(R[0])})` : `, ending with ${nm(R[R.length - 1])}`}${into}${jigText}.`);
      } else if (rods) {
        steps.push(`<b>Lower the rod cage into the mould</b>${jigText.replace(', each through its slot', ', every plate through its slot')}${into}${overInsert}.`);
      } else if (P.length) {
        if (insert) steps.push(`<b>Stand the insert</b> in place in the mould.`);
        steps.push(`<b>Set the plates in, back to front:</b> ${nm(back)} first, ${nm(front)} last${jigText}${into}${overInsert}. The layout drawing numbers every slot.`);
      }
      if (tmpl.length) steps.push(`<b>Fit the spacing template${tmpl.length > 1 ? 's' : ''}</b> ${ids(tmpl)}: lower ${tmpl.length > 1 ? 'them' : 'it'} over the plate tops so every plate sits in its slot.`);
    }
    if (v.baseOn) {
      const rows = m.pour.rows.filter((r) => r.height > 0);
      if (rows.length)
        steps.push(
          `<b>Pour the ${plural(rows.length, 'layer')}</b> in order, bottom first: ${rows.map((r) => `${esc(r.name)} (${mm(r.height)})`).join(', ')}. Tap the mould sides after each to bring the air up; let each layer firm up before the next for crisp bands.`,
        );
      else steps.push('<b>Pour the base</b> in one go and tap the mould sides to bring the air up.');
    }
    if (slot) {
      steps.push(`<b>After the cure, pull the formers</b> and fit the plates back to front, ${nm(back ?? R[R.length - 1])} first, bedding each in resin or grout.`);
    }
  }
  const moved = [...new Set(parts.filter((p) => moveText(project, view, p.plateKey)).map((p) => names.get(p.plateKey) ?? p.id))];
  if (moved.length) steps.push(`<b>Hand-placed plates:</b> ${moved.map((s) => `<b>${esc(s)}</b>`).join(', ')} ${moved.length > 1 ? 'were' : 'was'} moved by hand in the design. Set ${moved.length > 1 ? 'them' : 'it'} where the layout drawing shows, not at the regular spacing.`);
  if (v.baseOn && !flat) {
    const lift = [tmpl.length && `lift the template${tmpl.length > 1 ? 's' : ''} straight off`, jig.length && 'take off the jig board'].filter(Boolean).join(' and ');
    steps.push(`<b>Cure and demould.</b> Leave it at least two days${lift ? `, ${lift}` : ''}, then split the mould to release the base. Keep the concrete damp for a week before it goes outside.`);
  }
  if (metals.includes('corten')) steps.push('<b>Corten</b> rusts to its finish outdoors in a few weeks, and the run-off stains concrete: seal the concrete top first if you want it to stay clean.');
  return steps;
}

function rodsSection(m: Model, names: Map<string, string>, rp: RodPlan, view: View): string {
  const v = m.v;
  const t = v.thickness;
  const P = m.sliced.plates.filter((pl) => pl.def.family === 'P').sort((a, b) => a.def.index - b.def.index);
  const typical = P.filter((pl) => pl.parts.length)[Math.floor(P.filter((pl) => pl.parts.length).length / 2)];
  const out: string[] = [];
  // the drawing: one plate seen from the front, with every rod hole numbered and dimensioned
  if (typical) {
    const plane = typical.def.home ?? typical.def.plane;
    const sgn = plane.u[0] * view.right[0] + plane.u[2] * view.right[1] >= 0 ? 1 : -1;
    const pts = typical.parts.flatMap((p) => p.shape[0].outer).map(([u, y]) => [sgn * u, y] as P2);
    const holes = rp.rods.filter((r) => Number.isFinite(r.u));
    const b = boxOf([...pts, ...holes.map((r) => [sgn * r.u, r.y] as P2)]);
    b.minY = Math.min(b.minY, 0);
    const f = fitBox(b, 690, 380, [86, 120, 28, 30 + 18 * Math.min(holes.length, 6)]);
    const g: string[] = [];
    for (const p of typical.parts) g.push(`<path d="${[p.shape[0].outer, ...p.shape[0].holes].map((q) => pathD(q.map(([u, y]) => [sgn * u, y] as P2), f.X, f.Y)).join('')}" fill="#e6e6e6" stroke="#000" stroke-width="1" fill-rule="evenodd"/>`);
    g.push(`<line x1="${px(f.X(b.minX) - 30)}" y1="${px(f.Y(0))}" x2="${px(f.X(b.maxX) + 30)}" y2="${px(f.Y(0))}" stroke="#000" stroke-dasharray="8 4" stroke-width="1"/><text x="${px(f.X(b.maxX) + 34)}" y="${px(f.Y(0) + 4)}" font-size="11">top of concrete</text>`);
    g.push(`<line x1="${px(f.X(0))}" y1="${px(f.Y(b.maxY) - 10)}" x2="${px(f.X(0))}" y2="${px(f.h - 8)}" stroke="#000" stroke-dasharray="12 3 2 3" stroke-width="0.8"/><text x="${px(f.X(0))}" y="${px(f.Y(b.maxY) - 14)}" font-size="11" text-anchor="middle">centre line</text>`);
    const ys = [...new Set(holes.map((r) => Math.round(r.y * 10) / 10))].sort((a, c) => a - c);
    ys.forEach((y, k) => {
      const x = f.X(b.minX) - 22 - (k % 2) * 34;
      g.push(dim(x, f.Y(0), x, f.Y(y), `${n1(Math.abs(y))}`, 'left'));
    });
    holes.forEach((r, i) => {
      const cx = f.X(sgn * r.u), cy = f.Y(r.y);
      g.push(`<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(Math.max(4, (rp.hole / 2) * f.s))}" fill="#fff" stroke="#000" stroke-width="1.6"/><text x="${px(cx + Math.max(6, (rp.hole / 2) * f.s) + 2)}" y="${px(cy - 6)}" font-size="12" font-weight="700">${i + 1}</text>`);
      if (i < 6) {
        const yd = f.Y(b.minY) + 22 + i * 18;
        g.push(`<line x1="${px(cx)}" y1="${px(cy)}" x2="${px(cx)}" y2="${px(yd)}" stroke="#999" stroke-width="0.5" stroke-dasharray="2 2"/>`);
        g.push(dim(f.X(0), yd, cx, yd, `${i + 1}: ${n1(Math.abs(r.u))}`, cx >= f.X(0) ? 'right' : 'left').replace(/<text x="[^"]+"/, `<text x="${px(cx >= f.X(0) ? Math.max(cx, f.X(0)) + 6 : Math.min(cx, f.X(0)) - 6)}"`));
      }
    });
    out.push(`<figure><svg class="drawing" width="${px(f.w)}" height="${px(f.h)}" viewBox="0 0 ${px(f.w)} ${px(f.h)}" role="img" aria-label="Rod holes on a plate, seen from the front">${g.join('')}</svg><figcaption>Plate ${esc(names.get(typical.def.key) ?? '')} seen from the front: rod holes Ø${n1(rp.hole)} mm for ${esc(rp.size)} rod. Across distances are from the centre line, heights from the top of the concrete (mm).</figcaption></figure>`);
  }
  const side = (u: number) => {
    const plane = (typical?.def.home ?? typical?.def.plane);
    const sgn = plane ? (plane.u[0] * view.right[0] + plane.u[2] * view.right[1] >= 0 ? 1 : -1) : 1;
    const x = sgn * u;
    return Math.abs(x) < 0.5 ? 'centre' : `${n1(Math.abs(x))} ${x > 0 ? 'right' : 'left'}`;
  };
  out.push(`<table><thead><tr><th>Rod</th><th>Across (mm)</th><th>Height (mm)</th><th>Where</th><th>Length</th><th>Buy</th><th>Nuts</th><th>Washers</th></tr></thead><tbody>${rp.rods
    .map((r, i) => `<tr><td class="id">${i + 1}</td><td>${Number.isFinite(r.u) ? side(r.u) : '—'}</td><td>${r.y < 0 ? `${n1(-r.y)} below` : `${n1(r.y)} above`}</td><td>${r.embedded ? 'cast in' : 'through the steel'}</td><td class="nw"><b>${mm(r.length.length)}</b></td><td>${r.length.cut ? `cut from ${mm(r.length.stock)}` : 'stock length'}</td><td>${r.fixings.filter((x) => x.kind === 'nut').length}</td><td>${r.fixings.filter((x) => x.kind === 'washer').length}</td></tr>`)
    .join('')}</tbody></table>`);

  // nuts and washers along each rod, from its front end
  const groups = new Map<string, Rod[]>();
  for (const r of rp.rods) {
    const k = `${r.length.length}|${r.fixings.map((x) => `${x.kind}${x.s.toFixed(1)}`).join(',')}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const fix: string[] = [];
  for (const rods of groups.values()) {
    const r = rods[0];
    const half = r.length.length / 2;
    const list = [...r.fixings].sort((a, b) => a.s - b.s).map((x) => `${x.kind === 'nut' ? 'N' : 'W'}&nbsp;${n1(x.s + half)}`);
    fix.push(`<p><b>Rod${rods.length > 1 ? 's' : ''} ${rods.map((q) => rp.rods.indexOf(q) + 1).join(', ')}</b> (${mm(r.length.length)}): ${list.join(' · ')}</p>`);
  }
  out.push(`<h3>Nuts (N) and washers (W) along the rod</h3><p class="note">Distances in mm from the front end of the rod to the middle of each nut or washer. Mark them on the rod with a pen before you start threading.</p>${fix.join('')}`);

  // the clear gap between neighbouring plates along the rod, less any nuts and washers in it
  if (rp.rods.length && P.length > 1) {
    const dir: P2 = [rp.dir[0], rp.dir[2]];
    const ss = P.map((pl) => {
      const o = (pl.def.home ?? pl.def.plane).origin;
      return o[0] * dir[0] + o[2] * dir[1];
    });
    const centre = (ss[0] + ss[ss.length - 1]) / 2;
    const r = rp.rods[0];
    const rows: { a: string; b: string; clear: number; fixed: string; len: number }[] = [];
    for (let i = 0; i + 1 < P.length; i++) {
      const lo = ss[i] + t / 2 - centre, hi = ss[i + 1] - t / 2 - centre;
      const inGap = r.fixings.filter((x) => x.s > lo && x.s < hi);
      const used = inGap.reduce((a, x) => a + (x.kind === 'nut' ? rp.spec.nutH : rp.spec.washerH), 0);
      const nuts = inGap.filter((x) => x.kind === 'nut').length, wash = inGap.length - nuts;
      rows.push({ a: names.get(P[i].def.key) ?? P[i].def.key, b: names.get(P[i + 1].def.key) ?? P[i + 1].def.key, clear: hi - lo, fixed: [nuts && `${nuts} N`, wash && `${wash} W`].filter(Boolean).join(' + ') || '—', len: hi - lo - used });
    }
    // runs of identical gaps collapse to one line
    const merged: (typeof rows[number] & { count: number; last: string })[] = [];
    for (const g of rows) {
      const prev = merged[merged.length - 1];
      if (prev && Math.abs(prev.len - g.len) < 0.05 && prev.fixed === g.fixed && Math.abs(prev.clear - g.clear) < 0.05) {
        prev.count++;
        prev.last = `${g.a} → ${g.b}`;
      } else merged.push({ ...g, count: 1, last: '' });
    }
    out.push(`<h3>Spacer length per gap</h3><p class="note">Clear gap between plate faces along the rod, less the nuts and washers in it: the length to cut a tube spacer if you space the loose plates on the rod rather than with the jig or template.</p><table><thead><tr><th>Gap</th><th>Clear gap</th><th>Nuts / washers in it</th><th>Spacer length</th></tr></thead><tbody>${merged
      .map((g) => `<tr><td>${esc(g.a)} → ${esc(g.b)}${g.count > 1 ? ` … ${esc(g.last)} <small>(${g.count} gaps)</small>` : ''}</td><td class="nw">${mm(g.clear)}</td><td>${g.fixed}</td><td class="nw"><b>${g.len > 0.05 ? mm(g.len) : 'none'}</b></td></tr>`)
      .join('')}</tbody></table>`);
  }
  return out.join('\n');
}

function spacersTable(m: Model, view: View, names: Map<string, string>): string {
  const parts = m.sliced.parts.filter((p) => p.family === 'C' || p.family === 'T');
  if (!parts.length) return '';
  const holds = m.sliced.brace?.spacers?.holds ?? {};
  return `<h3>Laser-cut spacers</h3><table><thead><tr><th>Part</th><th>Kind</th><th>Where</th><th>Height</th><th>Holds</th><th>Size (mm)</th><th></th></tr></thead><tbody>${parts
    .map((p) => {
      const held = (holds[p.plateKey] ?? []).map((k) => names.get(k) ?? k);
      const h = p.family === 'C' ? `${n1(-p.bbox.maxY)}–${n1(-p.bbox.minY)} below the top of the concrete` : `teeth stop ${mm(Math.max(0, p.bbox.minY))} above the concrete`;
      return `<tr><td class="id">${esc(p.id)}</td><td>${p.family === 'C' ? 'Cross piece (cast in)' : 'Spacing template (lift off)'}</td><td>${esc(positionText(m, view, p))}</td><td>${h}</td><td class="nw">${held.length ? `${esc(run(held))} <small>(${held.length})</small>` : '—'}</td><td class="nw">${n1(p.bbox.maxX - p.bbox.minX)} × ${n1(p.bbox.maxY - p.bbox.minY)}</td><td>${thumb(p.shape, 110, 40)}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function glueUpSection(m: Model): string {
  const layers = m.sliced.plates.filter((pl) => pl.def.family === 'P' && pl.parts.length).sort((a, b) => a.def.index - b.def.index);
  const t = m.v.thickness;
  return `<table class="glue"><thead><tr><th>Order</th><th>Layer</th><th>Parts</th><th>Height</th><th>Notes</th><th>Outline (seen from above)</th></tr></thead><tbody>${layers
    .map((pl, i) => {
      const notes = [
        pl.def.index === 0 && (Math.round(m.v.flatPins) > 0 ? 'bottom layer: template for the pins' : 'bottom layer'),
        pl.parts.length > 1 && `${pl.parts.length} pieces: set the loose ones on the etched outline`,
      ].filter(Boolean);
      const shape = pl.parts.map((p) => p.shape[0]);
      return `<tr><td class="n big">${i + 1}</td><td class="id">L${pl.def.index + 1}</td><td>${pl.parts.map((p) => esc(p.id)).join(', ')}</td><td class="nw">${n1(pl.def.index * t)}–${mm((pl.def.index + 1) * t)}</td><td>${notes.join('; ') || '—'}</td><td>${thumb(shape, 130, 70)}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function pourSvg(m: Model): string {
  const v = m.v;
  const rows = m.pour.rows.filter((r) => r.height > 0);
  if (!rows.length) return '';
  const H = Math.max(m.pour.total, v.baseHeight);
  const s = Math.min(260 / H, 3);
  const w = 160, x0 = 12, top = 10;
  const Y = (y: number) => top + (H - y) * s;
  const bands = rows.map((r) => `<rect x="${x0}" y="${px(Y(r.y1))}" width="${w}" height="${px(r.height * s)}" fill="${esc(r.color)}" stroke="#000" stroke-width="0.8"/>`);
  // labels spread so thin bands don't overlap
  let lastY = Infinity;
  const labels = [...rows].map((r) => {
    let y = Y((r.y0 + r.y1) / 2) + 4;
    if (y > lastY - 14) y = lastY - 14;
    lastY = y;
    return `<line x1="${x0 + w}" y1="${px(Y((r.y0 + r.y1) / 2))}" x2="${x0 + w + 14}" y2="${px(y - 4)}" stroke="#777" stroke-width="0.6"/><text x="${x0 + w + 18}" y="${px(y)}" font-size="12">${esc(r.name)}: ${n1(r.y0)}–${mm(r.y1)}</text>`;
  });
  const hh = (H * s) + top + 16;
  const fill = Math.abs(m.pour.total - v.baseHeight) > 0.01 ? `<line x1="${x0 - 6}" y1="${px(Y(v.baseHeight))}" x2="${x0 + w + 6}" y2="${px(Y(v.baseHeight))}" stroke="#000" stroke-width="2" stroke-dasharray="6 3"/>` : '';
  return `<svg class="drawing" width="470" height="${px(Math.max(hh, top + 20 + rows.length * 14))}" viewBox="0 0 470 ${px(Math.max(hh, top + 20 + rows.length * 14))}" role="img" aria-label="Pour layers, bottom to top">${bands.join('')}${fill}${labels.join('')}</svg>`;
}

/** Litres of placed concrete to 25 kg bags of dry mix: about 2.2 kg of dry mix per litre, plus a tenth for waste. */
const bags = (litres: number) => Math.ceil((litres * 2.2 * 1.1) / 25);

function pourSection(m: Model): string {
  const v = m.v;
  const rows = m.pour.rows;
  const out: string[] = [];
  const total = rows.reduce((a, r) => a + r.volume, 0);
  out.push(`<div class="cols"><div>${pourSvg(m)}</div><div><p class="big">${n1(total)} L of concrete</p><p>About ${bags(total)} × 25 kg bags of dry mix (at roughly 2.2 kg per litre poured, plus 10% for waste). Mix each layer just before you pour it.</p>${m.bom.concreteBase > 0 && Math.abs(m.bom.concreteBase - total) > 0.5 ? `<p class="note">Less what the steel takes up: about ${n1(m.bom.concreteBase)} L once the plates and cast-in parts are in.</p>` : ''}</div></div>`);
  out.push(`<table><thead><tr><th>#</th><th>Layer</th><th>Colour</th><th>From – to</th><th>Height</th><th>Volume</th><th>Weight</th><th>Dry mix</th></tr></thead><tbody>${rows
    .map((r, i) => `<tr><td class="n">${i + 1}</td><td class="id">${esc(r.name)}${r.error ? ` <small>(${esc(r.error)})</small>` : ''}</td><td><span class="swatch" style="background:${esc(r.color)}"></span> ${esc(r.color)}</td><td class="nw">${n1(r.y0)}–${mm(r.y1)}</td><td class="nw">${mm(r.height)}</td><td class="nw">${r.volume.toFixed(1)} L</td><td class="nw">${r.mass.toFixed(1)} kg</td><td class="nw">${r.volume > 0 ? `≈ ${n1(r.volume * 2.2)} kg` : '—'}</td></tr>`)
    .join('')}</tbody></table>`);
  if (Math.abs(m.pour.mismatch) > 0.01) out.push(`<p class="warn">The layers add up to ${mm(m.pour.total)} but the base is ${mm(v.baseHeight)}: ${m.pour.mismatch > 0 ? 'the top layer overflows the mould' : 'top up to the fill line'}.</p>`);
  const mp = m.moulds.parts;
  if (mp.length || m.moulds.notes.length) {
    const kinds = (body: string) => {
      const ps = mp.filter((p) => p.body === body);
      const c = (k: string) => ps.filter((p) => p.kind === k).length;
      return [c('ring') && plural(c('ring'), 'ring layer'), c('floor') && 'floor board', c('cap') && 'cap', c('jig') && plural(c('jig'), 'jig board')].filter(Boolean).join(', ');
    };
    out.push(`<h3>Mould</h3><p>${mp.some((p) => p.body === 'base') ? `Base mould: ${kinds('base')}. ` : ''}${mp.some((p) => p.body === 'insert') ? `Insert mould: ${kinds('insert')}. ` : ''}${mp.length ? `${n1(v.plyThickness)} mm ply, ${plural(m.bom.plySheets, 'sheet')} of ${n1(v.plySheetW)} × ${n1(v.plySheetH)} mm (CNC files in the ZIP under mould/). ` : ''}${m.moulds.dowels ? `${m.moulds.dowels} dowels Ø${n1(v.dowelDia)} mm. ` : ''}${m.moulds.bolts ? `${m.moulds.bolts} bolts.` : ''}</p>${m.moulds.notes.length ? `<ul>${m.moulds.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`);
  }
  return out.join('\n');
}

function cutListSection(m: Model, rates: PriceRates): string {
  const v = m.v;
  const bom = m.bom;
  const out: string[] = [];
  out.push(`<h3>Laser-cut steel</h3><table><thead><tr><th>Metal</th><th>Thickness</th><th>Parts</th><th>Weight</th><th>Cut length</th><th>Pierces</th></tr></thead><tbody>${bom.byMaterial
    .filter((g) => g.partCount)
    .map((g) => `<tr><td class="id">${esc(METAL_NAMES[g.material] ?? g.material)}</td><td>${mm(v.thickness)}</td><td>${g.partCount}</td><td>${g.plateMass.toFixed(1)} kg</td><td>${g.cutLength.toFixed(1)} m</td><td>${g.pierces}</td></tr>`)
    .join('')}</tbody></table><p class="note">${plural(bom.sheets, 'sheet')} of ${n1(v.sheetW)} × ${n1(v.sheetH)} mm, ${Math.round(bom.utilisation * 100)}% used. Part files: laser/parts and laser/sheets in the ZIP; the full cut list is cutlist.csv.</p>`);
  const bought: string[] = [];
  for (const r of bom.hardware) bought.push(`<tr><td class="id">${esc(r.item)}</td><td>${esc(r.spec)}</td><td class="n">${r.qty}</td><td>${esc(r.note ?? '')}</td></tr>`);
  const conc = bom.concreteBase + bom.concreteInsert;
  if (conc > 0) bought.push(`<tr><td class="id">Concrete (dry mix)</td><td>25 kg bags</td><td class="n">${bags(conc)}</td><td>${n1(conc)} L poured, ${bom.concreteMass.toFixed(0)} kg cured${bom.concreteInsert > 0 ? ` (insert ${n1(bom.concreteInsert)} L)` : ''}</td></tr>`);
  if (bom.plyParts) bought.push(`<tr><td class="id">Plywood</td><td>${mm(v.plyThickness)}, ${n1(v.plySheetW)} × ${n1(v.plySheetH)}</td><td class="n">${bom.plySheets}</td><td>${bom.plyParts} CNC parts, ${bom.plyArea.toFixed(2)} m²</td></tr>`);
  if (bom.dowels) bought.push(`<tr><td class="id">Dowel</td><td>Ø${mm(v.dowelDia)}</td><td class="n">${bom.dowels}</td><td>mould alignment</td></tr>`);
  if (bom.bolts) bought.push(`<tr><td class="id">Bolt, nut and washer</td><td>to suit the mould tabs</td><td class="n">${bom.bolts}</td><td>mould clamping</td></tr>`);
  if (v.sliceMode === 'flat' && Math.round(v.flatPins) > 0) bought.push(`<tr><td class="id">Registration pin</td><td>Ø${mm(v.pinDia)} rod or dowel</td><td class="n">${Math.round(v.flatPins)}</td><td>through the layers into the base</td></tr>`);
  if (v.sliceMode === 'flat') bought.push(`<tr><td class="id">Adhesive</td><td>epoxy or construction adhesive</td><td class="n">—</td><td>for ${plural(m.sliced.plates.filter((p) => p.parts.length).length, 'layer')}</td></tr>`);
  if (v.baseOn) bought.push(`<tr><td class="id">Release agent</td><td>for the mould</td><td class="n">—</td><td></td></tr>`);
  if (bought.length) out.push(`<h3>Bought in</h3><table><thead><tr><th>Item</th><th>Spec</th><th>Qty</th><th>Note</th></tr></thead><tbody>${bought.join('')}</tbody></table>`);
  if (bom.partCount) {
    const est = withHardware(estimateMix(bom, v.thickness, rates), bom.hardware, rates);
    out.push(`<p class="note">Laser cutting${bom.hardware.length ? ' and rod hardware' : ''}: about £${est.total.toFixed(0)} including VAT (an estimate, not a quote; see price-estimate.txt).</p>`);
  }
  return out.join('\n');
}

// --- the page ---------------------------------------------------------------------------

export function buildPackHtml(project: Project, m: Model, opts: BuildPackOptions = {}): string {
  const v = m.v;
  const view = viewOf(m);
  const names = keyNames(m);
  const parts = m.sliced.parts;
  const plates = m.sliced.plates.filter((pl) => pl.parts.length);
  const mains = plates.filter((pl) => pl.def.family === 'P' || pl.def.family === 'X' || pl.def.family === 'R');
  const flat = v.sliceMode === 'flat';
  const rods = m.sliced.brace?.rods?.rods.length ? m.sliced.brace.rods : null;
  const spacers = parts.some((p) => p.family === 'C' || p.family === 'T');
  const date = opts.date ?? new Date();
  const rates = opts.rates ?? DEFAULT_RATES;

  // overall size: the base (or the plates) in plan, and the highest point of anything
  const planPts = [...(v.baseOn ? basePlan(v).map(([x, pz]) => view.plan([x, 0, -pz])) : []), ...parts.flatMap((p) => footprint(p, view).flat())];
  const pb = planPts.length ? boxOf(planPts) : { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  let top = v.baseOn ? v.baseHeight : 0;
  for (const p of parts) for (const [a, b] of [[p.bbox.minX, p.bbox.maxY], [p.bbox.maxX, p.bbox.maxY], [p.bbox.minX, p.bbox.minY], [p.bbox.maxX, p.bbox.minY]]) top = Math.max(top, planeToWorld(p.plane, a, b)[1] + (upright(p) ? 0 : p.thickness / 2));
  if (m.insert && v.insShape !== 'none') top = Math.max(top, m.insert.form.bbox.max.y);
  const weight = m.bom.plateMass + (v.baseOn ? m.bom.concreteMass : 0);
  const finishes = [...new Set(parts.map((p) => metalOf(project, m, p.plateKey).label))];
  const errors = m.issues.filter((i) => i.severity === 'error').length + (m.sliced.brace?.issues.filter((i) => i.severity === 'error').length ?? 0);

  const tunes = new Map<string, string>();
  m.sliced.plates.forEach((pl, i) => {
    const t = m.sliced.tuning?.[i];
    if (t) tunes.set(pl.def.key, t.name);
  });
  const mainParts = parts.filter(isMain).sort((a, b) => (a.family === b.family ? a.index - b.index || a.piece - b.piece : a.family.localeCompare(b.family)));
  const otherParts = parts.filter((p) => !isMain(p));

  const sections: { id: string; title: string; body: string }[] = [];
  const plan = planSvg(m, view, names);
  sections.push({
    id: 'layout',
    title: 'Plate layout',
    body: `<p class="note">Seen from above, front at the bottom. ${flat ? 'Every layer outline is drawn; the bottom layer is bold. The glue-up order lists them one by one.' : `Every plate is drawn where it stands and named as etched on it.${spacers ? ' Dashed: laser-cut cross pieces (long dashes) and spacing templates (short dashes).' : ''}`}</p><figure class="full">${plan}</figure>`,
  });
  const front = elevationSvg(m, view.right, 'Front elevation', { maxH: flat ? 300 : 420 });
  const sideRight: P2 = [view.back[0], view.back[1]];
  const side = v.sliceMode !== 'radial' ? elevationSvg(m, sideRight, 'Side elevation', { labels: !flat, maxH: flat ? 300 : 420 }) : '';
  sections.push({
    id: 'elevations',
    title: 'Elevations',
    body: `<h3>Front elevation</h3><p class="note">Looking at the front. The grey block is the concrete; plates are drawn through it.</p><figure>${front}</figure>${side ? `<h3>Side elevation</h3><p class="note">From the right-hand side: front on the left, back on the right.${!flat ? ' Plate numbers along the top.' : ''}</p><figure>${side}</figure>` : ''}`,
  });
  sections.push({
    id: 'schedule',
    title: 'Plate schedule',
    body: `<table class="sched"><thead><tr><th>#</th><th>Part</th><th>Material, finish</th><th>Size (mm)</th><th>Thk</th><th>Position</th><th>Hand move</th><th>Outline</th></tr></thead><tbody>${scheduleRows(project, m, view, mainParts, tunes)}</tbody></table>${otherParts.length ? `<h3>Support and spacer parts</h3><table class="sched"><thead><tr><th>#</th><th>Part</th><th>Material, finish</th><th>Size (mm)</th><th>Thk</th><th>Position</th><th>Hand move</th><th>Outline</th></tr></thead><tbody>${scheduleRows(project, m, view, otherParts, tunes)}</tbody></table>` : ''}<p class="note">Sizes are the part's bounding box as cut (width × height). Positions are to the middle of the plate.</p>`,
  });
  sections.push({ id: 'assembly', title: 'Assembly order', body: `<ol class="steps">${assemblySteps(project, m, view, names).map((s) => `<li>${s}</li>`).join('\n')}</ol>` });
  if (rods || spacers) sections.push({ id: 'rods', title: rods ? 'Rods and spacers' : 'Spacers', body: `${rods ? rodsSection(m, names, rods, view) : ''}${spacersTable(m, view, names)}` });
  if (flat && plates.length) sections.push({ id: 'glue', title: 'Glue-up order', body: `<p class="note">Bottom to top. Glue each layer onto the one before it${v.flatGuides ? ', lined up on the outline etched into that layer' : ''}.</p>${glueUpSection(m)}` });
  if (v.baseOn) sections.push({ id: 'pour', title: 'Pour plan', body: pourSection(m) });
  sections.push({ id: 'parts', title: 'Cut list and bought-in parts', body: cutListSection(m, rates) });

  const facts: [string, string][] = [
    ['Design', modeText(m, mains)],
    ['Overall size', `${n1(pb.maxX - pb.minX)} wide × ${n1(pb.maxY - pb.minY)} deep × ${n1(top)} high (mm)`],
    ['Plates', `${mains.length}${parts.length !== mains.length ? ` (${parts.length} laser-cut parts in all)` : ''}`],
    ['Weight', `about ${weight.toFixed(0)} kg${v.baseOn ? ` (steel ${m.bom.plateMass.toFixed(1)} kg, concrete ${m.bom.concreteMass.toFixed(0)} kg)` : ''}`],
    ['Materials', `${finishes.map(esc).join('; ')}; ${mm(v.thickness)} sheet${v.baseOn ? `; cast concrete base ${n1(v.baseLength)} × ${n1(v.baseWidth)} × ${mm(v.baseHeight)}` : ''}`],
    ['Date', `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`],
  ];
  const cover = `<section class="cover">
<p class="kicker">Strata build pack</p>
<h1>${esc(project.name || 'Untitled')}</h1>
<dl class="facts">${facts.map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join('')}</dl>
${errors ? `<p class="warn">The design has ${plural(errors, 'check error')}: fix ${errors === 1 ? 'it' : 'them'} in Strata before cutting.</p>` : ''}
<figure>${elevationSvg(m, view.right, 'Front elevation', { maxH: 300 })}</figure>
<h2>Contents</h2>
<ol class="toc">${sections.map((s) => `<li><a href="#${s.id}">${s.title}</a></li>`).join('')}</ol>
</section>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(project.name || 'Strata')} build pack</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  html { background: #fff; }
  body { font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #000; background: #fff; max-width: 760px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 34px; line-height: 1.1; margin: 0 0 18px; }
  h2 { font-size: 22px; margin: 0 0 10px; padding-bottom: 4px; border-bottom: 3px solid #000; }
  h3 { font-size: 15px; margin: 16px 0 6px; }
  .kicker { font-size: 13px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; margin: 8px 0 4px; }
  .facts { display: grid; grid-template-columns: 130px 1fr; gap: 6px 14px; font-size: 15px; margin: 0 0 18px; }
  .facts dt { font-weight: 700; } .facts dd { margin: 0; }
  .toc { font-size: 15px; columns: 2; } .toc a { color: #000; text-decoration: none; }
  section { padding-top: 6px; }
  section + section { break-before: page; page-break-before: always; margin-top: 40px; border-top: 1px dashed #bbb; padding-top: 24px; }
  figure { margin: 6px 0 10px; } figure.full { text-align: center; } figcaption { font-size: 12px; margin-top: 4px; }
  svg.drawing { display: block; max-width: 100%; height: auto; margin: 0 auto; font-family: inherit; }
  svg text { fill: #000; } .dim line { stroke: #000; stroke-width: 0.8; } .dim text { font-size: 11px; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; }
  th, td { border-bottom: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: middle; }
  th { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; border-bottom: 2px solid #000; }
  thead { display: table-header-group; } tr { break-inside: avoid; page-break-inside: avoid; }
  td.id { font-weight: 700; font-size: 14px; white-space: nowrap; } td.n { text-align: right; width: 2.5em; } td.big { font-size: 18px; font-weight: 700; }
  td.nw { white-space: nowrap; } td small { font-size: 11px; }
  .sched td { font-size: 12px; } .sched td.id { font-size: 14px; }
  svg.thumb { display: block; }
  ol.steps { padding-left: 26px; font-size: 14px; } ol.steps li { margin: 0 0 9px; padding-left: 4px; break-inside: avoid; }
  ol.steps li::marker { font-weight: 800; font-size: 16px; }
  .note { font-size: 12px; margin: 2px 0 8px; }
  .warn { border: 2px solid #000; padding: 6px 10px; font-weight: 700; }
  .big { font-size: 22px; font-weight: 800; margin: 4px 0; }
  .cols { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; } .cols > div { flex: 1 1 260px; }
  .swatch { display: inline-block; width: 14px; height: 14px; border: 1px solid #000; vertical-align: -2px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bar { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #000; padding: 8px 0; margin: -16px 0 12px; display: flex; gap: 12px; align-items: center; z-index: 1; }
  .bar button { font: inherit; font-weight: 700; font-size: 15px; padding: 8px 16px; border: 2px solid #000; background: #000; color: #fff; border-radius: 4px; cursor: pointer; }
  .bar span { font-size: 12px; }
  @media print {
    body { max-width: none; padding: 0; }
    .bar { display: none; }
    section + section { margin-top: 0; border-top: 0; padding-top: 0; }
    a { color: inherit; text-decoration: none; }
  }
</style></head>
<body>
<div class="bar"><button type="button" onclick="window.print()">Print / Save PDF</button><span>A4, portrait. Choose “Save as PDF” as the printer for a PDF.</span></div>
${cover}
${sections.map((s) => `<section id="${s.id}">\n<h2>${s.title}</h2>\n${s.body}\n</section>`).join('\n')}
<p class="note">Made with Strata from ${esc(project.name || 'this project')}. Everything here comes from the design: change the design and print a fresh pack.</p>
</body></html>
`;
}
