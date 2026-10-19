// A small 3D view of the plate tops for judging the top-surface relief.
// The camera is driven by a tilt angle: 0° looks straight down, higher values
// drop towards the front edge so the steps and risers read in depth.
import { memo, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import type { Model } from '../core/pipeline';
import type { Part } from '../core/slicer';
import { topAt } from '../core/slicer';
import { planeToWorld } from '../core/section';
import { stackFrame } from '../core/heightfield';
import { partGeometry } from '../core/partMesh';
import { Env } from './Scene';
import { METALS } from './materials';

interface Frame {
  center: THREE.Vector3;
  span: number;
  /** extent across the stack (screen width) and along it (screen height at 0°) */
  acrossExt: number;
  stackExt: number;
  lo: number;
  hi: number;
}

function frameOf(parts: Part[], stack: [number, number]): Frame | null {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, lo = Infinity, hi = -Infinity;
  for (const p of parts) {
    for (let u = p.bbox.minX; u <= p.bbox.maxX; u += 3) {
      const t = topAt(p.shape, u);
      if (t === null || t <= 0) continue;
      const w = planeToWorld(p.plane, u, t);
      x0 = Math.min(x0, w[0]);
      x1 = Math.max(x1, w[0]);
      z0 = Math.min(z0, w[2]);
      z1 = Math.max(z1, w[2]);
      lo = Math.min(lo, w[1]);
      hi = Math.max(hi, w[1]);
    }
  }
  if (!Number.isFinite(x0)) return null;
  const alongX = Math.abs(stack[0]) > 0.5;
  return {
    center: new THREE.Vector3((x0 + x1) / 2, (lo + hi) / 2, (z0 + z1) / 2),
    span: Math.max(x1 - x0, z1 - z0),
    acrossExt: alongX ? z1 - z0 : x1 - x0,
    stackExt: alongX ? x1 - x0 : z1 - z0,
    lo,
    hi,
  };
}

/** Plate material that can darken by height, so the impression band reads from any angle. */
function makePlateMaterial(color: string, metalness: number, roughness: number) {
  const uniforms = { uLo: { value: 0 }, uHi: { value: 1 }, uTint: { value: 1 } };
  const mat = new THREE.MeshStandardMaterial({ color, metalness, roughness });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWY;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWY;\nuniform float uLo;\nuniform float uHi;\nuniform float uTint;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\nif (uTint > 0.5) { float t = clamp((vWY - uLo) / max(uHi - uLo, 0.001), 0.0, 1.0); diffuseColor.rgb *= mix(0.22, 1.3, t * t); }',
      );
  };
  return { mat, uniforms };
}

const Plate = memo(function Plate({ part, material }: { part: Part; material: THREE.Material }) {
  const geo = useMemo(() => partGeometry(part), [part]);
  useEffect(() => () => geo.dispose(), [geo]);
  return <mesh geometry={geo} material={material} castShadow receiveShadow />;
});

function Rig({ frame, tilt, plateHeight, stack }: { frame: Frame; tilt: number; plateHeight: number; stack: [number, number] }) {
  const { camera, size, invalidate } = useThree();
  useEffect(() => {
    const t = (tilt * Math.PI) / 180;
    // 0° = plan view with the front plate at the bottom; tilting drops the camera towards the
    // front so it looks across the plates and the stepped tops read as relief
    const S = new THREE.Vector3(stack[0], 0, stack[1]);
    const dir = new THREE.Vector3(0, Math.cos(t), 0).addScaledVector(S, -Math.sin(t));
    const cam = camera as THREE.OrthographicCamera;
    const D = frame.span * 3;
    cam.position.copy(frame.center).addScaledVector(dir, D);
    cam.up.copy(S).multiplyScalar(Math.cos(t)).add(new THREE.Vector3(0, Math.sin(t), 0));
    cam.near = 1;
    cam.far = D * 2.5;
    cam.lookAt(frame.center);
    const projH = frame.stackExt * Math.cos(t) + plateHeight * Math.sin(t);
    cam.zoom = Math.min(size.width / (frame.acrossExt * 1.1), size.height / (Math.max(1, projH) * 1.15));
    cam.updateProjectionMatrix();
    invalidate();
  }, [camera, size, frame, tilt, plateHeight, stack, invalidate]);
  return null;
}

export default function ReliefPreview({ model, tilt, tint }: { model: Model; tilt: number; tint: boolean }) {
  const parts = model.sliced.parts;
  const f = stackFrame(model.v);
  const stack: [number, number] = [f.stack[0], f.stack[1]];
  const frame = useMemo(() => frameOf(parts, stack), [parts, stack[0], stack[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const metal = METALS[model.v.plateMaterial] ?? METALS.steel;
  const { mat, uniforms } = useMemo(() => makePlateMaterial(metal.color, metal.metalness, metal.roughness), [metal]);
  useEffect(() => () => mat.dispose(), [mat]);
  if (!frame) return <div className="empty">No plates to preview.</div>;
  uniforms.uLo.value = frame.lo;
  uniforms.uHi.value = frame.hi;
  uniforms.uTint.value = tint ? 1 : 0;
  const v = model.v;
  // aimed at the origin (the light's default target); the frustum covers the piece around it
  const sun = new THREE.Vector3(-stack[1] - 0.35 * stack[0], 0.75, stack[0] - 0.35 * stack[1]).normalize().multiplyScalar(frame.span * 1.5);
  const r = frame.span * 0.8 + frame.center.length();
  return (
    <Canvas orthographic frameloop="demand" shadows="percentage" dpr={[1, 2]} gl={{ antialias: true, alpha: true }} style={{ position: 'absolute', inset: 0 }}>
      <Rig frame={frame} tilt={tilt} stack={stack} plateHeight={frame.hi - (v.baseOn ? v.baseHeight : 0) + (v.baseOn ? v.baseHeight * 0.6 : 0)} />
      <Env />
      <ambientLight intensity={0.3} />
      {/* low raking light from the left so every riser throws a shadow */}
      <directionalLight
        position={sun}
        intensity={2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.5}
        shadow-camera-left={-r}
        shadow-camera-right={r}
        shadow-camera-top={r}
        shadow-camera-bottom={-r}
        shadow-camera-near={1}
        shadow-camera-far={frame.span * 4}
      />
      {v.baseOn && (
        <mesh position={[0, v.baseHeight / 2, 0]} receiveShadow>
          <boxGeometry args={[v.baseLength, v.baseHeight, v.baseWidth]} />
          <meshStandardMaterial color="#b9b2a7" roughness={0.95} />
        </mesh>
      )}
      {parts.map((p) => (
        <Plate key={p.id} part={p} material={mat} />
      ))}
    </Canvas>
  );
}
