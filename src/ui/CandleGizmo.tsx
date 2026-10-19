import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { TransformControls } from '@react-three/drei';
import { useStore } from '../state/store';
import type { Model } from '../core/pipeline';
import { localToSpot } from '../core/candles';
import { gizmoBusy } from './PlateGizmo';

/** Ids of the candles in the order they stand along the candelabra. */
const order = (id: string) => Number(id.slice(6));

/**
 * Drag a picked candle across the base. Dropping it turns the candelabra into a
 * free layout with every candle where it stands now, so nothing else jumps.
 */
export default function CandleGizmo({ model }: { model: Model }) {
  const sel = useStore((s) => (s.ui.objectsMode ? s.ui.objectSel : null));
  const spec = useStore((s) => s.project.candles);
  const setCandles = useStore((s) => s.setCandles);
  const obj = useMemo(() => new THREE.Object3D(), []);
  const dragging = useRef(false);
  const candles = model.objects.filter((b) => b.object.id.startsWith('candle')).map((b) => b.object);
  const cur = sel?.startsWith('candle') ? candles.find((o) => o.id === sel) : undefined;

  useLayoutEffect(() => {
    if (dragging.current || !cur) return;
    obj.position.set(cur.x, cur.y - cur.h / 2, cur.z);
    obj.updateMatrixWorld();
  }, [cur?.x, cur?.y, cur?.z, cur?.h, obj]);

  if (!spec || !cur) return null;
  // world → measured from the origin → the candelabra's own frame
  const toSpot = (x: number, z: number): [number, number] => {
    const { p, turn } = model.origin;
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const dx = x - p[0];
    const dz = z - p[2];
    const q = localToSpot(spec, [dx * c - dz * s, dx * s + dz * c]);
    return [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10];
  };
  return (
    <>
      <primitive object={obj} />
      <TransformControls
        object={obj}
        mode="translate"
        showY={false}
        size={0.8}
        translationSnap={1}
        onMouseDown={() => {
          dragging.current = true;
          gizmoBusy.until = Infinity;
        }}
        onMouseUp={() => {
          dragging.current = false;
          gizmoBusy.until = performance.now() + 250;
          const spots = [...candles].sort((a, b) => order(a.id) - order(b.id)).map((o) => (o.id === cur.id ? toSpot(obj.position.x, obj.position.z) : toSpot(o.x, o.z)));
          setCandles({ ...spec, path: 'free', spots }, `candles:drag:${cur.id}`);
        }}
      />
    </>
  );
}
