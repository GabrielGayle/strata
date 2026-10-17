// The project library: named saves, each with a small picture of the 3D view.
// This browser keeps a copy in IndexedDB (`strata-library`, origin-scoped — see
// persist.ts). Cloud copies live in Vercel Blob via /api/projects so preview
// URLs and production share one list (hybridLibrary.ts).
import { deserialize, serialize, type Project } from '../core/project';

export interface LibraryMeta {
  id: string;
  name: string;
  /** ms since epoch */
  savedAt: number;
  /** ms since epoch; set when opened from the library (or first saved). */
  openedAt: number;
  /** Small JPEG/WebP data URL of the 3D view, if one could be grabbed. */
  thumb?: string;
  /** Size of the stored project text, in characters. */
  size: number;
  /** ms since epoch; cloud last-write. Falls back to savedAt on older local records. */
  updatedAt?: number;
}

export interface LibraryStore {
  list(): Promise<LibraryMeta[]>;
  getMeta(id: string): Promise<LibraryMeta | undefined>;
  /** The stored project text (project file JSON). */
  getData(id: string): Promise<string | undefined>;
  /** Writes the record, and the project text when given, in one go. */
  put(meta: LibraryMeta, data?: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export const RECENT_COUNT = 5;

export function newEntryId(now = Date.now()): string {
  return `p${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function updatedAtOf(m: LibraryMeta): number {
  return m.updatedAt ?? m.savedAt;
}

/** Newest writes first. */
export function sortEntries(list: LibraryMeta[]): LibraryMeta[] {
  return [...list].sort((a, b) => updatedAtOf(b) - updatedAtOf(a));
}

/** The last few opened, most recent first. */
export function recentEntries(list: LibraryMeta[], n = RECENT_COUNT): LibraryMeta[] {
  return [...list].sort((a, b) => b.openedAt - a.openedAt).slice(0, n);
}

/** `name`, or "name 2", "name 3"… so it doesn't clash with an existing entry. */
export function uniqueName(name: string, taken: string[]): string {
  const base = name.trim() || 'Untitled';
  const set = new Set(taken.map((t) => t.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!set.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** A quick fingerprint of the project text, to tell whether the working copy has moved on from its library entry. */
export function fingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${text.length.toString(36)}`;
}

export const projectFingerprint = (p: Project) => fingerprint(serialize(p));

/** Save the project as a new entry under `name` (the project takes that name too). */
export async function saveAs(store: LibraryStore, p: Project, name: string, thumb?: string, now = Date.now()): Promise<{ meta: LibraryMeta; project: Project }> {
  const project = { ...p, name };
  const data = serialize(project);
  const meta: LibraryMeta = { id: newEntryId(now), name, savedAt: now, openedAt: now, updatedAt: now, size: data.length, ...(thumb ? { thumb } : {}) };
  await store.put(meta, data);
  return { meta, project };
}

/** Overwrite an entry with the project. Keeps the old picture when no new one is given. */
export async function saveOver(store: LibraryStore, id: string, p: Project, thumb?: string, now = Date.now()): Promise<LibraryMeta> {
  const old = await store.getMeta(id);
  if (!old) throw new Error('That project is no longer in the library');
  const data = serialize(p);
  const meta: LibraryMeta = { ...old, name: p.name, savedAt: now, updatedAt: now, size: data.length, ...(thumb ? { thumb } : {}) };
  await store.put(meta, data);
  return meta;
}

/** Read an entry back as a project, and mark it as just opened. */
export async function openEntry(store: LibraryStore, id: string, now = Date.now()): Promise<{ meta: LibraryMeta; project: Project }> {
  const [old, data] = await Promise.all([store.getMeta(id), store.getData(id)]);
  if (!old || data == null) throw new Error('That project is no longer in the library');
  const project = deserialize(data);
  const meta = { ...old, openedAt: now };
  await store.put(meta);
  return { meta, project };
}

/** Rename an entry (and the project inside it). */
export async function renameEntry(store: LibraryStore, id: string, name: string): Promise<LibraryMeta> {
  const [old, data] = await Promise.all([store.getMeta(id), store.getData(id)]);
  if (!old || data == null) throw new Error('That project is no longer in the library');
  const project = { ...deserialize(data), name };
  const text = serialize(project);
  const meta = { ...old, name, size: text.length, updatedAt: Date.now() };
  await store.put(meta, text);
  return meta;
}

/** Copy an entry under a new, unclashing name. */
export async function duplicateEntry(store: LibraryStore, id: string, now = Date.now()): Promise<LibraryMeta> {
  const [old, data, all] = await Promise.all([store.getMeta(id), store.getData(id), store.list()]);
  if (!old || data == null) throw new Error('That project is no longer in the library');
  const name = uniqueName(`${old.name} copy`, all.map((m) => m.name));
  const text = serialize({ ...deserialize(data), name });
  const meta: LibraryMeta = { ...old, id: newEntryId(now), name, savedAt: now, openedAt: 0, updatedAt: now, size: text.length };
  await store.put(meta, text);
  return meta;
}

/**
 * The whole library as one file. Browser storage belongs to a single site
 * address, so this is how saves move to another address, browser or computer.
 */
export const LIBRARY_FORMAT = 'strata-library';

export async function exportLibrary(store: LibraryStore, now = Date.now()): Promise<{ text: string; count: number }> {
  const entries: { meta: LibraryMeta; data: string }[] = [];
  for (const meta of sortEntries(await store.list())) {
    const data = await store.getData(meta.id);
    if (data != null) entries.push({ meta, data });
  }
  return { text: JSON.stringify({ format: LIBRARY_FORMAT, version: 1, exportedAt: now, entries }), count: entries.length };
}

/**
 * Adds the entries of a library file. An entry already here unchanged is
 * skipped; one whose id is taken by a different project comes in as a new
 * entry with a name that doesn't clash. A single project file also works.
 */
export async function importLibrary(store: LibraryStore, text: string, now = Date.now()): Promise<{ added: string[]; skipped: number }> {
  const raw = JSON.parse(text);
  let incoming: { meta?: Partial<LibraryMeta>; data: string }[];
  if (raw?.format === LIBRARY_FORMAT && Array.isArray(raw.entries)) incoming = raw.entries;
  else if (raw?.format === 'strata-project') incoming = [{ data: text }];
  else throw new Error('Not a Strata library or project file');
  const existing = await store.list();
  const prints = new Map<string, string>();
  for (const m of existing) {
    const d = await store.getData(m.id);
    if (d != null) prints.set(m.id, fingerprint(d));
  }
  const have = new Set(prints.values());
  const names = existing.map((m) => m.name);
  const added: string[] = [];
  let skipped = 0;
  for (const [i, e] of incoming.entries()) {
    if (typeof e?.data !== 'string') continue;
    const project = deserialize(e.data); // throws on a broken entry
    const print = fingerprint(e.data);
    if (have.has(print)) {
      skipped++;
      continue;
    }
    const m = e.meta ?? {};
    const id = typeof m.id === 'string' && m.id && !prints.has(m.id) ? m.id : newEntryId(now + i);
    let data = e.data;
    let name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : project.name;
    const unique = uniqueName(name, names);
    if (unique !== name || project.name !== unique) {
      name = unique;
      data = serialize({ ...project, name });
    }
    const savedAt = Number.isFinite(m.savedAt) ? (m.savedAt as number) : now;
    const meta: LibraryMeta = {
      id,
      name,
      savedAt,
      openedAt: Number.isFinite(m.openedAt) ? (m.openedAt as number) : 0,
      updatedAt: Number.isFinite(m.updatedAt) ? (m.updatedAt as number) : savedAt,
      size: data.length,
      ...(typeof m.thumb === 'string' ? { thumb: m.thumb } : {}),
    };
    await store.put(meta, data);
    prints.set(id, fingerprint(data));
    have.add(print);
    names.push(name);
    added.push(name);
  }
  return { added, skipped };
}

export function memoryLibrary(): LibraryStore {
  const meta = new Map<string, LibraryMeta>();
  const data = new Map<string, string>();
  return {
    list: async () => [...meta.values()].map((m) => ({ ...m })),
    getMeta: async (id) => (meta.has(id) ? { ...meta.get(id)! } : undefined),
    getData: async (id) => data.get(id),
    put: async (m, d) => {
      meta.set(m.id, { ...m });
      if (d !== undefined) data.set(m.id, d);
    },
    remove: async (id) => {
      meta.delete(id);
      data.delete(id);
    },
  };
}

const DB = 'strata-library';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new Error('Save was aborted (browser storage may be full)'));
  });
}

export function indexedDbLibrary(idb: IDBFactory): LibraryStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise((res, rej) => {
      const r = idb.open(DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('meta', { keyPath: 'id' });
        r.result.createObjectStore('data');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('The library is blocked by another Strata tab'));
    }));
  return {
    async list() {
      const d = await open();
      return (await req(d.transaction('meta').objectStore('meta').getAll())) as LibraryMeta[];
    },
    async getMeta(id) {
      const d = await open();
      return (await req(d.transaction('meta').objectStore('meta').get(id))) as LibraryMeta | undefined;
    },
    async getData(id) {
      const d = await open();
      return (await req(d.transaction('data').objectStore('data').get(id))) as string | undefined;
    },
    async put(meta, data) {
      const d = await open();
      const tx = d.transaction(data === undefined ? ['meta'] : ['meta', 'data'], 'readwrite');
      tx.objectStore('meta').put(meta);
      if (data !== undefined) tx.objectStore('data').put(data, meta.id);
      await done(tx);
    },
    async remove(id) {
      const d = await open();
      const tx = d.transaction(['meta', 'data'], 'readwrite');
      tx.objectStore('meta').delete(id);
      tx.objectStore('data').delete(id);
      await done(tx);
    },
  };
}

let shared: LibraryStore | null = null;
/** This browser's library (IndexedDB; in memory only when that is unavailable). */
export function defaultLibrary(): LibraryStore {
  if (shared) return shared;
  try {
    if (typeof indexedDB !== 'undefined') return (shared = indexedDbLibrary(indexedDB));
  } catch {
    /* fall through */
  }
  return (shared = memoryLibrary());
}

/**
 * Which library entry each setup tab's working copy came from, and the
 * fingerprint it had then. Small, so it sits in localStorage.
 */
export interface LibraryLink {
  id: string;
  print: string;
}

const LINKS_KEY = 'strata.library.links.v1';

export function readLinks(ls?: Storage): Record<string, LibraryLink> {
  try {
    const s = ls?.getItem(LINKS_KEY);
    const raw = s ? JSON.parse(s) : {};
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function writeLink(setup: string, link: LibraryLink | null, ls?: Storage) {
  const all = readLinks(ls);
  if (link) all[setup] = link;
  else delete all[setup];
  try {
    ls?.setItem(LINKS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** Whether the working copy has changes its library entry doesn't. Unlinked copies count as unsaved. */
export function hasUnsavedChanges(p: Project, link: LibraryLink | undefined): boolean {
  return !link || projectFingerprint(p) !== link.print;
}
