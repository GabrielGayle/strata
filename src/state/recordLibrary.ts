import type { Project } from '../core/project';
import { defaultProjectLibrary } from './hybridLibrary';
import { projectFingerprint, saveAs, saveOver, uniqueName, type LibraryMeta, type LibrarySource, type LibraryStore } from './library';

/** Put this project in the library (cloud + local). Linked id or the same fingerprint overwrites; a same name with different content becomes a new entry. */
export async function recordLibrarySave(
  project: Project,
  opts: { source: LibrarySource; plates?: number; thumb?: string; name?: string; linkId?: string } = { source: 'library' },
  store: LibraryStore = defaultProjectLibrary(),
): Promise<LibraryMeta> {
  const named = { ...project, name: opts.name ?? project.name };
  const print = projectFingerprint(named);
  const all = await store.list();
  const hit = (opts.linkId ? all.find((m) => m.id === opts.linkId) : undefined) ?? all.find((m) => m.print === print);
  const fields: Partial<LibraryMeta> = {
    source: opts.source,
    ...(opts.plates != null ? { plateCount: opts.plates } : {}),
  };
  const thumb = opts.thumb;
  if (hit) {
    return saveOver(store, hit.id, named, thumb, Date.now(), fields);
  }
  const { meta } = await saveAs(store, named, uniqueName(named.name, all.map((m) => m.name)), thumb, Date.now(), fields);
  return meta;
}
