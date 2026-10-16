// Runs the deferred pipeline stages (fit checks, nesting, moulds, BOM) off the
// main thread. The page posts only the inputs that changed since its last post;
// the worker folds them into its copy with structural sharing, so parts an edit
// didn't touch keep their identity there too and their cached checks still hit.
import { createDeferredPipeline, type DeferredInput, type DeferredModel } from './pipeline';
import { share } from './memo';

const KEYS = ['v', 'sliced', 'insert', 'pourRows', 'appearance'] as const;

export interface DeferredRequest {
  id: number;
  /** Only the fields that changed since the previous request. */
  changes: Partial<DeferredInput>;
}

export type DeferredReply = { id: number; result: DeferredModel } | { id: number; error: string };

/** The worker's side: keeps the last inputs and the stage cache between requests. */
export function createDeferredHandler() {
  const run = createDeferredPipeline();
  let input: Partial<DeferredInput> = {};
  return (req: DeferredRequest): DeferredReply => {
    try {
      const next: Partial<DeferredInput> = { ...input };
      for (const k of KEYS) if (k in req.changes) (next as Record<string, unknown>)[k] = share(input[k], req.changes[k]);
      input = next;
      return { id: req.id, result: run(input as DeferredInput, 'full') };
    } catch (e) {
      return { id: req.id, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

/** The page's side: the fields of `input` that differ (by identity) from what was last sent. */
export function changedFields(last: Partial<DeferredInput> | null, input: DeferredInput): Partial<DeferredInput> {
  const out: Partial<DeferredInput> = {};
  for (const k of KEYS) if (!last || !(k in last) || last[k] !== input[k]) (out as Record<string, unknown>)[k] = input[k];
  return out;
}

export const sameInput = (a: DeferredInput, b: DeferredInput) => KEYS.every((k) => a[k] === b[k]);

/** Keeps unchanged parts of a result that came back from the worker identical to the last one. */
export function shareResult(prev: DeferredModel | null, next: DeferredModel): DeferredModel {
  if (!prev) return next;
  return {
    ...next,
    issues: share(prev.issues, next.issues),
    nested: share(prev.nested, next.nested),
    moulds: share(prev.moulds, next.moulds),
    mouldNest: share(prev.mouldNest, next.mouldNest),
    bom: share(prev.bom, next.bom),
    sounding: share(prev.sounding, next.sounding),
  };
}

/**
 * Posts deferred work to a worker, newest request wins: while the worker is
 * busy only the latest input waits, so a dragged slider never builds a queue.
 */
export class DeferredWorker {
  private worker: Worker;
  private busy = false;
  private pending: { id: number; input: DeferredInput } | null = null;
  private sent: Partial<DeferredInput> | null = null;
  private nextId = 1;
  private lastInput: DeferredInput | null = null;
  private lastId = 0;

  constructor(
    worker: Worker,
    private onResult: (id: number, result: DeferredModel, input: DeferredInput) => void,
    /** The worker couldn't do this job (fatal: it died, so stop using it). */
    private onFail: (id: number, input: DeferredInput, fatal: boolean) => void,
  ) {
    this.worker = worker;
    this.worker.onmessage = (e: MessageEvent<DeferredReply>) => {
      const reply = e.data;
      this.busy = false;
      if ('error' in reply) {
        this.sent = null; // the worker may hold half an update: resend everything next time
        if (!this.pending) this.onFail(reply.id, this.lastInput!, false);
      } else this.onResult(reply.id, reply.result, this.lastInput!);
      this.flush();
    };
    this.worker.onerror = () => {
      this.busy = false;
      this.sent = null;
      const job = this.pending ?? (this.lastInput ? { id: this.lastId, input: this.lastInput } : null);
      this.pending = null;
      if (job) this.onFail(job.id, job.input, true);
    };
  }

  run(input: DeferredInput): number {
    const id = this.nextId++;
    this.pending = { id, input };
    this.flush();
    return id;
  }

  private flush() {
    if (this.busy || !this.pending) return;
    const { id, input } = this.pending;
    this.pending = null;
    const changes = changedFields(this.sent, input);
    this.sent = { ...input };
    this.lastInput = input;
    this.lastId = id;
    this.busy = true;
    this.worker.postMessage({ id, changes } satisfies DeferredRequest);
  }

  terminate() {
    this.worker.terminate();
  }
}
