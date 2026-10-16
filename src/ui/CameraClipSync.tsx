import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { Model } from '../core/pipeline';
import { modelBounds } from './Scene';
import { clipPlanesForBounds } from './viewportClip';

/** Keeps active camera near/far tight to the design so depth precision holds while orbiting. */
export default function CameraClipSync({ model }: { model: Model }) {
  const { camera } = useThree();
  const boundSize = useMemo(() => modelBounds(model).size, [model]);
  useEffect(() => {
    const { near, far, orthoSpan } = clipPlanesForBounds(boundSize);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    } else if (camera instanceof THREE.OrthographicCamera) {
      camera.near = -orthoSpan;
      camera.far = orthoSpan;
      camera.updateProjectionMatrix();
    }
  }, [camera, boundSize]);
  return null;
}
