import { bitmap, decodeRaw, dimensions, loadPlugin, thumbnail } from './ops';
import { ImageFastError, toImageFastError } from './errors';
import { lazy } from './lazy';
import type { ImageFastPlugin } from './plugin';

/** RPC ops a worker answers. `load` imports the plugin modules and must be posted first. */
const OPS = { dimensions, thumbnail, bitmap, decodeRaw };

export type Op = keyof typeof OPS;

export interface Request {
  id: number;
  /** `load` takes the `ImageFastPlugin`s as its args. */
  op: Op | 'load';
  args: unknown[];
}

/** What the worker posts back for a request. */
export type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { code: ImageFastError['code']; message: string } };

export function serve(): void {
  let plugins: ImageFastPlugin[] = [];
  // A failed import is tried again by the next op rather than failing this worker until it is terminated.
  const ready = lazy(() => Promise.all(plugins.map(loadPlugin)));
  self.addEventListener('message', async (event: MessageEvent<Request>) => {
    const { id, op, args } = event.data;
    try {
      if (op === 'load') plugins = args as ImageFastPlugin[];
      await ready();
      if (op === 'load') {
        self.postMessage({ id, ok: true, result: null } satisfies Reply);
        return;
      }
      const fn = OPS[op] as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (typeof fn !== 'function') throw new ImageFastError('decode-failed', `unknown op "${op}"`);
      const result = await fn(...args);
      const bitmap = (result as { bitmap?: unknown }).bitmap;
      self.postMessage({ id, ok: true, result } satisfies Reply, bitmap instanceof ImageBitmap ? [bitmap] : []);
    } catch (err) {
      const { code, message } = toImageFastError(err);
      self.postMessage({ id, ok: false, error: { code, message } } satisfies Reply);
    }
  });
  self.postMessage({ id: 0, ok: true, result: null } satisfies Reply); // tells the pool this worker started
}
