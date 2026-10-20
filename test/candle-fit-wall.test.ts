// Candelabra › Fit plates on a wall piece: the plates wrap each candle lying along
// the wall and the base covers its foot, rather than flattening the plates and
// stretching the base to every candle's whole length.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPipeline } from '../src/core/pipeline';
import { deserialize } from '../src/core/project';
import { loadAssets } from '../src/packNode';
import { fitCandles } from '../src/ui/CandlePanel';
import { baseTop } from '../src/core/slicer';

const FIXTURE = 'test/fixtures/projects/lucky-horseshoe.strata.json';

describe('Fit plates to the candelabra on a wall', () => {
  for (const wallPlates of ['across', 'down']) {
    it(`keeps plates deep enough to hold the candles (plates ${wallPlates})`, async () => {
      const p = deserialize(readFileSync(FIXTURE, 'utf8'));
      p.params = { ...p.params, mount: 'wall', wallPlates };
      const m = createPipeline()(p, await loadAssets(p));
      const patch = fitCandles(m, p.candles!)!;
      // every candle lies inside the plates' depth (Fit used to drop them to 10 mm, leaving the candles floating above)
      for (const b of m.objects.filter((q) => q.object.id.startsWith('candle'))) expect(baseTop(m.v) + Number(patch.stackHeight)).toBeGreaterThanOrEqual(b.object.y + b.object.w / 2);
      // the base isn't stretched to the candles' full length
      const tallest = Math.max(...m.objects.filter((b) => b.object.id.startsWith('candle')).map((b) => b.object.h));
      expect(Number(patch.baseLength)).toBeLessThan(Number(m.v.baseLength) + tallest);
      expect(Number(patch.baseWidth)).toBeLessThan(Number(m.v.baseWidth) + tallest);
      // applying it still builds, with every candle wrapped by the plates
      p.params = { ...p.params, ...patch };
      const after = createPipeline()(p, await loadAssets(p));
      expect(after.sliced.plates.length).toBeGreaterThan(0);
      for (const b of after.objects.filter((q) => q.object.id.startsWith('candle'))) expect(b.object.y + b.object.w / 2).toBeLessThanOrEqual(baseTop(after.v) + after.v.stackHeight + 1e-6);
    });
  }
});
