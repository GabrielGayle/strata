// Hand placement of plates and other plate-like parts: a translate / rotate gizmo on the selection.
// While dragging, the plate is previewed as a rigid body; on release the move is
// committed to the project and the pipeline re-cuts everything that depends on it.
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { TransformControls } from '@react-three/drei';
import { create } from 'zustand';
import type { Model } from '../core/pipeline';
import { platePivot } from '../core/slicer';
import { IDENTITY_MOVE, type PartMove } from '../core/moves';
import { planeToWorld, type V3 } from '../core/section';
import { planClearance } from '../core/base';
import { slabGap } from '../core/measure';
import { useStore } from '../state/store';

/** Set while the gizmo is in use, so the click that ends a drag doesn't change the selection. */
export const gizmoBusy = { until: 0 };
export const gizmoIsBusy = () => performance.now() < gizmoBusy.until;

export interface MoveTarget {
  /** Key the move is stored under (P3, X1, or a spacer's key). */
  key: string;
  label: string;
  pivot: [number, number, number];
}

/** What a hand move of the selected part acts on: its whole plate, or the loose part itself. */
export function moveTarget(model: Model, partId: string | null): MoveTarget | null {
  if (!partId) return null;
  const part = model.sliced.parts.find((p) => p.id === partId);
  // shelves move with their own arrows in Objects > Shelves, not as a hand move
  if (!part || part.family === 'S' || part.family === 'B' || part.family === 'H') return null;
  const plate = model.sliced.plates.find((p) => p.def.key === part.plateKey);
  if (plate) return { key: plate.def.key, label: part.id.replace(/[a-z]$/, ''), pivot: platePivot(plate.def) };
  return part.pivot ? { key: part.plateKey, label: part.id, pivot: part.pivot } : null;
}

/** Live clearances of the part under the gizmo while it is dragged (cleared on release). */
export interface Clearance {
  label: string;
  mm: number;
}
export const useGizmoClearance = create<{ items: Clearance[] | null }>(() => ({ items: null }));

/**
 * Where the dragged part is measured from: the outline corners of its pieces on both faces,
 * plus the neighbouring plates of its family and the base outline to measure to.
 */
function clearanceSetup(model: Model, key: string) {
  const parts = model.sliced.parts.filter((p) => p.plateKey === key);
  const pts: V3[] = [];
  for (const p of parts) for (const w of [-p.thickness / 2, p.thickness / 2]) for (const q of p.shape[0]?.outer ?? []) pts.push(planeToWorld(p.plane, q[0], q[1], w));
  const me = model.sliced.plates.find((p) => p.def.key === key);
  const neighbours = me
    ? model.sliced.plates
        .filter((p) => p.def.family === me.def.family && Math.abs(p.def.index - me.def.index) === 1 && p.parts.length)
        .map((p) => ({ key: p.def.key, plane: p.def.plane, t: p.parts[0].thickness }))
    : [];
  return { pts, neighbours };
}

/** Distances from the dragged points to the neighbouring plates (face to face) and to the base edge (in plan). */
function clearances(model: Model, setup: ReturnType<typeof clearanceSetup>, m: THREE.Matrix4): Clearance[] {
  const v = new THREE.Vector3();
  const pts = setup.pts.map((p): V3 => {
    v.set(p[0], p[1], p[2]).applyMatrix4(m);
    return [v.x, v.y, v.z];
  });
  const out: Clearance[] = setup.neighbours.map((n) => ({ label: n.key, mm: slabGap(pts, n.plane.origin, n.plane.normal, n.t) }));
  if (model.v.baseOn && !model.sliced.baseOutline && pts.length) out.push({ label: 'base edge', mm: Math.min(...pts.map((p) => planClearance(model.v, p[0], -p[2]))) });
  return out;
}

function moveMatrix(pivot: THREE.Vector3, m: PartMove): THREE.Matrix4 {
  return new THREE.Matrix4().compose(pivot.clone().add(new THREE.Vector3(...m.t)), new THREE.Quaternion(...m.q), new THREE.Vector3(1, 1, 1));
}

export default function PlateGizmo({ model, partId, preview }: { model: Model; partId: string | null; preview: RefObject<THREE.Group | null> }) {
  const target = moveTarget(model, partId);
  const key = target?.key ?? null;
  const move = useStore((s) => (key ? s.project.moves?.[key] : undefined)) ?? IDENTITY_MOVE;
  const movePart = useStore((s) => s.movePart);
  const mode = useStore((s) => s.ui.gizmoMode);
  const space = useStore((s) => s.ui.gizmoSpace);
  const obj = useMemo(() => new THREE.Object3D(), []);
  const [px, py, pz] = target?.pivot ?? [0, 0, 0];
  const pivot = useMemo(() => new THREE.Vector3(px, py, pz), [px, py, pz]);
  const committed = useRef(new THREE.Matrix4());
  const dragging = useRef(false);
  const setup = useMemo(() => (key ? clearanceSetup(model, key) : null), [model, key]);

  // follow the stored move (after a commit, undo, reset…) and clear any preview
  useLayoutEffect(() => {
    if (dragging.current) return;
    const m = moveMatrix(pivot, move);
    committed.current.copy(m);
    m.decompose(obj.position, obj.quaternion, obj.scale);
    obj.updateMatrixWorld();
    if (preview.current) {
      preview.current.matrix.identity();
      preview.current.matrixWorldNeedsUpdate = true;
    }
  }, [move, pivot, obj, preview]);

  if (!key) return null;
  return (
    <>
      <primitive object={obj} />
      <TransformControls
        object={obj}
        mode={mode}
        space={space}
        size={0.9}
        translationSnap={1}
        rotationSnap={THREE.MathUtils.degToRad(1)}
        onMouseDown={() => {
          dragging.current = true;
          gizmoBusy.until = Infinity;
        }}
        onObjectChange={() => {
          if (!preview.current) return;
          obj.updateMatrix();
          preview.current.matrix.multiplyMatrices(obj.matrix, committed.current.clone().invert());
          preview.current.matrixWorldNeedsUpdate = true;
          if (setup && dragging.current) useGizmoClearance.setState({ items: clearances(model, setup, preview.current.matrix) });
        }}
        onMouseUp={() => {
          dragging.current = false;
          useGizmoClearance.setState({ items: null });
          gizmoBusy.until = performance.now() + 250;
          const t = obj.position.clone().sub(pivot);
          const q = obj.quaternion.clone().normalize();
          const r = (x: number) => Math.round(x * 1e4) / 1e4;
          movePart(key, { t: [r(t.x), r(t.y), r(t.z)], q: [q.x, q.y, q.z, q.w] });
        }}
      />
    </>
  );
}
