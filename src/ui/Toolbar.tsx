import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../state/store';
import { PRESETS, deserialize, serialize, type Project } from '../core/project';
import { MAP_PRESET_CATALOG, mapPresetSpecKeepingUser } from '../core/mapPresets';
import { SOUND_PRESETS } from '../core/soundPresets';
import { soundDataUrl } from './audio';
import { buildPackHtmlChecked, buildZip, download, exportFailureMessage, FitCheckExportError, openHtml, withExportLock } from '../core/exporters';
import { bytesToBase64, parseMesh } from '../state/assets';
import { useFullModel } from './model';
import { loadRates } from './PriceEstimate';
import { randomTheme, themeTokens, THEME_PRESETS, type ThemeSeed } from './theme';
import { activeLibraryLinkId, CloudSyncMark, grabThumb, keepOpenedInLibrary, linkActive, ProjectsButton, ShareButton, SharedLinkPrompt, unlinkActive } from './LibraryPanel';
import { recordLibrarySave } from '../state/recordLibrary';
import { isProjectZipName, projectFromZip } from '../core/projectZip';

export function Menu({ label, children, className = 'tb' }: { label: ReactNode; children: (close: () => void) => ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu">
      <button
        ref={btn}
        className={className}
        aria-expanded={open}
        onClick={() => {
          const r = btn.current!.getBoundingClientRect();
          setPos({ x: Math.min(r.left, window.innerWidth - 280), y: r.bottom });
          setOpen(!open);
        }}
      >
        {label} ▾
      </button>
      {open && (
        <div ref={pop} className="menu-pop window" style={{ left: Math.max(4, pos.x), top: pos.y }}>
          <div className="title-bar">
            <div className="title-bar-text">{label}</div>
          </div>
          <div className="window-body">{children(() => setOpen(false))}</div>
        </div>
      )}
    </div>
  );
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    inp.click();
  });
}

/** Load an STL / OBJ as the insert or the source form; picks a file when none is given (e.g. dropped). */
export async function importMeshInto(slot: 'ins' | 'src', dropped?: File) {
  const st = useStore.getState();
  const file = dropped ?? (await pickFile('.stl,.obj,.step,.stp'));
  if (!file) return;
  const ext = file.name.split('.').pop()!.toLowerCase();
  if (ext === 'step' || ext === 'stp') {
    st.toast('STEP needs a CAD kernel: export STL (mm) from Fusion instead — File › Export › STL.');
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const asset = { name: file.name, format: ext === 'obj' ? 'obj' : 'stl', data: bytesToBase64(bytes) } as const;
  try {
    const g = parseMesh(asset);
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    st.setAsset('mesh', slot, asset);
    st.setParams(slot === 'ins' ? { insShape: 'mesh' } : { srcShape: 'mesh', stackSource: 'form' }, 'import');
    st.toast(`Imported ${file.name}: ${(bb.max.x - bb.min.x).toFixed(0)} × ${(bb.max.y - bb.min.y).toFixed(0)} × ${(bb.max.z - bb.min.z).toFixed(0)} mm`);
  } catch (e) {
    st.toast(`Could not read ${file.name}: ${(e as Error).message}`);
  }
}

/** Replace the working copy with a saved .strata.json or a fabrication zip (undo brings the old one back). */
export async function openProjectFile(f: File, opts: { offerKeep?: boolean } = {}) {
  const { replaceProject, toast } = useStore.getState();
  try {
    let project: Project;
    if (isProjectZipName(f.name, f.type)) {
      project = projectFromZip(new Uint8Array(await f.arrayBuffer())).project;
    } else {
      project = deserialize(await f.text());
    }
    replaceProject(project);
    unlinkActive();
    toast(`Opened ${f.name}`);
    if (opts.offerKeep !== false && isProjectZipName(f.name, f.type)) await keepOpenedInLibrary(project, f.name);
  } catch (e) {
    toast(`Could not open: ${(e as Error).message}`);
  }
}

function Swatch({ t }: { t: ThemeSeed }) {
  const k = themeTokens(t);
  return (
    <span className="sw" aria-hidden>
      <i style={{ background: k['--bg'] }} />
      <i style={{ background: k['--panel-2'] }} />
      <i style={{ background: k['--accent'] }} />
      <i style={{ background: k['--svg-etch'] }} />
    </span>
  );
}

function AppearanceMenu() {
  const theme = useStore((s) => s.ui.theme);
  const setTheme = useStore((s) => s.setTheme);
  const current = theme.id === 'system' ? null : (theme as ThemeSeed);
  return (
    <Menu label="Appearance">
      {() => (
        <div style={{ width: 300 }}>
          <div className="head">Plates</div>
          <div className="btnrow">
            <button className="btn sm" onClick={() => useStore.getState().setUi({ tab: '3d', paintMode: true, moveMode: false })} title="Sort plates into material buckets (Corten, aluminium…) by clicking them in the 3D view">
              Plate materials…
            </button>
          </div>
          <div className="head">Presets</div>
          <div className="theme-grid">
            <button className={`theme-swatch ${theme.id === 'system' ? 'on' : ''}`} onClick={() => setTheme({ id: 'system' })} title="Follow the system light/dark setting">
              <span className="sw" aria-hidden>
                <i style={{ background: '#efede8' }} />
                <i style={{ background: '#141412' }} />
                <i style={{ background: '#d4521c' }} />
                <i style={{ background: '#2f5f9e' }} />
              </span>
              <span>System</span>
            </button>
            {THEME_PRESETS.map((t) => (
              <button key={t.id} className={`theme-swatch ${theme.id === t.id ? 'on' : ''}`} onClick={() => setTheme(t)}>
                <Swatch t={t} />
                <span>{t.name}</span>
              </button>
            ))}
          </div>
          <div className="head">Random</div>
          <div className="btnrow">
            <button className="btn sm" onClick={() => setTheme(randomTheme('light'))}>
              Light
            </button>
            <button className="btn sm" onClick={() => setTheme(randomTheme('light', 'blue'))}>
              Blue
            </button>
            <button className="btn sm" onClick={() => setTheme(randomTheme('light', 'mauve'))}>
              Mauve
            </button>
            <button className="btn sm" onClick={() => setTheme(randomTheme('dark'))}>
              Dark
            </button>
          </div>
          {current && (
            <>
              <div className="head">Tune</div>
              <dl className="kv" style={{ alignItems: 'center', margin: 0 }}>
                <dt>Accent</dt>
                <dd>
                  <input type="color" value={current.accent} onChange={(e) => setTheme({ ...current, id: 'custom', name: 'Custom', accent: e.target.value })} aria-label="Accent colour" />
                </dd>
                <dt>Tint</dt>
                <dd>
                  <input
                    type="range"
                    min={0}
                    max={360}
                    value={current.hue}
                    onChange={(e) => setTheme({ ...current, id: 'custom', name: 'Custom', hue: Number(e.target.value) })}
                    style={{ width: 150, accentColor: 'var(--accent)' }}
                    aria-label="Surface tint"
                  />
                </dd>
                <dt>Colourfulness</dt>
                <dd>
                  <input
                    type="range"
                    min={0}
                    max={0.8}
                    step={0.01}
                    value={current.sat}
                    onChange={(e) => setTheme({ ...current, id: 'custom', name: 'Custom', sat: Number(e.target.value) })}
                    style={{ width: 150, accentColor: 'var(--accent)' }}
                    aria-label="Surface colourfulness"
                  />
                </dd>
                <dt>Mode</dt>
                <dd>
                  <span className="seg">
                    {(['light', 'dark'] as const).map((m) => (
                      <button key={m} className={`btn sm ${current.mode === m ? 'on' : ''}`} onClick={() => setTheme({ ...current, id: 'custom', name: 'Custom', mode: m })}>
                        {m}
                      </button>
                    ))}
                  </span>
                </dd>
              </dl>
            </>
          )}
        </div>
      )}
    </Menu>
  );
}

export default function Toolbar() {
  const project = useStore((s) => s.project);
  const past = useStore((s) => s.past.length);
  const future = useStore((s) => s.future.length);
  const saveStatus = useStore((s) => s.saveStatus);
  const { undo, redo, setName, randomise, loadPreset, saveVariant, loadVariant, deleteVariant, toast, setUi, setTopMap } = useStore.getState();
  const fullModel = useFullModel();

  const save = () => {
    download(`${(project.name || 'strata').replace(/[^\w-]+/g, '_')}.strata.json`, serialize(project), 'application/json');
    void recordLibrarySave(project, { source: 'save', thumb: grabThumb(), linkId: activeLibraryLinkId() })
      .then((meta) => linkActive(meta.id, project))
      .catch((e) => toast(`Saved the file, but Projects failed: ${(e as Error).message}`));
  };
  const open = async () => {
    const f = await pickFile('.json,.zip,application/json,application/zip');
    if (f) openProjectFile(f);
  };
  const exportZip = () => {
    try {
      const ran = withExportLock(() => {
        const model = fullModel();
        const zip = buildZip(model, project, loadRates());
        download(`${(project.name || 'strata').replace(/[^\w-]+/g, '_')}-fabrication.zip`, zip, 'application/zip');
        void recordLibrarySave(project, { source: 'export', plates: model.sliced.plates.length, thumb: grabThumb(), linkId: activeLibraryLinkId() })
          .then((meta) => linkActive(meta.id, project))
          .catch((e) => toast(`Exported, but Projects failed: ${(e as Error).message}`));
        return model;
      });
      if (!ran.ok) toast('Export already running');
      else
        toast(
          `Exported ${ran.value.sliced.plates.length} plates (${ran.value.sliced.parts.length} parts), ${ran.value.nested.sheets.length} cut sheets, ${ran.value.moulds.parts.length} mould parts`,
        );
    } catch (e) {
      const msg = exportFailureMessage(e);
      toast(e instanceof FitCheckExportError ? msg : `Export failed: ${msg}`);
    }
  };

  const buildPack = () => {
    try {
      const ran = withExportLock(() => {
        openHtml(buildPackHtmlChecked(project, fullModel(), { rates: loadRates() }));
      });
      if (!ran.ok) toast('Build pack already opening');
    } catch (e) {
      const msg = exportFailureMessage(e);
      toast(e instanceof FitCheckExportError ? msg : `Build pack failed: ${msg}`);
    }
  };

  return (
    <header className="topbar">
      <label className="field-row" title="Project name">
        <span>Name</span>
        <input className="name-input" value={project.name} onChange={(e) => setName(e.target.value)} aria-label="Project name" />
      </label>
      <span
        className={`save-mark ${saveStatus}`}
        role="status"
        title={
          saveStatus === 'failed'
            ? 'This browser could not keep the latest changes (its storage may be full). Use Save to keep a project file.'
            : 'Kept in this browser as you work. Use Save for a project file you can move or back up.'
        }
      >
        {saveStatus === 'saved' ? 'Saved' : saveStatus === 'saving' ? 'Saving…' : 'Not saved'}
      </span>
      <CloudSyncMark />
      <div className="group">
        <button className="tb" onClick={undo} disabled={!past} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button className="tb" onClick={redo} disabled={!future} title="Redo (Ctrl+Shift+Z)">
          Redo
        </button>
      </div>
      <div className="group">
        <Menu label="Presets">
          {(close) => (
            <ul className="tree-view">
              {[
                { head: 'Start from', list: PRESETS.filter((p) => !p.small) },
                { head: 'Small (under 10 cm)', list: PRESETS.filter((p) => p.small) },
              ].map(({ head, list }) => (
                <li key={head}>
                  <details open>
                    <summary>{head}</summary>
                    <ul>
                      {list.map((p) => (
                        <li key={p.name}>
                          <button
                            onClick={() => {
                              loadPreset(p);
                              close();
                            }}
                          >
                            <span>{p.name}</span>
                            <small>{p.note}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
              <li>
                <details open>
                  <summary>Sound</summary>
                  <ul>
                    {SOUND_PRESETS.map((p) => (
                      <li key={p.name}>
                        <button
                          onClick={() => {
                            const url = p.sound ? soundDataUrl(p.sound.spec) : null;
                            loadPreset(p, p.sound && url ? { [p.sound.slot]: { name: 'sound.png', dataUrl: url, sound: p.sound.spec } } : {});
                            close();
                          }}
                        >
                          <span>{p.name}</span>
                          <small>{p.note}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            </ul>
          )}
        </Menu>
        <Menu label={`Variants${project.variants.length ? ` (${project.variants.length})` : ''}`}>
          {(close) => (
            <ul className="tree-view">
              <li>
                <button
                  onClick={() => {
                    const name = window.prompt('Variant name', `${project.name} ${project.variants.length + 1}`);
                    if (name) saveVariant(name);
                    close();
                  }}
                >
                  + Save current as variant
                </button>
              </li>
              {project.variants.map((v) => (
                <li key={v.id}>
                  {v.name}
                  <span className="seg">
                    <button className="btn sm" onClick={() => (loadVariant(v.id), close())}>
                      Load
                    </button>
                    <button className="btn sm" onClick={() => (setUi({ compareA: 'current', compareB: v.id, tab: 'compare' }), close())}>
                      Compare
                    </button>
                    <button className="btn sm" onClick={() => deleteVariant(v.id)} aria-label={`Delete ${v.name}`}>
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Menu>
        <Menu label="Maps">
          {(close) => (
            <ul className="tree-view">
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setUi({ tab: 'map' });
                    close();
                  }}
                >
                  <span>Open Map tab</span>
                  <small>source, engraving, presets</small>
                </button>
              </li>
              {MAP_PRESET_CATALOG.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      const prev = useStore.getState().project.images.top?.map;
                      setTopMap(mapPresetSpecKeepingUser(p.id, prev));
                      setUi({ tab: 'map' });
                      close();
                    }}
                  >
                    <span>{p.label}</span>
                    <small>{p.note}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Menu>
        <Menu label="Shuffle">
          {(close) => (
            <>
              <button className="item" onClick={() => (randomise(), close())}>
                <span>Randomise</span>
                <small>unlocked values, anything goes</small>
              </button>
              <button className="item" onClick={() => (useStore.getState().shuffleGentle(), close())}>
                <span>Gentle impression</span>
                <small>soft, shallow, flowing relief</small>
              </button>
            </>
          )}
        </Menu>
      </div>
      <div className="group">
        <ProjectsButton />
        <button className="tb" onClick={open}>
          Open
        </button>
        <button className="tb" onClick={save} title="Save project JSON (parameters + images)">
          Save
        </button>
        <ShareButton />
        <Menu label="Import">
          {(close) => (
            <>
              <div className="head">STL / OBJ from Fusion (mm)</div>
              <button className="item" onClick={() => (close(), importMeshInto('ins'))}>
                <span>As insert (cavity cutter)</span>
                <small>e.g. the fin</small>
              </button>
              <button className="item" onClick={() => (close(), importMeshInto('src'))}>
                <span>As source form (to slice)</span>
                <small>re-slice a design</small>
              </button>
            </>
          )}
        </Menu>
      </div>
      <div className="group">
        <AppearanceMenu />
      </div>
      <div className="spacer" />
      <button className="tb" onClick={buildPack} title="One printable page for the workshop wall: numbered plate layout, assembly order, rods and spacers, glue-up and pour plan">
        Build pack
      </button>
      <button className="tb default" onClick={exportZip} title="All DXFs, sheets, moulds, STL, cut list and project file">
        Export ZIP
      </button>
      <SharedLinkPrompt />
    </header>
  );
}
