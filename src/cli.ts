// Headless export: the same fabrication files as the app, from a project JSON.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { buildZip } from './core/exporters';
import { decodeImage, setNodeImageDecoder } from './core/image';
import { decodeImageNode } from './core/imageNode';
import { depthToGray } from './core/depth';
import { createPipeline, type Assets } from './core/pipeline';
import { defaultRaw, PARAMS, PARAM_MAP, type EvalResult, type ParamKind, type RawValue } from './core/params';
import { DEFAULT_RATES, type PriceRates } from './core/price';
import { deserialize, PRESETS, type ImageAsset, type MeshAsset, type Project } from './core/project';

export interface CliIssue {
  level: 'error' | 'warning';
  message: string;
}

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

setNodeImageDecoder(decodeImageNode);

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

const USAGE = `Usage:
  npm run cli -- <project.json> --out <dir> [--preset <name>] [--image side=path.jpg] [--rates rates.json]
  npm run cli -- params
  npm run cli -- presets

Writes the fabrication bundle (part and sheet DXFs, moulds, model.stl, cutlist.csv,
price-estimate.txt, price-estimate.json, build-pack.html, project.strata.json) into <dir>.
A project may set "preset"; parameters in the file override the preset. --preset does the same.
--image replaces the side, front or top picture. --rates overrides price-estimate rates.
Unknown parameters and formula errors exit 1 and write nothing. Clamped values are warnings.
`;

type Slot = 'side' | 'front' | 'top';

interface Args {
  cmd: 'export' | 'params' | 'presets' | 'help';
  project?: string;
  out?: string;
  preset?: string;
  images: Partial<Record<Slot, string>>;
  rates?: string;
}

function take(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v == null || v.startsWith('--')) throw new Error(`missing value for ${flag}`);
  return v;
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

function parseArgs(argv: string[]): Args {
  if (argv.length === 0) throw new Error(`missing project file\n\n${USAGE}`);
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') return { cmd: 'help', images: {} };
  if (argv[0] === 'params' || argv[0] === 'presets') {
    if (argv.length > 1) throw new Error(`unexpected argument '${argv[1]}'`);
    return { cmd: argv[0], images: {} };
  }
  const args: Args = { cmd: 'export', project: argv[0], images: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = take(argv, ++i, a);
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (a === '--preset') args.preset = take(argv, ++i, a);
    else if (a.startsWith('--preset=')) args.preset = a.slice(9);
    else if (a === '--rates') args.rates = take(argv, ++i, a);
    else if (a.startsWith('--rates=')) args.rates = a.slice(8);
    else if (a === '--image') parseImage(take(argv, ++i, a), args.images);
    else if (a.startsWith('--image=')) parseImage(a.slice(8), args.images);
    else if (a === '--help' || a === '-h') return { cmd: 'help', images: {} };
    else throw new Error(`unknown argument '${a}'`);
  }
  if (!args.out) throw new Error(`missing --out <dir>\n\n${USAGE}`);
  return args;
}

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

function evalIssues(ev: EvalResult): CliIssue[] {
  const issues: CliIssue[] = [];
  for (const [id, msg] of Object.entries(ev.errors)) issues.push({ level: 'error', message: `${id}: ${msg}` });
  for (const id of Object.keys(ev.clamped)) {
    const d = PARAM_MAP[id];
    issues.push({ level: 'warning', message: `${id} was clamped to ${ev.values[id]} (range ${d.min}..${d.max})` });
  }
  return issues;
}

const RATE_KEYS = ['perKg', 'waste', 'machinePerHour', 'setup', 'perPart', 'minimum', 'vat', 'hardware'] as const;

function numField(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Rate ${name} must be a finite number`);
  return v;
}

export function readRates(text: string): PriceRates {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid rates JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Rates file must be a JSON object');
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!(RATE_KEYS as readonly string[]).includes(k)) throw new Error(`unknown rate '${k}'`);
  }
  const rates: PriceRates = {
    ...DEFAULT_RATES,
    perKg: { ...DEFAULT_RATES.perKg },
    hardware: { ...DEFAULT_RATES.hardware },
  };
  for (const k of ['waste', 'machinePerHour', 'setup', 'perPart', 'minimum', 'vat'] as const) {
    if (k in obj) rates[k] = numField(obj[k], k);
  }
  if (obj.perKg != null) {
    if (typeof obj.perKg !== 'object' || Array.isArray(obj.perKg)) throw new Error('Rate perKg must be an object');
    for (const [metal, v] of Object.entries(obj.perKg as Record<string, unknown>)) rates.perKg[metal] = numField(v, `perKg.${metal}`);
  }
  if (obj.hardware != null) {
    if (typeof obj.hardware !== 'object' || Array.isArray(obj.hardware)) throw new Error('Rate hardware must be an object');
    const hw = obj.hardware as Record<string, unknown>;
    for (const k of Object.keys(hw)) {
      if (k !== 'rodPerM' && k !== 'nut' && k !== 'washer') throw new Error(`unknown rate 'hardware.${k}'`);
    }
    for (const k of ['rodPerM', 'nut', 'washer'] as const) if (k in hw) rates.hardware[k] = numField(hw[k], `hardware.${k}`);
  }
  return rates;
}

function mimeOf(file: string, buf: Uint8Array): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  const ext = extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function fileToDataUrl(file: string): string {
  const buf = readFileSync(file);
  return `data:${mimeOf(file, buf)};base64,${buf.toString('base64')}`;
}

async function imageOf(slot: Slot, asset: ImageAsset | undefined, override?: string) {
  try {
    if (override) return await decodeImage(fileToDataUrl(override));
    if (asset?.depth) return depthToGray(asset.depth);
    if (asset?.dataUrl) return await decodeImage(asset.dataUrl);
    return null;
  } catch (e) {
    throw new Error(`${slot} image: ${(e as Error).message}`);
  }
}

async function meshOf(asset: MeshAsset | undefined) {
  if (!asset) return null;
  const { parseMesh } = await import('./state/assets');
  return parseMesh(asset);
}

async function loadAssets(project: Project, images: Partial<Record<Slot, string>>): Promise<Assets> {
  const assets: Assets = {
    sideImg: await imageOf('side', project.images.side, images.side),
    frontImg: await imageOf('front', project.images.front, images.front),
    topImg: await imageOf('top', project.images.top, images.top),
    insMesh: await meshOf(project.meshes.ins),
    srcMesh: await meshOf(project.meshes.src),
  };
  const frames = project.shadow?.frames;
  if (frames?.length) {
    assets.shadowFrames = await Promise.all(frames.map((f) => decodeImage(f.dataUrl)));
  }
  return assets;
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
  try {
    const text = readFileSync(args.project!, 'utf8');
    const { project, issues } = loadProject(text, { preset: args.preset });
    let rates = DEFAULT_RATES;
    if (args.rates) rates = readRates(readFileSync(args.rates, 'utf8'));
    if (issues.some((i) => i.level === 'error')) {
      report(issues, io);
      return 1;
    }
    const assets = await loadAssets(project, args.images);
    const model = createPipeline()(project, assets);
    issues.push(...evalIssues(model.ev));
    if (issues.some((i) => i.level === 'error')) {
      report(issues, io);
      return 1;
    }
    const files = writeBundle(args.out!, buildZip(model, project, rates));
    report(issues, io);
    const parts = Object.keys(files).filter((n) => n.startsWith('laser/parts/') && n.endsWith('.dxf')).length;
    const sheets = Object.keys(files).filter((n) => n.startsWith('laser/sheets/') && n.endsWith('.dxf')).length;
    const moulds = Object.keys(files).filter((n) => n.startsWith('mould/dxf/') && n.endsWith('.dxf')).length;
    const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
    io.stdout(`wrote ${n(parts, 'part')}, ${n(sheets, 'sheet')}, ${n(moulds, 'mould part')} to ${args.out}\n`);
    return 0;
  } catch (e) {
    io.stderr(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
