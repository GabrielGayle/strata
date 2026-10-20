// Bas-relief for depth-from-photo faces: the standard gradient-domain method
// (after Weyrich et al. 2007, "Digital bas-relief from 3D scenes"). The depth's
// slopes are compressed (big jumps, like a hand lying on a body or a figure's
// edge against the background, shrink the most), fine slopes are boosted, and
// the result is integrated back with a Poisson solve and pinned flat at the
// background. Plates then follow soft ramps instead of near-vertical walls.
// Pure and synchronous: it runs in the engine worker, the CLI and the UI.

export interface BasReliefOpts {
  /** 0..1: how hard big jumps are squashed (0 = off). */
  squash: number;
  /** 1..3: gain on fine detail (1 = as is). */
  detail: number;
  /** 0..0.3: depth of an incised groove along the edges where depth jumped, as a fraction of the relief. */
  outline: number;
  /** Groove width in pixels of the depth grid. */
  outlineWidth: number;
}

/** Separable gaussian, sigma in pixels, edges clamped. */
export function gaussian(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (!(sigma > 0.05)) return Float32Array.from(src);
  if (sigma >= 3) return boxGaussian(src, w, h, sigma);
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = a;
    }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = a;
    }
  return out;
}

/** Smallest value within r pixels (a square window), separable. */
function minFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) m = Math.min(m, src[y * w + i]);
      tmp[y * w + x] = m;
    }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) m = Math.min(m, tmp[j * w + x]);
      out[y * w + x] = m;
    }
  return out;
}

/** In-place radix-2 complex FFT (length a power of two). */
function fft2(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

interface Plan {
  n: number;
  m: number;
  cr: Float64Array; // chirp e^{-iπk²/n}
  ci: Float64Array;
  br: Float64Array; // FFT of the conjugate chirp, padded
  bi: Float64Array;
  tr: Float64Array; // DCT twiddles e^{-iπk/2n}
  ti: Float64Array;
}

/** Three running-box passes per axis: a close gaussian in O(n) whatever the width. */
function boxGaussian(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  // box widths whose three passes match the gaussian's variance (Kovesi)
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let lo = Math.floor(ideal);
  if (lo % 2 === 0) lo--;
  const mIdeal = (12 * sigma * sigma - 3 * lo * lo - 12 * lo - 9) / (-4 * lo - 4);
  const m = Math.round(mIdeal);
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    const r = ((pass < m ? lo : lo + 2) - 1) / 2;
    boxPass(a, b, w, h, r, 1, w); // along rows
    boxPass(b, a, h, w, r, w, 1); // along columns
  }
  return a;
}

/** One running box of radius r along lines of `len` samples, `step` apart; lines start `stride` apart. */
function boxPass(src: Float32Array, dst: Float32Array, len: number, lines: number, r: number, step: number, stride: number) {
  const k = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const o = l * stride;
    const at = (i: number) => src[o + Math.min(len - 1, Math.max(0, i)) * step];
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += at(i);
    for (let i = 0; i < len; i++) {
      dst[o + i * step] = acc * k;
      acc += at(i + r + 1) - at(i - r);
    }
  }
}

const plans = new Map<number, Plan>();

/** Any-length FFT by Bluestein's chirp-z, plus the DCT twiddles, cached per length. */
function plan(n: number): Plan {
  let p = plans.get(n);
  if (p) return p;
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const cr = new Float64Array(n), ci = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const a = (Math.PI * ((k * k) % (2 * n))) / n;
    cr[k] = Math.cos(a);
    ci[k] = -Math.sin(a);
  }
  const br = new Float64Array(m), bi = new Float64Array(m);
  br[0] = cr[0];
  bi[0] = -ci[0];
  for (let k = 1; k < n; k++) {
    br[k] = br[m - k] = cr[k];
    bi[k] = bi[m - k] = -ci[k];
  }
  fft2(br, bi, false);
  const tr = new Float64Array(n), ti = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    tr[k] = Math.cos((-Math.PI * k) / (2 * n));
    ti[k] = Math.sin((-Math.PI * k) / (2 * n));
  }
  p = { n, m, cr, ci, br, bi, tr, ti };
  plans.set(n, p);
  return p;
}

/** Complex DFT of any length (inverse unscaled), in place. */
function dft(p: Plan, re: Float64Array, im: Float64Array, inverse: boolean) {
  const { n, m, cr, ci, br, bi } = p;
  if ((n & (n - 1)) === 0) return fft2(re, im, inverse);
  const s = inverse ? -1 : 1; // the inverse uses the conjugate chirp
  const ar = new Float64Array(m), ai = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    const wr = cr[k], wi = s * ci[k];
    ar[k] = re[k] * wr - im[k] * wi;
    ai[k] = re[k] * wi + im[k] * wr;
  }
  fft2(ar, ai, false);
  for (let k = 0; k < m; k++) {
    const xr = br[k], xi = s * bi[k];
    // for the inverse the kernel is the conjugate chirp's FFT: conj(B(-k)); B is symmetric so conj suffices
    const yr = ar[k] * xr - ai[k] * (inverse ? -bi[(m - k) % m] : xi);
    const yi = ar[k] * (inverse ? -bi[(m - k) % m] : xi) + ai[k] * xr;
    ar[k] = yr;
    ai[k] = yi;
  }
  fft2(ar, ai, true);
  for (let k = 0; k < n; k++) {
    const yr = ar[k] / m, yi = ai[k] / m;
    const wr = cr[k], wi = s * ci[k];
    re[k] = yr * wr - yi * wi;
    im[k] = yr * wi + yi * wr;
  }
}

/** Orthonormal DCT-II of x (or its inverse, DCT-III), through one FFT of the same length. */
function dct1(x: Float64Array, out: Float64Array, inverse: boolean) {
  const n = x.length;
  const p = plan(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  const s0 = Math.sqrt(1 / n), s1 = Math.sqrt(2 / n);
  if (!inverse) {
    for (let k = 0; 2 * k < n; k++) re[k] = x[2 * k];
    for (let k = 0; 2 * k + 1 < n; k++) re[n - 1 - k] = x[2 * k + 1];
    dft(p, re, im, false);
    for (let k = 0; k < n; k++) out[k] = (re[k] * p.tr[k] - im[k] * p.ti[k]) * (k === 0 ? s0 : s1);
  } else {
    // V_k = e^{iπk/2n} (X_k - i X_{n-k}), X_n = 0, then v = IDFT(V)
    for (let k = 0; k < n; k++) {
      const a = x[k] / (k === 0 ? s0 : s1);
      const b = k === 0 ? 0 : x[n - k] / s1;
      const cr = p.tr[k], ci = -p.ti[k];
      re[k] = a * cr + b * ci;
      im[k] = a * ci - b * cr;
    }
    dft(p, re, im, true);
    for (let k = 0; 2 * k < n; k++) out[2 * k] = re[k] / n;
    for (let k = 0; 2 * k + 1 < n; k++) out[2 * k + 1] = re[n - 1 - k] / n;
  }
}

/** 2D orthonormal DCT-II (or its inverse) along rows then columns. */
function dct2(src: Float64Array, w: number, h: number, inverse: boolean): Float64Array {
  const tmp = new Float64Array(w * h);
  const row = new Float64Array(w), ro = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = src[y * w + x];
    dct1(row, ro, inverse);
    for (let x = 0; x < w; x++) tmp[y * w + x] = ro[x];
  }
  const out = new Float64Array(w * h);
  const col = new Float64Array(h), co = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = tmp[y * w + x];
    dct1(col, co, inverse);
    for (let y = 0; y < h; y++) out[y * w + x] = co[y];
  }
  return out;
}

/** The surface whose forward differences best match (gx, gy): Poisson with Neumann edges. */
export function integrate(gx: Float32Array, gy: Float32Array, w: number, h: number): Float64Array {
  const div = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      div[i] = gx[i] - (x > 0 ? gx[i - 1] : 0) + gy[i] - (y > 0 ? gy[i - w] : 0);
    }
  const d = dct2(div, w, h, false);
  for (let ky = 0; ky < h; ky++)
    for (let kx = 0; kx < w; kx++) {
      const den = 2 * Math.cos((Math.PI * kx) / w) - 2 + 2 * Math.cos((Math.PI * ky) / h) - 2;
      d[ky * w + kx] = kx === 0 && ky === 0 ? 0 : d[ky * w + kx] / den;
    }
  return dct2(d, w, h, true);
}

/**
 * Heights 0..1 (subject on a 0 background) in, bas-relief heights 0..1 out.
 * `inside` (0..1) marks the subject; when there is no cut-out pass null and the
 * lowest heights count as background.
 */
export function basRelief(data: Float32Array, w: number, h: number, o: BasReliefOpts, inside: Float32Array | null = null): Float32Array {
  const n = w * h;
  const squash = Math.min(1, Math.max(0, o.squash));
  if (!(squash > 0) || w < 4 || h < 4) return data;
  // work in units of "grey levels per pixel at 512 px", so the sliders mean the same at any resolution
  const unit = 255 * (Math.max(w, h) / 512);
  const scale = Math.max(w, h) / 512;
  const z = gaussian(data, w, h, 0.8 * scale);
  for (let i = 0; i < n; i++) z[i] *= unit;
  const alpha = 1 + 5 * squash;
  const cap = 3.5 - 2.9 * squash; // biggest step per pixel that survives, after compression
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      gx[i] = x < w - 1 ? z[i + 1] - z[i] : 0;
      gy[i] = y < h - 1 ? z[i + w] - z[i] : 0;
    }
  // one gain per pixel on the slope's length (not each axis on its own, which twists the
  // field and leaves seams after integrating): log-compress, then cap what is left of the jumps
  let k: Float32Array = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = Math.hypot(gx[i], gy[i]) + 1e-9;
    const c = Math.log1p(alpha * m) / alpha;
    k[i] = Math.min(c, cap) / m;
  }
  // spread the low gains first, so softening them can't leak a jump back through
  k = gaussian(minFilter(k, w, h, Math.max(1, Math.round(2 * scale))), w, h, 1.5 * scale);
  for (let i = 0; i < n; i++) {
    gx[i] *= k[i];
    gy[i] *= k[i];
  }
  const detail = Math.min(3, Math.max(1, o.detail || 1));
  if (detail > 1) {
    const sx = gaussian(gx, w, h, 5 * scale);
    const sy = gaussian(gy, w, h, 5 * scale);
    for (let i = 0; i < n; i++) {
      gx[i] = sx[i] + (gx[i] - sx[i]) * detail;
      gy[i] = sy[i] + (gy[i] - sy[i]) * detail;
    }
  }
  const r = integrate(gx, gy, w, h);
  // pin the background flat: a smooth baseline fitted to the background, taken off everywhere
  const bg = new Float32Array(n);
  if (inside) for (let i = 0; i < n; i++) bg[i] = inside[i] < 0.5 ? 1 : 0;
  let bgCount = 0;
  for (let i = 0; i < n; i++) bgCount += bg[i];
  if (bgCount < n * 0.02) {
    const sorted = Float32Array.from(data).sort();
    const lo = sorted[Math.floor(n * 0.08)] + 1e-6;
    bgCount = 0;
    for (let i = 0; i < n; i++) bgCount += bg[i] = data[i] <= lo ? 1 : 0;
  }
  const out = new Float32Array(n);
  if (bgCount > 0) {
    const base = backgroundBaseline(r, bg, w, h);
    for (let i = 0; i < n; i++) out[i] = r[i] - base[i];
  } else for (let i = 0; i < n; i++) out[i] = r[i];
  const bgVals: number[] = [];
  for (let i = 0; i < n; i++) if (bg[i] > 0) bgVals.push(out[i]);
  bgVals.sort((a, b) => a - b);
  const floor = bgVals.length ? bgVals[Math.floor(bgVals.length / 2)] : Math.min(...out);
  let hi = 0;
  for (let i = 0; i < n; i++) {
    out[i] = Math.max(0, out[i] - floor);
    if (out[i] > hi) hi = out[i];
  }
  if (hi > 1e-9) for (let i = 0; i < n; i++) out[i] /= hi;
  if (o.outline > 0) incise(out, z, w, h, Math.min(0.3, o.outline), Math.max(0.5, o.outlineWidth || 1.5) * scale);
  return out;
}

/**
 * A smooth surface through the integrated heights on the background, spread over the
 * whole picture (normalised convolution on a quarter-size grid). Wider passes are mixed
 * in faintly so pixels far from any background still get a value, with no seams.
 */
function backgroundBaseline(r: Float64Array, bg: Float32Array, w: number, h: number): Float32Array {
  const f = 4;
  const sw = Math.ceil(w / f), sh = Math.ceil(h / f);
  const rs = new Float32Array(sw * sh), bs = new Float32Array(sw * sh), cnt = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const j = Math.floor(y / f) * sw + Math.floor(x / f);
      rs[j] += r[y * w + x] * bg[y * w + x];
      bs[j] += bg[y * w + x];
      cnt[j]++;
    }
  for (let j = 0; j < rs.length; j++) {
    rs[j] /= cnt[j];
    bs[j] /= cnt[j];
  }
  const sig = Math.max(w, h) / 10 / f;
  const num = new Float32Array(sw * sh), den = new Float32Array(sw * sh);
  let weight = 1;
  for (const m of [1, 2, 4, 8]) {
    const a = gaussian(rs, sw, sh, sig * m);
    const b = gaussian(bs, sw, sh, sig * m);
    for (let j = 0; j < num.length; j++) {
      num[j] += weight * a[j];
      den[j] += weight * b[j];
    }
    weight *= 0.01;
  }
  const small = new Float32Array(sw * sh);
  for (let j = 0; j < small.length; j++) small[j] = den[j] > 0 ? num[j] / den[j] : 0;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5)), fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      out[y * w + x] =
        (small[y0 * sw + x0] * (1 - tx) + small[y0 * sw + x1] * tx) * (1 - ty) + (small[y1 * sw + x0] * (1 - tx) + small[y1 * sw + x1] * tx) * ty;
    }
  return out;
}

/** A fine groove where the original depth jumped (occluding edges), so outlines stay legible. */
function incise(out: Float32Array, z: Float32Array, w: number, h: number, depth: number, width: number) {
  const n = w * h;
  const g = new Float32Array(n);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      g[i] = Math.hypot(z[i + 1] - z[i - 1], z[i + w] - z[i - w]) / 2;
    }
  // the steepest few percent of the original are the jumps
  const sorted = Float32Array.from(g).sort();
  const t = Math.max(1e-6, sorted[Math.floor(n * 0.96)]);
  const edge = new Float32Array(n);
  for (let i = 0; i < n; i++) edge[i] = g[i] > t ? 1 : 0;
  const groove = gaussian(edge, w, h, width / 2);
  let gm = 0;
  for (let i = 0; i < n; i++) gm = Math.max(gm, groove[i]);
  if (gm < 1e-9) return;
  for (let i = 0; i < n; i++) out[i] = Math.max(0, out[i] - (depth * groove[i]) / gm);
}

/** The cut-out rolled down over `px` pixels inside its edge instead of stopping at a wall. */
export function featherMatte(k: Float32Array, w: number, h: number, px: number): Float32Array {
  if (!(px > 0.25)) return k;
  const b = gaussian(k, w, h, px / 2);
  const out = new Float32Array(k.length);
  for (let i = 0; i < k.length; i++) {
    const t = Math.min(1, Math.max(0, 2 * b[i] - 1));
    out[i] = Math.min(k[i], t * t * (3 - 2 * t));
  }
  return out;
}
