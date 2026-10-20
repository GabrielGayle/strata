import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useStore, type Snap } from '../state/store';
import { stackFrame } from '../core/heightfield';
import { isWall, mountFrame, roomToModel } from '../core/mount';
import type { Model } from '../core/pipeline';
import Scene, { cssVar, modelBounds } from './Scene';
import CameraClipSync from './CameraClipSync';
import { clipPlanesForBounds } from './viewportClip';
import { gizmoIsBusy, moveTarget, useGizmoClearance } from './PlateGizmo';
import { useModel, fmt } from './model';
import { isMapDepth } from '../core/mapPlateHeight';
import { plateOutlineYRangeMm } from '../core/slicer';
import { flatStackIsCapped, formatMapHeightCaption } from '../core/mapGeometryReadout';
import { paintClick } from './AppearancePanel';
import { SunBar } from './SunStudy';
import { MeasureTool, useMeasure } from './Measure';
import { openSideTab } from './sidebarState';
import ViewportSidebar from './ViewportSidebar';
import {
  VIEWPORT_CAM_POS,
  VIEWPORT_DPR,
  VIEWPORT_GL,
  VIEWPORT_RESIZE,
  VIEWPORT_STYLE,
  ViewportParkedContext,
} from './viewportKeepAlive';
import ViewportLayersToolbar from './ViewportLayersToolbar';
import ViewAidsToolbar from './ViewAidsToolbar';
import { DEFAULT_VIEWPORT_LAYERS } from './viewportLayers';
import { setLiveCamera, setLiveViewFromOffset } from './liveView';
import ViewFromPointPanel, { ViewFromPointRig } from './ViewFromPoint';

export function snapDirection(model: Model, dir: Snap, mapNorthUp = false): { dir: THREE.Vector3; up: THREE.Vector3 } {
  if (isWall(model.v)) return wallSnapDirection(model, dir, mapNorthUp);
  const f = stackFrame(model.v);
  const up = new THREE.Vector3(0, 1, 0);
  switch (dir) {
    case 'front':
      // From the north end (−X) looking south. Map world +Z is west, so east is on the left.
      return { dir: new THREE.Vector3(-f.stack[0], 0.04, -f.stack[1]).normalize(), up };
    case 'side':
      return { dir: new THREE.Vector3(f.across[0], 0.04, f.across[1]).normalize(), up };
    case 'top':
      // Maps: north / S-01 (front) at the top. East is screen-right because +Z is west
      // (South × Up = West). Do not roll this camera to fake an E–W flip.
      // Other designs keep the front plate at the bottom, stack running up the screen.
      return {
        dir: new THREE.Vector3(0, 1, 0),
        up: mapNorthUp
          ? new THREE.Vector3(-f.stack[0], 0, -f.stack[1])
          : new THREE.Vector3(f.stack[0], 0, f.stack[1]),
      };
    case 'shelf':
      if (model.shelfEye) return { dir: new THREE.Vector3(...model.shelfEye), up };
      return { dir: new THREE.Vector3(0.95, 0.75, 1.25).normalize(), up };
    default:
      return { dir: new THREE.Vector3(0.95, 0.75, 1.25).normalize(), up };
  }
}

/**
 * A wall piece's views, in the room: Front faces the wall, Side looks along it from
 * the right, Top looks down on the piece with the wall at the top of the screen.
 */
function wallSnapDirection(model: Model, dir: Snap, map: boolean): { dir: THREE.Vector3; up: THREE.Vector3 } {
  const f = mountFrame(model.v, map);
  const room = (x: number, y: number, z: number) => new THREE.Vector3(...roomToModel(f, [x, y, z]));
  const up = room(0, 1, 0);
  switch (dir) {
    case 'front':
      return { dir: room(0, 0.04, 1).normalize(), up };
    case 'side':
      return { dir: room(1, 0.04, 0.02).normalize(), up };
    case 'top':
      return { dir: room(0, 1, 0.02).normalize(), up: room(0, 0, -1) };
    case 'shelf':
      if (model.shelfEye) return { dir: new THREE.Vector3(...model.shelfEye), up };
      return { dir: room(0.95, 0.75, 1.25).normalize(), up };
    default:
      return { dir: room(0.95, 0.75, 1.25).normalize(), up };
  }
}

/** Orbit about the real vertical: a wall piece turns about the wall's up, not the model's +Y. */
export function useOrbitUp(controls: unknown, up: THREE.Vector3) {
  useEffect(() => {
    const c = controls as { _quat?: THREE.Quaternion; _quatInverse?: THREE.Quaternion } | null;
    if (!c?._quat || !c._quatInverse) return;
    c._quat.setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
    c._quatInverse.copy(c._quat).invert();
  }, [controls, up.x, up.y, up.z]); // eslint-disable-line react-hooks/exhaustive-deps
}

function ResumeWhenVisible({ parked }: { parked: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!parked) invalidate();
  }, [parked, invalidate]);
  return null;
}

export function CameraRig({ model, snap, ortho, mapNorthUp }: { model: Model; snap: { dir: Snap; n: number; follow?: boolean }; ortho: boolean; mapNorthUp?: boolean }) {
  const { camera, controls, size } = useThree() as any;
  const pointViewN = useStore((s) => s.ui.pointView?.n ?? 0);
  // a "follow" snap (preset load) frames again once the new model arrives a frame later
  const pending = useRef<{ n: number; model: Model } | null>(null);
  const orbitUp = useMemo(() => new THREE.Vector3(...mountFrame(model.v, mapNorthUp).up), [model.v.mount, model.v.wallTop, model.v.wallPlates, model.v.sliceAxis, model.v.sliceMode, mapNorthUp]); // eslint-disable-line react-hooks/exhaustive-deps
  useOrbitUp(controls, orbitUp);
  const frame = (m: Model) => {
    const { center, size: s } = modelBounds(m);
    const { near, far, orthoSpan } = clipPlanesForBounds(s);
    const { dir, up } = snapDirection(m, snap.dir, mapNorthUp);
    const fov = 32;
    const dist = (s * 0.8) / Math.tan(((fov / 2) * Math.PI) / 180);
    camera.up.copy(up);
    camera.position.copy(center.clone().add(dir.clone().multiplyScalar(dist)));
    controls.target.copy(center);
    if (camera.isPerspectiveCamera) {
      camera.near = near;
      camera.far = far;
    } else if (camera.isOrthographicCamera) {
      camera.near = -orthoSpan;
      camera.far = orthoSpan;
      camera.zoom = Math.min(size.width, size.height) / (s * 1.35);
    }
    camera.updateProjectionMatrix();
    controls.update();
  };
  useEffect(() => {
    if (!controls) return;
    // A View-from-point pose owns the camera until Iso/Front/Side/Top (which clears it).
    if (pointViewN > 0 && !snap.follow) return;
    frame(model);
    pending.current = snap.follow ? { n: snap.n, model } : null;
    // re-frame only on explicit snaps, camera type, map north-up (top view flips) or table / wall
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.n, snap.dir, ortho, controls, camera, mapNorthUp, pointViewN, orbitUp]);
  useEffect(() => {
    const p = pending.current;
    if (!controls || !p || p.n !== snap.n || p.model === model) return;
    if (pointViewN > 0 && !snap.follow) return;
    pending.current = null;
    frame(model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, pointViewN]);
  return null;
}

function LiveViewTracker() {
  const { camera, controls, size } = useThree() as { camera: THREE.Camera; size: { width: number; height: number }; controls?: { target: THREE.Vector3; addEventListener: (t: string, fn: () => void) => void; removeEventListener: (t: string, fn: () => void) => void } };
  useEffect(() => {
    const sync = () => {
      if (!controls) return;
      const p = camera.position;
      const t = controls.target;
      setLiveViewFromOffset(p.x - t.x, p.y - t.y, p.z - t.z);
      const persp = camera as THREE.PerspectiveCamera;
      setLiveCamera({
        position: [p.x, p.y, p.z],
        target: [t.x, t.y, t.z],
        up: [camera.up.x, camera.up.y, camera.up.z],
        // an orthographic view is rendered with the 3D view's usual lens
        fov: persp.isPerspectiveCamera ? persp.fov : 32,
        aspect: size.width > 0 && size.height > 0 ? size.width / size.height : 1.5,
        ortho: !persp.isPerspectiveCamera,
      });
    };
    sync();
    controls?.addEventListener('change', sync);
    return () => controls?.removeEventListener('change', sync);
  }, [camera, controls, size]);
  return null;
}

export default function Viewport() {
  const model = useModel();
  const modelRef = useRef(model);
  modelRef.current = model;
  const parked = useContext(ViewportParkedContext);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const setParam = useStore((s) => s.setParam);
  const v = model.v;
  const snapTo = (dir: Snap) => setUi({ snap: { dir, n: ui.snap.n + 1 }, pointViewFov: undefined, pointView: undefined });
  const [fromPoint, setFromPoint] = useState(false);
  const onSelect = useCallback(
    (id: string | null) => {
      // with the object tabs open, clicking a shelf picks it there (its arrows move it)
      const part = id && useStore.getState().ui.objectsMode ? modelRef.current.sliced.parts.find((p) => p.id === id) : undefined;
      const shelf = part?.family === 'H' ? modelRef.current.shelfCuts?.[part.index] : undefined;
      if (shelf) {
        openSideTab('shelves');
        setUi({ objectSel: shelf.id });
      } else setUi({ selected: id });
    },
    [setUi],
  );
  const onPaint = useCallback((key: string, shift: boolean) => paintClick(modelRef.current, key, shift), []);
  const opts = useMemo(
    () => ({
      selected: ui.selected,
      onSelect: ui.measureMode || ui.placing ? undefined : onSelect,
      showMoulds: ui.showMoulds,
      explode: ui.explode,
      xray: ui.xray,
      showIssues: ui.showIssues,
      showSource: ui.showSource,
      viewportLayers: ui.viewportLayers ?? DEFAULT_VIEWPORT_LAYERS,
      viewAids: ui.viewAids,
      moveMode: ui.moveMode && !ui.paintMode && !ui.measureMode,
      onPaint: ui.paintMode && !ui.measureMode ? onPaint : undefined,
    }),
    [ui.selected, ui.showMoulds, ui.explode, ui.xray, ui.showIssues, ui.showSource, ui.viewportLayers, ui.viewAids, ui.moveMode, ui.paintMode, ui.measureMode, ui.placing, onSelect, onPaint],
  );
  // placing a shelf or candle: Esc stops, and so does leaving the object tabs
  const placing = ui.placing;
  useEffect(() => {
    if (!placing) return;
    if (!ui.objectsMode || ui.measureMode) {
      setUi({ placing: null });
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setUi({ placing: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placing, ui.objectsMode, ui.measureMode, setUi]);
  const bucketed = Object.keys(useStore((s) => s.project.appearance?.assign) ?? {}).length;
  const movedCount = Object.keys(useStore((s) => s.project.moves) ?? {}).length;
  const objectCount = useStore((s) => s.project.objects?.length ?? 0);
  useEffect(() => {
    if (parked || !ui.moveMode) return;
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
  }, [parked, ui.moveMode, setUi]);
  // measuring tape: M toggles it, Esc drops a half-made measurement and then leaves, Delete removes the latest
  useEffect(() => {
    if (parked) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.closest('input, textarea, select, [contenteditable="true"]')) return;
      const k = e.key.toLowerCase();
      const on = useStore.getState().ui.measureMode;
      const ms = useMeasure.getState();
      if (k === 'm') setUi({ measureMode: !on, moveMode: false, paintMode: false, objectsMode: false });
      else if (k === 'escape' && on) {
        if (ms.pending) ms.setPending(null);
        else setUi({ measureMode: false });
      } else if ((k === 'delete' || (k === 'backspace' && on)) && ms.list.length) ms.removeLast();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parked, setUi]);
  const toggleViewportLayer = useStore((s) => s.toggleViewportLayer);
  useEffect(() => {
    if (parked) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || !e.altKey || !e.shiftKey || el.closest('input, textarea, select, [contenteditable="true"]')) return;
      const k = e.key.toLowerCase();
      if (k === 'g') toggleViewportLayer('grid');
      else if (k === 'p') toggleViewportLayer('plates');
      else if (k === 'l') toggleViewportLayer('labels');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parked, toggleViewportLayer]);
  const heights = model.sliced.parts.map((p) => p.bbox.maxY);
  const hMin = heights.length ? Math.min(...heights) : 0;
  const hMax = heights.length ? Math.max(...heights) : 0;
  const boundSize = modelBounds(model).size;
  const clip = useMemo(() => clipPlanesForBounds(boundSize), [boundSize]);
  const mapFace = useStore((s) => isMapDepth(s.project.images.top?.depth) && !!s.project.images.top?.map);
  const terrainY = mapFace && v.sliceMode !== 'flat' ? plateOutlineYRangeMm(model.sliced.plates) : null;
  const stackCapped =
    mapFace && v.sliceMode === 'flat' && flatStackIsCapped(model.hf?.max, model.sliced.plates.length, v.thickness);
  return (
    <div className="vp-shell">
      <div className="vp-main">
        {/* Linear clip + ViewportGrid depthWrite. logarithmicDepthBuffer writes gl_FragDepth (kills early-Z) and drei Grid has no logdepthbuf chunks. */}
        <Canvas
          shadows="percentage"
          dpr={VIEWPORT_DPR}
          gl={VIEWPORT_GL}
          frameloop={parked ? 'never' : 'always'}
          resize={VIEWPORT_RESIZE}
          onCreated={({ gl }) => {
            gl.setClearColor(cssVar('--viewport', '#e6e3dc'), 1);
          }}
          onPointerMissed={() => !gizmoIsBusy() && !ui.paintMode && !ui.measureMode && setUi({ selected: null })}
          style={VIEWPORT_STYLE}
        >
          <ResumeWhenVisible parked={parked} />
          <PerspectiveCamera
            makeDefault={!ui.ortho}
            fov={ui.pointViewFov ?? 32}
            near={clip.near}
            far={ui.pointView ? Math.max(clip.far, 50_000) : clip.far}
            position={VIEWPORT_CAM_POS}
          />
          <OrthographicCamera makeDefault={ui.ortho} near={-clip.orthoSpan} far={clip.orthoSpan} position={VIEWPORT_CAM_POS} zoom={0.6} />
          <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
          <LiveViewTracker />
          <CameraClipSync boundSize={boundSize} />
          <CameraRig model={model} snap={ui.snap} ortho={ui.ortho} mapNorthUp={mapFace} />
          <ViewFromPointRig />
          <Scene model={model} opts={opts} />
          <MeasureTool active={ui.measureMode} showDimensions={ui.viewportLayers.labels} />
        </Canvas>
        <ViewportLayersToolbar />
        <ViewAidsToolbar />
        <div className="overlay tl">
          {(['iso', 'front', 'side', 'top'] as Snap[]).map((d) => (
            <button key={d} className={`btn sm ${ui.snap.dir === d ? 'on' : ''}`} onClick={() => snapTo(d)} title={d === 'front' ? 'Look through the stack (front-view image)' : d === 'side' ? 'Look at the plate faces edge-on (profile)' : undefined}>
              {d === 'iso' ? 'Iso' : d === 'front' ? 'Front' : d === 'side' ? 'Side' : 'Top'}
            </button>
          ))}
          <button className={`btn sm ${ui.ortho ? 'on' : ''}`} onClick={() => setUi({ ortho: !ui.ortho })} title="Orthographic camera">
            Ortho
          </button>
          <button
            className={`btn sm ${fromPoint ? 'on' : ''}`}
            data-testid="view-from-point-toggle"
            onClick={() => setFromPoint((on) => !on)}
            title="Paste a Google Earth URL or type lat, lon, altitude, heading and tilt"
          >
            View from point
          </button>
          <span className="vp-mount" role="group" aria-label="Shown on">
            <button
              className={`btn sm ${isWall(v) ? '' : 'on'}`}
              aria-pressed={!isWall(v)}
              data-testid="mount-table"
              onClick={() => setParam('mount', 'table')}
              title="Table piece: stands on its base, plates rising up (Display › Shown on)"
            >
              Table
            </button>
            <button
              className={`btn sm ${isWall(v) ? 'on' : ''}`}
              aria-pressed={isWall(v)}
              data-testid="mount-wall"
              onClick={() => setParam('mount', 'wall')}
              title="Wall piece: the base hangs flat on the wall and the plates stand out into the room (Display › Shown on; pick the top edge there)"
            >
              Wall
            </button>
          </span>
        </div>
        <div className="vp-tr-column">
          <div className="overlay tr col">
            <button className="btn sm" onClick={() => setUi({ tab: 'impress' })} title="Press a picture into the top surface or the front face, placed by hand with an x-ray of the cut">
              Impress image
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
          {fromPoint && <ViewFromPointPanel />}
        </div>
        <div className="overlay bl info">
          <span>
            {model.sliced.steelBase
              ? `steel base ${fmt(v.baseLength, 0)} × ${fmt(v.baseWidth, 0)} × ${fmt(model.sliced.steelBase.spec.thickness, 1)} mm · ${model.sliced.steelBase.tabs.length} ${model.sliced.steelBase.spec.fixing === 'twist' ? 'twist tabs' : 'welds'}`
              : `base ${fmt(v.baseLength, 0)} × ${fmt(v.baseWidth, 0)} × ${fmt(v.baseHeight, 0)} mm`}
          </span>
          <span>
            {!model.sliced.plates.length ? (
              'no plates'
            ) : (
              <>
                {model.bom.plateCount} {v.sliceMode === 'flat' ? 'layers' : 'plates'} · {model.sliced.parts.length} parts × {fmt(v.thickness, 1)} mm {v.sliceMode === 'flat' ? 'face to face' : v.sliceMode !== 'radial' ? `@ ${fmt(v.pitch, 2)} pitch` : 'radial'}
              </>
            )}
          </span>
          <span
            data-testid="plate-height-range"
            title={
              stackCapped
                ? 'Layer count × thickness. Terrain millimetres exceed the stack — raise Plate count to keep the top. Exaggeration still changes how many layers each area gets.'
                : terrainY
                  ? 'Lowest to highest terrain on the cut outlines, above the concrete. A plate’s bounding-box top can sit higher than a valley on the same plate.'
                  : undefined
            }
          >
            {formatMapHeightCaption({
              sliceMode: v.sliceMode,
              plates: model.sliced.plates,
              thicknessMm: v.thickness,
              mapFace,
              bboxMin: hMin,
              bboxMax: hMax,
              terrainTopMm: model.hf?.max,
            })}
          </span>
          {ui.selected && <span style={{ color: 'var(--accent)' }}>selected {ui.selected}</span>}
        </div>
        {placing && ui.objectsMode && (
          <div className="overlay placing-note status-bar-field" role="status" data-testid="placing-note">
            {placing.kind === 'shelf' ? 'Click a plate where the shelf should go. Esc cancels.' : 'Click a shelf, a plate top or the concrete to stand a candle there. Esc stops.'}
          </div>
        )}
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
      </div>
      <ViewportSidebar move={<MovePanel />} parked={parked} counts={{ objects: objectCount, moved: movedCount, bucketed }} />
    </div>
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
  const live = useGizmoClearance((s) => s.items);
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
      {live && live.length > 0 && (
        <div className="mp-info mp-live">
          {live.map((c) => (
            <span key={c.label} className={c.mm < 0 ? 'clash' : undefined}>
              {c.label} {c.mm < 0 ? `overlaps ${fmt(-c.mm, 1)}` : fmt(c.mm, 1)} mm
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
