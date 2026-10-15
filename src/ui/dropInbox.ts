// Files dropped on the window for the shadow kitchen, held until its view is on screen to take them.
export interface ShadowDrop {
  images?: File[];
  video?: File;
}

let pending: ShadowDrop | null = null;
let listener: ((d: ShadowDrop) => void) | null = null;

export function sendToShadow(d: ShadowDrop) {
  if (listener) listener(d);
  else pending = d;
}

/** The shadow view registers here; anything dropped before it mounted arrives straight away. */
export function receiveShadowDrops(fn: (d: ShadowDrop) => void): () => void {
  listener = fn;
  if (pending) {
    const d = pending;
    pending = null;
    fn(d);
  }
  return () => {
    if (listener === fn) listener = null;
  };
}
