import { PNG } from 'pngjs';
import { decodeTerrariumMetres } from './mapTerrarium';

/** Node / vitest synchronous terrarium decode (pngjs). */
export function decodeTerrariumPng(buf: Uint8Array): { w: number; h: number; data: Float32Array } {
  const png = PNG.sync.read(Buffer.from(buf));
  const w = png.width;
  const h = png.height;
  const n = w * h;
  const data = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const m = decodeTerrariumMetres(png.data[p], png.data[p + 1], png.data[p + 2]);
    data[i] = m < -1000 || m > 9000 ? NaN : m;
  }
  return { w, h, data };
}
