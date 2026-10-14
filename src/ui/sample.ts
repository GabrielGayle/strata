// A procedural banded-cliff image, so the image tools can be tried without a photo.
import { fbm } from '../core/rng';

export function sampleCliff(seed = 3, w = 320, h = 200): string {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const fx = x / w;
    // ridge line: a mesa with eroded shoulders
    const ridge = 0.32 + 0.18 * Math.sin(fx * Math.PI) * (fx > 0.15 && fx < 0.85 ? 1 : 0.6) + 0.08 * fbm(fx * 6, 0.5, seed, 4, 0.55);
    const top = Math.round((1 - ridge - 0.25) * h);
    for (let y = 0; y < h; y++) {
      let b: number;
      if (y < top) b = 0.93 - 0.1 * (y / h);
      else {
        const depth = (y - top) / h;
        const band = Math.sin((y + 6 * fbm(fx * 4, y / 40, seed + 1, 3, 0.5)) * 0.32) * 0.5 + 0.5;
        b = 0.18 + 0.32 * band + 0.08 * fbm(fx * 18, y / 8, seed + 2, 2, 0.5) - depth * 0.15;
      }
      const i = (y * w + x) * 4;
      const c = Math.max(0, Math.min(255, b * 255));
      img.data[i] = c;
      img.data[i + 1] = c * 0.86;
      img.data[i + 2] = c * 0.78;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}
