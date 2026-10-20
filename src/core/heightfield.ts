// The eroded-strata height field: plate top edges are read from H(x, z).
import { fbm } from './rng';
import { sample, sampleProfile, silhouetteProfile, type Gray } from './image';
import type { Values } from './params';

export interface HeightField {
  /** Height of the plate top above the base top, at world (x, z). */
  at(x: number, z: number): number;
  /** Erosion-only component, for previews. */
  min: number;
  max: number;
  /** Uniform scale so map tops fit a user-set Plate height (never clip). */
  heightCapScale?: number;
  /**
   * Where the side picture sinks below the floor and is cut flat there: the share
   * of the picture (its background left out) and how far the plates must rise to clear it.
   */
  floorClip?: { fraction: number; liftMm: number };
  /**
   * Image as height with a cut-off set: the side picture's brightness (0..1) at world (x, z),
   * and the window it must sit inside for there to be any plate there.
   */
  sideCut?: { grey(x: number, z: number): number; lo: number; hi: number };
}

/** The side picture's cut-offs as 0..1 brightness, or null when both are off. */
export function sideCutWindow(v: Values): { lo: number; hi: number } | null {
  const lo = Math.min(1, Math.max(0, (Number(v.imgCutLow) || 0) / 100));
  const hi = Math.min(1, Math.max(0, (v.imgCutHigh == null ? 100 : Number(v.imgCutHigh)) / 100));
  return lo > 0 || hi < 1 ? { lo, hi } : null;
}

/** Plate tops never go lower than this above the base top; anything the field asks below it is cut flat. */
export const PLATE_FLOOR_MM = 4;

export interface StackFrame {
  /** Unit vector along the stack (plate normal for parallel stacks), in XZ. */
  stack: [number, number];
  /** Unit vector across the stack (along each plate), in XZ. */
  across: [number, number];
  stackLen: number;
  acrossLen: number;
}

export function stackFrame(v: Values): StackFrame {
  const alongWidth = v.sliceMode !== 'radial' && v.sliceAxis === 'width';
  return alongWidth
    ? { stack: [0, 1], across: [1, 0], stackLen: v.baseWidth, acrossLen: v.baseLength }
    : { stack: [1, 0], across: [0, 1], stackLen: v.baseLength, acrossLen: v.baseWidth };
}

export function buildHeightField(v: Values, sideImg: Gray | null): HeightField {
  const f = stackFrame(v);
  const scale = Math.max(1, v.erosionScale);
  const pitch = Math.max(0.5, v.sliceMode === 'radial' ? 10 : v.pitch);
  const c = Math.min(0.999, Math.max(0, v.coherence));
  const alongScale = Math.min(1e7, pitch / ((1 - c) * (1 - c)));
  const amp = v.erosionAmp;
  const band = Math.max(0.5, v.bandHeight);
  const banding = Math.min(1, Math.max(0, v.banding));
  const seed = Math.round(v.seed);
  const mode = sideImg ? v.imgSideMode : 'off';
  const mix = mode === 'off' ? 0 : v.imgMix;
  const sil = mode === 'silhouette' && sideImg ? silhouetteProfile(sideImg) : null;
  const range = v.imgRange;
  // relief in millimetres: background (darkest) at mmBase, brightest mmDepth above it, never below the floor
  const mm = mode === 'heightmap' && v.imgReliefSet === 'mm';
  const mmBase = Math.max(PLATE_FLOOR_MM, Number(v.imgReliefBase) || 0);
  const mmDepth = Math.max(0, Number(v.imgReliefDepth) || 0);

  const smooth = (e0: number, e1: number, x: number) => {
    if (e1 <= e0) return x < e0 ? 0 : 1;
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  // the field before the floor, s along the stack and a across it (mm from the centre)
  const rawAt = (s: number, a: number) => {
    const sn = s / f.stackLen + 0.5; // 0..1 along the base
    const an = a / f.acrossLen + 0.5;
    let e = amp * fbm(a / scale, s / alongScale + 0.37, seed, v.octaves, v.roughness);
    if (banding > 0) {
      const q = e / band;
      const fl = Math.floor(q);
      const r = q - fl;
      const w = (1 - banding) * 0.5;
      const terr = (fl + smooth(0.5 - w, 0.5 + w, r)) * band;
      e = e + (terr - e) * banding;
    }
    if (mm && sideImg) return mmBase + sample(sideImg, sn, 1 - an) * mmDepth;
    let img = 0;
    if (mix > 0 && sideImg) {
      if (mode === 'heightmap') {
        // image x runs along the stack (one strip per plate), image y across each plate
        img = sample(sideImg, sn, 1 - an) * range - range / 2;
      } else if (sil) {
        img = sampleProfile(sil, an) * range - range / 2;
      }
    }
    const base = v.stackHeight + v.crest * Math.sin(Math.PI * Math.min(1, Math.max(0, sn))) + v.slope * (sn - 0.5);
    return base + e * (1 - mix) + img * mix;
  };
  const at = (x: number, z: number) => Math.max(PLATE_FLOOR_MM, rawAt(x * f.stack[0] + z * f.stack[1], x * f.across[0] + z * f.across[1]));

  // estimate range for previews
  let min = Infinity, max = -Infinity;
  for (let i = 0; i <= 24; i++)
    for (let j = 0; j <= 12; j++) {
      const s = (i / 24 - 0.5) * f.stackLen;
      const a = (j / 12 - 0.5) * f.acrossLen;
      const h = at(s * f.stack[0] + a * f.across[0], s * f.stack[1] + a * f.across[1]);
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  const cut = (mix > 0 || mm) && mode === 'heightmap' && sideImg ? sideCutWindow(v) : null;
  const floorClip = mix > 0 && !mm && mode === 'heightmap' && sideImg ? sideFloorClip(sideImg, (sn, an) => rawAt((sn - 0.5) * f.stackLen, (an - 0.5) * f.acrossLen), Math.min(0.45, Math.max(0, v.sideMargin) / Math.max(1, f.acrossLen)), cut) : undefined;
  const sideCut = cut && sideImg
    ? {
        ...cut,
        grey: (x: number, z: number) => {
          const s = x * f.stack[0] + z * f.stack[1], a = x * f.across[0] + z * f.across[1];
          return sample(sideImg, s / f.stackLen + 0.5, 1 - (a / f.acrossLen + 0.5));
        },
      }
    : undefined;
  return { at, min, max, ...(floorClip ? { floorClip } : {}), ...(sideCut ? { sideCut } : {}) };
}

/**
 * How much of the side picture the floor cuts flat. The picture's background
 * (its darkest level, where a depth map leaves the backdrop) is meant to sit
 * low, so only the rest counts.
 */
function sideFloorClip(img: Gray, rawAt: (sn: number, an: number) => number, margin: number, cut: { lo: number; hi: number } | null): HeightField['floorClip'] {
  let lo = Infinity;
  for (let i = 0; i < img.data.length; i++) lo = Math.min(lo, img.data[i]);
  const NS = 160, NA = 64;
  const raws: number[] = [];
  for (let i = 0; i <= NS; i++)
    for (let j = 0; j <= NA; j++) {
      const sn = i / NS;
      const an = margin + (j / NA) * (1 - 2 * margin);
      const g = sample(img, sn, 1 - an);
      // the background, and anything past a cut-off (no plate there at all), can't be cut flat
      if (g <= lo + 0.02 || (cut && (g < cut.lo || g > cut.hi))) continue;
      raws.push(rawAt(sn, an));
    }
  const clipped = raws.filter((r) => r < PLATE_FLOOR_MM).length;
  if (!raws.length || clipped / raws.length < 0.01) return undefined;
  // the lowest 1% is the soft rim where the picture fades into its backdrop: letting that touch the floor is fine
  raws.sort((a, b) => a - b);
  return { fraction: clipped / raws.length, liftMm: PLATE_FLOOR_MM - raws[Math.floor(raws.length * 0.01)] };
}
