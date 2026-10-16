// Measuring tape in the 3D view: point to point, edge to edge, point to edge and point to face.
// Picks snap to vertices, edge midpoints, edges and faces of the plates, base and insert.
// Measurements are view-only: kept as world points (so they survive a regenerate), never saved.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { create } from 'zustand';
import { useThree } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import type { V3 } from '../core/section';
import { chooseSnap, measureLines, measurePointFace, measurePointLine, measurePoints, MEASURE_KINDS, PICKS, SNAP_LABEL, type MeasureKind, type MeasureResult, type Measurement, type Seg, type Snap } from '../core/measure';
import { useStore } from '../state/store';
import { cssVar } from './Scene';
import { fmt } from './model';

interface Pick {
  snap: Snap;
  /** Raw surface point under the cursor (a face pick uses it, not the snapped point). */
  hit: V3;
}

interface MeasureState {
  kind: MeasureKind;
  /** Snapping switched off (Alt does the same while held). */
  free: boolean;
  list: Measurement[];
  pending: Pick | null;
  setKind: (k: MeasureKind) => void;
  setFree: (f: boolean) => void;
  setPending: (p: Pick | null) => void;
  add: (m: MeasureResult) => void;
  remove: (id: number) => void;
  removeLast: () => void;
  clear: () => void;
}

let nextId = 1;

export const useMeasure = create<MeasureState>((set, get) => ({
  kind: 'pp',
  free: false,
  list: [],
  pending: null,
  setKind: (kind) => set({ kind, pending: null }),
  setFree: (free) => set({ free }),
  setPending: (pending) => set({ pending }),
  add: (m) => set({ list: [...get().list, { ...m, id: nextId++ }], pending: null }),
  remove: (id) => set({ list: get().list.filter((m) => m.id !== id) }),
  removeLast: () => set({ list: get().list.slice(0, -1) }),
  clear: () => set({ list: [], pending: null }),
}));

/** What the next click should pick, in words. */
function promptFor(kind: MeasureKind, pending: Pick | null): string {
  const want = PICKS[kind][pending ? 1 : 0];
  const nth = pending && want === PICKS[kind][0] ? 'the second ' : want === 'edge' ? 'an ' : 'a ';
  return `Click ${nth}${want}`;
}

/** Turn two picks into a measurement, or null when the second pick isn't the kind of thing wanted. */
function resolve(kind: MeasureKind, a: Pick, b: Pick): MeasureResult | null {
  switch (kind) {
    case 'pp':
      return measurePoints(a.snap.point, b.snap.point);
    case 'll':
      return a.snap.edge && b.snap.edge ? measureLines(a.snap.edge, b.snap.edge) : null;
    case 'pl':
      return b.snap.edge ? measurePointLine(a.snap.point, b.snap.edge) : null;
    case 'pf':
      return measurePointFace(a.snap.point, b.hit, b.snap.normal);
  }
}

/** Is this pick usable for the given slot? */
function fits(want: 'point' | 'edge' | 'face', p: Pick) {
  return want !== 'edge' || !!p.snap.edge;
}

// ---------- feature edges, cached per geometry ----------

const edgeCache = new WeakMap<THREE.BufferGeometry, Float32Array>();
function featureEdges(g: THREE.BufferGeometry): Float32Array {
  let e = edgeCache.get(g);
  if (!e) {
    const eg = new THREE.EdgesGeometry(g, 20);
    e = eg.getAttribute('position').array as Float32Array;
    eg.dispose();
    edgeCache.set(g, e);
  }
  return e;
}

/** Feature edges of a mesh lying within r of the world point p, in world space. */
function edgesNear(mesh: THREE.Mesh, p: THREE.Vector3, r: number): Seg[] {
  const arr = featureEdges(mesh.geometry);
  const inv = mesh.matrixWorld.clone().invert();
  const lp = p.clone().applyMatrix4(inv);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Vector3();
  const line = new THREE.Line3(a, b);
  const out: Seg[] = [];
  const toW = (v: THREE.Vector3): V3 => {
    const w = v.clone().applyMatrix4(mesh.matrixWorld);
    return [w.x, w.y, w.z];
  };
  for (let i = 0; i + 5 < arr.length; i += 6) {
    a.set(arr[i], arr[i + 1], arr[i + 2]);
    b.set(arr[i + 3], arr[i + 4], arr[i + 5]);
    line.closestPointToPoint(lp, true, q);
    if (q.distanceTo(lp) <= r) out.push([toW(a), toW(b)]);
    if (out.length > 400) break;
  }
  return out;
}

const SKIP_RAYCAST = () => {};

/** The measuring tool inside the Canvas: picking, snap marker, and every measurement drawn as a dimension line. */
export function MeasureTool({ active, showDimensions = true }: { active: boolean; showDimensions?: boolean }) {
  const { camera, gl, scene } = useThree();
  const kind = useMeasure((s) => s.kind);
  const list = useMeasure((s) => s.list);
  const pending = useMeasure((s) => s.pending);
  const theme = useStore((s) => s.ui.theme);
  const accent = useMemo(() => cssVar('--accent', '#d4521c'), [theme]); // eslint-disable-line react-hooks/exhaustive-deps
  const ink = useMemo(() => cssVar('--ink', '#1b1b1b'), [theme]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hover, setHover] = useState<Pick | null>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  const ray = useMemo(() => new THREE.Raycaster(), []);

  useEffect(() => {
    if (!active) {
      setHover(null);
      return;
    }
    const el = gl.domElement;
    const prevCursor = el.style.cursor;
    el.style.cursor = 'crosshair';
    const pickAt = (e: PointerEvent): Pick | null => {
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      ray.setFromCamera(new THREE.Vector2((sx / r.width) * 2 - 1, -(sy / r.height) * 2 + 1), camera);
      const meshes: THREE.Object3D[] = [];
      scene.traverseVisible((o) => {
        if ((o as THREE.Mesh).isMesh && o.userData.measure) meshes.push(o);
      });
      const hit = ray.intersectObjects(meshes, false)[0];
      if (!hit || !hit.face) return null;
      const mesh = hit.object as THREE.Mesh;
      const n = hit.face.normal.clone().transformDirection(mesh.matrixWorld);
      // world size of one screen pixel at the hit
      const cam = camera as THREE.PerspectiveCamera & THREE.OrthographicCamera;
      const perPx = cam.isOrthographicCamera ? (cam.top - cam.bottom) / cam.zoom / r.height : (2 * hit.distance * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / r.height;
      const edges = edgesNear(mesh, hit.point, perPx * 40);
      const v = new THREE.Vector3();
      const project = (p: V3): [number, number] => {
        v.set(p[0], p[1], p[2]).project(camera);
        return [((v.x + 1) / 2) * r.width, ((1 - v.y) / 2) * r.height];
      };
      const h: V3 = [hit.point.x, hit.point.y, hit.point.z];
      const snap = chooseSnap({ cursor: [sx, sy], hit: h, normal: [n.x, n.y, n.z], edges, project }, { snap: !(useMeasure.getState().free || e.altKey) });
      return { snap, hit: h };
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return; // orbiting
      setHover(pickAt(e));
    };
    const onDown = (e: PointerEvent) => {
      down.current = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const d = down.current;
      down.current = null;
      if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return; // a drag orbits, a click picks
      const p = pickAt(e);
      if (!p) return;
      const st = useMeasure.getState();
      const want = PICKS[st.kind][st.pending ? 1 : 0];
      if (!fits(want, p)) {
        useStore.getState().toast('Point at an edge: the pick snaps to the nearest one.');
        return;
      }
      if (!st.pending) return st.setPending(p);
      const m = resolve(st.kind, st.pending, p);
      if (m) st.add(m);
    };
    const onLeave = () => setHover(null);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.style.cursor = prevCursor;
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [active, camera, gl, scene, ray]);

  // what the next click would give, drawn live from the first pick
  const want = PICKS[kind][pending ? 1 : 0];
  const live = active && pending && hover && fits(want, hover) ? resolve(kind, pending, hover) : null;
  const hoverEdge = active && hover && want !== 'point' && want !== 'face' ? hover.snap.edge : undefined;
  const marker = hover ? (want === 'face' ? hover.hit : hover.snap.point) : null;

  return (
    <group>
      {(showDimensions || active) &&
        list.map((m) => (
          <Dimension key={m.id} m={m} color={accent} ink={ink} />
        ))}
      {active && pending && (
        <>
          {pending.snap.edge && PICKS[kind][0] === 'edge' && <Line points={pending.snap.edge} color={accent} lineWidth={3} depthTest={false} renderOrder={10} raycast={SKIP_RAYCAST} />}
          <Html position={pending.snap.point} center zIndexRange={[2, 0]} wrapperClass="ms-nohit">
            <div className="ms-dot" />
          </Html>
        </>
      )}
      {live && <Line points={[live.a, live.b]} color={accent} lineWidth={1.5} dashed dashSize={4} gapSize={3} depthTest={false} renderOrder={10} raycast={SKIP_RAYCAST} />}
      {hoverEdge && <Line points={hoverEdge} color={accent} lineWidth={2.5} depthTest={false} renderOrder={10} raycast={SKIP_RAYCAST} />}
      {active && hover && marker && (
        <Html position={marker} center zIndexRange={[2, 0]} wrapperClass="ms-nohit">
          <div className="ms-snapwrap">
            <div className={`ms-snap ms-${hover.snap.kind}`} />
            <div className="ms-hint">
              {want === 'face' ? 'Face' : SNAP_LABEL[hover.snap.kind]}
              {live ? ` · ${fmt(live.dist, 1)} mm` : ''}
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}

function Dimension({ m, color, ink }: { m: Measurement; color: string; ink: string }) {
  const remove = useMeasure((s) => s.remove);
  const mid: V3 = [(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2, (m.a[2] + m.b[2]) / 2];
  return (
    <group>
      {m.guides.map((g, i) => (
        <Line key={i} points={g} color={ink} lineWidth={2} transparent opacity={0.6} depthTest={false} renderOrder={9} raycast={SKIP_RAYCAST} />
      ))}
      {m.dist > 1e-6 && <Line points={[m.a, m.b]} color={color} lineWidth={2} depthTest={false} renderOrder={10} raycast={SKIP_RAYCAST} />}
      {[m.a, m.b].map((p, i) => (
        <Html key={i} position={p} center zIndexRange={[2, 0]} wrapperClass="ms-nohit">
          <div className="ms-dot" />
        </Html>
      ))}
      <Html position={mid} center zIndexRange={[2, 0]}>
        <button
          className="ms-label"
          title="Click to remove this measurement"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            remove(m.id);
          }}
        >
          <b>{fmt(m.dist, 1)} mm</b>
          {m.kind === 'pf' && <span>⊥ to face</span>}
          {m.kind === 'pl' && <span>⊥ to edge</span>}
          {m.angle !== undefined && <span>{fmt(m.angle, 1)}° between</span>}
          {m.delta && (
            <span>
              X {fmt(m.delta[0], 1)} · Y {fmt(m.delta[1], 1)} · Z {fmt(m.delta[2], 1)}
            </span>
          )}
        </button>
      </Html>
    </group>
  );
}

/** The small control strip shown while measuring. */
export function MeasurePanel() {
  const { kind, free, list, pending, setKind, setFree, clear, setPending } = useMeasure();
  return (
    <div className="overlay tc movepanel measurepanel">
      <div className="mp-row">
        {MEASURE_KINDS.map((k) => (
          <button key={k.id} className={`btn sm ${kind === k.id ? 'on' : ''}`} onClick={() => setKind(k.id)} title={k.title}>
            {k.label}
          </button>
        ))}
        <button className={`btn sm ${free ? '' : 'on'}`} onClick={() => setFree(!free)} title="Snap to vertices, edge midpoints, edges and faces (hold Alt to switch off for one pick)">
          Snap
        </button>
        <button className="btn sm" disabled={!list.length && !pending} onClick={clear} title="Remove every measurement">
          Clear
        </button>
      </div>
      <div className="mp-info">
        {promptFor(kind, pending)}
        {pending && (
          <>
            {' · '}
            <a href="#" onClick={(e) => (e.preventDefault(), setPending(null))}>
              restart
            </a>
          </>
        )}
        {list.length > 0 && ` · ${list.length} shown (click a label or Delete to remove)`}
      </div>
    </div>
  );
}
