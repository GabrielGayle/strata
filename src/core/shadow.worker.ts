// Web Worker entry: see shadowJob.ts. Requests come from the engine worker over
// the port the page hands over in the first message.
import { createShadowJobHandler, type ShadowJobRequest } from './shadowJob';

// a zero-delay pause that lets waiting messages in (setTimeout would wait at least 4 ms)
const tick = new MessageChannel();
const waiting: (() => void)[] = [];
tick.port1.onmessage = () => waiting.shift()?.();
const pause = () =>
  new Promise<void>((resolve) => {
    waiting.push(resolve);
    tick.port2.postMessage(0);
  });

self.onmessage = (e: MessageEvent<{ port: MessagePort }>) => {
  const port = e.data.port;
  const handle = createShadowJobHandler((reply) => port.postMessage(reply), pause);
  port.onmessage = (m: MessageEvent<ShadowJobRequest>) => void handle(m.data);
};
