import type { ImageAsset, Project } from './project';
import type { MapSpec } from './mapSpec';
import { defaultMapSpec } from './mapSpec';
import { mapBuildKey } from './mapBuildKey';
import { mapStackFromProject } from './mapStack';

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
    },
  };
  return { ...project, images: { ...project.images, top: merged } };
}
