import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { deserialize } from '../core/project';
import { buildZip, download, exportFailureMessage, FitCheckExportError } from '../core/exporters';
import { createPipeline } from '../core/pipeline';
import { decodeProjectAssets } from '../state/assets';
import { filterLibrary, folderCounts, foldersOf, sortLibrary, sourceLabel, type LibrarySort } from '../state/libraryDescribe';
import { updatedAtOf, type LibraryMeta, type LibraryStore } from '../state/library';
import { Loading } from './BusyWindow';

const VIEW_KEY = 'strata.library.view';
const SORT_KEY = 'strata.library.sort';
const DRAG_TYPE = 'application/x-strata-save';

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

function readPref<T extends string>(key: string, fallback: T, ok: T[]): T {
  try {
    const v = localStorage.getItem(key);
    return v && (ok as string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function Thumb({ m }: { m: LibraryMeta }) {
  return m.thumb ? <img src={m.thumb} alt="" /> : <span className="lib-nothumb">{m.name.slice(0, 1).toUpperCase()}</span>;
}

function bits(m: LibraryMeta): string {
  const parts = [m.kind, sourceLabel(m.source), m.plateCount != null ? `${m.plateCount} plates` : null, m.material, m.folder, ...(m.tags ?? [])].filter(Boolean);
  return parts.join(' · ');
}

export function LibraryBrowser({
  store,
  list,
  currentId,
  busy,
  compact,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onPatch,
  onError,
}: {
  store: LibraryStore;
  list: LibraryMeta[] | null;
  currentId?: string;
  busy: boolean;
  compact?: boolean;
  onOpen: (m: LibraryMeta) => void;
  onRename: (m: LibraryMeta) => void;
  onDuplicate: (m: LibraryMeta) => void;
  onDelete: (m: LibraryMeta) => void;
  onPatch: (m: LibraryMeta, patch: Partial<LibraryMeta>) => void;
  onError: (msg: string) => void;
}) {
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [view, setView] = useState<'grid' | 'list'>(() => readPref(VIEW_KEY, compact ? 'list' : 'grid', ['grid', 'list']));
  const [sort, setSort] = useState<LibrarySort>(() => readPref(SORT_KEY, 'updated', ['updated', 'name', 'plates', 'kind']));
  const [menu, setMenu] = useState<{ m: LibraryMeta; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Keep the actions menu on screen near the bottom and right edges.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4))}px`;
  }, [menu]);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
      localStorage.setItem(SORT_KEY, sort);
    } catch {
      /* ignore */
    }
  }, [view, sort]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    // Escape closes just the menu, not the Projects window behind it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  // A folder made with New folder… lives here until something is put in it.
  const [madeFolders, setMadeFolders] = useState<string[]>([]);
  const [dragging, setDragging] = useState<LibraryMeta | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const folders = useMemo(() => (list ? foldersOf(list, madeFolders) : []), [list, madeFolders]);
  const counts = useMemo(() => folderCounts(list ?? []), [list]);
  const shown = useMemo(() => (list ? sortLibrary(filterLibrary(list, q, folder), sort) : []), [list, q, folder, sort]);

  const onMenu = (e: MouseEvent, m: LibraryMeta) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ m, x: e.clientX, y: e.clientY });
  };

  const downloadZip = async (m: LibraryMeta) => {
    try {
      const data = await store.getData(m.id);
      if (data == null) throw new Error('That project is no longer in the library');
      const project = deserialize(data);
      const assets = await decodeProjectAssets(project);
      const model = createPipeline()(project, assets);
      const zip = buildZip(model, project);
      download(`${(project.name || 'strata').replace(/[^\w-]+/g, '_')}-fabrication.zip`, zip, 'application/zip');
    } catch (e) {
      const msg = e instanceof FitCheckExportError ? exportFailureMessage(e) : (e as Error).message;
      throw new Error(msg);
    }
  };

  const doTags = (m: LibraryMeta) => {
    const next = window.prompt('Tags (comma-separated)', (m.tags ?? []).join(', '));
    if (next == null) return;
    const tags = next
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    onPatch(m, { tags: tags.length ? tags : undefined });
  };

  const moveTo = (m: LibraryMeta, f: string | undefined) => {
    if ((m.folder ?? undefined) === f) return;
    onPatch(m, { folder: f });
  };

  const newFolder = (m?: LibraryMeta) => {
    const name = window.prompt(m ? `New folder for "${m.name}"` : 'New folder name')?.trim();
    if (!name) return;
    if (!folders.includes(name)) setMadeFolders((xs) => [...xs, name]);
    if (m) moveTo(m, name);
  };

  // Drag a save onto a folder button to put it in that folder.
  const dragProps = (m: LibraryMeta) => ({
    draggable: !busy,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE, m.id);
      e.dataTransfer.effectAllowed = 'move';
      setDragging(m);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropOn(null);
    },
  });
  const dropProps = (key: string, f: string | undefined) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropOn(key);
    },
    onDragLeave: () => setDropOn((k) => (k === key ? null : k)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer.getData(DRAG_TYPE);
      const m = list?.find((x) => x.id === id) ?? dragging;
      setDragging(null);
      setDropOn(null);
      if (m) moveTo(m, f);
    },
  });

  return (
    <div className={`lib-browser ${compact ? 'compact' : ''} ${view}`} data-testid="saves-browser">
      <div className="lib-tools">
        <input
          className="search"
          type="search"
          placeholder="Search saves…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search saves"
          data-testid="saves-search"
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as LibrarySort)} aria-label="Sort saves" data-testid="saves-sort">
          <option value="updated">Updated</option>
          <option value="name">Name</option>
          <option value="plates">Plates</option>
          <option value="kind">Type</option>
        </select>
        <span className="seg">
          <button className={`btn sm ${view === 'grid' ? 'on' : ''}`} onClick={() => setView('grid')} data-testid="saves-view-grid">
            Grid
          </button>
          <button className={`btn sm ${view === 'list' ? 'on' : ''}`} onClick={() => setView('list')} data-testid="saves-view-list">
            List
          </button>
        </span>
      </div>
      <div className={`lib-folders ${dragging ? 'dragging' : ''}`} data-testid="saves-folders" role="toolbar" aria-label="Folders">
        <button className={`btn sm ${!folder ? 'on' : ''}`} onClick={() => setFolder(null)}>
          All
        </button>
        {folders.map((f) => (
          <button
            key={f}
            className={`btn sm lib-folder ${folder === f ? 'on' : ''} ${dropOn === f ? 'drop' : ''}`}
            onClick={() => setFolder(f)}
            title={`Show "${f}". Drag a project here to put it in this folder.`}
            data-testid={`saves-folder-${f}`}
            {...dropProps(f, f)}
          >
            📁 {f}
            <small>{counts.get(f) ?? 0}</small>
          </button>
        ))}
        {dragging?.folder && (
          <button className={`btn sm lib-folder ${dropOn === '\0none' ? 'drop' : ''}`} data-testid="saves-folder-none" {...dropProps('\0none', undefined)}>
            Take out of folder
          </button>
        )}
        <button className="btn sm" disabled={busy} onClick={() => newFolder()} data-testid="saves-new-folder">
          New folder…
        </button>
        <small className="lib-folder-hint">{dragging ? `Drop "${dragging.name}" on a folder` : folders.length ? 'Drag a project onto a folder to move it' : 'Make a folder, then drag projects onto it'}</small>
      </div>
      <div className="lib-body">
        {!list ? (
          <Loading label="Loading your projects…" />
        ) : !shown.length ? (
          <div className="lib-note">{list.length ? 'Nothing matches.' : 'Nothing saved yet. Save or Export ZIP lands here automatically.'}</div>
        ) : view === 'list' ? (
          <div className="lib-rows">
            {shown.map((m) => (
              <div
                key={m.id}
                className={`lib-line ${currentId === m.id ? 'on' : ''} ${dragging?.id === m.id ? 'dragged' : ''}`}
                {...dragProps(m)}
                data-testid={`saves-row-${m.id}`}
                data-source={m.source ?? ''}
                onContextMenu={(e) => onMenu(e, m)}
              >
                <button className="lib-line-main" onClick={() => onOpen(m)} disabled={busy} title={`Open "${m.name}"`}>
                  <Thumb m={m} />
                  <span className="lib-name">{m.name}</span>
                  <small>{bits(m)}</small>
                  <small title={new Date(updatedAtOf(m)).toLocaleString()}>{ago(updatedAtOf(m))}</small>
                </button>
                <button className="btn sm" disabled={busy} onClick={(e) => onMenu(e, m)} aria-label={`Actions for ${m.name}`}>
                  ⋯
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="lib-grid">
            {shown.map((m) => (
              <div
                key={m.id}
                className={`lib-card ${currentId === m.id ? 'on' : ''} ${dragging?.id === m.id ? 'dragged' : ''}`}
                {...dragProps(m)}
                data-testid={`saves-card-${m.id}`}
                data-source={m.source ?? ''}
                onContextMenu={(e) => onMenu(e, m)}
              >
                <button className="lib-thumb" onClick={() => onOpen(m)} disabled={busy} title={`Open "${m.name}"`}>
                  <Thumb m={m} />
                </button>
                <div className="lib-meta">
                  <span className="lib-name" title={m.name}>
                    {m.name}
                  </span>
                  <small>{bits(m)}</small>
                  <small title={new Date(updatedAtOf(m)).toLocaleString()}>updated {ago(updatedAtOf(m))}</small>
                </div>
                <div className="lib-actions">
                  <button className="btn sm" disabled={busy} onClick={() => onOpen(m)}>
                    Open
                  </button>
                  <button className="btn sm" disabled={busy} onClick={(e) => onMenu(e, m)} aria-label={`Actions for ${m.name}`}>
                    ⋯
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {menu && (
        <div ref={menuRef} className="lib-menu" style={{ left: menu.x, top: menu.y }} role="menu" data-testid="saves-menu" onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={() => (setMenu(null), onOpen(menu.m))}>
            Open
          </button>
          <button role="menuitem" onClick={() => (setMenu(null), onRename(menu.m))}>
            Rename
          </button>
          <button role="menuitem" onClick={() => (setMenu(null), onDuplicate(menu.m))}>
            Duplicate
          </button>
          <button role="menuitem" onClick={() => (setMenu(null), doTags(menu.m))}>
            Tags…
          </button>
          <div className="lib-menu-head" role="presentation">
            Move to folder
          </div>
          {folders.map((f) => (
            <button key={f} role="menuitemradio" aria-checked={menu.m.folder === f} onClick={() => (setMenu(null), moveTo(menu.m, f))}>
              <span className="lib-menu-mark">{menu.m.folder === f ? '✓' : ''}</span>📁 {f}
            </button>
          ))}
          <button role="menuitem" onClick={() => (setMenu(null), newFolder(menu.m))}>
            New folder…
          </button>
          {menu.m.folder && (
            <button role="menuitem" onClick={() => (setMenu(null), moveTo(menu.m, undefined))}>
              Take out of folder
            </button>
          )}
          <hr className="lib-menu-sep" />
          <button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              void downloadZip(menu.m).catch((e) => onError((e as Error).message));
            }}
          >
            Download zip
          </button>
          <button role="menuitem" onClick={() => (setMenu(null), onDelete(menu.m))}>
            Delete…
          </button>
        </div>
      )}
    </div>
  );
}
