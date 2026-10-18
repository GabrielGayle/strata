import type { LayerBudgetMode, MapSpec } from './mapSpec';
import type { Project } from './project';
import type { RawValue } from './params';

/** Plate-stack settings a map terrain build reads (and keys on). */
export interface MapStackContext {
  plateCount: number;
  thicknessMm: number;
  masterWidthMm: number;
  layerBudget?: LayerBudgetMode;
  kerfMm?: number;
  baseLengthMm?: number;
  baseWidthMm?: number;
  /** Project `sliceMode`. Only flat stacks snap terrain to the layer budget. */
  sliceMode?: string;
}

/** Flat stacks are terraces by construction; upright faces snap only when asked. */
export function mapUsesLayerBudget(spec: Pick<MapSpec, 'terraced'>, stack?: Pick<MapStackContext, 'sliceMode'>): boolean {
  return stack?.sliceMode === 'flat' || spec.terraced === true;
}

function numParam(raw: Record<string, RawValue>, id: string, fallback: number): number {
  const n = Number(raw[id]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function mapStackFromProject(project: Project, layerBudget?: LayerBudgetMode): MapStackContext {
  const p = project.params;
  return {
    plateCount: Math.round(numParam(p, 'plateCount', 12)),
    thicknessMm: numParam(p, 'thickness', 3),
    masterWidthMm: Math.max(numParam(p, 'baseLength', 520), numParam(p, 'baseWidth', 380)),
    layerBudget,
    kerfMm: numParam(p, 'kerf', 0.2),
    baseLengthMm: numParam(p, 'baseLength', 520),
    baseWidthMm: numParam(p, 'baseWidth', 380),
    sliceMode: typeof p.sliceMode === 'string' ? p.sliceMode : 'parallel',
  };
}

export const MAP_WIDTH_AXIS_NOTE =
  'Map faces always stack along the length (north to south), so Direction "Along width" is ignored here. Swapping the axis would mirror the map.';

/**
 * Map faces are drawn in a fixed north-up world frame, and stacking along the
 * width transposes that frame (a mirror, not a rotation). Evaluate map projects
 * with the stack along the length; the user's setting is kept in the project.
 */
const forcedParams = new WeakMap<Record<string, RawValue>, Record<string, RawValue>>();

export function mapFaceParams(raw: Record<string, RawValue>): { raw: Record<string, RawValue>; forced: boolean } {
  if (raw.sliceAxis !== 'width' || raw.sliceMode === 'radial') return { raw, forced: false };
  // same object for the same params, so the pipeline's Parameters stage stays cached
  let out = forcedParams.get(raw);
  if (!out) forcedParams.set(raw, (out = { ...raw, sliceAxis: 'length' }));
  return { raw: out, forced: true };
}
