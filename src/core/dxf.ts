// Minimal, widely compatible DXF (R12 / AC1009) writer: closed POLYLINEs with
// arc bulges, or plain LINE + ARC entities. No splines, ever.
import type { Path } from './geom2d';
import type { Seg } from './arcs';

export interface Layer {
  name: string;
  color: number; // ACI
}

export const LAYERS = {
  CUT: { name: 'CUT', color: 1 },
  ETCH: { name: 'ETCH', color: 5 },
  BEND: { name: 'BEND', color: 3 },
  SHEET: { name: 'SHEET', color: 8 },
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

  /** A closed or open polyline built from fitted segments (arcs become bulges). */
  polyline(layer: string, segs: Seg[], closed: boolean) {
    if (!segs.length) return;
    const e: string[] = ['0', 'POLYLINE', '8', layer, '66', '1', '10', '0', '20', '0', '30', '0', '70', closed ? '1' : '0'];
    const verts = closed ? segs : [...segs, { kind: 'line', a: segs[segs.length - 1].b, b: segs[segs.length - 1].b } as Seg];
    for (const s of verts) {
      const bulge = s.kind === 'arc' ? Math.tan(s.sweep / 4) : 0;
      e.push('0', 'VERTEX', '8', layer, '10', f(s.a[0]), '20', f(s.a[1]), '30', '0');
      if (bulge !== 0) e.push('42', f(bulge));
      this.ext(s.a[0], s.a[1]);
      if (s.kind === 'arc') {
        // include arc extremes in the extents roughly
        this.ext(s.c[0] - s.r, s.c[1] - s.r);
        this.ext(s.c[0] + s.r, s.c[1] + s.r);
      }
    }
    e.push('0', 'SEQEND', '8', layer);
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
    out.push('9', '$ACADVER', '1', 'AC1009');
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
    for (const l of this.layers) out.push('0', 'LAYER', '2', l.name, '70', '0', '62', String(l.color), '6', 'CONTINUOUS');
    out.push('0', 'ENDTAB');
    out.push('0', 'ENDSEC');
    out.push('0', 'SECTION', '2', 'BLOCKS', '0', 'ENDSEC');
    out.push('0', 'SECTION', '2', 'ENTITIES');
    const head = out.join('\n');
    const body = this.ents.join('\n');
    return `${head}\n${body ? body + '\n' : ''}0\nENDSEC\n0\nEOF\n`;
  }
}
