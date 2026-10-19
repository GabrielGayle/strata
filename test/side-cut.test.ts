import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { planeToWorld } from '../src/core/section';
import type { Gray } from '../src/core/image';

// a depth-map-like side picture: a bright oval on a black backdrop (bright = high)
function oval(): Gray {
  const w = 120, h = 90;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x - w / 2) / (w * 0.3), dy = (y - h / 2) / (h * 0.3);
      const r = dx * dx + dy * dy;
      data[y * w + x] = r < 1 ? 0.4 + 0.5 * (1 - r) : 0;
    }
  return { w, h, data };
}

const assets: Assets = { sideImg: oval(), frontImg: null, insMesh: null, srcMesh: null };

function run(params: Record<string, string | boolean>) {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', imgSideMode: 'heightmap', imgMix: '0.8', imgRange: '200', stackHeight: '150', ...params };
  return createPipeline()(p, assets);
}
const errors = (m: ReturnType<typeof run>) => m.issues.filter((i) => i.severity === 'error').map((i) => i.message);
const mains = (m: ReturnType<typeof run>) => m.sliced.plates.filter((pl) => pl.def.family === 'P');

describe('side picture cut-offs', () => {
  it('changes nothing when both are off', () => {
    const a = run({});
    const b = run({ imgCutLow: '0', imgCutHigh: '100' });
    expect(a.hf?.sideCut).toBeUndefined();
    expect(b.sliced.parts.length).toBe(a.sliced.parts.length);
    expect(mains(a).every((pl) => pl.parts.length > 0)).toBe(true);
  });

  it('leaves no plate on the black backdrop', () => {
    const before = run({});
    const m = run({ imgCutLow: '3' });
    const plates = mains(m);
    expect(plates.length).toBe(mains(before).length);
    const kept = plates.filter((pl) => pl.parts.length);
    // the oval covers the middle 60% along the stack: the end plates go, the middle ones stay
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(plates.length);
    expect(plates[0].parts.length).toBe(0);
    expect(plates[plates.length - 1].parts.length).toBe(0);
    // each kept plate is narrower than its full span and sits over the oval
    const mid = kept[Math.floor(kept.length / 2)];
    const full = mains(before).find((pl) => pl.def.key === mid.def.key)!;
    const width = (pl: typeof mid) => Math.max(...pl.parts.map((p) => p.bbox.maxX)) - Math.min(...pl.parts.map((p) => p.bbox.minX));
    expect(width(mid)).toBeLessThan(width(full) * 0.75);
    for (const pl of kept)
      for (const part of pl.parts) {
        const c = planeToWorld(pl.def.plane, (part.bbox.minX + part.bbox.maxX) / 2, 0);
        expect(m.hf!.sideCut!.grey(c[0], c[2])).toBeGreaterThan(0.03);
      }
    expect(errors(m)).toEqual([]);
  });

  it('cuts away the brightest parts with the upper cut-off', () => {
    const m = run({ imgCutHigh: '80' });
    // the oval's centre is brighter than 80%: the middle plate splits in two around it
    const plates = mains(m);
    const mid = plates[Math.floor(plates.length / 2)];
    expect(mid.parts.length).toBeGreaterThanOrEqual(2);
  });

  it('a steel base only gets slots under the plates that are left', () => {
    const m = run({ imgCutLow: '3', baseMaterial: 'steel' });
    const sb = m.sliced.steelBase!;
    const kept = new Set(mains(m).filter((pl) => pl.parts.length).map((pl) => pl.def.key));
    expect(sb.tabs.length).toBeGreaterThan(0);
    for (const t of sb.tabs) if (t.plateKey.startsWith('P')) expect(kept.has(t.plateKey)).toBe(true);
    expect(errors(m)).toEqual([]);
  });
});
