/** Minimal uncompressed little-endian Float32 GeoTIFF with GDAL_NODATA. */

export function encodeFloat32Geotiff(
  width: number,
  height: number,
  data: Float32Array,
  nodata: number,
): Uint8Array {
  if (data.length !== width * height) throw new Error('encodeFloat32Geotiff: size mismatch');
  const imageBytes = data.byteLength;
  const nodataAscii = `${nodata}\0`;
  const nodataPad = nodataAscii.length + (nodataAscii.length % 2);

  const extraScale = 24;
  const extraTie = 48;
  const imageOff = 8;
  const extraOff = imageOff + imageBytes;
  const scaleOff = extraOff;
  const tieOff = scaleOff + extraScale;
  const nodataOff = tieOff + extraTie;
  const extraLen = extraScale + extraTie + nodataPad;
  const ifdOff = extraOff + extraLen;
  const nTags = 13;
  const buf = new ArrayBuffer(ifdOff + 2 + nTags * 12 + 4);
  const u8 = new Uint8Array(buf);
  const view = new DataView(buf);

  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOff, true);
  u8.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), imageOff);

  view.setFloat64(scaleOff, 1, true);
  view.setFloat64(scaleOff + 8, 1, true);
  view.setFloat64(scaleOff + 16, 0, true);
  view.setFloat64(tieOff, 0, true);
  view.setFloat64(tieOff + 8, 0, true);
  view.setFloat64(tieOff + 16, 0, true);
  view.setFloat64(tieOff + 24, 0, true);
  view.setFloat64(tieOff + 32, height, true);
  view.setFloat64(tieOff + 40, 0, true);
  for (let i = 0; i < nodataAscii.length; i++) u8[nodataOff + i] = nodataAscii.charCodeAt(i);

  let p = ifdOff;
  view.setUint16(p, nTags, true);
  p += 2;
  const entry = (tag: number, type: number, count: number, valueOrOff: number) => {
    view.setUint16(p, tag, true);
    view.setUint16(p + 2, type, true);
    view.setUint32(p + 4, count, true);
    view.setUint32(p + 8, valueOrOff, true);
    p += 12;
  };
  const SHORT = 3;
  const LONG = 4;
  const ASCII = 2;
  const DOUBLE = 12;
  entry(256, LONG, 1, width);
  entry(257, LONG, 1, height);
  entry(258, SHORT, 1, 32);
  entry(259, SHORT, 1, 1);
  entry(262, SHORT, 1, 1);
  entry(273, LONG, 1, imageOff);
  entry(277, SHORT, 1, 1);
  entry(278, LONG, 1, height);
  entry(279, LONG, 1, imageBytes);
  entry(339, SHORT, 1, 3);
  entry(33550, DOUBLE, 3, scaleOff);
  entry(33922, DOUBLE, 6, tieOff);
  entry(42113, ASCII, nodataAscii.length, nodataOff);
  view.setUint32(p, 0, true);
  return u8;
}
