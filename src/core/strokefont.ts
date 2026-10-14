// Single-stroke font so part numbers etch as plain lines (no TEXT entities,
// no fonts needed in the laser software). Glyphs live on a 4 x 6 grid.
import type { Path } from './geom2d';

type G = number[][]; // list of polylines, flat [x0,y0,x1,y1,...]

const GLYPHS: Record<string, G> = {
  '0': [[0, 0, 4, 0, 4, 6, 0, 6, 0, 0], [0, 0, 4, 6]],
  '1': [[1, 5, 2, 6, 2, 0], [1, 0, 3, 0]],
  '2': [[0, 6, 4, 6, 4, 3, 0, 3, 0, 0, 4, 0]],
  '3': [[0, 6, 4, 6, 4, 0, 0, 0], [1, 3, 4, 3]],
  '4': [[0, 6, 0, 3, 4, 3], [3, 6, 3, 0]],
  '5': [[4, 6, 0, 6, 0, 3, 4, 3, 4, 0, 0, 0]],
  '6': [[4, 6, 0, 6, 0, 0, 4, 0, 4, 3, 0, 3]],
  '7': [[0, 6, 4, 6, 1, 0]],
  '8': [[0, 0, 4, 0, 4, 6, 0, 6, 0, 0], [0, 3, 4, 3]],
  '9': [[4, 3, 0, 3, 0, 6, 4, 6, 4, 0, 0, 0]],
  A: [[0, 0, 0, 4, 2, 6, 4, 4, 4, 0], [0, 3, 4, 3]],
  B: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3], [3, 3, 4, 2, 4, 1, 3, 0, 0, 0]],
  C: [[4, 6, 0, 6, 0, 0, 4, 0]],
  D: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 1, 3, 0, 0, 0]],
  E: [[4, 6, 0, 6, 0, 0, 4, 0], [0, 3, 3, 3]],
  F: [[4, 6, 0, 6, 0, 0], [0, 3, 3, 3]],
  G: [[4, 6, 0, 6, 0, 0, 4, 0, 4, 3, 2, 3]],
  H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
  I: [[1, 6, 3, 6], [2, 6, 2, 0], [1, 0, 3, 0]],
  J: [[4, 6, 4, 0, 0, 0, 0, 2]],
  K: [[0, 0, 0, 6], [4, 6, 0, 3, 4, 0]],
  L: [[0, 6, 0, 0, 4, 0]],
  M: [[0, 0, 0, 6, 2, 3, 4, 6, 4, 0]],
  N: [[0, 0, 0, 6, 4, 0, 4, 6]],
  O: [[0, 0, 4, 0, 4, 6, 0, 6, 0, 0]],
  P: [[0, 0, 0, 6, 4, 6, 4, 3, 0, 3]],
  Q: [[0, 0, 4, 0, 4, 6, 0, 6, 0, 0], [2, 2, 4, -1]],
  R: [[0, 0, 0, 6, 4, 6, 4, 3, 0, 3, 4, 0]],
  S: [[4, 6, 0, 6, 0, 3, 4, 3, 4, 0, 0, 0]],
  T: [[0, 6, 4, 6], [2, 6, 2, 0]],
  U: [[0, 6, 0, 0, 4, 0, 4, 6]],
  V: [[0, 6, 2, 0, 4, 6]],
  W: [[0, 6, 1, 0, 2, 3, 3, 0, 4, 6]],
  X: [[0, 0, 4, 6], [0, 6, 4, 0]],
  Y: [[0, 6, 2, 3, 4, 6], [2, 3, 2, 0]],
  Z: [[0, 6, 4, 6, 0, 0, 4, 0]],
  '-': [[1, 3, 3, 3]],
  '.': [[2, 0, 2, 0.6]],
  '/': [[0, 0, 4, 6]],
  ' ': [],
};

const ADVANCE = 5.5;

export function textWidth(text: string, h: number): number {
  return Math.max(0, (text.length * ADVANCE - 1.5) * (h / 6));
}

/** Polylines for `text` with its bottom-left corner at (x, y) and cap height h. */
export function strokeText(text: string, x: number, y: number, h: number): Path[] {
  const k = h / 6;
  const out: Path[] = [];
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch] ?? GLYPHS['-'];
    for (const line of g) {
      const p: Path = [];
      for (let i = 0; i < line.length; i += 2) p.push([cx + line[i] * k, y + line[i + 1] * k]);
      out.push(p);
    }
    cx += ADVANCE * k;
  }
  return out;
}

export function strokeTextCentered(text: string, cx: number, cy: number, h: number): Path[] {
  return strokeText(text, cx - textWidth(text, h) / 2, cy - h / 2, h);
}
