import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { roundAll, topAt } from '../src/core/slicer';
import { rect, unionShapes, type Shape } from '../src/core/geom2d';

const run = (params: Record<string, string>) => {
  const p = newProject();
  p.params = { ...p.params, ...params };
  return createPipeline()(p, { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null });
};

/** Narrow dips in each part's top edge (a slit or notch), as "part@u". */
function dips(m: ReturnType<typeof run>): Set<string> {
  const out = new Set<string>();
  for (const part of m.sliced.parts) {
    const ys: number[] = [];
    for (let u = part.bbox.minX + 1; u < part.bbox.maxX - 1; u += 0.5) ys.push(topAt(part.shape, u) ?? NaN);
    for (let k = 2; k < ys.length - 12; k++) {
      if (Math.min(ys[k - 2], ys[k + 10]) - Math.min(...ys.slice(k, k + 9)) > 0.8 && ys[k - 1] - ys[k] > 0.3) {
        out.add(`${part.id}@${Math.round(part.bbox.minX + 1 + k * 0.5)}`);
        k += 10;
      }
    }
  }
  return out;
}

describe('round all corners', () => {
  it('never cuts slits into the plate tops', () => {
    const plain = dips(run({ edgeRound: '0' })); // the insert cavity's own notches
    for (const r of ['5', '15', '30']) {
      const extra = [...dips(run({ edgeRound: r }))].filter((d) => !plain.has(d));
      expect(extra, `edgeRound ${r}`).toEqual([]);
    }
  }, 60000);

  it('rounds inside corners by their own radius, or leaves them crisp at 0', () => {
    // a fat L: one inside corner at (30, 30), outside corners elsewhere
    const L: Shape = unionShapes(rect(0, 0, 80, 30), rect(0, 0, 30, 80));
    const near = (s: Shape, x: number, y: number) => s.some((ex) => ex.outer.some((q) => Math.hypot(q[0] - x, q[1] - y) < 0.5));
    expect(near(roundAll(L, 5, 0), 30, 30)).toBe(true); // valley kept (bar the 0.3 mm kerf blunting)
    expect(near(roundAll(L, 5, 0), 80, 30)).toBe(false); // peak rounded
    expect(near(roundAll(L, 0, 5), 30, 30)).toBe(false); // valley rounded
    expect(near(roundAll(L, 0, 5), 80, 30)).toBe(true); // peak kept
  });

  it('reports where the edge moved most and warns when detail is flattened', () => {
    const m = run({ edgeRound: '4' });
    const spots = m.sliced.roundSpots ?? [];
    expect(spots.length).toBeGreaterThan(0);
    expect(spots[0].move).toBeGreaterThanOrEqual(spots[spots.length - 1].move);
    expect(m.sliced.warnings.some((w) => w.startsWith('Round all corners'))).toBe(false);
    expect(run({ edgeRound: '0' }).sliced.roundSpots).toEqual([]);
  }, 30000);
});
