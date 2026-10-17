import { isMapTerrainFailure, userFacingMapBuildError } from '../core/mapBuildError';
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
  const error = userFacingMapBuildError(err);
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
  try {
    return front(project, assets);
  } catch (e) {
    if (!isMapTerrainFailure(e)) throw e;
    reportMapTerrainFailure(e);
    const top = project.images.top;
    if (top?.map && top.depth) {
      return front({ ...project, images: { ...project.images, top: { ...top, depth: undefined } } }, assets);
    }
    throw e;
  }
}
