// Impress image: press a picture into the top surface or the front face by hand.
// Pick a picture, click the surface to drop it there, drag it about, pull a corner
// to size it, the round handle to turn it and the arrow (or the Depth slider) to
// set how deep it cuts. X-ray turns the plates see-through and shows the floor of
// every cut inside them. Pictures are ordinary layers on the surface (useLiveLayers),
// so the slicer, build pack, price and saved projects see the image they always did.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Line, OrbitControls, PerspectiveCamera } from '@react-three/drei';
import { composite, frameSize, makeBlock, type Block, type BlockSource } from '../core/compose';
import type { Gray } from '../core/image';
import type { Values } from '../core/params';
import type { V3 } from '../core/section';
import { stackFrame } from '../core/heightfield';
import {
  blockAt,
  blockCorners,
  depthCap,
  depthField,
  enablePatch,
  fillPatch,
  frameFractions,
  framePoint,
  frontPlates,
  impressFrames,
  IMPRESS_SURFACES,
  layerDepth,
  maxDepth,
  refitBlocks,
  reliefMesh,
  setLayerDepth,
  type ImpressFrame,
  type ImpressSurface,
  type SurfaceFrames,
} from '../core/impress';
import { useStore } from '../state/store';
import { useModel, fmt } from './model';
import Scene, { cssVar, modelBounds } from './Scene';
import { DEFAULT_VIEWPORT_LAYERS } from './viewportLayers';
import { useLiveLayers, type LiveLayers } from './SurfaceLayers';
import { loadImageGray, sourceGray } from './blockSources';
import { grayDataUrl, readImages, topAspectGuess } from './surfaces';
import { DEPTH_URL, defaultDepthSettings, depthFromPhoto, depthToGray, depthWaitEstimate, wakeDepth } from '../core/depth';
import { beginBusy, depthStep } from './busy';

const NAMES: Record<ImpressSurface, string> = { top: 'Top surface', front: 'Front face' };
type Hover = { s: ImpressSurface; fx: number; fy: number } | null;
type Armed = { source: BlockSource; name: string; w: number; h: number } | null;

/** The frame the surface's layers are measured in now: its picture's window, or the whole surface before it has one. */
const liveFrame = (f: SurfaceFrames) => f.window ?? f.area;
/** True when the picture does not yet cover the whole surface (placing by hand widens it first). */
function needsFit(f: SurfaceFrames): boolean {
  const w = f.window;
  if (!w) return true;
  const a = f.area;
  const d = (p: V3, q: V3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  // the picture is a whole number of pixels, so its window can miss the surface by a fraction of one
  const tol = Math.max(1, 0.01 * Math.max(a.w, a.h));
  return Math.abs(w.w - a.w) > tol || Math.abs(w.h - a.h) > tol || d(w.origin, a.origin) > tol || d(w.ax, a.ax) > 1e-3;
}

const v3 = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);

export default function ImpressView() {
  const model = useModel();
  const v = model.v;
  const live = useLiveLayers(topAspectGuess(v));
  const lift = model.sunkenFrame?.plateLiftMm ?? 0;
  const frames = useMemo(() => impressFrames(model.sliced, v, lift), [model.sliced, v, lift]);
  const available = IMPRESS_SURFACES.filter((s) => frames[s]);
  const [surface, setSurface] = useState<ImpressSurface>('top');
  const s: ImpressSurface = frames[surface] ? surface : (available[0] ?? 'top');
  const [xray, setXray] = useState(true);
  const [armed, setArmed] = useState<Armed>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [look, setLook] = useState(0);
  // settings a drag has changed but not yet committed (a layer pulled deeper than the rest)
  const vLive = useMemo(() => ({ ...v, ...(live.draftPatch ?? {}) }) as Values, [v, live.draftPatch]);
  const sel = live.sel ? live.comp.blocks.find((b) => b.id === live.sel && b.surface && (IMPRESS_SURFACES as string[]).includes(b.surface)) : undefined;

  useEffect(() => {
    if (sel?.surface && sel.surface !== s) setSurface(sel.surface as ImpressSurface);
  }, [sel?.surface]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Press the armed picture in at frame fractions of the whole surface. */
  const drop = useCallback(
    async (at: { s: ImpressSurface; fx: number; fy: number }) => {
      const f = frames[at.s];
      if (!armed || !f) return;
      const base = live.comp;
      // the surface's picture covers the whole surface from now on, so the frame is the surface
      const fitted = refitBlocks(base, at.s, liveFrame(f), f.area);
      const sa = armed.w / armed.h;
      const wmm = Math.min(f.area.w * 0.4, f.area.h * 0.4 * sa);
      const b = makeBlock(armed.source, { surface: at.s, x: at.fx, y: at.fy, scale: +(wmm / f.area.w).toFixed(4), blend: 'darken' });
      const patch = { ...fillPatch(at.s, v), ...enablePatch(at.s, v) };
      await live.commit(base, { ...fitted, blocks: [...fitted.blocks, b] }, patch);
      live.setSel(b.id);
      setSurface(at.s);
      setArmed(null);
    },
    [armed, frames, live, v],
  );

  const arm = useCallback(async (source: BlockSource, name: string) => {
    const g = source.kind === 'image' ? await loadImageGray(source.dataUrl) : sourceGray(source);
    setArmed({ source, name, w: g?.w ?? 1, h: g?.h ?? 1 });
  }, []);

  const pick = async () => {
    const imgs = await readImages();
    if (imgs[0]) await arm({ kind: 'image', ...imgs[0] }, imgs[0].name);
  };

  // keys: Delete removes the picked picture, Esc puts the picture down / drops the pick
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'Escape') {
        if (armed) setArmed(null);
        else live.setSel(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        live.change((c) => ({ ...c, blocks: c.blocks.filter((b) => b.id !== sel.id) }));
        live.setSel(null);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, sel, live]);

  const opts = useMemo(
    () => ({ selected: null, showMoulds: false, explode: false, xray: false, showIssues: false, showSource: false, viewportLayers: DEFAULT_VIEWPORT_LAYERS, ghost: xray }),
    [xray],
  );

  return (
    <div className="impress-view" data-testid="impress-view">
      <Canvas shadows="percentage" dpr={[1, 2]} gl={{ antialias: true }} style={{ position: 'absolute', inset: 0 }} onCreated={({ gl }) => gl.setClearColor(cssVar('--viewport', '#e6e3dc'), 1)}>
        <PerspectiveCamera makeDefault fov={32} near={1} far={60000} position={[1500, 1100, 1800]} />
        <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
        <LookAt surface={s} frame={frames[s]?.area ?? null} n={look} />
        <Scene model={model} opts={opts} />
        {IMPRESS_SURFACES.map((k) => {
          const f = frames[k];
          if (!f) return null;
          return (
            <SurfaceLayer
              key={k}
              s={k}
              f={f}
              active={k === s}
              live={live}
              v={vLive}
              xray={xray}
              armed={armed}
              hover={hover?.s === k ? hover : null}
              onHover={setHover}
              onDrop={drop}
              onPick={(id) => {
                setSurface(k);
                live.setSel(id);
              }}
            />
          );
        })}
      </Canvas>
      <ImpressPanel
        s={s}
        setSurface={(k) => {
          setSurface(k);
          setLook((n) => n + 1);
        }}
        available={available}
        frames={frames}
        live={live}
        v={vLive}
        sel={sel}
        armed={armed}
        setArmed={setArmed}
        arm={arm}
        pick={pick}
        xray={xray}
        setXray={setXray}
        look={() => setLook((n) => n + 1)}
        plateCount={model.sliced.plates.filter((p) => p.def.family === 'P').length}
      />
    </div>
  );
}

/** Frame the camera on a surface: from above and in front for the top, square on for the front face. */
function LookAt({ surface, frame, n }: { surface: ImpressSurface; frame: ImpressFrame | null; n: number }) {
  const model = useModel();
  const { camera, controls, size: px } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls?: { target: THREE.Vector3; update: () => void }; size: { width: number; height: number } };
  useEffect(() => {
    if (!controls) return;
    const mb = modelBounds(model);
    const f = stackFrame(model.v);
    const toFront = new THREE.Vector3(-f.stack[0], 0, -f.stack[1]);
    const dir = surface === 'top' ? toFront.clone().multiplyScalar(0.45).add(new THREE.Vector3(0, 1, 0)).normalize() : toFront.clone().add(new THREE.Vector3(0.12, 0.22, 0.08)).normalize();
    // fit the surface (with room for the tool window on the left), else the whole piece
    const center = frame ? v3(framePoint(frame, 0.5, 0.5)) : mb.center;
    const aspect = px.width / Math.max(1, px.height);
    const span = frame ? Math.max(frame.h, frame.w / Math.max(0.5, aspect * 0.7)) * 1.25 : mb.size * 0.85;
    const dist = span / 2 / Math.tan((16 * Math.PI) / 180);
    camera.up.set(0, 1, 0);
    camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
    controls.target.copy(center);
    camera.updateProjectionMatrix();
    controls.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, surface, controls, camera, !!frame]);
  return null;
}

/** A flat quad over a frame with picture coordinates as its uv (u right, v down). */
function quadGeometry(f: ImpressFrame, fx0 = 0, fy0 = 0, fx1 = 1, fy1 = 1): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pts = [framePoint(f, fx0, fy0), framePoint(f, fx1, fy0), framePoint(f, fx0, fy1), framePoint(f, fx1, fy1)];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  g.setIndex([0, 2, 1, 1, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/** One surface: the click target, its pictures pressed on it, the x-ray relief and (when active) the gizmo. */
function SurfaceLayer(props: {
  s: ImpressSurface;
  f: SurfaceFrames;
  active: boolean;
  live: LiveLayers;
  v: Values;
  xray: boolean;
  armed: Armed;
  hover: Hover;
  onHover: (h: Hover) => void;
  onDrop: (at: { s: ImpressSurface; fx: number; fy: number }) => void;
  onPick: (id: string | null) => void;
}) {
  const { s, f, active, live, v, xray, armed, hover, onHover, onDrop, onPick } = props;
  const F = liveFrame(f);
  const comp = live.comp;
  const has = comp.blocks.some((b) => b.surface === s && !b.hidden);
  const accent = cssVar('--accent', '#d4521c');
  // the surface's picture as the slicer will read it (before contrast and blur)
  const gray = useMemo(() => {
    if (!has) return null;
    const { w, h } = frameSize(comp.frames[s], 256);
    return composite(comp, s, (b) => live.sourceOf(b), w, h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comp, s, has, live.sourceOf]);
  const target = useMemo(() => quadGeometry(f.area, -0.02, -0.02, 1.02, 1.02), [f.area]);
  useEffect(() => () => target.dispose(), [target]);
  const pickAt = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    const p = e.point;
    return frameFractions(f.area, [p.x, p.y, p.z]);
  };
  const outline = useMemo(() => [framePoint(f.area, 0, 0), framePoint(f.area, 1, 0), framePoint(f.area, 1, 1), framePoint(f.area, 0, 1), framePoint(f.area, 0, 0)], [f.area]);
  return (
    <group>
      {/* click target: the whole surface */}
      <mesh
        geometry={target}
        renderOrder={2}
        onPointerMove={(e) => {
          if (!armed) return;
          e.stopPropagation();
          const [fx, fy] = pickAt(e);
          onHover({ s, fx, fy });
        }}
        onPointerOut={() => onHover(null)}
        onClick={(e) => {
          if (e.delta > 4) return;
          e.stopPropagation();
          const [fx, fy] = pickAt(e);
          if (armed) return onDrop({ s, fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) });
          const p = e.point;
          const [lx, ly] = frameFractions(F, [p.x, p.y, p.z]);
          onPick(blockAt(comp, s, lx, ly, live.dimsOf, F)?.id ?? null);
        }}
      >
        <meshBasicMaterial color={accent} transparent opacity={armed ? 0.1 : 0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Line points={outline} color={active ? accent : '#6d6a64'} lineWidth={active ? 2 : 1} dashed dashSize={6} gapSize={4} depthTest={false} transparent renderOrder={12} />
      {gray && <Pressed f={F} gray={gray} xray={xray} />}
      {gray && xray && <Relief s={s} f={F} gray={gray} v={v} dim={!active} />}
      {armed && hover && <DropGhost f={f.area} armed={armed} at={hover} />}
      {active && <Gizmo s={s} f={F} live={live} v={v} />}
    </group>
  );
}

/** The picture pressed onto the surface: dark where it cuts. */
function Pressed({ f, gray, xray }: { f: ImpressFrame; gray: Gray; xray: boolean }) {
  const tex = useMemo(() => {
    const data = new Uint8Array(gray.w * gray.h * 4);
    const ink = new THREE.Color(cssVar('--accent', '#d4521c'));
    for (let i = 0; i < gray.w * gray.h; i++) {
      const d = 1 - gray.data[i];
      data[i * 4] = ink.r * 140;
      data[i * 4 + 1] = ink.g * 140;
      data[i * 4 + 2] = ink.b * 140;
      data[i * 4 + 3] = Math.round(Math.min(1, d * 1.15) * 205);
    }
    const t = new THREE.DataTexture(data, gray.w, gray.h, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }, [gray]);
  useEffect(() => () => tex.dispose(), [tex]);
  const geo = useMemo(() => quadGeometry(f), [f]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh geometry={geo} renderOrder={3}>
      {/* drawn over the plates: the frame sits at the lowest top on the surface, where the impression is measured from */}
      <meshBasicMaterial map={tex} transparent depthWrite={false} depthTest={false} side={THREE.DoubleSide} opacity={xray ? 0.55 : 0.7} />
    </mesh>
  );
}

/** X-ray: the floor of the cut, hanging inside the see-through plates, shaded shallow (pale) to deep (accent). */
function Relief({ s, f, gray, v, dim }: { s: ImpressSurface; f: ImpressFrame; gray: Gray; v: Values; dim: boolean }) {
  const geo = useMemo(() => {
    // a coarser grid is plenty to read the shape, and keeps a drag smooth
    const k = Math.max(1, Math.ceil(Math.max(gray.w, gray.h) / 128));
    const w = Math.max(2, Math.floor(gray.w / k)), h = Math.max(2, Math.floor(gray.h / k));
    const small: Gray = { w, h, data: new Float32Array(w * h) };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) small.data[y * w + x] = gray.data[Math.min(gray.h - 1, y * k) * gray.w + Math.min(gray.w - 1, x * k)];
    const depth = depthField(s, v, small, f);
    const { positions, depths, index } = reliefMesh(f, depth, w, h);
    const max = Math.max(1, maxDepth(s, v));
    const pale = new THREE.Color('#ffe2a8'), deep = new THREE.Color(cssVar('--accent', '#d4521c')).lerp(new THREE.Color('#7a1206'), 0.35);
    const col = new Float32Array(depths.length * 3);
    const c = new THREE.Color();
    for (let i = 0; i < depths.length; i++) {
      c.copy(pale).lerp(deep, Math.min(1, depths[i] / max));
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeVertexNormals();
    return g;
  }, [s, f, gray, v]);
  useEffect(() => () => geo.dispose(), [geo]);
  // the depth envelope: the frame carried down to the deepest cut
  const d = maxDepth(s, v);
  const box = useMemo(() => {
    const out: V3[][] = [];
    const cs: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    out.push([...cs, cs[0]].map(([x, y]) => framePoint(f, x, y, d)));
    for (const [x, y] of cs) out.push([framePoint(f, x, y), framePoint(f, x, y, d)]);
    return out;
  }, [f, d]);
  return (
    <group>
      <mesh geometry={geo} renderOrder={4}>
        <meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={0.6} metalness={0} transparent opacity={dim ? 0.3 : 0.92} depthWrite={!dim} />
      </mesh>
      {box.map((pts, i) => (
        <Line key={i} points={pts} color="#8a5a2b" lineWidth={1} dashed dashSize={4} gapSize={3} transparent opacity={dim ? 0.25 : 0.7} />
      ))}
    </group>
  );
}

/** Where the armed picture would land, following the pointer. */
function DropGhost({ f, armed, at }: { f: ImpressFrame; armed: Armed; at: { fx: number; fy: number } }) {
  if (!armed) return null;
  const wmm = Math.min(f.w * 0.4, f.h * 0.4 * (armed.w / armed.h));
  const hmm = (wmm * armed.h) / armed.w;
  const x0 = at.fx - wmm / f.w / 2, x1 = at.fx + wmm / f.w / 2, y0 = at.fy - hmm / f.h / 2, y1 = at.fy + hmm / f.h / 2;
  const pts = [framePoint(f, x0, y0), framePoint(f, x1, y0), framePoint(f, x1, y1), framePoint(f, x0, y1), framePoint(f, x0, y0)];
  return <Line points={pts} color={cssVar('--accent', '#d4521c')} lineWidth={2} depthTest={false} transparent renderOrder={13} />;
}

type DragKind = 'move' | 'scale' | 'turn' | 'depth';

/**
 * The impress gizmo on the picked picture: its outline, four corner handles to
 * size it, a round handle on a stalk to turn it, and an arrow into the material
 * to set how deep it cuts. Dragging the picture itself moves it.
 */
function Gizmo({ s, f, live, v }: { s: ImpressSurface; f: ImpressFrame; live: LiveLayers; v: Values }) {
  const b = live.comp.blocks.find((x) => x.id === live.sel && x.surface === s && !x.hidden);
  const src = b ? live.dimsOf(b) : null;
  return b && src ? <GizmoOn s={s} f={f} live={live} v={v} b={b} src={src} /> : null;
}

function GizmoOn({ s, f, live, v, b, src }: { s: ImpressSurface; f: ImpressFrame; live: LiveLayers; v: Values; b: Block; src: { w: number; h: number } }) {
  const { controls, camera, gl } = useThree() as unknown as { controls?: { enabled: boolean }; camera: THREE.Camera; gl: THREE.WebGLRenderer };
  // a drag follows the pointer anywhere on the page, not only while it is over the handle
  const moveRef = useRef<(ray: THREE.Ray, shift: boolean) => void>(() => {});
  const drag = useRef<{ kind: DragKind; b: Block; p0: [number, number]; d0: number; a0: number } | null>(null);
  const accent = cssVar('--accent', '#d4521c');
  const body = useBodyGeometry(f, blockCorners(b, src, f));
  const hs = Math.min(14, Math.max(3, Math.min(f.w, f.h) * 0.03));
  const cube = useMemo(() => {
    const box = new THREE.BoxGeometry(hs, hs, hs);
    return { box, edges: new THREE.EdgesGeometry(box) };
  }, [hs]);
  useEffect(() => () => (cube.box.dispose(), cube.edges.dispose()), [cube]);
  useEffect(() => {
    const rc = new THREE.Raycaster();
    const onMove = (ev: PointerEvent) => {
      if (!drag.current) return;
      const r = gl.domElement.getBoundingClientRect();
      rc.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
      moveRef.current(rc.ray, ev.shiftKey);
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      if (controls) controls.enabled = true;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [controls, camera, gl]);
  const corners = blockCorners(b, src, f);
  const centre: [number, number] = [b.x, b.y];
  const mm = (p: [number, number]): [number, number] => [p[0] * f.w, p[1] * f.h];
  // the turn handle sits on a stalk above the picture's top edge
  const th = (b.rotate * Math.PI) / 180;
  const up: [number, number] = [Math.sin(th), -Math.cos(th)]; // picture "up" in mm (y down)
  const topMid = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
  const knob: [number, number] = [topMid[0] + (up[0] * hs * 4) / f.w, topMid[1] + (up[1] * hs * 4) / f.h];
  const depth = layerDepth(b, s, v);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(v3(f.inward), v3(f.origin));
  const onPlane = (ray: THREE.Ray): [number, number] | null => {
    const hit = ray.intersectPlane(plane, new THREE.Vector3());
    return hit ? frameFractions(f, [hit.x, hit.y, hit.z]) : null;
  };
  /** How far along the depth arrow the pointer's ray passes closest, mm. */
  const alongArrow = (ray: THREE.Ray): number => {
    const C = v3(framePoint(f, b.x, b.y)), D = v3(f.inward), O = ray.origin, R = ray.direction;
    const w = C.clone().sub(O);
    const bb = D.dot(R);
    const den = 1 - bb * bb;
    if (den < 1e-6) return drag.current?.d0 ?? 0;
    return (bb * R.dot(w) - D.dot(w)) / den;
  };
  const start = (kind: DragKind) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const p = onPlane(e.ray);
    if (!p) return;
    live.begin();
    const c = mm(centre), q = mm(p);
    drag.current = { kind, b, p0: p, d0: Math.hypot(q[0] - c[0], q[1] - c[1]), a0: Math.atan2(q[1] - c[1], q[0] - c[0]) };
    if (controls) controls.enabled = false;
  };
  moveRef.current = (ray, shift) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'depth') {
      const mmDeep = Math.max(0.5, Math.min(depthCap(s, v, 9999), alongArrow(ray)));
      live.changeWith((c, patch) => setLayerDepth(c, s, d.b.id, mmDeep, { ...v, ...patch } as Values));
      return;
    }
    const p = onPlane(ray);
    if (!p) return;
    const c = mm([d.b.x, d.b.y]), q = mm(p);
    let next: Partial<Block>;
    if (d.kind === 'move') next = { x: +(d.b.x + p[0] - d.p0[0]).toFixed(5), y: +(d.b.y + p[1] - d.p0[1]).toFixed(5) };
    else if (d.kind === 'scale') next = { scale: +Math.max(0.01, (d.b.scale * Math.hypot(q[0] - c[0], q[1] - c[1])) / Math.max(1e-6, d.d0)).toFixed(5) };
    else {
      let deg = d.b.rotate + ((Math.atan2(q[1] - c[1], q[0] - c[0]) - d.a0) * 180) / Math.PI;
      deg = shift ? Math.round(deg / 15) * 15 : Math.round(deg);
      next = { rotate: ((((deg + 180) % 360) + 360) % 360) - 180 };
    }
    live.setBlock(d.b.id, next);
  };
  const P = (p: [number, number], dd = 0) => v3(framePoint(f, p[0], p[1], dd));
  const ring = [...corners, corners[0]].map((p) => framePoint(f, p[0], p[1]));
  useHandleProbe({ move: P(centre), scale: P(corners[2]), turn: P(knob), depth: P(centre, depth) });
  const tip = P(centre, depth);
  const coneQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v3(f.inward));
  return (
    <group>
      {/* drag the picture itself to move it */}
      <mesh geometry={body} renderOrder={8} onPointerDown={start('move')}>
        <meshBasicMaterial color={accent} transparent opacity={0.12} depthTest={false} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Line points={ring} color={accent} lineWidth={2.5} depthTest={false} transparent renderOrder={13} />
      {corners.map((p, i) => (
        <mesh key={i} geometry={cube.box} position={P(p)} renderOrder={14} onPointerDown={start('scale')} userData={{ impress: 'scale' }}>
          <meshBasicMaterial color="#ffffff" depthTest={false} transparent />
          <lineSegments geometry={cube.edges} renderOrder={15}>
            <lineBasicMaterial color={accent} depthTest={false} transparent />
          </lineSegments>
        </mesh>
      ))}
      <Line points={[framePoint(f, topMid[0], topMid[1]), framePoint(f, knob[0], knob[1])]} color={accent} lineWidth={2} depthTest={false} transparent renderOrder={13} />
      <mesh position={P(knob)} renderOrder={14} onPointerDown={start('turn')} userData={{ impress: 'turn' }}>
        <sphereGeometry args={[hs * 0.75, 20, 14]} />
        <meshBasicMaterial color={accent} depthTest={false} transparent />
      </mesh>
      {/* depth: a stalk into the material from the picture's centre, the cone at the bottom of the cut */}
      <Line points={[framePoint(f, b.x, b.y), [tip.x, tip.y, tip.z]]} color="#2f5f9e" lineWidth={3} depthTest={false} transparent renderOrder={13} />
      <mesh position={tip} quaternion={coneQ} renderOrder={14} onPointerDown={start('depth')} userData={{ impress: 'depth' }}>
        <coneGeometry args={[hs * 0.8, hs * 2, 18]} />
        <meshBasicMaterial color="#2f5f9e" depthTest={false} transparent />
      </mesh>
    </group>
  );
}

/** Where each handle is on screen, kept on the view as data-handles (for the end-to-end tests). */
function useHandleProbe(pts: Record<string, THREE.Vector3>) {
  const { camera, gl } = useThree();
  const ref = useRef(pts);
  ref.current = pts;
  useFrame(() => {
    const el = gl.domElement.closest('.impress-view') as HTMLElement | null;
    if (!el) return;
    const r = gl.domElement.getBoundingClientRect();
    const out: Record<string, [number, number]> = {};
    for (const [k, p] of Object.entries(ref.current)) {
      const q = p.clone().project(camera);
      out[k] = [Math.round(r.left + ((q.x + 1) / 2) * r.width), Math.round(r.top + ((1 - q.y) / 2) * r.height)];
    }
    const s = JSON.stringify(out);
    if (el.dataset.handles !== s) el.dataset.handles = s;
  });
}

function useBodyGeometry(f: ImpressFrame, corners: [number, number][]) {
  const key = corners.flat().join(',');
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap((p) => framePoint(f, p[0], p[1])), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f, key]);
  useEffect(() => () => geo.dispose(), [geo]);
  return geo;
}

/** The Windows 98 tool window: surface, pictures, depth, size, turn and the x-ray switch. */
function ImpressPanel(props: {
  s: ImpressSurface;
  setSurface: (s: ImpressSurface) => void;
  available: ImpressSurface[];
  frames: Record<ImpressSurface, SurfaceFrames | null>;
  live: LiveLayers;
  v: Values;
  sel: Block | undefined;
  armed: Armed;
  setArmed: (a: Armed) => void;
  arm: (source: BlockSource, name: string) => void;
  pick: () => void;
  xray: boolean;
  setXray: (x: boolean) => void;
  look: () => void;
  plateCount: number;
}) {
  const { s, setSurface, available, frames, live, v, sel, armed, setArmed, arm, pick, xray, setXray, look, plateCount } = props;
  const setParams = useStore((st) => st.setParams);
  const f = frames[s];
  const F = f ? liveFrame(f) : null;
  const here = live.comp.blocks.filter((b) => b.surface === s);
  // pictures already in the project (other surfaces, the tray), offered again
  const others = useMemo(() => {
    const seen = new Set<string>();
    return live.comp.blocks.filter((b) => {
      if (b.source.kind !== 'image' || seen.has(b.source.dataUrl)) return false;
      seen.add(b.source.dataUrl);
      return true;
    });
  }, [live.comp.blocks]);
  const cap = depthCap(s, v, plateCount);
  const src = sel ? live.dimsOf(sel) : null;
  const widthMm = sel && F ? sel.scale * F.w : 0;
  const setDepth = (id: string, mm: number) => live.changeWith((c, patch) => setLayerDepth(c, s, id, mm, { ...v, ...patch } as Values));
  const frontOff = !frames.front;
  const [depthBusy, setDepthBusy] = useState(false);
  const [depthError, setDepthError] = useState<string | null>(null);
  // the depth server takes ~45 s to boot cold: start it while a picture is placed
  useEffect(() => {
    if (DEPTH_URL && sel?.source.kind === 'image') wakeDepth(DEPTH_URL);
  }, [sel?.source.kind]);
  const toggleDepth = async (b: Block) => {
    if (b.source.kind !== 'image') return;
    setDepthError(null);
    if (b.source.photo) {
      const { photo, ...rest } = b.source;
      return live.setBlock(b.id, { source: { ...rest, name: rest.name.replace(/^depth · /, ''), dataUrl: photo } });
    }
    setDepthBusy(true);
    try {
      const relief = await photoDepth(b.source.dataUrl);
      if (!relief) return;
      const photo = b.source.dataUrl;
      // the layer may have been moved, renamed or removed while the server answered: change its latest state
      live.change((c) => ({
        ...c,
        blocks: c.blocks.map((x) => (x.id === b.id && x.source.kind === 'image' && x.source.dataUrl === photo ? { ...x, source: { ...x.source, name: `depth · ${x.source.name}`, dataUrl: relief, photo } } : x)),
      }));
    } catch (e) {
      setDepthError(e instanceof Error ? e.message : String(e));
    } finally {
      setDepthBusy(false);
    }
  };
  return (
    <div className="window box impress-panel" role="region" aria-label="Impress image">
      <div className="title-bar">
        <div className="title-bar-text">Impress image</div>
      </div>
      <div className="window-body">
        <fieldset className="section">
          <legend>Surface</legend>
          <div className="btnrow" role="group" aria-label="Surface">
            {IMPRESS_SURFACES.map((k) => (
              <button key={k} className={`btn sm ${k === s ? 'on' : ''}`} aria-pressed={k === s} disabled={!available.includes(k)} onClick={() => setSurface(k)}>
                {NAMES[k]}
              </button>
            ))}
          </div>
          {frontOff && <p className="note">The front face takes pictures on an upright parallel stack.</p>}
          {f && (
            <p className="note" data-testid="impress-surface-size">
              {fmt(f.area.w, 0)} × {fmt(f.area.h, 0)} mm{needsFit(f) && here.length ? ' · the picture is widened to the whole surface when you drop the next one' : ''}
            </p>
          )}
        </fieldset>
        <fieldset className="section">
          <legend>Picture</legend>
          <div className="btnrow">
            <button className="btn sm default" onClick={pick} data-testid="impress-pick">
              Pick picture…
            </button>
            {armed && (
              <button className="btn sm" onClick={() => setArmed(null)}>
                Cancel
              </button>
            )}
          </div>
          {others.length > 0 && (
            <div className="impress-thumbs" aria-label="Pictures already in this project">
              {others.map((b) => (
                <button
                  key={b.id}
                  className={`impress-thumb ${armed?.source.kind === 'image' && b.source.kind === 'image' && armed.source.dataUrl === b.source.dataUrl ? 'on' : ''}`}
                  title={`Use ${b.name} again`}
                  onClick={() => arm(b.source, b.name)}
                >
                  <img src={(b.source as { dataUrl: string }).dataUrl} alt={b.name} />
                </button>
              ))}
            </div>
          )}
          <p className="note" role="status" data-testid="impress-hint">
            {armed ? `Click the ${NAMES[s].toLowerCase()} (or the other surface) where ${armed.name.replace(/\.[a-z0-9]+$/i, '')} should go.` : 'Pick a picture, then click a surface to press it in.'}
          </p>
        </fieldset>
        <fieldset className="section">
          <legend>On the {NAMES[s].toLowerCase()}</legend>
          {here.length === 0 ? (
            <p className="note">Nothing pressed in yet.</p>
          ) : (
            <ul className="impress-list">
              {here.map((b) => (
                <li key={b.id} className={b.id === sel?.id ? 'sel' : undefined}>
                  <button className="impress-name" onClick={() => live.setSel(b.id)} aria-pressed={b.id === sel?.id}>
                    {b.name}
                  </button>
                  <span className="impress-depth">{fmt(layerDepth(b, s, v), 1)} mm</span>
                  <button className="btn sm" title={b.hidden ? 'Show' : 'Hide'} aria-label={`${b.hidden ? 'Show' : 'Hide'} ${b.name}`} onClick={() => live.setBlock(b.id, { hidden: !b.hidden })}>
                    {b.hidden ? 'Show' : 'Hide'}
                  </button>
                  <button
                    className="btn sm"
                    aria-label={`Remove ${b.name}`}
                    onClick={() => {
                      live.change((c) => ({ ...c, blocks: c.blocks.filter((x) => x.id !== b.id) }));
                      if (b.id === sel?.id) live.setSel(null);
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        {sel && F && src && (
          <fieldset className="section" data-testid="impress-selected">
            <legend>{sel.name}</legend>
            <Slider
              label="Depth"
              unit="mm"
              min={s === 'front' ? 0 : 0.5}
              max={cap}
              step={s === 'front' ? v.pitch : 0.5}
              value={layerDepth(sel, s, v)}
              onDown={live.begin}
              onChange={(x) => setDepth(sel.id, x)}
              note={s === 'front' ? `${Math.round(layerDepth(sel, s, v) / v.pitch)} of ${plateCount} plates cut through` : undefined}
              testId="impress-depth"
            />
            <Slider label="Width" unit="mm" min={2} max={Math.round(F.w * 1.5)} step={1} value={widthMm} onDown={live.begin} onChange={(x) => live.setBlock(sel.id, { scale: +(x / F.w).toFixed(5) })} testId="impress-width" />
            <Slider label="Turn" unit="°" min={-180} max={180} step={1} value={sel.rotate} onDown={live.begin} onChange={(x) => live.setBlock(sel.id, { rotate: x })} testId="impress-turn" />
            <div className="btnrow">
              <label className="impress-check">
                <input type="checkbox" checked={sel.invert} onChange={(e) => live.setBlock(sel.id, { invert: e.target.checked })} />
                <span>Invert (light cuts)</span>
              </label>
              {DEPTH_URL && sel.source.kind === 'image' && (
                <label className="impress-check" title="Send the photo to the depth server and press in its shape (near parts cut deepest; Invert makes them stand proud)">
                  <input type="checkbox" checked={!!sel.source.photo} disabled={depthBusy} onChange={() => toggleDepth(sel)} data-testid="impress-photo-depth" />
                  <span>{depthBusy ? 'Reading depth…' : 'Depth from photo'}</span>
                </label>
              )}
            </div>
            {depthError && <p className="note err" role="alert">{depthError}</p>}
            <div className="btnrow">
              <button className="btn sm" onClick={() => live.setBlock(sel.id, { x: 0.5, y: 0.5 })}>
                Centre
              </button>
              <button className="btn sm" onClick={() => live.setBlock(sel.id, { scale: Math.min(1, (F.h * src.w) / (src.h * F.w)), x: 0.5, y: 0.5, rotate: 0 })}>
                Fill
              </button>
            </div>
          </fieldset>
        )}
        {f && here.length > 0 && (
          <fieldset className="section">
            <legend>Cut</legend>
            {s === 'top' ? (
              <Slider label="Steps" unit="" min={0} max={20} step={1} value={v.topSteps} onChange={(x) => setParams({ topSteps: x })} note={v.topSteps > 0 ? `${v.topSteps} crisp terraces` : 'a smooth slope'} testId="impress-steps" />
            ) : (
              <p className="note">Deepest cut {frontPlates(v)} plate{frontPlates(v) === 1 ? '' : 's'} ({fmt(maxDepth(s, v), 0)} mm) at {fmt(v.pitch, 1)} mm pitch.</p>
            )}
          </fieldset>
        )}
        <fieldset className="section">
          <legend>View</legend>
          <div className="btnrow">
            <label className="impress-check">
              <input type="checkbox" checked={xray} onChange={(e) => setXray(e.target.checked)} data-testid="impress-xray" />
              <span>X-ray</span>
            </label>
            <button className="btn sm" onClick={look}>
              Look at surface
            </button>
          </div>
          <p className="note">Drag the picture to move it, a corner to size it, the round handle to turn it (Shift: 15° steps) and the blue arrow to set its depth. Del removes it.</p>
        </fieldset>
      </div>
    </div>
  );
}

function Slider({ label, unit, min, max, step, value, onChange, onDown, note, testId }: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (x: number) => void; onDown?: () => void; note?: string; testId?: string }) {
  return (
    <div className="impress-slider">
      <label className="field-row">
        <span className="impress-label">{label}</span>
        <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} onPointerDown={onDown} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} data-testid={testId} />
        <span className="impress-value">
          {fmt(value, step < 1 ? 1 : 0)}
          {unit && ` ${unit}`}
        </span>
      </label>
      {note && <p className="note">{note}</p>}
    </div>
  );
}


// one answer per photo per page: switching Depth from photo off and on again doesn't ask twice
const depthAnswers = new Map<string, string>();

/** The photo's depth relief as a grey picture (near = dark), or null when cancelled. */
async function photoDepth(photo: string): Promise<string | null> {
  const known = depthAnswers.get(photo);
  if (known) return known;
  const ctrl = new AbortController();
  const est = depthWaitEstimate();
  const started = Date.now();
  const busy = beginBusy({ scene: 'depth', title: 'Depth from photo', detail: depthStep(0, est), expectMs: est.totalMs, cancel: () => ctrl.abort() });
  const tick = setInterval(() => busy.update({ detail: depthStep(Date.now() - started, est) }), 500);
  try {
    const { png, depth } = await depthFromPhoto(photo, { signal: ctrl.signal });
    const relief = depth ? grayDataUrl(depthToGray({ ...depth, settings: defaultDepthSettings(depth) })) : png;
    depthAnswers.set(photo, relief);
    return relief;
  } catch (e) {
    if (ctrl.signal.aborted) return null;
    throw e;
  } finally {
    clearInterval(tick);
    busy.end();
  }
}
