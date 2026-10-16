// Minimal JPEG EXIF reader for 35 mm-equivalent focal length → pixels on the image.

function readU16(buf: Uint8Array, off: number, le: boolean): number {
  return le ? buf[off] | (buf[off + 1] << 8) : (buf[off] << 8) | buf[off + 1];
}

function readU32(buf: Uint8Array, off: number, le: boolean): number {
  return le
    ? buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)
    : (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
}

/** Focal length in pixels on the image width (horizontal), or undefined if not found. */
export function exifFocalLengthPx(jpeg: Uint8Array, imageWidth: number): number | undefined {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 4 < jpeg.length) {
    if (jpeg[i] !== 0xff) break;
    const marker = jpeg[i + 1];
    const len = readU16(jpeg, i + 2, false);
    if (len < 2) break;
    if (marker === 0xe1) {
      const start = i + 4;
      if (start + 6 > jpeg.length) break;
      const hdr = String.fromCharCode(jpeg[start], jpeg[start + 1], jpeg[start + 2], jpeg[start + 3]);
      if (hdr !== 'Exif') break;
      const tiff = start + 6;
      if (tiff + 8 > jpeg.length) break;
      const le = jpeg[tiff] === 0x49 && jpeg[tiff + 1] === 0x49;
      const ifd0 = tiff + readU32(jpeg, tiff + 4, le);
      const exif = walkIfd(jpeg, ifd0, le, imageWidth);
      if (exif != null) return exif;
    }
    i += 2 + len;
  }
  return undefined;
}

function walkIfd(buf: Uint8Array, ifd: number, le: boolean, imageWidth: number): number | undefined {
  if (ifd + 2 > buf.length) return undefined;
  const n = readU16(buf, ifd, le);
  let exifIfd = 0;
  let focal35 = 0;
  let focal = 0;
  let focalDenom = 1;
  for (let e = 0; e < n; e++) {
    const ent = ifd + 2 + e * 12;
    if (ent + 12 > buf.length) break;
    const tag = readU16(buf, ent, le);
    const typ = readU16(buf, ent + 2, le);
    const cnt = readU32(buf, ent + 4, le);
    const valOff = ent + 8;
    if (tag === 0x8769) exifIfd = readU32(buf, valOff, le);
    if (tag === 0xa405 && typ === 3 && cnt >= 1) focal35 = readU16(buf, valOff, le);
    if (tag === 0x920a && typ === 5 && cnt >= 1) {
      const at = readU32(buf, valOff, le);
      if (at + 8 <= buf.length) {
        focal = readU32(buf, at, le);
        focalDenom = readU32(buf, at + 4, le) || 1;
      }
    }
  }
  if (focal35 > 0) return (focal35 / 36) * imageWidth;
  if (focal > 0 && focalDenom > 0) {
    const mm = focal / focalDenom;
    return (mm / 36) * imageWidth;
  }
  if (exifIfd) return walkExifSub(buf, exifIfd, le, imageWidth);
  return undefined;
}

function walkExifSub(buf: Uint8Array, ifd: number, le: boolean, imageWidth: number): number | undefined {
  if (ifd + 2 > buf.length) return undefined;
  const n = readU16(buf, ifd, le);
  let focal35 = 0;
  let focal = 0;
  let focalDenom = 1;
  for (let e = 0; e < n; e++) {
    const ent = ifd + 2 + e * 12;
    if (ent + 12 > buf.length) break;
    const tag = readU16(buf, ent, le);
    const typ = readU16(buf, ent + 2, le);
    const cnt = readU32(buf, ent + 4, le);
    const valOff = ent + 8;
    if (tag === 0xa405 && typ === 3 && cnt >= 1) focal35 = readU16(buf, valOff, le);
    if (tag === 0x920a && typ === 5 && cnt >= 1) {
      const at = readU32(buf, valOff, le);
      if (at + 8 <= buf.length) {
        focal = readU32(buf, at, le);
        focalDenom = readU32(buf, at + 4, le) || 1;
      }
    }
  }
  if (focal35 > 0) return (focal35 / 36) * imageWidth;
  if (focal > 0 && focalDenom > 0) return ((focal / focalDenom) / 36) * imageWidth;
  return undefined;
}

/** Parse focal length from a JPEG data URL (browser or Node). */
export function exifFocalFromDataUrl(dataUrl: string, imageWidth: number): number | undefined {
  const i = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || i < 0 || !/base64/i.test(dataUrl.slice(0, i))) return undefined;
  const bin = atob(dataUrl.slice(i + 1));
  const bytes = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
  return exifFocalLengthPx(bytes, imageWidth);
}
