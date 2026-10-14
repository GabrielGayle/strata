// The project file: parameters + pour plan + source assets, as one readable JSON.
import { defaultRaw, PARAM_MAP, type RawValue } from './params';
import type { PourLayer } from './mould';

export interface ImageAsset {
  name: string;
  dataUrl: string;
}

export interface MeshAsset {
  name: string;
  format: 'stl' | 'obj';
  /** base64 of the original file */
  data: string;
}

export interface Variant {
  id: string;
  name: string;
  params: Record<string, RawValue>;
  locks: Record<string, boolean>;
  pour: PourLayer[];
  createdAt: string;
}

export interface Project {
  format: 'strata-project';
  version: 1;
  name: string;
  params: Record<string, RawValue>;
  locks: Record<string, boolean>;
  pour: PourLayer[];
  images: { side?: ImageAsset; front?: ImageAsset; top?: ImageAsset };
  meshes: { ins?: MeshAsset; src?: MeshAsset };
  variants: Variant[];
}

export const DEFAULT_POUR: PourLayer[] = [
  { id: 'p1', name: 'Bottom band', height: 'baseHeight * 0.35', color: '#9c4a2e' },
  { id: 'p2', name: 'Middle band', height: 'baseHeight * 0.3', color: '#d08b5b' },
  { id: 'p3', name: 'Top band', height: 'baseHeight * 0.35', color: '#e8d6bb' },
];

export function newProject(): Project {
  return {
    format: 'strata-project',
    version: 1,
    name: 'Vermilion 40',
    params: defaultRaw(),
    locks: {},
    pour: DEFAULT_POUR.map((p) => ({ ...p })),
    images: {},
    meshes: {},
    variants: [],
  };
}

export interface Preset {
  name: string;
  note: string;
  params: Record<string, RawValue>;
}

export const PRESETS: Preset[] = [
  { name: 'Vermilion 40', note: '40 eroded corten plates, central fin, 3-band pour', params: {} },
  {
    name: 'Radial bloom',
    note: 'Radial plates around a cone',
    params: {
      sliceMode: 'radial', radialCount: '28', radialHub: '40', baseLength: '600', baseWidth: '600', insShape: 'cone', insWidth: '120',
      insHeight: '420', insTaper: '0.15', insSweep: '0', stackHeight: '180', crest: '90', coherence: '0.6',
    },
  },
  {
    name: 'Waffle field',
    note: 'Interlocking grid, no insert',
    params: { sliceMode: 'waffle', insShape: 'none', plateCount: '14', crossCount: '5', stackHeight: '160', erosionAmp: '35', banding: '0.8', thickness: '6' },
  },
  {
    name: 'Sliced vessel',
    note: 'A revolved form sliced into 30 plates',
    params: { stackSource: 'form', srcShape: 'revolve', srcWidth: '240', srcHeight: '320', srcTaper: '0.55', srcCamber: '70', plateCount: '30', pitch: '(srcWidth - 16) / (plateCount - 1)', insShape: 'none', baseWidth: '420', baseLength: '420', embedDepth: '30' },
  },
  {
    name: 'Stamped stack',
    note: 'Plates laid flat face to face; a top image presses down through the layers',
    params: {
      sliceMode: 'flat', plateCount: '20', insShape: 'none', thickness: '3', stackHeight: '60', erosionAmp: '4', crest: '0', slope: '0', baseLength: '520', baseWidth: '380', baseHeight: '60',
      endMargin: '30', sideMargin: '30', imgTopMode: 'carve', topDepth: '45', topSteps: '0', topFloor: 'flat', topMargin: '25',
    },
  },
  {
    name: 'Image cliff',
    note: 'Side profile + front cut-outs from an image',
    params: { imgSideMode: 'heightmap', imgMix: '0.7', imgFrontMode: 'layers', etchMode: 'hatch', insShape: 'none', plateCount: '48', thickness: '1.5' },
  },
];

export function applyPreset(p: Project, preset: Preset): Project {
  return { ...p, name: preset.name, params: { ...defaultRaw(), ...preset.params }, locks: {} };
}

export function serialize(p: Project): string {
  return JSON.stringify(p, null, 2);
}

export function deserialize(text: string): Project {
  const raw = JSON.parse(text);
  if (!raw || raw.format !== 'strata-project') throw new Error('Not a Strata project file');
  const base = newProject();
  const params = { ...base.params };
  for (const [k, val] of Object.entries(raw.params ?? {})) if (PARAM_MAP[k]) params[k] = val as RawValue;
  return {
    ...base,
    name: String(raw.name ?? 'Untitled'),
    params,
    locks: raw.locks ?? {},
    pour: Array.isArray(raw.pour) ? raw.pour : base.pour,
    images: raw.images ?? {},
    meshes: raw.meshes ?? {},
    variants: Array.isArray(raw.variants) ? raw.variants : [],
  };
}
