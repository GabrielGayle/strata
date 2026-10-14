// "Depth from photo": sends a photo to the Depth Pro endpoint (Modal worker in
// promptda-depth-generator) and gets back a grey relief plate in Strata's
// convention: near subject = dark, background = white.

export type DepthMode = 'relief' | 'depth';

/** Endpoint URL, e.g. https://<workspace>--strata-depth.modal.run/strata. Unset = feature off. */
export const DEPTH_URL: string | undefined = (import.meta.env.VITE_DEPTH_URL as string | undefined)?.trim() || undefined;

export interface DepthResult {
  png: string;
  width: number;
  height: number;
  coldStart: boolean;
}

export function parseDepthResponse(body: unknown): DepthResult {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.png !== 'string' || !b.png.startsWith('data:image/png;base64,')) {
    throw new Error(typeof b.detail === 'string' ? b.detail : 'Depth service returned no image');
  }
  return { png: b.png, width: Number(b.width) || 0, height: Number(b.height) || 0, coldStart: !!b.cold_start };
}

export async function depthFromPhoto(
  photo: string,
  opts: { mode?: DepthMode; url?: string; signal?: AbortSignal } = {},
): Promise<DepthResult> {
  const url = opts.url ?? DEPTH_URL;
  if (!url) throw new Error('Depth service not configured (set VITE_DEPTH_URL)');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: photo, mode: opts.mode ?? 'relief', max_side: 512 }),
    signal: opts.signal,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // fall through to the status error
  }
  if (!res.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail;
    throw new Error(typeof detail === 'string' ? detail : `Depth service error ${res.status}`);
  }
  return parseDepthResponse(body);
}

/** Flip a grey PNG (near = dark → near = bright), for slots that read bright as high. */
export async function invertDataUrl(dataUrl: string): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height);
  for (let i = 0; i < px.data.length; i += 4) {
    px.data[i] = 255 - px.data[i];
    px.data[i + 1] = 255 - px.data[i + 1];
    px.data[i + 2] = 255 - px.data[i + 2];
  }
  ctx.putImageData(px, 0, 0);
  return cv.toDataURL('image/png');
}
