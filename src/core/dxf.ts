// DXF 2000 (AC1015) writer: closed LWPOLYLINEs with arc bulges, CIRCLE for
// round holes, or plain LINE + ARC entities. No splines, ever.
import type { Path, Vec2 } from './geom2d';
import type { Seg } from './arcs';

export interface Layer {
  name: string;
  color: number; // ACI
  /** False = non-plotting (REFERENCE geometry that must not be cut). */
  plot?: boolean;
}

export const LAYERS = {
  CUT: { name: 'CUT', color: 1 },
  ETCH: { name: 'ETCH', color: 5 },
  /** Map / OSM vector engraving (ticket 13+). */
  ENGRAVE: { name: 'ENGRAVE', color: 4 },
  BEND: { name: 'BEND', color: 3 },
  SHEET: { name: 'SHEET', color: 8 },
  /** Sheet border and other non-cut guides. */
  REFERENCE: { name: 'REFERENCE', color: 8, plot: false },
  NOTE: { name: 'NOTE', color: 2 },
};

const f = (x: number) => {
  const s = x.toFixed(4);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

export class DxfWriter {
  private ents: string[] = [];
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private layers: Layer[];

  constructor(layers: Layer[]) {
    this.layers = layers;
  }

  private ext(x: number, y: number) {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }

  /** Closed or open LWPOLYLINE; arcs become bulges (group 42). */
  polyline(layer: string, segs: Seg[], closed: boolean) {
    this.lwpolyline(layer, segs, closed);
  }

  lwpolyline(layer: string, segs: Seg[], closed: boolean) {
    if (!segs.length) return;
    const verts = closed ? segs : [...segs, { kind: 'line', a: segs[segs.length - 1].b, b: segs[segs.length - 1].b } as Seg];
    const e: string[] = ['0', 'LWPOLYLINE', '8', layer, '90', String(verts.length), '70', closed ? '1' : '0'];
    for (const s of verts) {
      const bulge = s.kind === 'arc' ? Math.tan(s.sweep / 4) : 0;
      e.push('10', f(s.a[0]), '20', f(s.a[1]));
      if (bulge !== 0) e.push('42', f(bulge));
      this.ext(s.a[0], s.a[1]);
      if (s.kind === 'arc') {
        this.ext(s.c[0] - s.r, s.c[1] - s.r);
        this.ext(s.c[0] + s.r, s.c[1] + s.r);
      }
    }
    this.ents.push(e.join('\n'));
  }

  /** Same geometry as separate LINE and ARC entities. */
  linesAndArcs(layer: string, segs: Seg[]) {
    for (const s of segs) {
      if (s.kind === 'line') this.line(layer, s.a[0], s.a[1], s.b[0], s.b[1]);
      else {
        let a0 = (Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]) * 180) / Math.PI;
        let a1 = (Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]) * 180) / Math.PI;
        if (s.sweep < 0) [a0, a1] = [a1, a0]; // DXF arcs always run CCW
        a0 = (a0 + 360) % 360;
        a1 = (a1 + 360) % 360;
        this.ents.push(['0', 'ARC', '8', layer, '10', f(s.c[0]), '20', f(s.c[1]), '30', '0', '40', f(s.r), '50', f(a0), '51', f(a1)].join('\n'));
        this.ext(s.a[0], s.a[1]);
        this.ext(s.b[0], s.b[1]);
      }
    }
  }

  line(layer: string, x0: number, y0: number, x1: number, y1: number) {
    this.ents.push(['0', 'LINE', '8', layer, '10', f(x0), '20', f(y0), '30', '0', '11', f(x1), '21', f(y1), '31', '0'].join('\n'));
    this.ext(x0, y0);
    this.ext(x1, y1);
  }

  /** Open polyline as consecutive LINE entities (etch strokes). */
  path(layer: string, p: Path, closed = false) {
    for (let i = 0; i < p.length - 1; i++) this.line(layer, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]);
    if (closed && p.length > 2) this.line(layer, p[p.length - 1][0], p[p.length - 1][1], p[0][0], p[0][1]);
  }

  circle(layer: string, cx: number, cy: number, r: number) {
    this.ents.push(['0', 'CIRCLE', '8', layer, '10', f(cx), '20', f(cy), '30', '0', '40', f(r)].join('\n'));
    this.ext(cx - r, cy - r);
    this.ext(cx + r, cy + r);
  }

  toString(): string {
    const ext = Number.isFinite(this.minX) ? [this.minX, this.minY, this.maxX, this.maxY] : [0, 0, 0, 0];
    const out: string[] = [];
    out.push('0', 'SECTION', '2', 'HEADER');
    out.push('9', '$ACADVER', '1', 'AC1015');
    out.push('9', '$INSUNITS', '70', '4');
    out.push('9', '$MEASUREMENT', '70', '1');
    out.push('9', '$EXTMIN', '10', f(ext[0]), '20', f(ext[1]), '30', '0');
    out.push('9', '$EXTMAX', '10', f(ext[2]), '20', f(ext[3]), '30', '0');
    out.push('0', 'ENDSEC');
    out.push('0', 'SECTION', '2', 'TABLES');
    out.push('0', 'TABLE', '2', 'LTYPE', '70', '1');
    out.push('0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0');
    out.push('0', 'ENDTAB');
    out.push('0', 'TABLE', '2', 'LAYER', '70', String(this.layers.length + 1));
    out.push('0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS');
    for (const l of this.layers) {
      const row = ['0', 'LAYER', '2', l.name, '70', '0', '62', String(l.color), '6', 'CONTINUOUS'];
      if (l.plot === false) row.push('290', '0');
      out.push(...row);
    }
    out.push('0', 'ENDTAB');
    out.push('0', 'ENDSEC');
    out.push('0', 'SECTION', '2', 'BLOCKS', '0', 'ENDSEC');
    out.push('0', 'SECTION', '2', 'ENTITIES');
    const head = out.join('\n');
    const body = this.ents.join('\n');
    return `${head}\n${body ? body + '\n' : ''}0\nENDSEC\n0\nEOF\n`;
  }
}

export function dxfPairs(text: string): [number, string][] {
  const l = text.split(/\r?\n/);
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < l.length; i += 2) out.push([parseInt(l[i].trim(), 10), l[i + 1].trim()]);
  return out;
}

export interface DxfEntityRef {
  type: string;
  layer: string;
}

/** Entity types in the ENTITIES section (VERTEX/SEQEND are skipped). */
export function listDxfEntities(text: string): DxfEntityRef[] {
  const P = dxfPairs(text);
  let i = P.findIndex(([c, v], k) => c === 2 && v === 'ENTITIES' && P[k - 1]?.[1] === 'SECTION');
  if (i < 0) return [];
  i++;
  const out: DxfEntityRef[] = [];
  while (i < P.length && !(P[i][0] === 0 && P[i][1] === 'ENDSEC')) {
    if (P[i][0] !== 0) {
      i++;
      continue;
    }
    const type = P[i][1];
    if (type === 'VERTEX' || type === 'SEQEND') {
      i++;
      continue;
    }
    let layer = '0';
    let k = i + 1;
    while (k < P.length && P[k][0] !== 0) {
      if (P[k][0] === 8) layer = P[k][1];
      k++;
    }
    out.push({ type, layer });
    i = k;
  }
  return out;
}

export function dxfEntitySummary(text: string): { types: Record<string, number>; layers: Record<string, Record<string, number>> } {
  const types: Record<string, number> = {};
  const layers: Record<string, Record<string, number>> = {};
  for (const e of listDxfEntities(text)) {
    types[e.type] = (types[e.type] ?? 0) + 1;
    layers[e.layer] ??= {};
    layers[e.layer][e.type] = (layers[e.layer][e.type] ?? 0) + 1;
  }
  return { types, layers };
}

const FORBIDDEN_CUT_TYPES = ['POLYLINE', 'SPLINE', 'LINE', 'INSERT', 'TEXT', 'MTEXT', 'HATCH', 'ELLIPSE'] as const;
const ALLOWED_CUT_TYPES = new Set(['LWPOLYLINE', 'CIRCLE', 'ARC']);

function isSheetSize(w: number, h: number, sheetW: number, sheetH: number, tol: number) {
  const a = Math.max(w, h);
  const b = Math.min(w, h);
  const A = Math.max(sheetW, sheetH);
  const B = Math.min(sheetW, sheetH);
  return Math.abs(a - A) <= tol && Math.abs(b - B) <= tol;
}

/** True when the file still contains a 1250×2500 (or similar) sheet-border rectangle. */
export function dxfHasSheetBorder(text: string, sheetW = 2500, sheetH = 1250, tol = 2): boolean {
  const P = dxfPairs(text);
  let i = P.findIndex(([c, v], k) => c === 2 && v === 'ENTITIES' && P[k - 1]?.[1] === 'SECTION');
  if (i < 0) return false;
  i++;
  const lineLens: number[] = [];
  while (i < P.length && !(P[i][0] === 0 && P[i][1] === 'ENDSEC')) {
    if (P[i][0] !== 0) {
      i++;
      continue;
    }
    const type = P[i][1];
    const xs: number[] = [];
    const ys: number[] = [];
    let x0 = 0;
    let y0 = 0;
    let x1 = 0;
    let y1 = 0;
    let k = i + 1;
    while (k < P.length && P[k][0] !== 0) {
      if (P[k][0] === 10) {
        x0 = +P[k][1];
        xs.push(x0);
      } else if (P[k][0] === 20) {
        y0 = +P[k][1];
        ys.push(y0);
      } else if (P[k][0] === 11) x1 = +P[k][1];
      else if (P[k][0] === 21) y1 = +P[k][1];
      k++;
    }
    if (type === 'LINE') {
      lineLens.push(Math.hypot(x1 - x0, y1 - y0));
    } else if ((type === 'LWPOLYLINE' || type === 'POLYLINE') && xs.length >= 4) {
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      if (isSheetSize(w, h, sheetW, sheetH, tol)) return true;
    }
    i = k;
  }
  const long = lineLens.filter((L) => Math.abs(L - Math.max(sheetW, sheetH)) <= tol).length;
  const short = lineLens.filter((L) => Math.abs(L - Math.min(sheetW, sheetH)) <= tol).length;
  return long >= 2 && short >= 2;
}

/** Shape a bureau cut-only file should have: CUT layer, closed outlines, no sheet rectangle, no etch. */
export function dxfCutStructure(text: string) {
  const sum = dxfEntitySummary(text);
  const ents = listDxfEntities(text);
  const typeNames = Object.keys(sum.types).sort();
  const layers = Object.keys(sum.layers).sort();
  return {
    types: sum.types,
    typeNames,
    layers,
    cutOnly: ents.length > 0 && ents.every((e) => e.layer === 'CUT'),
    hasBorder: dxfHasSheetBorder(text),
    hasEtch: Boolean(sum.layers.ETCH || sum.layers.ENGRAVE),
    hasForbidden: FORBIDDEN_CUT_TYPES.some((t) => sum.types[t]),
    extraTypes: typeNames.filter((t) => !ALLOWED_CUT_TYPES.has(t)),
  };
}

function bulgeLength(p1: Vec2, p2: Vec2, b: number): number {
  const chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (Math.abs(b) < 1e-12) return chord;
  const th = 4 * Math.atan(b);
  const r = chord / 2 / Math.sin(th / 2);
  return Math.abs(r * th);
}

/** Total length of CUT-layer geometry (LWPOLYLINE, CIRCLE, LINE, ARC, POLYLINE). */
export function dxfCutLength(text: string): number {
  const P = dxfPairs(text);
  let i = P.findIndex(([c, v], k) => c === 2 && v === 'ENTITIES' && P[k - 1]?.[1] === 'SECTION');
  if (i < 0) return 0;
  i++;
  let len = 0;
  const fields = (start: number) => {
    const f: Record<number, string> = {};
    let k = start + 1;
    while (k < P.length && P[k][0] !== 0) {
      f[P[k][0]] = P[k][1];
      k++;
    }
    return { f, next: k };
  };
  while (i < P.length && !(P[i][0] === 0 && P[i][1] === 'ENDSEC')) {
    const type = P[i][1];
    const { f, next } = fields(i);
    const layer = f[8] ?? '0';
    if (layer !== 'CUT') {
      i = next;
      continue;
    }
    if (type === 'CIRCLE') len += 2 * Math.PI * (+f[40]);
    else if (type === 'LINE') len += Math.hypot(+f[11] - +f[10], +f[21] - +f[20]);
    else if (type === 'ARC') {
      const r = +f[40];
      let a0 = +f[50];
      let a1 = +f[51];
      while (a1 <= a0) a1 += 360;
      len += r * ((a1 - a0) * Math.PI) / 180;
    } else if (type === 'LWPOLYLINE') {
      const closed = (parseInt(f[70] ?? '0', 10) & 1) === 1;
      const verts: { p: Vec2; b: number }[] = [];
      let k = i + 1;
      let bulge = 0;
      let x = 0;
      let y = 0;
      let have = false;
      const flush = () => {
        if (have) verts.push({ p: [x, y], b: bulge });
        bulge = 0;
        have = false;
      };
      while (k < P.length && P[k][0] !== 0) {
        if (P[k][0] === 10) {
          flush();
          x = +P[k][1];
          have = true;
        } else if (P[k][0] === 20) y = +P[k][1];
        else if (P[k][0] === 42) bulge = +P[k][1];
        k++;
      }
      flush();
      const n = closed ? verts.length : verts.length - 1;
      for (let j = 0; j < n; j++) len += bulgeLength(verts[j].p, verts[(j + 1) % verts.length].p, verts[j].b);
      i = k;
      continue;
    } else if (type === 'POLYLINE') {
      const closed = (parseInt(f[70] ?? '0', 10) & 1) === 1;
      const verts: { p: Vec2; b: number }[] = [];
      let k = next;
      while (P[k][1] === 'VERTEX') {
        const vf = fields(k);
        verts.push({ p: [+vf.f[10], +vf.f[20]], b: +(vf.f[42] ?? 0) });
        k = vf.next;
      }
      const n = closed ? verts.length : verts.length - 1;
      for (let j = 0; j < n; j++) len += bulgeLength(verts[j].p, verts[(j + 1) % verts.length].p, verts[j].b);
      i = fields(k).next;
      continue;
    }
    i = next;
  }
  return len;
}
