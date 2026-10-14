import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { topAt } from '../src/core/slicer';
import type { Gray } from '../src/core/image';
import { partDxf } from '../src/core/exporters';

// white image with a black disc in the middle
function disc(w = 120, h = 60): Gray {
  const data = new Float32Array(w * h).fill(1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot(x - w / 2, y - h / 2) < h * 0.3) data[y * w + x] = 0;
  return { w, h, data };
}

describe('top-surface impression', () => {
  const p = newProject();
  p.params = { ...p.params, insShape: 'none', erosionAmp: '0', crest: '0', imgTopMode: 'carve', topDepth: '20', topSteps: '1', imgSmooth: '0', imgContrast: '1' };
  const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: disc(), insMesh: null, srcMesh: null });
  const plates = m.sliced.plates;
  const mid = plates[Math.floor(plates.length / 2)].parts[0];
  const end = plates[0].parts[0];

  it('sinks the plate tops under the dark part of the image', () => {
    expect(m.sliced.top).toBeTruthy();
    const h = m.v.stackHeight;
    expect(topAt(mid.shape, 0)).toBeCloseTo(h - 20, 1); // centre of the disc
    expect(topAt(mid.shape, mid.bbox.maxX - 2)).toBeCloseTo(h, 1); // outside it
    expect(topAt(end.shape, 0)).toBeCloseTo(h, 1); // end plate misses the disc
  });

  it('cuts crisp vertical risers and stays laser-safe', () => {
    const top = mid.shape[0].outer.filter((q) => q[1] > m.v.stackHeight - 25);
    const risers = top.filter((q, i) => {
      const n = top[(i + 1) % top.length];
      return Math.abs(q[0] - n[0]) < 1e-6 && Math.abs(q[1] - n[1]) > 15;
    });
    expect(risers.length).toBeGreaterThanOrEqual(2);
    expect(m.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(partDxf(mid, m.v)).toContain('POLYLINE');
  });
});
