// A side picture that asks for plate tops below the floor is cut flat there; the field says so.
import { describe, expect, it } from 'vitest';
import { buildHeightField, PLATE_FLOOR_MM } from '../src/core/heightfield';
import { defaultRaw, evaluateParams } from '../src/core/params';
import type { Gray } from '../src/core/image';

// a black backdrop with a bright disc that darkens to its rim, like a depth map of one shape
function disc(): Gray {
  const w = 128, h = 64;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = Math.hypot((x - w / 2) / 40, (y - h / 2) / 24);
      data[y * w + x] = r < 1 ? 0.15 + 0.85 * (1 - r) : 0;
    }
  return { w, h, data };
}

const values = (over: Record<string, string>) =>
  evaluateParams({ ...defaultRaw(), stackSource: 'strata', strataOn: false, imgSideMode: 'heightmap', imgSideFit: 'off', imgMix: '0.25', imgRange: '300', ...over }).values;

describe('side picture against the plate floor', () => {
  it('reports the share cut flat and the lift that clears it', () => {
    const hf = buildHeightField(values({ stackHeight: '10' }), disc());
    expect(hf.floorClip).toBeDefined();
    expect(hf.floorClip!.fraction).toBeGreaterThan(0.2);
    // the darkest part of the picture (0.15) needs 10 + 0.25 × (0.15 × 300 − 150) + lift ≥ floor; its soft rim asks a little more
    const darkest = PLATE_FLOOR_MM - (10 + 0.25 * (0.15 * 300 - 150));
    expect(hf.floorClip!.liftMm).toBeGreaterThan(darkest - 1);
    expect(hf.floorClip!.liftMm).toBeLessThan(darkest + 10);
  });

  it('is quiet once Plate height clears it, and the backdrop alone never counts', () => {
    const lift = buildHeightField(values({ stackHeight: '10' }), disc()).floorClip!.liftMm;
    const raised = buildHeightField(values({ stackHeight: String(Math.ceil(10 + lift)) }), disc());
    expect(raised.floorClip).toBeUndefined();
    expect(raised.at(0, 0)).toBeGreaterThan(PLATE_FLOOR_MM);
  });
});
