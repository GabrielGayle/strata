import { useEffect, useMemo, useRef } from 'react';
import { mapBuildKey, mapTerrainIsCurrent } from '../core/mapBuildKey';
import { MAP_TERRAIN_NO_SAMPLES_ERROR, userFacingMapBuildError } from '../core/mapBuildError';
import { buildMapTerrainAsset } from '../core/mapTerrainBuild';
import { mapStackFromProject } from '../core/mapStack';
import { useStore } from '../state/store';
import { reportMapTerrainFailure } from './mapTerrainError';
import { terrainJobRequest } from '../core/cloudTerrain';
import { CloudUnavailableError, restWords, runCloudJob, useCloud } from '../state/cloud';

/**
 * When the top face has a MapSpec without matching DepthData, build terrain in the browser,
 * or on the cloud at 2048 px when the map asks for "High resolution (cloud)" and Boost is ready.
 * A cloud failure falls back to the local build with a toast.
 */
export function useMapTerrainBuild() {
  const spec = useStore((s) => s.project.images.top?.map);
  const depth = useStore((s) => s.project.images.top?.depth);
  const setMapTerrain = useStore((s) => s.setMapTerrain);
  const finishMapTerrainBuild = useStore((s) => s.finishMapTerrainBuild);
  const rebuildEpoch = useStore((s) => s.mapRebuildEpoch);
  const token = useRef(0);
  /** Cancels the running build's tile fetches when a newer build starts or the app unmounts. */
  const inFlight = useRef<AbortController | null>(null);
  const failedKey = useRef<string | null>(null);
  const lastFailedError = useRef<string | null>(null);
  const seenEpoch = useRef(rebuildEpoch);

  // Plate count, thickness, base size, kerf and slicing feed the terrain build,
  // so a change to any of them rebuilds it (the key string keeps this cheap).
  const stackKey = useStore((s) => (spec ? JSON.stringify(mapStackFromProject(s.project, spec.layerBudget)) : ''));
  const stack = useMemo(() => (stackKey ? JSON.parse(stackKey) : undefined), [stackKey]);
  const buildKey = spec ? mapBuildKey(spec, stack) : '';
  const cloudPhase = useCloud((s) => (s.boost ? s.phase : 'off'));
  const cloudOk = cloudPhase === 'ready' || cloudPhase === 'working';
  /** Keys the cloud failed for: their local fallback stands until the map or Boost changes. */
  const cloudFailedKey = useRef<string | null>(null);
  // the cloud coming back (Boost turned on, a fresh health check) gives a failed key another try
  const cloudWasOk = useRef(cloudOk);
  if (cloudOk && !cloudWasOk.current) cloudFailedKey.current = null;
  cloudWasOk.current = cloudOk;
  const wantCloud = !!spec?.cloudRes && cloudOk && cloudFailedKey.current !== buildKey;
  // unticking High resolution (cloud) goes back to the local build
  /** Wait for the health check before building a cloud map, rather than build it twice. */
  const cloudPending = !!spec?.cloudRes && cloudPhase === 'checking';
  const cloudResting = cloudPhase === 'resting' || cloudPhase === 'locked';
  /** The build in flight: a re-render for the same key and route leaves it running. */
  const running = useRef<{ key: string; cloud: boolean } | null>(null);
  const stale = spec && (!mapTerrainIsCurrent(spec, depth, stack) || (wantCloud && !spec.cloudBuilt) || (!spec.cloudRes && !!spec.cloudBuilt));

  useEffect(() => {
    if (rebuildEpoch !== seenEpoch.current) {
      failedKey.current = null;
      seenEpoch.current = rebuildEpoch;
    }
    if (!stale || !spec) {
      if (!stale) failedKey.current = null;
      if (spec && mapTerrainIsCurrent(spec, depth, stack)) {
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
    if (running.current?.key === buildKey && running.current.cloud === wantCloud) return;
    if (cloudPending) {
      setMapTerrain({ phase: 'working', message: 'Checking the cloud…', error: undefined });
      return;
    }

    const id = ++token.current;
    const key = buildKey;
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    setMapTerrain({
      phase: 'working',
      message: wantCloud ? 'Building high-resolution terrain in the cloud…' : 'Fetching elevation and building depth…',
      error: undefined,
    });

    // Read the project at kickoff so param / override edits during the fetch
    // do not restart it, and finishMapTerrainBuild merges into the latest store.
    const project = useStore.getState().project;
    running.current = { key, cloud: wantCloud };
    if (!wantCloud && spec.cloudRes && cloudResting) {
      const why = useCloud.getState().phase === 'locked' ? 'locked' : (useCloud.getState().reason ?? 'unavailable');
      useStore.getState().toast(`Cloud ${why}: building the map here at 1024 px instead`);
    }
    const local = () => buildMapTerrainAsset(project, { ...spec, buildKey: key }, ctrl.signal);
    const build = wantCloud
      ? runCloudJob(terrainJobRequest(project, spec), ctrl.signal)
          // the cloud built from the same spec and stack this key names
          .then((asset) => ({ ...asset, map: { ...asset.map!, buildKey: key } }))
          .catch((e: Error) => {
            if (e.name === 'AbortError' || token.current !== id) throw e;
            cloudFailedKey.current = key;
            running.current = { key, cloud: false };
            const why = e instanceof CloudUnavailableError ? restWords(e.reason) : 'unavailable';
            useStore.getState().toast(`Cloud ${why}: building the map here at 1024 px instead`);
            setMapTerrain({ phase: 'working', message: 'Fetching elevation and building depth…', error: undefined });
            return local();
          })
      : local();
    void build
      .then((asset) => {
        if (token.current !== id) return;
        running.current = null;
        finishMapTerrainBuild(asset);
        const warns = asset.map?.sourceWarnings;
        if (warns?.length) {
          useStore.getState().toast(`${warns.length} map warning${warns.length === 1 ? '' : 's'} (see Map tab)`);
        }
      })
      .catch((e: Error) => {
        if (token.current !== id) return;
        running.current = null;
        failedKey.current = key;
        lastFailedError.current = userFacingMapBuildError(e);
        reportMapTerrainFailure(e);
      });
  }, [stale, spec, depth, stack, buildKey, wantCloud, cloudPending, cloudResting, rebuildEpoch, setMapTerrain, finishMapTerrainBuild]);

  useEffect(() => () => inFlight.current?.abort(), []);
}
