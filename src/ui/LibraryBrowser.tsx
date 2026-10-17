import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { deserialize } from '../core/project';
import { buildZip, download, exportFailureMessage, FitCheckExportError } from '../core/exporters';
import { createPipeline } from '../core/pipeline';
import { decodeProjectAssets } from '../state/assets';
import { filterLibrary, foldersOf, sortLibrary, sourceLabel, type LibrarySort } from '../state/libraryDescribe';
import { updatedAtOf, type LibraryMeta, type LibraryStore } from '../state/library';

const VIEW_KEY = 'strata.library.view';
const SORT_KEY = 'strata.library.sort';

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
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const folders = useMemo(() => (list ? foldersOf(list) : []), [list]);
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

  const doFolder = (m: LibraryMeta) => {
    const next = window.prompt('Folder (blank to clear)', m.folder ?? '');
    if (next == null) return;
    onPatch(m, { folder: next.trim() || undefined });
  };

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
      {folders.length > 0 && (
        <div className="lib-folders" data-testid="saves-folders">
          <button className={`btn sm ${!folder ? 'on' : ''}`} onClick={() => setFolder(null)}>
            All
          </button>
          {folders.map((f) => (
            <button key={f} className={`btn sm ${folder === f ? 'on' : ''}`} onClick={() => setFolder(f)}>
              {f}
            </button>
          ))}
        </div>
      )}
      <div className="lib-body">
        {!list ? (
          <div className="empty">Loading…</div>
        ) : !shown.length ? (
          <div className="lib-note">{list.length ? 'Nothing matches.' : 'Nothing saved yet. Save or Export ZIP lands here automatically.'}</div>
        ) : view === 'list' ? (
          <div className="lib-rows">
            {shown.map((m) => (
              <div
                key={m.id}
                className={`lib-line ${currentId === m.id ? 'on' : ''}`}
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
                className={`lib-card ${currentId === m.id ? 'on' : ''}`}
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
        <div className="lib-menu" style={{ left: menu.x, top: menu.y }} role="menu" data-testid="saves-menu" onClick={(e) => e.stopPropagation()}>
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
          <button role="menuitem" onClick={() => (setMenu(null), doFolder(menu.m))}>
            Folder…
          </button>
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
