// Builds the model for one saved project, once, for the phone viewer: from the
// result cache when this phone has seen it before, else in the engine worker,
// else on this thread. Nothing is edited, so there is no preview pass.
import { useEffect, useState } from 'react';
import { EngineWorker } from '../../core/engine';
import { assemble, createDeferredPipeline, createFrontPipeline, deferredInput, type Model } from '../../core/pipeline';
import type { Project } from '../../core/project';
import { decodeProjectAssets } from '../../state/assets';
import { lookupModel, storeModel } from '../../state/results';
import { runFrontPipelineSafe } from '../mapTerrainError';

export type ViewerModel =
  | { phase: 'idle' }
  | { phase: 'building'; step: string }
  | { phase: 'ready'; model: Model; finishing: boolean }
  | { phase: 'error'; error: string };

function buildHere(project: Project, assets: Awaited<ReturnType<typeof decodeProjectAssets>>): Model {
  const f = runFrontPipelineSafe(createFrontPipeline(), project, assets);
  return assemble(f, createDeferredPipeline()(deferredInput(f, project), 'full'), false);
}

export function useViewerModel(project: Project | null): ViewerModel {
  const [state, setState] = useState<ViewerModel>({ phase: 'idle' });
  useEffect(() => {
    if (!project) {
      setState({ phase: 'idle' });
      return;
    }
    let alive = true;
    let worker: Worker | null = null;
    setState({ phase: 'building', step: 'Reading pictures' });
    (async () => {
      const assets = await decodeProjectAssets(project);
      if (!alive) return;
      const saved = await lookupModel(project, assets);
      if (!alive) return;
      if (saved) {
        setState({ phase: 'ready', model: saved, finishing: false });
        return;
      }
      setState({ phase: 'building', step: 'Cutting the plates' });
      const local = () => {
        try {
          const m = buildHere(project, assets);
          if (!alive) return;
          setState({ phase: 'ready', model: m, finishing: false });
          storeModel(project, assets, m);
        } catch (e) {
          if (alive) setState({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
        }
      };
      if (typeof Worker === 'undefined') {
        // give the hourglass a frame to paint first
        setTimeout(local, 30);
        return;
      }
      try {
        worker = new Worker(new URL('../../core/engine.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        setTimeout(local, 30);
        return;
      }
      const engine = new EngineWorker(
        worker,
        (_job, m, reply) => {
          if (!alive) return;
          const finishing = !!reply.carving || !!m.stale;
          setState({ phase: 'ready', model: { ...m, stale: finishing }, finishing });
        },
        () => {
          worker?.terminate();
          worker = null;
          if (alive) local();
        },
      );
      engine.run(project, assets, 'full');
    })().catch((e) => alive && setState({ phase: 'error', error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
      worker?.terminate();
    };
  }, [project]);
  return state;
}
