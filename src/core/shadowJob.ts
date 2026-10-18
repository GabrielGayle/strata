// Shadow carving on a thread of its own. The engine worker slices the plates and
// shows them at once; the carve runs here, a step at a time, and a newer carve
// (or a drag starting) stops the one under way. The engine worker and the
// shadow worker talk over a MessageChannel the page sets up, so the plates
// never pass through the page twice.
import { applyCarveDiff, carveDiff, carveShadow, carveShadowSteps, type CarveDiff, type CarveResult, type ShadowInput, type ShadowReport } from './shadow';
import type { CarveJob } from './pipeline';
import type { Values } from './params';
import type { SliceResult } from './slicer';
import { packPoints, unpackPoints } from './packPoints';

export type ShadowJobRequest =
  | { id: number; v: Values; sliced: SliceResult; /** null: the same pictures as the last request. */ frames: ShadowInput[] | null }
  | { id: number; cancel: true };

export type ShadowJobReply = { id: number; diff: CarveDiff; report: ShadowReport } | { id: number; error: string };

/** How many finished carves the engine keeps, for undo and for edits that don't touch the plates. */
const KEEP = 4;
/** Longest the shadow worker runs before it looks for a newer request, ms. */
const SLICE_MS = 12;

const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The engine worker's side: the `carve` option of its full front pipeline. A
 * carve it already has comes back at once; otherwise it asks the shadow worker
 * and returns undefined, and calls `onCarved` when the answer is in, so the
 * engine can build the carved model. With no shadow worker it carves inline.
 */
export class ShadowClient {
  private port: MessagePort | null = null;
  private done: { deps: unknown[]; value: CarveResult }[] = [];
  private pending: { id: number; deps: unknown[]; sliced: SliceResult } | null = null;
  private sentFrames: unknown[] | null = null;
  private nextId = 1;
  /** Don't start new carves (the engine is only warming its caches). */
  quiet = false;

  constructor(private onCarved: () => void) {}

  attach(port: MessagePort) {
    this.port = port;
    port.onmessage = (e) => this.receive(e.data as ShadowJobReply);
  }

  get attached() {
    return !!this.port;
  }

  carve = (job: CarveJob): CarveResult | undefined => {
    const hit = this.done.find((d) => same(d.deps, job.deps));
    if (hit) return hit.value;
    if (!this.port) return this.keep(job.deps, carveShadow(job.v, job.sliced, job.frames));
    if (this.pending && same(this.pending.deps, job.deps)) return undefined;
    if (this.quiet) return undefined;
    // the pictures are the last two deps (decoded frames and the project's frame list)
    const framesId = job.deps.slice(-2);
    const frames = this.sentFrames && same(this.sentFrames, framesId) ? null : job.frames;
    this.sentFrames = framesId;
    const id = this.nextId++;
    this.pending = { id, deps: job.deps, sliced: job.sliced };
    this.port.postMessage({ id, v: job.v, sliced: packPoints(job.sliced), frames } satisfies ShadowJobRequest);
    return undefined;
  };

  /** Stops the carve under way (a drag started: the plates it was carving are already out of date). */
  cancel() {
    if (!this.pending || !this.port) return;
    this.pending = null;
    this.port.postMessage({ id: this.nextId++, cancel: true } satisfies ShadowJobRequest);
  }

  clear() {
    this.done = [];
  }

  private keep(deps: unknown[], value: CarveResult) {
    this.done = [{ deps, value }, ...this.done].slice(0, KEEP);
    return value;
  }

  private receive(reply: ShadowJobReply) {
    const p = this.pending;
    if (!p || p.id !== reply.id) return;
    this.pending = null;
    if ('error' in reply) {
      // carve here from now on (the error, if it is in the carve itself, shows the way it always has)
      console.error('Strata shadow worker:', reply.error);
      this.port = null;
    } else {
      const diff = unpackPoints(reply.diff) as CarveDiff;
      this.keep(p.deps, { sliced: applyCarveDiff(p.sliced, diff), report: unpackPoints(reply.report) as ShadowReport });
    }
    this.onCarved();
  }
}

/**
 * The shadow worker's side. Each request carves the plates it carries; the
 * carve hands back control every few milliseconds (`pause`), and when a newer
 * request has arrived meanwhile it stops without answering.
 */
export function createShadowJobHandler(post: (reply: ShadowJobReply) => void, pause: () => Promise<void>, sliceMs = SLICE_MS) {
  let latest = 0;
  let frames: ShadowInput[] = [];
  return async (req: ShadowJobRequest) => {
    latest = req.id;
    if ('cancel' in req) return;
    if (req.frames) frames = req.frames;
    try {
      const sliced = unpackPoints(req.sliced) as SliceResult;
      const steps = carveShadowSteps(req.v, sliced, frames);
      let t = performance.now();
      for (;;) {
        const r = steps.next();
        if (r.done) {
          if (latest === req.id) post({ id: req.id, diff: packPoints(carveDiff(sliced, r.value)), report: packPoints(r.value.report) });
          return;
        }
        if (performance.now() - t >= sliceMs) {
          await pause();
          if (latest !== req.id) return;
          t = performance.now();
        }
      }
    } catch (e) {
      if (latest === req.id) post({ id: req.id, error: e instanceof Error ? e.message : String(e) });
    }
  };
}
