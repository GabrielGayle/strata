import type { ImageAsset, Project } from './project';
import type { MapSpec } from './mapSpec';
import { defaultMapSpec } from './mapSpec';
import { mapBuildKey } from './mapBuildKey';
import { mapStackFromProject } from './mapStack';
import { b64Bytes, type DepthData } from './depth';
import { b64FromU16 } from './mapToDepth';
import { MAP_LOCAL_MAX_PX } from './mapProject';

export const MAP_TOP_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Attach a MapSpec to the top face and enable carving; depth is built asynchronously in the browser. */
export function projectWithTopMapSpec(project: Project, mapInput: MapSpec | (Partial<MapSpec> & { bbox: MapSpec['bbox'] })): Project {
  const prev = project.images.top?.map;
  const spec: MapSpec =
    (mapInput as MapSpec).kind === 'map' ? (mapInput as MapSpec) : defaultMapSpec({ ...prev, ...mapInput, bbox: mapInput.bbox });
  const title = spec.title?.trim() || 'Map terrain';
  const params = String(project.params.imgTopMode ?? 'off') === 'off' ? { ...project.params, imgTopMode: 'carve' } : project.params;
  const prevTop = project.images.top;
  const top: ImageAsset = {
    name: title,
    dataUrl: prevTop?.dataUrl ?? MAP_TOP_PLACEHOLDER,
    map: spec,
    ...(prevTop?.depth ? { depth: prevTop.depth } : {}),
  };
  return { ...project, params, images: { ...project.images, top } };
}

/**
 * Apply a finished terrain build onto the current project without clobbering
 * user map settings (exaggeration, sunken frame, bbox, …) or any other
 * project fields (params, locks, moves). Stale builds — whose key no longer
 * matches what the user has asked for — are dropped.
 */
export function applyBuiltMapAsset(project: Project, asset: ImageAsset): Project | null {
  const current = project.images.top;
  const built = asset.map;
  if (!current?.map || !built) return null;
  const stack = mapStackFromProject(project, current.map.layerBudget);
  const wanted = mapBuildKey(current.map, stack);
  const incoming = built.buildKey ?? mapBuildKey(built, stack);
  if (incoming !== wanted) return null;
  const merged: ImageAsset = {
    ...current,
    name: asset.name || current.name,
    dataUrl: asset.dataUrl || current.dataUrl,
    depth: asset.depth ?? current.depth,
    map: {
      ...current.map,
      buildKey: incoming,
      crs: built.crs ?? current.map.crs,
      fetchedAt: built.fetchedAt,
      layerBreaksM: built.layerBreaksM,
      exaggerationFactor: built.exaggerationFactor,
      exaggerationReadout: built.exaggerationReadout,
      simplifyLostFeatures: built.simplifyLostFeatures,
      resolvedSource: built.resolvedSource,
      sourceWarnings: built.sourceWarnings,
      engraveArt: built.engraveArt ?? current.map.engraveArt,
      attribution: built.attribution?.length ? built.attribution : current.map.attribution,
      cloudBuilt: built.cloudBuilt,
    },
  };
  return { ...project, images: { ...project.images, top: merged } };
}

/** Halve a uint16 depth grid by 2×2 averaging; 0 is "no depth" and is left out of each average. */
function halveDepth(d: DepthData): DepthData {
  const bytes = b64Bytes(d.data);
  const w = Math.ceil(d.w / 2);
  const h = Math.ceil(d.h / 2);
  const out = new Uint16Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let sum = 0;
      let n = 0;
      for (let dr = 0; dr < 2; dr++) {
        const y = 2 * r + dr;
        if (y >= d.h) continue;
        for (let dc = 0; dc < 2; dc++) {
          const x = 2 * c + dc;
          if (x >= d.w) continue;
          const i = (y * d.w + x) * 2;
          const q = bytes[i] | (bytes[i + 1] << 8);
          if (q) (sum += q, n++);
        }
      }
      out[r * w + c] = n ? Math.round(sum / n) : 0;
    }
  }
  const { mask: _mask, ...rest } = d;
  return { ...rest, w, h, data: b64FromU16(out) };
}

/**
 * A cloud-built map (up to 2048 px) saved as a 1024 px copy so project files stay under 4 MB.
 * The full grid stays in the cloud cache under `map.cloudBuilt.key`.
 */
export function compactCloudAsset(asset: ImageAsset | undefined): ImageAsset | undefined {
  if (!asset?.map?.cloudBuilt || !asset.depth) return asset;
  let depth = asset.depth;
  while (Math.max(depth.w, depth.h) > MAP_LOCAL_MAX_PX) depth = halveDepth(depth);
  return depth === asset.depth ? asset : { ...asset, depth };
}
