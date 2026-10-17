import { PNG } from 'pngjs';
import type { Gray } from '../src/core/image';
import { PRESETS } from '../src/core/project';

/** White plate with two dark cones (peaks) left and right. */
export function twoPeakGray(w = 96, h = 64): Gray {
  const data = new Float32Array(w * h).fill(1);
  const r = Math.min(w, h) * 0.16;
  const peaks: [number, number][] = [
    [w * 0.28, h * 0.5],
    [w * 0.72, h * 0.5],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = 1;
      for (const [cx, cy] of peaks) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d < 1) best = Math.min(best, d);
      }
      data[y * w + x] = best;
    }
  }
  return { w, h, data };
}

export function grayToPngDataUrl(g: Gray): string {
  const png = new PNG({ width: g.w, height: g.h });
  for (let i = 0; i < g.w * g.h; i++) {
    const v = Math.max(0, Math.min(255, Math.round(g.data[i] * 255)));
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

export const STACK_ROD_PARAMS: Record<string, string | boolean> = {
  imgTopMode: 'raise',
  imgSmooth: '0',
  imgContrast: '1',
  topThreshold: '0.08',
  topDepth: '21',
  topSteps: '0',
  plateCount: '10',
  thickness: '3',
  stackHeight: '30',
  erosionAmp: '0',
  crest: '0',
  slope: '0',
  banding: '0',
  stackRodsOn: true,
  flatPins: '0',
  insShape: 'none',
};

export function stackRodsProjectJson(): string {
  const preset = PRESETS.find((p) => p.name === 'Stamped stack')!;
  return JSON.stringify({
    format: 'strata-project',
    version: 1,
    name: 'Support poles',
    params: { ...preset.params, ...STACK_ROD_PARAMS },
    images: {
      top: { name: 'two-peaks.png', dataUrl: grayToPngDataUrl(twoPeakGray()) },
    },
  });
}
