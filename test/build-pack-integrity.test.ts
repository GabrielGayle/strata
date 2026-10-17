import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, newProject, PRESETS } from '../src/core/project';
import { buildZip, buildPackHtmlChecked, withExportLock } from '../src/core/exporters';
import { buildPlateManifest, dxfHasEntities, inAppPlateCount, svgHasPaths, uniqueZipPath } from '../src/core/buildPackIntegrity';
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
  const inApp = inAppPlateCount(model);
  expect(inApp, `${label} in-app`).toBe(model.sliced.plates.length);
  expect(manifest.plateCount, label).toBe(inApp);
  expect(manifest.plates.length, label).toBe(inApp);
  expect(names.filter((n) => n.startsWith('plates/') && n.endsWith('.dxf')).length, `${label} plates/*.dxf`).toBe(inApp);
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
    expect(htmlHasPlate(strFromU8(zip['build-pack.html']), row.key), `${label} gallery ${row.key}`).toBe(true);
  }
  const html = strFromU8(zip['build-pack.html']);
  buildPackHtmlChecked(project, model); // throws if HTML inconsistent
  expect(html).toContain('Strata build pack');
  expect(html).toContain(`data-plate-count="${inApp}"`);
  expect(html).toContain('id="show-spacers"');
  expect(html).toContain('id="gallery"');
}

function htmlHasPlate(html: string, key: string) {
  return html.includes(`data-plate-key="${key}"`);
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
    radial.params.insShape = 'none';
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

  it('keeps empty / zero-area layers in the pack (flat stack taller than the form)', () => {
    const p = newProject();
    p.params.sliceMode = 'flat';
    p.params.plateCount = '24';
    p.params.stackHeight = '8';
    p.params.thickness = '3';
    p.params.erosionAmp = '0';
    p.params.crest = '0';
    p.params.slope = '0';
    const m = createPipeline()(p, assets);
    const empty = m.sliced.plates.filter((pl) => !pl.parts.length);
    expect(empty.length).toBeGreaterThan(0);
    assertZipPlates(m, p, 'empty-layers');
    const manifest = buildPlateManifest(m, p);
    expect(manifest.plates.filter((r) => r.empty).length).toBe(empty.length);
  });

  it('does not overwrite zip paths after filename sanitisation', () => {
    const claimed = new Set<string>();
    const a = uniqueZipPath(claimed, 'plates/P_0.dxf');
    const b = uniqueZipPath(claimed, 'plates/P_0.dxf');
    expect(a).toBe('plates/P_0.dxf');
    expect(b).toBe('plates/P_0-2.dxf');
    expect(a).not.toBe(b);
  });

  it('ignores a nested export while one is already running', async () => {
    let inner: { ok: true; value: number } | { ok: false } | null = null;
    const outer = withExportLock(() => {
      inner = withExportLock(() => 2);
      return 1;
    });
    expect(outer).toEqual({ ok: true, value: 1 });
    expect(inner).toEqual({ ok: false });
    expect(withExportLock(() => 3)).toEqual({ ok: false });
    await new Promise((r) => setTimeout(r, 450));
    expect(withExportLock(() => 4)).toEqual({ ok: true, value: 4 });
  });
});
