import { encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { decodeImage, scaledSize, setNodeImageDecoder } from '../src/core/image';
import { decodeImageNode } from '../src/core/imageNode';

setNodeImageDecoder(decodeImageNode);

function dataUrl(png: PNG): string {
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

describe('node image decode', () => {
  it('matches the browser luminance formula, including transparency', async () => {
    const png = new PNG({ width: 2, height: 2 });
    const set = (x: number, y: number, r: number, g: number, b: number, a: number) => {
      const i = (y * 2 + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    };
    set(0, 0, 255, 0, 0, 255);
    set(1, 0, 0, 255, 0, 255);
    set(0, 1, 0, 0, 255, 255);
    set(1, 1, 0, 0, 0, 0);
    const gray = await decodeImage(dataUrl(png));
    expect(gray.w).toBe(2);
    expect(gray.h).toBe(2);
    expect(gray.data[0]).toBeCloseTo(0.2126, 5);
    expect(gray.data[1]).toBeCloseTo(0.7152, 5);
    expect(gray.data[2]).toBeCloseTo(0.0722, 5);
    expect(gray.data[3]).toBeCloseTo(1, 5);
    expect(gray.alpha?.[3]).toBe(0);
  });

  it('decodes JPEG and scales the longest side to the same size as the browser path', async () => {
    const w = 300;
    const h = 100;
    const data = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 0;
      data[i * 4 + 1] = 255;
      data[i * 4 + 2] = 0;
      data[i * 4 + 3] = 255;
    }
    const jpg = encodeJpeg({ data, width: w, height: h }, 100);
    const gray = await decodeImage(`data:image/jpeg;base64,${Buffer.from(jpg.data).toString('base64')}`);
    expect({ w: gray.w, h: gray.h }).toEqual(scaledSize(w, h, 256));
    expect(gray.w).toBe(256);
    expect(gray.h).toBe(85);
    expect(gray.alpha).toBeUndefined();
    let sum = 0;
    for (let i = 0; i < gray.data.length; i++) sum += gray.data[i];
    expect(sum / gray.data.length).toBeCloseTo(0.7152, 1);
  });

  it('keeps a flat colour flat when resampling a PNG', async () => {
    const png = new PNG({ width: 8, height: 4 });
    for (let i = 0; i < 8 * 4; i++) {
      png.data[i * 4] = 255;
      png.data[i * 4 + 1] = 0;
      png.data[i * 4 + 2] = 0;
      png.data[i * 4 + 3] = 255;
    }
    const gray = await decodeImage(dataUrl(png), 4);
    expect({ w: gray.w, h: gray.h }).toEqual({ w: 4, h: 2 });
    for (let i = 0; i < gray.data.length; i++) expect(gray.data[i]).toBeCloseTo(0.2126, 5);
  });
});
