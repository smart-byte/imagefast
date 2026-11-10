import * as ops from './ops';
import { WorkerPool, type PoolStats } from './pool';
import { ImageFastError, toImageFastError } from './errors';
import { lazy } from './lazy';
import type { Op } from './serve';
import type { RawDecodeOptions, RawDecodeResult } from './rawdecode';
import type { BitmapOptions, BitmapResult, Dimensions, ThumbnailOptions, ThumbnailResult } from './ops';
import type { ImageFastPlugin } from './plugin';

export interface ImageFastOptions {
  /** Decoders for formats browsers cannot open: `imagefast/raw`, `imagefast/tiff`, `imagefast/psd`, `imagefast/heic`. */
  plugins?: ImageFastPlugin[];
  /** Worker count. Default `hardwareConcurrency - 1` (min 1). `0` runs everything on the calling thread. */
  workers?: number;
  /** Milliseconds of idle time after which workers are terminated (they hold the decoders' memory). Default 5000. */
  idleMs?: number;
}

/**
 * Cancels a job (code 'aborted'): dropped while queued, its worker terminated while running (the next call spawns a
 * fresh one). `AbortSignal.timeout(ms)` makes a timeout. With `workers: 0` a running job cannot be stopped.
 */
export interface CallOptions {
  signal?: AbortSignal;
}

export interface ImageFast {
  /**
   * Width/height (EXIF-oriented). RAW is detected by file name or MIME type (see `isRawFile`) and read with LibRaw;
   * a nameless RAW `Blob` is probed as TIFF and may report the size of its embedded preview instead.
   */
  dimensions(file: Blob, opts?: CallOptions): Promise<Dimensions>;
  /** Resized JPEG/WebP/PNG. RAW/TIFF/PSD/HEIC go through their plugin first. */
  thumbnail(file: Blob, opts?: ThumbnailOptions & CallOptions): Promise<ThumbnailResult>;
  /** The same scaled, oriented pixels as `thumbnail`, as an `ImageBitmap` for a canvas: no encode, no second decode. */
  bitmap(file: Blob, opts?: BitmapOptions & CallOptions): Promise<BitmapResult>;
  /** JPEG preview of a RAW file (embedded thumbnail or half-size demosaic). Needs the `raw` plugin. */
  decodeRaw(file: Blob, opts?: RawDecodeOptions & CallOptions): Promise<RawDecodeResult>;
  /** Pool size, live and busy workers, queued jobs. All zero with `workers: 0`. */
  stats(): PoolStats;
  /**
   * Kills the workers; pending calls reject with code 'terminated'. Workers also exit on their own after `idleMs`.
   * The instance stays usable: the next call spawns workers again.
   */
  terminate(): void;
}

/**
 * Throws `ImageFastError('unsupported')` when the environment lacks what imagefast needs. Arguments no decoder should
 * see are refused before any work is queued: a bad `workers` throws here, a call with a non-Blob `file` or a
 * non-positive `width`/`height` rejects with a `TypeError`/`RangeError`.
 */
export function createImageFast(options: ImageFastOptions = {}): ImageFast {
  const workers = options.workers ?? defaultWorkers();
  if (!Number.isInteger(workers) || workers < 0) throw new RangeError(`imagefast: workers must be a non-negative integer, got ${workers}`);
  assertSupported(workers);
  const { plugins = [] } = options;
  const pool =
    workers > 0
      ? new WorkerPool({
          size: workers,
          idleMs: options.idleMs,
          create: () => {
            const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'imagefast' });
            // id 0 is never awaited: the next op imports the plugins again and rejects with the import error if that fails too.
            if (plugins.length) w.postMessage({ id: 0, op: 'load', args: plugins });
            return w;
          },
        })
      : null;
  const loaded = lazy(() => Promise.all(plugins.map(ops.loadPlugin)));
  const call = <R>(op: Op, args: [file: Blob, box?: Box], signal?: AbortSignal): Promise<R> => {
    const bad = invalid(...args);
    if (bad) return Promise.reject(bad);
    if (pool) return pool.call<R>(op, args, signal);
    if (signal?.aborted) return Promise.reject(new ImageFastError('aborted', `${op} aborted`));
    return loaded()
      .then(() => (ops[op] as (...a: unknown[]) => Promise<R>)(...args))
      .catch((e: unknown) => {
        throw toImageFastError(e);
      });
  };
  return {
    dimensions: (file, { signal } = {}) => call('dimensions', [file], signal),
    thumbnail: (file, { signal, ...opts } = {}) => call('thumbnail', [file, opts], signal),
    bitmap: (file, { signal, ...opts } = {}) => call('bitmap', [file, opts], signal),
    decodeRaw: (file, { signal, ...opts } = {}) => call('decodeRaw', [file, opts], signal),
    stats: () => pool?.stats() ?? { size: 0, workers: 0, busy: 0, queued: 0 },
    terminate: () => pool?.terminate(),
  };
}

type Box = { width?: unknown; height?: unknown };

function invalid(file: unknown, box: Box = {}): Error | undefined {
  if (!(file instanceof Blob)) return new TypeError('imagefast: file must be a Blob or File');
  for (const side of ['width', 'height'] as const) {
    const value = box[side];
    if (value !== undefined && !(typeof value === 'number' && value > 0)) return new RangeError(`imagefast: ${side} must be a positive number, got ${value}`);
  }
}

// Whatever the page lacks, its workers lack too, so the pool path is checked here rather than failing every call later.
function assertSupported(workers: number): void {
  const needed = [...(workers > 0 ? ['Worker'] : []), 'OffscreenCanvas', 'createImageBitmap'];
  const missing = needed.find((name) => !(name in globalThis));
  if (missing) throw new ImageFastError('unsupported', `${missing} is not available here; create the ImageFast instance in browser code`);
}

function defaultWorkers(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, cores - 1);
}
