import * as THREE from 'three';
import type { Part } from '../core/slicer';
import type { Shape } from '../core/geom2d';
import type { Plane } from '../core/section';
import { planeMatrix } from '../core/geometry3d';

/**
 * View aids: ways of drawing the plates that make one plate's edge stand out from the next
 * in a dense stack. View only: none of them touch the cut geometry or exports.
 */
export type PlateTint = 'off' | 'alternate' | 'rainbow' | 'height';

export interface ViewAids {
  /** Dark line round every plate face, so each top edge reads against the plate behind it. */
  outlines: boolean;
  tint: PlateTint;
  /** Pull parallel plates apart along their normal (1 = as built). */
  spread: number;
}

export const DEFAULT_VIEW_AIDS: ViewAids = { outlines: false, tint: 'off', spread: 1 };

export const TINT_LABELS: Record<PlateTint, string> = {
  off: 'Metal',
  alternate: 'Alternate',
  rainbow: 'Rainbow',
  height: 'Height bands',
};

export const SPREAD_STEPS = [1, 1.5, 2, 3];

const KEY = 'strata.viewAids.v1';

export function loadViewAids(): ViewAids {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_VIEW_AIDS };
    const p = JSON.parse(raw) as Partial<ViewAids>;
    return {
      outlines: typeof p.outlines === 'boolean' ? p.outlines : DEFAULT_VIEW_AIDS.outlines,
      tint: p.tint && p.tint in TINT_LABELS ? p.tint : DEFAULT_VIEW_AIDS.tint,
      spread: typeof p.spread === 'number' && SPREAD_STEPS.includes(p.spread) ? p.spread : DEFAULT_VIEW_AIDS.spread,
    };
  } catch {
    return { ...DEFAULT_VIEW_AIDS };
  }
}

export function saveViewAids(a: ViewAids): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* private mode */
  }
}

/**
 * How far each plate moves for Spread, keyed by part id. Plates move along their own normal,
 * scaled away from their family's middle, so a parallel stack opens up evenly and radial
 * plates (whose planes pass through the centre) stay put.
 */
export function spreadOffsets(parts: Part[], spread: number): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  if (spread === 1 || !parts.length) return out;
  const along = (p: Part) => p.plane.origin[0] * p.plane.normal[0] + p.plane.origin[1] * p.plane.normal[1] + p.plane.origin[2] * p.plane.normal[2];
  const mid = new Map<string, { sum: number; n: number }>();
  for (const p of parts) {
    const m = mid.get(p.family) ?? { sum: 0, n: 0 };
    m.sum += along(p);
    m.n++;
    mid.set(p.family, m);
  }
  for (const p of parts) {
    const m = mid.get(p.family)!;
    const d = (along(p) - m.sum / m.n) * (spread - 1);
    if (Math.abs(d) < 1e-6) continue;
    const n = p.plane.normal;
    out.set(p.id, [n[0] * d, n[1] * d, n[2] * d]);
  }
  return out;
}

/** Plate colour for the Alternate and Rainbow tints (null: keep the metal). */
export function tintColor(tint: PlateTint, base: string, index: number, count: number): string | null {
  if (tint === 'alternate') {
    const c = new THREE.Color(base);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    // light / dark pairs, far enough apart to read in shadow
    // (lightness here is linear, so 0.05 reads as a deep grey and 0.45 as a pale one)
    const l = index % 2 ? Math.min(0.6, Math.max(0.45, hsl.l + 0.3)) : Math.max(0.035, Math.min(hsl.l, 0.06));
    return '#' + new THREE.Color().setHSL(hsl.h, Math.min(hsl.s, 0.35), l).getHexString();
  }
  if (tint === 'rainbow') {
    const t = count > 1 ? index / (count - 1) : 0;
    return '#' + new THREE.Color().setHSL(0.72 * t, 0.62, 0.52).getHexString();
  }
  return null;
}

/** Edge line colour: light on dark steel, dark on light or tinted plates. */
export function outlineColor(tint: PlateTint, plateColor: string): string {
  if (tint === 'alternate' || tint === 'rainbow' || tint === 'height') return '#161616';
  const c = new THREE.Color(plateColor);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return lum < 0.3 ? '#f2ead8' : '#161616';
}

/** Closed rings of a part's outline (and holes) traced on both faces, just proud of the steel. */
export function outlineSegments(shape: Shape, thickness: number, plane: Plane, out: number[], offset?: [number, number, number]): void {
  const m = planeMatrix(plane);
  if (offset) m.premultiply(new THREE.Matrix4().makeTranslation(offset[0], offset[1], offset[2]));
  const v = new THREE.Vector3();
  const rings = shape.flatMap((ex) => [ex.outer, ...ex.holes]);
  for (const w of [-thickness / 2 - 0.05, thickness / 2 + 0.05]) {
    for (const r of rings) {
      for (let i = 0; i < r.length; i++) {
        const a = r[i];
        const b = r[(i + 1) % r.length];
        v.set(a[0], a[1], w).applyMatrix4(m);
        out.push(v.x, v.y, v.z);
        v.set(b[0], b[1], w).applyMatrix4(m);
        out.push(v.x, v.y, v.z);
      }
    }
  }
}

/**
 * Height bands: plates coloured from low (deep blue) to high (warm sand) by world height,
 * with a thin dark contour every `step` mm. A shader patch, so orbiting costs nothing extra.
 */
export function makeHeightBandMaterial(look: { metalness: number; roughness: number }): THREE.MeshStandardMaterial & {
  setRange: (lo: number, hi: number, step: number) => void;
} {
  const uniforms = { uLo: { value: 0 }, uHi: { value: 1 }, uStep: { value: 10 } };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: Math.min(look.metalness, 0.3), roughness: Math.max(look.roughness, 0.6) }) as THREE.MeshStandardMaterial & {
    setRange: (lo: number, hi: number, step: number) => void;
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvHPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHPos;\nuniform float uLo;\nuniform float uHi;\nuniform float uStep;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float t = clamp((vHPos.y - uLo) / max(uHi - uLo, 1e-3), 0.0, 1.0);
  vec3 c0 = vec3(0.10, 0.22, 0.42);
  vec3 c1 = vec3(0.22, 0.55, 0.50);
  vec3 c2 = vec3(0.62, 0.70, 0.38);
  vec3 c3 = vec3(0.90, 0.80, 0.58);
  vec3 c = t < 0.33 ? mix(c0, c1, t / 0.33) : t < 0.66 ? mix(c1, c2, (t - 0.33) / 0.33) : mix(c2, c3, (t - 0.66) / 0.34);
  float f = fract((vHPos.y - uLo) / uStep);
  float w = fwidth((vHPos.y - uLo) / uStep);
  float line = 1.0 - smoothstep(0.0, w * 1.5, min(f, 1.0 - f));
  diffuseColor.rgb = mix(c, c * 0.35, line * 0.85);
}`,
      );
  };
  mat.customProgramCacheKey = () => 'strata-height-bands';
  mat.setRange = (lo, hi, step) => {
    uniforms.uLo.value = lo;
    uniforms.uHi.value = hi;
    uniforms.uStep.value = step;
  };
  return mat;
}

/**
 * World height range of the plate tops (the relief), for Height bands. Uses outline points in
 * the upper half of each plate, so the plate feet and base tabs don't stretch the colours.
 */
export function reliefRange(parts: Part[]): { lo: number; hi: number } {
  const ys: number[] = [];
  const v = new THREE.Vector3();
  for (const p of parts) {
    const m = planeMatrix(p.plane);
    const pts: number[] = [];
    for (const ex of p.shape) for (const q of ex.outer) pts.push(v.set(q[0], q[1], 0).applyMatrix4(m).y);
    if (!pts.length) continue;
    const lo = Math.min(...pts);
    const hi = Math.max(...pts);
    const mid = (lo + hi) / 2;
    for (const y of pts) if (y >= mid) ys.push(y);
  }
  if (!ys.length) return { lo: 0, hi: 1 };
  ys.sort((a, b) => a - b);
  const lo = ys[Math.floor(ys.length * 0.03)];
  const hi = ys[ys.length - 1];
  return hi - lo < 1 ? { lo: lo - 1, hi: hi + 1 } : { lo, hi };
}

/** A contour step that gives roughly 8 to 20 bands over the height range. */
export function contourStep(range: number): number {
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 500]) if (range / s <= 20) return s;
  return 1000;
}
