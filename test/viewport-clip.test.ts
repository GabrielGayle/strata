import { describe, expect, it } from 'vitest';
import { clipPlanesForBounds, gridFloorY } from '../src/ui/viewportClip';

describe('viewport clip planes', () => {
  it('keeps a moderate near/far ratio for typical models', () => {
    const { near, far } = clipPlanesForBounds(800);
    expect(near).toBeGreaterThanOrEqual(1);
    expect(far).toBeGreaterThan(near * 8);
    expect(far / near).toBeLessThan(5000);
  });

  it('places the grid below the base footprint', () => {
    expect(gridFloorY(800)).toBeLessThan(-2);
    expect(gridFloorY(80)).toBeLessThan(0);
  });
});
