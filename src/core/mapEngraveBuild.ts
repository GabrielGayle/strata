import type { DepthData } from './depth';
import { fetchOverpass } from './mapOverpass';
import { osmToEngraveArt, type MapEngraveArt } from './mapOsmEngrave';
import { resolveEngravePreset } from './mapEngravePresets';
import type { MapSpec } from './mapSpec';
import type { OverpassFetcher } from './mapOverpass';

export interface BuildMapEngraveOptions {
  cacheDir?: string;
  overpass?: OverpassFetcher;
  allowNetwork?: boolean;
  overpassQuery?: string;
}

export async function buildMapEngraveArt(
  spec: MapSpec,
  depth: DepthData,
  opts: BuildMapEngraveOptions = {},
): Promise<MapEngraveArt | null> {
  if (!spec.engrave?.enabled) return null;
  const features = spec.engrave.features?.length ? spec.engrave.features : ['roads', 'water'];
  const raw = await fetchOverpass(spec.bbox, {
    cacheDir: spec.cacheDir ?? opts.cacheDir,
    fetch: opts.overpass,
    allowNetwork: opts.allowNetwork,
    query: opts.overpassQuery,
  });
  const art = osmToEngraveArt(raw, spec.bbox, depth.w, depth.h, features);
  const w = art.imageW;
  const h = art.imageH;
  if (features.includes('compass')) {
    const cx = w * 0.12;
    const cy = h * 0.12;
    const r = Math.min(w, h) * 0.04;
    art.lines.push({
      kind: 'other',
      path: [[cx, cy - r], [cx, cy + r], [cx - r, cy], [cx + r, cy], [cx, cy - r * 0.7], [cx, cy - r]],
    });
  }
  if (features.includes('scale') || features.includes('contours')) {
    const y = h * 0.92;
    const x0 = w * 0.72;
    const x1 = w * 0.92;
    art.lines.push({ kind: 'other', path: [[x0, y], [x1, y], [x0, y - 3], [x0, y + 3], [x1, y - 3], [x1, y + 3]] });
  }
  if (spec.layerBreaksM?.length && features.includes('contours')) {
    const n = spec.layerBreaksM.length;
    for (let i = 1; i < n; i++) {
      const yy = h * (0.2 + (0.65 * i) / n);
      art.lines.push({ kind: 'other', path: [[w * 0.08, yy], [w * 0.92, yy]] });
    }
  }
  void resolveEngravePreset(spec.engrave.preset);
  return art;
}
