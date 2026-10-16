import { detectUkNation } from './mapRegion';
import type { MapSource, MapSpec } from './mapSpec';
import { HIGH_RES_MAX_M, sourceMeta } from './mapSourceRegistry';

export interface MapSourcePickResult {
  source: MapSource;
  warnings: string[];
}

function warnCoarse(fallback: MapSource, reason: string): string {
  const res = sourceMeta(fallback).resolutionM;
  return `${reason}; using ${fallback} (~${res} m) — may be too coarse for golf-scale maps (<2 km).`;
}

/**
 * Choose the best open elevation source for a bbox when `source` is `auto`.
 * Prefers ≤2 m LiDAR where a UK nation has a catalogue entry.
 */
export function pickAutoMapSource(bbox: MapSpec['bbox']): MapSourcePickResult {
  const nation = detectUkNation(bbox);
  const warnings: string[] = [];
  if (!nation) {
    warnings.push(warnCoarse('terrarium', 'bbox is outside UK nations heuristics'));
    return { source: 'terrarium', warnings };
  }
  if (nation === 'scotland') return { source: 'scot-dtm', warnings };
  if (nation === 'wales') return { source: 'wales-dtm', warnings };
  if (nation === 'northern-ireland') return { source: 'ni-dtm', warnings };
  return { source: 'ea-dtm', warnings };
}

export function isHighResSource(source: MapSource): boolean {
  if (source === 'auto') return false;
  return sourceMeta(source).resolutionM <= HIGH_RES_MAX_M;
}

export function pickExplicitSource(source: MapSource): MapSourcePickResult {
  return { source, warnings: [] };
}
