// PNG/JPEG → the same brightness grid decodeImage builds in the browser.
// Used when there is no canvas (the CLI, tests). 1:1 images copy pixels; larger
// ones are bilinear-sampled down to scaledSize, then run through grayFromRgba.
import { decode as decodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { grayFromRgba, scaledSize, setNodeImageDecoder, type Gray } from './image';

function dataUrlBytes(dataUrl: string): Uint8Array {
  const i = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || i < 0) throw new Error('Not an image data URL');
  if (!/base64/i.test(dataUrl.slice(0, i))) throw new Error('Image data URL is not base64');
  return Buffer.from(dataUrl.slice(i + 1), 'base64');
}

function decodeRgba(bytes: Uint8Array): { w: number; h: number; data: Uint8Array } {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { w: png.width, h: png.height, data: png.data };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const jpg = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
    return { w: jpg.width, h: jpg.height, data: jpg.data };
  }
  throw new Error('Unsupported image (PNG or JPEG)');
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Bilinear RGBA resize. Destination pixels map like a canvas drawImage scale. */
function resizeBilinear(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * yr - 0.5;
    const y0 = Math.floor(sy);
    const ty = sy - y0;
    const y0c = clamp(y0, 0, sh - 1);
    const y1c = clamp(y0 + 1, 0, sh - 1);
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * xr - 0.5;
      const x0 = Math.floor(sx);
      const tx = sx - x0;
      const x0c = clamp(x0, 0, sw - 1);
      const x1c = clamp(x0 + 1, 0, sw - 1);
      const i = (y * dw + x) * 4;
      const i00 = (y0c * sw + x0c) * 4;
      const i10 = (y0c * sw + x1c) * 4;
      const i01 = (y1c * sw + x0c) * 4;
      const i11 = (y1c * sw + x1c) * 4;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      for (let c = 0; c < 4; c++) {
        out[i + c] = Math.round(src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11);
      }
    }
  }
  return out;
}

export function decodeImageNode(dataUrl: string, maxSide = 256): Gray {
  const { w: sw, h: sh, data } = decodeRgba(dataUrlBytes(dataUrl));
  if (!(sw >= 1 && sh >= 1) || data.length < sw * sh * 4) throw new Error('Image is empty');
  const { w, h } = scaledSize(sw, sh, maxSide);
  const px = sw === w && sh === h ? data : resizeBilinear(data, sw, sh, w, h);
  return grayFromRgba(px, w, h);
}

setNodeImageDecoder(decodeImageNode);
