// Shelves and candles placed on surfaces in the 3D view: the click that puts
// one down, and the arrows that move it afterwards.
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { TransformControls } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { useStore } from '../state/store';
import type { Model } from '../core/pipeline';
import { baseTop } from '../core/slicer';
import { newShelf, onShelf } from '../core/shelfPlates';
import { newPlacedCandle, placedAt } from '../core/surfaceCandles';
import { gizmoBusy } from './PlateGizmo';

const UPRIGHT = new Set(['P', 'X', 'R']);

/**
 * A click in the 3D view while placing: a new shelf at the height clicked on a
 * plate, or a candle on whatever surface was clicked (shelf, plate tops, concrete).
 */
export function placeOnClick(model: Model, e: ThreeEvent<MouseEvent>) {
  const st = useStore.getState();
  const placing = st.ui.placing;
  if (!placing || e.delta > 4) return;
  e.stopPropagation();
  const id = e.object.userData?.measure as string | undefined;
  const part = id ? model.sliced.parts.find((p) => p.id === id) : undefined;
  if (!part && id !== 'base') return;
  // plates sit in a group lifted over a sunken frame; the concrete does not
  const lift = part ? (model.sunkenFrame?.plateLiftMm ?? 0) : 0;
  const p = { x: e.point.x, y: e.point.y - lift, z: e.point.z };
  if (placing.kind === 'shelf') {
    if (part && !UPRIGHT.has(part.family)) return st.toast('Click one of the plates to put a shelf there.');
    const shelves = st.project.shelves ?? [];
    const s = newShelf(shelves, { x: p.x, y: part ? p.y : baseTop(model.v) + 60, z: p.z });
    st.setShelves([...shelves, s]);
    st.setUi({ placing: null, objectSel: s.id });
    return;
  }
  const placed = st.project.placedCandles ?? [];
  let c;
  if (part?.family === 'H') {
    const shelf = model.shelfCuts?.[part.index];
    if (!shelf || !onShelf(shelf, p.x, p.z)) return;
    c = newPlacedCandle(placed, { size: placing.size, on: 'shelf', shelf: shelf.id, x: p.x - shelf.x, z: p.z - shelf.z });
  } else if (part && UPRIGHT.has(part.family)) c = newPlacedCandle(placed, { size: placing.size, on: 'plates', x: p.x, z: p.z });
  else if (id === 'base') c = newPlacedCandle(placed, { size: placing.size, on: 'base', x: p.x, z: p.z });
  else return st.toast('Click a shelf, the top of the plates or the concrete to stand a candle there.');
  // stays in placing, so several candles go down one after another (Esc stops)
  st.setPlacedCandles([...placed, c]);
  st.setUi({ objectSel: c.id });
}

/** Arrows on the picked shelf: drag it across, along or up and down. */
export function ShelfGizmo({ model }: { model: Model }) {
  const sel = useStore((s) => (s.ui.objectsMode && !s.ui.placing ? s.ui.objectSel : null));
  const shelves = useStore((s) => s.project.shelves);
  const setShelves = useStore((s) => s.setShelves);
  const cur = shelves?.find((s) => s.id === sel && s.on);
  const obj = useMemo(() => new THREE.Object3D(), []);
  const dragging = useRef(false);
  useLayoutEffect(() => {
    if (dragging.current || !cur) return;
    obj.position.set(cur.x, cur.y, cur.z);
    obj.updateMatrixWorld();
  }, [cur?.x, cur?.y, cur?.z, obj]);
  if (!cur || !shelves || model.v.sliceMode === 'flat') return null;
  return (
    <>
      <primitive object={obj} />
      <TransformControls
        object={obj}
        mode="translate"
        size={0.8}
        translationSnap={1}
        onMouseDown={() => {
          dragging.current = true;
          gizmoBusy.until = Infinity;
        }}
        onMouseUp={() => {
          dragging.current = false;
          gizmoBusy.until = performance.now() + 250;
          const r = (x: number) => Math.round(x);
          const { x, y, z } = obj.position;
          if (r(x) === cur.x && r(y) === cur.y && r(z) === cur.z) return;
          setShelves(shelves.map((s) => (s.id === cur.id ? { ...s, x: r(x), y: r(y), z: r(z) } : s)), `shelf:drag:${cur.id}`);
        }}
      />
    </>
  );
}

/** Arrows on a picked placed candle: slide it over its surface (a shelf candle stays on its shelf). */
export function PlacedCandleGizmo({ model }: { model: Model }) {
  const sel = useStore((s) => (s.ui.objectsMode && !s.ui.placing ? s.ui.objectSel : null));
  const placed = useStore((s) => s.project.placedCandles);
  const setPlaced = useStore((s) => s.setPlacedCandles);
  const cur = placed?.find((c) => c.id === sel);
  const built = model.objects.find((b) => b.object.id === cur?.id)?.object;
  const obj = useMemo(() => new THREE.Object3D(), []);
  const dragging = useRef(false);
  useLayoutEffect(() => {
    if (dragging.current || !built) return;
    obj.position.set(built.x, built.y - built.h / 2, built.z);
    obj.updateMatrixWorld();
  }, [built?.x, built?.y, built?.z, built?.h, obj]);
  if (!cur || !placed || !built) return null;
  return (
    <>
      <primitive object={obj} />
      <TransformControls
        object={obj}
        mode="translate"
        showY={false}
        size={0.7}
        translationSnap={1}
        onMouseDown={() => {
          dragging.current = true;
          gizmoBusy.until = Infinity;
        }}
        onMouseUp={() => {
          dragging.current = false;
          gizmoBusy.until = performance.now() + 250;
          const at = placedAt(cur, model.shelfCuts ?? []);
          if (!at) return;
          const dx = obj.position.x - at[0];
          const dz = obj.position.z - at[1];
          const r = (x: number) => Math.round(x * 10) / 10;
          setPlaced(placed.map((c) => (c.id === cur.id ? { ...c, x: r(c.x + dx), z: r(c.z + dz) } : c)), `placed:drag:${cur.id}`);
        }}
      />
    </>
  );
}
