import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { MAP_RENDER_HEIGHT, MAP_RENDER_WIDTH, renderVenueMockup } from '../src/core/mapRender';
import { fetchTerrariumGrid } from '../src/core/mapTerrarium';
import { reprojectResample } from '../src/core/mapProject';
import { mapGridToDepth } from '../src/core/mapToDepth';
import { fixtureTileFetcher } from './map-cli-fixtures';
import { NEASDEN_BBOX } from './map-fixtures';

describe('map venue render', () => {
  it('renders Neasden fixtures to a fixed-size PNG offline', async () => {
    const elev = await fetchTerrariumGrid({ bbox: NEASDEN_BBOX }, { fetch: fixtureTileFetcher });
    const metric = reprojectResample(elev, { bbox: NEASDEN_BBOX, resM: 8, model: 'dtm' });
    const { depth } = mapGridToDepth(metric);
    const buf = renderVenueMockup({ elevation: elev, depth, title: 'Neasden' });
    const png = PNG.sync.read(buf);
    expect(png.width).toBe(MAP_RENDER_WIDTH);
    expect(png.height).toBe(MAP_RENDER_HEIGHT);
    expect(buf.length).toBeGreaterThan(10_000);
  });
});
