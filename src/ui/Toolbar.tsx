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
import { ProposalButton } from './ProposalDialog';
import { isProjectZipName, projectFromZip } from '../core/projectZip';
import { busyThen } from './busy';
import { clearSavedResults, resultsStored, savedResultsUsage } from '../state/results';
import { BoostSettings, CloudHeroButton, CloudPackButton } from './CloudStatus';
import { openShortcuts } from './Help';
import { openChangelog, useUnseenChanges } from './Changelog';
import { usePanels } from '../state/panelLayout';
import { changedControls } from '../core/panelLayout';

export function Menu({ label, children, className = 'tb', hl }: { label: ReactNode; children: (close: () => void) => ReactNode; className?: string; /** `data-hl` name for the changelog's "show me" */ hl?: string }) {
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
        data-hl={hl}
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
    let plates: number | undefined;
    if (isProjectZipName(f.name, f.type)) {
      const opened = projectFromZip(new Uint8Array(await f.arrayBuffer()));
      project = opened.project;
      plates = opened.plateCount;
    } else {
      project = deserialize(await f.text());
    }
    replaceProject(project);
    unlinkActive();
    toast(`Opened ${f.name}`);
    if (opts.offerKeep !== false && isProjectZipName(f.name, f.type)) await keepOpenedInLibrary(project, f.name, plates);
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

/** Results the engine keeps so undo, compare and reopening are instant: how much there is, and one button to clear them. */
function SavedResults() {
  const [usage, setUsage] = useState<{ entries: number; bytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    savedResultsUsage()
      .then((u) => alive && setUsage(u))
      .catch(() => alive && setUsage({ entries: 0, bytes: 0 }));
    return () => {
      alive = false;
    };
  }, []);
  const clear = async () => {
    setBusy(true);
    try {
      await clearSavedResults();
      setUsage({ entries: 0, bytes: 0 });
    } finally {
      setBusy(false);
    }
  };
  if (!resultsStored()) return <p className="note">Finished designs are kept in memory for undo. Saving them in the browser is off here (development server).</p>;
  return (
    <>
      <p className="note" data-testid="saved-results">
        {usage ? `${usage.entries} finished design${usage.entries === 1 ? '' : 's'} kept, ${(usage.bytes / 1e6).toFixed(1)} MB` : 'Counting…'}
      </p>
      <div className="btnrow">
        <button className="btn sm" data-hl="clear-saved-results" onClick={clear} disabled={busy} title="Forget every kept result: the next undo, compare or reopen builds the design again">
          Clear saved results
        </button>
      </div>
    </>
  );
}

function SettingsMenu() {
  return (
    <Menu label="Settings" hl="menu-settings">
      {() => (
        <div style={{ width: 300 }}>
          <div className="head">Saved results</div>
          <p className="note">Undo, Compare and reopening a design show finished results straight from this browser instead of building them again.</p>
          <SavedResults />
          <div className="head">Boost</div>
          <BoostSettings />
        </div>
      )}
    </Menu>
  );
}

function LayoutMenu() {
  const editing = usePanels((s) => s.editing);
  const layout = usePanels((s) => s.layout);
  const saved = usePanels((s) => s.saved);
  const current = usePanels((s) => s.current);
  const toast = useStore((s) => s.toast);
  const p = usePanels.getState;
  const cur = saved.find((x) => x.id === current);
  const moved = changedControls(layout);
  return (
    <Menu label="Layout" hl="menu-layout">
      {(close) => (
        <div style={{ width: 300 }}>
          <button className="item" data-hl="layout-edit" aria-pressed={editing} onClick={() => (close(), p().setEditing(!editing))}>
            <span>{editing ? '✓ ' : ''}Edit layout</span>
            <small>drag controls</small>
          </button>
          <button
            className="item"
            onClick={() => {
              close();
              const n = window.prompt('Name for the new panel', 'My favourites');
              if (n) {
                p().addPanel(n);
                p().setEditing(true);
              }
            }}
          >
            <span>New panel…</span>
            <small>for favourites</small>
          </button>
          <div className="head">Columns</div>
          <button className="item" aria-pressed={!layout.hide.a} onClick={() => p().toggleHide('a')}>
            <span>{layout.hide.a ? '' : '✓ '}Parameters column</span>
          </button>
          <button className="item" aria-pressed={!layout.hide.b} onClick={() => p().toggleHide('b')}>
            <span>{layout.hide.b ? '' : '✓ '}Inspector column</span>
          </button>
          <button className="item" onClick={() => p().toggleSwap()}>
            <span>Swap sides</span>
            <small>{layout.swap ? 'Parameters left' : 'Parameters right'}</small>
          </button>
          <div className="head">Saved layouts</div>
          {saved.length === 0 && <p className="note" style={{ padding: '6px 10px', margin: 0 }}>None yet. The layout is kept as you go; save one to come back to.</p>}
          {saved.map((x) => (
            <button key={x.id} className="item" data-hl="layout-saved" onClick={() => (close(), p().loadSaved(x.id), toast(`Layout "${x.name}"`))}>
              <span>
                {x.id === current ? '● ' : ''}
                {x.name}
              </span>
            </button>
          ))}
          <button
            className="item"
            data-hl="layout-save"
            onClick={() => {
              close();
              const n = window.prompt('Save this layout as', cur?.name ?? 'My layout');
              if (n) {
                p().saveAs(n);
                toast(`Saved layout "${n.trim()}"`);
              }
            }}
          >
            <span>Save layout as…</span>
            <small>the whole screen</small>
          </button>
          {cur && (
            <>
              <button
                className="item"
                onClick={() => {
                  close();
                  const n = window.prompt('Rename layout', cur.name);
                  if (n) p().renameSaved(cur.id, n);
                }}
              >
                <span>Rename "{cur.name}"…</span>
              </button>
              <button
                className="item"
                onClick={() => {
                  close();
                  if (window.confirm(`Delete the saved layout "${cur.name}"? What's on screen stays as it is.`)) p().removeSaved(cur.id);
                }}
              >
                <span>Delete "{cur.name}"</span>
              </button>
            </>
          )}
          {saved.length > 0 && (
            <button className="item" onClick={() => (close(), download('strata-layouts.json', p().exportText(), 'application/json'))}>
              <span>Export layouts…</span>
              <small>as a file</small>
            </button>
          )}
          <button
            className="item"
            onClick={async () => {
              close();
              const f = await pickFile('.json,application/json');
              if (!f) return;
              try {
                const n = p().importText(await f.text());
                toast(`${n} layout${n === 1 ? '' : 's'} added to Layout`);
              } catch (e) {
                toast(`Couldn't read that file: ${(e as Error).message}`);
              }
            }}
          >
            <span>Import layouts…</span>
          </button>
          <div className="head">Reset</div>
          <button
            className="item"
            data-hl="layout-reset"
            onClick={() => {
              close();
              if (window.confirm('Put every panel, control, column, 3D sidebar tab and view back where they start? Saved layouts are kept, and your projects are not touched.')) {
                p().resetAll();
                toast('Layout back to the default');
              }
            }}
          >
            <span>Reset to default layout</span>
            <small>{moved ? `${moved} moved` : 'everything'}</small>
          </button>
        </div>
      )}
    </Menu>
  );
}

function HelpMenu() {
  const unseen = useUnseenChanges();
  return (
    <Menu label={unseen ? `Help (${unseen} new)` : 'Help'} hl="menu-help">
      {(close) => (
        <>
          <button className="item" data-hl="help-changelog" onClick={() => (close(), openChangelog())}>
            <span>Changelog…</span>
            <small>{unseen ? `${unseen} new since you last looked` : 'what\'s new and fixed, and where it is'}</small>
          </button>
          <button className="item" onClick={() => (close(), openShortcuts())}>
            <span>Keyboard shortcuts</span>
            <small>?</small>
          </button>
        </>
      )}
    </Menu>
  );
}

function AppearanceMenu() {
  const theme = useStore((s) => s.ui.theme);
  const setTheme = useStore((s) => s.setTheme);
  const current = theme.id === 'system' ? null : (theme as ThemeSeed);
  return (
    <Menu label="Appearance" hl="menu-appearance">
      {() => (
        <div style={{ width: 300 }}>
          <div className="head">Plates</div>
          <div className="btnrow">
            <button className="btn sm" data-hl="plate-materials" onClick={() => useStore.getState().setUi({ tab: '3d', paintMode: true, moveMode: false })} title="Sort plates into material buckets (Corten, aluminium…) by clicking them in the 3D view">
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
  const { undo, redo, setName, randomise, loadPreset, saveVariant, loadVariant, deleteVariant, toast, setUi, setTopMap, applyQuickMap } =
    useStore.getState();
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
  const exportZip = async () => {
    try {
      const ran = await busyThen({ scene: 'export', title: 'Exporting', detail: 'Slicing every plate, nesting cut sheets, drawing moulds and zipping the DXFs…' }, () => withExportLock(() => {
        const model = fullModel();
        const zip = buildZip(model, project, loadRates());
        download(`${(project.name || 'strata').replace(/[^\w-]+/g, '_')}-fabrication.zip`, zip, 'application/zip');
        void recordLibrarySave(project, { source: 'export', plates: model.sliced.plates.length, thumb: grabThumb(), linkId: activeLibraryLinkId() })
          .then((meta) => linkActive(meta.id, project))
          .catch((e) => toast(`Exported, but Projects failed: ${(e as Error).message}`));
        return model;
      }));
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

  const buildPack = async () => {
    try {
      const ran = await busyThen({ scene: 'pack', title: 'Build pack', detail: 'Laying out the numbered plates, assembly order and pour plan…' }, () =>
        withExportLock(() => {
          openHtml(buildPackHtmlChecked(project, fullModel(), { rates: loadRates() }));
        }),
      );
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
        <button className="tb" data-testid="impress-open" onClick={() => setUi({ tab: 'impress' })} title="Press a picture into the top surface or the front face: click it into place, size, turn and set its depth in 3D, with an x-ray of the cut">
          Impress image
        </button>
      </div>
      <div className="group">
        <Menu label="Presets" hl="menu-presets">
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
                  <summary>Maps</summary>
                  <ul>
                    <li>
                      <button
                        type="button"
                        data-testid="quick-map-from-presets"
                        onClick={() => {
                          applyQuickMap();
                          setUi({ tab: 'map' });
                          close();
                        }}
                      >
                        <span>Quick map</span>
                        <small>dense plates, OSM engrave, no insert</small>
                      </button>
                    </li>
                  </ul>
                </details>
              </li>
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
        <Menu hl="menu-variants" label={`Variants${project.variants.length ? ` (${project.variants.length})` : ''}`}>
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
        <Menu label="Maps" hl="menu-maps">
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
              <li>
                <button
                  type="button"
                  data-testid="quick-map-from-maps"
                  onClick={() => {
                    applyQuickMap();
                    setUi({ tab: 'map' });
                    close();
                  }}
                >
                  <span>Quick map</span>
                  <small>dense plates, OSM engrave, no insert</small>
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
        <Menu label="Shuffle" hl="menu-shuffle">
          {(close) => (
            <>
              <button className="item" onClick={() => (randomise(), close())}>
                <span>Randomise</span>
                <small>unlocked values, anything goes</small>
              </button>
              <button className="item" data-hl="gentle-impression" onClick={() => (useStore.getState().shuffleGentle(), close())}>
                <span>Gentle impression</span>
                <small>soft, shallow, flowing relief</small>
              </button>
            </>
          )}
        </Menu>
      </div>
      <div className="group">
        <ProjectsButton />
        <button className="tb" data-hl="open-file" onClick={open}>
          Open
        </button>
        <button className="tb" data-hl="save-file" onClick={save} title="Save project JSON (parameters + images)">
          Save
        </button>
        <ShareButton />
        <ProposalButton />
        <Menu label="Import" hl="menu-import">
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
        <LayoutMenu />
        <SettingsMenu />
        <HelpMenu />
      </div>
      <div className="spacer" />
      <button className="tb" data-hl="build-pack" onClick={buildPack} title="One printable page for the workshop wall: numbered plate layout, assembly order, rods and spacers, glue-up and pour plan">
        Build pack
      </button>
      <CloudHeroButton project={() => useStore.getState().project} model={fullModel} setHero={useStore.getState().setHero} />
      <CloudPackButton project={() => useStore.getState().project} model={fullModel} rates={loadRates} />
      <button className="tb default" data-hl="export-zip" onClick={exportZip} title="All DXFs, sheets, moulds, STL, cut list and project file">
        Export ZIP
      </button>
      <SharedLinkPrompt />
    </header>
  );
}
