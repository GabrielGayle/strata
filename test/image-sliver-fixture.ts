import { PNG } from 'pngjs';
import type { Gray } from '../src/core/image';

function grayToPng(g: Gray): string {
  const png = new PNG({ width: g.w, height: g.h });
  for (let i = 0; i < g.w * g.h; i++) {
    const v = Math.max(0, Math.min(255, Math.round(g.data[i] * 255)));
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

/**
 * White plate face with a full-width black band near the top.
 * Mapped onto the front window this cuts through a side-silhouette peak and
 * leaves a thin unanchored cap (the sliver).
 */
export function sliverFrontGray(w = 80, h = 120): Gray {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const black = y >= 2 && y < 16;
    for (let x = 0; x < w; x++) data[y * w + x] = black ? 0 : 1;
  }
  return { w, h, data };
}

/**
 * Side silhouette: a wide body with a 1-pixel-taller centre peak, so a front
 * cut across the peak knocks off a sub-millimetre-to-2 mm cap.
 * Dark = the shape (silhouetteProfile uses the topmost dark pixel).
 */
export function sliverSideGray(w = 80, h = 200): Gray {
  const data = new Float32Array(w * h);
  const shoulder = 40;
  const peak = 39;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mid = Math.abs(x + 0.5 - w / 2) < 8;
      const top = mid ? peak : shoulder;
      data[y * w + x] = y >= top ? 0 : 1;
    }
  }
  return { w, h, data };
}

export function sliverFrontDataUrl(): string {
  return grayToPng(sliverFrontGray());
}

export function sliverSideDataUrl(): string {
  return grayToPng(sliverSideGray());
}

/** Gabriel's reported setup: image mode, 200×150 mm, 1.5 mm mild steel, 20 mm gap, 6 plates. */
export const GABRIEL_PARAMS: Record<string, string> = {
  imgFrontMode: 'layers',
  imgSideMode: 'silhouette',
  imgMix: '1',
  imageOn: 'true',
  baseLength: '200',
  baseWidth: '150',
  thickness: '1.5',
  plateMaterial: 'steel',
  spacingMode: 'gapCount',
  plateGap: '20',
  plateCount: '6',
  frontMargin: '0',
  imgFrontStrength: '1',
  frontDepth: '10',
  erosionAmp: '0',
  crest: '0',
  slope: '0',
  banding: '0',
  insShape: 'none',
  anchorHoles: '0',
  stackHeight: '80',
  embedDepth: '25',
  endMargin: '20',
  sideMargin: '15',
};

export function gabrielProjectJson(fragmentMode: 'auto' | 'keep' | 'drop' | 'merge' = 'auto'): string {
  return JSON.stringify({
    format: 'strata-project',
    version: 1,
    name: 'Gabriel sliver',
    params: { ...GABRIEL_PARAMS, fragmentMode },
    images: {
      front: { name: 'sliver-front.png', dataUrl: sliverFrontDataUrl() },
      side: { name: 'sliver-side.png', dataUrl: sliverSideDataUrl() },
    },
  });
}
