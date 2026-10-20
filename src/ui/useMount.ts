import { useMemo } from 'react';
import * as THREE from 'three';
import { useStore } from '../state/store';
import { isMapDepth } from '../core/mapPlateHeight';
import { mountFrame, roomToModel, type MountFrame } from '../core/mount';
import type { Values } from '../core/params';

/** Whether the top face is a map (its picture top is north, at the front end). */
export const useMapTop = () => useStore((s) => isMapDepth(s.project.images.top?.depth) && !!s.project.images.top?.map);

/** Table or wall: which way is really up for this design, in model coordinates. */
export function useMountFrame(v: Values): MountFrame {
  const map = useMapTop();
  return useMemo(() => mountFrame(v, map), [v.mount, v.wallTop, v.wallPlates, v.sliceAxis, v.sliceMode, map]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A room direction (x right, y up, z towards the viewer) as a model-space vector. */
export const roomVec = (f: MountFrame, x: number, y: number, z: number) => new THREE.Vector3(...roomToModel(f, [x, y, z]));
