// The terrain job Boost runs on the cloud: the same map build as the browser and
// the CLI (buildMapBundle), at up to 2048 px, with the server fetching the data.
import type { TerrainJobRequest, TerrainJobSize } from '../../api/_lib/geoJob.js';
import { terrainJobSpec } from '../../api/_lib/geoJob.js';
import { buildMapBundle, type BuildMapImageOptions } from './mapPipeline';
import { mapStackFromProject, type MapStackContext } from './mapStack';
import { cleanMapSpec, type LayerBudgetMode, type MapSpec } from './mapSpec';
import type { ImageAsset, Project } from './project';
import { ENGINE_BUILD } from './resultCache';

/** The cloud job for this project's top map. */
export function terrainJobRequest(project: Project, spec: MapSpec, maxPx: TerrainJobSize = 2048, engine = ENGINE_BUILD): TerrainJobRequest {
  const stack = mapStackFromProject(project, spec.layerBudget);
  return {
    kind: 'terrain',
    engine,
    spec: terrainJobSpec(spec as unknown as Record<string, unknown>),
    stack: JSON.parse(JSON.stringify(stack)),
    maxPx,
  };
}

export type TerrainJobOptions = Omit<BuildMapImageOptions, 'stack' | 'maxPx'>;

/** Build the asset for a terrain job. The caller stamps `map.cloudBuilt` with the job key. */
export async function runTerrainJob(req: TerrainJobRequest, opts: TerrainJobOptions = {}): Promise<ImageAsset> {
  const spec = cleanMapSpec(req.spec);
  if (!spec) throw new Error('Terrain job has no usable map spec');
  const stack: MapStackContext = { ...req.stack, layerBudget: req.stack.layerBudget as LayerBudgetMode | undefined };
  const bundle = await buildMapBundle(spec, { ...opts, stack, maxPx: req.maxPx });
  return bundle.asset;
}
