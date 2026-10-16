import { describe, expect, it } from 'vitest';
import { buildPackHtml } from '../src/core/buildPack';
import { partDxf } from '../src/core/exporters';
import { attributionEtchPaths } from '../src/core/mapAttributionEtch';
import { defaultMapSpec } from '../src/core/mapSpec';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { applyPreset, newProject, PRESETS } from '../src/core/project';
import type { Part } from '../src/core/slicer';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

describe('map attribution etch (T14)', () => {
  it('generates ETCH stroke paths for licence lines', () => {
    const part: Part = {
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
    const paths = attributionEtchPaths(part, ['© OpenStreetMap contributors (ODbL)', 'Terrain © Mapzen']);
    expect(paths.length).toBeGreaterThan(0);
    const dxf = partDxf(part, { kerf: 0.2, arcTolerance: 0.05, dxfMode: 'polyline' } as never, [], paths);
    expect(dxf).toContain('8\nETCH');
  });

  it('includes map credits in the build pack when MapSpec has attribution', () => {
    const p = applyPreset(newProject(), PRESETS.find((x) => x.name === 'Stamped stack')!);
    p.images.top = {
      name: 'Map',
      dataUrl: 'data:image/png;base64,AA',
      map: defaultMapSpec({
        bbox: [-0.28, 51.54, -0.24, 51.57],
        attribution: ['Map features © OpenStreetMap contributors (ODbL)'],
      }),
    };
    const m = createPipeline()(p, assets);
    const html = buildPackHtml(p, m);
    expect(html).toContain('section id="credits"');
    expect(html).toMatch(/OpenStreetMap/);
  });
});
