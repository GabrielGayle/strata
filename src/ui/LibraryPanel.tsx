// Projects library (named saves) and share links. Cloud copy is /api/projects.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { useStore } from '../state/store';
import type { Project } from '../core/project';
import { decodeShare, LONG_LINK, projectFromShare, shareCodeFromHash, shareLink, type ShareState } from '../core/share';
import {
  defaultLibrary, duplicateEntry, exportLibrary, hasUnsavedChanges, importLibrary, openEntry, projectFingerprint, readLinks, recentEntries, renameEntry, saveAs, saveOver, uniqueName, writeLink,
  type LibraryLink, type LibraryMeta,
} from '../state/library';
import { defaultCloudLibrary, probeCloud } from '../state/cloudLibrary';
import { cloudSyncLabel, getCloudSync, subscribeCloudSync, takeCloudWarning } from '../state/cloudSync';
import {
  defaultProjectLibrary, hasMigrated, localProjectsPendingMigration, markMigrated, migrateLocalToCloud, migrateSkippedThisSession, skipMigrateThisSession,
} from '../state/hybridLibrary';
import { readOwnerToken, writeOwnerToken } from '../state/ownerToken';
import { isOneOffAddress, MAIN_HOST } from '../state/persist';
import { download } from '../core/exporters';
import { isProjectZipName, projectFromZip } from '../core/projectZip';
import { LibraryBrowser } from './LibraryBrowser';
import { recordLibrarySave } from '../state/recordLibrary';

const host = () => (typeof location !== 'undefined' ? location.host : '');

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    inp.click();
  });
}

const ls = () => (typeof localStorage !== 'undefined' ? localStorage : undefined);
const linkOf = (setup: string): LibraryLink | undefined => readLinks(ls())[setup];
const link = (setup: string, l: LibraryLink | null) => writeLink(setup, l, ls());

/** Forget which library entry the active tab came from (e.g. after opening a project file over it). */
export function unlinkActive() {
  link(useStore.getState().activeSetup, null);
}

/** After opening a zip/JSON, offer to keep it in the (cloud) library. */
export async function keepOpenedInLibrary(project: Project, sourceName: string): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!window.confirm(`Save “${project.name}” from ${sourceName} to Projects so it appears on other builds?`)) return;
  const store = defaultProjectLibrary();
  const { toast, setName } = useStore.getState();
  try {
    const names = (await store.list()).map((m) => m.name);
    const name = uniqueName(project.name, names);
    const { meta, project: saved } = await saveAs(store, project, name, grabThumb(), Date.now(), { source: 'import' });
    setName(saved.name);
    link(useStore.getState().activeSetup, { id: meta.id, print: projectFingerprint(saved) });
    const warn = takeCloudWarning();
    toast(warn ?? `Saved “${meta.name}” to Projects`);
  } catch (e) {
    toast(`Could not save to Projects: ${(e as Error).message}`);
  }
}

/** A small picture of the 3D view: the largest three.js canvas on screen, scaled down. Undefined when there is none (or it reads blank). */
export function grabThumb(w = 320, h = 220): string | undefined {
  try {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('canvas[data-engine]')].filter((c) => c.width > 0 && c.height > 0);
    const src = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!src) return undefined;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    if (!g) return undefined;
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--viewport').trim() || '#e6e3dc';
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    // cover: crop the middle of the view to the thumbnail's shape
    const s = Math.max(w / src.width, h / src.height);
    const sw = w / s;
    const sh = h / s;
    g.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    let same = true;
    for (let i = 4; i < px.length && same; i += 4 * 97) same = px[i] === px[0] && px[i + 1] === px[1] && px[i + 2] === px[2];
    if (same) return undefined;
    const webp = cv.toDataURL('image/webp', 0.72);
    return webp.startsWith('data:image/webp') ? webp : cv.toDataURL('image/jpeg', 0.75);
  } catch {
    return undefined;
  }
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="pm-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`window pm lib ${wide ? '' : 'narrow'}`} role="dialog" aria-modal="true" aria-label={title} data-testid={title === 'Projects' ? 'projects-dialog' : undefined}>
        <div className="title-bar">
          <div className="title-bar-text">{title}</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onClose}></button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function Thumb({ m }: { m: LibraryMeta }) {
  return m.thumb ? <img src={m.thumb} alt="" /> : <span className="lib-nothumb">{m.name.slice(0, 1).toUpperCase()}</span>;
}

function LibraryPanel({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const setup = useStore((s) => s.activeSetup);
  const { replaceProject, setName, toast } = useStore.getState();
  const store = defaultProjectLibrary();
  const local = defaultLibrary();
  const cloud = defaultCloudLibrary();
  const sync = useSyncExternalStore(subscribeCloudSync, getCloudSync, getCloudSync);
  const [list, setList] = useState<LibraryMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(() => readOwnerToken() ?? '');
  const [tokenDraft, setTokenDraft] = useState('');
  const [migrate, setMigrate] = useState<LibraryMeta[] | null>(null);
  const [lnk, setLnk] = useState(() => linkOf(setup));
  const current = lnk && list?.find((m) => m.id === lnk.id);
  const dirty = useMemo(() => hasUnsavedChanges(project, current ? lnk : undefined), [project, current, lnk]);
  const unlocked = !!token;

  const refresh = useCallback(async () => {
    try {
      setList(await store.list());
      setError(null);
    } catch (e) {
      setError(`The library could not be read: ${(e as Error).message}`);
      setList([]);
    }
  }, [store]);

  const considerMigrate = useCallback(async () => {
    if (!readOwnerToken() || hasMigrated() || migrateSkippedThisSession()) {
      setMigrate(null);
      return;
    }
    try {
      const [localList, cloudList] = await Promise.all([local.list(), cloud.list()]);
      const pending = localProjectsPendingMigration(localList, cloudList);
      setMigrate(pending.length ? pending : null);
      if (!pending.length && localList.length) markMigrated();
    } catch {
      /* cloud probe already reported */
    }
  }, [cloud, local]);

  useEffect(() => void refresh(), [refresh]);
  useEffect(() => setLnk(linkOf(setup)), [setup]);
  useEffect(() => {
    if (unlocked) void considerMigrate();
  }, [unlocked, considerMigrate]);

  const relink = (l: LibraryLink | null) => {
    link(setup, l);
    setLnk(l ?? undefined);
  };
  const run = async (what: () => Promise<void>) => {
    setBusy(true);
    try {
      await what();
    } catch (e) {
      toast(`Library: ${(e as Error).message}`);
    } finally {
      const warn = takeCloudWarning();
      if (warn) toast(warn);
      setBusy(false);
      void refresh();
    }
  };

  const unlock = (e: FormEvent) => {
    e.preventDefault();
    const next = tokenDraft.trim();
    if (!next) return;
    writeOwnerToken(next);
    setToken(next);
    void probeCloud();
    void run(async () => {
      await considerMigrate();
    });
  };

  const forgetToken = () => {
    writeOwnerToken(null);
    setToken('');
    setTokenDraft('');
    setMigrate(null);
    void probeCloud();
    void refresh();
  };

  const doMigrate = () =>
    void run(async () => {
      const r = await migrateLocalToCloud(local, cloud);
      markMigrated();
      setMigrate(null);
      toast(r.added.length ? `Uploaded ${r.added.length} project${r.added.length === 1 ? '' : 's'} to the cloud` : 'Nothing new to upload');
    });

  const doSaveAs = () => {
    const name = window.prompt('Save to the library as', uniqueName(project.name, (list ?? []).map((m) => m.name)));
    if (!name?.trim()) return;
    void run(async () => {
      const r = await saveAs(store, project, name.trim(), grabThumb(), Date.now(), { source: 'save' });
      if (r.project.name !== project.name) setName(r.project.name);
      relink({ id: r.meta.id, print: projectFingerprint(r.project) });
      toast(`Saved "${r.meta.name}" to the library`);
    });
  };
  const doSave = () => {
    if (!current) return doSaveAs();
    void run(async () => {
      const m = await saveOver(store, current.id, project, grabThumb());
      relink({ id: m.id, print: projectFingerprint(project) });
      toast(`Saved "${m.name}"`);
    });
  };
  const doOpen = (m: LibraryMeta) => {
    if (current?.id === m.id && !dirty) return toast(`"${m.name}" is already open`);
    const unsaved = current ? dirty : useStore.getState().past.length > 0;
    if (unsaved && !window.confirm(`Open "${m.name}"? It replaces your working copy${current ? `, which has changes not saved to "${current.name}"` : ', which is not in the library'}. Undo brings it back.`)) return;
    void run(async () => {
      const r = await openEntry(store, m.id);
      replaceProject(r.project);
      relink({ id: m.id, print: projectFingerprint(r.project) });
      toast(`Opened "${m.name}" (Undo brings back the previous working copy)`);
      onClose();
    });
  };
  const doRename = (m: LibraryMeta) => {
    const name = window.prompt('Rename project', m.name);
    if (!name?.trim() || name.trim() === m.name) return;
    void run(async () => {
      await renameEntry(store, m.id, name.trim());
      if (current?.id === m.id && !dirty) {
        setName(name.trim());
        relink({ id: m.id, print: projectFingerprint({ ...project, name: name.trim() }) });
      }
    });
  };
  const doDuplicate = (m: LibraryMeta) =>
    void run(async () => {
      const d = await duplicateEntry(store, m.id);
      toast(`Duplicated as "${d.name}"`);
    });
  const doDelete = (m: LibraryMeta) => {
    if (!window.confirm(`Delete "${m.name}" from the library? This can't be undone.`)) return;
    void run(async () => {
      await store.remove(m.id);
      if (lnk?.id === m.id) relink(null);
      toast(`Deleted "${m.name}"`);
    });
  };
  const doPatch = (m: LibraryMeta, patch: Partial<LibraryMeta>) =>
    void run(async () => {
      await store.put({ ...m, ...patch, updatedAt: Date.now() });
    });

  const doExport = () =>
    void run(async () => {
      const { text, count } = await exportLibrary(store);
      if (!count) return toast('The library is empty: nothing to export');
      download(`strata-library-${new Date().toISOString().slice(0, 10)}.json`, text, 'application/json');
      toast(`Exported ${count} project${count === 1 ? '' : 's'}`);
    });
  const doImport = async () => {
    const file = await pickFile('.json,.zip,application/json,application/zip');
    if (!file) return;
    void run(async () => {
      if (isProjectZipName(file.name, file.type)) {
        const { project: opened } = projectFromZip(new Uint8Array(await file.arrayBuffer()));
        const names = (list ?? []).map((m) => m.name);
        const meta = await recordLibrarySave(opened, { source: 'import', thumb: grabThumb(), name: uniqueName(opened.name, names) });
        toast(`Added “${meta.name}” from ${file.name}`);
        return;
      }
      const { added, skipped } = await importLibrary(store, await file.text());
      const already = skipped ? ` (${skipped} already here)` : '';
      toast(added.length ? `Added ${added.length} project${added.length === 1 ? '' : 's'} to the library${already}` : `Nothing new to add${already}`);
    });
  };

  const here = host();
  const recent = list ? recentEntries(list.filter((m) => m.openedAt > 0)) : [];
  return (
    <Modal title="Projects" onClose={onClose} wide>
      <div className="lib-bar">
        <div className="lib-working">
          <b>Working copy:</b> {project.name}
          <small>
            {current ? (dirty ? ` · changed since saved to "${current.name}"` : ` · saved as "${current.name}"`) : ' · not in the library yet'}
            {unlocked ? ' · cloud + this browser' : ' · this browser only until you unlock the cloud'}
          </small>
        </div>
        <span
          className={`lib-sync ${sync.status}`}
          data-testid="projects-sync"
          data-sync-status={sync.status}
          title={sync.detail ?? cloudSyncLabel(sync.status)}
        >
          {cloudSyncLabel(sync.status)}
        </span>
        <span className="seg">
          <button className="btn sm" disabled={busy || !current} onClick={doSave} title={current ? `Overwrite "${current.name}" in the library` : 'Use Save as first'}>
            Save
          </button>
          <button className="btn sm primary" disabled={busy} onClick={doSaveAs}>
            Save as…
          </button>
        </span>
        <span className="seg">
          <button className="btn sm" disabled={busy} onClick={doExport} title="Download every project in the library as one file, to move them to another address, browser or computer">
            Export all
          </button>
          <button className="btn sm" disabled={busy} onClick={() => void doImport()} title="Add the projects from a library file (or a single project file)">
            Import…
          </button>
        </span>
      </div>
      {!unlocked && (
        <form className="lib-gate" onSubmit={unlock} data-testid="projects-token-form">
          <label>
            <span>Access token</span>
            <input
              type="password"
              autoComplete="off"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              aria-label="Access token"
              data-testid="projects-token"
              placeholder="STRATA_OWNER_TOKEN"
            />
          </label>
          <button className="btn sm primary" type="submit" disabled={busy || !tokenDraft.trim()}>
            Unlock cloud
          </button>
          <small>Without it this address cannot read or write cloud projects.</small>
        </form>
      )}
      {unlocked && (
        <div className="lib-note">
          Cloud unlocked.{' '}
          <button className="btn sm" type="button" onClick={forgetToken}>
            Forget token
          </button>
        </div>
      )}
      {migrate && migrate.length > 0 && (
        <div className="lib-note warn" data-testid="projects-migrate">
          This browser has {migrate.length} project{migrate.length === 1 ? '' : 's'} that only live here. Upload them to the cloud so they appear on other builds?
          <span className="seg">
            <button className="btn sm primary" disabled={busy} onClick={doMigrate}>
              Upload
            </button>
            <button
              className="btn sm"
              disabled={busy}
              onClick={() => {
                skipMigrateThisSession();
                setMigrate(null);
              }}
            >
              Not now
            </button>
          </span>
        </div>
      )}
      {isOneOffAddress(here) && (
        <div className="lib-note warn">
          This is a one-off build address ({here}). Named projects go to the cloud once you enter the access token, so they appear at{' '}
          <a href={`https://${MAIN_HOST}`}>{MAIN_HOST}</a> and other previews. This browser still keeps a local copy.
        </div>
      )}
      {error && <div className="lib-note err">{error}</div>}
      {recent.length > 0 && (
        <>
          <div className="lib-head">Recent</div>
          <div className="lib-recent">
            {recent.map((m) => (
              <button key={m.id} className={`lib-chip ${current?.id === m.id ? 'on' : ''}`} onClick={() => doOpen(m)} disabled={busy} title={`Open "${m.name}"`}>
                <Thumb m={m} />
                <span>{m.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="lib-head">All saves{list ? ` (${list.length})` : ''}</div>
      <LibraryBrowser
        store={store}
        list={list}
        currentId={current?.id}
        busy={busy}
        onOpen={doOpen}
        onRename={doRename}
        onDuplicate={doDuplicate}
        onDelete={doDelete}
        onPatch={doPatch}
        onError={(msg) => toast(msg)}
      />
      <div className="lib-note">
        {unlocked
          ? `Cloud projects are shared across builds. This browser${here ? ` at ${here}` : ''} still keeps a local copy if you go offline.`
          : `Kept in this browser${here ? ` at ${here}` : ''} only until you unlock the cloud. Export all still makes a backup you can Import anywhere.`}
      </div>
    </Modal>
  );
}

export function CloudSyncMark() {
  const sync = useSyncExternalStore(subscribeCloudSync, getCloudSync, getCloudSync);
  useEffect(() => {
    void probeCloud();
    const onNet = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      void probeCloud();
    };
    const onOff = () => probeCloud();
    window.addEventListener('online', onNet);
    window.addEventListener('offline', onOff);
    return () => {
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onOff);
    };
  }, []);
  return (
    <span
      className={`save-mark cloud ${sync.status}`}
      data-testid="cloud-sync"
      data-sync-status={sync.status}
      role="status"
      title={sync.detail ?? (sync.status === 'locked' ? 'Enter the access token in Projects to read and write cloud saves.' : 'Named projects in the cloud, shared across builds.')}
    >
      {cloudSyncLabel(sync.status)}
    </span>
  );
}

export function ProjectsButton() {
  const [open, setOpen] = useState(false);
  const setUi = useStore((s) => s.setUi);
  return (
    <>
      <button
        className="tb"
        onClick={() => {
          setUi({ leftPane: 'saves' });
          setOpen(true);
        }}
        title="Saves browser: cloud and local projects"
      >
        Projects
      </button>
      {open && <LibraryPanel onClose={() => setOpen(false)} />}
    </>
  );
}

/** Compact saves browser for the left side panel. */
export function SavesPanel() {
  const setup = useStore((s) => s.activeSetup);
  const { replaceProject, setName, toast } = useStore.getState();
  const store = defaultProjectLibrary();
  const [list, setList] = useState<LibraryMeta[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [lnk, setLnk] = useState(() => linkOf(setup));
  const current = lnk && list?.find((m) => m.id === lnk.id);

  const refresh = useCallback(async () => {
    try {
      setList(await store.list());
    } catch {
      setList([]);
    }
  }, [store]);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => setLnk(linkOf(setup)), [setup]);

  const relink = (l: LibraryLink | null) => {
    link(setup, l);
    setLnk(l ?? undefined);
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(`Library: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      void refresh();
    }
  };
  const doOpen = (m: LibraryMeta) =>
    void run(async () => {
      const { project: p, meta } = await openEntry(store, m.id);
      replaceProject(p);
      relink({ id: meta.id, print: projectFingerprint(p) });
    });
  const doRename = (m: LibraryMeta) => {
    const name = window.prompt('Rename project', m.name);
    if (!name?.trim() || name.trim() === m.name) return;
    void run(async () => {
      await renameEntry(store, m.id, name.trim());
      if (current?.id === m.id) setName(name.trim());
    });
  };
  const doDuplicate = (m: LibraryMeta) =>
    void run(async () => {
      const d = await duplicateEntry(store, m.id);
      toast(`Duplicated as "${d.name}"`);
    });
  const doDelete = (m: LibraryMeta) => {
    if (!window.confirm(`Delete "${m.name}" from the library? This can't be undone.`)) return;
    void run(async () => {
      await store.remove(m.id);
      if (lnk?.id === m.id) relink(null);
    });
  };
  const doPatch = (m: LibraryMeta, patch: Partial<LibraryMeta>) =>
    void run(async () => {
      await store.put({ ...m, ...patch, updatedAt: Date.now() });
    });

  return (
    <div className="saves-panel" data-testid="saves-panel">
      <LibraryBrowser
        store={store}
        list={list}
        currentId={current?.id}
        busy={busy}
        compact
        onOpen={doOpen}
        onRename={doRename}
        onDuplicate={doDuplicate}
        onDelete={doDelete}
        onPatch={doPatch}
        onError={(msg) => toast(msg)}
      />
    </div>
  );
}

function NotIncluded({ items, who }: { items: string[]; who: string }) {
  if (!items.length) return null;
  return (
    <div className="lib-note">
      {who} doesn't include: {items.join(', ')}.
    </div>
  );
}

function ShareDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const [res, setRes] = useState<{ url: string; omitted: string[]; long: boolean } | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  useEffect(() => {
    let live = true;
    void shareLink(project, location.href).then((r) => {
      if (!live) return;
      setRes(r);
      void copy(r.url);
    });
    return () => {
      live = false;
    };
  }, [project]);
  return (
    <Modal title="Share link" onClose={onClose}>
      <div className="lib-share">
        {!res ? (
          <div className="empty">Making the link…</div>
        ) : (
          <>
            <p>{copied ? 'Copied to the clipboard.' : copied === false ? 'Copy the link below.' : 'Copying…'} Anyone who opens it gets this design's settings: parameters, pour, plate moves, materials and variants.</p>
            <div className="lib-row">
              <input readOnly value={res.url} onFocus={(e) => e.target.select()} aria-label="Share link" />
              <button className="btn sm" onClick={() => void copy(res.url)}>
                Copy
              </button>
            </div>
            <small className="mono">{res.url.length.toLocaleString()} characters</small>
            {res.long && <div className="lib-note warn">This link is over {LONG_LINK.toLocaleString()} characters. Some chat and mail apps cut long links short; send the project file (Save) if it doesn't open.</div>}
            <NotIncluded items={res.omitted} who="The link" />
            <div className="lib-note">Links carry settings, not pictures: images, depth from photo, composer blocks, imported meshes, shadow pictures and video stills stay with you. Send the project file (Save) for everything.</div>
          </>
        )}
      </div>
    </Modal>
  );
}

export function ShareButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="tb" onClick={() => setOpen(true)} title="Copy a link that opens this design's settings (not its images)">
        Share
      </button>
      {open && <ShareDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function clearHash() {
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    location.hash = '';
  }
}

/** Asks before opening a design from a share link (#s=…) in the address. */
export function SharedLinkPrompt() {
  const [shared, setShared] = useState<{ state: ShareState; project: Project } | null>(null);
  useEffect(() => {
    const check = async () => {
      const code = shareCodeFromHash(location.hash);
      if (!code) return;
      clearHash();
      try {
        const state = await decodeShare(code);
        setShared({ state, project: projectFromShare(state) });
      } catch (e) {
        useStore.getState().toast(`Could not open the shared design: ${(e as Error).message}`);
      }
    };
    void check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, []);
  if (!shared) return null;
  const close = () => setShared(null);
  const open = (newTab: boolean) => {
    const st = useStore.getState();
    if (newTab) useStore.getState().newSetup('blank');
    else unlinkActive();
    useStore.getState().replaceProject(shared.project);
    st.toast(newTab ? `Opened "${shared.project.name}" in a new tab` : `Opened "${shared.project.name}" (Undo brings back your working copy)`);
    close();
  };
  return (
    <Modal title="Shared design" onClose={close}>
      <div className="lib-share">
        <p>
          Open shared design <b>{shared.project.name}</b>? Opening it here replaces your current working copy (Undo brings it back), or open it in a new tab.
        </p>
        <NotIncluded items={shared.state.omitted ?? []} who="The link" />
        <div className="lib-row end">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn" onClick={() => open(true)}>
            Open in new tab
          </button>
          <button className="btn primary" onClick={() => open(false)}>
            Open here
          </button>
        </div>
      </div>
    </Modal>
  );
}
