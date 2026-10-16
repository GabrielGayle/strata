import { createContext } from 'react';

/** Parked = the 3D tab is in this pane but another view is in front. */
export const ViewportParkedContext = createContext(false);

/** Stable Canvas config. Inline `{ gl: {…} }` / `dpr={[1,2]}` on every parent
 *  render used to make R3F reconfigure (and sometimes remount) the renderer. */
export const VIEWPORT_GL = {
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance' as const,
};
export const VIEWPORT_DPR: [number, number] = [1, 2];
export const VIEWPORT_CAM_POS: [number, number, number] = [1500, 1100, 1800];
export const VIEWPORT_STYLE = { position: 'absolute' as const, inset: 0 };
export const VIEWPORT_RESIZE = { scroll: false, debounce: { scroll: 50, resize: 50 } };
