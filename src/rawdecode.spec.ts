import { afterEach, describe, expect, it, vi } from 'vitest';
import { jpegOrientation } from './probe';
import type { LibRawModule } from './libraw.js';

type Factory = (opts: { locateFile: (path: string) => string }) => Promise<unknown>;
const state = vi.hoisted(() => ({ module: null as unknown, factory: null as Factory | null }));
vi.mock('./libraw.js', () => ({ default: (opts: Parameters<Factory>[0]) => (state.factory ? state.factory(opts) : Promise.resolve(state.module)) }));

const u16 = (n: number) => [n >> 8, n & 0xff];
/** Minimal JPEG (SOI, SOF0 with the given size, SOS): enough for probeDimensions. */
const jpeg = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, ...u16(11), 8, ...u16(h), ...u16(w), 1, 1, 0x11, 0, 0xff, 0xda]);

const JPEG = 4;
const PPM16 = 8;

interface Thumb {
  format: number;
  width: number;
  height: number;
  /** Return code of unpack_thumb_ex for this entry (0 = ok). */
  unpack?: number;
}

/**
 * Fake emscripten module. Embedded previews come back as JPEGs sized like their thumbs_list entry; demosaic
 * yields a 6000x4000 "JPEG" (type 1 keeps the test canvas-free). Records the LibRaw calls that matter.
 */
function fakeLibRaw(thumbs: Thumb[], opts: { makeThumb?: number; flip?: number } = {}): LibRawModule & { calls: string[]; opened: number[] } {
  const portrait = opts.flip === 5 || opts.flip === 6;
  const heap = new Uint8Array(1 << 16);
  let top = 1024;
  const images = new Map<number, Uint8Array>();
  const put = (bytes: Uint8Array) => {
    const img = top;
    heap.set(bytes, img);
    top += bytes.length;
    images.set(img, bytes);
    return img;
  };
  const calls: string[] = [];
  let unpacked = -1;
  let opened: number[] = [];
  const m = {
    calls,
    get opened() {
      return opened;
    },
    HEAPU8: heap,
    UTF8ToString: () => 'fake',
    _malloc: (n: number) => (top += n) - n,
    _free: () => {},
    _lr_new: () => 1,
    _lr_free: () => {},
    _lr_strerror: () => 0,
    _lr_open: (_p: number, buf: number, len: number) => ((opened = [...heap.subarray(buf, buf + len)]), 0),
    _lr_make: () => 0,
    _lr_model: () => 0,
    _lr_width: () => (portrait ? 4000 : 6000),
    _lr_height: () => (portrait ? 6000 : 4000),
    _lr_flip: () => opts.flip ?? 0,
    _lr_thumb_count: () => thumbs.length,
    _lr_thumb_format: (_p: number, i: number) => thumbs[i]!.format,
    _lr_thumb_width: (_p: number, i: number) => thumbs[i]!.width,
    _lr_thumb_height: (_p: number, i: number) => thumbs[i]!.height,
    _lr_thumb_default_width: () => 0,
    _lr_unpack_thumb: (_p: number, i: number) => {
      calls.push(`unpack_thumb ${i}`);
      unpacked = i;
      return thumbs[i]?.unpack ?? 0;
    },
    _lr_make_thumb: () => opts.makeThumb ?? put(jpeg(thumbs[unpacked]!.width, thumbs[unpacked]!.height)),
    _lr_process: () => {
      calls.push('process');
      return 0;
    },
    _lr_make_image: () => put(jpeg(6000, 4000)),
    _lr_last_error: () => 0,
    _lr_img_type: () => 1,
    _lr_img_width: () => 0,
    _lr_img_height: () => 0,
    _lr_img_colors: () => 3,
    _lr_img_bits: () => 8,
    _lr_img_size: (img: number) => images.get(img)!.length,
    _lr_img_data: (img: number) => img,
    _lr_free_image: () => {},
  };
  return m as unknown as LibRawModule & { calls: string[]; opened: number[] };
}

async function load(thumbs: Thumb[], opts?: { makeThumb?: number; flip?: number }) {
  const fake = fakeLibRaw(thumbs, opts);
  state.module = fake;
  const m = await import('./rawdecode');
  return { m, fake };
}

const file = new Blob([new Uint8Array(16)]);
const opts = { width: 1024, quality: 0.9 };

describe('decodeRaw', () => {
  afterEach(() => vi.resetModules());

  it('picks the smallest embedded JPEG that still covers targetWidth', async () => {
    const { m, fake } = await load([
      { format: JPEG, width: 6000, height: 4000 },
      { format: JPEG, width: 1600, height: 1067 },
      { format: JPEG, width: 160, height: 120 },
    ]);
    const r = await m.decodeRaw(file, opts);
    expect(r).toMatchObject({ method: 'embedded', previewWidth: 1600, previewHeight: 1067, width: 6000, height: 4000 });
    expect(fake.calls).toEqual(['unpack_thumb 1']);
  });

  it('compares long edges, so a portrait camera picks a preview that still covers the oriented box', async () => {
    // 4000x6000 oriented; 1200 wide -> 1200x1800 needed. The 1600x1067 preview (stored landscape) is only 1067 wide upright.
    const { m, fake } = await load(
      [
        { format: JPEG, width: 6000, height: 4000 },
        { format: JPEG, width: 1600, height: 1067 },
      ],
      { flip: 6 },
    );
    expect(await m.decodeRaw(file, { width: 1200, quality: 0.9 })).toMatchObject({ method: 'embedded', previewWidth: 4000, previewHeight: 6000 });
    expect(fake.calls).toEqual(['unpack_thumb 0']);
  });

  it('picks a preview that covers the box when the caller crops (fit: cover)', async () => {
    // 6000x4000 into a 1024x1024 cover box needs 1536x1024: the 1280x853 preview is too small.
    const { m, fake } = await load([
      { format: JPEG, width: 6000, height: 4000 },
      { format: JPEG, width: 1280, height: 853 },
    ]);
    expect(await m.decodeRaw(file, { width: 1024, height: 1024, fit: 'cover', quality: 0.9 })).toMatchObject({ previewWidth: 6000 });
    expect(fake.calls).toEqual(['unpack_thumb 0']);
  });

  it('skips 16-bit PPM previews (only 8-bit bitmaps can be converted)', async () => {
    const { m, fake } = await load([
      { format: PPM16, width: 2000, height: 1333 },
      { format: JPEG, width: 3000, height: 2000 },
    ]);
    expect(await m.decodeRaw(file, opts)).toMatchObject({ method: 'embedded', previewWidth: 3000 });
    expect(fake.calls).toEqual(['unpack_thumb 1']);
  });

  it('falls back to demosaic when the chosen preview cannot be unpacked', async () => {
    const { m, fake } = await load([{ format: JPEG, width: 3000, height: 2000, unpack: -1 }]);
    expect(await m.decodeRaw(file, opts)).toMatchObject({ method: 'demosaic', previewWidth: 6000 });
    expect(fake.calls).toEqual(['unpack_thumb 0', 'process']);
  });

  it('writes the camera flip into the preview EXIF instead of re-encoding the pixels', async () => {
    const { m } = await load([{ format: JPEG, width: 3000, height: 2000 }], { flip: 6 });
    const r = await m.decodeRaw(file, opts);
    expect(r).toMatchObject({ method: 'embedded', previewWidth: 2000, previewHeight: 3000 });
    const out = new Uint8Array(await r.blob.arrayBuffer());
    expect(jpegOrientation(out)).toBe(6);
    const src = jpeg(3000, 2000);
    expect([...out.subarray(out.length - (src.length - 2))]).toEqual([...src.subarray(2)]);
  });

  it('hands LibRaw the whole file, byte for byte, in its heap', async () => {
    const { m, fake } = await load([{ format: JPEG, width: 3000, height: 2000 }]);
    const bytes = Array.from({ length: 3000 }, (_, i) => (i * 7) & 0xff);
    await m.decodeRaw(new Blob([new Uint8Array(bytes.slice(0, 1000)), new Uint8Array(bytes.slice(1000))]), opts);
    expect(fake.opened).toEqual(bytes);
  });

  it('rejects a file LibRaw has no memory for, instead of writing it over the start of the heap', async () => {
    const { m, fake } = await load([{ format: JPEG, width: 3000, height: 2000 }]);
    const mallocs: number[] = [];
    fake._malloc = (n) => (mallocs.push(n), 0);
    const tooLarge = { code: 'decode-failed', message: expect.stringContaining('too large') };
    await expect(m.decodeRaw(file, opts)).rejects.toMatchObject(tooLarge);
    // A size above 32 bits would wrap inside wasm and come back as a buffer that is too small.
    const huge = { size: 2 ** 32 + 16, stream: () => file.stream() } as Blob;
    await expect(m.decodeRaw(huge, opts)).rejects.toMatchObject(tooLarge);
    expect(mallocs).toEqual([16]);
    expect(fake.opened).toEqual([]);
  });

  it('rejects with an ImageFastError when make_thumb returns null, even with last_error 0', async () => {
    const { m } = await load([{ format: JPEG, width: 3000, height: 2000 }], { makeThumb: 0 });
    await expect(m.decodeRaw(file, opts)).rejects.toMatchObject({ name: 'ImageFastError', code: 'decode-failed' });
  });
});

describe('loadLibRaw', () => {
  afterEach(() => {
    state.factory = null;
    vi.resetModules();
  });

  it('points the emscripten glue at the configured libraw.wasm URL', async () => {
    const located: string[] = [];
    state.factory = async ({ locateFile }) => (located.push(locateFile('libraw.wasm')), state.module);
    const m = await import('./rawdecode');
    m.configure({ wasm: 'https://cdn.example/libraw.wasm' });
    await m.loadLibRaw();
    expect(located).toEqual(['https://cdn.example/libraw.wasm']);
  });

  it('reports a failed wasm load as decode-failed naming the URL, then retries instead of caching the rejection', async () => {
    state.module = fakeLibRaw([]);
    let attempt = 0;
    state.factory = async () => {
      if (!attempt++) throw new Error('Aborted(both async and sync fetching of the wasm failed)');
      return state.module;
    };
    const m = await import('./rawdecode');
    m.configure({ wasm: '/assets/libraw.wasm' });
    await expect(m.loadLibRaw()).rejects.toMatchObject({ code: 'decode-failed', message: expect.stringContaining('/assets/libraw.wasm') });
    await expect(m.loadLibRaw()).resolves.toBe(state.module);
  });
});
