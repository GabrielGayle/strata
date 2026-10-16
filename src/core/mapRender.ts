// Venue outreach mock-up: plate-honest relief hero + source/relief diptych (ticket 20).
import { PNG } from 'pngjs';
import type { DepthData } from './depth';
import { depthToGray } from './depth';
import type { Float32Grid } from './mapGrid';
import { gridElevationRange } from './mapTerrarium';

export const MAP_RENDER_WIDTH = 1600;
export const MAP_RENDER_HEIGHT = 900;

const HERO_H = 520;
const DIP_H = MAP_RENDER_HEIGHT - HERO_H;

function grayFromGrid(g: Float32Grid): { w: number; h: number; data: Float32Array } {
  const { min, max } = gridElevationRange(g);
  const span = max - min || 1;
  const out = new Float32Array(g.data.length);
  for (let i = 0; i < g.data.length; i++) {
    const v = g.data[i];
    out[i] = Number.isFinite(v) ? (v - min) / span : 1;
  }
  return { w: g.w, h: g.h, data: out };
}

function sampleGray(g: { w: number; h: number; data: Float32Array }, u: number, v: number): number {
  const x = Math.min(g.w - 1, Math.max(0, u * (g.w - 1)));
  const y = Math.min(g.h - 1, Math.max(0, v * (g.h - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(g.w - 1, x0 + 1);
  const y1 = Math.min(g.h - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = g.data[y0 * g.w + x0];
  const b = g.data[y0 * g.w + x1];
  const c = g.data[y1 * g.w + x0];
  const d = g.data[y1 * g.w + x1];
  return (1 - tx) * (1 - ty) * a + tx * (1 - ty) * b + (1 - tx) * ty * c + tx * ty * d;
}

function blitGray(
  target: Uint8Array,
  tw: number,
  th: number,
  g: { w: number; h: number; data: Float32Array },
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  invert = false,
) {
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const u = x / Math.max(1, dw - 1);
      const v = y / Math.max(1, dh - 1);
      let b = sampleGray(g, u, v);
      if (invert) b = 1 - b;
      const px = dx + x;
      const py = dy + y;
      if (px < 0 || py < 0 || px >= tw || py >= th) continue;
      const i = (py * tw + px) * 4;
      const c = Math.round(Math.min(255, Math.max(0, b * 255)));
      target[i] = c;
      target[i + 1] = c;
      target[i + 2] = c;
      target[i + 3] = 255;
    }
  }
}

function label(target: Uint8Array, tw: number, text: string, x: number, y: number) {
  const scale = 2;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    const ox = x + i * 6 * scale;
    for (let dy = 0; dy < 7 * scale; dy++) {
      for (let dx = 0; dx < 5 * scale; dx++) {
        const px = ox + dx;
        const py = y + dy;
        if (px >= tw || py >= MAP_RENDER_HEIGHT) continue;
        const bit = ((ch >> (dy % 8)) & 1) && dx % scale === 0;
        if (!bit) continue;
        const j = (py * tw + px) * 4;
        target[j] = 30;
        target[j + 1] = 30;
        target[j + 2] = 30;
        target[j + 3] = 255;
      }
    }
  }
}

export interface MapRenderInput {
  elevation: Float32Grid;
  depth: DepthData;
  title?: string;
}

/** PNG buffer (1600×900) for outreach mock-ups. */
export function renderVenueMockup(input: MapRenderInput): Buffer {
  const src = grayFromGrid(input.elevation);
  const relief = depthToGray(input.depth);
  const rgba = new Uint8Array(MAP_RENDER_WIDTH * MAP_RENDER_HEIGHT * 4).fill(255);
  blitGray(rgba, MAP_RENDER_WIDTH, MAP_RENDER_HEIGHT, relief, 0, 0, MAP_RENDER_WIDTH, HERO_H, false);
  blitGray(rgba, MAP_RENDER_WIDTH, MAP_RENDER_HEIGHT, src, 0, HERO_H, MAP_RENDER_WIDTH / 2 - 4, DIP_H, false);
  blitGray(rgba, MAP_RENDER_WIDTH, MAP_RENDER_HEIGHT, relief, MAP_RENDER_WIDTH / 2 + 4, HERO_H, MAP_RENDER_WIDTH / 2 - 4, DIP_H, false);
  label(rgba, MAP_RENDER_WIDTH, input.title?.toUpperCase() || 'MAP RELIEF', 24, 20);
  label(rgba, MAP_RENDER_WIDTH, 'SOURCE TERRAIN', 24, HERO_H + 12);
  label(rgba, MAP_RENDER_WIDTH, 'PLATE RELIEF', MAP_RENDER_WIDTH / 2 + 20, HERO_H + 12);
  return PNG.sync.write({ width: MAP_RENDER_WIDTH, height: MAP_RENDER_HEIGHT, data: Buffer.from(rgba) });
}
