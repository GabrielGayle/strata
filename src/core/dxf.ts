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

const ENTITY_SUBCLASS: Record<string, string> = {
  LWPOLYLINE: 'AcDbPolyline',
  CIRCLE: 'AcDbCircle',
  LINE: 'AcDbLine',
  ARC: 'AcDbCircle',
  POLYLINE: 'AcDb2dPolyline',
  VERTEX: 'AcDbVertex',
  SEQEND: 'AcDbEntity',
};

class HandleGen {
  private n = 1;
  next(): string {
    return (this.n++).toString(16).toUpperCase();
  }
  seed(): string {
    return this.n.toString(16).toUpperCase();
  }
}

/** DXF 2000 (AC1015) entity with handle + AcDbEntity / geometry subclass markers. */
export class DxfWriter {
  private ents: string[][] = [];
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
    this.ents.push(e);
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
        this.ents.push(['0', 'ARC', '8', layer, '10', f(s.c[0]), '20', f(s.c[1]), '30', '0', '40', f(s.r), '50', f(a0), '51', f(a1)]);
        this.ext(s.a[0], s.a[1]);
        this.ext(s.b[0], s.b[1]);
      }
    }
  }

  line(layer: string, x0: number, y0: number, x1: number, y1: number) {
    this.ents.push(['0', 'LINE', '8', layer, '10', f(x0), '20', f(y0), '30', '0', '11', f(x1), '21', f(y1), '31', '0']);
    this.ext(x0, y0);
    this.ext(x1, y1);
  }

  /** Open polyline as consecutive LINE entities (etch strokes). */
  path(layer: string, p: Path, closed = false) {
    for (let i = 0; i < p.length - 1; i++) this.line(layer, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]);
    if (closed && p.length > 2) this.line(layer, p[p.length - 1][0], p[p.length - 1][1], p[0][0], p[0][1]);
  }

  circle(layer: string, cx: number, cy: number, r: number) {
    this.ents.push(['0', 'CIRCLE', '8', layer, '10', f(cx), '20', f(cy), '30', '0', '40', f(r)]);
    this.ext(cx - r, cy - r);
    this.ext(cx + r, cy + r);
  }

  toString(): string {
    const ext = Number.isFinite(this.minX) ? [this.minX, this.minY, this.maxX, this.maxY] : [0, 0, 0, 0];
    const h = new HandleGen();
    const root = '0';
    const vportT = h.next();
    const ltypeT = h.next();
    const layerT = h.next();
    const styleT = h.next();
    const viewT = h.next();
    const ucsT = h.next();
    const appidT = h.next();
    const dimT = h.next();
    const blockRecT = h.next();
    const ltByBlock = h.next();
    const ltByLayer = h.next();
    const ltCont = h.next();
    const layer0 = h.next();
    const layerDef = h.next();
    const layerIds = this.layers.map(() => h.next());
    const styleStd = h.next();
    const appAcad = h.next();
    const dimStd = h.next();
    const modelRec = h.next();
    const paperRec = h.next();
    const modelBlk = h.next();
    const modelEnd = h.next();
    const paperBlk = h.next();
    const paperEnd = h.next();
    const dictRoot = h.next();
    const dictGroup = h.next();
    const vportActive = h.next();
    const entHandles = this.ents.map(() => h.next());

    const table = (name: string, handle: string, count: number, extra: string[] = []) => [
      '0', 'TABLE', '2', name, '5', handle, '330', root, '100', 'AcDbSymbolTable', '70', String(count), ...extra,
    ];
    const rec = (type: string, handle: string, owner: string, subclass: string, rest: string[]) => [
      '0', type, '5', handle, '330', owner, '100', 'AcDbSymbolTableRecord', '100', subclass, ...rest,
    ];

    const out: string[] = [];
    out.push('0', 'SECTION', '2', 'HEADER');
    out.push('9', '$ACADVER', '1', 'AC1015');
    out.push('9', '$HANDSEED', '5', h.seed());
    out.push('9', '$INSUNITS', '70', '4');
    out.push('9', '$MEASUREMENT', '70', '1');
    out.push('9', '$EXTMIN', '10', f(ext[0]), '20', f(ext[1]), '30', '0');
    out.push('9', '$EXTMAX', '10', f(ext[2]), '20', f(ext[3]), '30', '0');
    out.push('0', 'ENDSEC');

    out.push('0', 'SECTION', '2', 'CLASSES', '0', 'ENDSEC');

    out.push('0', 'SECTION', '2', 'TABLES');
    out.push(...table('VPORT', vportT, 1));
    out.push(
      ...rec('VPORT', vportActive, vportT, 'AcDbViewportTableRecord', [
        '2', '*Active', '70', '0', '10', '0', '20', '0', '11', '1', '21', '1', '12', '0', '22', '0',
        '13', '0', '23', '0', '14', '0.5', '24', '0.5', '15', '0.5', '25', '0.5', '16', '0', '26', '0', '36', '1',
        '17', '0', '27', '0', '37', '0', '40', '1000', '41', '1.34', '42', '50', '43', '0', '44', '0', '50', '0', '51', '0',
        '71', '0', '72', '1000', '73', '1', '74', '3', '75', '0', '76', '0', '77', '0', '78', '0',
      ]),
    );
    out.push('0', 'ENDTAB');

    out.push(...table('LTYPE', ltypeT, 3));
    for (const [id, name] of [
      [ltByBlock, 'ByBlock'],
      [ltByLayer, 'ByLayer'],
      [ltCont, 'Continuous'],
    ] as const) {
      out.push(
        ...rec('LTYPE', id, ltypeT, 'AcDbLinetypeTableRecord', ['2', name, '70', '0', '3', name === 'Continuous' ? 'Solid line' : '', '72', '65', '73', '0', '40', '0.0']),
      );
    }
    out.push('0', 'ENDTAB');

    out.push(...table('LAYER', layerT, this.layers.length + 2));
    out.push(...rec('LAYER', layer0, layerT, 'AcDbLayerTableRecord', ['2', '0', '70', '0', '62', '7', '6', 'Continuous']));
    out.push(...rec('LAYER', layerDef, layerT, 'AcDbLayerTableRecord', ['2', 'Defpoints', '70', '0', '62', '7', '6', 'Continuous', '290', '0']));
    this.layers.forEach((l, i) => {
      const row = ['2', l.name, '70', '0', '62', String(l.color), '6', 'Continuous'];
      if (l.plot === false) row.push('290', '0');
      out.push(...rec('LAYER', layerIds[i], layerT, 'AcDbLayerTableRecord', row));
    });
    out.push('0', 'ENDTAB');

    out.push(...table('STYLE', styleT, 1));
    out.push(
      ...rec('STYLE', styleStd, styleT, 'AcDbTextStyleTableRecord', [
        '2', 'Standard', '70', '0', '40', '0', '41', '1', '50', '0', '71', '0', '42', '2.5', '3', 'txt', '4', '',
      ]),
    );
    out.push('0', 'ENDTAB');

    out.push(...table('VIEW', viewT, 0), '0', 'ENDTAB');
    out.push(...table('UCS', ucsT, 0), '0', 'ENDTAB');

    out.push(...table('APPID', appidT, 1));
    out.push(...rec('APPID', appAcad, appidT, 'AcDbRegAppTableRecord', ['2', 'ACAD', '70', '0']));
    out.push('0', 'ENDTAB');

    out.push(...table('DIMSTYLE', dimT, 1, ['100', 'AcDbDimStyleTable']));
    out.push('0', 'DIMSTYLE', '105', dimStd, '330', dimT, '100', 'AcDbSymbolTableRecord', '100', 'AcDbDimStyleTableRecord', '2', 'Standard', '70', '0');
    out.push('0', 'ENDTAB');

    out.push(...table('BLOCK_RECORD', blockRecT, 2));
    out.push(...rec('BLOCK_RECORD', modelRec, blockRecT, 'AcDbBlockTableRecord', ['2', '*Model_Space']));
    out.push(...rec('BLOCK_RECORD', paperRec, blockRecT, 'AcDbBlockTableRecord', ['2', '*Paper_Space']));
    out.push('0', 'ENDTAB');
    out.push('0', 'ENDSEC');

    const block = (handle: string, owner: string, name: string, endHandle: string) => {
      out.push('0', 'BLOCK', '5', handle, '330', owner, '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockBegin', '2', name, '70', '0', '10', '0', '20', '0', '30', '0', '3', name, '1', '');
      out.push('0', 'ENDBLK', '5', endHandle, '330', owner, '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockEnd');
    };
    out.push('0', 'SECTION', '2', 'BLOCKS');
    block(modelBlk, modelRec, '*Model_Space', modelEnd);
    block(paperBlk, paperRec, '*Paper_Space', paperEnd);
    out.push('0', 'ENDSEC');

    out.push('0', 'SECTION', '2', 'ENTITIES');
    this.ents.forEach((raw, i) => {
      const type = raw[1];
      const layer = raw[3];
      const rest = raw.slice(4);
      const eh = entHandles[i];
      out.push('0', type, '5', eh, '330', modelRec, '100', 'AcDbEntity', '8', layer);
      if (type === 'ARC') {
        const i50 = rest.indexOf('50');
        out.push('100', 'AcDbCircle', ...rest.slice(0, i50), '100', 'AcDbArc', ...rest.slice(i50));
      } else if (type === 'SEQEND') {
        /* AcDbEntity only */
      } else {
        const sub = ENTITY_SUBCLASS[type] ?? 'AcDbEntity';
        if (sub !== 'AcDbEntity') out.push('100', sub);
        out.push(...rest);
      }
    });
    out.push('0', 'ENDSEC');

    out.push('0', 'SECTION', '2', 'OBJECTS');
    out.push('0', 'DICTIONARY', '5', dictRoot, '330', root, '100', 'AcDbDictionary', '281', '1', '3', 'ACAD_GROUP', '350', dictGroup);
    out.push('0', 'DICTIONARY', '5', dictGroup, '330', dictRoot, '100', 'AcDbDictionary', '281', '1');
    out.push('0', 'ENDSEC');
    out.push('0', 'EOF');
    return out.join('\n') + '\n';
  }
}

export function dxfPairs(text: string): [number, string][] {
  const l = text.split(/\r?\n/);
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < l.length; i += 2) out.push([parseInt(l[i].trim(), 10), l[i + 1].trim()]);
  return out;
}

const R2000_PLUS = new Set(['AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032']);

const REQUIRED_SUBCLASS: Record<string, string[]> = {
  LWPOLYLINE: ['AcDbEntity', 'AcDbPolyline'],
  CIRCLE: ['AcDbEntity', 'AcDbCircle'],
  LINE: ['AcDbEntity', 'AcDbLine'],
  ARC: ['AcDbEntity', 'AcDbCircle', 'AcDbArc'],
  POLYLINE: ['AcDbEntity', 'AcDb2dPolyline'],
};

/** Strict R2000+ check: handles, AcDbEntity / geometry subclass markers. No recover. */
export function assertStrictDxfR2000(text: string): void {
  const P = dxfPairs(text);
  let acad = '';
  for (let i = 0; i < P.length - 1; i++) {
    if (P[i][0] === 9 && P[i][1] === '$ACADVER' && P[i + 1][0] === 1) acad = P[i + 1][1];
  }
  if (!R2000_PLUS.has(acad)) throw new Error(`DXF $ACADVER ${acad || 'missing'} is not R2000+ (AC1015)`);

  const handles = new Set<string>();
  const takeHandle = (code: number, value: string, ctx: string) => {
    if (code !== 5 && code !== 105) return;
    if (!value) throw new Error(`${ctx}: empty handle`);
    if (handles.has(value)) throw new Error(`${ctx}: duplicate handle ${value}`);
    handles.add(value);
  };

  let i = P.findIndex(([c, v], k) => c === 2 && v === 'ENTITIES' && P[k - 1]?.[1] === 'SECTION');
  if (i < 0) throw new Error('DXF has no ENTITIES section');
  i++;
  while (i < P.length && !(P[i][0] === 0 && P[i][1] === 'ENDSEC')) {
    if (P[i][0] !== 0) {
      i++;
      continue;
    }
    const type = P[i][1];
    const subs: string[] = [];
    let handle = '';
    let k = i + 1;
    while (k < P.length && P[k][0] !== 0) {
      if (P[k][0] === 5 || P[k][0] === 105) handle = P[k][1];
      if (P[k][0] === 100) subs.push(P[k][1]);
      k++;
    }
    if (type !== 'VERTEX' && type !== 'SEQEND' && type !== 'ENDBLK') {
      takeHandle(5, handle, type);
      const need = REQUIRED_SUBCLASS[type];
      if (need) {
        for (const s of need) {
          if (!subs.includes(s)) throw new Error(`${type}: missing ${s} subclass (got ${subs.join(',') || 'none'})`);
        }
      } else if (!subs.includes('AcDbEntity')) {
        throw new Error(`${type}: missing AcDbEntity subclass`);
      }
    }
    i = k;
  }

  // Unique handles on table records / blocks / objects as well.
  for (let k = 0; k < P.length; k++) {
    if (P[k][0] !== 0) continue;
    const type = P[k][1];
    if (type === 'SECTION' || type === 'ENDSEC' || type === 'ENDTAB' || type === 'EOF' || type === 'TABLE') continue;
    let handle = '';
    let code = 5;
    let n = k + 1;
    while (n < P.length && P[n][0] !== 0) {
      if (P[n][0] === 5 || P[n][0] === 105) {
        handle = P[n][1];
        code = P[n][0];
        break;
      }
      n++;
    }
    if (!handle) continue;
    if (handles.has(handle)) continue; // already taken from ENTITIES
    takeHandle(code, handle, type);
  }
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
