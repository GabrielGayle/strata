// Node side of an export: decode a project's assets and make the fabrication zip.
// Shared by the CLI (`cli export`) and the cloud pack job (worker/job.ts), so the
// two give the same bytes for the same project at the same commit.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { buildZip } from './core/exporters';
import { decodeImage, setNodeImageDecoder } from './core/image';
import { decodeImageNode } from './core/imageNode';
import { depthToGray } from './core/depth';
import { createPipeline, type Assets, type DeferredOptions, type Model } from './core/pipeline';
import { DEFAULT_RATES, type PriceRates } from './core/price';
import { isSupplierId, SUPPLIER_IDS } from './core/suppliers';
import type { ImageAsset, MeshAsset, Project } from './core/project';

setNodeImageDecoder(decodeImageNode);

export type Slot = 'side' | 'front' | 'top';

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

/** Decode a project's images, meshes and shadow frames the way the CLI always has; `images` swaps in files for slots. */
export async function loadAssets(project: Project, images: Partial<Record<Slot, string>> = {}): Promise<Assets> {
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


const RATE_KEYS = ['perKg', 'waste', 'machinePerHour', 'setup', 'perPart', 'minimum', 'vat', 'hardware', 'supplier', 'includeEtch', 'labour'] as const;

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
  if (obj.supplier != null) {
    if (!isSupplierId(obj.supplier)) throw new Error(`Rate supplier must be one of ${SUPPLIER_IDS.join(', ')}`);
    rates.supplier = obj.supplier;
  }
  if (obj.includeEtch != null) {
    if (typeof obj.includeEtch !== 'boolean') throw new Error('Rate includeEtch must be true or false');
    rates.includeEtch = obj.includeEtch;
  }
  if (obj.labour != null) {
    if (typeof obj.labour !== 'object' || Array.isArray(obj.labour)) throw new Error('Rate labour must be an object');
    const lab = obj.labour as Record<string, unknown>;
    for (const k of Object.keys(lab)) {
      if (k !== 'days' && k !== 'dayRate') throw new Error(`unknown rate 'labour.${k}'`);
    }
    rates.labour = { ...DEFAULT_RATES.labour!, ...rates.labour };
    for (const k of ['days', 'dayRate'] as const) if (k in lab) rates.labour[k] = numField(lab[k], `labour.${k}`);
  }
  return rates;
}

export interface PackOptions {
  rates: PriceRates;
  /** Date printed in the build pack and stamped on every file in the zip. */
  date: Date;
  deferred?: DeferredOptions;
}

/** Build the whole model and the fabrication zip. Throws on a fit error, as the app's export does. */
export function packZip(project: Project, assets: Assets, opts: PackOptions): { zip: Uint8Array; model: Model } {
  const model = createPipeline(opts.deferred)(project, assets);
  return { zip: buildZip(model, project, opts.rates, { date: opts.date }), model };
}
