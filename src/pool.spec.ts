import { describe, expect, it, vi } from 'vitest';
import { WorkerPool } from './pool';

/** Fake worker: says it started (like `serve()`), echoes args after a tick, or fails for op "fail". */
class FakeWorker {
  static live = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  constructor(starts = true) {
    FakeWorker.live++;
    if (starts) queueMicrotask(() => this.onmessage?.({ data: { id: 0, ok: true, result: null } } as MessageEvent));
  }
  postMessage(msg: { id: number; op: string; args: unknown[] }) {
    if (msg.args.some((a) => typeof a === 'function')) throw new DOMException('could not be cloned', 'DataCloneError');
    setTimeout(() => {
      if (msg.op === 'crash') return this.onerror?.({ message: 'kaboom' } as ErrorEvent);
      if (msg.op === 'garbled') return this.onmessageerror?.({} as MessageEvent);
      const ok = msg.op !== 'fail';
      this.onmessage?.({
        data: ok ? { id: msg.id, ok, result: msg.args } : { id: msg.id, ok, error: { code: 'decode-failed', message: 'nope' } },
      } as MessageEvent);
    }, 1);
  }
  terminate() {
    FakeWorker.live--;
  }
}

const pool = (size = 2, idleMs = 20) => new WorkerPool({ size, idleMs, create: () => new FakeWorker() as unknown as Worker });

describe('WorkerPool', () => {
  it('resolves results and rejects errors', async () => {
    const p = pool();
    await expect(p.call('echo', [1, 2])).resolves.toEqual([1, 2]);
    await expect(p.call('fail', [])).rejects.toMatchObject({ code: 'decode-failed', message: 'imagefast: nope' });
    p.terminate();
  });

  it('rejects with code terminated / worker-crashed', async () => {
    const p = pool(1);
    const pending = p.call('echo', [1]);
    p.terminate();
    await expect(pending).rejects.toMatchObject({ code: 'terminated' });
    const q = pool(1);
    await expect(q.call('crash', [])).rejects.toMatchObject({ code: 'worker-crashed' });
    q.terminate();
  });

  it('drops a queued job when its signal aborts, without posting it', async () => {
    const p = pool(1);
    const ctl = new AbortController();
    const first = p.call('echo', [1]);
    const queued = p.call('echo', [2], ctl.signal);
    expect(p.stats().queued).toBe(1);
    ctl.abort();
    expect(p.stats().queued).toBe(0);
    await expect(queued).rejects.toMatchObject({ code: 'aborted' });
    await expect(first).resolves.toEqual([1]);
    await expect(p.call('echo', [3], AbortSignal.abort())).rejects.toMatchObject({ code: 'aborted' });
    p.terminate();
  });

  it('aborts a running job by terminating its worker, and serves the next job on a fresh one', async () => {
    const p = pool(1);
    const live = FakeWorker.live;
    const ctl = new AbortController();
    const running = p.call('echo', [1], ctl.signal);
    expect(p.stats()).toMatchObject({ workers: 1, busy: 1, queued: 0 });
    ctl.abort();
    await expect(running).rejects.toMatchObject({ code: 'aborted' });
    expect(FakeWorker.live).toBe(live);
    expect(p.stats()).toMatchObject({ workers: 0, busy: 0 });
    await expect(p.call('echo', [2])).resolves.toEqual([2]);
    p.terminate();
  });

  it('spawns lazily up to size and queues the rest', async () => {
    FakeWorker.live = 0;
    const p = pool(2);
    const calls = [1, 2, 3, 4, 5].map((n) => p.call('echo', [n]));
    expect(p.stats()).toMatchObject({ workers: 2, busy: 2, queued: 3 });
    expect(await Promise.all(calls)).toEqual([[1], [2], [3], [4], [5]]);
    expect(FakeWorker.live).toBe(2);
    p.terminate();
    expect(FakeWorker.live).toBe(0);
  });

  it('terminates idle workers and respawns on demand', async () => {
    vi.useFakeTimers();
    FakeWorker.live = 0;
    const p = pool(1, 50);
    const c = p.call('echo', ['a']);
    await vi.advanceTimersByTimeAsync(2);
    await c;
    expect(p.stats().workers).toBe(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(p.stats().workers).toBe(0);
    expect(FakeWorker.live).toBe(0);
    const c2 = p.call('echo', ['b']);
    await vi.advanceTimersByTimeAsync(2);
    await expect(c2).resolves.toEqual(['b']);
    p.terminate();
    vi.useRealTimers();
  });

  it('removes its abort listener once the job settles (long-lived signals must not retain jobs)', async () => {
    const p = pool(1);
    const ctl = new AbortController();
    const remove = vi.spyOn(ctl.signal, 'removeEventListener');
    await p.call('echo', [1], ctl.signal);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    p.terminate();
  });

  it('refuses size 0 (jobs would queue forever, then reject as terminated)', () => {
    expect(() => pool(0)).toThrow(RangeError);
  });

  it('rejects the job whose reply cannot be deserialized (messageerror) instead of leaving it pending', async () => {
    const p = pool(1);
    await expect(p.call('garbled', [])).rejects.toMatchObject({ code: 'worker-crashed' });
    await expect(p.call('echo', ['ok'])).resolves.toEqual(['ok']);
    p.terminate();
  });

  it('fails the queue when a worker dies before answering anything (bad URL, CSP) instead of respawning once per job', async () => {
    let created = 0;
    const p = new WorkerPool({
      size: 1,
      create: () => {
        created++;
        const w = new FakeWorker(false);
        w.postMessage = () => setTimeout(() => w.onerror?.({ message: '' } as ErrorEvent), 1);
        return w as unknown as Worker;
      },
    });
    const jobs = [1, 2, 3].map((n) => p.call('echo', [n]));
    for (const job of jobs) await expect(job).rejects.toMatchObject({ code: 'worker-crashed', message: expect.stringContaining('could not start') });
    expect(created).toBe(1);
    p.terminate();
  });

  it('keeps the queue when a worker fails to start while another one is up (the worker URL evidently works)', async () => {
    let created = 0;
    const p = new WorkerPool({
      size: 2,
      create: () => {
        const neverStarts = ++created === 2;
        const w = new FakeWorker(!neverStarts);
        if (neverStarts) w.postMessage = () => setTimeout(() => w.onerror?.({ message: '' } as ErrorEvent), 1);
        return w as unknown as Worker;
      },
    });
    const [first, second, third, fourth] = [1, 2, 3, 4].map((n) => p.call('echo', [n]));
    await expect(second).rejects.toMatchObject({ code: 'worker-crashed' }); // the job that was on the dead worker
    expect(await Promise.all([first, third, fourth])).toEqual([[1], [3], [4]]);
    p.terminate();
  });

  it('rejects a job whose arguments cannot be cloned and keeps its worker free for the next one', async () => {
    const p = pool(1);
    await expect(p.call('echo', [() => {}])).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(p.stats().busy).toBe(0);
    await expect(p.call('echo', ['ok'])).resolves.toEqual(['ok']);
    p.terminate();
  });

  it('rejects jobs of a crashed worker and keeps serving', async () => {
    const p = pool(1);
    await expect(p.call('crash', [])).rejects.toThrow(/crashed/);
    await expect(p.call('echo', ['ok'])).resolves.toEqual(['ok']);
    p.terminate();
  });
});
