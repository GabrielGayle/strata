// Hand placement of plates: a translate / rotate gizmo on the selected plate.
// While dragging, the plate is previewed as a rigid body; on release the move is
// committed to the project and the pipeline re-cuts everything that depends on it.
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { TransformControls } from '@react-three/drei';
import type { Model } from '../core/pipeline';
import { platePivot } from '../core/slicer';
import { IDENTITY_MOVE, type PartMove } from '../core/moves';
import { useStore } from '../state/store';

/** Set while the gizmo is in use, so the click that ends a drag doesn't change the selection. */
export const gizmoBusy = { until: 0 };
export const gizmoIsBusy = () => performance.now() < gizmoBusy.until;

/** The plate (by key) a selected part belongs to, if it can be moved by hand. */
export function movablePlate(model: Model, partId: string | null) {
  if (!partId) return null;
  const part = model.sliced.parts.find((p) => p.id === partId);
  if (!part || part.family === 'S') return null;
  return model.sliced.plates.find((p) => p.def.key === part.plateKey) ?? null;
}

function moveMatrix(pivot: THREE.Vector3, m: PartMove): THREE.Matrix4 {
  return new THREE.Matrix4().compose(pivot.clone().add(new THREE.Vector3(...m.t)), new THREE.Quaternion(...m.q), new THREE.Vector3(1, 1, 1));
}

export default function PlateGizmo({ model, partId, preview }: { model: Model; partId: string | null; preview: RefObject<THREE.Group | null> }) {
  const plate = movablePlate(model, partId);
  const key = plate?.def.key ?? null;
  const move = useStore((s) => (key ? s.project.moves?.[key] : undefined)) ?? IDENTITY_MOVE;
  const movePart = useStore((s) => s.movePart);
  const mode = useStore((s) => s.ui.gizmoMode);
  const space = useStore((s) => s.ui.gizmoSpace);
  const obj = useMemo(() => new THREE.Object3D(), []);
  const pivot = useMemo(() => (plate ? new THREE.Vector3(...platePivot(plate.def)) : new THREE.Vector3()), [plate]);
  const committed = useRef(new THREE.Matrix4());
  const dragging = useRef(false);

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

  if (!plate || !key) return null;
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
        }}
        onMouseUp={() => {
          dragging.current = false;
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
