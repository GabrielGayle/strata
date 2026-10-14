// Seeded randomness and noise so every design is exactly repeatable from its seed.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Gradient noise in roughly [-1, 1]. */
export function noise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const g = (cx: number, cy: number, dx: number, dy: number) => {
    const a = hash2(cx, cy, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = g(ix, iy, fx, fy);
  const n10 = g(ix + 1, iy, fx - 1, fy);
  const n01 = g(ix, iy + 1, fx, fy - 1);
  const n11 = g(ix + 1, iy + 1, fx - 1, fy - 1);
  const u = fade(fx);
  const v = fade(fy);
  return 1.414 * ((n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v);
}

/** Fractal Brownian motion, normalised to roughly [-1, 1]. */
export function fbm(x: number, y: number, seed: number, octaves: number, roughness: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  const n = Math.max(1, Math.min(8, Math.round(octaves)));
  for (let i = 0; i < n; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 101);
    norm += amp;
    amp *= roughness;
    freq *= 2.03;
  }
  return sum / norm;
}
