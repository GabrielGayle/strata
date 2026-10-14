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
}

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

  const smooth = (e0: number, e1: number, x: number) => {
    if (e1 <= e0) return x < e0 ? 0 : 1;
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  const at = (x: number, z: number) => {
    const s = x * f.stack[0] + z * f.stack[1];
    const a = x * f.across[0] + z * f.across[1];
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
    return Math.max(4, base + e * (1 - mix) + img * mix);
  };

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
  return { at, min, max };
}
