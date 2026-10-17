import { useEffect, useRef } from 'react';
import { mapBuildKey, mapTerrainIsCurrent } from '../core/mapBuildKey';
import { MAP_TERRAIN_NO_SAMPLES_ERROR, userFacingMapBuildError } from '../core/mapBuildError';
import { buildMapTerrainAsset } from '../core/mapTerrainBuild';
import { useStore } from '../state/store';
import { reportMapTerrainFailure } from './mapTerrainError';

/** When the top face has a MapSpec without matching DepthData, build terrain in the browser. */
export function useMapTerrainBuild() {
  const spec = useStore((s) => s.project.images.top?.map);
  const depth = useStore((s) => s.project.images.top?.depth);
  const setMapTerrain = useStore((s) => s.setMapTerrain);
  const finishMapTerrainBuild = useStore((s) => s.finishMapTerrainBuild);
  const rebuildEpoch = useStore((s) => s.mapRebuildEpoch);
  const token = useRef(0);
  const failedKey = useRef<string | null>(null);
  const lastFailedError = useRef<string | null>(null);
  const seenEpoch = useRef(rebuildEpoch);

  const buildKey = spec ? mapBuildKey(spec) : '';
  const stale = spec && !mapTerrainIsCurrent(spec, depth);

  useEffect(() => {
    if (rebuildEpoch !== seenEpoch.current) {
      failedKey.current = null;
      seenEpoch.current = rebuildEpoch;
    }
    if (!stale || !spec) {
      if (!stale) failedKey.current = null;
      if (spec && mapTerrainIsCurrent(spec, depth)) {
        setMapTerrain({ phase: 'ready', message: 'Map terrain ready', error: undefined });
      } else if (!spec) {
        setMapTerrain({ phase: 'idle', message: '', error: undefined });
      }
      return;
    }
    if (failedKey.current === buildKey) {
      const st = useStore.getState().mapTerrain;
      if (st.phase === 'working') {
        setMapTerrain({
          phase: 'error',
          message: "Couldn't build plates",
          error: lastFailedError.current ?? MAP_TERRAIN_NO_SAMPLES_ERROR,
        });
      }
      return;
    }

    const id = ++token.current;
    const key = buildKey;
    setMapTerrain({ phase: 'working', message: 'Fetching elevation and building depth…', error: undefined });

    // Read the project at kickoff so param / override edits during the fetch
    // do not restart it, and finishMapTerrainBuild merges into the latest store.
    const project = useStore.getState().project;
    void buildMapTerrainAsset(project, { ...spec, buildKey: key })
      .then((asset) => {
        if (token.current !== id) return;
        finishMapTerrainBuild(asset);
        const warns = asset.map?.sourceWarnings;
        if (warns?.length) {
          useStore.getState().toast(`${warns.length} map warning${warns.length === 1 ? '' : 's'} (see Map tab)`);
        }
      })
      .catch((e: Error) => {
        if (token.current !== id) return;
        failedKey.current = key;
        lastFailedError.current = userFacingMapBuildError(e);
        reportMapTerrainFailure(e);
      });
  }, [stale, spec, depth, buildKey, rebuildEpoch, setMapTerrain, finishMapTerrainBuild]);
}
