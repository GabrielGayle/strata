import { createContext, useContext } from 'react';
import type { Model } from '../core/pipeline';

export const ModelContext = createContext<Model | null>(null);

export function useModel(): Model {
  const m = useContext(ModelContext);
  if (!m) throw new Error('No model');
  return m;
}

export const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
export const fmtInt = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-GB') : '–');

/** Returns a fully up-to-date model (runs deferred stages if needed). Use for exports. */
export const FullModelContext = createContext<() => Model>(() => {
  throw new Error('No pipeline');
});
export const useFullModel = () => useContext(FullModelContext);
