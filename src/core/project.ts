// The project file: parameters + pour plan + source assets, as one readable JSON.
import { defaultRaw, PARAM_MAP, type RawValue } from './params';
import type { PourLayer } from './mould';
import type { PatternSpec } from './pattern';
import type { Composition } from './compose';
import type { SoundSpec } from './sound';

export interface ImageAsset {
  name: string;
  dataUrl: string;
  /** Set when the image is a generated graphic, so it can be reopened and edited. */
  pattern?: PatternSpec;
  /** Set when the image is rendered from the composer (project.composition). */
  composed?: boolean;
  /** Set when the image is drawn from a sound, so it can be reopened and edited. */
  sound?: SoundSpec;
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
  /** Image blocks placed on the surfaces; each used surface is also rendered into images[surface]. */
  composition?: Composition;
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
  /** Listed under "Small (under 10 cm)" in the Presets menu. */
  small?: boolean;
}

/**
 * Shared settings for tabletop pieces under 100 mm. Stock and tolerances that
 * Master size never touches (ply, dowels, labels, min part size) drop to
 * what a small laser-cut mould and a hand-held part can use; the base keeps
 * at least 8 mm of concrete under the plates and room for one anchor hole.
 */
const SMALL: Record<string, RawValue> = {
  baseHeight: '18',
  thickness: '1.5',
  endMargin: '6',
  sideMargin: '5',
  embedDepth: '10',
  anchorHoles: '1',
  anchorDia: '3',
  sampleStep: '0.5',
  bandHeight: '3',
  clearance: '0.3',
  slotGap: '0.3',
  slotClearance: '0.1',
  minFeature: '1',
  minPartSize: '5',
  partSpacing: '3',
  labelHeight: '3',
  plyThickness: '3',
  mouldWall: '6',
  dowelDia: '3',
  tabsPerSide: '1',
  tabSize: '12',
  jigClearance: '0.15',
  // the embedded support ring, if switched on, stays inside the small base
  supportOuter: 'min(baseLength, baseWidth)/2 - sideMargin - 4',
  supportDepth: 'embedDepth',
  supportLand: '3',
};

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
  {
    name: 'Mini Vermilion',
    note: '90 × 40 mm, 14 plates around a small fin',
    small: true,
    params: {
      ...SMALL, baseLength: '90', baseWidth: '40', plateCount: '14', stackHeight: '50', erosionAmp: '8', erosionScale: '35', crest: '6',
      insLength: '58', insWidth: '8', insHeight: '62', insSweep: '12', insCamber: '3', insBend: '3',
    },
  },
  {
    name: 'Mini radial',
    note: '80 mm round, 12 plates around a cone',
    small: true,
    params: {
      ...SMALL, sliceMode: 'radial', radialCount: '12', radialHub: '9', baseLength: '80', baseWidth: '80', stackHeight: '40', erosionAmp: '6', erosionScale: '30',
      crest: '10', coherence: '0.6', insShape: 'cone', insWidth: '16', insHeight: '64', insTaper: '0.15', insSweep: '0',
    },
  },
  {
    name: 'Mini waffle',
    note: '70 mm square interlocking grid, no insert',
    small: true,
    params: { ...SMALL, sliceMode: 'waffle', insShape: 'none', endMargin: '9', baseLength: '70', baseWidth: '70', plateCount: '7', crossCount: '3', stackHeight: '38', erosionAmp: '6', crest: '5', erosionScale: '30', banding: '0.8' },
  },
  {
    name: 'Mini vessel',
    note: 'A 60 mm revolved form sliced into 16 plates',
    small: true,
    params: {
      ...SMALL, stackSource: 'form', srcShape: 'revolve', srcWidth: '56', srcHeight: '70', srcTaper: '0.55', srcCamber: '14', plateCount: '16',
      pitch: '(srcWidth - 4) / (plateCount - 1)', insShape: 'none', baseLength: '80', baseWidth: '80',
    },
  },
];

/** Images that come with a preset (e.g. a sound picture) replace those slots. */
export function applyPreset(p: Project, preset: Preset, images: Project['images'] = {}): Project {
  return { ...p, name: preset.name, params: { ...defaultRaw(), ...preset.params }, locks: {}, images: { ...p.images, ...images } };
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
    composition: raw.composition?.kind === 'composition' ? raw.composition : undefined,
  };
}
