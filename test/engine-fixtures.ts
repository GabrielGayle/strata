// Projects for the engine timing runs: the 93-plate Vermilion and a Shadow design with 8 frames.
import type { Gray } from '../src/core/image';
import { newProject, serialize, type Project } from '../src/core/project';
import { grayToPngDataUrl } from './stack-rods-fixture';

export function vermilion93(): Project {
  const p = newProject();
  p.params = { ...p.params, plateCount: '93' };
  return p;
}

/** A disc that walks across the picture, one step per frame. */
export function shadowFrameGray(i: number, w = 60, h = 40): Gray {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.hypot(x / w - 0.2 - i * 0.08, y / h - 0.5) < 0.2 ? 1 : 0;
  return { w, h, data };
}

export function shadow8(): Project {
  const p = newProject();
  p.params = { ...p.params, sunOn: true, shadowOn: true, sunMonth: '12', sunDay: '21', sunLat: '51.5', sunLon: '0', sunUtc: '0', sunFacing: '180', shadowW: '120', shadowH: '80', insertOn: false, shadowDays: '0' };
  p.shadow = { frames: Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, name: `F${i}`, dataUrl: grayToPngDataUrl(shadowFrameGray(i)), time: 11 + i * 0.25, hold: 0 })) };
  return p;
}

export const vermilion93Json = () => serialize(vermilion93());
export const shadow8Json = () => serialize(shadow8());
