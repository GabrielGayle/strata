import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, newProject, PRESETS } from '../src/core/project';
import { buildZip, buildPackHtmlChecked } from '../src/core/exporters';
import { buildPlateManifest, dxfHasEntities, svgHasPaths } from '../src/core/buildPackIntegrity';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { depthToGray } from '../src/core/depth';
import { fixtureTileFetcher } from './map-cli-fixtures';
import { NEASDEN_BBOX } from './map-fixtures';
import { setMapTileFetcher } from '../src/core/mapTerrarium';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

function assertZipPlates(model: ReturnType<ReturnType<typeof createPipeline>>, project: ReturnType<typeof newProject>, label: string) {
  const zip = unzipSync(buildZip(model, project));
  const names = Object.keys(zip);
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));
  expect(manifest.plateCount, label).toBe(model.sliced.plates.length);
  expect(manifest.plates.length, label).toBe(model.sliced.plates.length);
  for (const row of manifest.plates) {
    expect(names, label).toContain(row.dxf);
    expect(names, label).toContain(row.svg);
    const dxf = strFromU8(zip[row.dxf]);
    const svg = strFromU8(zip[row.svg]);
    expect(dxfHasEntities(dxf), `${label} ${row.key} dxf`).toBe(true);
    expect(svgHasPaths(svg), `${label} ${row.key} svg`).toBe(true);
    for (const pf of row.partFiles) {
      expect(names, label).toContain(pf);
      expect(dxfHasEntities(strFromU8(zip[pf])), `${label} ${pf}`).toBe(true);
    }
    const ids = new Set(row.partIds);
    expect(ids.size, `${label} unique part ids`).toBe(row.partIds.length);
  }
  const html = strFromU8(zip['build-pack.html']);
  buildPackHtmlChecked(project, model); // throws if HTML inconsistent
  expect(html).toContain('Strata build pack');
}

describe('build pack integrity', { timeout: 120_000 }, () => {
  it('matches model plates for image, tuned, waffle, flat, and radial jobs', () => {
    const cliff = deserialize(readFileSync(fileURLToPath(new URL('../examples/image-cliff.strata.json', import.meta.url)), 'utf8'));
    assertZipPlates(createPipeline()(cliff, assets), cliff, 'image-cliff');

    const tuned = newProject();
    tuned.params.tuneOn = '1';
    tuned.params.tuneMode = 'chord';
    tuned.params.plateCount = '24';
    assertZipPlates(createPipeline()(tuned, assets), tuned, 'tuned');

    const waffle = newProject();
    waffle.params.sliceMode = 'waffle';
    waffle.params.plateCount = '8';
    assertZipPlates(createPipeline()(waffle, assets), waffle, 'waffle');

    const flat = newProject();
    flat.params.sliceMode = 'flat';
    flat.params.plateCount = '16';
    assertZipPlates(createPipeline()(flat, assets), flat, 'flat');

    const radial = newProject();
    radial.params.sliceMode = 'radial';
    radial.params.radialCount = '10';
    assertZipPlates(createPipeline()(radial, assets), radial, 'radial');
  });

  it('matches model plates for thin high-count row (Pacey repro)', () => {
    const p = newProject();
    p.params.plateCount = '94';
    p.params.pitch = '2.5';
    p.params.thickness = '0.5';
    const m = createPipeline()(p, assets);
    assertZipPlates(m, p, 'pacey-thin');
    const manifest = buildPlateManifest(m, p);
    expect(manifest.plates.every((row) => row.dxf === `plates/${safe(row.key)}.dxf`)).toBe(true);
  });

  it('includes every plate for a Neasden map stack (offline fixtures)', async () => {
    setMapTileFetcher(fixtureTileFetcher);
    const spec = defaultMapSpec({
      bbox: NEASDEN_BBOX,
      source: 'terrarium',
      exaggeration: 'auto',
      layerBudget: 'jenks',
      engrave: { enabled: false, features: [] },
      sunkenFrame: { enabled: true },
    });
    const bundle = await buildMapBundle(spec, {
      fetch: fixtureTileFetcher,
      stack: { plateCount: 12, thicknessMm: 3, masterWidthMm: 520, layerBudget: 'jenks' },
    });
    const p = newProject();
    const preset = PRESETS.find((x) => x.name === 'Stamped stack')!;
    p.params = { ...p.params, ...preset.params, plateCount: '12', topDepth: '40' };
    p.images.top = bundle.asset;
    const gray = depthToGray(bundle.depth);
    const m = createPipeline()(p, { sideImg: null, frontImg: null, topImg: gray, insMesh: null, srcMesh: null });
    assertZipPlates(m, p, 'neasden-map');
  });
});
