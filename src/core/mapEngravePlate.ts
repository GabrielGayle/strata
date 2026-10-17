import { clipLines, type Path } from './geom2d';
import type { MapEngraveArt } from './mapOsmEngrave';
import { strokeTextCentered, textWidth } from './strokefont';
import type { Part } from './slicer';
import { resolveEngravePreset } from './mapEngravePresets';
import { etchKeepOut, LABEL_HOLE_CLEAR_MM } from './stackRods';

export interface MapEngravePlateContext {
  /** Width of map on top face in mm (along plate u). */
  faceW: number;
  /** Depth along stack in mm. */
  faceH: number;
  presetId?: string;
  title?: string;
}

/**
 * Map image-space paths into a part's local mm.
 * Art x=0 is west; plate +x runs west so a north-facing drawing has east at minX.
 */
export function mapEngravePathsForPart(part: Part, art: MapEngraveArt, ctx: MapEngravePlateContext): Path[] {
  const bb = part.bbox;
  const pw = bb.maxX - bb.minX;
  const ph = bb.maxY - bb.minY;
  if (pw < 1 || ph < 1) return [];
  const sx = pw / art.imageW;
  const sy = ph / art.imageH;
  const tf = (p: Path): Path => p.map(([x, y]) => [bb.maxX - x * sx, bb.minY + y * sy]);
  const keep = etchKeepOut(part.shape, LABEL_HOLE_CLEAR_MM, 0.4);
  const out: Path[] = [];
  for (const ln of art.lines) out.push(...clipLines([tf(ln.path)], keep));
  const typo = resolveEngravePreset(ctx.presetId);
  if (ctx.title) {
    const h = Math.min(typo.titleHeightMm, ph * 0.2);
    const cx = (bb.minX + bb.maxX) / 2;
    const cy = bb.maxY - h * 0.8;
    const tw = textWidth(ctx.title, h * typo.titleScale);
    if (tw <= pw - 2) {
      out.push(...clipLines(strokeTextCentered(ctx.title, cx, cy, h * typo.titleScale), keep));
    }
  }
  for (const t of art.texts) {
    const h = typo.labelHeightMm * typo.labelScale;
    const cx = bb.maxX - t.nx * pw;
    const cy = bb.minY + t.ny * ph;
    if (textWidth(t.text, h) > pw * 0.9) continue;
    out.push(...clipLines(strokeTextCentered(t.text, cx, cy, h), keep));
  }
  return out;
}
