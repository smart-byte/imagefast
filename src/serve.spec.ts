import { afterEach, describe, expect, it, vi } from 'vitest';

const ops = vi.hoisted(() => ({ loadPlugin: vi.fn(), dimensions: vi.fn(), thumbnail: vi.fn(), bitmap: vi.fn(), decodeRaw: vi.fn() }));
vi.mock('./ops', () => ops);

import { serve, type Reply, type Request } from './serve';

/** Runs `serve()` in a fake worker scope. The returned function delivers a request and resolves with the reply to it. */
function worker(): (request: Request) => Promise<Reply> {
  let onMessage!: (e: MessageEvent<Request>) => Promise<void>;
  const replies: Reply[] = [];
  vi.stubGlobal('ImageBitmap', class {});
  vi.stubGlobal('self', { addEventListener: (_: string, fn: typeof onMessage) => (onMessage = fn), postMessage: (reply: Reply) => replies.push(reply) });
  serve();
  return async (request) => {
    await onMessage({ data: request } as MessageEvent<Request>);
    return replies.at(-1)!;
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('serve', () => {
  it('imports the plugins again for the next op after a failed load, instead of failing every op of this worker', async () => {
    ops.loadPlugin.mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined);
    ops.dimensions.mockResolvedValue({ width: 1, height: 1 });
    const post = worker();
    expect(await post({ id: 0, op: 'load', args: [{ module: 'x' }] })).toMatchObject({ ok: false });
    expect(await post({ id: 1, op: 'dimensions', args: [new Blob()] })).toMatchObject({ id: 1, ok: true });
    expect(ops.loadPlugin).toHaveBeenCalledTimes(2);
  });
});
