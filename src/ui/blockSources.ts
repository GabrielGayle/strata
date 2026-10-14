// Decoded brightness grids for composer blocks. Images decode once per data URL;
// patterns and drawings render once per spec (specs are replaced, never mutated).
import { useCallback, useEffect, useState } from 'react';
import { renderDrawing, type Block, type BlockSource } from '../core/compose';
import { decodeImage, type Gray } from '../core/image';
import { patternSize, renderPattern } from '../core/pattern';

const imgCache = new Map<string, Gray>();
const pending = new Set<string>();
const specCache = new WeakMap<object, Gray>();

export function sourceGray(src: BlockSource): Gray | null {
  if (src.kind === 'image') return imgCache.get(src.dataUrl) ?? null;
  const spec = src.spec;
  let g = specCache.get(spec);
  if (!g) {
    if (src.kind === 'pattern') {
      const { w, h } = patternSize(src.spec, 360);
      g = renderPattern(src.spec, w, h);
    } else {
      const a = Math.max(0.1, src.spec.aspect);
      const w = a >= 1 ? 480 : Math.round(480 * a);
      const h = a >= 1 ? Math.round(480 / a) : 480;
      g = renderDrawing(src.spec, w, h);
    }
    specCache.set(spec, g);
  }
  return g;
}

/** Decode an image source ahead of time (e.g. to read its proportions). */
export async function loadImageGray(dataUrl: string): Promise<Gray | null> {
  if (imgCache.has(dataUrl)) return imgCache.get(dataUrl)!;
  try {
    const g = await decodeImage(dataUrl, 512);
    imgCache.set(dataUrl, g);
    return g;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

/** A lookup that fills in as image blocks finish decoding. */
export function useBlockSources(blocks: Block[]): (b: Block) => Gray | null {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, []);
  useEffect(() => {
    for (const b of blocks) {
      if (b.source.kind !== 'image') continue;
      const url = b.source.dataUrl;
      if (imgCache.has(url) || pending.has(url)) continue;
      pending.add(url);
      loadImageGray(url).finally(() => {
        pending.delete(url);
        listeners.forEach((f) => f());
      });
    }
  }, [blocks]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((b: Block) => sourceGray(b.source), [blocks, tick]);
}
