import type { ImageAsset, Project } from './project';
import { buildMapTopAsset, mapStackFromProject } from './mapPipeline';
import { mapBuildKey } from './mapBuildKey';
import type { MapSpec } from './mapSpec';
import { getBrowserMapTileFetcher } from './mapBrowserTiles';
import { browserEaGridLoader, browserOverpassFetcher, browserRegionalGridLoader } from './mapBrowserFixtures';

const e2eFixtures = import.meta.env.VITE_E2E_MAP_FIXTURES === '1';

export async function buildMapTerrainAsset(project: Project, spec: MapSpec, signal?: AbortSignal): Promise<ImageAsset> {
  const stack = mapStackFromProject(project, spec.layerBudget);
  const key = mapBuildKey(spec, stack);
  const asset = await buildMapTopAsset(
    { ...spec, buildKey: key },
    {
      stack,
      allowOverpassNetwork: !e2eFixtures,
      signal,
      fetch: getBrowserMapTileFetcher(),
      ...(e2eFixtures
        ? {
            eaLoader: browserEaGridLoader(),
            regionalLoader: browserRegionalGridLoader(),
            overpass: browserOverpassFetcher(),
          }
        : {}),
    },
  );
  return asset;
}
