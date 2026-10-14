import { memo, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { Edges, Grid } from '@react-three/drei';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Model } from '../core/pipeline';
import type { Part } from '../core/slicer';
import type { MouldPart } from '../core/mould';
import { etchSegments, extrudeOnPlane, extrudePlan } from '../core/geometry3d';
import { planeToWorld } from '../core/section';
import { shapeBBox } from '../core/geom2d';
import { makeConcreteMaterial, METALS, PLY, type Band } from './materials';

export interface SceneOpts {
  selected: string | null;
  onSelect?: (id: string | null) => void;
  showMoulds: boolean;
  explode: boolean;
  xray: boolean;
  showIssues: boolean;
  showSource: boolean;
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

const PlateMesh = memo(function PlateMesh({ part, material, selMaterial, selected, onSelect }: { part: Part; material: THREE.Material; selMaterial: THREE.Material; selected: boolean; onSelect?: (id: string) => void }) {
  const geo = useMemo(() => extrudeOnPlane(part.shape, part.thickness, part.plane), [part]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh
      geometry={geo}
      material={selected ? selMaterial : material}
      onClick={
        onSelect
          ? (e: ThreeEvent<MouseEvent>) => {
              if (e.delta > 4) return;
              e.stopPropagation();
              onSelect(part.id);
            }
          : undefined
      }
    />
  );
});

function Etches({ parts }: { parts: Part[] }) {
  const geo = useMemo(() => {
    const geos = parts.filter((p) => p.etch.length || p.labelPaths.length).map((p) => etchSegments([...p.etch, ...p.labelPaths], p.thickness, p.plane));
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
  }, [parts]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#1b1b1b" transparent opacity={0.75} />
    </lineSegments>
  );
}

function Base({ model, xray }: { model: Model; xray: boolean }) {
  const v = model.v;
  const mat = useMemo(() => makeConcreteMaterial(), []);
  const geo = useMemo(() => {
    const g = new THREE.BoxGeometry(v.baseLength, v.baseHeight, v.baseWidth);
    g.translate(0, v.baseHeight / 2, 0);
    return g;
  }, [v.baseLength, v.baseHeight, v.baseWidth]);
  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => () => mat.dispose(), [mat]);
  const bands: Band[] =
    v.pourView === 'plain' || !model.pour.rows.length ? [{ top: 1e9, color: v.concreteTint }] : model.pour.rows.map((r) => ({ top: r.y1, color: r.color }));
  mat.setBands(bands, v.pourView === 'eroded' ? v.erodeAmount : 0);
  mat.transparent = xray;
  mat.opacity = xray ? 0.28 : 1;
  mat.depthWrite = !xray;
  return (
    <mesh geometry={geo} material={mat}>
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
      <mesh geometry={ins.form.geometry}>
        <meshBasicMaterial color={cssVar('--accent', '#d4521c')} wireframe transparent opacity={0.35} />
      </mesh>
    );
  if (v.insMaterial === 'metal') {
    const m = METALS.steel;
    return (
      <mesh geometry={ins.form.geometry}>
        <meshStandardMaterial color={m.color} metalness={m.metalness} roughness={m.roughness} />
      </mesh>
    );
  }
  mat.setBands([{ top: 1e9, color: v.insTint }], 0);
  return <mesh geometry={ins.form.geometry} material={mat} />;
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
  const v = model.v;
  const metal = METALS[v.plateMaterial] ?? METALS.steel;
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: metal.color, metalness: metal.metalness, roughness: metal.roughness }), [metal]);
  const selMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: cssVar('--accent', '#d4521c'), metalness: 0.2, roughness: 0.5, emissive: new THREE.Color('#5a1a00') }), []);
  useEffect(() => () => material.dispose(), [material]);
  const gridA = useMemo(() => cssVar('--grid-a', '#cfcbc2'), []);
  const gridB = useMemo(() => cssVar('--grid-b', '#a9a49a'), []);
  return (
    <>
      <Env />
      <ambientLight intensity={0.35} />
      <directionalLight position={[600, 1400, 900]} intensity={1.6} />
      <directionalLight position={[-900, 500, -600]} intensity={0.45} />
      <Grid args={[20000, 20000]} cellSize={10} sectionSize={100} cellColor={gridA} sectionColor={gridB} cellThickness={0.6} sectionThickness={1} fadeDistance={7000} fadeStrength={1.5} infiniteGrid position={[0, -0.05, 0]} />
      {v.baseOn && <Base model={model} xray={opts.xray} />}
      {model.sliced.parts.map((p) => (
        <PlateMesh key={p.id} part={p} material={material} selMaterial={selMaterial} selected={opts.selected === p.id} onSelect={opts.onSelect} />
      ))}
      <Etches parts={model.sliced.parts} />
      <Insert model={model} />
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
