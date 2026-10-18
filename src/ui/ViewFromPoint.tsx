import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import {
  earthViewToWorldPose,
  earthWorldFrame,
  fitMapBoxToView,
  mapSpecWithBbox,
  matchBaseToMapBbox,
  parseEarthView,
  pointViewMessage,
  type EarthView,
  type EarthWorldPose,
} from '../core/earthView';
import { evaluateParams } from '../core/params';
import { useStore } from '../state/store';
import { useModel } from './model';

const EMPTY = { lat: '', lon: '', altitude: '', heading: '', tilt: '', fov: '', distance: '' };

function numStr(n: number | undefined, digits = 6): string {
  if (n == null || !Number.isFinite(n)) return '';
  const s = n.toFixed(digits);
  return s.replace(/\.?0+$/, '') || '0';
}

function viewToFields(v: EarthView) {
  return {
    lat: numStr(v.lat, 8),
    lon: numStr(v.lon, 8),
    altitude: numStr(v.altitude, 4),
    heading: numStr(v.heading, 4),
    tilt: numStr(v.tilt, 4),
    fov: numStr(v.fov, 2),
    distance: v.distance != null ? numStr(v.distance, 4) : '',
  };
}

function fieldsToText(f: typeof EMPTY): string {
  if (f.distance.trim()) {
    const fov = f.fov.trim() || '35';
    return `@${f.lat},${f.lon},${f.altitude}a,${f.distance}d,${fov}y,${f.heading}h,${f.tilt}t`;
  }
  const parts = [f.lat, f.lon, f.altitude, f.heading, f.tilt];
  if (f.fov) parts.push(f.fov);
  return parts.join(', ');
}

function canvasAspect(): number {
  const el = document.querySelector('[data-testid="viewport-3d"] canvas') as HTMLCanvasElement | null;
  if (!el) return 16 / 9;
  const w = el.clientWidth || el.width;
  const h = el.clientHeight || el.height;
  return h > 0 ? w / h : 16 / 9;
}

function publishPose(pose: EarthWorldPose, camera?: THREE.Camera, target?: THREE.Vector3) {
  const position = camera
    ? ([camera.position.x, camera.position.y, camera.position.z] as [number, number, number])
    : pose.position;
  const lookAt = target ? ([target.x, target.y, target.z] as [number, number, number]) : pose.target;
  const look = {
    x: lookAt[0] - position[0],
    y: lookAt[1] - position[1],
    z: lookAt[2] - position[2],
  };
  if (typeof window !== 'undefined') {
    (window as Window & { __STRATA_POINT_VIEW__?: unknown }).__STRATA_POINT_VIEW__ = {
      position,
      target: lookAt,
      look,
      fov: pose.fov,
      applied: true,
    };
  }
}

export default function ViewFromPointPanel() {
  const saved = useStore((s) => s.project.savedView);
  const map = useStore((s) => s.project.images.top?.map);
  const setUi = useStore((s) => s.setUi);
  const setSavedView = useStore((s) => s.setSavedView);
  const setTopMap = useStore((s) => s.setTopMap);
  const setParams = useStore((s) => s.setParams);
  const model = useModel();
  const [paste, setPaste] = useState(() => {
    const v = useStore.getState().project.savedView;
    return v ? fieldsToText(viewToFields(v)) : '';
  });
  const [pasteDirty, setPasteDirty] = useState(false);
  const [fields, setFields] = useState(() => {
    const v = useStore.getState().project.savedView;
    return v ? viewToFields(v) : EMPTY;
  });
  const [matchBase, setMatchBase] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    setFields((f) => (f.lat.trim() || f.lon.trim() ? f : viewToFields(saved)));
    setPaste((p) => (p.trim() ? p : fieldsToText(viewToFields(saved))));
  }, [saved]);

  const fill = (view: EarthView) => {
    setFields(viewToFields(view));
    setError(null);
  };

  const parseInput = (): { ok: true; view: EarthView } | { ok: false; error: string } => {
    const fromPaste = paste.trim();
    if (pasteDirty && fromPaste) {
      const r = parseEarthView(fromPaste);
      if (r.ok) {
        fill(r.view);
        setPasteDirty(false);
        return r;
      }
      return r;
    }
    if (fields.lat.trim() && fields.lon.trim()) {
      const typed = fieldsToText(fields);
      const r = parseEarthView(typed);
      if (r.ok) {
        fill(r.view);
        return r;
      }
      if (!fromPaste) return r;
    }
    if (fromPaste) {
      const r = parseEarthView(fromPaste);
      if (r.ok) {
        fill(r.view);
        setPasteDirty(false);
        return r;
      }
      return r;
    }
    return { ok: false, error: 'Paste a Google Earth URL, or type lat, lon, altitude, heading and tilt.' };
  };

  const look = (view: EarthView) => {
    setSavedView(view);
    const project = useStore.getState().project;
    const warn = pointViewMessage(view, project.images.top?.map?.bbox);
    setMessage(warn);
    setError(null);
    const frame = earthWorldFrame(project.images.top?.map, model.v, project.images.top?.depth);
    if (!frame) return false;
    const pose = earthViewToWorldPose(view, frame);
    const ui = useStore.getState().ui;
    setUi({
      ortho: false,
      pointView: { n: (ui.pointView?.n ?? 0) + 1, pose },
      pointViewFov: pose.fov,
    });
    return true;
  };

  const onLook = () => {
    const r = parseInput();
    if (!r.ok) {
      setError(r.error);
      setMessage(null);
      return;
    }
    look(r.view);
  };

  const onFit = () => {
    const r = parseInput();
    if (!r.ok) {
      setError(r.error);
      setMessage(null);
      return;
    }
    const bbox = fitMapBoxToView(r.view, { aspect: canvasAspect() });
    const spec = mapSpecWithBbox(useStore.getState().project.images.top?.map, bbox);
    setTopMap(spec);
    if (matchBase) {
      const outline = matchBaseToMapBbox(bbox, useStore.getState().project.params);
      if (outline) setParams(outline, 'match-base-to-map');
    }
    setSavedView(r.view);
    setError(null);
    setMessage('Map box fitted to this view. Rebuild runs from the Map tab settings — wait for terrain, then the camera will match.');
    const project = useStore.getState().project;
    const values = evaluateParams(project.params).values;
    const frame = earthWorldFrame(project.images.top?.map, values, project.images.top?.depth);
    if (!frame) return;
    const pose = earthViewToWorldPose(r.view, frame);
    const ui = useStore.getState().ui;
    setUi({
      ortho: false,
      pointView: { n: (ui.pointView?.n ?? 0) + 1, pose },
      pointViewFov: pose.fov,
    });
  };

  const onReturn = () => {
    if (!saved) {
      setError('No saved view on this project yet. Look from a point first.');
      return;
    }
    fill(saved);
    look(saved);
  };

  const onPasteBlur = () => {
    if (!paste.trim()) return;
    const r = parseEarthView(paste);
    if (r.ok) fill(r.view);
  };

  const setField = (key: keyof typeof EMPTY, value: string) => {
    setPasteDirty(false);
    setFields((f) => ({ ...f, [key]: value }));
  };

  return (
    <div
      className="overlay appearance viewpoint"
      data-testid="view-from-point"
      data-view-lat={fields.lat}
      data-view-lon={fields.lon}
      data-view-heading={fields.heading}
      data-view-tilt={fields.tilt}
      data-view-fov={fields.fov}
    >
      <div className="mp-row">
        <span className="mp-info" style={{ flex: 1 }}>
          View from point
        </span>
      </div>
      <label className="vp-paste">
        Google Earth URL
        <textarea
          data-testid="view-from-point-input"
          aria-label="Google Earth URL or coordinates"
          rows={2}
          value={paste}
          placeholder="Paste an Earth link, or type lat, lon, altitude, heading, tilt"
          onChange={(e) => {
            setPaste(e.target.value);
            setPasteDirty(true);
          }}
          onBlur={onPasteBlur}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (!text) return;
            const r = parseEarthView(text);
            if (r.ok) fill(r.view);
          }}
        />
      </label>
      <div className="vp-grid">
        <label>
          Lat
          <input inputMode="decimal" aria-label="Latitude" value={fields.lat} onChange={(e) => setField('lat', e.target.value)} />
        </label>
        <label>
          Lon
          <input inputMode="decimal" aria-label="Longitude" value={fields.lon} onChange={(e) => setField('lon', e.target.value)} />
        </label>
        <label>
          Altitude m
          <input inputMode="decimal" aria-label="Altitude in metres" value={fields.altitude} onChange={(e) => setField('altitude', e.target.value)} />
        </label>
        <label>
          Heading °
          <input inputMode="decimal" aria-label="Heading in degrees" value={fields.heading} onChange={(e) => setField('heading', e.target.value)} />
        </label>
        <label>
          Tilt °
          <input inputMode="decimal" aria-label="Tilt in degrees" value={fields.tilt} onChange={(e) => setField('tilt', e.target.value)} />
        </label>
        <label>
          FOV °
          <input inputMode="decimal" aria-label="Field of view in degrees" value={fields.fov} onChange={(e) => setField('fov', e.target.value)} placeholder="35" />
        </label>
        <label>
          Distance m
          <input inputMode="decimal" aria-label="Distance to look-at in metres" value={fields.distance} onChange={(e) => setField('distance', e.target.value)} placeholder="from URL" />
        </label>
      </div>
      <div className="mp-row">
        <button type="button" className="btn sm" data-testid="view-from-point-look" onClick={onLook} title="Move the 3D camera to this viewpoint">
          Look
        </button>
        <button
          type="button"
          className="btn sm"
          data-testid="view-from-point-return"
          disabled={!saved}
          onClick={onReturn}
          title="Restore the viewpoint saved with this project"
        >
          Return to saved view
        </button>
        <button type="button" className="btn sm" data-testid="view-from-point-fit" onClick={onFit} title="Set the map bbox to the ground this camera can see">
          Fit map box to view
        </button>
      </div>
      <label className="vp-match">
        <input
          type="checkbox"
          data-testid="view-from-point-match-base"
          checked={matchBase}
          onChange={(e) => setMatchBase(e.target.checked)}
        />
        Match base to map shape
      </label>
      {(error || message) && (
        <div
          className={`mp-info ${error ? 'vp-error' : 'vp-warn'}`}
          data-testid="view-from-point-warning"
          role="status"
        >
          {error ?? message}
        </div>
      )}
      {map && (
        <div className="mp-info">
          Map box {map.bbox.map((n) => n.toFixed(4)).join(', ')}
        </div>
      )}
    </div>
  );
}

type OrbitLike = {
  target: THREE.Vector3;
  update: () => void;
  enableDamping: boolean;
  sphericalDelta?: THREE.Vector3;
  panOffset?: THREE.Vector3;
};

/** Apply a stored pose to the live three.js camera (after CameraRig so snaps don't win). */
export function ViewFromPointRig() {
  const tick = useStore((s) => s.ui.pointView);
  const { camera, controls } = useThree() as {
    camera: THREE.Camera & { isPerspectiveCamera?: boolean; fov?: number; near: number; far: number; updateProjectionMatrix: () => void };
    controls?: OrbitLike;
  };
  const hold = useRef(0);
  const lastN = useRef(0);

  const apply = () => {
    if (!tick?.pose || !controls) return;
    const { pose } = tick;
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    camera.up.set(pose.up[0], pose.up[1], pose.up[2]);
    camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
    const dist =
      Math.hypot(pose.position[0], pose.position[1], pose.position[2]) +
      Math.hypot(pose.target[0], pose.target[1], pose.target[2]) +
      Math.hypot(pose.position[0] - pose.target[0], pose.position[1] - pose.target[1], pose.position[2] - pose.target[2]);
    if (camera.isPerspectiveCamera) {
      camera.fov = pose.fov;
      camera.near = Math.max(0.5, Math.min(camera.near, dist * 0.002));
      camera.far = Math.max(camera.far, dist * 8, 4000);
      camera.updateProjectionMatrix();
    }
    controls.sphericalDelta?.set(0, 0, 0);
    controls.panOffset?.set(0, 0, 0);
    controls.update();
    controls.enableDamping = damping;
    publishPose(pose, camera, controls.target);
  };

  useLayoutEffect(() => {
    if (!tick?.pose) return;
    if (tick.n !== lastN.current) {
      lastN.current = tick.n;
      hold.current = 16;
    }
    apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, camera, controls]);

  useFrame(() => {
    if (!tick?.pose || hold.current <= 0) return;
    apply();
    hold.current -= 1;
  });
  return null;
}
