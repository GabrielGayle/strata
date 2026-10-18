// Web Worker entry: see engine.ts. Requests that arrive while a build runs wait
// in `queue`; the next build takes them all and builds only the newest.
import { createEngineHandler, type EngineRequest } from './engine';

const handle = createEngineHandler();
let queue: EngineRequest[] = [];
self.onmessage = (e: MessageEvent<EngineRequest>) => {
  queue.push(e.data);
  if (queue.length === 1) setTimeout(drain);
};

function drain() {
  const reqs = queue;
  queue = [];
  self.postMessage(handle(reqs));
}
