import type { Path } from './geom2d';
import { strokeTextCentered, textWidth } from './strokefont';
import type { MapSpec } from './mapSpec';
import type { Part } from './slicer';
import { attributionEtchPaths } from './mapAttributionEtch';

export function editionEtchPaths(part: Part, edition: number): Path[] {
  if (!Number.isFinite(edition) || edition < 1) return [];
  const bb = part.bbox;
  const h = Math.max(3, Math.min(6, (bb.maxX - bb.minX) / 28));
  const text = `Edition ${Math.round(edition)}`;
  const cx = bb.maxX - textWidth(text, h) / 2 - h;
  const cy = bb.maxY - h * 1.2;
  return strokeTextCentered(text, cx, cy, h);
}

/** Bottom-plate ETCH: attribution, edition number, commemorative line (T14/T25/T26). */
export function mapBackPlateEtchPaths(part: Part, map: MapSpec): Path[] {
  const out: Path[] = [];
  out.push(...attributionEtchPaths(part, map.attribution));
  if (map.editionNumber != null) out.push(...editionEtchPaths(part, map.editionNumber));
  if (map.commemorativeText?.trim()) {
    const bb = part.bbox;
    const faceW = bb.maxX - bb.minX;
    const h = Math.max(2.5, Math.min(5, faceW / 36));
    const text = map.commemorativeText.trim();
    if (textWidth(text, h) <= faceW - 4) {
      out.push(...strokeTextCentered(text, (bb.minX + bb.maxX) / 2, bb.minY + h * 2.2, h));
    }
  }
  return out;
}

export function commemorativeFitWarning(text: string, faceWidthMm: number): string | null {
  const t = text.trim();
  if (!t) return null;
  const h = Math.max(2.5, Math.min(5, faceWidthMm / 36));
  if (textWidth(t, h) > faceWidthMm - 4) {
    return `Commemorative text does not fit on back plate at ${h.toFixed(1)} mm cap height`;
  }
  return null;
}
