// The app's check on a fabrication zip made somewhere else (the cloud pack job):
// the same plates and parts as the design on screen, or no download at all.
import { strFromU8, unzipSync } from 'fflate';
import type { Model } from './pipeline';

/** Why the zip doesn't match the model, or null when every plate and part is there. */
export function packMismatch(zip: Uint8Array, model: Pick<Model, 'sliced'>): string | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip, { filter: (f) => f.name === 'manifest.json' || (f.name.startsWith('laser/parts/') && f.name.endsWith('.dxf')) });
  } catch {
    return 'the cloud pack is not a readable zip';
  }
  if (!files['manifest.json']) return 'the cloud pack has no manifest';
  let manifest: { plateCount?: number; partCount?: number; plates?: { key: string }[] };
  try {
    manifest = JSON.parse(strFromU8(files['manifest.json']));
  } catch {
    return 'the cloud pack manifest is unreadable';
  }
  const plates = model.sliced.plates.length;
  const parts = model.sliced.parts.length;
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? '' : 's'}`;
  if (manifest.plateCount !== plates) return `the cloud pack has ${n(manifest.plateCount ?? 0, 'plate')} and this design has ${plates}`;
  if (manifest.partCount !== parts) return `the cloud pack has ${n(manifest.partCount ?? 0, 'part')} and this design has ${parts}`;
  const dxfs = Object.keys(files).filter((f) => f.startsWith('laser/parts/')).length;
  if (dxfs !== parts) return `the cloud pack has ${n(dxfs, 'part DXF')} and this design has ${n(parts, 'part')}`;
  const want = model.sliced.plates.map((p) => p.def.key).join(',');
  const got = (manifest.plates ?? []).map((p) => p.key).join(',');
  if (want !== got) return 'the cloud pack numbers its plates differently from this design';
  return null;
}
