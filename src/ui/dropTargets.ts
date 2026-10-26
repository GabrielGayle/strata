// What a file dropped on the window can become, and the targets offered for it.
export type DropKind = 'image' | 'mesh' | 'project' | 'video';
export type TargetId = 'side' | 'front' | 'top' | 'shadow' | 'ins' | 'src' | 'open' | 'video';

export interface DropTarget {
  id: TargetId;
  kind: DropKind;
  label: string;
  hint: string;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|ogv|mkv)$/i;
const MESH_EXT = /\.(stl|obj|step|stp)$/i;

/** A dropped file's kind from its name and type (null: nothing here takes it). */
export function fileKind(name: string, type = ''): DropKind | null {
  if (/\.json$/i.test(name) || type === 'application/json') return 'project';
  if (/\.zip$/i.test(name) || type === 'application/zip' || type === 'application/x-zip-compressed') return 'project';
  if (MESH_EXT.test(name)) return 'mesh';
  if (type.startsWith('image/') || IMAGE_EXT.test(name)) return 'image';
  if (type.startsWith('video/') || VIDEO_EXT.test(name)) return 'video';
  return null;
}

/**
 * Kinds that may be in a drag, from the item types the browser shows before the drop
 * (no names yet). STL / OBJ usually come through with no type at all.
 */
export function dragKinds(types: string[]): Set<DropKind> {
  const out = new Set<DropKind>();
  for (const t of types) {
    if (t.startsWith('image/')) out.add('image');
    else if (t.startsWith('video/')) out.add('video');
    else if (t === 'application/json' || t === 'application/zip' || t === 'application/x-zip-compressed') out.add('project');
    else if (t === '' || t.startsWith('model/') || t === 'application/sla' || t === 'application/octet-stream' || t === 'application/vnd.ms-pki.stl') {
      out.add('mesh');
      out.add('project'); // some systems hand .json over untyped too
    }
  }
  // no clue (Safari hides the items until the drop): offer everything
  if (!out.size) for (const k of ['image', 'mesh', 'project', 'video'] as DropKind[]) out.add(k);
  return out;
}

/** Targets for the kinds being dragged; pictures go to the shadow frames while the shadow view is up. */
export function dropTargets(kinds: Set<DropKind>, shadowOpen: boolean): DropTarget[] {
  const out: DropTarget[] = [];
  if (kinds.has('image')) {
    if (shadowOpen) out.push({ id: 'shadow', kind: 'image', label: 'Shadow frame', hint: 'add as pictures for the shadow kitchen' });
    else
      out.push(
        { id: 'side', kind: 'image', label: 'Side surface', hint: 'profile: each plate takes a strip as its height' },
        { id: 'front', kind: 'image', label: 'Front surface', hint: 'layered cut-outs on the end face' },
        { id: 'top', kind: 'image', label: 'Top surface', hint: 'pressed into the plate tops' },
      );
  }
  if (kinds.has('mesh'))
    out.push(
      { id: 'ins', kind: 'mesh', label: 'Insert', hint: 'STL / OBJ as the cavity cutter' },
      { id: 'src', kind: 'mesh', label: 'Source form', hint: 'STL / OBJ to slice into plates' },
    );
  if (kinds.has('project')) out.push({ id: 'open', kind: 'project', label: 'Open project', hint: '.strata.json or fabrication zip, replaces the working copy; a .lace-loft.json becomes the plates' });
  if (kinds.has('video')) out.push({ id: 'video', kind: 'video', label: 'Shadow video', hint: 'pull stills from a clip for the shadow kitchen' });
  return out;
}
