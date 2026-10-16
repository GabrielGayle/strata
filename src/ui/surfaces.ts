// What each image surface switches on, shared by the slot cards and the composer.
import type { Surface } from '../core/compose';
import type { Gray } from '../core/image';

export const SURFACE_INFO: Record<Surface, { title: string; short: string; enable: Record<string, string>; off: Record<string, string> }> = {
  top: { title: 'Top surface image', short: 'Top', enable: { imgTopMode: 'carve' }, off: { imgTopMode: 'off' } },
  front: { title: 'Front face image', short: 'Front', enable: { imgFrontMode: 'layers', sliceMode: 'parallel' }, off: { imgFrontMode: 'off' } },
  side: { title: 'Side profile image', short: 'Side', enable: { imgSideMode: 'heightmap', stackSource: 'strata' }, off: { imgSideMode: 'off' } },
};

/** Paint a brightness grid onto a canvas at its own resolution. */
export function paintGray(cv: HTMLCanvasElement, g: Gray) {
  cv.width = g.w;
  cv.height = g.h;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(g.w, g.h);
  for (let i = 0; i < g.w * g.h; i++) {
    const c = g.data[i] * 255;
    img.data[i * 4] = c;
    img.data[i * 4 + 1] = c;
    img.data[i * 4 + 2] = c;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function grayDataUrl(g: Gray): string {
  const cv = document.createElement('canvas');
  paintGray(cv, g);
  return cv.toDataURL('image/png');
}

export async function readImage(maxSide = 640): Promise<{ name: string; dataUrl: string } | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return resolve(null);
      readImageFile(f, maxSide).then(resolve);
    };
    inp.click();
  });
}

/** An image file as a project image: downscaled, PNG when it has transparency, else JPEG (null if it is not an image). */
export function readImageFile(f: File, maxSide = 640): Promise<{ name: string; dataUrl: string } | null> {
  return new Promise((resolve) => {
    // downscale big photos before storing them in the project file
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k);
      cv.height = Math.round(img.height * k);
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      // cut-out PNGs keep their transparency (the plates can follow the shape); everything else is stored as a compact JPEG
      const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let clear = false;
      for (let i = 3; i < px.length && !clear; i += 4) clear = px[i] < 250;
      if (clear) return resolve({ name: f.name, dataUrl: cv.toDataURL('image/png') });
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      resolve({ name: f.name, dataUrl: cv.toDataURL('image/jpeg', 0.9) });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** Start a top graphic at roughly the stack's footprint proportions (width across / length along). */
export function topAspectGuess(v: Record<string, any>): number {
  const a = Number(v.plateWidth) / Number(v.stackLength);
  return Number.isFinite(a) && a > 0 ? Math.min(3, Math.max(1 / 3, a)) : 1;
}
