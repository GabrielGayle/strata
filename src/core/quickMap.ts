import type { DepthData } from './depth';
import { mapBboxWidthHeightM } from './mapGiftSizing';
import { keepUserMapSettings } from './mapPresets';
import { defaultMapSpec, type EngraveSpec, type MapSpec } from './mapSpec';
import type { RawValue } from './params';
import { applyParamPatchRespectingOverrides, masterSizeBlocked } from './projectOverrides';
import { projectWithTopMapSpec } from './mapTopAsset';
import type { Project } from './project';

/** Clear gap between plate faces on an 800 mm Vermilion stack (~49 plates). */
export const QUICK_MAP_TARGET_PITCH_MM = 15;

export const QUICK_MAP_ENGRAVE_PRESET = 'survey';

const PLACE_ENGRAVE_EXTRA = new Set(['golf', 'contours', 'ski', 'piste', 'fairway', 'green', 'alpine']);

const DERIVED_MAP_KEYS = [
  'buildKey',
  'fetchedAt',
  'exaggerationFactor',
  'exaggerationReadout',
  'layerBreaksM',
  'simplifyLostFeatures',
  'resolvedSource',
  'sourceWarnings',
  'engraveArt',
] as const;

/** Image / insert / slicer fields that hide the terrain. User param overrides still win. */
export const QUICK_MAP_PARAM_PATCH: Record<string, RawValue> = {
  sliceMode: 'parallel',
  sliceAxis: 'length',
  spacingMode: 'fit',
  insertOn: false,
  insShape: 'none',
  imageOn: true,
  imgSideMode: 'off',
  imgFrontMode: 'off',
  etchMode: 'off',
  imgFit: 'off',
  imgFrontFit: 'off',
  imgSideFit: 'off',
  topOutline: 'off',
  imgTopMode: 'carve',
  topFloor: 'follow',
  topRotate: '0',
  edgeFlow: '0',
  erosionAmp: '0',
  crest: '0',
  slope: '0',
  banding: '0',
  fragmentMode: 'auto',
  stackSource: 'strata',
  imgInvert: false,
  imgSmooth: '0',
  imgContrast: '1',
  tuneMode: 'off',
};

function extraEngraveFeatures(prev?: EngraveSpec): string[] {
  const extras = (prev?.features ?? []).filter((f) => PLACE_ENGRAVE_EXTRA.has(f.toLowerCase()));
  const preset = (prev?.preset ?? '').toLowerCase();
  if (preset === 'golf' && !extras.some((f) => f.toLowerCase() === 'golf')) extras.push('golf');
  if (preset === 'ski' && !extras.some((f) => f.toLowerCase() === 'ski' || f.toLowerCase() === 'piste')) {
    extras.push('ski', 'piste');
  }
  return extras;
}

export function quickMapEngrave(prev?: EngraveSpec): EngraveSpec {
  const extras = extraEngraveFeatures(prev);
  const features = ['roads', 'water', 'title', 'labels', 'compass', ...extras];
  const seen = new Set<string>();
  const unique = features.filter((f) => {
    const k = f.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { enabled: true, features: unique, preset: QUICK_MAP_ENGRAVE_PRESET };
}

export function quickMapPlateCount(params: Record<string, RawValue>): number {
  const length = Number(params.baseLength) || 800;
  const end = Number(params.endMargin);
  const endM = Number.isFinite(end) ? end : 40;
  const span = Math.max(length - 2 * endM, 40);
  const n = Math.round(span / QUICK_MAP_TARGET_PITCH_MM) + 1;
  return Math.min(72, Math.max(8, n));
}

/**
 * Keep the long millimetre as the stack (N–S in the height field) so pitch
 * stays dense. Portrait places (Neasden, Kingsbarns, Royal County Down) already
 * match Vermilion 800×300; a short stack would drop to ~16 plates.
 */
export function mapOutlineForBbox(
  bbox: MapSpec['bbox'] | undefined,
  params: Record<string, RawValue>,
): Record<string, RawValue> {
  if (!bbox) return {};
  const { widthM, heightM } = mapBboxWidthHeightM(bbox);
  if (!(widthM > 0) || !(heightM > 0)) return {};
  const length = Number(params.baseLength);
  const width = Number(params.baseWidth);
  if (!Number.isFinite(length) || !Number.isFinite(width) || length <= 0 || width <= 0) return {};
  const long = Math.max(length, width);
  const short = Math.min(length, width);
  if (length === long && width === short) return {};
  return { baseLength: String(long), baseWidth: String(short) };
}

function stripDerivedMapFields(spec: MapSpec): MapSpec {
  const copy: MapSpec = { ...spec };
  for (const k of DERIVED_MAP_KEYS) delete copy[k];
  return copy;
}

/**
 * Quick map display defaults on the current place. Reuses keepUserMapSettings
 * so exaggeration, frame, source, gift size and dedication stay put.
 * Engrave, water, DTM and jenks are mode fields (not the override table).
 */
export function quickMapSpecKeepingUser(prev?: MapSpec): MapSpec | undefined {
  if (!prev) return undefined;
  const place = stripDerivedMapFields(prev);
  const mode = defaultMapSpec({
    ...place,
    exaggeration: 'auto',
    water: prev.water,
    model: 'dtm',
    layerBudget: 'jenks',
    engrave: quickMapEngrave(prev.engrave),
    bbox: prev.bbox,
    title: prev.title,
  });
  const kept = keepUserMapSettings(prev, mode);
  return defaultMapSpec({
    ...stripDerivedMapFields(kept),
    water: prev.water,
    model: 'dtm',
    layerBudget: 'jenks',
    engrave: quickMapEngrave(prev.engrave),
    exaggeration: prev.exaggeration,
    bbox: prev.bbox,
    title: prev.title,
    source: prev.source,
    resM: prev.resM,
    sunkenFrame: prev.sunkenFrame ? { ...prev.sunkenFrame } : kept.sunkenFrame,
    giftSizeId: prev.giftSizeId,
    commemorativeText: prev.commemorativeText,
    editionNumber: prev.editionNumber,
    buildingClampM: prev.buildingClampM,
  });
}

function applyQuickMapDepthDefaults(project: Project): Project {
  const top = project.images.top;
  if (!top?.depth) return project;
  const d = top.depth;
  const o = d.settingsOverrides;
  const settings: DepthData['settings'] = {
    ...d.settings,
    flatLevelMode: 'off',
    flatten: o?.flatten ? d.settings.flatten : 0,
    spacing: o?.spacing ? d.settings.spacing : 'linear',
    matte: o?.matte ? d.settings.matte : false,
    curve: o?.curve ? d.settings.curve : 1,
  };
  if (
    settings.flatLevelMode === d.settings.flatLevelMode &&
    settings.flatten === d.settings.flatten &&
    settings.spacing === d.settings.spacing &&
    settings.matte === d.settings.matte &&
    settings.curve === d.settings.curve
  ) {
    return project;
  }
  return { ...project, images: { ...project.images, top: { ...top, depth: { ...d, settings } } } };
}

/** One-step Quick map: plate options + map display. Does not mark param overrides. */
export function applyQuickMapToProject(project: Project): Project {
  const bbox = project.images.top?.map?.bbox;
  const outline = masterSizeBlocked(project.userParamOverrides) ? {} : mapOutlineForBbox(bbox, project.params);
  const withOutline = applyParamPatchRespectingOverrides(
    project.params,
    { ...QUICK_MAP_PARAM_PATCH, ...outline },
    project.userParamOverrides,
  );
  const counted = applyParamPatchRespectingOverrides(
    withOutline,
    { plateCount: String(quickMapPlateCount(withOutline)) },
    project.userParamOverrides,
  );
  let next: Project = { ...project, params: counted };
  const spec = quickMapSpecKeepingUser(next.images.top?.map);
  if (spec) next = projectWithTopMapSpec(next, spec);
  return applyQuickMapDepthDefaults(next);
}

export function engraveHasLabels(features: string[] | undefined): boolean {
  return (features ?? []).some((f) => {
    const k = f.toLowerCase();
    return k === 'labels' || k === 'label';
  });
}
