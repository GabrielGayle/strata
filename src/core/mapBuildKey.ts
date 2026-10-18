import type { MapSpec } from './mapSpec';

/**
 * Plate-stack settings the terrain build reads: layer breaks, auto exaggeration,
 * simplify thresholds and whether heights snap to terraces all depend on them.
 */
export interface MapBuildStackKey {
  plateCount: number;
  thicknessMm: number;
  baseLengthMm?: number;
  baseWidthMm?: number;
  masterWidthMm: number;
  kerfMm?: number;
  sliceMode?: string;
}

/** Stable key for whether cached DepthData matches the current MapSpec and plate stack. */
export function mapBuildKey(spec: MapSpec, stack?: MapBuildStackKey): string {
  return JSON.stringify({
    bbox: spec.bbox,
    source: spec.source,
    model: spec.model,
    resM: spec.resM,
    exaggeration: spec.exaggeration,
    water: spec.water,
    // builds store the budget they used; an unset budget means jenks
    layerBudget: spec.layerBudget ?? 'jenks',
    terraced: spec.terraced === true,
    buildingClampM: spec.buildingClampM,
    engrave: spec.engrave,
    sunkenFrame: spec.sunkenFrame,
    giftSizeId: spec.giftSizeId,
    editionNumber: spec.editionNumber,
    stack: stack
      ? {
          plateCount: stack.plateCount,
          thicknessMm: stack.thicknessMm,
          baseLengthMm: stack.baseLengthMm,
          baseWidthMm: stack.baseWidthMm,
          masterWidthMm: stack.masterWidthMm,
          kerfMm: stack.kerfMm,
          sliceMode: stack.sliceMode,
        }
      : undefined,
  });
}

export function mapTerrainIsCurrent(spec: MapSpec, depth?: unknown, stack?: MapBuildStackKey): boolean {
  return !!depth && spec.buildKey === mapBuildKey(spec, stack);
}
