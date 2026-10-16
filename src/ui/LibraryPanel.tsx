// Projects library (named saves kept in this browser) and share links.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from '../state/store';
import type { Project } from '../core/project';
import { decodeShare, LONG_LINK, projectFromShare, shareCodeFromHash, shareLink, type ShareState } from '../core/share';
import {
  defaultLibrary, duplicateEntry, hasUnsavedChanges, openEntry, projectFingerprint, readLinks, recentEntries, renameEntry, saveAs, saveOver, sortEntries, uniqueName, writeLink,
  type LibraryLink, type LibraryMeta,
} from '../state/library';

const ls = () => (typeof localStorage !== 'undefined' ? localStorage : undefined);
const linkOf = (setup: string): LibraryLink | undefined => readLinks(ls())[setup];
const link = (setup: string, l: LibraryLink | null) => writeLink(setup, l, ls());

/** Forget which library entry the active tab came from (e.g. after opening a project file over it). */
export function unlinkActive() {
  link(useStore.getState().activeSetup, null);
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

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="pm-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`pm lib ${wide ? '' : 'narrow'}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="box-head">
          <span>{title}</span>
          <button className="btn sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
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
  const store = defaultLibrary();
  const [list, setList] = useState<LibraryMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lnk, setLnk] = useState(() => linkOf(setup));
  const current = lnk && list?.find((m) => m.id === lnk.id);
  const dirty = useMemo(() => hasUnsavedChanges(project, current ? lnk : undefined), [project, current, lnk]);

  const refresh = useCallback(async () => {
    try {
      setList(await store.list());
      setError(null);
    } catch (e) {
      setError(`The library could not be read: ${(e as Error).message}`);
      setList([]);
    }
  }, [store]);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => setLnk(linkOf(setup)), [setup]);

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
      setBusy(false);
      void refresh();
    }
  };

  const doSaveAs = () => {
    const name = window.prompt('Save to the library as', uniqueName(project.name, (list ?? []).map((m) => m.name)));
    if (!name?.trim()) return;
    void run(async () => {
      const r = await saveAs(store, project, name.trim(), grabThumb());
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

  const sorted = list ? sortEntries(list) : [];
  const recent = list ? recentEntries(list.filter((m) => m.openedAt > 0)) : [];
  return (
    <Modal title="Projects" onClose={onClose} wide>
      <div className="lib-bar">
        <div className="lib-working">
          <b>Working copy:</b> {project.name}
          <small>
            {current ? (dirty ? ` · changed since saved to "${current.name}"` : ` · saved as "${current.name}"`) : ' · not in the library yet'} · kept in this browser as you work
          </small>
        </div>
        <span className="seg">
          <button className="btn sm" disabled={busy || !current} onClick={doSave} title={current ? `Overwrite "${current.name}" in the library` : 'Use Save as first'}>
            Save
          </button>
          <button className="btn sm primary" disabled={busy} onClick={doSaveAs}>
            Save as…
          </button>
        </span>
      </div>
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
      <div className="lib-head">All projects{list ? ` (${list.length})` : ''}</div>
      <div className="lib-body">
        {!list ? (
          <div className="empty">Loading…</div>
        ) : !list.length ? (
          <div className="lib-note">Nothing saved yet. Save as… keeps the working copy here with a picture of the 3D view, so you can come back to it.</div>
        ) : (
          <div className="lib-grid">
            {sorted.map((m) => (
              <div key={m.id} className={`lib-card ${current?.id === m.id ? 'on' : ''}`}>
                <button className="lib-thumb" onClick={() => doOpen(m)} disabled={busy} title={`Open "${m.name}"`}>
                  <Thumb m={m} />
                </button>
                <div className="lib-meta">
                  <span className="lib-name" title={m.name}>
                    {m.name}
                  </span>
                  <small title={new Date(m.savedAt).toLocaleString()}>
                    saved {ago(m.savedAt)} · {m.size > 1e6 ? `${(m.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(m.size / 1e3))} kB`}
                  </small>
                </div>
                <div className="lib-actions">
                  <button className="btn sm" disabled={busy} onClick={() => doOpen(m)}>
                    Open
                  </button>
                  <button className="btn sm" disabled={busy} onClick={() => doRename(m)}>
                    Rename
                  </button>
                  <button className="btn sm" disabled={busy} onClick={() => doDuplicate(m)}>
                    Duplicate
                  </button>
                  <button className="btn sm" disabled={busy} onClick={() => doDelete(m)} aria-label={`Delete ${m.name}`}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="lib-note">Kept in this browser only. Use Save in the toolbar for a project file you can move or back up.</div>
    </Modal>
  );
}

export function ProjectsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="tb" onClick={() => setOpen(true)} title="Projects kept in this browser: save, open, rename, duplicate">
        Projects
      </button>
      {open && <LibraryPanel onClose={() => setOpen(false)} />}
    </>
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
