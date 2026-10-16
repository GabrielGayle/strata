import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { editionEtchPaths } from '../src/core/mapBackPlateEtch';
import { buildZip } from '../src/core/exporters';
import { defaultMapSpec } from '../src/core/mapSpec';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { smallProject } from './small-project';
import type { Part } from '../src/core/slicer';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

const plate: Part = {
  id: 'P1',
  plateKey: 'P1',
  family: 'P',
  index: 0,
  piece: 0,
  plane: { origin: [0, 0, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 1, 0] },
  thickness: 3,
  shape: [{ outer: [[0, 0], [120, 0], [120, 80], [0, 80], [0, 0]], holes: [] }],
  etch: [],
  labelPaths: [],
  labelAt: null,
  area: 9600,
  perimeter: 400,
  bbox: { minX: 0, minY: 0, maxX: 120, maxY: 80 },
  anchored: true,
  kind: 'plate',
};

describe('map edition + archetype card (T25)', () => {
  it('etches edition number paths', () => {
    expect(editionEtchPaths(plate, 12).length).toBeGreaterThan(0);
  });

  it('ships archetype-card.json in the build zip', () => {
    const p = smallProject();
    p.images.top = {
      name: 'Map',
      dataUrl: 'data:image/png;base64,AA',
      map: defaultMapSpec({
        bbox: [-0.28, 51.54, -0.24, 51.57],
        editionNumber: 3,
        archetypeCard: { archetype: 'venue-relief', edition: 3, venue: 'Test' },
      }),
    };
    const m = createPipeline()(p, assets);
    const files = unzipSync(buildZip(m, p));
    expect(strFromU8(files['map/archetype-card.json'])).toContain('"venue-relief"');
  });
});
