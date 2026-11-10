import { ImageFastError } from './errors';
import type { Reply } from './serve';

export interface PoolOptions {
  /** Max workers (>= 1). Spawned lazily. */
  size: number;
  /** Terminate all workers after this much idle time. Default 5000. */
  idleMs?: number;
  create: () => Worker;
}

export interface PoolStats {
  /** Maximum number of workers. */
  size: number;
  /** Workers currently alive. */
  workers: number;
  /** Workers running a job. */
  busy: number;
  /** Jobs waiting for a worker. */
  queued: number;
}

interface Slot {
  worker: Worker;
  busy: boolean;
  /** Has posted anything yet (`serve()` says hello first). A worker that dies before that never started (bad URL, CSP). */
  started: boolean;
}

interface Job {
  id: number;
  op: string;
  args: unknown[];
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort: () => void;
  slot?: Slot;
}

/** Promise RPC over a lazily grown pool of workers. One job per worker at a time (ops are CPU bound). */
export class WorkerPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private inflight = new Map<number, Job>();
  private seq = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private opts: PoolOptions) {
    if (!(opts.size >= 1)) throw new RangeError(`imagefast: pool size must be >= 1, got ${opts.size}`);
  }

  /** `signal` cancels the job: dropped while queued, or its worker is terminated while it runs. */
  call<R>(op: string, args: unknown[], signal?: AbortSignal): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      if (signal?.aborted) return reject(new ImageFastError('aborted', `${op} aborted`));
      const job: Job = { id: ++this.seq, op, args, resolve: resolve as Job['resolve'], reject, signal, onAbort: () => this.abort(job) };
      signal?.addEventListener('abort', job.onAbort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  stats(): PoolStats {
    return { size: this.opts.size, workers: this.slots.length, busy: this.slots.filter((s) => s.busy).length, queued: this.queue.length };
  }

  /** Kill all workers. In-flight and queued jobs reject with code 'terminated'. The next call spawns workers again. */
  terminate(): void {
    clearTimeout(this.idleTimer);
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
    for (const job of [...this.inflight.values(), ...this.queue]) this.settle(job, false, new ImageFastError('terminated', 'pool terminated'));
    this.inflight.clear();
    this.queue = [];
  }

  /** Resolves or rejects a job and drops its abort listener (a long-lived signal must not retain settled jobs). */
  private settle(job: Job, ok: boolean, value: unknown): void {
    job.signal?.removeEventListener('abort', job.onAbort);
    if (ok) job.resolve(value);
    else job.reject(value);
  }

  private abort(job: Job): void {
    const i = this.queue.indexOf(job);
    if (i >= 0) this.queue.splice(i, 1);
    else if (this.inflight.get(job.id) === job) {
      // A worker cannot be interrupted mid-decode, only killed; the next job spawns a fresh one.
      this.inflight.delete(job.id);
      this.drop(job.slot!);
    } else return; // already settled
    this.settle(job, false, new ImageFastError('aborted', `${job.op} aborted`));
    this.pump();
  }

  private drop(slot: Slot): void {
    slot.worker.terminate();
    this.slots = this.slots.filter((s) => s !== slot);
  }

  private pump(): void {
    clearTimeout(this.idleTimer);
    while (this.queue.length) {
      let slot = this.slots.find((s) => !s.busy);
      if (!slot && this.slots.length < this.opts.size) slot = this.spawn();
      if (!slot) return;
      const job = this.queue.shift()!;
      slot.busy = true;
      job.slot = slot;
      this.inflight.set(job.id, job);
      try {
        slot.worker.postMessage({ id: job.id, op: job.op, args: job.args });
      } catch (e) {
        // Arguments that cannot be cloned (a function among the options) never reach the worker: fail that job, keep the worker.
        this.inflight.delete(job.id);
        slot.busy = false;
        this.settle(job, false, e);
      }
    }
    if (!this.inflight.size) this.idleTimer = setTimeout(() => this.terminate(), this.opts.idleMs ?? 5000);
  }

  private spawn(): Slot {
    const worker = this.opts.create();
    const slot: Slot = { worker, busy: false, started: false };
    worker.onmessage = (e: MessageEvent<Reply>) => this.onMessage(slot, e.data);
    worker.onerror = (e: ErrorEvent) => this.onCrash(slot, e.message || 'worker error');
    worker.onmessageerror = () => this.onCrash(slot, 'a reply could not be deserialized');
    this.slots.push(slot);
    return slot;
  }

  private onMessage(slot: Slot, msg: Reply): void {
    slot.started = true;
    const job = this.inflight.get(msg.id);
    if (!job) return;
    this.inflight.delete(msg.id);
    slot.busy = false;
    if (msg.ok) this.settle(job, true, msg.result);
    else this.settle(job, false, new ImageFastError(msg.error.code, msg.error.message));
    this.pump();
  }

  private onCrash(slot: Slot, message: string): void {
    this.drop(slot);
    const error = new ImageFastError(
      'worker-crashed',
      slot.started ? `worker crashed: ${message}` : `worker could not start (check its URL and CSP): ${message}`,
    );
    for (const [id, job] of this.inflight) {
      if (job.slot === slot) {
        this.inflight.delete(id);
        this.settle(job, false, error);
      }
    }
    // No worker has ever started: the next one will not either, so the queue fails now rather than one crash per job.
    if (!slot.started && !this.slots.some((s) => s.started)) for (const job of this.queue.splice(0)) this.settle(job, false, error);
    this.pump();
  }
}
