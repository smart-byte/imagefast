import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageFastError } from './errors';
import { createImageFast } from './index';

describe('ImageFastError', () => {
  it('carries a code and an imagefast-prefixed message', () => {
    const e = new ImageFastError('no-decoder', 'RAW file but no raw decoder is loaded');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('no-decoder');
    expect(e.name).toBe('ImageFastError');
    expect(e.message).toBe('imagefast: RAW file but no raw decoder is loaded');
  });
});

describe('createImageFast', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('throws unsupported when workers are requested but Worker is missing', () => {
    expect(() => createImageFast()).toThrow(expect.objectContaining({ code: 'unsupported' }));
  });

  it('throws unsupported for workers: 0 without OffscreenCanvas', () => {
    expect(() => createImageFast({ workers: 0 })).toThrow(expect.objectContaining({ code: 'unsupported' }));
  });

  it('throws unsupported up front when workers exist but OffscreenCanvas does not (Safari before 16.4), instead of failing every call', () => {
    vi.stubGlobal('Worker', class {});
    expect(() => createImageFast({ workers: 2 })).toThrow(
      expect.objectContaining({ code: 'unsupported', message: expect.stringContaining('OffscreenCanvas') }),
    );
  });

  it('refuses a worker count that is not a non-negative integer', () => {
    for (const workers of [-1, 0.5, NaN]) expect(() => createImageFast({ workers })).toThrow(RangeError);
  });
});

describe('workers: 0', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects with an ImageFastError when a plugin decoder throws something else, as a worker would', async () => {
    for (const name of ['OffscreenCanvas', 'createImageBitmap']) vi.stubGlobal(name, class {});
    const source =
      "export const container = 'boom'; export const matches = () => true; export const decoder = { decode() { throw new TypeError('bad table'); } };";
    const fast = createImageFast({ workers: 0, plugins: [{ module: `data:text/javascript,${encodeURIComponent(source)}` }] });
    await expect(fast.thumbnail(new Blob(['x']))).rejects.toMatchObject({
      name: 'ImageFastError',
      code: 'decode-failed',
      message: expect.stringContaining('bad table'),
    });
  });
});

describe('arguments', () => {
  afterEach(() => vi.unstubAllGlobals());
  const instance = () => {
    for (const name of ['Worker', 'OffscreenCanvas', 'createImageBitmap']) vi.stubGlobal(name, class {});
    return createImageFast({ workers: 1 });
  };

  it('rejects a file that is not a Blob with a TypeError, before a worker is started for it', async () => {
    const fast = instance();
    await expect(fast.dimensions('photo.jpg' as never)).rejects.toBeInstanceOf(TypeError);
    expect(fast.stats()).toMatchObject({ workers: 0, queued: 0 });
  });

  it('rejects a width or height that is not a positive number with a RangeError', async () => {
    const fast = instance();
    for (const width of [0, -5, NaN, '640']) await expect(fast.thumbnail(new Blob(), { width: width as never })).rejects.toBeInstanceOf(RangeError);
    await expect(fast.bitmap(new Blob(), { width: 100, height: 0 })).rejects.toBeInstanceOf(RangeError);
    expect(fast.stats()).toMatchObject({ workers: 0, queued: 0 });
  });
});
