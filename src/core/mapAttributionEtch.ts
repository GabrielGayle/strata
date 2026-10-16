import type { Path } from './geom2d';
import { strokeTextCentered, textWidth } from './strokefont';
import type { Part } from './slicer';

/** Licence / attribution lines etched on the back (bottom) plate face (ticket T14). */
export function attributionEtchPaths(part: Part, lines: string[]): Path[] {
  if (!lines.length) return [];
  const bb = part.bbox;
  const faceW = bb.maxX - bb.minX;
  const cap = Math.max(2, Math.min(3.2, faceW / 48));
  const out: Path[] = [];
  let y = bb.minY + cap * 1.4;
  for (const raw of lines.slice(0, 10)) {
    const line = raw.trim();
    if (!line) continue;
    const text = line.length > 96 ? `${line.slice(0, 93)}…` : line;
    const h = cap;
    if (textWidth(text, h) > faceW - 4) continue;
    out.push(...strokeTextCentered(text, (bb.minX + bb.maxX) / 2, y, h));
    y += cap * 1.45;
    if (y > bb.maxY - cap * 1.2) break;
  }
  return out;
}
