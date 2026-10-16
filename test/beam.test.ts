import { describe, expect, it } from 'vitest';
import { analyticFreeHz, beamModes, centsBetween, tuneBar } from '../src/core/beam';

describe('free-free Timoshenko bar', () => {
  it('matches the thin-strip formula and the 22.4% nodes', () => {
    const hz = analyticFreeHz(300, 3, 'steel');
    const t0 = performance.now();
    const m = beamModes({ lengthMm: 300, thicknessMm: 3, widthMm: 50, material: 'steel' });
    const ms = performance.now() - t0;
    expect(m.hz[0]).toBeCloseTo(hz, 0);
    expect(Math.abs(m.hz[0] - hz) / hz).toBeLessThan(0.005);
    expect(m.hz[1] / m.hz[0]).toBeCloseTo(2.756, 2);
    expect(m.hz[2] / m.hz[0]).toBeGreaterThan(5.3);
    expect(m.nodes[0]).toBeCloseTo(0.2242, 3);
    expect(m.nodes[1]).toBeCloseTo(0.7758, 3);
    expect(ms).toBeLessThan(500);
  });

  it('tunes a holed plate to within a cent', () => {
    const target = 440;
    const bar = tuneBar({ targetHz: target, thicknessMm: 3, widthMm: 80, material: 'steel', holeRmm: 4 });
    expect(Math.abs(bar.cents)).toBeLessThan(1);
    expect(Math.abs(centsBetween(bar.hz[0], target))).toBeLessThan(1);
    const plain = beamModes({ lengthMm: bar.lengthMm, thicknessMm: 3, widthMm: 80, material: 'steel', holeRmm: 0 });
    expect(plain.hz[0]).not.toBeCloseTo(bar.hz[0], 1);
  });
});
