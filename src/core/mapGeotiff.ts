// GeoTIFF → Float32Grid (EA WCS 1 m elevation rasters).
import { fromArrayBuffer } from 'geotiff';
import type { Float32Grid, GridTransform } from './mapGrid';

const NODATA = -3.4028235e38;
/** Decode cap if WCS ignored SCALEFACTOR (native Neasden is ~12 M cells). */
const MAX_DECODE_CELLS = 512 * 512;

export async function parseFloat32Geotiff(buf: Uint8Array): Promise<Float32Grid> {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const tiff = await fromArrayBuffer(ab);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const cells = width * height;
  const scale = cells > MAX_DECODE_CELLS ? Math.sqrt(MAX_DECODE_CELLS / cells) : 1;
  const readW = Math.max(2, Math.round(width * scale));
  const readH = Math.max(2, Math.round(height * scale));
  const rasters = (await image.readRasters({
    interleave: true,
    width: readW,
    height: readH,
    resampleMethod: scale < 1 ? 'bilinear' : 'nearest',
  })) as Float32Array | number[];
  const data = rasters instanceof Float32Array ? rasters : new Float32Array(rasters);
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i]) || data[i] <= NODATA + 1) data[i] = NaN;
  }
  const origin = image.getOrigin?.() as number[] | undefined;
  const bbox = image.getBoundingBox();
  const res = image.getResolution?.() as number[] | undefined;
  const sx = width / readW;
  const sy = height / readH;
  const pixelW = (res?.[0] ?? 1) * sx;
  const pixelH = -Math.abs(res?.[1] ?? 1) * sy;
  const transform: GridTransform = {
    originX: bbox?.[0] ?? origin?.[0] ?? 0,
    originY: bbox?.[3] ?? origin?.[1] ?? 0,
    pixelW,
    pixelH,
  };
  return {
    w: readW,
    h: readH,
    data,
    crs: 'EPSG:27700',
    transform,
  };
}
