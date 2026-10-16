// The project file: parameters + pour plan + source assets, as one readable JSON.
import { defaultRaw, PARAM_MAP, type RawValue } from './params';
import type { PourLayer } from './mould';
import type { PatternSpec } from './pattern';
import type { Composition } from './compose';
import { cleanMoves, type PartMoves } from './moves';
import type { SoundSpec } from './sound';
import { cleanAppearance, type Appearance } from './appearance';
import type { DepthData } from './depth';
import { cleanMapSpec, type MapSpec } from './mapSpec';
import { cleanUserParamOverrides, type UserParamOverrides } from './projectOverrides';
import { cleanShadow, type ShadowSpec } from './shadow';
import { cleanObjects, type CutObject } from './objects';
import { cleanShelf, type ShelfSpec } from './shelf';
import { cleanOrigin, type WorldOrigin } from './origin';

export interface ImageAsset {
  name: string;
  dataUrl: string;
  /** Set when the image is a generated graphic, so it can be reopened and edited. */
  pattern?: PatternSpec;
  /** Set when the image is rendered from the composer (project.composition). */
  composed?: boolean;
  /** Set when the image is drawn from a sound, so it can be reopened and edited. */
  sound?: SoundSpec;
  /** Set when the image came from "Depth from photo": the metric depth, and how it is turned into grey. */
  depth?: DepthData;
  /** Set when the image is terrain from the Map function (re-openable spec). */
  map?: MapSpec;
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
  moves?: PartMoves;
  appearance?: Appearance;
  /**
   * The images as they were (graphics, sound pictures and depth settings ride
   * along inside each asset). Missing on variants saved before this existed:
   * those keep whatever images the project has.
   */
  images?: Project['images'];
  composition?: Composition;
  /** The shadow pictures as they were. Missing on variants saved before this existed: those keep the project's. */
  shadow?: ShadowSpec | null;
  /** The placed objects as they were. Missing on variants saved before this existed: those keep the project's. */
  objects?: CutObject[] | null;
  /** The postcard shelf as it was. Missing on variants saved before this existed: those keep the project's. */
  shelf?: ShelfSpec | null;
  /** The world origin as it was. Missing on variants saved before this existed: those keep the project's. */
  origin?: WorldOrigin | null;
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
  /** Plates moved by hand in the 3D view, keyed by plate key (P3, X1, R5…). */
  moves?: PartMoves;
  /** Material buckets: which plates are cut from which metal, and how each looks. */
  appearance?: Appearance;
  /** Shadow pictures and the times they appear (Shadow view). */
  shadow?: ShadowSpec;
  /** Objects placed among the plates (postcards, boxes…), each cut out of the plates it passes through. */
  objects?: CutObject[];
  /** Postcards laid along an arc, each held in a seat cut into the plates. */
  shelf?: ShelfSpec;
  /** Where placed objects and the shelf are measured from (the middle of the floor under the base when missing). */
  origin?: WorldOrigin;
  /** Parameter ids the user set; auto-dimension and design size patches must not overwrite them. */
  userParamOverrides?: UserParamOverrides;
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
  return { ...p, name: preset.name, params: { ...defaultRaw(), ...preset.params }, locks: {}, images: { ...p.images, ...images }, moves: undefined };
}

/** Stands in for a variant image (or set of shadow pictures) that is the same as the project's own, so files don't carry it twice. */
const SAME_IMAGE = '=current';

export function serialize(p: Project): string {
  const variants = p.variants.map((v) => {
    if (!v.images) return v;
    const images: Record<string, unknown> = {};
    for (const [slot, a] of Object.entries(v.images)) {
      const cur = p.images[slot as keyof Project['images']];
      images[slot] = a && (a === cur || (cur && JSON.stringify(a) === JSON.stringify(cur))) ? SAME_IMAGE : a;
    }
    return { ...v, images };
  }).map((v) => (v.shadow && p.shadow && JSON.stringify(v.shadow) === JSON.stringify(p.shadow) ? { ...v, shadow: SAME_IMAGE } : v));
  return JSON.stringify({ ...p, variants }, null, 2);
}

function readVariants(raw: any): Variant[] {
  if (!Array.isArray(raw.variants)) return [];
  const own = raw.images ?? {};
  const shadow = (v: any) => (v.shadow === SAME_IMAGE ? cleanShadow(raw.shadow) ?? null : v.shadow === undefined ? undefined : cleanShadow(v.shadow) ?? null);
  return raw.variants.map((v: any) => (v && typeof v === 'object' && 'shadow' in v ? { ...v, shadow: shadow(v) } : v)).map((v: any) => (v && typeof v === 'object' && 'objects' in v ? { ...v, objects: cleanObjects(v.objects) ?? null } : v)).map((v: any) => (v && typeof v === 'object' && 'shelf' in v ? { ...v, shelf: cleanShelf(v.shelf) ?? null } : v)).map((v: any) => (v && typeof v === 'object' && 'origin' in v ? { ...v, origin: cleanOrigin(v.origin) ?? null } : v)).map((v: any) => {
    if (!v?.images || typeof v.images !== 'object') return v;
    const images: Project['images'] = {};
    for (const [slot, a] of Object.entries(v.images)) {
      const asset = a === SAME_IMAGE ? own[slot] : a;
      const cleaned = cleanImageAsset(asset);
      if (cleaned) images[slot as keyof Project['images']] = cleaned;
    }
    return { ...v, images, composition: v.composition?.kind === 'composition' ? v.composition : undefined };
  });
}

/** The project as a variant left it: its settings, images and composition over the current project. */
export function applyVariant(p: Project, v: Variant): Project {
  return {
    ...p,
    params: { ...p.params, ...v.params },
    locks: { ...v.locks },
    pour: v.pour.map((x) => ({ ...x })),
    moves: v.moves,
    appearance: v.appearance ?? p.appearance,
    ...(v.images ? { images: { ...v.images }, composition: v.composition } : {}),
    ...(v.shadow !== undefined ? { shadow: v.shadow ?? undefined } : {}),
    ...(v.objects !== undefined ? { objects: v.objects ?? undefined } : {}),
    ...(v.shelf !== undefined ? { shelf: v.shelf ?? undefined } : {}),
    ...(v.origin !== undefined ? { origin: v.origin ?? undefined } : {}),
  };
}

function cleanImageAsset(raw: unknown): ImageAsset | undefined {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || typeof o.name !== 'string' || typeof o.dataUrl !== 'string') return undefined;
  const asset: ImageAsset = { name: o.name, dataUrl: o.dataUrl };
  if (o.pattern && typeof o.pattern === 'object') asset.pattern = o.pattern as ImageAsset['pattern'];
  if (o.composed === true) asset.composed = true;
  if (o.sound && typeof o.sound === 'object') asset.sound = o.sound as ImageAsset['sound'];
  if (o.depth && typeof o.depth === 'object') asset.depth = o.depth as DepthData;
  const map = cleanMapSpec(o.map);
  if (map) asset.map = map;
  return asset;
}

function readImages(raw: unknown): Project['images'] {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Record<string, unknown>;
  const out: Project['images'] = {};
  for (const slot of ['side', 'front', 'top'] as const) {
    const a = cleanImageAsset(src[slot]);
    if (a) out[slot] = a;
  }
  return out;
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
    images: readImages(raw.images),
    meshes: raw.meshes ?? {},
    variants: readVariants(raw),
    composition: raw.composition?.kind === 'composition' ? raw.composition : undefined,
    moves: cleanMoves(raw.moves),
    appearance: cleanAppearance(raw.appearance),
    shadow: cleanShadow(raw.shadow),
    objects: cleanObjects(raw.objects),
    shelf: cleanShelf(raw.shelf),
    origin: cleanOrigin(raw.origin),
    userParamOverrides: cleanUserParamOverrides(raw.userParamOverrides),
  };
}
