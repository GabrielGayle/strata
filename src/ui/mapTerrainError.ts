import { userFacingMapBuildError } from '../core/mapBuildError';
import { frontWithMapFallback } from '../core/engine';
import type { Assets, FrontModel } from '../core/pipeline';
import type { Project } from '../core/project';
import { useStore } from '../state/store';

export {
  isMapTerrainFailure,
  MAP_TERRAIN_NETWORK_ERROR,
  MAP_TERRAIN_NO_SAMPLES_ERROR,
  MAP_TERRAIN_RANGE_ERROR,
  MAP_TERRAIN_USER_ERROR,
} from '../core/mapBuildError';

export function reportMapTerrainFailure(err: unknown): void {
  reportMapTerrainMessage(userFacingMapBuildError(err));
}

/** Shows a map build failure the engine worker already turned into words. */
export function reportMapTerrainMessage(error: string): void {
  const st = useStore.getState();
  if (st.mapTerrain.phase === 'error' && st.mapTerrain.error === error) return;
  st.setMapTerrain({
    phase: 'error',
    message: "Couldn't build plates",
    error,
  });
  st.toast(error);
}

export function runFrontPipelineSafe(
  front: (project: Project, assets: Assets) => FrontModel,
  project: Project,
  assets: Assets,
): FrontModel {
  return frontWithMapFallback(front, project, assets, (message) => reportMapTerrainMessage(message));
}
