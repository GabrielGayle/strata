// The composer: several image blocks on each surface, moved, scaled and turned
// freely, dragged between surfaces, and blended down to one greyscale image per
// surface when applied. Canvas view places blocks; node view wires them up.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  blockId,
  composite,
  frameSize,
  makeBlock,
  moveBlock,
  newComposition,
  newDrawing,
  restack,
  SURFACES,
  swapSurfaces,
  type Block,
  type BlendMode,
  type BlockSource,
  type Composition,
  type Surface,
} from '../core/compose';
import type { Gray } from '../core/image';
import { PATTERN_PRESETS, type PatternSpec } from '../core/pattern';
import type { ImageAsset, Project } from '../core/project';
import type { RawValue } from '../core/params';
import { useStore } from '../state/store';
import { loadImageGray, useBlockSources } from './blockSources';
import ArrangeStage from './ArrangeStage';
import DrawModal from './DrawModal';
import { ArrangeBar } from './SurfaceLayers';
import NodeView from './NodeView';
import PatternModal, { ASPECTS } from './PatternModal';
import { sampleCliff } from './sample';
import { grayDataUrl, paintGray, readImage, SURFACE_INFO } from './surfaces';
import { Tab as TabItem } from './Tab';

const BLENDS: { value: BlendMode; label: string; hint: string }[] = [
  { value: 'darken', label: 'Darken', hint: 'Keeps the deeper cut where blocks overlap' },
  { value: 'multiply', label: 'Multiply', hint: 'Overlaps cut deeper than either block' },
  { value: 'lighten', label: 'Lighten', hint: 'Keeps the shallower cut: a white block erases' },
  { value: 'normal', label: 'Cover', hint: 'Covers what is under it, white included' },
];

/**
 * Open with the saved composition, or start one from whatever is already in the
 * slots. A slot filled outside the composer since (a new upload or pattern) comes
 * in as a block on top, and the blocks it replaced wait in the tray.
 */
export async function seedComposition(project: Project, stackAspect: number): Promise<Composition> {
  let comp = project.composition ?? newComposition({ top: stackAspect });
  for (const s of SURFACES) {
    const a = project.images[s];
    if (!a || a.composed) continue;
    const fresh = !comp.blocks.some((b) => b.surface === s);
    comp = { ...comp, blocks: comp.blocks.map((b) => (b.surface === s ? { ...b, surface: null } : b)) };
    let aspect = comp.frames[s].aspect;
    let block: Block;
    if (a.pattern) {
      aspect = a.pattern.aspect;
      block = makeBlock({ kind: 'pattern', spec: a.pattern }, { surface: s, scale: 1 });
    } else {
      const g = await loadImageGray(a.dataUrl);
      if (g) aspect = g.w / g.h;
      block = makeBlock({ kind: 'image', name: a.name, dataUrl: a.dataUrl }, { surface: s, scale: 1 });
    }
    comp = { ...comp, frames: fresh ? { ...comp.frames, [s]: { ...comp.frames[s], aspect } } : comp.frames, blocks: [...comp.blocks, block] };
  }
  return comp;
}

function Thumb({ g, className = 'cm-thumb' }: { g: Gray | null; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current && g) paintGray(ref.current, g);
  }, [g]);
  return g ? <canvas ref={ref} className={className} /> : <span className={className} />;
}

function Num({ label, value, min, max, step = 0.01, onChange, onStart }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onStart?: () => void }) {
  return (
    <label className="field-row pm-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onPointerDown={onStart} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <span className="mono">{step >= 1 ? Math.round(value) : value.toFixed(2)}</span>
    </label>
  );
}

type Editing = { kind: 'pattern'; id: string | null; spec: PatternSpec } | { kind: 'drawing'; id: string | null; spec: import('../core/compose').DrawingSpec };

export default function ComposerModal({ initial, initialSurface, stackAspect, onClose }: { initial: Composition; initialSurface: Surface; stackAspect: number; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const applyComposition = useStore((s) => s.applyComposition);
  const toast = useStore((s) => s.toast);
  const [comp, setCompState] = useState<Composition>(initial);
  const [surface, setSurface] = useState<Surface>(initialSurface);
  const [view, setView] = useState<'canvas' | 'nodes'>('canvas');
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [applied, setApplied] = useState<Composition>(initial);
  const past = useRef<Composition[]>([]);
  const future = useRef<Composition[]>([]);
  const sourceOf = useBlockSources(comp.blocks);

  /** Record an undo step, then change. Drags call begin() once and change() many times. */
  const begin = () => {
    past.current = [...past.current.slice(-99), comp];
    future.current = [];
  };
  const change = (next: Composition | ((c: Composition) => Composition)) => setCompState(next);
  const commit = (next: (c: Composition) => Composition) => {
    begin();
    change(next);
  };
  const undo = () => {
    const p = past.current.pop();
    if (!p) return;
    future.current = [comp, ...future.current];
    setCompState(p);
  };
  const redo = () => {
    const n = future.current.shift();
    if (!n) return;
    past.current.push(comp);
    setCompState(n);
  };
  const setBlock = (id: string, patch: Partial<Block>) => change((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
  const selected = comp.blocks.find((b) => b.id === sel) ?? null;
  const dirty = comp !== applied;

  const tryClose = () => {
    if (dirty && !window.confirm('Close the composer without applying your changes?')) return;
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing) return; // the pattern / drawing modal on top handles its own keys
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      // keep the app's own shortcuts (undo, tab numbers) from acting on the project behind
      e.stopImmediatePropagation();
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') tryClose();
      else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'd' && selected) {
        e.preventDefault();
        duplicate(selected);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        remove(selected.id);
      } else if (selected && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const k = e.shiftKey ? 0.05 : 0.005;
        commit((c) => ({
          ...c,
          blocks: c.blocks.map((b) =>
            b.id === selected.id ? { ...b, x: b.x + (e.key === 'ArrowLeft' ? -k : e.key === 'ArrowRight' ? k : 0), y: b.y + (e.key === 'ArrowUp' ? -k : e.key === 'ArrowDown' ? k : 0) } : b,
          ),
        }));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const preview = useMemo(() => {
    const { w, h } = frameSize(comp.frames[surface], 420);
    return composite(comp, surface, sourceOf, w, h);
  }, [comp, surface, sourceOf]);

  const add = async (source: BlockSource, patch: Partial<Block> = {}) => {
    // start at most 80% of the frame either way, whatever the source's proportions
    const g = source.kind === 'image' ? await loadImageGray(source.dataUrl) : null;
    const srcAspect = source.kind === 'image' ? (g ? g.w / g.h : 1) : source.spec.aspect;
    const fa = comp.frames[patch.surface ?? surface]?.aspect ?? 1;
    const b = makeBlock(source, { surface, scale: +Math.min(0.8, (0.8 * srcAspect) / fa).toFixed(3), ...patch });
    commit((c) => ({ ...c, blocks: [...c.blocks, b] }));
    setSel(b.id);
    setView('canvas');
  };
  const duplicate = (b: Block) => {
    const d = { ...b, id: blockId(), name: `${b.name} copy`, x: b.x + 0.04, y: b.y + 0.04, node: b.node && { x: b.node.x + 24, y: b.node.y + 24 } };
    commit((c) => ({ ...c, blocks: [...c.blocks, d] }));
    setSel(d.id);
  };
  const remove = (id: string) => {
    commit((c) => ({ ...c, blocks: c.blocks.filter((b) => b.id !== id) }));
    setSel(null);
  };
  const sendTo = (id: string, s: Surface | null) => commit((c) => moveBlock(c, id, s));

  const apply = (close: boolean) => {
    const imgs: Partial<Record<Surface, ImageAsset | null>> = {};
    const patch: Record<string, RawValue> = {};
    for (const s of SURFACES) {
      const on = comp.blocks.some((b) => b.surface === s && !b.hidden);
      if (on) {
        const { w, h } = frameSize(comp.frames[s], 640);
        imgs[s] = { name: 'composition.png', dataUrl: grayDataUrl(composite(comp, s, sourceOf, w, h)), composed: true };
        Object.assign(patch, SURFACE_INFO[s].enable);
      } else if (project.images[s]?.composed) {
        // this surface was composed before and is now empty: clear it rather than leave a stale picture
        imgs[s] = null;
        Object.assign(patch, SURFACE_INFO[s].off);
      }
    }
    applyComposition(comp, imgs, patch);
    setApplied(comp);
    const n = Object.values(imgs).filter(Boolean).length;
    toast(n ? `Pressed ${n} surface${n === 1 ? '' : 's'} from the composer (undo to step back)` : 'Composer saved; no surfaces have blocks');
    if (close) onClose();
  };

  const tray = comp.blocks.filter((b) => b.surface === null);
  const onSurface = comp.blocks.filter((b) => b.surface === surface);
  const frame = comp.frames[surface];
  const aspects = ASPECTS.some((a) => Math.abs(a.value - frame.aspect) < 1e-3) ? ASPECTS : [{ value: frame.aspect, label: `${frame.aspect.toFixed(2)} : 1` }, ...ASPECTS];
  const dragProps = (b: Block) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('text/x-block', b.id);
      e.dataTransfer.effectAllowed = 'move';
    },
  });

  return (
    <div className="pm-back" onMouseDown={(e) => e.target === e.currentTarget && tryClose()}>
      <div className="window pm cm" role="dialog" aria-modal="true" aria-label="Image composer">
        <div className="title-bar">
          <div className="title-bar-text">Composer</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={tryClose}></button>
          </div>
        </div>
        <div className="cm-add btnrow">
          <menu role="tablist" aria-label="Surface">
            {SURFACES.map((s) => {
              const n = comp.blocks.filter((b) => b.surface === s).length;
              const on = view === 'canvas' && surface === s;
              return (
                <TabItem
                  key={s}
                  selected={on}
                  onSelect={() => {
                    setSurface(s);
                    setView('canvas');
                  }}
                  onDragOver={(e) => e.dataTransfer.types.includes('text/x-block') && e.preventDefault()}
                  onDrop={(e) => {
                    const id = e.dataTransfer.getData('text/x-block');
                    if (id) sendTo(id, s);
                  }}
                  title={`${SURFACE_INFO[s].title}. Drop a block here to move it to this surface.`}
                >
                  {SURFACE_INFO[s].short} {n}
                </TabItem>
              );
            })}
            <TabItem selected={view === 'nodes'} onSelect={() => setView('nodes')} title="See every block and wire it to a surface">
              Nodes
            </TabItem>
          </menu>
          <button className="btn sm" onClick={undo} disabled={!past.current.length} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button className="btn sm" onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Shift+Z)">
            Redo
          </button>
        </div>

        <div className="cm-add btnrow">
          <span className="mono cm-add-label">Add to {view === 'nodes' ? 'tray' : SURFACE_INFO[surface].short.toLowerCase()}:</span>
          <button
            className="btn sm"
            onClick={async () => {
              const img = await readImage();
              if (img) add({ kind: 'image', ...img }, view === 'nodes' ? { surface: null } : {});
            }}
          >
            + Image
          </button>
          <button className="btn sm" onClick={() => setEditing({ kind: 'pattern', id: null, spec: { ...PATTERN_PRESETS[0].spec(), aspect: 1 } })}>
            + Pattern
          </button>
          <button className="btn sm" onClick={() => setEditing({ kind: 'drawing', id: null, spec: newDrawing(1) })}>
            + Drawing
          </button>
          <button className="btn sm" onClick={() => add({ kind: 'image', name: 'sample-cliff.png', dataUrl: sampleCliff(Math.floor(Math.random() * 9999)) }, view === 'nodes' ? { surface: null } : {})}>
            + Sample
          </button>
        </div>

        {view === 'nodes' ? (
          <NodeView
            comp={comp}
            sourceOf={sourceOf}
            sel={sel}
            onSelect={setSel}
            onBegin={begin}
            onChange={setBlock}
            onWire={(id, s) => sendTo(id, s)}
            onOpenSurface={(s) => {
              setSurface(s);
              setView('canvas');
            }}
          />
        ) : (
          <div className="cm-body">
            <ArrangeStage
              comp={comp}
              surface={surface}
              sourceOf={sourceOf}
              preview={preview}
              sel={sel}
              onSelect={setSel}
              onChange={setBlock}
              onBegin={begin}
              onDropBlock={(id, x, y) => {
                commit((c) => {
                  const m = moveBlock(c, id, surface);
                  return { ...m, blocks: m.blocks.map((b) => (b.id === id ? { ...b, x, y } : b)) };
                });
                setSel(id);
              }}
            />
            <div className="cm-side">
              <div className="pm-group">Frame</div>
              <div className="field-row pm-row">
                <span>Proportions</span>
                <select value={aspects.find((a) => Math.abs(a.value - frame.aspect) < 1e-3)?.value ?? frame.aspect} onChange={(e) => commit((c) => ({ ...c, frames: { ...c.frames, [surface]: { ...frame, aspect: Number(e.target.value) } } }))} aria-label="Frame proportions">
                  {aspects.map((a) => (
                    <option key={a.label} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
              {surface === 'top' && (
                <div className="field-row pm-row">
                  <span />
                  <button className="btn sm" onClick={() => commit((c) => ({ ...c, frames: { ...c.frames, top: { ...frame, aspect: stackAspect } } }))} title="Match the plate stack's footprint">
                    Match stack footprint
                  </button>
                </div>
              )}
              <Num label="Background" value={frame.background} min={0} max={1} onStart={begin} onChange={(x) => change((c) => ({ ...c, frames: { ...c.frames, [surface]: { ...c.frames[surface], background: x } } }))} />
              <div className="field-row pm-row">
                <span>Swap with</span>
                <span className="seg">
                  {SURFACES.filter((s) => s !== surface).map((s) => (
                    <button key={s} className="btn sm" onClick={() => commit((c) => swapSurfaces(c, surface, s))} title={`Exchange every block on ${SURFACE_INFO[surface].short} and ${SURFACE_INFO[s].short}`}>
                      {SURFACE_INFO[s].short}
                    </button>
                  ))}
                </span>
              </div>

              <div className="pm-group">Blocks on {SURFACE_INFO[surface].short.toLowerCase()} (top of the list is on top)</div>
              <div className="cm-list">
                {[...onSurface].reverse().map((b) => (
                  <div key={b.id} className={`cm-item ${b.id === sel ? 'on' : ''}`} onClick={() => setSel(b.id)} {...dragProps(b)}>
                    <Thumb g={sourceOf(b)} />
                    <span className="cm-name">{b.name}</span>
                    <button className="btn sm" title={b.hidden ? 'Show' : 'Hide'} onClick={(e) => (e.stopPropagation(), commit((c) => ({ ...c, blocks: c.blocks.map((x) => (x.id === b.id ? { ...x, hidden: !x.hidden } : x)) })))}>
                      {b.hidden ? '○' : '●'}
                    </button>
                    <button className="btn sm" title="Bring forward" onClick={(e) => (e.stopPropagation(), commit((c) => restack(c, b.id, 1)))}>
                      ↑
                    </button>
                    <button className="btn sm" title="Send backward" onClick={(e) => (e.stopPropagation(), commit((c) => restack(c, b.id, -1)))}>
                      ↓
                    </button>
                  </div>
                ))}
                {!onSurface.length && <div className="note">Nothing here yet.</div>}
              </div>
              <div className="pm-group">Arrange</div>
              <ArrangeBar comp={comp} surface={surface} sel={sel} dimsOf={sourceOf} onArrange={commit} />

              {selected && selected.surface === surface && (
                <>
                  <div className="pm-group">Selected block</div>
                  <label className="field-row pm-row">
                    <span>Name</span>
                    <input value={selected.name} onFocus={begin} onChange={(e) => setBlock(selected.id, { name: e.target.value })} aria-label="Block name" style={{ flex: 1, minWidth: 0 }} />
                  </label>
                  <div className="field-row pm-row">
                    <span>Blend</span>
                    <span className="seg pm-seg">
                      {BLENDS.map((o) => (
                        <button key={o.value} className={`btn sm ${selected.blend === o.value ? 'on' : ''}`} title={o.hint} onClick={() => commit((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === selected.id ? { ...b, blend: o.value } : b)) }))}>
                          {o.label}
                        </button>
                      ))}
                    </span>
                  </div>
                  <Num label="Strength" value={selected.opacity} min={0} max={1} onStart={begin} onChange={(x) => setBlock(selected.id, { opacity: x })} />
                  <Num label="Contrast" value={selected.contrast} min={0.2} max={4} onStart={begin} onChange={(x) => setBlock(selected.id, { contrast: x })} />
                  <Num label="Size" value={selected.scale} min={0.02} max={2} onStart={begin} onChange={(x) => setBlock(selected.id, { scale: x })} />
                  <Num label="Turn" value={selected.rotate} min={-180} max={180} step={1} onStart={begin} onChange={(x) => setBlock(selected.id, { rotate: x })} />
                  <label className="field-row pm-row">
                    <span>Invert</span>
                    <input type="checkbox" className="chk" checked={selected.invert} onChange={(e) => commit((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === selected.id ? { ...b, invert: e.target.checked } : b)) }))} />
                  </label>
                  <div className="field-row pm-row">
                    <span>Move to</span>
                    <span className="seg">
                      {SURFACES.filter((s) => s !== surface).map((s) => (
                        <button key={s} className="btn sm" onClick={() => sendTo(selected.id, s)}>
                          {SURFACE_INFO[s].short}
                        </button>
                      ))}
                      <button className="btn sm" onClick={() => sendTo(selected.id, null)} title="Park it in the tray, off every surface">
                        Tray
                      </button>
                    </span>
                  </div>
                  <div className="btnrow" style={{ padding: '6px 0' }}>
                    <button className="btn sm" onClick={() => commit((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === selected.id ? { ...b, x: 0.5, y: 0.5 } : b)) }))}>
                      Centre
                    </button>
                    <button className="btn sm" onClick={() => commit((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === selected.id ? { ...b, x: 0.5, y: 0.5, scale: 1, rotate: 0 } : b)) }))}>
                      Fill width
                    </button>
                    {selected.source.kind === 'pattern' && (
                      <button className="btn sm" onClick={() => setEditing({ kind: 'pattern', id: selected.id, spec: (selected.source as { spec: PatternSpec }).spec })}>
                        Edit pattern…
                      </button>
                    )}
                    {selected.source.kind === 'drawing' && (
                      <button className="btn sm" onClick={() => setEditing({ kind: 'drawing', id: selected.id, spec: (selected.source as { spec: import('../core/compose').DrawingSpec }).spec })}>
                        Edit drawing…
                      </button>
                    )}
                    {selected.source.kind === 'image' && (
                      <button
                        className="btn sm"
                        onClick={async () => {
                          const img = await readImage();
                          if (img) commit((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === selected.id ? { ...b, source: { kind: 'image', ...img } } : b)) }));
                        }}
                      >
                        Replace image…
                      </button>
                    )}
                    <button className="btn sm" onClick={() => duplicate(selected)} title="Duplicate (Ctrl+D)">
                      Duplicate
                    </button>
                    <button className="btn sm" onClick={() => remove(selected.id)} title="Delete">
                      Delete
                    </button>
                  </div>
                </>
              )}

              <div className="pm-group">Tray (on no surface)</div>
              <div className="cm-list">
                {tray.map((b) => (
                  <div key={b.id} className={`cm-item ${b.id === sel ? 'on' : ''}`} {...dragProps(b)} title="Drag onto the picture or a surface tab">
                    <Thumb g={sourceOf(b)} />
                    <span className="cm-name">{b.name}</span>
                    <button className="btn sm" onClick={() => (sendTo(b.id, surface), setSel(b.id))}>
                      Place
                    </button>
                    <button className="btn sm" onClick={() => remove(b.id)} title="Delete">
                      ✕
                    </button>
                  </div>
                ))}
                {!tray.length && <div className="note">Blocks you take off a surface wait here.</div>}
              </div>
            </div>
          </div>
        )}

        <div className="btnrow" style={{ justifyContent: 'flex-end', borderTop: '1px solid var(--line)' }}>
          <span className="note" style={{ marginRight: 'auto', padding: 0 }}>
            Dark cuts deepest. Each surface with blocks becomes that surface's image; drag the boxes to move, the corner to resize, the dot to turn.
          </span>
          <button className="btn" onClick={tryClose}>
            {dirty ? 'Cancel' : 'Close'}
          </button>
          <button className="btn" onClick={() => apply(false)} disabled={!dirty}>
            Apply
          </button>
          <button className="btn default" onClick={() => apply(true)}>
            Apply and close
          </button>
        </div>
      </div>
      {editing?.kind === 'pattern' && (
        <PatternModal
          title={editing.id ? 'Edit pattern block' : 'New pattern block'}
          initial={editing.spec}
          onClose={() => setEditing(null)}
          onApply={(spec) => {
            if (editing.id) commit((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === editing.id ? { ...b, source: { kind: 'pattern', spec } } : b)) }));
            else add({ kind: 'pattern', spec }, view === 'nodes' ? { surface: null } : {});
            setEditing(null);
          }}
        />
      )}
      {editing?.kind === 'drawing' && (
        <DrawModal
          initial={editing.spec}
          onClose={() => setEditing(null)}
          onApply={(spec) => {
            if (editing.id) commit((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === editing.id ? { ...b, source: { kind: 'drawing', spec } } : b)) }));
            else add({ kind: 'drawing', spec }, view === 'nodes' ? { surface: null } : {});
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
