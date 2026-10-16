import { useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import { Grid, type GridProps } from '@react-three/drei';

/** Floor grid: no depth fighting with base/plates; stable sort while orbiting. */
export default function ViewportGrid(props: GridProps) {
  const ref = useRef<THREE.Mesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.renderOrder = -20;
    const mat = mesh.material as THREE.Material & {
      depthWrite?: boolean;
      depthTest?: boolean;
      polygonOffset?: boolean;
      polygonOffsetFactor?: number;
      polygonOffsetUnits?: number;
    };
    // Floor is already below the base (gridFloorY). Pulling toward the camera
    // (negative polygonOffset) made the grid paint over concrete at grazing angles.
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 1;
    mat.polygonOffsetUnits = 1;
    mat.transparent = true;
  }, []);
  return <Grid ref={ref} frustumCulled={false} {...props} />;
}
