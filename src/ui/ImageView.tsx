import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import type { Gray } from '../core/image';
import type { Snap } from '../state/store';
import { sampleCliff } from './sample';
import { PATTERN_PRESETS, type PatternSpec } from '../core/pattern';
import { grayDataUrl, readImage, topAspectGuess } from './surfaces';
import { DEFAULT_SOUND, type SoundSpec } from '../core/sound';
import type { Composition, Surface } from '../core/compose';
import { moveBlock } from '../core/compose';
import { isLayered, LayerNodes, SurfaceLayers, useLiveLayers } from './SurfaceLayers';
import { DEPTH_URL, defaultDepthSettings, depthFromPhoto, depthToGray, invertDataUrl, sampleDepthMetres, wakeDepth } from '../core/depth';
import { isMapDepthFace } from '../core/depthFlat';
import { exifFocalFromDataUrl } from '../core/exifFocal';
import { Tab as TabItem } from './Tab';

function GrayCanvas({ g, picking, onPick }: { g: Gray | null; picking?: boolean; onPick?: (u: number, v: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !g) return;
    cv.width = g.w;
    cv.height = g.h;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(g.w, g.h);
    for (let i = 0; i < g.w * g.h; i++) {
      const c = g.data[i] * 255;
      img.data[i * 4] = c;
      img.data[i * 4 + 1] = c;
      img.data[i * 4 + 2] = c;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [g]);
  if (!g) return <div className="empty" style={{ padding: 30 }}>No image</div>;
  return (
    <canvas
      ref={ref}
      className="thumb"
      data-testid={picking ? 'depth-preview-pick' : 'depth-preview'}
      title={picking ? 'Click to pick a flat level' : undefined}
      onClick={
        onPick
          ? (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const u = (e.clientX - r.left) / Math.max(1e-6, r.width);
              const v = (e.clientY - r.top) / Math.max(1e-6, r.height);
              onPick(Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
            }
          : undefined
      }
      style={{ aspectRatio: `${g.w} / ${g.h}`, maxHeight: 260, objectFit: 'contain', cursor: picking ? 'crosshair' : undefined }}
    />
  );
}

const ReliefPreview = lazy(() => import('./ReliefPreview'));
// the tools load when first opened; hovering their button starts the fetch
const loadComposer = () => import('./ComposerModal');
const loadPattern = () => import('./PatternModal');
const loadSound = () => import('./SoundModal');
const ComposerModal = lazy(loadComposer);
const PatternModal = lazy(loadPattern);
const SoundModal = lazy(loadSound);
const DepthControls = lazy(() => import('./DepthControls'));
const AutoDimensionControls = lazy(() => import('./AutoDimensionControls'));
const preload = (load: () => Promise<unknown>) => () => {
  load().catch(() => {});
};
const modalFallback = (
  <div className="pm-back">
    <div className="empty">Loading…</div>
  </div>
);

type Slot = 'top' | 'side' | 'front';

export default function ImageView() {
  const model = useModel();
  const project = useStore((s) => s.project);
  const setAsset = useStore((s) => s.setAsset);
  const setDepthSettings = useStore((s) => s.setDepthSettings);
  const setParams = useStore((s) => s.setParams);
  const setUi = useStore((s) => s.setUi);
  const ui = useStore((s) => s.ui);
  const v = model.v;
  // Image = an uploaded picture; Graphic = a pattern made here. Both end up as the same greyscale input.
  // Composer = several blocks placed freely on the surface (and moved between surfaces).
  const [source, setSource] = useState<Partial<Record<Slot, 'image' | 'graphic' | 'sound' | 'compose'>>>({});
  const [editing, setEditing] = useState<Slot | null>(null);
  const [hearing, setHearing] = useState<Slot | null>(null);
  const [composing, setComposing] = useState<{ comp: Composition; surface: Surface } | null>(null);
  // every surface can hold any number of layers, arranged on its card or wired up on the node board
  const live = useLiveLayers(topAspectGuess(v));
  const [board, setBoard] = useState<'cards' | 'nodes'>('cards');
  const openComposer = async (surface: Surface) => {
    const { seedComposition } = await loadComposer();
    setComposing({ comp: await seedComposition(useStore.getState().project, topAspectGuess(v)), surface });
  };
  // the depth service takes ~45 s to boot cold: start it now, while a photo is being chosen
  useEffect(() => {
    if (DEPTH_URL) wakeDepth(DEPTH_URL);
  }, []);
  const sourceOf = (slot: Slot) => source[slot] ?? (project.images[slot]?.composed ? 'compose' : project.images[slot]?.pattern ? 'graphic' : project.images[slot]?.sound ? 'sound' : 'image');
  const [depthBusy, setDepthBusy] = useState<Slot | null>(null);
  const [depthError, setDepthError] = useState<{ slot: Slot; msg: string } | null>(null);
  const loadDepth = async (slot: Slot, enable: Record<string, string>) => {
    const photo = await readImage(1536);
    if (!photo) return;
    setDepthBusy(slot);
    setDepthError(null);
    try {
      const { png, depth } = await depthFromPhoto(photo.dataUrl);
      const name = `depth · ${photo.name}`;
      if (depth) {
        // keep the real depth so near / far / curve can be changed here; side profile reads bright as high
        const exifFocal = exifFocalFromDataUrl(photo.dataUrl, depth.w);
        const d = {
          ...depth,
          ...(exifFocal ? { exifFocalLengthPx: exifFocal } : {}),
          settings: defaultDepthSettings(depth, slot === 'side'),
        };
        setAsset('image', slot, { name, dataUrl: grayDataUrl(depthToGray(d)), depth: d });
      } else {
        // older service: only the finished grey picture
        setAsset('image', slot, { name, dataUrl: slot === 'side' ? await invertDataUrl(png) : png });
      }
      // near parts of the photo stand proud on the top surface rather than sinking
      open(slot === 'top' ? { ...enable, imgTopMode: 'raise' } : enable);
    } catch (e) {
      setDepthError({ slot, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setDepthBusy(null);
    }
  };
  const slots: { slot: Slot; title: string; g: Gray | null; desc: string; enable: Record<string, string>; off: Record<string, string>; snap: Snap }[] = [
    {
      slot: 'top',
      title: 'Top surface image',
      g: model.topImg,
      desc:
        v.sliceMode === 'flat'
          ? 'Pressed down into the flat stack like a stamp: each layer is cut away where the image is darker than its depth, so dark areas run through more layers.'
          : "Looking down on the stack: each plate's top edge is cut down where its strip of the image is dark, so the image reads as an impression across the whole top surface.",
      enable: { imgTopMode: 'carve' },
      off: { imgTopMode: 'off' },
      snap: 'top',
    },
    {
      slot: 'front',
      title: 'Front face image',
      g: model.frontImg,
      desc: 'On the end face of the stack: layered cut-outs get deeper where the image is dark (or halftone holes grow), with etched lines lining up plate to plate.',
      enable: { imgFrontMode: 'layers', sliceMode: 'parallel' },
      off: { imgFrontMode: 'off' },
      snap: 'front',
    },
    {
      slot: 'side',
      title: 'Side profile image',
      g: model.sideImg,
      desc: 'Each plate takes one strip of this image as its overall top-edge height (or the traced silhouette), blended with the eroded strata.',
      enable: { imgSideMode: 'heightmap', stackSource: 'strata' },
      off: { imgSideMode: 'off' },
      snap: 'side',
    },
  ];
  const open = (patch: Record<string, string>) => {
    setParams(patch, 'img');
    setUi({ collapsed: { ...ui.collapsed, Image: false } });
  };
  // "Fit face to image": the option for each surface, null where it can't apply
  const fitFor = (slot: Slot): { id: string; on: string; title: string } | null => {
    if (v.sliceMode === 'radial') return null;
    if (slot === 'top') return { id: 'imgFit', on: 'width', title: "Keeps the base length and sets its width so the top has this image's proportions" };
    if (slot === 'front') return v.sliceMode === 'parallel' ? { id: 'imgFrontFit', on: 'width', title: "Keeps the plate height and sets the base width so the front face has this image's proportions" } : null;
    return v.stackSource === 'strata'
      ? { id: 'imgSideFit', on: 'length', title: "Keeps the base width and sets its length (and the plate count, at the same gap) so the side image isn't stretched" }
      : null;
  };
  const toggleFit = (slot: Slot) => {
    const f = fitFor(slot)!;
    if (v[f.id] !== 'off') return setParams({ [f.id]: 'off' }, 'Fit face to image off');
    const patch: Record<string, string> = { [f.id]: f.on };
    // when the stack run changes, keep the plate thickness and gap so the plate count follows the new length
    const runChanges = slot === 'side' && v.imgSideMode !== 'silhouette';
    if (runChanges && v.spacingMode === 'fit') {
      patch.spacingMode = 'gap';
      patch.plateGap = String(Math.max(0.5, Math.round((v.pitch - v.thickness) * 2) / 2));
    }
    setParams(patch, 'Fit face to image');
  };
  const topRes = v.sliceMode === 'radial' ? null : v.pitch;
  // kept in the store so the view survives switching tabs
  const tilt = ui.reliefTilt;
  const tint = ui.reliefTint;
  const setTilt = (t: number) => setUi({ reliefTilt: t });
  const setTint = (t: boolean) => setUi({ reliefTint: t });
  return (
    <div className="scroll">
      <div className="pad" style={{ display: 'grid', gap: 12 }}>
        <div className="sl-bar">
          <menu role="tablist" aria-label="Surfaces view">
            <TabItem selected={board === 'cards'} onSelect={() => setBoard('cards')} title="One card per surface, its layers arranged on it">
              Cards
            </TabItem>
            <TabItem selected={board === 'nodes'} onSelect={() => setBoard('nodes')} title="Every layer as a node, wired into a surface">
              Layer nodes
            </TabItem>
          </menu>
          <span className="note">
            {board === 'nodes'
              ? 'Drag a layer\'s dot onto Top, Front or Side to send it there, or onto Tray to set it aside. Double-click a surface to arrange it.'
              : 'Each surface can hold any number of images: Add images…, then drag, pin or lay them out. Dark cuts deepest.'}
          </span>
        </div>
        {board === 'nodes' ? (
          <LayerNodes live={live} onOpenSurface={() => setBoard('cards')} />
        ) : (
        <div className="img-face-grid">
          {slots.map((s) => {
            const asset = project.images[s.slot];
            const other = s.slot === 'top' ? project.images.front ?? project.images.side : null;
            return (
              <div
                className="window box"
                key={s.slot}
                data-testid={`face-card-${s.slot}`}
                onDragOver={(e) => e.dataTransfer.types.includes('text/x-block') && e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData('text/x-block');
                  if (!id) return;
                  e.preventDefault();
                  live.change((c) => moveBlock(c, id, s.slot));
                }}
              >
                <div className="title-bar box-head">
                  <span>{s.title}</span>
                  <span className="mono" style={{ fontWeight: 400, textTransform: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                    {asset ? asset.name : 'empty'}
                  </span>
                </div>
                {isLayered(live, s.slot) ? (
                  <SurfaceLayers live={live} surface={s.slot} />
                ) : (
                  <GrayCanvas
                    g={s.g}
                    picking={!!asset?.depth && !isMapDepthFace(asset.depth) && asset.depth.settings.flatLevelMode === 'eyedropper'}
                    onPick={
                      asset?.depth && !isMapDepthFace(asset.depth) && asset.depth.settings.flatLevelMode === 'eyedropper'
                        ? (u, v) => {
                            const m = sampleDepthMetres(asset.depth!, u, v);
                            if (m == null) return;
                            const next = { ...asset.depth!, settings: { ...asset.depth!.settings, flatLevel: m, flatLevelMode: 'eyedropper' as const, flatLevelOverride: true } };
                            setDepthSettings(s.slot, { flatLevel: m, flatLevelMode: 'eyedropper', flatLevelOverride: true }, grayDataUrl(depthToGray(next)));
                          }
                        : undefined
                    }
                  />
                )}
                <div className="note">{s.desc}</div>
                <div className="btnrow" style={{ paddingBottom: 0 }}>
                  <span className="seg" role="group" aria-label={`${s.title} source`}>
                    <button className={`btn sm ${sourceOf(s.slot) === 'image' ? 'on' : ''}`} onClick={() => setSource({ ...source, [s.slot]: 'image' })}>
                      Image
                    </button>
                    <button className={`btn sm ${sourceOf(s.slot) === 'graphic' ? 'on' : ''}`} onClick={() => setSource({ ...source, [s.slot]: 'graphic' })}>
                      Graphic
                    </button>
                    <button className={`btn sm ${sourceOf(s.slot) === 'sound' ? 'on' : ''}`} onClick={() => setSource({ ...source, [s.slot]: 'sound' })} title="A tone, chord or recording drawn as a picture">
                      Sound
                    </button>
                    <button className={`btn sm ${sourceOf(s.slot) === 'compose' ? 'on' : ''}`} onClick={() => setSource({ ...source, [s.slot]: 'compose' })} title="Several images, patterns and drawings placed freely">
                      Composer
                    </button>
                  </span>
                  <button className="btn sm" onClick={() => live.addImages(s.slot)} title="Add one or more pictures to this surface as layers you can move, pin and lay out">
                    Add images…
                  </button>
                </div>
                {asset?.depth && sourceOf(s.slot) === 'image' && (
                  <Suspense fallback={null}>
                    <DepthControls slot={s.slot} depth={asset.depth} />
                    <AutoDimensionControls slot={s.slot} depth={asset.depth} />
                  </Suspense>
                )}
                {depthError?.slot === s.slot && <div className="note" style={{ color: 'var(--err)' }}>Depth from photo failed: {depthError.msg}</div>}
                <div className="btnrow">
                  {sourceOf(s.slot) === 'compose' ? (
                    <button className="btn default" onClick={() => openComposer(s.slot)} onPointerEnter={preload(loadComposer)}>
                      {project.composition?.blocks.some((b) => b.surface === s.slot) ? 'Edit composition…' : 'Open composer…'}
                    </button>
                  ) : sourceOf(s.slot) === 'sound' ? (
                    <button className="btn default" onClick={() => setHearing(s.slot)} onPointerEnter={preload(loadSound)}>
                      {asset?.sound ? 'Edit sound…' : 'Make from sound…'}
                    </button>
                  ) : sourceOf(s.slot) === 'graphic' ? (
                    <button className="btn default" onClick={() => setEditing(s.slot)} onPointerEnter={preload(loadPattern)}>
                      {asset?.pattern ? 'Edit pattern…' : 'Make pattern…'}
                    </button>
                  ) : (
                  <>
                  <button
                    className="btn"
                    onClick={async () => {
                      const img = await readImage();
                      if (!img) return;
                      setAsset('image', s.slot, img);
                      open(s.enable);
                    }}
                  >
                    Load image…
                  </button>
                  <button
                    className="btn"
                    disabled={!DEPTH_URL || depthBusy !== null}
                    title={
                      DEPTH_URL
                        ? 'Pick a photo: Depth Pro turns it into a relief (near = proud), background left uncut'
                        : 'Depth service not configured (set VITE_DEPTH_URL)'
                    }
                    onClick={() => loadDepth(s.slot, s.enable)}
                  >
                    {depthBusy === s.slot ? 'Reading depth…' : 'Depth from photo…'}
                  </button>
                  {other && !asset && (
                    <button
                      className="btn default"
                      onClick={() => {
                        setAsset('image', 'top', other);
                        open(s.enable);
                      }}
                    >
                      Use {project.images.front ? 'front' : 'side'} image
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={() => {
                      setAsset('image', s.slot, { name: 'sample-cliff.png', dataUrl: sampleCliff(Math.round(v.seed)) });
                      open(s.enable);
                    }}
                  >
                    Sample
                  </button>
                  </>
                  )}
                  {asset && (
                    <button
                      className="btn"
                      onClick={() => {
                        setAsset('image', s.slot, null);
                        setParams(s.off, 'img-off');
                      }}
                    >
                      Remove
                    </button>
                  )}
                  <button className="btn" onClick={() => setUi({ tab: '3d', snap: { dir: s.snap, n: Date.now() } })}>
                    View {s.snap}
                  </button>
                  {asset && fitFor(s.slot) && (
                    <button
                      className={`btn ${v[fitFor(s.slot)!.id] !== 'off' ? 'on' : ''}`}
                      title={fitFor(s.slot)!.title}
                      onClick={() => toggleFit(s.slot)}
                    >
                      Fit face to image
                    </button>
                  )}
                </div>
                {asset && fitFor(s.slot) && v[fitFor(s.slot)!.id] !== 'off' && (
                  <div className="note" style={{ paddingTop: 0 }}>
                    Fitted: base {fmt(v.baseLength, 0)} × {fmt(v.baseWidth, 0)} mm, plates {fmt(v.stackHeight, 0)} mm high, {v.plateCount} plates
                    {s.slot === 'side' && v.imgSideMode === 'silhouette' ? `, outline ${fmt(v.imgRange, 0)} mm tall` : ''}. Options under Parameters › Image.
                  </div>
                )}
              </div>
            );
          })}
        </div>
        )}
        <div className="window box">
          <div className="title-bar box-head" style={{ flexWrap: 'wrap' }}>
            <span>Relief preview</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
              <label htmlFor="relief-tilt" className="mono">
                Tilt
              </label>
              <input
                id="relief-tilt"
                type="range"
                min={0}
                max={75}
                step={1}
                value={tilt}
                onChange={(e) => setTilt(Number(e.target.value))}
                style={{ width: 160, accentColor: 'var(--accent)' }}
                aria-label="Tilt the relief preview"
              />
              <span className="mono" style={{ width: 30, textAlign: 'right' }}>
                {tilt}°
              </span>
              <span className="seg">
                <button className="btn sm" onClick={() => setTilt(0)} title="Straight down">
                  Top
                </button>
                <button className="btn sm" onClick={() => setTilt(55)} title="Low raking view">
                  Low
                </button>
                <button className={`btn sm ${tint ? 'on' : ''}`} onClick={() => setTint(!tint)} title="Darken by depth so the impression reads from any angle">
                  Depth colour
                </button>
              </span>
              <button className="btn sm default" onClick={() => useStore.getState().shuffleGentle()} title="Shuffle a soft, shallow, flowing impression (locked values stay)">
                Shuffle gentle
              </button>
            </span>
          </div>
          <div style={{ position: 'relative', height: 'min(56vh, 460px)', background: 'var(--viewport)', borderBottom: '1px solid var(--line)' }}>
            <Suspense fallback={<div className="empty">Loading preview…</div>}>
              <ReliefPreview model={model} tilt={tilt} tint={tint} />
            </Suspense>
          </div>
          <div className="note">
            {v.imgTopMode !== 'off' && model.topImg ? (
              <>
                Top impression: {v.imgTopMode === 'carve' ? 'dark areas sink' : 'dark areas stand proud'} up to {fmt(v.topDepth, 0)} mm in {v.topSteps > 0 ? `${v.topSteps} steps` : 'a smooth slope'}.
                {v.sliceMode === 'flat' ? (
                  <>Flat stack: the picture is pressed down through the layers, one {fmt(v.thickness, 1)} mm layer per depth step, so {Math.floor(v.topDepth / v.thickness)} layers carry the deepest areas. Thinner plates give finer depth steps.</>
                ) : (
                  <>Resolution is one plate per image row{topRes ? ` (${fmt(topRes, 1)} mm pitch)` : ''} by {fmt(Math.min(1, v.sampleStep), 1)} mm along each plate: more, thinner plates give a sharper picture.</>
                )}
                Size, position, depth and threshold are under Parameters › Image.
                {v.stackSource === 'strata' && v.erosionAmp > v.topDepth && (
                  <span style={{ color: 'var(--warn)' }}>
                    {' '}
                    Erosion ({fmt(v.erosionAmp, 0)} mm) is stronger than the impression ({fmt(v.topDepth, 0)} mm): lower Strata › Erosion amplitude or deepen the impression if the picture gets lost.
                  </span>
                )}
              </>
            ) : (
              <>Load an image into the top surface slot to press it into the plate tops. Every image-derived edge still goes through the same arc fitting, minimum-feature, kerf and fit checks.</>
            )}
          </div>
        </div>
      </div>
      <Suspense fallback={modalFallback}>
      {composing && <ComposerModal initial={composing.comp} initialSurface={composing.surface} stackAspect={topAspectGuess(v)} onClose={() => setComposing(null)} />}
      {hearing && (
        <SoundModal
          title={`${slots.find((x) => x.slot === hearing)!.title}: sound`}
          initial={project.images[hearing]?.sound ?? { ...DEFAULT_SOUND, drawn: hearing !== 'side', view: hearing === 'top' ? 'spectrum' : 'bars', aspect: hearing === 'top' ? topAspectGuess(v) : DEFAULT_SOUND.aspect }}
          onClose={() => setHearing(null)}
          onApply={(spec: SoundSpec, dataUrl: string) => {
            const slot = slots.find((x) => x.slot === hearing)!;
            setAsset('image', hearing, { name: spec.source === 'file' && spec.fileName ? `${spec.fileName}.png` : 'sound.png', dataUrl, sound: spec });
            open(slot.enable);
            setHearing(null);
          }}
        />
      )}
      {editing && (
        <PatternModal
          title={`${slots.find((x) => x.slot === editing)!.title}: pattern`}
          initial={project.images[editing]?.pattern ?? (editing === 'top' ? { ...PATTERN_PRESETS[2].spec(), aspect: topAspectGuess(v) } : PATTERN_PRESETS[2].spec())}
          onClose={() => setEditing(null)}
          onApply={async (spec: PatternSpec) => {
            const slot = slots.find((x) => x.slot === editing)!;
            const { patternDataUrl } = await loadPattern();
            setAsset('image', editing, { name: 'pattern.png', dataUrl: patternDataUrl(spec), pattern: spec });
            open(slot.enable);
            setEditing(null);
          }}
        />
      )}
      </Suspense>
    </div>
  );
}
