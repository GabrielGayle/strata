import type { MapSpec } from './mapSpec';

/** Stable key for whether cached DepthData matches the current MapSpec settings. */
export function mapBuildKey(spec: MapSpec): string {
  return JSON.stringify({
    bbox: spec.bbox,
    source: spec.source,
    model: spec.model,
    resM: spec.resM,
    exaggeration: spec.exaggeration,
    water: spec.water,
    layerBudget: spec.layerBudget,
    buildingClampM: spec.buildingClampM,
    engrave: spec.engrave,
    sunkenFrame: spec.sunkenFrame,
    giftSizeId: spec.giftSizeId,
    editionNumber: spec.editionNumber,
  });
}

export function mapTerrainIsCurrent(spec: MapSpec, depth?: unknown): boolean {
  return !!depth && spec.buildKey === mapBuildKey(spec);
}
