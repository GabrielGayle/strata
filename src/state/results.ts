// The page's side of the result cache (see core/resultCache.ts): the model the
// app opens with after a reload, Compare's two models, and the Settings menu's
// size and Clear button. The engine worker reads and writes the same storage.
import { modelFromPlain, modelToPlain, packPoints, validCachedModel, type PlainModel } from '../core/engine';
import type { Assets, Model } from '../core/pipeline';
import type { Project } from '../core/project';
import { approxBytes, resultKey } from '../core/resultCache';
import { idbDiskStore } from '../core/resultCacheIdb';
import { unpackPoints } from '../core/packPoints';

const disk = idbDiskStore();

/** The assets the app has before any picture is decoded (what useAssets starts with). */
export const NO_ASSETS: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

/** A stored model, ready to show; undefined when there is none. */
export async function lookupModel(project: Project, assets: Assets): Promise<Model | undefined> {
  if (!disk) return undefined;
  try {
    const t0 = performance.now();
    const plain = await disk.get(resultKey(project, assets));
    if (!validCachedModel(plain)) return undefined;
    const m = modelFromPlain(unpackPoints(plain) as PlainModel);
    const ms = performance.now() - t0;
    return { ...m, stages: [{ name: 'Result cache (disk)', ms, cached: true }, ...m.stages.map((s) => ({ ...s, cached: true }))], totalMs: ms, stale: false };
  } catch {
    return undefined;
  }
}

/** Keeps a model built on this thread (Compare), for next time. */
export function storeModel(project: Project, assets: Assets, model: Model) {
  if (!disk || model.stale || model.shadowPending) return;
  try {
    const plain = packPoints(modelToPlain(model));
    disk.put(resultKey(project, assets), plain, approxBytes(plain)).catch(() => {});
  } catch {
    /* not worth an error: it is only a cache */
  }
}

let preloaded: { project: Project; model: Model } | null = null;

/** Reads the model for the session's project before the first render, so a reload doesn't slice on this thread. Gives up after `waitMs`. */
export async function preloadModel(project: Project, waitMs = 1500) {
  if (!disk) return;
  const model = await Promise.race([lookupModel(project, NO_ASSETS), new Promise<undefined>((r) => setTimeout(r, waitMs))]);
  if (model) preloaded = { project, model };
}

/** The preloaded model, if it is for `project`. */
export function takePreloaded(project: Project): Model | null {
  return preloaded?.project === project ? preloaded.model : null;
}

const clearHooks = new Set<() => void>();

/** Runs `fn` whenever the saved results are cleared (the engine forgets its copies too). */
export function onResultsCleared(fn: () => void) {
  clearHooks.add(fn);
  return () => void clearHooks.delete(fn);
}

export const resultsStored = () => !!disk;

export async function savedResultsUsage() {
  return disk ? disk.usage() : { entries: 0, bytes: 0 };
}

export async function clearSavedResults() {
  clearHooks.forEach((fn) => fn());
  await disk?.clear();
}
