// Measures plate-top curves the way the 18 Oct 2026 curve audit did: on the cut
// contour after kerf offset and arc fitting, top profile only.
import type { Seg } from '../../src/core/arcs';
import { fitShape } from '../../src/core/exporters';
import type { Vec2 } from '../../src/core/geom2d';
import type { Model } from '../../src/core/pipeline';

export interface CurveAudit {
  plates: number;
  fitErrors: number;
  /** Entities on the top profiles. */
  entities: number;
  arcs: number;
  /** Share of top-profile length written as arcs. */
  arcLengthShare: number;
  /** Turn (degrees) between consecutive entities on the top profiles. */
  medianTurnDeg: number;
  p90TurnDeg: number;
  over20Share: number;
  /** Entities shorter than 0.2 mm. */
  stubs: number;
  /** Of those, the ones more than 1 mm from either end of the plate (end corners may be tiny). */
  midStubs: number;
  /** Turns over 1° between entities on the top profiles (a kink the cutter has to stop for). */
  over1Share: number;
  /** Highest point of any plate top (mm above the concrete) and the height field max. */
  topMm: number;
  hfMaxMm: number;
  /** Plates whose top reaches within 0.5 mm of the highest. */
  platesAtTop: number;
}

const deg = (r: number) => (r * 180) / Math.PI;

function segLen(s: Seg): number {
  return s.kind === 'line' ? Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) : Math.abs(s.sweep) * s.r;
}

/** Unit tangent at the start (t = 0) or end (t = 1) of a segment, in travel direction. */
function tangent(s: Seg, end: boolean): Vec2 {
  if (s.kind === 'line') {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }
  const p = end ? s.b : s.a;
  const rx = p[0] - s.c[0], ry = p[1] - s.c[1];
  const l = Math.hypot(rx, ry) || 1;
  // CCW (sweep > 0) travels along (-ry, rx)
  return s.sweep > 0 ? [-ry / l, rx / l] : [ry / l, -rx / l];
}

function turn(a: Seg, b: Seg): number {
  const t0 = tangent(a, true), t1 = tangent(b, false);
  return Math.acos(Math.max(-1, Math.min(1, t0[0] * t1[0] + t0[1] * t1[1])));
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export function curveAudit(model: Model): CurveAudit {
  const v = model.v;
  const turns: number[] = [];
  let entities = 0, arcs = 0, arcLen = 0, len = 0, stubs = 0, midStubs = 0, topMm = 0;
  const plateTops: number[] = [];
  for (const plate of model.sliced.plates) {
    if (plate.def.family !== 'P') continue;
    let plateTop = 0;
    for (const part of plate.parts) {
      const bb = part.bbox;
      // the top profile: above the concrete line, clear of the plate's end edges
      const onTop = (p: Vec2) => p[1] > 0.5 && p[0] > bb.minX + 0.5 && p[0] < bb.maxX - 0.5;
      for (const c of fitShape(part.shape, v)) {
        if (c.hole) continue;
        const segs = c.segs;
        const top = segs.map((s) => onTop(s.a) && onTop(s.b));
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          plateTop = Math.max(plateTop, s.a[1], s.b[1]);
          if (!top[i]) continue;
          entities++;
          const l = segLen(s);
          len += l;
          if (l < 0.2) {
            stubs++;
            if ([s.a, s.b].every((p) => p[0] > bb.minX + 1 && p[0] < bb.maxX - 1)) midStubs++;
          }
          if (s.kind === 'arc') {
            arcs++;
            arcLen += l;
          }
          const j = (i + 1) % segs.length;
          if (top[j]) turns.push(deg(turn(s, segs[j])));
        }
      }
    }
    plateTops.push(plateTop);
    topMm = Math.max(topMm, plateTop);
  }
  return {
    plates: model.sliced.plates.length,
    fitErrors: model.issues.filter((i) => i.severity === 'error').length,
    entities,
    arcs,
    arcLengthShare: len ? arcLen / len : 0,
    medianTurnDeg: quantile(turns, 0.5),
    p90TurnDeg: quantile(turns, 0.9),
    over20Share: turns.length ? turns.filter((t) => t > 20).length / turns.length : 0,
    stubs,
    midStubs,
    over1Share: turns.length ? turns.filter((t) => t > 1).length / turns.length : 0,
    // kerf offset adds half a kerf on top
    topMm: topMm - v.kerf / 2,
    hfMaxMm: model.hf?.max ?? 0,
    platesAtTop: plateTops.filter((t) => t > topMm - 0.5).length,
  };
}

export function formatCurveAudit(r: CurveAudit): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return [
    `plates ${r.plates}, fit errors ${r.fitErrors}`,
    `top-profile entities ${r.entities} (${r.arcs} arcs = ${pct(r.entities ? r.arcs / r.entities : 0)}; ${pct(r.arcLengthShare)} of length)`,
    `turn median ${r.medianTurnDeg.toFixed(1)}°, p90 ${r.p90TurnDeg.toFixed(1)}°, over 1° ${pct(r.over1Share)}, over 20° ${pct(r.over20Share)}`,
    `entities under 0.2 mm ${r.stubs} (${r.midStubs} away from the plate ends)`,
    `highest top ${r.topMm.toFixed(2)} mm (height field ${r.hfMaxMm.toFixed(2)} mm), plates within 0.5 mm of it ${r.platesAtTop}`,
  ].join('\n');
}
