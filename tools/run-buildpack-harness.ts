/**
 * Exhaustive plate audit: model sliced.plates vs zip laser/plate files vs build-pack HTML.
 * Run: npx tsx tools/run-buildpack-harness.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, newProject, PRESETS } from '../src/core/project';
import { auditScenario, type PlateAuditIssue } from '../src/core/buildPackAudit';
import { angledPlatePathCount, buildPackHtml } from '../src/core/buildPack';
import { buildMapBundle } from '../src/core/mapPipeline';
import { defaultMapSpec } from '../src/core/mapSpec';
import { depthToGray } from '../src/core/depth';
import { fixtureTileFetcher } from '../test/map-cli-fixtures';
import { NEASDEN_BBOX } from '../test/map-fixtures';
import { setMapTileFetcher } from '../src/core/mapTerrarium';
import { grayFromRgba } from '../src/core/image';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const all: PlateAuditIssue[] = [];
const notes: string[] = [];

function run(name: string, model: ReturnType<ReturnType<typeof createPipeline>>, project: ReturnType<typeof newProject>) {
  all.push(...auditScenario(name, model, project));
  for (const turn of [-35, 35, 145, -120, 90]) {
    const { drawn, expected } = angledPlatePathCount(project, model, { turn, maxH: 400 });
    if (drawn < expected) {
      all.push({
        scenario: `${name}@turn${turn}`,
        plateKey: '*',
        kind: 'angled_missing',
        detail: `drawn ${drawn} < expected ${expected} (clip/overlap/empty pathD)`,
      });
    }
  }
  const html = buildPackHtml(project, model);
  const upright = model.sliced.parts.filter((p) => Math.abs(p.plane.normal[1]) < 0.5).length;
  if (upright > 12 && html.includes('fill-opacity="0"') && html.includes('id="elevations"')) {
    notes.push(
      `${name}: side/front elevation uses dense mode (>${12} upright parts): fill-opacity 0 — plate faces are outline-only; not absent from zip.`,
    );
  }
  const platePaths = (html.match(/class="plate"/g) ?? []).length;
  const mainCount = model.sliced.parts.filter((p) => p.family === 'P' || p.family === 'X' || p.family === 'R').length;
  if (platePaths > mainCount) {
    notes.push(`${name}: HTML has ${platePaths} class=plate paths across all angled figures vs ${mainCount} main parts (duplicate views, not missing).`);
  }
}

function pacey(thickness: string, count: string) {
  const p = newProject();
  p.params.plateCount = count;
  p.params.pitch = '2.5';
  p.params.thickness = thickness;
  return { p, m: createPipeline()(p, assets) };
}

async function main() {
  const thin = pacey('0.5', '94');
  run('pacey-94-thin', thin.m, thin.p);
  const thick = pacey('3', '48');
  run('pacey-48-thick', thick.m, thick.p);

  const cliff = deserialize(readFileSync(fileURLToPath(new URL('../examples/image-cliff.strata.json', import.meta.url)), 'utf8'));
  run('image-cliff-preset', createPipeline()(cliff, assets), cliff);

  const multi = newProject();
  multi.preset = 'Image cliff';
  multi.params.plateCount = '20';
  multi.params.imgSideMode = 'heightmap';
  multi.params.imgFrontMode = 'layers';
  const side = grayFromRgba(new Uint8Array(64 * 48 * 4).map((_, i) => (i % 4 === 3 ? 255 : 128 + ((i / 4) % 64))), 64, 48);
  const front = grayFromRgba(new Uint8Array(48 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : 60 + ((i / 4) % 48))), 48, 64);
  const top = grayFromRgba(new Uint8Array(32 * 32 * 4).map((_, i) => (i % 4 === 3 ? 255 : 200)), 32, 32);
  run('multi-face-image', createPipeline()(multi, { ...assets, sideImg: side, frontImg: front, topImg: top }), multi);

  const tuned = newProject();
  tuned.params.tuneOn = '1';
  tuned.params.tuneMode = 'chord';
  tuned.params.plateCount = '32';
  run('tuned-chord-32', createPipeline()(tuned, assets), tuned);

  const speech = newProject();
  speech.params.tuneOn = '1';
  speech.params.tuneMode = 'speech';
  speech.params.plateCount = '24';
  run('tuned-speech-24', createPipeline()(speech, assets), speech);

  const waffle = newProject();
  waffle.params.sliceMode = 'waffle';
  waffle.params.plateCount = '10';
  run('waffle-10', createPipeline()(waffle, assets), waffle);

  const radial = newProject();
  radial.params.sliceMode = 'radial';
  radial.params.radialCount = '18';
  run('radial-18', createPipeline()(radial, assets), radial);

  const flat = newProject();
  flat.params.sliceMode = 'flat';
  flat.params.plateCount = '28';
  flat.params.flatGuides = '1';
  run('flat-28', createPipeline()(flat, assets), flat);

  const holes = newProject();
  holes.params.plateCount = '24';
  holes.params.anchorHoles = '3';
  holes.params.rodsOn = true;
  holes.params.rodCount = '3';
  holes.params.spacerMode = 'both';
  run('row-rods-holes', createPipeline()(holes, assets), holes);

  const round = newProject();
  round.params.plateCount = '30';
  round.params.edgeRound = '0.85';
  round.params.edgeRoundIn = '0.4';
  run('edge-round-islands', createPipeline()(round, assets), round);

  const embed = newProject();
  embed.params.plateCount = '40';
  embed.params.embedDepth = '35';
  embed.params.stackHeight = '40';
  embed.params.crest = '0';
  embed.params.thickness = '0.5';
  embed.params.pitch = '2';
  run('embed-deep-thin-40', createPipeline()(embed, assets), embed);

  const ins = newProject();
  ins.params.insShape = 'cone';
  ins.params.plateCount = '36';
  run('insert-cone-36', createPipeline()(ins, assets), ins);

  setMapTileFetcher(fixtureTileFetcher);
  for (const budget of ['equal', 'quantile', 'jenks'] as const) {
    const spec = defaultMapSpec({
      bbox: NEASDEN_BBOX,
      source: 'terrarium',
      exaggeration: 18,
      layerBudget: budget,
      engrave: { enabled: false, features: [] },
      sunkenFrame: { enabled: true },
    });
    const bundle = await buildMapBundle(spec, {
      fetch: fixtureTileFetcher,
      stack: { plateCount: 14, thicknessMm: 3, masterWidthMm: 480, layerBudget: budget },
    });
    const mp = newProject();
    const preset = PRESETS.find((x) => x.name === 'Stamped stack');
    if (!preset) throw new Error('preset');
    mp.params = { ...mp.params, ...preset.params, plateCount: '14', topDepth: '40', sliceMode: 'flat' };
    mp.images.top = bundle.asset;
    const gray = depthToGray(bundle.depth);
    run(`map-neasden-${budget}-sunken`, createPipeline()(mp, { ...assets, topImg: gray }), mp);
  }

  // Fuzz: random row configs — file-level misses only
  for (let i = 0; i < 120; i++) {
    const p = newProject();
    p.params.plateCount = String(8 + (i % 45));
    p.params.thickness = ['0.5', '1', '3', '6'][i % 4];
    p.params.pitch = String(2 + (i % 8) * 0.5);
    p.params.embedDepth = String((i % 10) * 3);
    p.params.edgeRound = i % 5 === 0 ? '0.7' : '0';
    const m = createPipeline()(p, assets);
    all.push(...auditScenario(`fuzz-${i}`, m, p));
  }

  const fileIssues = all.filter((i) =>
    ['no_parts', 'missing_laser_dxf', 'empty_laser_dxf', 'missing_plate_dxf', 'empty_plate_dxf', 'missing_plate_svg', 'empty_plate_svg'].includes(
      i.kind,
    ),
  );
  const viewIssues = all.filter((i) => !fileIssues.includes(i));

  console.log('=== FILE / ZIP ISSUES (plate absent from fabrication) ===');
  if (!fileIssues.length) console.log('(none across all scenarios + 120 fuzz runs)');
  else console.log(JSON.stringify(fileIssues, null, 2));

  console.log('\n=== HTML VIEW ISSUES (schedule / angled / plan) ===');
  if (!viewIssues.length) console.log('(none)');
  else console.log(JSON.stringify(viewIssues, null, 2));

  console.log('\n=== VISUAL / UX NOTES (files present; view may mislead) ===');
  if (!notes.length) console.log('(none flagged)');
  else notes.forEach((n) => console.log(`- ${n}`));

  console.log(`\nTotal issues: ${all.length} (${fileIssues.length} file, ${viewIssues.length} view)`);
  process.exit(fileIssues.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
