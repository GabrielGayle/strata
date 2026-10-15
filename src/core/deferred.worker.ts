// Web Worker entry: see deferred.ts.
import { createDeferredHandler, type DeferredRequest } from './deferred';

const handle = createDeferredHandler();
self.onmessage = (e: MessageEvent<DeferredRequest>) => {
  self.postMessage(handle(e.data));
};
