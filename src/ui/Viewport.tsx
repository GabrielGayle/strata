import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useStore, type Snap } from '../state/store';
import { stackFrame } from '../core/heightfield';
import type { Model } from '../core/pipeline';
import Scene, { modelBounds } from './Scene';
import { useModel, fmt } from './model';

export function snapDirection(model: Model, dir: Snap): { dir: THREE.Vector3; up: THREE.Vector3 } {
  const f = stackFrame(model.v);
  const up = new THREE.Vector3(0, 1, 0);
  switch (dir) {
    case 'front':
      // looking along the stack, through the plates
      return { dir: new THREE.Vector3(-f.stack[0], 0.04, -f.stack[1]).normalize(), up };
    case 'side':
      return { dir: new THREE.Vector3(f.across[0], 0.04, f.across[1]).normalize(), up };
    case 'top':
      // plan view from the front end: front plate at the bottom, stack running up the screen
      return { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(f.stack[0], 0, f.stack[1]) };
    default:
      return { dir: new THREE.Vector3(0.95, 0.75, 1.25).normalize(), up };
  }
}

export function CameraRig({ model, snap, ortho }: { model: Model; snap: { dir: Snap; n: number }; ortho: boolean }) {
  const { camera, controls, size } = useThree() as any;
  const first = useRef(true);
  useEffect(() => {
    if (!controls) return;
    const { center, size: s } = modelBounds(model);
    const { dir, up } = snapDirection(model, snap.dir);
    const fov = 32;
    const dist = (s * 0.8) / Math.tan(((fov / 2) * Math.PI) / 180);
    camera.up.copy(up);
    camera.position.copy(center.clone().add(dir.clone().multiplyScalar(dist)));
    controls.target.copy(center);
    if (camera.isOrthographicCamera) {
      camera.zoom = Math.min(size.width, size.height) / (s * 1.35);
      camera.updateProjectionMatrix();
    }
    controls.update();
    first.current = false;
    // re-frame only on explicit snaps or camera type changes, not on every regenerate
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.n, snap.dir, ortho, controls, camera]);
  return null;
}

export default function Viewport() {
  const model = useModel();
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const v = model.v;
  const snapTo = (dir: Snap) => setUi({ snap: { dir, n: ui.snap.n + 1 } });
  const opts = useMemo(
    () => ({
      selected: ui.selected,
      onSelect: (id: string | null) => setUi({ selected: id }),
      showMoulds: ui.showMoulds,
      explode: ui.explode,
      xray: ui.xray,
      showIssues: ui.showIssues,
      showSource: ui.showSource,
    }),
    [ui.selected, ui.showMoulds, ui.explode, ui.xray, ui.showIssues, ui.showSource, setUi],
  );
  const heights = model.sliced.parts.map((p) => p.bbox.maxY);
  const hMin = heights.length ? Math.min(...heights) : 0;
  const hMax = heights.length ? Math.max(...heights) : 0;
  return (
    <>
      <Canvas shadows="percentage" dpr={[1, 2]} gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }} onPointerMissed={() => setUi({ selected: null })} style={{ position: 'absolute', inset: 0 }}>
        <PerspectiveCamera makeDefault={!ui.ortho} fov={32} near={1} far={60000} position={[1500, 1100, 1800]} />
        <OrthographicCamera makeDefault={ui.ortho} near={-50000} far={50000} position={[1500, 1100, 1800]} zoom={0.6} />
        <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
        <CameraRig model={model} snap={ui.snap} ortho={ui.ortho} />
        <Scene model={model} opts={opts} />
      </Canvas>
      <div className="overlay tl">
        {(['iso', 'front', 'side', 'top'] as Snap[]).map((d) => (
          <button key={d} className={`btn sm ${ui.snap.dir === d ? 'on' : ''}`} onClick={() => snapTo(d)} title={d === 'front' ? 'Look through the stack (front-view image)' : d === 'side' ? 'Look at the plate faces edge-on (profile)' : undefined}>
            {d === 'iso' ? 'Iso' : d === 'front' ? 'Front' : d === 'side' ? 'Side' : 'Top'}
          </button>
        ))}
        <button className={`btn sm ${ui.ortho ? 'on' : ''}`} onClick={() => setUi({ ortho: !ui.ortho })} title="Orthographic camera">
          Ortho
        </button>
      </div>
      <div className="overlay tr col">
        <button className={`btn sm ${ui.xray ? 'on' : ''}`} onClick={() => setUi({ xray: !ui.xray })} title="See the plates' embedded tabs through the concrete">
          X-ray concrete
        </button>
        <button className={`btn sm ${ui.showMoulds ? 'on' : ''}`} onClick={() => setUi({ showMoulds: !ui.showMoulds })}>
          Moulds
        </button>
        {ui.showMoulds && (
          <button className={`btn sm ${ui.explode ? 'on' : ''}`} onClick={() => setUi({ explode: !ui.explode })}>
            Exploded
          </button>
        )}
        <button className={`btn sm ${ui.showIssues ? 'on' : ''}`} onClick={() => setUi({ showIssues: !ui.showIssues })}>
          Issue markers
        </button>
        {v.stackSource === 'form' && (
          <button className={`btn sm ${ui.showSource ? 'on' : ''}`} onClick={() => setUi({ showSource: !ui.showSource })}>
            Source ghost
          </button>
        )}
      </div>
      <div className="overlay bl info">
        <span>
          base {fmt(v.baseLength, 0)} × {fmt(v.baseWidth, 0)} × {fmt(v.baseHeight, 0)} mm
        </span>
        <span>
          {model.sliced.plates.length} plates × {fmt(v.thickness, 1)} mm {v.sliceMode !== 'radial' ? `@ ${fmt(v.pitch, 2)} pitch` : 'radial'}
        </span>
        <span>
          plate height {fmt(hMin, 0)}–{fmt(hMax, 0)} mm
        </span>
        {ui.selected && <span style={{ color: 'var(--accent)' }}>selected {ui.selected}</span>}
      </div>
      {v.pourView !== 'plain' && model.pour.rows.length > 0 && (
        <div className="overlay br info">
          {[...model.pour.rows].reverse().map((r) => (
            <span key={r.id} className="legend">
              <i style={{ background: r.color }} /> {r.name} {fmt(r.height, 0)} mm
            </span>
          ))}
        </div>
      )}
    </>
  );
}
