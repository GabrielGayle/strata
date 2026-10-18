// GeoTIFF → Float32Grid (EA WCS 1 m elevation rasters).
import { fromArrayBuffer } from 'geotiff';
import type { Float32Grid, GridTransform } from './mapGrid';
import {
  downsampleNaNAware,
  FLOAT32_NODATA,
  maskElevationSamples,
} from './mapElevation';

/** Decode cap if WCS ignored SCALEFACTOR (native Neasden is ~12 M cells). */
const MAX_DECODE_CELLS = 512 * 512;
/** Read natively (then NaN-aware downsample) up to this many cells (~64 MB Float32). */
const MAX_NATIVE_CELLS = 16 * 1024 * 1024;

function asFloat32(rasters: Float32Array | number[] | ArrayLike<number>): Float32Array {
  return rasters instanceof Float32Array ? rasters : new Float32Array(rasters as ArrayLike<number>);
}

function gdalNodata(image: {
  getGDALNoData?: () => number | null;
  fileDirectory?: { GDAL_NODATA?: unknown };
}): number {
  const fromApi = image.getGDALNoData?.();
  if (typeof fromApi === 'number' && Number.isFinite(fromApi)) return fromApi;
  const raw = image.fileDirectory?.GDAL_NODATA;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw.replace(/\0+$/g, '').trim());
    if (Number.isFinite(n)) return n;
  }
  return FLOAT32_NODATA;
}

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
  const nodata = gdalNodata(image);

  let srcW: number;
  let srcH: number;
  let data: Float32Array;
  // Mask nodata before any bilinear resample. Native read, or nearest if the
  // raster is too large — nearest never blends ±3.4e38 into finite neighbours.
  if (cells <= MAX_NATIVE_CELLS || scale >= 1) {
    const rasters = (await image.readRasters({ interleave: true })) as Float32Array | number[];
    data = asFloat32(rasters);
    srcW = width;
    srcH = height;
  } else {
    const midScale = Math.min(1, Math.sqrt(MAX_NATIVE_CELLS / cells));
    srcW = Math.max(readW, Math.round(width * midScale));
    srcH = Math.max(readH, Math.round(height * midScale));
    const rasters = (await image.readRasters({
      interleave: true,
      width: srcW,
      height: srcH,
      resampleMethod: 'nearest',
    })) as Float32Array | number[];
    data = asFloat32(rasters);
  }
  maskElevationSamples(data, nodata);
  if (srcW !== readW || srcH !== readH) data = downsampleNaNAware(data, srcW, srcH, readW, readH);

  const origin = image.getOrigin?.() as number[] | undefined;
  const bbox = image.getBoundingBox();
  const res = image.getResolution?.() as number[] | undefined;
  const sx = width / readW;
  const sy = height / readH;
  const pixelW = (res?.[0] ?? 1) * sx;
  const pixelH = -Math.abs(res?.[1] ?? 1) * sy;
  // GeoTIFF bbox / origin is the outer edge of the top-left pixel; GridTransform wants its centre.
  const transform: GridTransform = {
    originX: (bbox?.[0] ?? origin?.[0] ?? 0) + pixelW / 2,
    originY: (bbox?.[3] ?? origin?.[1] ?? 0) + pixelH / 2,
    pixelW,
    pixelH,
  };
  return {
    w: readW,
    h: readH,
    data,
    crs: 'EPSG:27700',
    transform,
    nodata,
  };
}
