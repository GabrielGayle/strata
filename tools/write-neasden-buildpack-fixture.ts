import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { newProject, PRESETS, serialize } from '../src/core/project';
import { fixtureTileFetcher } from '../test/map-cli-fixtures';
import { NEASDEN_BBOX } from '../test/map-fixtures';
import { setMapTileFetcher } from '../src/core/mapTerrarium';

async function main() {
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
  if (!preset) throw new Error('Stamped stack preset missing');
  p.name = 'Neasden buildpack e2e';
  p.params = { ...p.params, ...preset.params, plateCount: '12', topDepth: '40' };
  p.images.top = bundle.asset;
  mkdirSync(join('test/fixtures/projects'), { recursive: true });
  writeFileSync(join('test/fixtures/projects/neasden-buildpack.strata.json'), serialize(p));
  console.log('wrote test/fixtures/projects/neasden-buildpack.strata.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
