/** Test hook: increments once per Scene mount (not per React re-render). */
let sceneMountCount = 0;

export function registerSceneMount(): void {
  sceneMountCount += 1;
  if (typeof window !== 'undefined') {
    (window as Window & { __STRATA_SCENE_MOUNT_COUNT?: number }).__STRATA_SCENE_MOUNT_COUNT = sceneMountCount;
  }
}

export function getSceneMountCount(): number {
  return sceneMountCount;
}

export function resetSceneMountCountForTests(): void {
  sceneMountCount = 0;
  if (typeof window !== 'undefined') {
    (window as Window & { __STRATA_SCENE_MOUNT_COUNT?: number }).__STRATA_SCENE_MOUNT_COUNT = 0;
  }
}
