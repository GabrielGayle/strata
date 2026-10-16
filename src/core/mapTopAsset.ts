import type { ImageAsset, Project } from './project';
import type { MapSpec } from './mapSpec';
import { defaultMapSpec } from './mapSpec';

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
