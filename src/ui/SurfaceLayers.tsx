// Layers right on the Image tab: every surface can hold any number of pictures,
// arranged on its card (straight mover, pins, row / column / grid layouts) or
// wired between surfaces on a node board. A surface with one ordinary picture
// looks exactly as before; it turns into layers when a second one is added or
// it is moved. Each finished edit renders the surface and is one undo step.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ANCHORS, LAYOUTS, layoutLayers, liveComposition, pinLayers, seedId, settleComposition, type LayoutKind } from '../core/arrange';
import { composite, frameSize, makeBlock, moveBlock, restack, SURFACES, type BlendMode, type Block, type Composition, type Surface } from '../core/compose';
import type { Gray } from '../core/image';
import type { ImageAsset } from '../core/project';
import type { RawValue } from '../core/params';
import { useStore } from '../state/store';
import ArrangeStage from './ArrangeStage';
import { cachedGray, loadImageGray, useBlockSources, useDecoded } from './blockSources';
import NodeView from './NodeView';
import { grayDataUrl, paintGray, readImages, SURFACE_INFO } from './surfaces';

export type LiveLayers = ReturnType<typeof useLiveLayers>;

/** The project's layers, live: edits made between a pointer press and release render once, on release. */
export function useLiveLayers(topAspect: number) {
  const images = useStore((s) => s.project.images);
  const composition = useStore((s) => s.project.composition);
  const applyComposition = useStore((s) => s.applyComposition);
  const plain = SURFACES.map((s) => images[s]).filter((a): a is ImageAsset => !!a && !a.composed && !a.pattern);
  const decoded = useDecoded(plain.map((a) => a.dataUrl));
  const base = useMemo(
    () =>
      liveComposition(images, composition, topAspect, (a) => {
        const g = cachedGray(a.dataUrl);
        return g ? g.w / g.h : null;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [images, composition, topAspect, decoded],
  );
  const [draft, setDraftState] = useState<{ before: Composition; now: Composition } | null>(null);
  const draftRef = useRef(draft);
  const setDraft = (d: typeof draft) => {
    draftRef.current = d;
    setDraftState(d);
  };
  const comp = draft?.now ?? base;
  const sourceOf = useBlockSources(comp.blocks);
  const [sel, setSel] = useState<string | null>(null);
  const baseRef = useRef(base);
  baseRef.current = base;

  const commit = useCallback(
    async (before: Composition, after: Composition) => {
      const { comp: next, changed, renamed } = settleComposition(before, after);
      if (!changed.length && next.blocks.length === before.blocks.length && next.blocks.every((b, i) => b === before.blocks[i])) return;
      // every picture on a changed surface must be decoded before it is rendered
      await Promise.all(next.blocks.filter((b) => b.surface && changed.includes(b.surface) && b.source.kind === 'image').map((b) => loadImageGray((b.source as { dataUrl: string }).dataUrl)));
      const now = useStore.getState().project.images;
      const imgs: Partial<Record<Surface, ImageAsset | null>> = {};
      const patch: Record<string, RawValue> = {};
      for (const s of changed) {
        if (next.blocks.some((b) => b.surface === s && !b.hidden)) {
          const { w, h } = frameSize(next.frames[s], 640);
          imgs[s] = { name: 'composition.png', dataUrl: grayDataUrl(composite(next, s, (b) => (b.source.kind === 'image' ? cachedGray(b.source.dataUrl) : sourceOf(b)), w, h)), composed: true };
          // switch the surface on only when it was empty, so its own mode (carve / raise …) is kept
          if (!now[s]) Object.assign(patch, SURFACE_INFO[s].enable);
        } else if (now[s]) {
          imgs[s] = null;
          Object.assign(patch, SURFACE_INFO[s].off);
        }
      }
      applyComposition(next, imgs, patch);
      setSel((id) => (id && renamed.get(id)) ?? id);
    },
    [applyComposition, sourceOf],
  );

  /** Start a drag: changes go to a draft until the pointer is released (a click or key changes at once). */
  const pressed = useRef(false);
  const begin = useCallback(() => {
    if (pressed.current && !draftRef.current) setDraft({ before: baseRef.current, now: baseRef.current });
  }, []);
  /** Change now (one undo step), or the draft while a drag is on. */
  const change = useCallback(
    (f: (c: Composition) => Composition) => {
      const d = draftRef.current;
      if (d) setDraft({ ...d, now: f(d.now) });
      else commit(baseRef.current, f(baseRef.current));
    },
    [commit],
  );
  const setBlock = useCallback((id: string, p: Partial<Block>) => change((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === id ? { ...b, ...p } : b)) })), [change]);
  useEffect(() => {
    const down = () => (pressed.current = true);
    const up = () => {
      pressed.current = false;
      const d = draftRef.current;
      if (!d) return;
      // keep showing the drag's result until the store has it, so nothing jumps back
      draftRef.current = null;
      commit(d.before, d.now).finally(() => setDraftState((x) => (x === d ? null : x)));
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [commit]);

  const dimsOf = useCallback((b: Block) => sourceOf(b), [sourceOf]);

  /** Add pictures to a surface: one goes on top of what is there; several (or the first on an empty surface) are laid out in a grid. */
  const addImages = useCallback(
    async (surface: Surface, picked?: { name: string; dataUrl: string }[]) => {
      const imgs = picked ?? (await readImages());
      if (!imgs.length) return;
      const grays = await Promise.all(imgs.map((i) => loadImageGray(i.dataUrl)));
      const c0 = baseRef.current;
      const fa = c0.frames[surface].aspect;
      const had = c0.blocks.filter((b) => b.surface === surface);
      const added = imgs.map((img, i) => {
        const g = grays[i];
        const sa = g ? g.w / g.h : 1;
        // at most half the frame either way, stepped so several do not hide each other
        return makeBlock({ kind: 'image', ...img }, { surface, scale: +Math.min(0.5, (0.5 * sa) / fa).toFixed(3), x: 0.5 + 0.04 * (i + had.length - 1), y: 0.5 + 0.04 * (i + had.length - 1) });
      });
      let next: Composition = { ...c0, blocks: [...c0.blocks, ...added] };
      if (imgs.length > 1 || !had.length) {
        const ids = [...had, ...added].map((b) => b.id);
        const dims = (b: Block) => (b.source.kind === 'image' ? cachedGray(b.source.dataUrl) : sourceOf(b));
        next = layoutLayers(next, surface, ids, 'auto', dims, had.length ? 0.04 : 0, 0.03);
      }
      setSel(added[added.length - 1].id);
      await commit(c0, next);
    },
    [commit, sourceOf],
  );

  return { comp, sourceOf, dimsOf, sel, setSel, begin, change, setBlock, commit, addImages, dragging: !!draft };
}

/** True when a surface is shown as layers on its card (more than its one ordinary picture). */
export function isLayered(live: LiveLayers, surface: Surface): boolean {
  const on = live.comp.blocks.filter((b) => b.surface === surface);
  return on.length > 1 || (on.length === 1 && on[0].id !== seedId(surface));
}

function Thumb({ g }: { g: Gray | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current && g) paintGray(ref.current, g);
  }, [g]);
  return g ? <canvas ref={ref} className="cm-thumb" /> : <span className="cm-thumb" />;
}

const BLENDS: { value: BlendMode; label: string }[] = [
  { value: 'darken', label: 'Darken' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'normal', label: 'Cover' },
];

/** Pins and layouts for the layers on one surface. Pins move the selected layer, or all of them as a group. */
export function ArrangeBar({
  comp,
  surface,
  sel,
  dimsOf,
  onArrange,
}: {
  comp: Composition;
  surface: Surface;
  sel: string | null;
  dimsOf: (b: Block) => { w: number; h: number } | null;
  onArrange: (f: (c: Composition) => Composition) => void;
}) {
  const [margin, setMargin] = useState(0.04);
  const on = comp.blocks.filter((b) => b.surface === surface);
  const visible = on.filter((b) => !b.hidden);
  const selOn = on.some((b) => b.id === sel) ? sel : null;
  const pinIds = selOn ? [selOn] : visible.map((b) => b.id);
  return (
    <div className="sl-arrange">
      <div className="sl-pins" role="group" aria-label={selOn ? 'Pin the selected layer' : 'Pin all layers'}>
        {ANCHORS.map((a) => (
          <button key={a.id} className="btn sm" disabled={!pinIds.length} title={`${a.label}${selOn ? '' : ' (all layers as a group; select one to pin just that)'}`} onClick={() => onArrange((c) => pinLayers(c, surface, pinIds, a, dimsOf, margin))}>
            {a.glyph}
          </button>
        ))}
      </div>
      <div className="sl-layouts">
        <span className="seg" role="group" aria-label="Lay out every layer">
          {LAYOUTS.map((l) => (
            <button key={l.id} className="btn sm" disabled={!visible.length} title={l.hint} onClick={() => onArrange((c) => layoutLayers(c, surface, visible.map((b) => b.id), l.id as LayoutKind, dimsOf, margin, margin * 0.75))}>
              {l.label}
            </button>
          ))}
        </span>
        <label className="field-row sl-margin" title="Space kept round the edge and between layers">
          <span>Margin</span>
          <input type="range" min={0} max={0.15} step={0.005} value={margin} onChange={(e) => setMargin(Number(e.target.value))} aria-label="Margin" />
          <span className="mono">{Math.round(margin * 100)}%</span>
        </label>
      </div>
    </div>
  );
}

/** One surface's layers on its card: the arranging stage, pins and layouts, and the layer list. */
export function SurfaceLayers({ live, surface }: { live: LiveLayers; surface: Surface }) {
  const { comp, sourceOf, sel, setSel, begin, change, setBlock } = live;
  const preview = useMemo(() => {
    const { w, h } = frameSize(comp.frames[surface], 360);
    return composite(comp, surface, sourceOf, w, h);
  }, [comp, surface, sourceOf]);
  const on = comp.blocks.filter((b) => b.surface === surface);
  const selected = on.find((b) => b.id === sel) ?? null;
  const edit = (id: string, p: Partial<Block>) => change((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === id ? { ...b, ...p } : b)) }));
  return (
    <div className="sl">
      <ArrangeStage
        compact
        comp={comp}
        surface={surface}
        sourceOf={sourceOf}
        preview={preview}
        sel={sel}
        onSelect={setSel}
        onChange={setBlock}
        onBegin={begin}
        onDropBlock={(id, x, y) => {
          change((c) => {
            const m = moveBlock(c, id, surface);
            return { ...m, blocks: m.blocks.map((b) => (b.id === id ? { ...b, x, y } : b)) };
          });
          setSel(id);
        }}
        empty="No layers here. Add images, or drag a layer here from another surface."
      />
      <ArrangeBar comp={comp} surface={surface} sel={sel} dimsOf={live.dimsOf} onArrange={change} />
      <div className="cm-list sl-list" aria-label={`Layers on the ${SURFACE_INFO[surface].short.toLowerCase()}`}>
        {[...on].reverse().map((b) => (
          <div
            key={b.id}
            className={`cm-item ${b.id === sel ? 'on' : ''}`}
            onClick={() => setSel(b.id)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/x-block', b.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            title="Drag onto another surface's picture to move it there"
          >
            <Thumb g={sourceOf(b)} />
            <span className="cm-name">{b.name}</span>
            <button className="btn sm" title={b.hidden ? 'Show' : 'Hide'} onClick={(e) => (e.stopPropagation(), edit(b.id, { hidden: !b.hidden }))}>
              {b.hidden ? '○' : '●'}
            </button>
            <button className="btn sm" title="Bring forward" onClick={(e) => (e.stopPropagation(), change((c) => restack(c, b.id, 1)))}>
              ↑
            </button>
            <button className="btn sm" title="Send backward" onClick={(e) => (e.stopPropagation(), change((c) => restack(c, b.id, -1)))}>
              ↓
            </button>
            <button
              className="btn sm"
              title="Remove this layer"
              onClick={(e) => {
                e.stopPropagation();
                change((c) => ({ ...c, blocks: c.blocks.filter((x) => x.id !== b.id) }));
                if (sel === b.id) setSel(null);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      {selected && (
        <div className="sl-sel">
          <label className="field-row pm-row">
            <span>Size</span>
            <input type="range" min={0.02} max={2} step={0.01} value={selected.scale} onPointerDown={begin} onChange={(e) => setBlock(selected.id, { scale: Number(e.target.value) })} aria-label="Size" />
            <span className="mono">{selected.scale.toFixed(2)}</span>
          </label>
          <label className="field-row pm-row">
            <span>Turn</span>
            <input type="range" min={-180} max={180} step={1} value={selected.rotate} onPointerDown={begin} onChange={(e) => setBlock(selected.id, { rotate: Number(e.target.value) })} aria-label="Turn" />
            <span className="mono">{Math.round(selected.rotate)}°</span>
          </label>
          <label className="field-row pm-row">
            <span>Strength</span>
            <input type="range" min={0} max={1} step={0.01} value={selected.opacity} onPointerDown={begin} onChange={(e) => setBlock(selected.id, { opacity: Number(e.target.value) })} aria-label="Strength" />
            <span className="mono">{selected.opacity.toFixed(2)}</span>
          </label>
          <div className="field-row pm-row">
            <span>Blend</span>
            <select value={selected.blend} onChange={(e) => edit(selected.id, { blend: e.target.value as BlendMode })} aria-label="Blend">
              {BLENDS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <label style={{ marginLeft: 8 }}>
              <input type="checkbox" className="chk" checked={selected.invert} onChange={(e) => edit(selected.id, { invert: e.target.checked })} /> Invert
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

/** Every layer as a node, wired into the surface it sits on. */
export function LayerNodes({ live, onOpenSurface }: { live: LiveLayers; onOpenSurface: (s: Surface) => void }) {
  return (
    <div className="sl-nodes">
      <NodeView
        comp={live.comp}
        sourceOf={live.sourceOf}
        sel={live.sel}
        onSelect={live.setSel}
        onBegin={live.begin}
        onChange={live.setBlock}
        onWire={(id, s) => live.change((c) => moveBlock(c, id, s))}
        onOpenSurface={onOpenSurface}
      />
    </div>
  );
}
