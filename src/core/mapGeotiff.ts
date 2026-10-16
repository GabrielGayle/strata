// GeoTIFF → Float32Grid (EA WCS 1 m elevation rasters).
import { fromArrayBuffer } from 'geotiff';
import type { Float32Grid, GridTransform } from './mapGrid';

const NODATA = -3.4028235e38;

export async function parseFloat32Geotiff(buf: Uint8Array): Promise<Float32Grid> {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const tiff = await fromArrayBuffer(ab);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const rasters = (await image.readRasters({ interleave: true })) as Float32Array | number[];
  const data = rasters instanceof Float32Array ? rasters : new Float32Array(rasters);
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i]) || data[i] <= NODATA + 1) data[i] = NaN;
  }
  const [originX, pixelW, , originY, , pixelH] = image.getGeoKeys()
    ? image.getOrigin()
    : [0, 1, 0, 0, 0, -1];
  const bbox = image.getBoundingBox();
  const transform: GridTransform = {
    originX: bbox?.[0] ?? originX,
    originY: bbox?.[3] ?? originY,
    pixelW: image.getResolution()?.[0] ?? pixelW,
    pixelH: -(image.getResolution()?.[1] ?? Math.abs(pixelH)),
  };
  return {
    w: width,
    h: height,
    data,
    crs: 'EPSG:27700',
    transform,
  };
}
