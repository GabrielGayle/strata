import { describe, expect, it } from 'vitest';
import { formatMapOrthoReadout, measureMapOrthoExtent, previewAutoDimension } from '../src/core/autoDimension';
import { mapGridToDepth } from '../src/core/mapToDepth';
import { syntheticConeGrid } from '../src/core/mapToDepth';
import { newProject } from '../src/core/project';
import { NEASDEN_FAST_BBOX } from './map-fixtures';

describe('map auto-dimension ortho (T17)', () => {
  it('stores map ortho metadata on depth and readout matches bbox km', () => {
    const grid = syntheticConeGrid(48, 40, 15);
    const { depth } = mapGridToDepth(grid, { bbox: NEASDEN_FAST_BBOX, exaggeration: 1 });
    expect(depth.mapOrtho?.source).toBe('map');
    const ext = measureMapOrthoExtent(depth);
    expect(ext?.widthM).toBeGreaterThan(0);
    const readout = formatMapOrthoReadout(depth);
    expect(readout).toMatch(/km/);
    expect(readout).toMatch(/relief/i);
  });

  it('previewAutoDimension uses map ortho without pinhole note', () => {
    const grid = syntheticConeGrid(48, 40, 15);
    const { depth } = mapGridToDepth(grid, { bbox: NEASDEN_FAST_BBOX });
    const preview = previewAutoDimension('top', depth, newProject().params);
    expect(preview.ok).toBe(true);
    expect(preview.readout).toMatch(/km/);
  });
});
