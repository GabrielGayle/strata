// Candle master: the source form cut into flat layers is glued up into a
// solid, stratified copy of the candle (the master). A silicone mould is cast
// around it, and candles poured into that mould carry the layer lines. Each
// layer also gets a frame; stacked, the frames are the box the silicone is
// poured into. A pin through every layer lines the glue-up up and, standing
// proud of the top, casts the wick hole.
import { circlePath, difference, rect, shapeArea, unionShapes, type Shape } from './geom2d';
import type { IndexedMesh } from './forms';
import type { Values } from './params';

/** g/cm³: paraffin wax, and a typical platinum-cure mould silicone. */
export const WAX_DENSITY = 0.9;
export const SILICONE_DENSITY = 1.1;

/** Where the master sits, in plan coordinates (u = x, v = -z), and how tall it is above the bottom layer. */
export interface MasterFrame {
  cu: number;
  cv: number;
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  top: number;
}

export interface MasterSummary {
  /** Stratified master (the candle as cast), mm³. */
  volume: number;
  /** Height of the master: its top layer's top, mm. */
  height: number;
  /** Inside of the box: the silicone block, mm. */
  inner: { w: number; d: number; h: number };
  /** Silicone to fill the box around the master, mm³. */
  silicone: number;
  /** The centre pin: diameter and length (through every master layer plus the part above the top), mm. 0 when off. */
  pin: { d: number; length: number };
  masterLayers: number;
  frameLayers: number;
  /** Layers the box needs (master plus silicone over the top). */
  layersNeeded: number;
}

export const isCandleMaster = (v: Values) => !!v.cmOn && v.sliceMode === 'flat' && v.stackSource === 'form';

/** The master's footprint and height from the source form; `base` is the height of the bottom layer's underside. */
export function masterFrame(mesh: IndexedMesh, base: number): MasterFrame | null {
  const p = mesh.pos;
  if (p.length < 3) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let top = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]);
    maxX = Math.max(maxX, p[i]);
    top = Math.max(top, p[i + 1]);
    minZ = Math.min(minZ, p[i + 2]);
    maxZ = Math.max(maxZ, p[i + 2]);
  }
  // plan v is -z
  return { cu: (minX + maxX) / 2, cv: -(minZ + maxZ) / 2, minU: minX, maxU: maxX, minV: -maxZ, maxV: -minZ, top: top - base };
}

/** The frame round one layer: the box wall, `wall` mm of silicone clear of the master. */
export function frameRing(f: MasterFrame, v: Values): Shape {
  if (v.cmFrame <= 0) return [];
  const w = v.cmWall;
  const inner = rect(f.minU - w, f.minV - w, f.maxU + w, f.maxV + w);
  const outer = rect(f.minU - w - v.cmFrame, f.minV - w - v.cmFrame, f.maxU + w + v.cmFrame, f.maxV + w + v.cmFrame);
  return difference(outer, inner);
}

/**
 * Turn each layer's section of the form into a master layer: the pin hole
 * through it, and the frame beside it while the box still has to rise.
 * `sections[i]` is layer i's section; layer i spans i·t to (i + 1)·t.
 */
export function masterLayers(sections: Shape[], f: MasterFrame, v: Values): { outlines: Shape[]; summary: MasterSummary } {
  const t = v.thickness;
  const ring = frameRing(f, v);
  const pin = v.cmPin > 0 ? [{ outer: circlePath(f.cu, f.cv, v.cmPin / 2, 32), holes: [] }] : [];
  const boxTop = f.top + v.cmCover;
  let volume = 0;
  let masterLayers = 0;
  let frameLayers = 0;
  let height = 0;
  const outlines = sections.map((sec, i) => {
    const body = pin.length && sec.length ? difference(sec, pin) : sec;
    if (sec.length) {
      volume += shapeArea(sec) * t;
      masterLayers++;
      height = (i + 1) * t;
    }
    const framed = ring.length && i * t < boxTop - 1e-6;
    if (framed) frameLayers++;
    return framed ? unionShapes(body, ring) : body;
  });
  const w = f.maxU - f.minU + 2 * v.cmWall;
  const d = f.maxV - f.minV + 2 * v.cmWall;
  const h = ring.length ? frameLayers * t : height + v.cmCover;
  const pinLength = v.cmPin > 0 ? height + v.cmPinOut : 0;
  const pinVol = v.cmPin > 0 ? Math.PI * (v.cmPin / 2) ** 2 * Math.max(0, Math.min(h, pinLength) - height) : 0;
  return {
    outlines,
    summary: {
      volume,
      height,
      inner: { w, d, h },
      silicone: Math.max(0, w * d * h - volume - pinVol),
      pin: { d: v.cmPin > 0 ? v.cmPin : 0, length: pinLength },
      masterLayers,
      frameLayers,
      layersNeeded: Math.ceil((f.top + v.cmCover) / t - 1e-6),
    },
  };
}

const g = (mm3: number, density: number) => (mm3 / 1000) * density;

/** Bought-in lines for the master: silicone (with 10% for mixing and spills), wax per candle, the pin rod. */
export function masterShopping(s: MasterSummary): { item: string; spec: string; qty: string; note: string }[] {
  const out = [
    { item: 'Mould silicone', spec: 'platinum or tin cure, two-part', qty: `${Math.ceil(g(s.silicone, SILICONE_DENSITY) * 1.1)} g`, note: `${(s.silicone / 1000).toFixed(0)} cm³ to fill the box, plus 10% for mixing` },
    { item: 'Candle wax', spec: 'paraffin or soy', qty: `${Math.ceil(g(s.volume, WAX_DENSITY))} g per candle`, note: `${(s.volume / 1000).toFixed(0)} cm³ per candle; keep about 10% back to top up as it shrinks` },
  ];
  if (s.pin.d > 0) out.push({ item: 'Centre pin', spec: `Ø${s.pin.d} mm rod (steel or brass)`, qty: `1 × ${Math.ceil(s.pin.length)} mm`, note: `through every layer and ${Math.ceil(s.pin.length - s.height)} mm above the top for the wick hole` });
  return out;
}

export function masterText(s: MasterSummary): string {
  const lines = [
    'Candle master',
    '=============',
    '',
    `Master: ${s.masterLayers} layers, ${s.height.toFixed(0)} mm tall, ${(s.volume / 1000).toFixed(0)} cm³ (the candle as it will cast).`,
    `Box inside: ${s.inner.w.toFixed(0)} × ${s.inner.d.toFixed(0)} mm, ${s.inner.h.toFixed(0)} mm deep (${s.frameLayers} frame layers).`,
    '',
    'To buy:',
    ...masterShopping(s).map((r) => `  - ${r.item} (${r.spec}): ${r.qty}. ${r.note}.`),
    '',
    'Making it:',
    '  1. Glue the master layers in order on the centre pin, bottom layer first. Fill and sand only if you want the layer lines softer.',
    '  2. Glue the frames into a box around it on a flat board (glass or acrylic). Seal the inside seams and the foot with tape or hot glue so silicone cannot creep out.',
    '  3. Seal the master (shellac or clear coat) and brush on mould release.',
    '  4. Mix the silicone, pour it slowly into a corner and let it rise over the master. Leave it to cure as the kit says.',
    '  5. Lift the box off, flex the silicone off the master and pull out the pin: its hole is the wick hole.',
    '  6. Thread a wick through the hole, stand the mould open side up and pour the wax. Top up as it shrinks.',
  ];
  return lines.join('\n') + '\n';
}
