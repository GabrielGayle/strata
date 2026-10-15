// Skyline bottom-left nesting of part bounding boxes onto sheets.

export interface NestItem {
  id: string;
  w: number;
  h: number;
  area: number;
}

export interface Placement {
  id: string;
  x: number; // position of the (possibly rotated) bbox min corner on the sheet
  y: number;
  w: number;
  h: number;
  rot: boolean; // rotated 90° CCW
}

export interface NestSheet {
  index: number;
  placements: Placement[];
  used: number; // part area placed
  /** Metal on this sheet, when the plates mix metals (each is cut on its own sheets). */
  material?: string;
}

export interface NestResult {
  sheets: NestSheet[];
  unplaced: string[];
  sheetW: number;
  sheetH: number;
  utilisation: number;
}

interface Sky {
  x: number;
  y: number;
  w: number;
}

class SkylineSheet {
  sky: Sky[];
  constructor(public W: number, public H: number) {
    this.sky = [{ x: 0, y: 0, w: W }];
  }
  find(w: number, h: number): { x: number; y: number; idx: number } | null {
    let best: { x: number; y: number; idx: number } | null = null;
    for (let i = 0; i < this.sky.length; i++) {
      const x = this.sky[i].x;
      if (x + w > this.W + 1e-9) break;
      let y = 0;
      let rem = w;
      for (let j = i; j < this.sky.length && rem > 1e-9; j++) {
        y = Math.max(y, this.sky[j].y);
        rem -= this.sky[j].w;
      }
      if (y + h > this.H + 1e-9) continue;
      if (!best || y < best.y - 1e-9 || (Math.abs(y - best.y) < 1e-9 && x < best.x)) best = { x, y, idx: i };
    }
    return best;
  }
  place(x: number, y: number, w: number, h: number) {
    const top = y + h;
    const next: Sky[] = [];
    for (const s of this.sky) {
      const s0 = s.x, s1 = s.x + s.w;
      if (s1 <= x + 1e-9 || s0 >= x + w - 1e-9) {
        next.push(s);
        continue;
      }
      if (s0 < x) next.push({ x: s0, y: s.y, w: x - s0 });
      if (s1 > x + w) next.push({ x: x + w, y: s.y, w: s1 - (x + w) });
    }
    next.push({ x, y: top, w });
    next.sort((a, b) => a.x - b.x);
    const merged: Sky[] = [];
    for (const s of next) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.y - s.y) < 1e-9 && Math.abs(last.x + last.w - s.x) < 1e-6) last.w += s.w;
      else merged.push({ ...s });
    }
    this.sky = merged;
  }
}

export function nest(items: NestItem[], sheetW: number, sheetH: number, spacing: number): NestResult {
  const W = sheetW - spacing;
  const H = sheetH - spacing;
  const sorted = [...items].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.area - a.area);
  const sheets: { sk: SkylineSheet; out: NestSheet }[] = [];
  const unplaced: string[] = [];
  for (const it of sorted) {
    const opts = [
      { w: it.w + spacing, h: it.h + spacing, rot: false },
      { w: it.h + spacing, h: it.w + spacing, rot: true },
    ];
    let done = false;
    const tryOn = (s: { sk: SkylineSheet; out: NestSheet }) => {
      let best: { x: number; y: number; o: (typeof opts)[0] } | null = null;
      for (const o of opts) {
        const f = s.sk.find(o.w, o.h);
        if (f && (!best || f.y + o.h < best.y + best.o.h - 1e-9)) best = { x: f.x, y: f.y, o };
      }
      if (!best) return false;
      s.sk.place(best.x, best.y, best.o.w, best.o.h);
      s.out.placements.push({ id: it.id, x: best.x + spacing, y: best.y + spacing, w: best.o.w - spacing, h: best.o.h - spacing, rot: best.o.rot });
      s.out.used += it.area;
      return true;
    };
    for (const s of sheets) if (tryOn(s)) { done = true; break; }
    if (!done) {
      const s = { sk: new SkylineSheet(W, H), out: { index: sheets.length, placements: [], used: 0 } as NestSheet };
      if (tryOn(s)) {
        sheets.push(s);
        done = true;
      }
    }
    if (!done) unplaced.push(it.id);
  }
  const used = sheets.reduce((a, s) => a + s.out.used, 0);
  return {
    sheets: sheets.map((s) => s.out),
    unplaced,
    sheetW,
    sheetH,
    utilisation: sheets.length ? used / (sheets.length * sheetW * sheetH) : 0,
  };
}

/** Nest each group onto its own sheets (one metal per sheet), numbered in group order. */
export function nestGroups(groups: { material: string; items: NestItem[] }[], sheetW: number, sheetH: number, spacing: number): NestResult {
  if (groups.length <= 1) return nest(groups[0]?.items ?? [], sheetW, sheetH, spacing);
  const sheets: NestSheet[] = [];
  const unplaced: string[] = [];
  for (const g of groups) {
    const r = nest(g.items, sheetW, sheetH, spacing);
    for (const s of r.sheets) sheets.push({ ...s, index: sheets.length, material: g.material });
    unplaced.push(...r.unplaced);
  }
  const used = sheets.reduce((a, s) => a + s.used, 0);
  return { sheets, unplaced, sheetW, sheetH, utilisation: sheets.length ? used / (sheets.length * sheetW * sheetH) : 0 };
}
