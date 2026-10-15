// The shadow kitchen's Fit button: try a handful of plate layouts (count or
// gap, and height) through the real pipeline, and suggest the one whose
// frames come out best for the chosen sun. A coarser picture grid keeps it quick.
import type { Values } from './params';
import type { Project } from './project';
import { createFrontPipeline, type Assets } from './pipeline';

export interface FitTry {
  /** Parameter changes for this layout (empty for the current plates). */
  params: Record<string, number>;
  /** Average match over the usable frames, stray light and frames the sun can't show count against it. */
  score: number;
  match: number;
  stray: number;
  cut: number;
  plates: number;
}

/** The layouts to try: plate count (or gap) around the current one, times a few heights. */
export function fitLayouts(v: Values): Record<string, number>[] {
  const out: Record<string, number>[] = [];
  const counts =
    v.spacingMode === 'gap'
      ? [0.5, 0.75, 1, 1.5, 2].map((k) => ({ plateGap: Math.max(0.5, Math.round(v.plateGap * k * 2) / 2) }))
      : [0.5, 0.75, 1, 1.5, 2].map((k) => ({ plateCount: Math.min(300, Math.max(4, Math.round(v.plateCount * k))) }));
  const heights = v.stackSource === 'strata' ? [1, 1.3, 1.7].map((k) => Math.round(v.stackHeight * k)) : [null];
  const seen = new Set<string>();
  for (const c of counts)
    for (const h of heights) {
      const p: Record<string, number> = { ...c };
      if (h !== null) p.stackHeight = h;
      const key = JSON.stringify(p);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  return out;
}

/** Carve one layout and score it. */
export function tryLayout(run: ReturnType<typeof createFrontPipeline>, project: Project, assets: Assets, v: Values, params: Record<string, number>): FitTry {
  const cell = Math.max(0.5, Number(v.shadowCell) || 3);
  const p: Project = { ...project, params: { ...project.params, ...params, shadowCell: Math.min(10, cell * 2) } };
  const rep = run(p, assets).shadow;
  if (!rep || !rep.scores.length) return { params, score: 0, match: 0, stray: 0, cut: 0, plates: 0 };
  const n = rep.scores.length;
  const match = rep.scores.reduce((a, s) => a + (s.problem ? 0 : s.match), 0) / n;
  const stray = rep.scores.reduce((a, s) => a + (s.problem ? 0 : s.stray), 0) / n;
  return { params, score: match - 0.5 * stray, match, stray, cut: rep.cut, plates: rep.plates };
}

/** The best of the tries; a near tie goes to the cheaper layout (less steel: fewer, shorter plates). */
export function bestTry(tries: FitTry[], v: Values): FitTry | null {
  if (!tries.length) return null;
  const top = Math.max(...tries.map((t) => t.score));
  const steel = (t: FitTry) => (t.params.plateCount ?? (t.params.plateGap ? v.plateCount * (v.plateGap / t.params.plateGap) : v.plateCount)) * (t.params.stackHeight ?? v.stackHeight);
  return tries.filter((t) => t.score >= top - 0.01).sort((a, b) => steel(a) - steel(b))[0];
}
