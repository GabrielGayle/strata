import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { MAP_RENDER_HEIGHT, MAP_RENDER_WIDTH, renderVenueMockup } from '../src/core/mapRender';
import { mapGridToDepth, syntheticConeGrid } from '../src/core/mapToDepth';

describe('map venue render', () => {
  it('renders a synthetic elevation grid to a fixed-size PNG', () => {
    const elev = syntheticConeGrid(32, 24, 18);
    const { depth } = mapGridToDepth(elev);
    const buf = renderVenueMockup({ elevation: elev, depth, title: 'Cone' });
    const png = PNG.sync.read(buf);
    expect(png.width).toBe(MAP_RENDER_WIDTH);
    expect(png.height).toBe(MAP_RENDER_HEIGHT);
    expect(buf.length).toBeGreaterThan(10_000);
  });
});
