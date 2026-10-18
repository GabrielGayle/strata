// Rebuilds the Buttermere curve fixture from Terrarium tiles (needs network the first time).
// npx tsx scripts/curve-fixture.ts <out.strata.json> [--terraced] [--cache <dir>]
import { readFileSync, writeFileSync } from 'node:fs';
import { buildMapBundle, mapSpecFromCli, mapStackFromProject } from '../src/core/mapPipeline';
import { parseEngraveFlag } from '../src/core/mapSpec';
import { deserialize, serialize } from '../src/core/project';
import { BUTTERMERE_BBOX } from '../test/map-fixtures';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? 'buttermere.strata.json';
const ci = args.indexOf('--cache');
const project = deserialize(readFileSync('test/fixtures/projects/buttermere-terrarium-77.strata.json', 'utf8'));
const spec = {
  ...mapSpecFromCli({
    title: 'Buttermere',
    bbox: BUTTERMERE_BBOX,
    source: 'terrarium',
    resM: 8,
    exaggeration: 4,
    engrave: parseEngraveFlag(undefined, true),
    cacheDir: ci >= 0 ? args[ci + 1] : undefined,
  }),
  ...(args.includes('--terraced') ? { terraced: true } : {}),
};
const bundle = await buildMapBundle(spec, { stack: mapStackFromProject(project), allowOverpassNetwork: true });
project.images.top = bundle.asset;
writeFileSync(out, serialize(project));
console.log(`wrote ${out}`);
