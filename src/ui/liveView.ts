// Latest 3D camera direction, so the postcard unobstructed-view panel can
// copy it. Not part of the project; "Use current camera" writes it in.
import { DEFAULT_VIEW_AZIMUTH, DEFAULT_VIEW_ELEVATION, sphericalFromOffset } from '../core/shelfView';

let live = { azimuth: DEFAULT_VIEW_AZIMUTH, elevation: DEFAULT_VIEW_ELEVATION };

export function setLiveViewFromOffset(x: number, y: number, z: number) {
  live = sphericalFromOffset(x, y, z);
}

export function getLiveView() {
  return live;
}

/** The 3D view's camera as it is now (world mm, y up), for a hero render of what's on screen. */
export interface LiveCamera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  aspect: number;
  ortho: boolean;
}

let liveCamera: LiveCamera | null = null;

export function setLiveCamera(c: LiveCamera) {
  liveCamera = c;
}

export function getLiveCamera(): LiveCamera | null {
  return liveCamera;
}
