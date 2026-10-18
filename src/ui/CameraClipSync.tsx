import { useEffect } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useStore } from '../state/store';
import { clipPlanesForBounds } from './viewportClip';

/** Keeps active camera near/far tight to the design so depth precision holds while orbiting. */
export default function CameraClipSync({ boundSize }: { boundSize: number }) {
  const { camera } = useThree();
  const pointViewN = useStore((s) => s.ui.pointView?.n ?? 0);
  useEffect(() => {
    // View-from-point owns near/far (a 5 km Earth view sits well outside the model AABB).
    if (pointViewN > 0) return;
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
  }, [camera, boundSize, pointViewN]);
  return null;
}
