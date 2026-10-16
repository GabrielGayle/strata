import { memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { Edges } from '@react-three/drei';
import ViewportGrid from './ViewportGrid';
import { registerSceneMount } from './viewportSceneDebug';
import { gridFloorY } from './viewportClip';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Model } from '../core/pipeline';
import type { Part } from '../core/slicer';
import type { MouldPart } from '../core/mould';
import { etchSegments, extrudeOnPlane, extrudePlan } from '../core/geometry3d';
import { planeToWorld } from '../core/section';
import { baseGeometry } from '../core/base';
import { shapeBBox } from '../core/geom2d';
import { makeConcreteMaterial, METALS, PLY, type Band } from './materials';
import { lookOf, MAIN, type Appearance } from '../core/appearance';
import { useStore } from '../state/store';
import PlateGizmo, { gizmoIsBusy, moveTarget } from './PlateGizmo';
import { SunStudy3D } from './SunStudy';

export interface SceneOpts {
  selected: string | null;
  onSelect?: (id: string | null) => void;
  showMoulds: boolean;
  explode: boolean;
  xray: boolean;
  showIssues: boolean;
  showSource: boolean;
  /** Hand placement: the selected plate gets a move / rotate gizmo. */
  moveMode?: boolean;
  /** Material picking: a click puts the plate in the active bucket (shift-click: the run since the last one). */
  onPaint?: (plateKey: string, shift: boolean) => void;
}

export function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function Env() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.55;
    return () => {
      scene.environment = null;
      env.dispose();
      pm.dispose();
    };
  }, [gl, scene]);
  return null;
}

const PlateMesh = memo(function PlateMesh({ part, material, selMaterial, selected, onSelect, onPaint }: { part: Part; material: THREE.Material; selMaterial: THREE.Material; selected: boolean; onSelect?: (id: string) => void; onPaint?: (key: string, shift: boolean) => void }) {
  const geo = useMemo(() => extrudeOnPlane(part.shape, part.thickness, part.plane), [part]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh
      geometry={geo}
      userData={{ measure: part.id }}
      castShadow
      receiveShadow
      material={selected ? selMaterial : material}
      onClick={
        onPaint
          ? (e: ThreeEvent<MouseEvent>) => {
              if (e.delta > 4) return;
              e.stopPropagation();
              onPaint(part.plateKey, e.nativeEvent.shiftKey);
            }
          : onSelect
            ? (e: ThreeEvent<MouseEvent>) => {
                if (e.delta > 4 || gizmoIsBusy()) return;
                e.stopPropagation();
                onSelect(part.id);
              }
            : undefined
      }
    />
  );
});

function Etches({ parts, engraving = true, labels = true }: { parts: Part[]; engraving?: boolean; labels?: boolean }) {
  const geo = useMemo(() => {
    const geos = parts
      .map((p) => {
        const seg: typeof p.etch = [];
        if (engraving) seg.push(...p.etch);
        if (labels) seg.push(...p.labelPaths);
        if (!seg.length) return null;
        return etchSegments(seg, p.thickness, p.plane);
      })
      .filter(Boolean) as THREE.BufferGeometry[];
    if (!geos.length) return new THREE.BufferGeometry();
    const n = geos.reduce((a, g) => a + g.getAttribute('position').count, 0);
    const pos = new Float32Array(n * 3);
    let o = 0;
    for (const g of geos) {
      pos.set(g.getAttribute('position').array as Float32Array, o);
      o += g.getAttribute('position').array.length;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return out;
  }, [parts, engraving, labels]);
  useEffect(() => () => geo.dispose(), [geo]);
  if (!engraving && !labels) return null;
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#1b1b1b" transparent opacity={0.75} />
    </lineSegments>
  );
}

function Base({ model, xray }: { model: Model; xray: boolean }) {
  const v = model.v;
  const mat = useMemo(() => makeConcreteMaterial(), []);
  const geo = useMemo(() => baseGeometry(v), [v.baseLength, v.baseHeight, v.baseWidth, v.baseCornerChamfer, v.baseEdgeChamfer]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => () => mat.dispose(), [mat]);
  const bands: Band[] =
    v.pourView === 'plain' || !model.pour.rows.length ? [{ top: 1e9, color: v.concreteTint }] : model.pour.rows.map((r) => ({ top: r.y1, color: r.color }));
  mat.setBands(bands, v.pourView === 'eroded' ? v.erodeAmount : 0);
  if (mat.transparent !== xray) mat.needsUpdate = true; // switching blending needs a recompile
  mat.transparent = xray;
  mat.opacity = xray ? 0.28 : 1;
  mat.depthWrite = !xray;
  return (
    <mesh geometry={geo} material={mat} receiveShadow castShadow={!xray} userData={{ measure: 'base' }}>
      <Edges color="#1b1b1b" threshold={15} />
    </mesh>
  );
}

function Insert({ model }: { model: Model }) {
  const v = model.v;
  const ins = model.insert;
  const mat = useMemo(() => makeConcreteMaterial(), []);
  useEffect(() => () => mat.dispose(), [mat]);
  if (!ins) return null;
  if (v.insMaterial === 'void')
    return (
      <mesh geometry={ins.form.geometry} userData={{ measure: 'insert' }}>
        <meshBasicMaterial color={cssVar('--accent', '#d4521c')} wireframe transparent opacity={0.35} />
      </mesh>
    );
  if (v.insMaterial === 'metal') {
    const m = METALS.steel;
    return (
      <mesh geometry={ins.form.geometry} userData={{ measure: 'insert' }}>
        <meshStandardMaterial color={m.color} metalness={m.metalness} roughness={m.roughness} />
      </mesh>
    );
  }
  mat.setBands([{ top: 1e9, color: v.insTint }], 0);
  return <mesh geometry={ins.form.geometry} material={mat} castShadow receiveShadow userData={{ measure: 'insert' }} />;
}

/** Objects placed among the plates: postcards read as paper, the rest as see-through cutters. */
function PlacedObjects({ model }: { model: Model }) {
  const sel = useStore((s) => (s.ui.objectsMode ? s.ui.objectSel : null));
  const hl = useStore((s) => s.ui.highlight);
  const setUi = useStore((s) => s.setUi);
  const accent = cssVar('--accent', '#d4521c');
  return (
    <>
      {model.objects.map(({ object: o, geometry }) => {
        const shelf = o.seat !== undefined || o.id.startsWith('shelf');
        const lit = hl === 'notches' || (hl === 'cards' && shelf) || (hl === 'objects' && !shelf);
        const picked = o.id === sel || lit;
        const card = o.kind === 'card';
        return (
          <mesh
            key={o.id}
            geometry={geometry}
            userData={{ measure: o.id }}
            castShadow={card}
            onClick={(e) => {
              if (!useStore.getState().ui.objectsMode) return;
              e.stopPropagation();
              setUi({ objectSel: o.id });
            }}
          >
            <meshStandardMaterial color={card ? '#f3eee2' : '#7fb3d5'} roughness={0.85} transparent={!card} opacity={card ? 1 : 0.35} depthWrite={card} emissive={lit ? accent : '#000000'} emissiveIntensity={lit ? 0.35 : 0} />
            <Edges color={picked ? accent : card ? '#8a8378' : '#3d6f91'} threshold={20} />
          </mesh>
        );
      })}
      <OriginMarker model={model} />
    </>
  );
}

/** The world origin's axes: shown while placing objects or pointing at the origin node. */
function OriginMarker({ model }: { model: Model }) {
  const hl = useStore((s) => s.ui.highlight);
  const placing = useStore((s) => s.ui.objectsMode);
  if (!placing && hl !== 'origin') return null;
  const big = hl === 'origin';
  const len = big ? 220 : 120;
  return (
    // drawn over everything, so it shows even inside the concrete
    <group position={model.origin.p} rotation={[0, model.origin.turn, 0]}>
      <axesHelper args={[len]} renderOrder={999} onUpdate={(a) => ((a.material as THREE.Material).depthTest = false)} />
      <mesh renderOrder={999}>
        <sphereGeometry args={[big ? 12 : 7, 20, 12]} />
        <meshBasicMaterial color={cssVar('--accent', '#d4521c')} depthTest={false} />
      </mesh>
    </group>
  );
}

function explodeOffset(mp: MouldPart, center: THREE.Vector2, model: Model): THREE.Vector3 {
  const bb = shapeBBox(mp.shape);
  const cx = (bb.minX + bb.maxX) / 2 - center.x;
  const cy = (bb.minY + bb.maxY) / 2 - center.y;
  const out = new THREE.Vector3();
  if (mp.kind === 'ring') {
    // halves slide apart across their split line
    if (Math.abs(cx) > Math.abs(cy)) out.x = Math.sign(cx) * 140;
    else out.z = -Math.sign(cy) * 140;
  }
  if (mp.kind === 'floor') out.y = -70;
  if (mp.kind === 'cap') out.y = 70;
  if (mp.kind === 'jig') out.y = 160 + model.v.stackHeight;
  return out;
}

function Moulds({ model, explode }: { model: Model; explode: boolean }) {
  const parts = model.moulds.parts;
  const geos = useMemo(() => parts.map((p) => extrudePlan(p.shape, p.thickness, p.y0)), [parts]);
  useEffect(() => () => geos.forEach((g) => g.dispose()), [geos]);
  const centers = useMemo(() => {
    const c: Record<string, THREE.Vector2> = {};
    for (const body of ['base', 'insert'] as const) {
      const ps = parts.filter((p) => p.body === body);
      if (!ps.length) continue;
      const bbs = ps.map((p) => shapeBBox(p.shape));
      c[body] = new THREE.Vector2((Math.min(...bbs.map((b) => b.minX)) + Math.max(...bbs.map((b) => b.maxX))) / 2, (Math.min(...bbs.map((b) => b.minY)) + Math.max(...bbs.map((b) => b.maxY))) / 2);
    }
    return c;
  }, [parts]);
  const v = model.v;
  // the insert mould sits beside the base so both can be read
  const insertShift = new THREE.Vector3(0, 0, v.baseWidth / 2 + v.mouldWall * 2 + 260 + (model.insert ? model.insert.form.bbox.max.z - model.insert.form.bbox.min.z : 0));
  return (
    <group>
      {parts.map((p, i) => {
        const off = explode ? explodeOffset(p, centers[p.body], model) : new THREE.Vector3();
        if (p.body === 'insert') off.add(insertShift).add(new THREE.Vector3(0, explode ? 0 : 0, 0));
        return (
          <mesh key={p.id} geometry={geos[i]} position={off}>
            <meshStandardMaterial color={p.kind === 'jig' ? '#c9a46c' : PLY} roughness={0.85} transparent={p.kind === 'jig'} opacity={p.kind === 'jig' ? 0.85 : 1} />
            <Edges color="#5a4022" threshold={20} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Threaded rods with their nuts and washers, cast into the base. */
function Rods({ model }: { model: Model }) {
  const plan = model.sliced.brace?.rods ?? null;
  const parts = useMemo(() => {
    if (!plan) return null;
    const dir = new THREE.Vector3(...plan.dir).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const sp = plan.spec;
    const rodGeo = new THREE.CylinderGeometry(sp.d / 2, sp.d / 2, 1, 12);
    const nutGeo = new THREE.CylinderGeometry(sp.nutS / Math.sqrt(3), sp.nutS / Math.sqrt(3), sp.nutH, 6);
    const washerGeo = new THREE.CylinderGeometry(sp.washerD / 2, sp.washerD / 2, sp.washerH, 16);
    const place = (kind: 'nut' | 'washer') => {
      const mats: THREE.Matrix4[] = [];
      for (const r of plan.rods) {
        const c = new THREE.Vector3(...r.a).add(new THREE.Vector3(...r.b)).multiplyScalar(0.5);
        for (const f of r.fixings.filter((x) => x.kind === kind)) mats.push(new THREE.Matrix4().compose(c.clone().addScaledVector(dir, f.s), q, new THREE.Vector3(1, 1, 1)));
      }
      return mats;
    };
    return { q, rodGeo, nutGeo, washerGeo, nuts: place('nut'), washers: place('washer') };
  }, [plan]);
  useEffect(() => () => {
    parts?.rodGeo.dispose();
    parts?.nutGeo.dispose();
    parts?.washerGeo.dispose();
  }, [parts]);
  if (!plan || !parts) return null;
  return (
    <group>
      {plan.rods.map((r, i) => (
        <mesh key={i} geometry={parts.rodGeo} quaternion={parts.q} scale={[1, r.length.length, 1]} position={new THREE.Vector3(...r.a).add(new THREE.Vector3(...r.b)).multiplyScalar(0.5)}>
          <meshStandardMaterial color="#9aa0a6" metalness={0.85} roughness={0.35} />
        </mesh>
      ))}
      <Instanced geometry={parts.nutGeo} mats={parts.nuts} color="#b8bcc0" />
      <Instanced geometry={parts.washerGeo} mats={parts.washers} color="#cfd2d4" />
    </group>
  );
}

function Instanced({ geometry, mats, color }: { geometry: THREE.BufferGeometry; mats: THREE.Matrix4[]; color: string }) {
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ color, metalness: 0.8, roughness: 0.4 }), Math.max(1, mats.length));
    mats.forEach((x, i) => m.setMatrixAt(i, x));
    m.count = mats.length;
    m.instanceMatrix.needsUpdate = true;
    return m;
  }, [geometry, mats, color]);
  useEffect(() => () => (mesh.material as THREE.Material).dispose(), [mesh]);
  return <primitive object={mesh} />;
}

function IssueMarkers({ model }: { model: Model }) {
  const byId = useMemo(() => new Map(model.sliced.parts.map((p) => [p.id, p])), [model.sliced.parts]);
  const pts = model.issues
    .filter((i) => i.at && i.partId && (i.severity === 'error' || i.severity === 'warn'))
    .map((i) => {
      const part = byId.get(i.partId!);
      if (!part) return null;
      const w = planeToWorld(part.plane, i.at![0], i.at![1], -part.thickness / 2 - 2);
      return { p: w, sev: i.severity };
    })
    .filter(Boolean) as { p: [number, number, number]; sev: string }[];
  return (
    <group>
      {pts.slice(0, 300).map((x, k) => (
        <mesh key={k} position={x.p}>
          <boxGeometry args={[7, 7, 7]} />
          <meshBasicMaterial color={x.sev === 'error' ? '#c0281f' : '#d99a1e'} />
        </mesh>
      ))}
    </group>
  );
}

export default function Scene({ model, opts }: { model: Model; opts: SceneOpts }) {
  useEffect(() => {
    registerSceneMount();
  }, []);
  const v = model.v;
  const appearance = useStore((st) => st.project.appearance);
  // one material per bucket; plates in no bucket wear the main metal
  const looks = useMemo(() => bucketLooks(appearance, String(v.plateMaterial)), [appearance, v.plateMaterial]);
  const lookKey = JSON.stringify(looks);
  const materials = useMemo(
    () => new Map(Object.entries(looks).map(([id, l]) => [id, new THREE.MeshStandardMaterial({ color: l.color, metalness: l.metalness, roughness: l.roughness })])),
    [lookKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const material = materials.get(MAIN)!;
  const matFor = (p: Part) => materials.get(appearance?.assign[p.plateKey] ?? MAIN) ?? material;
  // re-read theme colours whenever the window appearance changes
  const theme = useStore((st) => st.ui.theme);
  const selMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: cssVar('--accent', '#d4521c'), metalness: 0.2, roughness: 0.5, emissive: new THREE.Color('#5a1a00') }), [theme]); // eslint-disable-line react-hooks/exhaustive-deps
  const platesLit = useStore((s) => s.ui.highlight === 'plates');
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);
  const bounds = useMemo(() => modelBounds(model), [model]);
  const gridY = useMemo(() => gridFloorY(bounds.size), [bounds.size]);
  const gridA = useMemo(() => cssVar('--grid-a', '#cfcbc2'), [theme]); // eslint-disable-line react-hooks/exhaustive-deps
  const gridB = useMemo(() => cssVar('--grid-b', '#a9a49a'), [theme]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useRef<THREE.Group>(null);
  const dragKey = opts.moveMode ? (moveTarget(model, opts.selected)?.key ?? null) : null;
  return (
    <>
      <Env />
      <color attach="background" args={[cssVar('--viewport', '#e6e3dc')]} />
      <ambientLight intensity={v.sunOn ? 0.28 : 0.35} />
      {v.sunOn ? <SunStudy3D model={model} /> : <ShadowSun model={model} />}
      <directionalLight position={[-900, 500, -600]} intensity={v.sunOn ? 0.18 : 0.45} />
      <ViewportGrid
          args={[Math.max(bounds.size * 6, 1200), Math.max(bounds.size * 6, 1200)]}
          cellSize={10}
          sectionSize={100}
          cellColor={gridA}
          sectionColor={gridB}
          cellThickness={0.6}
          sectionThickness={1}
          fadeDistance={Math.max(bounds.size * 4, 800)}
          fadeStrength={0.85}
          position={[0, gridY, 0]}
        />
      {v.baseOn && <Base model={model} xray={opts.xray} />}
      {model.sliced.parts.filter((p) => p.plateKey !== dragKey).map((p) => (
        <PlateMesh key={p.id} part={p} material={matFor(p)} selMaterial={selMaterial} selected={(!opts.onPaint && opts.selected === p.id) || platesLit} onSelect={opts.onSelect} onPaint={opts.onPaint} />
        ))}
      {/* the plate under the gizmo, carried rigidly while it is dragged */}
      <group ref={preview} matrixAutoUpdate={false}>
        {dragKey &&
          model.sliced.parts.filter((p) => p.plateKey === dragKey).map((p) => (
            <PlateMesh key={p.id} part={p} material={matFor(p)} selMaterial={selMaterial} selected onSelect={opts.onSelect} />
          ))}
      </group>
      {opts.moveMode && <PlateGizmo model={model} partId={opts.selected} preview={preview} />}
      <Etches parts={model.sliced.parts} />
      <Rods model={model} />
      <Insert model={model} />
      <PlacedObjects model={model} />
      {opts.showSource && model.source && v.stackSource === 'form' && (
        <mesh geometry={model.source.form.geometry}>
          <meshBasicMaterial color={cssVar('--info', '#2f5f9e')} wireframe transparent opacity={0.12} />
        </mesh>
      )}
      {opts.showMoulds && <Moulds model={model} explode={opts.explode} />}
      {opts.showIssues && <IssueMarkers model={model} />}
    </>
  );
}

/** The look of each bucket (and MAIN for plates in none). */
export function bucketLooks(app: Appearance | undefined, main: string) {
  const out: Record<string, { color: string; metalness: number; roughness: number }> = {};
  out[MAIN] = app ? lookOf(main, app.main?.finish, app.main?.color) : (METALS[main] ?? METALS.steel);
  for (const b of app?.buckets ?? []) out[b.id] = lookOf(b.material, b.finish, b.color);
  return out;
}

/** Key light with a shadow camera fitted to the design, so carved recesses and cavities read. */
function ShadowSun({ model }: { model: Model }) {
  const { center, size } = modelBounds(model);
  const dir = new THREE.Vector3(-0.75, 0.9, 0.35).normalize(); // rakes across from the far side so recesses cast visible shadows
  // the light aims at the origin (its default target); the frustum is sized to cover the whole piece around it
  const pos = dir.multiplyScalar(size * 1.6);
  const r = size * 0.75 + center.length();
  return (
    <directionalLight
      position={pos}
      intensity={1.7}
      castShadow
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0004}
      shadow-normalBias={0.6}
      shadow-camera-left={-r}
      shadow-camera-right={r}
      shadow-camera-top={r}
      shadow-camera-bottom={-r}
      shadow-camera-near={1}
      shadow-camera-far={size * 4}
    />
  );
}

/** Bounding size of the design, for camera framing. */
export function modelBounds(model: Model): { center: THREE.Vector3; size: number } {
  const v = model.v;
  const box = new THREE.Box3();
  if (v.baseOn) box.expandByPoint(new THREE.Vector3(-v.baseLength / 2, 0, -v.baseWidth / 2)).expandByPoint(new THREE.Vector3(v.baseLength / 2, v.baseHeight, v.baseWidth / 2));
  for (const p of model.sliced.parts) {
    const a = planeToWorld(p.plane, p.bbox.minX, p.bbox.minY);
    const b = planeToWorld(p.plane, p.bbox.maxX, p.bbox.maxY);
    box.expandByPoint(new THREE.Vector3(...a)).expandByPoint(new THREE.Vector3(...b));
  }
  if (model.insert) box.union(model.insert.form.bbox);
  if (box.isEmpty()) box.set(new THREE.Vector3(-300, 0, -300), new THREE.Vector3(300, 300, 300));
  const size = box.getSize(new THREE.Vector3());
  return { center: box.getCenter(new THREE.Vector3()), size: Math.max(size.x, size.y, size.z) };
}
