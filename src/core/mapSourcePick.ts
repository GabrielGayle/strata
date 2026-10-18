import { detectUkNation, type UkNation } from './mapRegion';
import type { MapSource, MapSpec } from './mapSpec';
import { HIGH_RES_MAX_M, sourceMeta } from './mapSourceRegistry';

export interface MapSourcePickResult {
  source: MapSource;
  warnings: string[];
}

/**
 * Sources that fetch real elevation in the browser and the CLI today. The Scottish,
 * Welsh and Northern Irish ids only resolve through injected fixture loaders (tests),
 * so neither the auto pick nor the Map tab offers them (docs/map-sources.md).
 */
export const WORKING_MAP_SOURCES: readonly MapSource[] = ['auto', 'ea-dtm', 'ea-dsm', 'terrarium'];

export function isWorkingMapSource(source: MapSource): boolean {
  return WORKING_MAP_SOURCES.includes(source);
}

const NATION_LABEL: Record<Exclude<UkNation, 'england'>, string> = {
  scotland: 'Scottish',
  wales: 'Welsh',
  'northern-ireland': 'Northern Irish',
};

function warnCoarse(fallback: MapSource, reason: string): string {
  const res = sourceMeta(fallback).resolutionM;
  return `${reason}; using ${fallback} (~${res} m) — may be too coarse for golf-scale maps (<2 km).`;
}

/**
 * Choose an open elevation source for a bbox when `source` is `auto`: EA LiDAR in
 * England, Terrarium everywhere else. Only sources that actually fetch are returned.
 */
export function pickAutoMapSource(bbox: MapSpec['bbox']): MapSourcePickResult {
  const nation = detectUkNation(bbox);
  if (nation === 'england') return { source: 'ea-dtm', warnings: [] };
  const reason = nation ? `${NATION_LABEL[nation]} LiDAR is not supported yet` : 'bbox is outside UK nations heuristics';
  return { source: 'terrarium', warnings: [warnCoarse('terrarium', reason)] };
}

export function isHighResSource(source: MapSource): boolean {
  if (source === 'auto') return false;
  return sourceMeta(source).resolutionM <= HIGH_RES_MAX_M;
}

export function pickExplicitSource(source: MapSource): MapSourcePickResult {
  return { source, warnings: [] };
}
