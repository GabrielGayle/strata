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
      polygonOffset?: boolean;
      polygonOffsetFactor?: number;
      polygonOffsetUnits?: number;
    };
    mat.depthWrite = false;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -4;
    mat.polygonOffsetUnits = -4;
    mat.transparent = true;
  }, []);
  return <Grid ref={ref} frustumCulled={false} {...props} />;
}
