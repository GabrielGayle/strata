/** Perspective / ortho clip planes from model bounds (mm scene units). */
export function clipPlanesForBounds(boundSize: number): { near: number; far: number; orthoSpan: number } {
  const size = Math.max(boundSize, 80);
  const near = Math.max(size * 0.008, 1);
  const far = size * 32;
  const orthoSpan = size * 12;
  return { near, far, orthoSpan };
}

export function gridFloorY(boundSize: number): number {
  const size = Math.max(boundSize, 80);
  return -(size * 0.012 + 2);
}
