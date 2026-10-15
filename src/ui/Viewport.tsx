import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useStore, type Snap } from '../state/store';
import { stackFrame } from '../core/heightfield';
import type { Model } from '../core/pipeline';
import Scene, { modelBounds } from './Scene';
import { gizmoIsBusy, moveTarget } from './PlateGizmo';
import { useModel, fmt } from './model';
import AppearancePanel, { paintClick } from './AppearancePanel';
import ObjectsPanel from './ObjectsPanel';
import { SunBar } from './SunStudy';

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

export function CameraRig({ model, snap, ortho }: { model: Model; snap: { dir: Snap; n: number; follow?: boolean }; ortho: boolean }) {
  const { camera, controls, size } = useThree() as any;
  // a "follow" snap (preset load) frames again once the new model arrives a frame later
  const pending = useRef<{ n: number; model: Model } | null>(null);
  const frame = (m: Model) => {
    const { center, size: s } = modelBounds(m);
    const { dir, up } = snapDirection(m, snap.dir);
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
  };
  useEffect(() => {
    if (!controls) return;
    frame(model);
    pending.current = snap.follow ? { n: snap.n, model } : null;
    // re-frame only on explicit snaps or camera type changes, not on every regenerate
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.n, snap.dir, ortho, controls, camera]);
  useEffect(() => {
    const p = pending.current;
    if (!controls || !p || p.n !== snap.n || p.model === model) return;
    pending.current = null;
    frame(model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);
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
      moveMode: ui.moveMode && !ui.paintMode,
      onPaint: ui.paintMode ? (key: string, shift: boolean) => paintClick(model, key, shift) : undefined,
    }),
    [ui.selected, ui.showMoulds, ui.explode, ui.xray, ui.showIssues, ui.showSource, ui.moveMode, ui.paintMode, model, setUi],
  );
  const bucketed = Object.keys(useStore((s) => s.project.appearance?.assign) ?? {}).length;
  const movedCount = Object.keys(useStore((s) => s.project.moves) ?? {}).length;
  const objectCount = useStore((s) => s.project.objects?.length ?? 0);
  useEffect(() => {
    if (!ui.moveMode) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.closest('input, textarea, select, [contenteditable="true"]')) return;
      const k = e.key.toLowerCase();
      const st = useStore.getState().ui;
      if (k === 'w') setUi({ gizmoMode: 'translate' });
      else if (k === 'e') setUi({ gizmoMode: 'rotate' });
      else if (k === 'q') setUi({ gizmoSpace: st.gizmoSpace === 'world' ? 'local' : 'world' });
      else if (k === 'escape') setUi({ selected: null });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui.moveMode, setUi]);
  const heights = model.sliced.parts.map((p) => p.bbox.maxY);
  const hMin = heights.length ? Math.min(...heights) : 0;
  const hMax = heights.length ? Math.max(...heights) : 0;
  return (
    <>
      <Canvas shadows="percentage" dpr={[1, 2]} gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }} onPointerMissed={() => !gizmoIsBusy() && !ui.paintMode && setUi({ selected: null })} style={{ position: 'absolute', inset: 0 }}>
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
        <button className={`btn sm ${ui.paintMode ? 'on' : ''}`} onClick={() => setUi({ paintMode: !ui.paintMode, moveMode: false, objectsMode: false })} title="Material buckets: click plates to choose what each is cut from (shift-click a run)">
          Materials{bucketed ? ` (${bucketed})` : ''}
        </button>
        <button className={`btn sm ${ui.moveMode ? 'on' : ''}`} onClick={() => setUi({ moveMode: !ui.moveMode, paintMode: false, objectsMode: false })} title="Click a plate, then drag the gizmo to move or turn it (W move, E rotate, Q world / local)">
          Move plates{movedCount ? ` (${movedCount})` : ''}
        </button>
        <button className={`btn sm ${ui.objectsMode ? 'on' : ''}`} onClick={() => setUi({ objectsMode: !ui.objectsMode, paintMode: false, moveMode: false })} title="Place postcards, boxes and other objects; each is cut out of the plates it passes through">
          Objects{objectCount ? ` (${objectCount})` : ''}
        </button>
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
          {model.sliced.plates.length} {v.sliceMode === 'flat' ? 'layers' : 'plates'} × {fmt(v.thickness, 1)} mm {v.sliceMode === 'flat' ? 'face to face' : v.sliceMode !== 'radial' ? `@ ${fmt(v.pitch, 2)} pitch` : 'radial'}
        </span>
        <span>
          {v.sliceMode === 'flat' ? `stack height ${fmt(model.sliced.plates.length * v.thickness, 0)} mm` : `plate height ${fmt(hMin, 0)}–${fmt(hMax, 0)} mm`}
        </span>
        {ui.selected && <span style={{ color: 'var(--accent)' }}>selected {ui.selected}</span>}
      </div>
      {ui.moveMode && !ui.paintMode && <MovePanel />}
      {ui.paintMode && <AppearancePanel />}
      {ui.objectsMode && <ObjectsPanel />}
      {v.sunOn && <SunBar model={model} />}
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

/** What the move gizmo is acting on, and the ways back. */
function MovePanel() {
  const model = useModel();
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const moves = useStore((s) => s.project.moves);
  const movePart = useStore((s) => s.movePart);
  const resetMoves = useStore((s) => s.resetMoves);
  const target = moveTarget(model, ui.selected);
  const key = target?.key;
  const m = key ? moves?.[key] : undefined;
  const count = Object.keys(moves ?? {}).length;
  const deg = m ? (2 * Math.acos(Math.min(1, Math.abs(m.q[3]))) * 180) / Math.PI : 0;
  const label = target?.label;
  return (
    <div className="overlay tc movepanel">
      <div className="mp-row">
        <button className={`btn sm ${ui.gizmoMode === 'translate' ? 'on' : ''}`} onClick={() => setUi({ gizmoMode: 'translate' })} title="Move (W)">
          Move
        </button>
        <button className={`btn sm ${ui.gizmoMode === 'rotate' ? 'on' : ''}`} onClick={() => setUi({ gizmoMode: 'rotate' })} title="Rotate (E)">
          Rotate
        </button>
        <button className="btn sm" onClick={() => setUi({ gizmoSpace: ui.gizmoSpace === 'world' ? 'local' : 'world' })} title="Gizmo axes (Q)">
          {ui.gizmoSpace === 'world' ? 'World axes' : 'Plate axes'}
        </button>
        <button className="btn sm" disabled={!m} onClick={() => key && movePart(key, null)} title="Put this plate back where it was designed">
          Reset plate
        </button>
        <button className="btn sm" disabled={!count} onClick={resetMoves} title="Put every moved plate back">
          Reset all
        </button>
      </div>
      <div className="mp-info">
        {!target
          ? ui.selected
            ? 'The support ring follows the plates; pick a plate to move it.'
            : 'Click a plate (or cross plate) to move it.'
          : m
            ? `${label}: moved ${fmt(m.t[0], 1)}, ${fmt(m.t[1], 1)}, ${fmt(m.t[2], 1)} mm, turned ${fmt(deg, 1)}°`
            : `${label}: where it was designed`}
        {count > 0 && ` · ${count} plate${count > 1 ? 's' : ''} moved`}
      </div>
    </div>
  );
}
