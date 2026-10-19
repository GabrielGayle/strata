// Checks a nest against the real part outlines: every part on its sheet, inside the
// edge margin, and at least the gap from every other part. The tests run it on every
// nest they make, and the cloud nest job runs it before handing a nest back.
import { intersection, offset, shapeArea, type Shape } from './geom2d';
import { placeTransform, type NestResult } from './nest';

export interface NestPart {
  id: string;
  shape: Shape;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Half a tenth of a millimetre: Clipper's arcs and the outline grid round to about this. */
const SLACK = 0.05;

/** What is wrong with a nest, worst first; empty when every part keeps the gap. */
export function nestClearanceProblems(parts: NestPart[], r: NestResult, gap = r.spacing ?? 0): string[] {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const problems: string[] = [];
  const half = Math.max(0, gap / 2 - SLACK);
  r.sheets.forEach((s, si) => {
    const placed = s.placements.flatMap((pl) => {
      const p = byId.get(pl.id);
      if (!p) {
        problems.push(`sheet ${si + 1}: ${pl.id} is not a part`);
        return [];
      }
      const f = placeTransform(p.bbox, pl);
      const shape: Shape = p.shape.map((e) => ({ outer: e.outer.map(f), holes: e.holes.map((h) => h.map(f)) }));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const e of shape)
        for (const [x, y] of e.outer) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      const edge = Math.min(minX, minY, r.sheetW - maxX, r.sheetH - maxY);
      if (edge < gap - SLACK * 2) problems.push(`sheet ${si + 1}: ${pl.id} is ${edge.toFixed(2)} mm from the sheet edge`);
      const grown = half > 0 ? offset(shape.map((e) => ({ outer: e.outer, holes: [] })), half, 'round', 0.01) : shape;
      return [{ id: pl.id, grown, box: [minX - half, minY - half, maxX + half, maxY + half] as const }];
    });
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        if (a.box[2] < b.box[0] || b.box[2] < a.box[0] || a.box[3] < b.box[1] || b.box[3] < a.box[1]) continue;
        const touch = shapeArea(intersection(a.grown, b.grown));
        if (touch > 0.01) problems.push(`sheet ${si + 1}: ${a.id} and ${b.id} are closer than ${gap} mm (${touch.toFixed(2)} mm² overlap)`);
      }
  });
  return problems;
}
