import type { MapSpec } from './mapSpec';
import { mapBackPlateEtchPaths } from './mapBackPlateEtch';
import { mapEngravePathsForPart } from './mapEngravePlate';
import { deserializeMapEngraveArt } from './mapOsmEngrave';
import type { SliceResult } from './slicer';

/** Attach clipped map credits / OSM paths so the fit check sees every etch layer. */
export function attachMapPartEtch(sliced: SliceResult, map?: MapSpec | null): void {
  const pParts = sliced.parts.filter((p) => p.family === 'P');
  if (!pParts.length) return;
  if (!map) {
    for (const part of pParts) {
      delete part.exportEtch;
      delete part.exportEngrave;
    }
    return;
  }
  const bottom = Math.min(...pParts.map((p) => p.index));
  const top = Math.max(...pParts.map((p) => p.index));
  const art = map.engraveArt && map.engrave.enabled ? deserializeMapEngraveArt(map.engraveArt) : null;
  for (const part of sliced.parts) {
    if (part.family !== 'P') continue;
    if (part.index === bottom) part.exportEtch = mapBackPlateEtchPaths(part, map);
    else delete part.exportEtch;
    if (art && part.index === top) {
      part.exportEngrave = mapEngravePathsForPart(part, art, {
        faceW: part.bbox.maxX - part.bbox.minX,
        faceH: part.bbox.maxY - part.bbox.minY,
        presetId: map.engrave.preset,
        title: map.engrave.features.includes('title') ? map.title : undefined,
      });
    } else delete part.exportEngrave;
  }
}
