// Free-free sounding plates, as a xylophone bar rather than a cantilever.
//
// The plate's outline is read as a beam along its height: the local width
// (holes already subtracted) is the beam's width, the sheet thickness is the
// depth it bends through. About 100 Timoshenko elements, then a dense
// generalised eigenproblem small enough to solve by shift-invert subspace
// iteration. The same routine tunes the length and, in the deferred worker,
// reports f1 and the first overtones of the plate that was actually cut.
//
// Reference model: github.com/amosr/xylo (Timoshenko bar, free-free). The
// thin-strip Euler–Bernoulli limit is f = 1.028 · c · t / L² with c = √(E/ρ).
import type { Shape } from './geom2d';
import { MATERIALS } from './tuning';

/** Euler–Bernoulli free-free factor: (4.73004² / 2π) / √12. */
export const EULER_FREE = 1.028;
/** First-mode nodes of a uniform free-free beam, as a fraction of the length. */
export const FREE_NODE = 0.2242;
export const BEAM_ELEMENTS = 100;

const NU = 0.3;
const KAPPA = 5 / 6;
const BENDING_MODES = 3;

/** Bar speed c = √(E/ρ), m/s. Steel ≈ 5050, aluminium ≈ 5050 with the stored moduli. */
export function barSpeed(material: string): number {
  const m = MATERIALS[material] ?? MATERIALS.steel;
  return Math.sqrt(m.E / m.rho);
}

/** Analytic free-free fundamental, f = 1.028 · c · t / L². */
export function analyticFreeHz(lengthMm: number, thicknessMm: number, material: string): number {
  const L = lengthMm / 1000;
  const t = thicknessMm / 1000;
  return (EULER_FREE * barSpeed(material) * t) / (L * L);
}

export interface BeamModes {
  /** Bending partials, low to high, Hz. */
  hz: number[];
  /** Nodes of the first bending mode, fractions of the length from the low end. */
  nodes: number[];
}

export interface BeamSpec {
  lengthMm: number;
  thicknessMm: number;
  /** Rectangle width before holes, mm. Ignored when `widthsMm` is set. */
  widthMm: number;
  material: string;
  /** Mounting-hole radius, mm, on the centreline. */
  holeRmm?: number;
  /** Hole centres as fractions of the length. Defaults to the two free-free nodes. */
  holeAt?: number[];
  elements?: number;
  /** Material width of each element, mm. Holes are already in the numbers. */
  widthsMm?: ArrayLike<number>;
}

/** Material width (mm) of a horizontal station through an outline. Holes subtract. */
export function widthAtY(shape: Shape, y: number): number {
  let w = 0;
  for (const ex of shape) {
    w += spanWidth(ex.outer, y);
    for (const h of ex.holes) w -= spanWidth(h, y);
  }
  return Math.max(0, w);
}

function spanWidth(path: [number, number][], y: number): number {
  const xs: number[] = [];
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const y0 = path[j][1];
    const y1 = path[i][1];
    if ((y0 > y) === (y1 > y)) continue;
    const t = (y - y0) / (y1 - y0);
    xs.push(path[j][0] + t * (path[i][0] - path[j][0]));
  }
  xs.sort((a, b) => a - b);
  let w = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) w += xs[i + 1] - xs[i];
  return w;
}

function elementWidths(spec: BeamSpec, ne: number): Float64Array {
  const w = new Float64Array(ne);
  if (spec.widthsMm && spec.widthsMm.length >= ne) {
    for (let e = 0; e < ne; e++) w[e] = Math.max(0, spec.widthsMm[e]);
    return w;
  }
  const L = spec.lengthMm;
  const half = spec.widthMm / 2;
  const r = Math.max(0, spec.holeRmm ?? 0);
  const at = spec.holeAt ?? [FREE_NODE, 1 - FREE_NODE];
  for (let e = 0; e < ne; e++) {
    const y = ((e + 0.5) / ne) * L;
    let width = spec.widthMm;
    if (r > 0) {
      for (const s of at) {
        const dy = y - s * L;
        if (Math.abs(dy) >= r) continue;
        const chord = Math.sqrt(r * r - dy * dy);
        const a = Math.max(-half, -chord);
        const b = Math.min(half, chord);
        width -= Math.max(0, b - a);
      }
    }
    w[e] = Math.max(0, width);
  }
  return w;
}

/**
 * Free-free bending partials. `lengthMm` runs from the low end of the outline
 * to the high end; width may vary from element to element.
 */
export function beamModes(spec: BeamSpec): BeamModes {
  const ne = spec.elements ?? BEAM_ELEMENTS;
  const mat = MATERIALS[spec.material] ?? MATERIALS.steel;
  const modes = solveBeam(spec.lengthMm / 1000, spec.thicknessMm / 1000, mat.E, mat.rho, elementWidths(spec, ne), ne);
  return modes;
}

/** Partials of a cut outline. The beam runs up the plate (y), holes included. */
export function modesOfOutline(shape: Shape, thicknessMm: number, material: string, elements = BEAM_ELEMENTS): BeamModes & { lengthMm: number } {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ex of shape) {
    for (const p of ex.outer) {
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  const lengthMm = Math.max(1, maxY - minY);
  const widths = new Float64Array(elements);
  for (let e = 0; e < elements; e++) widths[e] = widthAtY(shape, minY + ((e + 0.5) / elements) * lengthMm);
  const modes = beamModes({ lengthMm, thicknessMm, widthMm: 1, material, elements, widthsMm: widths });
  return { ...modes, lengthMm };
}

export interface TunedBar extends BeamModes {
  lengthMm: number;
  /** How far f1 landed from the target, cents (+ = sharp). */
  cents: number;
  iters: number;
}

/**
 * Length whose fundamental is `targetHz`, by secant on 1/L² (the Euler
 * scaling). Mounting holes, if any, ride at the node fractions and are
 * included in the width, so the length already accounts for them.
 */
export function tuneBar(opts: {
  targetHz: number;
  thicknessMm: number;
  widthMm: number;
  material: string;
  holeRmm?: number;
  elements?: number;
}): TunedBar {
  const holeR = opts.holeRmm ?? 0;
  let holeAt = [FREE_NODE, 1 - FREE_NODE];
  let tuned = secant(opts, holeAt);
  if (holeR > 0 && tuned.nodes.length >= 2) {
    const moved = Math.abs(tuned.nodes[0] - holeAt[0]) > 0.002 || Math.abs(tuned.nodes[1] - holeAt[1]) > 0.002;
    if (moved) {
      holeAt = [tuned.nodes[0], tuned.nodes[1]];
      const again = secant(opts, holeAt);
      tuned = { ...again, iters: tuned.iters + again.iters };
    }
  }
  return tuned;

  function secant(o: typeof opts, at: number[]): TunedBar {
    const t = o.thicknessMm / 1000;
    const guess = Math.sqrt((EULER_FREE * barSpeed(o.material) * t) / o.targetHz) * 1000;
    const fAt = (lengthMm: number) =>
      beamModes({ lengthMm, thicknessMm: o.thicknessMm, widthMm: o.widthMm, material: o.material, holeRmm: holeR, holeAt: at, elements: o.elements });
    let L0 = Math.max(5, guess);
    let m0 = fAt(L0);
    let x0 = 1 / (L0 * L0);
    let f0 = m0.hz[0];
    let x1 = x0 * (f0 / o.targetHz);
    let L1 = 1 / Math.sqrt(x1);
    let m1 = fAt(L1);
    let f1 = m1.hz[0];
    let iters = 1;
    for (; iters < 8 && Math.abs(centsBetween(f1, o.targetHz)) > 0.4; iters++) {
      const df = f1 - f0;
      let x2 = Math.abs(df) < 1e-6 ? x1 * (f1 / o.targetHz) : x1 - ((f1 - o.targetHz) * (x1 - x0)) / df;
      if (!(x2 > 0)) x2 = x1 * (o.targetHz / f1);
      x0 = x1;
      f0 = f1;
      x1 = x2;
      L1 = 1 / Math.sqrt(x1);
      m1 = fAt(L1);
      f1 = m1.hz[0];
    }
    return { lengthMm: L1, hz: m1.hz, nodes: m1.nodes, cents: centsBetween(f1, o.targetHz), iters };
  }
}

export function centsBetween(hz: number, target: number): number {
  return 1200 * Math.log2(hz / target);
}

// ---------------------------------------------------------------------------
// Element matrices and the small dense eigenproblem

function solveBeam(lengthM: number, thickM: number, E: number, rho: number, widthsMm: Float64Array, ne: number): BeamModes {
  const G = E / (2 * (1 + NU));
  const Le = lengthM / ne;
  const n = 2 * (ne + 1);
  const K = new Float64Array(n * n);
  const M = new Float64Array(n * n);
  const t3 = thickM * thickM * thickM;
  let wMax = 0;
  for (let e = 0; e < ne; e++) if (widthsMm[e] > wMax) wMax = widthsMm[e];
  if (wMax < 1e-9) wMax = 1e-9;

  for (let e = 0; e < ne; e++) {
    const w = Math.max(widthsMm[e], wMax * 1e-8) / 1000;
    const A = w * thickM;
    const I = (w * t3) / 12;
    const kb = (E * I) / Le;
    const ks = KAPPA * G * A;
    const rA = rho * A;
    const rI = rho * I;
    const Ke = [
      ks / Le, ks / 2, -ks / Le, ks / 2,
      ks / 2, (ks * Le) / 4 + kb, -ks / 2, (ks * Le) / 4 - kb,
      -ks / Le, -ks / 2, ks / Le, -ks / 2,
      ks / 2, (ks * Le) / 4 - kb, -ks / 2, (ks * Le) / 4 + kb,
    ];
    const Me = [
      (rA * Le) / 3, 0, (rA * Le) / 6, 0,
      0, (rI * Le) / 3, 0, (rI * Le) / 6,
      (rA * Le) / 6, 0, (rA * Le) / 3, 0,
      0, (rI * Le) / 6, 0, (rI * Le) / 3,
    ];
    const d = [2 * e, 2 * e + 1, 2 * e + 2, 2 * e + 3];
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        const i = d[a] * n + d[b];
        K[i] += Ke[a * 4 + b];
        M[i] += Me[a * 4 + b];
      }
    }
  }

  const A0 = (wMax / 1000) * thickM;
  const sK = (KAPPA * G * A0) / Le;
  const sM = rho * A0 * Le;
  const eigScale = sK / sM;
  for (let i = 0; i < n * n; i++) {
    K[i] /= sK;
    M[i] /= sM;
  }

  const c = Math.sqrt(E / rho);
  const fest = (EULER_FREE * c * thickM) / (lengthM * lengthM);
  let shift = (2 * Math.PI * fest) ** 2 * (sM / sK) * 1e-3;
  const k = BENDING_MODES + 3;
  const lam = new Float64Array(k);
  const vecs = new Float64Array(n * k);
  for (let attempt = 0; attempt < 4; attempt++) {
    const got = subspace(K, M, n, k, shift);
    if (got) {
      lam.set(got.lam);
      vecs.set(got.vecs);
      break;
    }
    shift *= 100;
  }

  const order = [...Array(k).keys()].sort((a, b) => lam[a] - lam[b]);
  const hz: number[] = [];
  let bendCol = -1;
  const wShape = new Float64Array(ne + 1);
  for (const col of order) {
    const omega2 = lam[col] * eigScale;
    const f = omega2 > 0 ? Math.sqrt(omega2) / (2 * Math.PI) : 0;
    if (f < 1) continue;
    if (bendCol < 0) {
      bendCol = col;
      for (let i = 0; i <= ne; i++) wShape[i] = vecs[col * n + 2 * i];
    }
    hz.push(f);
    if (hz.length === BENDING_MODES) break;
  }
  return { hz: hz.length ? hz : [fest], nodes: nodePair(zeroCrossings(wShape, ne)) };
}

/** The two crossings nearest the analytic free-free nodes. */
function nodePair(nodes: number[]): number[] {
  if (nodes.length < 2) return [FREE_NODE, 1 - FREE_NODE];
  const nearest = (target: number) => nodes.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  const lo = nearest(FREE_NODE);
  const hi = nearest(1 - FREE_NODE);
  return lo < hi ? [lo, hi] : [FREE_NODE, 1 - FREE_NODE];
}

function zeroCrossings(w: Float64Array, ne: number): number[] {
  let max = 0;
  for (let i = 0; i < w.length; i++) max = Math.max(max, Math.abs(w[i]));
  const floor = max * 1e-6;
  const nodes: number[] = [];
  for (let i = 0; i < ne; i++) {
    const a = w[i];
    const b = w[i + 1];
    if (Math.abs(a) < floor && Math.abs(b) < floor) continue;
    if (a === 0) nodes.push(i / ne);
    else if (a * b < 0) nodes.push((i + Math.abs(a) / (Math.abs(a) + Math.abs(b))) / ne);
  }
  return nodes;
}

function subspace(K: Float64Array, M: Float64Array, n: number, k: number, shift: number): { lam: Float64Array; vecs: Float64Array } | null {
  const A = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) A[i] = K[i] + shift * M[i];
  if (!cholesky(A, n)) return null;

  let Q = new Float64Array(n * k);
  let Z = new Float64Array(n * k);
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      Q[j * n + i] = Math.sin((j + 1) * Math.PI * x) + 0.15 * Math.cos((j + 2) * x);
    }
  }
  const MQ = new Float64Array(n * k);
  mOrtho(Q, MQ, n, k, M);

  const KZ = new Float64Array(n * k);
  const Kr = new Float64Array(k * k);
  const Y = new Float64Array(k * k);
  const lam = new Float64Array(k);
  let prev = 0;
  for (let iter = 0; iter < 18; iter++) {
    for (let c = 0; c < k; c++) {
      mul(M, n, Q.subarray(c * n, c * n + n), Z.subarray(c * n, c * n + n));
      cholSolve(A, n, Z.subarray(c * n, c * n + n));
    }
    mOrtho(Z, MQ, n, k, M);
    for (let c = 0; c < k; c++) mul(K, n, Z.subarray(c * n, c * n + n), KZ.subarray(c * n, c * n + n));
    for (let i = 0; i < k; i++) {
      for (let j = i; j < k; j++) {
        let s = 0;
        const zi = i * n;
        const kz = j * n;
        for (let t = 0; t < n; t++) s += Z[zi + t] * KZ[kz + t];
        Kr[i * k + j] = Kr[j * k + i] = s;
      }
    }
    jacobi(Kr, k, lam, Y);
    // Q = Z Y
    for (let c = 0; c < k; c++) {
      for (let t = 0; t < n; t++) {
        let s = 0;
        for (let j = 0; j < k; j++) s += Z[j * n + t] * Y[j + c * k];
        Q[c * n + t] = s;
      }
    }
    // lam[2] is the first bending partial once the two rigid-body modes are first
    const watch = lam[Math.min(2, k - 1)];
    if (iter > 4 && Math.abs(watch - prev) <= 1e-10 * (1 + Math.abs(watch))) break;
    prev = watch;
  }
  return { lam, vecs: Q };
}

/** In-place lower Cholesky. Returns false if A is not SPD. */
function cholesky(A: Float64Array, n: number): boolean {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= A[i * n + k] * A[j * n + k];
      if (i === j) {
        if (s <= 1e-18) return false;
        A[i * n + j] = Math.sqrt(s);
      } else A[i * n + j] = s / A[j * n + j];
    }
  }
  return true;
}

/** Solve A x = b in place (b is overwritten), A holding a lower Cholesky factor. */
function cholSolve(L: Float64Array, n: number, x: Float64Array): void {
  for (let i = 0; i < n; i++) {
    let s = x[i];
    const row = i * n;
    for (let k = 0; k < i; k++) s -= L[row + k] * x[k];
    x[i] = s / L[row + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
}

function mul(A: Float64Array, n: number, x: Float64Array, y: Float64Array): void {
  for (let i = 0; i < n; i++) {
    const row = i * n;
    let s = 0;
    for (let j = 0; j < n; j++) s += A[row + j] * x[j];
    y[i] = s;
  }
}

/** M-orthonormalise the columns of Z. MZ is scratch (and ends as M Z). */
function mOrtho(Z: Float64Array, MZ: Float64Array, n: number, k: number, M: Float64Array): void {
  for (let i = 0; i < k; i++) {
    const zi = i * n;
    for (let j = 0; j < i; j++) {
      const zj = j * n;
      let coef = 0;
      for (let t = 0; t < n; t++) coef += Z[zi + t] * MZ[zj + t];
      for (let t = 0; t < n; t++) Z[zi + t] -= coef * Z[zj + t];
    }
    mul(M, n, Z.subarray(zi, zi + n), MZ.subarray(zi, zi + n));
    let nrm2 = 0;
    for (let t = 0; t < n; t++) nrm2 += Z[zi + t] * MZ[zi + t];
    const inv = 1 / Math.sqrt(Math.max(nrm2, 1e-30));
    for (let t = 0; t < n; t++) {
      Z[zi + t] *= inv;
      MZ[zi + t] *= inv;
    }
  }
}

/**
 * Symmetric eigendecomposition. Eigenvalues are sorted ascending into `lam`,
 * eigenvectors are columns of `vecs` (length k*k, column-major). `S` is overwritten.
 */
function jacobi(S: Float64Array, k: number, lam: Float64Array, vecs: Float64Array): void {
  vecs.fill(0);
  for (let i = 0; i < k; i++) vecs[i + i * k] = 1;
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < k; p++) for (let q = p + 1; q < k; q++) off += S[p * k + q] * S[p * k + q];
    let diag = 0;
    for (let p = 0; p < k; p++) diag = Math.max(diag, Math.abs(S[p * k + p]));
    if (off <= 1e-28 * (1 + diag) * (1 + diag)) break;
    for (let p = 0; p < k; p++) {
      for (let q = p + 1; q < k; q++) {
        const apq = S[p * k + q];
        const app = S[p * k + p];
        const aqq = S[q * k + q];
        if (apq * apq < 1e-30 * (1 + diag) * (1 + diag)) continue;
        const tau = (aqq - app) / (2 * apq);
        const tt = Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + tt * tt);
        const s = tt * c;
        S[p * k + p] = app - tt * apq;
        S[q * k + q] = aqq + tt * apq;
        S[p * k + q] = S[q * k + p] = 0;
        for (let i = 0; i < k; i++) {
          if (i === p || i === q) continue;
          const aip = S[i * k + p];
          const aiq = S[i * k + q];
          const np = c * aip - s * aiq;
          const nq = s * aip + c * aiq;
          S[i * k + p] = S[p * k + i] = np;
          S[i * k + q] = S[q * k + i] = nq;
        }
        for (let i = 0; i < k; i++) {
          const vip = vecs[i + p * k];
          const viq = vecs[i + q * k];
          vecs[i + p * k] = c * vip - s * viq;
          vecs[i + q * k] = s * vip + c * viq;
        }
      }
    }
  }
  // sort eigenvalues (and their vectors) so the caller can watch the lowest
  const idx = [...Array(k).keys()].sort((a, b) => S[a * k + a] - S[b * k + b]);
  const lam0 = Float64Array.from(idx, (i) => S[i * k + i]);
  const V = new Float64Array(k * k);
  for (let c = 0; c < k; c++) {
    const src = idx[c];
    lam[c] = lam0[c];
    for (let i = 0; i < k; i++) V[i + c * k] = vecs[i + src * k];
  }
  vecs.set(V);
}
