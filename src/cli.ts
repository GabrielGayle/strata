// Headless export: the same fabrication files as the app, from a project JSON.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { buildZip } from './core/exporters';
import { applyFlatCliPatch, isMapDepthFace, parse01Flag, parseBoolFlag, parseFlatLevelFlag, type FlatCliPatch } from './core/depthFlat';
import { createPipeline } from './core/pipeline';
import { defaultHeroCamera, heroGlb, heroScene } from './core/hero';
import { loadAssets, readRates } from './packNode';

export { readRates };
import { defaultRaw, PARAMS, PARAM_MAP, type EvalResult, type ParamKind, type RawValue } from './core/params';
import { DEFAULT_RATES } from './core/price';
import { MASTER_SIZE_CLI_CANONICAL } from './core/masterPresets';
import { applyAutoDimensionPatch, previewAutoDimension, type DepthFace } from './core/autoDimension';
import { applyProjectPatch, formatPatchDiff, masterSizePatch, parseDesign } from './core/design';
import { serialize, deserialize, PRESETS, type Project } from './core/project';
import { buildMapBundle, MapSourceNotImplementedError, mapSpecFromCli } from './core/mapPipeline';
import { mapPresetSpec, parseMapPresetId } from './core/mapPresets';
import { renderVenueMockup } from './core/mapRender';
import { parseBbox, parseEngraveFlag, parseExaggeration, parseLayerBudget, parseMapSource, type MapSpec } from './core/mapSpec';
import { mapStackFromProject } from './core/mapPipeline';

export interface CliIssue {
  level: 'error' | 'warning';
  message: string;
}

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}


const defaultIo: CliIo = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

export interface ParamInfo {
  id: string;
  type: ParamKind;
  default: RawValue;
  range: [number, number] | null;
  choices: string[] | null;
  group: string;
  help: string | null;
}

/** Parameter catalogue printed by `cli params`. */
export function paramCatalog(): ParamInfo[] {
  return PARAMS.map((p) => ({
    id: p.id,
    type: p.kind,
    default: p.def,
    range: p.kind === 'number' ? [p.min ?? 0, p.max ?? 0] : null,
    choices: p.options ? p.options.map((o) => o.value) : null,
    group: p.group,
    help: p.help ?? null,
  }));
}

export interface PresetInfo {
  id: string;
  name: string;
  note: string;
  small: boolean;
  params: Record<string, RawValue>;
}

/** Preset catalogue printed by `cli presets`. */
export function presetCatalog(): PresetInfo[] {
  return PRESETS.map((p) => ({ id: p.name, name: p.name, note: p.note, small: !!p.small, params: p.params }));
}

const SIZE_HELP = MASTER_SIZE_CLI_CANONICAL.join(', ');

const USAGE = `Usage:
  npm run cli -- <project.json> --out <dir> | --zip <file.zip> [--date YYYY-MM-DD] [--preset <name>] [--size <id>] [--orientation portrait|landscape]
                 [--image side=path.jpg] [--auto-dimension side=top,front] [--relief-exaggeration <n>]
                 [--flat-level off|auto|plateau|percentile|<metres>] [--edge-ease <0..1>] [--step-limit <0..1>]
                 [--flat-negative] [--rates rates.json]
                 [--map <title>] [--bbox west,south,east,north]
                 [--map-source auto|ea-dtm|ea-dsm|terrarium]
                 [--map-res <metres>] [--exaggeration auto|<n>] [--layer-budget equal|quantile|jenks]
                 [--engrave on|off|roads,water,...]
                 [--map-cache <dir>] [--map-preset <id>] [--render <out.png>] [--glb <model.glb>]
  npm run cli -- say <project.json> "<instruction>"
  npm run cli -- <project.json> say [--apply] "<instruction>"
  npm run cli -- params
  npm run cli -- presets

Writes the fabrication bundle (part and sheet DXFs, moulds, model.stl, cutlist.csv,
price-estimate.txt, price-estimate.json, build-pack.html, project.strata.json) into <dir>.
--zip writes the same files as one zip (with or without --out). --date sets the date printed in
the build pack and stamped on every file, so the zip is the same bytes on every run; the cloud
pack job (Boost) makes its zip exactly this way. --glb also writes model.glb, the file Blender renders
for a hero render, with the 3D view's opening Iso camera (render it with worker/hero_render.py).
A project may set "preset"; parameters in the file override the preset. --preset does the same.
--size sets the base outline from a master size preset (${SIZE_HELP}); fixed sizes use real mm,
ratio sizes keep the current long edge. Only the outline changes (thickness and plate count stay).
--orientation is portrait (default) or landscape. Applied after the project file and --preset.
--image replaces the side, front or top picture. --rates overrides price-estimate rates.
--auto-dimension sets plate proportions from metric depth on each face (repeat or comma list:
side, front, top). Needs depth data on that image. --relief-exaggeration scales relief (default 1).
--flat-level / --edge-ease / --step-limit / --flat-negative shape IMAGE depth maps only (never map
faces): flatten everything at or beyond a background level onto a plate, with optional edge falloff
and a max step between adjacent plates. Default is off. Map faces stay real metres × exaggeration.
--map with --bbox fetches open terrain into the top face DepthData (auto picks UK LiDAR where catalogued).
Regional LiDAR adapters use offline fixtures in tests; production COG/WMS reads are stubbed until later tickets.
Unimplemented explicit sources fall back to terrarium with a warning. --engrave is stored
on the MapSpec (default on); engraving is a no-op until a later release.
say parses plain-language design instructions (same rules as the in-app Type a design box),
prints the parameter diff and any unrecognised phrases. --apply writes the updated project JSON to stdout.
Unknown parameters, formula errors, and remaining fit-check errors exit 1 and write nothing. Clamped values are warnings.
`;

type Slot = 'side' | 'front' | 'top';

interface Args {
  cmd: 'export' | 'params' | 'presets' | 'help' | 'say';
  project?: string;
  out?: string;
  zip?: string;
  glb?: string;
  date?: string;
  preset?: string;
  images: Partial<Record<Slot, string>>;
  rates?: string;
  size?: string;
  orientation?: string;
  sayText?: string;
  sayApply?: boolean;
  render?: string;
  autoDimension: DepthFace[];
  reliefExaggeration: number;
  flat?: FlatCliPatch;
  mapPreset?: string;
  map?: {
    title?: string;
    bbox?: string;
    source: MapSpec['source'];
    resM: number;
    exaggeration: MapSpec['exaggeration'];
    engrave: MapSpec['engrave'];
    cacheDir?: string;
    layerBudget?: MapSpec['layerBudget'];
    editionNumber?: number;
    archetypeCard?: Record<string, unknown>;
    commemorativeText?: string;
  };
}

function take(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v == null || v.startsWith('--')) throw new Error(`missing value for ${flag}`);
  return v;
}

const FACES = new Set<DepthFace>(['side', 'front', 'top']);

function parseAutoDimension(spec: string, faces: DepthFace[]) {
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    const face = (eq > 0 ? part.slice(0, eq) : part) as DepthFace;
    if (!FACES.has(face)) throw new Error(`--auto-dimension: unknown face '${face}' (use side, front or top)`);
    if (!faces.includes(face)) faces.push(face);
  }
}

function idleArgs(cmd: Args['cmd']): Args {
  return { cmd, images: {}, autoDimension: [], reliefExaggeration: 1 };
}

function newExportArgs(project: string): Args {
  return {
    cmd: 'export',
    project,
    images: {},
    autoDimension: [],
    reliefExaggeration: 1,
    map: { source: 'auto', resM: 0, exaggeration: 'auto', engrave: parseEngraveFlag(undefined, true) },
  };
}

function parseSay(argv: string[]): Args {
  if (argv.length < 2) throw new Error(`say needs a project file and instruction\n\n${USAGE}`);
  const project = argv[0] === 'say' ? argv[1] : argv[0];
  const rest = argv[0] === 'say' ? argv.slice(2) : argv.slice(1);
  let sayApply = false;
  const textParts: string[] = [];
  for (const a of rest) {
    if (a === 'say') continue;
    if (a === '--apply') sayApply = true;
    else if (a.startsWith('--')) throw new Error(`unknown argument '${a}'`);
    else textParts.push(a);
  }
  const sayText = textParts.join(' ').trim();
  if (!sayText) throw new Error(`missing instruction text\n\n${USAGE}`);
  return { ...idleArgs('say'), project, sayText, sayApply };
}

function parseImage(spec: string, images: Args['images']) {
  const eq = spec.indexOf('=');
  if (eq <= 0) throw new Error('--image expects side=path, front=path or top=path');
  const slot = spec.slice(0, eq);
  const path = spec.slice(eq + 1);
  if (slot !== 'side' && slot !== 'front' && slot !== 'top') throw new Error(`unknown image slot '${slot}'`);
  if (!path) throw new Error(`--image ${slot} is missing a path`);
  images[slot] = path;
}

function parseDate(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new Error(`--date expects YYYY-MM-DD, got '${s}'`);
  return s;
}

function parseArgs(argv: string[]): Args {
  if (argv.length === 0) throw new Error(`missing project file\n\n${USAGE}`);
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') return idleArgs('help');
  if (argv[0] === 'params' || argv[0] === 'presets') {
    if (argv.length > 1) throw new Error(`unexpected argument '${argv[1]}'`);
    return idleArgs(argv[0]);
  }
  if (argv[0] === 'say' || (argv.length >= 2 && argv[1] === 'say')) return parseSay(argv);
  const args: Args = newExportArgs(argv[0]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--zip') args.zip = take(argv, ++i, a);
    else if (a.startsWith('--zip=')) args.zip = a.slice(6);
    else if (a === '--glb') args.glb = take(argv, ++i, a);
    else if (a.startsWith('--glb=')) args.glb = a.slice(6);
    else if (a === '--date') args.date = parseDate(take(argv, ++i, a));
    else if (a.startsWith('--date=')) args.date = parseDate(a.slice(7));
    else if (a === '--out') args.out = take(argv, ++i, a);
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (a === '--preset') args.preset = take(argv, ++i, a);
    else if (a.startsWith('--preset=')) args.preset = a.slice(9);
    else if (a === '--rates') args.rates = take(argv, ++i, a);
    else if (a.startsWith('--rates=')) args.rates = a.slice(8);
    else if (a === '--image') parseImage(take(argv, ++i, a), args.images);
    else if (a.startsWith('--image=')) parseImage(a.slice(8), args.images);
    else if (a === '--size') args.size = take(argv, ++i, a);
    else if (a.startsWith('--size=')) args.size = a.slice(7);
    else if (a === '--orientation') args.orientation = take(argv, ++i, a);
    else if (a.startsWith('--orientation=')) args.orientation = a.slice(14);
    else if (a === '--auto-dimension') parseAutoDimension(take(argv, ++i, a), args.autoDimension);
    else if (a.startsWith('--auto-dimension=')) parseAutoDimension(a.slice(17), args.autoDimension);
    else if (a === '--relief-exaggeration') args.reliefExaggeration = Number(take(argv, ++i, a));
    else if (a.startsWith('--relief-exaggeration=')) args.reliefExaggeration = Number(a.slice(22));
    else if (a === '--flat-level') (args.flat ??= {}).flatLevel = parseFlatLevelFlag(take(argv, ++i, a));
    else if (a.startsWith('--flat-level=')) (args.flat ??= {}).flatLevel = parseFlatLevelFlag(a.slice(13));
    else if (a === '--edge-ease') (args.flat ??= {}).edgeEase = parse01Flag(take(argv, ++i, a), '--edge-ease');
    else if (a.startsWith('--edge-ease=')) (args.flat ??= {}).edgeEase = parse01Flag(a.slice(12), '--edge-ease');
    else if (a === '--step-limit') (args.flat ??= {}).stepLimit = parse01Flag(take(argv, ++i, a), '--step-limit');
    else if (a.startsWith('--step-limit=')) (args.flat ??= {}).stepLimit = parse01Flag(a.slice(13), '--step-limit');
    else if (a === '--flat-negative') (args.flat ??= {}).flatNegative = true;
    else if (a.startsWith('--flat-negative=')) (args.flat ??= {}).flatNegative = parseBoolFlag(a.slice(16), '--flat-negative');
    else if (a === '--map-preset') args.mapPreset = take(argv, ++i, a);
    else if (a.startsWith('--map-preset=')) args.mapPreset = a.slice(13);
    else if (a === '--map') args.map!.title = take(argv, ++i, a);
    else if (a.startsWith('--map=')) args.map!.title = a.slice(6);
    else if (a === '--bbox') args.map!.bbox = take(argv, ++i, a);
    else if (a.startsWith('--bbox=')) args.map!.bbox = a.slice(7);
    else if (a === '--map-source') args.map!.source = parseMapSource(take(argv, ++i, a));
    else if (a.startsWith('--map-source=')) args.map!.source = parseMapSource(a.slice(13));
    else if (a === '--map-res') args.map!.resM = Number(take(argv, ++i, a));
    else if (a.startsWith('--map-res=')) args.map!.resM = Number(a.slice(10));
    else if (a === '--exaggeration') args.map!.exaggeration = parseExaggeration(take(argv, ++i, a));
    else if (a.startsWith('--exaggeration=')) args.map!.exaggeration = parseExaggeration(a.slice(15));
    else if (a === '--layer-budget') args.map!.layerBudget = parseLayerBudget(take(argv, ++i, a));
    else if (a.startsWith('--layer-budget=')) args.map!.layerBudget = parseLayerBudget(a.slice(15));
    else if (a === '--engrave') args.map!.engrave = parseEngraveFlag(take(argv, ++i, a), true);
    else if (a.startsWith('--engrave=')) args.map!.engrave = parseEngraveFlag(a.slice(10), true);
    else if (a === '--map-cache') args.map!.cacheDir = take(argv, ++i, a);
    else if (a.startsWith('--map-cache=')) args.map!.cacheDir = a.slice(12);
    else if (a === '--map-edition') args.map!.editionNumber = Number(take(argv, ++i, a));
    else if (a.startsWith('--map-edition=')) args.map!.editionNumber = Number(a.slice(14));
    else if (a === '--archetype-card') {
      const path = take(argv, ++i, a);
      args.map!.archetypeCard = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } else if (a.startsWith('--archetype-card=')) {
      args.map!.archetypeCard = JSON.parse(readFileSync(a.slice(16), 'utf8')) as Record<string, unknown>;
    } else if (a === '--commemorative') args.map!.commemorativeText = take(argv, ++i, a);
    else if (a.startsWith('--commemorative=')) args.map!.commemorativeText = a.slice(14);
    else if (a === '--render') args.render = take(argv, ++i, a);
    else if (a.startsWith('--render=')) args.render = a.slice(9);
    else if (a === '--help' || a === '-h') return idleArgs('help');
    else throw new Error(`unknown argument '${a}'`);
  }
  if (!args.out && !args.zip) throw new Error(`missing --out <dir> or --zip <file>\n\n${USAGE}`);
  if (args.mapPreset) parseMapPresetId(args.mapPreset);
  if (args.map?.bbox == null && args.map?.title && !args.mapPreset) throw new Error('--map requires --bbox west,south,east,north');
  if ((args.map?.bbox != null || args.mapPreset) && args.map && !args.map.title && !args.mapPreset) args.map.title = 'Map terrain';
  return args;
}

export { parseArgs as parseCliArgs };

/** Project file plus preset / --preset. Explicit params win. Unknown ids are reported, not dropped. */
export function loadProject(text: string, opts: { preset?: string } = {}): { project: Project; issues: CliIssue[] } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  if (!raw || raw.format !== 'strata-project') throw new Error('Not a Strata project file');
  const issues: CliIssue[] = [];
  let presetName = opts.preset;
  if (presetName == null && raw.preset != null) {
    if (typeof raw.preset !== 'string') issues.push({ level: 'error', message: 'preset must be a string' });
    else presetName = raw.preset;
  }
  let presetParams: Record<string, RawValue> = {};
  if (presetName) {
    const preset = PRESETS.find((p) => p.name === presetName);
    if (!preset) issues.push({ level: 'error', message: `unknown preset '${presetName}'` });
    else presetParams = preset.params;
  }
  if (raw.params != null && (typeof raw.params !== 'object' || Array.isArray(raw.params))) throw new Error('params must be an object');
  const explicit = (raw.params ?? {}) as Record<string, RawValue>;
  for (const id of Object.keys(explicit)) {
    if (!PARAM_MAP[id]) issues.push({ level: 'error', message: `unknown parameter '${id}'` });
  }
  const params: Record<string, RawValue> = { ...defaultRaw(), ...presetParams };
  for (const [id, val] of Object.entries(explicit)) if (PARAM_MAP[id]) params[id] = val;
  for (const p of PARAMS) {
    if (p.kind !== 'choice' || !p.options) continue;
    const v = String(params[p.id] ?? p.def);
    if (!p.options.some((o) => o.value === v)) issues.push({ level: 'error', message: `${p.id}: unknown choice '${v}'` });
  }
  const project = deserialize(text);
  project.params = params;
  if ((raw.name == null || raw.name === '') && presetName && PRESETS.some((p) => p.name === presetName)) project.name = presetName;
  return { project, issues };
}

/** Apply --size / --orientation after the project file and preset are merged. */
/** Apply --auto-dimension for each face that has metric depth on the project image. */
export function applyAutoDimensionCli(project: Project, faces: DepthFace[], reliefExaggeration = 1): CliIssue[] {
  const issues: CliIssue[] = [];
  let params = project.params;
  for (const face of faces) {
    const asset = project.images[face];
    const preview = previewAutoDimension(face, asset?.depth, params, { reliefExaggeration });
    if (!preview.ok) {
      issues.push({ level: 'warning', message: `auto-dimension ${face}: ${preview.reason ?? 'failed'}` });
      continue;
    }
    for (const id of preview.clamped) {
      issues.push({ level: 'warning', message: `auto-dimension ${face}: ${id} was clamped` });
    }
    params = applyAutoDimensionPatch(params, preview);
  }
  project.params = params;
  return issues;
}

/** Patch IMAGE depth faces only. Map faces keep real metres × exaggeration. */
export function applyFlatLevelCli(project: Project, patch: FlatCliPatch): CliIssue[] {
  const issues: CliIssue[] = [];
  let applied = 0;
  for (const slot of ['side', 'front', 'top'] as const) {
    const asset = project.images[slot];
    if (!asset?.depth) continue;
    if (isMapDepthFace(asset.depth) || asset.map) {
      issues.push({ level: 'warning', message: `flat-level skipped on ${slot}: map faces use real metres × exaggeration` });
      continue;
    }
    try {
      asset.depth = { ...asset.depth, settings: applyFlatCliPatch(asset.depth.settings, patch) };
      applied++;
    } catch (e) {
      issues.push({ level: 'error', message: (e as Error).message });
    }
  }
  if (!applied) issues.push({ level: 'warning', message: 'flat-level: no image depth-map faces to apply' });
  return issues;
}

export function applyMasterSizeCli(
  project: Project,
  size: string,
  orientation?: string,
): void {
  const next = applyProjectPatch(project, masterSizePatch(size, orientation));
  project.params = next.params;
  if (next.name !== project.name) project.name = next.name;
}

function evalIssues(ev: EvalResult): CliIssue[] {
  const issues: CliIssue[] = [];
  for (const [id, msg] of Object.entries(ev.errors)) issues.push({ level: 'error', message: `${id}: ${msg}` });
  for (const id of Object.keys(ev.clamped)) {
    const d = PARAM_MAP[id];
    issues.push({ level: 'warning', message: `${id} was clamped to ${ev.values[id]} (range ${d.min}..${d.max})` });
  }
  return issues;
}

function writeBundle(dir: string, zip: Uint8Array): Record<string, Uint8Array> {
  const files = unzipSync(zip);
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    const path = resolve(root, name);
    if (path !== root && !path.startsWith(root + sep)) throw new Error(`Refusing to write '${name}'`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  return files;
}

function report(issues: CliIssue[], io: CliIo) {
  for (const i of issues) io.stderr(`${i.level}: ${i.message}\n`);
}

export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.stderr(`error: ${(e as Error).message}\n`);
    return 1;
  }
  if (args.cmd === 'help') {
    io.stdout(USAGE);
    return 0;
  }
  if (args.cmd === 'params') {
    io.stdout(JSON.stringify(paramCatalog(), null, 2) + '\n');
    return 0;
  }
  if (args.cmd === 'presets') {
    io.stdout(JSON.stringify(presetCatalog(), null, 2) + '\n');
    return 0;
  }
  if (args.cmd === 'say') {
    try {
      const text = readFileSync(args.project!, 'utf8');
      const { project, issues } = loadProject(text);
      if (issues.some((i) => i.level === 'error')) {
        report(issues, io);
        return 1;
      }
      const parsed = parseDesign(args.sayText!, { project });
      io.stdout(formatPatchDiff(project, parsed.patch) + '\n');
      if (parsed.unrecognised.length) {
        const bits = parsed.unrecognised.map((s) => args.sayText!.slice(s.start, s.end));
        io.stdout(`unrecognised: ${bits.join('; ')}\n`);
      }
      if (parsed.notes.length) io.stderr(`note: ${parsed.notes.join('; ')}\n`);
      if (args.sayApply) {
        const updated = applyProjectPatch(project, parsed.patch);
        io.stdout(serialize(updated) + '\n');
      }
      return 0;
    } catch (e) {
      io.stderr(`error: ${(e as Error).message}\n`);
      return 1;
    }
  }
  try {
    const text = readFileSync(args.project!, 'utf8');
    const { project, issues } = loadProject(text, { preset: args.preset });
    if (args.size) {
      try {
        applyMasterSizeCli(project, args.size, args.orientation);
      } catch (e) {
        io.stderr(`error: ${(e as Error).message}\n`);
        return 1;
      }
    } else if (args.orientation) {
      io.stderr('error: --orientation requires --size\n');
      return 1;
    }
    if (args.autoDimension.length) {
      issues.push(...applyAutoDimensionCli(project, args.autoDimension, args.reliefExaggeration));
    }
    if (args.flat) issues.push(...applyFlatLevelCli(project, args.flat));
    let rates = DEFAULT_RATES;
    if (args.rates) rates = readRates(readFileSync(args.rates, 'utf8'));
    if (issues.some((i) => i.level === 'error')) {
      report(issues, io);
      return 1;
    }
    if (args.mapPreset || args.map?.bbox) {
      try {
        const preset = args.mapPreset ? mapPresetSpec(args.mapPreset) : null;
        const bbox = args.map?.bbox ? parseBbox(args.map.bbox) : preset!.bbox;
        const spec = mapSpecFromCli({
          title: args.map?.title ?? preset?.title,
          bbox,
          source: args.map?.source ?? preset?.source ?? 'auto',
          resM: args.map && args.map.resM > 0 ? args.map.resM : preset?.resM ?? 0,
          exaggeration: args.map?.exaggeration ?? preset?.exaggeration ?? 'auto',
          engrave: args.map?.engrave ?? preset?.engrave ?? { enabled: true, features: ['roads', 'water', 'title'] },
          cacheDir: args.map?.cacheDir ?? preset?.cacheDir,
          layerBudget: args.map?.layerBudget ?? preset?.layerBudget,
          editionNumber: args.map?.editionNumber ?? preset?.editionNumber,
          archetypeCard: args.map?.archetypeCard ?? preset?.archetypeCard,
          commemorativeText: args.map?.commemorativeText ?? preset?.commemorativeText,
        });
        const bundle = await buildMapBundle(spec, {
          stack: mapStackFromProject(project, args.map?.layerBudget ?? preset?.layerBudget),
          allowOverpassNetwork: true,
        });
        project.images.top = bundle.asset;
        if (args.map?.title) project.name = args.map.title;
        if (args.render) {
          writeFileSync(args.render, renderVenueMockup({ elevation: bundle.elevation, depth: bundle.depth, title: spec.title }));
        }
      } catch (e) {
        if (e instanceof MapSourceNotImplementedError) {
          io.stderr(`error: ${e.message}\n`);
          return 1;
        }
        io.stderr(`error: ${(e as Error).message}\n`);
        return 1;
      }
    }
    const assets = await loadAssets(project, args.images);
    const model = createPipeline()(project, assets);
    issues.push(...evalIssues(model.ev));
    if (issues.some((i) => i.level === 'error')) {
      report(issues, io);
      return 1;
    }
    const zip = buildZip(model, project, rates, { date: args.date ? new Date(`${args.date}T00:00:00Z`) : undefined });
    // the zip or model may go inside --out, which isn't made yet
    const writeMaking = (path: string, data: Uint8Array) => {
      mkdirSync(dirname(resolve(path)), { recursive: true });
      writeFileSync(path, data);
    };
    if (args.zip) writeMaking(args.zip, zip);
    if (args.glb) {
      const scene = heroScene(model, project);
      writeMaking(args.glb, heroGlb(scene, defaultHeroCamera(scene)));
    }
    const files = args.out ? writeBundle(args.out, zip) : unzipSync(zip);
    report(issues, io);
    const parts = Object.keys(files).filter((n) => n.startsWith('laser/parts/') && n.endsWith('.dxf')).length;
    const sheets = Object.keys(files).filter((n) => n.startsWith('laser/sheets/') && n.endsWith('.dxf')).length;
    const moulds = Object.keys(files).filter((n) => n.startsWith('mould/dxf/') && n.endsWith('.dxf')).length;
    const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
    io.stdout(`wrote ${n(parts, 'part')}, ${n(sheets, 'sheet')}, ${n(moulds, 'mould part')} to ${[args.out, args.zip].filter(Boolean).join(' and ')}\n`);
    return 0;
  } catch (e) {
    io.stderr(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

const entry = process.argv[1];
// only when run as the CLI itself, not when bundled into another entry (the cloud worker imports main)
if (entry && /(^|[\\/])cli\.(ts|js|mjs)$/.test(entry) && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
