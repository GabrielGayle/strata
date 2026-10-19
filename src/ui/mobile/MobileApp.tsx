// Strata Viewer: the phone face of the app, at /m. It only looks: pick a saved
// project, turn it in 3D, read its numbers, and stand it on a table in AR.
// Nothing here edits or saves a design (the store's autosave never starts,
// because hydrate() is not called on this route).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import { deserialize, type Project } from '../../core/project';
import type { Model } from '../../core/pipeline';
import { useStore, type Snap } from '../../state/store';
import { defaultProjectLibrary } from '../../state/hybridLibrary';
import { sortEntries, type LibraryMeta } from '../../state/library';
import { probeCloud } from '../../state/cloudLibrary';
import { cloudSyncLabel, getCloudSync, subscribeCloudSync } from '../../state/cloudSync';
import { readOwnerToken, writeOwnerToken } from '../../state/ownerToken';
import { FullModelContext, ModelContext, fmt, fmtInt } from '../model';
import Scene, { cssVar, modelBounds } from '../Scene';
import { snapDirection } from '../Viewport';
import { clipPlanesForBounds } from '../viewportClip';
import { DEFAULT_VIEWPORT_LAYERS } from '../viewportLayers';
import { VIEWPORT_CAM_POS, VIEWPORT_DPR, VIEWPORT_GL, VIEWPORT_RESIZE, VIEWPORT_STYLE } from '../viewportKeepAlive';
import { Tab } from '../Tab';
import { Loading } from '../BusyWindow';
import { isMapDepth } from '../../core/mapPlateHeight';
import { useViewerModel } from './useViewerModel';
import { arSizeMm, buildArScene, canQuickLook, exportUsdz } from './arExport';
import { setDesktopChoice, VIEWER_PATH } from './route';
import './mobile.css';

const library = () => defaultProjectLibrary();

function projectIdFromUrl(): string | null {
  try {
    return new URLSearchParams(location.search).get('p');
  } catch {
    return null;
  }
}

function when(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

/** Home screen icon and name, and room under the notch; only on this route so the editor's page is unchanged. */
function useViewerHead() {
  useEffect(() => {
    const add = (tag: 'link' | 'meta', attrs: Record<string, string>) => {
      const el = document.createElement(tag);
      for (const [k, val] of Object.entries(attrs)) el.setAttribute(k, val);
      document.head.appendChild(el);
      return el;
    };
    const els = [
      add('link', { rel: 'manifest', href: '/viewer.webmanifest' }),
      add('link', { rel: 'apple-touch-icon', href: '/viewer-icon-180.png' }),
      add('meta', { name: 'apple-mobile-web-app-title', content: 'Strata' }),
      add('meta', { name: 'theme-color', content: '#000080' }),
    ];
    const vp = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const before = vp?.content;
    if (vp) vp.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    const title = document.title;
    document.title = 'Strata Viewer';
    // opening the viewer on purpose means phones should land here again
    setDesktopChoice(false);
    return () => {
      els.forEach((e) => e.remove());
      if (vp && before) vp.content = before;
      document.title = title;
    };
  }, []);
}

export default function MobileApp() {
  useViewerHead();
  const [openId, setOpenId] = useState<string | null>(projectIdFromUrl);
  useEffect(() => {
    const onPop = () => {
      pushed.current = false;
      setOpenId(projectIdFromUrl());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // a project opened from the list goes back with the phone's own back swipe too
  const pushed = useRef(false);
  const open = (id: string) => {
    history.pushState({ strataViewer: true }, '', `${VIEWER_PATH}?p=${encodeURIComponent(id)}`);
    pushed.current = true;
    setOpenId(id);
  };
  const back = () => {
    if (pushed.current) {
      pushed.current = false;
      history.back();
    } else history.replaceState(null, '', VIEWER_PATH);
    setOpenId(null);
  };
  return openId ? <ProjectView id={openId} onBack={back} /> : <ProjectList onOpen={open} />;
}

function TitleBar({ text, onClose }: { text: string; onClose?: () => void }) {
  return (
    <div className="title-bar">
      <div className="title-bar-text">{text}</div>
      {onClose && (
        <div className="title-bar-controls">
          <button aria-label="Close" onClick={onClose} />
        </div>
      )}
    </div>
  );
}

function useCloudSync() {
  return useSyncExternalStore(subscribeCloudSync, getCloudSync, getCloudSync);
}

/* ---------- the project list ---------- */

function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const [entries, setEntries] = useState<LibraryMeta[] | null>(null);
  const [query, setQuery] = useState('');
  const [token, setToken] = useState(() => readOwnerToken() ?? '');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const sync = useCloudSync();
  const refresh = async () => {
    setBusy(true);
    try {
      setEntries(sortEntries(await library().list()));
    } catch {
      setEntries((e) => e ?? []);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
    const onVis = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  const unlock = (e: FormEvent) => {
    e.preventDefault();
    const next = draft.trim();
    if (!next) return;
    writeOwnerToken(next);
    setDraft('');
    setToken(next);
    void probeCloud();
  };
  const refused = sync.status === 'error' && /refused/i.test(sync.detail ?? '');
  const forget = () => {
    writeOwnerToken(null);
    setToken('');
  };
  const q = query.trim().toLowerCase();
  const shown = (entries ?? []).filter((m) => !q || m.name.toLowerCase().includes(q) || (m.folder ?? '').toLowerCase().includes(q) || (m.tags ?? []).some((t) => t.toLowerCase().includes(q)));
  return (
    <div className="mv window" data-testid="mobile-viewer">
      <TitleBar text="Strata Viewer" />
      <div className="mv-bar">
        <input
          type="search"
          className="mv-search"
          placeholder="Search projects"
          aria-label="Search projects"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
      </div>
      {(!token || refused) && (
        <form className="mv-gate" onSubmit={unlock} data-testid="mobile-token-form">
          <fieldset className="section">
            <legend>Cloud projects</legend>
            <p>{refused ? 'That access token was refused. Try it again.' : 'Enter your access token once to see the projects you saved on your computer.'}</p>
            <div className="mv-row">
              <input
                type="password"
                autoComplete="current-password"
                aria-label="Access token"
                placeholder="Access token"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button className="btn primary" type="submit" disabled={!draft.trim()}>
                Unlock
              </button>
            </div>
          </fieldset>
        </form>
      )}
      <div className="mv-body">
        {entries === null ? (
          <Loading label="Reading your projects…" />
        ) : shown.length === 0 ? (
          <div className="mv-empty">
            {q ? `No project matches “${query.trim()}”.` : token ? 'No saved projects yet. Save one from the Projects window on your computer.' : 'Projects saved on this phone show here. Unlock the cloud to see the rest.'}
          </div>
        ) : (
          <ul className="mv-list tree-view" role="list" data-testid="mobile-project-list">
            {shown.map((m) => (
              <li key={m.id}>
                <button className="mv-item" onClick={() => onOpen(m.id)}>
                  {m.thumb ? <img src={m.thumb} alt="" className="mv-thumb" /> : <span className="mv-thumb mv-thumb-empty" aria-hidden />}
                  <span className="mv-item-text">
                    <strong>{m.name}</strong>
                    <small>
                      {[m.kind, m.plateCount ? `${m.plateCount} plates` : '', m.material, when(m.updatedAt ?? m.savedAt)].filter(Boolean).join(' · ')}
                    </small>
                    {m.folder && <small className="mv-folder">{m.folder}</small>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="status-bar">
        <p className="status-bar-field">{entries ? `${shown.length} project${shown.length === 1 ? '' : 's'}` : 'Reading…'}</p>
        <p className="status-bar-field" title={sync.detail ?? undefined}>
          {token ? cloudSyncLabel(sync.status) : 'This phone only'}
        </p>
        <p className="status-bar-field mv-links">
          {token && (
            <button className="mv-link" onClick={forget}>
              Lock
            </button>
          )}
          <a
            className="mv-link"
            href="/"
            onClick={() => setDesktopChoice(true)}
          >
            Full editor
          </a>
        </p>
      </div>
    </div>
  );
}

/* ---------- one project ---------- */

type Loaded = { phase: 'loading' } | { phase: 'ready'; meta?: LibraryMeta; project: Project } | { phase: 'error'; error: string };

function useSavedProject(id: string): Loaded {
  const [state, setState] = useState<Loaded>({ phase: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ phase: 'loading' });
    (async () => {
      const lib = library();
      const [meta, data] = await Promise.all([lib.getMeta(id), lib.getData(id)]);
      if (data == null) throw new Error('This project is not on this phone, and the cloud could not be reached.');
      const project = deserialize(data);
      if (alive) setState({ phase: 'ready', meta, project });
    })().catch((e) => alive && setState({ phase: 'error', error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [id]);
  return state;
}

type ViewTab = '3d' | 'details';

function ProjectView({ id, onBack }: { id: string; onBack: () => void }) {
  const saved = useSavedProject(id);
  const project = saved.phase === 'ready' ? saved.project : null;
  // the 3D scene reads the project's looks from the store; this route never saves it
  useEffect(() => {
    if (project) useStore.setState({ project });
  }, [project]);
  const built = useViewerModel(project);
  const [tab, setTab] = useState<ViewTab>('3d');
  const name = (saved.phase === 'ready' && (saved.meta?.name || saved.project.name)) || 'Project';
  const model = built.phase === 'ready' ? built.model : null;
  return (
    <div className="mv window" data-testid="mobile-project">
      <TitleBar text={name} onClose={onBack} />
      <div className="mv-bar">
        <button className="btn" onClick={onBack}>
          ◀ Projects
        </button>
        <menu className="ws-tabs mv-tabs" role="tablist">
          <Tab selected={tab === '3d'} onSelect={() => setTab('3d')}>
            3D
          </Tab>
          <Tab selected={tab === 'details'} onSelect={() => setTab('details')}>
            Details
          </Tab>
        </menu>
      </div>
      <div className="mv-body mv-stage">
        {saved.phase === 'error' ? (
          <div className="mv-empty">{saved.error}</div>
        ) : built.phase === 'error' ? (
          <div className="mv-empty">Could not build this project: {built.error}</div>
        ) : !model ? (
          <Loading label={saved.phase === 'loading' ? 'Opening project…' : built.phase === 'building' ? `${built.step}…` : 'Opening project…'} />
        ) : (
          <ModelContext.Provider value={model}>
            <FullModelContext.Provider value={() => model}>
              <Stage model={model} hidden={tab !== '3d'} finishing={built.phase === 'ready' && built.finishing} name={name} />
              {tab === 'details' && <Details model={model} meta={saved.phase === 'ready' ? saved.meta : undefined} />}
            </FullModelContext.Provider>
          </ModelContext.Provider>
        )}
      </div>
      <div className="status-bar">
        <p className="status-bar-field">{model ? `${model.bom.plateCount} ${model.v.sliceMode === 'flat' ? 'layers' : 'plates'}` : '…'}</p>
        <p className="status-bar-field">{model ? `${fmt(model.v.baseLength, 0)} × ${fmt(model.v.baseWidth, 0)} mm` : ''}</p>
        <p className="status-bar-field">{built.phase === 'ready' && built.finishing ? 'Finishing…' : model ? 'Ready' : 'Building…'}</p>
      </div>
    </div>
  );
}

const SNAPS: { dir: Snap; label: string }[] = [
  { dir: 'iso', label: 'Iso' },
  { dir: 'front', label: 'Front' },
  { dir: 'side', label: 'Side' },
  { dir: 'top', label: 'Top' },
];

function Stage({ model, hidden, finishing, name }: { model: Model; hidden: boolean; finishing: boolean; name: string }) {
  const [snap, setSnap] = useState<{ dir: Snap; n: number }>({ dir: 'iso', n: 1 });
  const root = useRef<THREE.Group>(null);
  const mapFace = useStore((s) => isMapDepth(s.project.images.top?.depth) && !!s.project.images.top?.map);
  const boundSize = modelBounds(model).size;
  const clip = useMemo(() => clipPlanesForBounds(boundSize), [boundSize]);
  const opts = useMemo(
    () => ({
      selected: null,
      showMoulds: false,
      explode: false,
      xray: false,
      showIssues: false,
      showSource: false,
      viewportLayers: { ...DEFAULT_VIEWPORT_LAYERS, labels: false },
    }),
    [],
  );
  return (
    <div className="mv-3d" hidden={hidden}>
      <Canvas
        shadows="percentage"
        dpr={VIEWPORT_DPR}
        gl={VIEWPORT_GL}
        frameloop={hidden ? 'never' : 'always'}
        resize={VIEWPORT_RESIZE}
        onCreated={({ gl }) => gl.setClearColor(cssVar('--viewport', '#e6e3dc'), 1)}
        style={VIEWPORT_STYLE}
      >
        <PerspectiveCamera makeDefault fov={32} near={clip.near} far={clip.far} position={VIEWPORT_CAM_POS} />
        <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
        <PhoneRig model={model} snap={snap} mapNorthUp={mapFace} />
        <group ref={root}>
          <Scene model={model} opts={opts} />
        </group>
      </Canvas>
      <div className="mv-overlay mv-snaps">
        {SNAPS.map((s) => (
          <button key={s.dir} className={`btn sm ${snap.dir === s.dir ? 'on' : ''}`} onClick={() => setSnap((p) => ({ dir: s.dir, n: p.n + 1 }))}>
            {s.label}
          </button>
        ))}
      </div>
      <ArButton model={model} root={root} ready={!finishing} name={name} />
    </div>
  );
}

/**
 * Frames the whole model in a tall, narrow screen: the editor's rig fits the
 * vertical field of view, which cuts the ends off in portrait.
 */
function PhoneRig({ model, snap, mapNorthUp }: { model: Model; snap: { dir: Snap; n: number }; mapNorthUp: boolean }) {
  const { camera, controls, size } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls?: { target: THREE.Vector3; update: () => void }; size: { width: number; height: number } };
  const modelRef = useRef(model);
  modelRef.current = model;
  const aspect = size.width / Math.max(1, size.height);
  useEffect(() => {
    if (!controls) return;
    const m = modelRef.current;
    const { center, radius } = modelBounds(m);
    const { dir, up } = snapDirection(m, snap.dir, mapNorthUp);
    const vHalf = ((camera.fov / 2) * Math.PI) / 180;
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    const dist = (radius * 1.12) / Math.sin(Math.min(vHalf, hHalf));
    camera.up.copy(up);
    camera.position.copy(center).addScaledVector(dir, dist);
    controls.target.copy(center);
    controls.update();
  }, [snap.n, snap.dir, controls, camera, aspect, mapNorthUp]);
  return null;
}

type ArState = { phase: 'idle' } | { phase: 'making' } | { phase: 'ready'; url: string; bytes: number; size: { x: number; y: number; z: number } } | { phase: 'error'; error: string };

/** Makes the USDZ as soon as the model has settled, so the tap opens Quick Look straight away (Safari wants the tap). */
function ArButton({ model, root, ready, name }: { model: Model; root: React.RefObject<THREE.Group | null>; ready: boolean; name: string }) {
  const [ar, setAr] = useState<ArState>({ phase: 'idle' });
  const quickLook = useMemo(() => canQuickLook(), []);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    let url: string | null = null;
    setAr({ phase: 'making' });
    // a couple of frames, so the scene graph holds this model's meshes
    const t = setTimeout(async () => {
      try {
        if (!root.current) throw new Error('The 3D view is not ready');
        const scene = buildArScene(root.current);
        if (!scene.children.length) throw new Error('Nothing solid to place');
        const size = arSizeMm(scene);
        const bytes = await exportUsdz(scene);
        if (!alive) return;
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'model/vnd.usdz+zip' }));
        setAr({ phase: 'ready', url, bytes: bytes.byteLength, size });
      } catch (e) {
        if (alive) setAr({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
      if (url) URL.revokeObjectURL(url);
    };
  }, [model, ready, root]);
  const fileName = `${name.replace(/[^\w\- ]+/g, '').trim() || 'strata'}.usdz`;
  const openAr = () => {
    if (ar.phase !== 'ready') return;
    const a = document.createElement('a');
    if (quickLook) {
      a.rel = 'ar';
      // Quick Look wants an image as the link's first child
      a.appendChild(document.createElement('img'));
    } else a.download = fileName;
    a.href = ar.url;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  return (
    <div className="mv-overlay mv-ar">
      <button className="btn primary mv-ar-btn" data-testid="mobile-ar" disabled={ar.phase !== 'ready'} onClick={openAr}>
        {ar.phase === 'ready' ? (quickLook ? 'View in AR' : 'Save AR file (.usdz)') : ar.phase === 'error' ? 'AR unavailable' : 'Preparing AR…'}
      </button>
      <small className="mv-ar-note" data-testid="mobile-ar-note">
        {ar.phase === 'ready'
          ? `True size ${fmt(ar.size.x, 0)} × ${fmt(ar.size.z, 0)} × ${fmt(ar.size.y, 0)} mm${quickLook ? '' : ' · opens in AR on iPhone'}`
          : ar.phase === 'error'
            ? ar.error
            : ''}
      </small>
    </div>
  );
}

function Details({ model, meta }: { model: Model; meta?: LibraryMeta }) {
  const v = model.v;
  const b = model.bom;
  const flat = v.sliceMode === 'flat';
  const rows: [string, string][] = [
    ['Base', `${fmt(v.baseLength, 0)} × ${fmt(v.baseWidth, 0)} × ${fmt(v.baseHeight, 0)} mm`],
    [flat ? 'Layers' : 'Plates', `${b.plateCount}${flat ? ' face to face' : v.sliceMode === 'radial' ? ' radial' : ` @ ${fmt(v.pitch, 2)} mm pitch`}`],
    ['Parts', `${b.partCount} × ${fmt(v.thickness, 1)} mm`],
    ['Material', String(v.plateMaterial)],
    ['Steel', `${fmt(b.plateArea, 2)} m² · ${fmt(b.plateMass, 1)} kg`],
    ['Cutting', `${fmt(b.cutLength, 1)} m · ${fmtInt(b.pierces)} pierces · ${b.sheets} sheet${b.sheets === 1 ? '' : 's'}`],
  ];
  if (b.concreteBase > 0) rows.push(['Concrete', `${fmt(b.concreteBase + b.concreteInsert, 1)} L · ${fmt(b.concreteMass, 1)} kg`]);
  if (b.hardware.length) rows.push(['Hardware', b.hardware.map((h) => `${h.qty} × ${h.item}`).join(', ')]);
  const errors = model.issues.filter((i) => i.severity === 'error').length;
  const warns = model.issues.filter((i) => i.severity === 'warn').length;
  rows.push(['Checks', errors ? `${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}` : warns ? `${warns} warning${warns === 1 ? '' : 's'}` : 'All clear']);
  if (meta) rows.push(['Saved', new Date(meta.updatedAt ?? meta.savedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })]);
  if (meta?.folder) rows.push(['Folder', meta.folder]);
  return (
    <div className="mv-details" data-testid="mobile-details">
      <fieldset className="section">
        <legend>This design</legend>
        <dl>
          {rows.map(([k, val]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{val}</dd>
            </div>
          ))}
        </dl>
      </fieldset>
      {model.issues.length > 0 && (
        <fieldset className="section">
          <legend>Notes</legend>
          <ul className="mv-issues">
            {model.issues.slice(0, 12).map((i, n) => (
              <li key={n} className={i.severity}>
                {i.message}
              </li>
            ))}
          </ul>
        </fieldset>
      )}
    </div>
  );
}
