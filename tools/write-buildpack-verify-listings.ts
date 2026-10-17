import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { buildZip } from '../src/core/exporters';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, newProject, PRESETS, serialize } from '../src/core/project';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { depthToGray } from '../src/core/depth';
import { fixtureTileFetcher } from '../test/map-cli-fixtures';
import { NEASDEN_BBOX } from '../test/map-fixtures';
import { setMapTileFetcher } from '../src/core/mapTerrarium';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const outDir = join('docs', 'buildpack-verify');

function listing(label: string, zip: Uint8Array, plateCount: number): string {
  const files = unzipSync(zip);
  const names = Object.keys(files).sort();
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  return [
    `# ${label}`,
    `modelPlateCount=${plateCount}`,
    `manifestPlateCount=${manifest.plateCount}`,
    `zipFileCount=${names.length}`,
    '',
    ...names,
    '',
  ].join('\n');
}

async function neasdenProject() {
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
  const preset = PRESETS.find((x) => x.name === 'Stamped stack');
  if (!preset) throw new Error('preset');
  p.name = 'Neasden verify';
  p.params = { ...p.params, ...preset.params, plateCount: '12', topDepth: '40' };
  p.images.top = bundle.asset;
  return { p, gray: depthToGray(bundle.depth) };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const cliffPath = fileURLToPath(new URL('../examples/image-cliff.strata.json', import.meta.url));
  const cliff = deserialize(readFileSync(cliffPath, 'utf8'));
  const cliffModel = createPipeline()(cliff, assets);
  writeFileSync(join(outDir, 'image-cliff-zip.txt'), listing('image-cliff', buildZip(cliffModel, cliff), cliffModel.sliced.plates.length));

  const { p, gray } = await neasdenProject();
  const mapModel = createPipeline()(p, { ...assets, topImg: gray });
  writeFileSync(join(outDir, 'neasden-map-zip.txt'), listing('neasden-map', buildZip(mapModel, p), mapModel.sliced.plates.length));
  console.log('wrote docs/buildpack-verify/*.txt');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
