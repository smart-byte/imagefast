import { afterEach, describe, expect, it, vi } from 'vitest';
import { detect, dimensions, loadPlugin, registerDecoder, thumbnail } from './ops';
import type { Decoder } from './plugin';

const noop: Decoder = { decode: () => Promise.reject(new Error('unused')) };
const moduleUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`;

describe('loadPlugin', () => {
  it('rejects a module without container/decoder exports (an empty chunk) instead of registering undefined', async () => {
    await expect(loadPlugin({ module: moduleUrl('export const x = 1;') })).rejects.toMatchObject({ code: 'no-decoder' });
    await expect(loadPlugin({ module: moduleUrl("export const container = 'x'; export const decoder = {};") })).rejects.toMatchObject({ code: 'no-decoder' });
  });

  it("hands the plugin's options to configure() and registers its container", async () => {
    const code = `export const container = 'cfg'; export const decoder = { decode() {} };
      export const matches = (b) => b[0] === 0x43; export function configure(o) { globalThis.cfgOptions = o; }`;
    await loadPlugin({ module: moduleUrl(code), options: { wasm: 'https://cdn.example/x.wasm' } });
    expect((globalThis as { cfgOptions?: unknown }).cfgOptions).toEqual({ wasm: 'https://cdn.example/x.wasm' });
    expect(detect(new Blob([]), new Uint8Array([0x43, 0, 0, 0]))).toBe('cfg');
  });
});

describe('detect', () => {
  it('routes to a registered custom container when its matcher hits', () => {
    registerDecoder('xyz', noop, (bytes) => bytes[0] === 0x58 && bytes[1] === 0x59 && bytes[2] === 0x5a);
    expect(detect(new Blob([]), new Uint8Array([0x58, 0x59, 0x5a, 0]))).toBe('xyz');
    expect(detect(new Blob([]), new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('native');
  });

  it('keeps built-in magic ahead of custom matchers', () => {
    registerDecoder('greedy', noop, () => true);
    expect(detect(new Blob([]), new Uint8Array([0x38, 0x42, 0x50, 0x53]))).toBe('psd');
  });
});

describe('dimensions', () => {
  it('reports the format it read the header of', async () => {
    const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(640), ...u32(480), 8, 6, 0, 0, 0]);
    expect(await dimensions(new Blob([png]))).toMatchObject({ format: 'png', width: 640, height: 480, method: 'header' });
  });

  it('reads 64 KB of a file whose header is there, and up to 512 KB when a big EXIF block pushes the JPEG size further', async () => {
    const u16 = (n: number) => [n >> 8, n & 0xff];
    const reads: number[] = [];
    class Tracked extends Blob {
      override slice(start?: number, end?: number) {
        reads.push((end ?? this.size) - (start ?? 0));
        return super.slice(start, end);
      }
    }
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0x80, 0, 0, 1, 0xe0, 8, 6, 0, 0, 0];
    expect(await dimensions(new Tracked([new Uint8Array(png), new Uint8Array(600_000)]))).toMatchObject({ width: 640, method: 'header' });
    expect(reads).toEqual([64 * 1024]);
    // 2 APP1 segments of ~50 KB each (EXIF + XMP), then SOF0 for 4000x3000.
    const app1 = [0xff, 0xe1, ...u16(50_000), ...new Array(49_998).fill(0)];
    const sof = [0xff, 0xc0, ...u16(17), 8, ...u16(3000), ...u16(4000), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda];
    reads.length = 0;
    const jpeg = new Tracked([new Uint8Array([0xff, 0xd8, ...app1, ...app1, ...sof]), new Uint8Array(600_000)]);
    expect(await dimensions(jpeg)).toMatchObject({ format: 'jpeg', width: 4000, height: 3000, method: 'header' });
    expect(reads).toEqual([64 * 1024, 512 * 1024]);
  });
});

describe('thumbnail routing', () => {
  // Node has no image decoding: stand in for the browser's decoder and canvas, keep imagefast's routing real.
  const browserDecodes = (ok: boolean) => {
    vi.stubGlobal('createImageBitmap', async () => {
      if (!ok) throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      return { width: 8, height: 6, close() {} };
    });
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext = () => ({ drawImage() {} });
        convertToBlob = async () => new Blob(['jpeg'], { type: 'image/jpeg' });
      },
    );
  };
  afterEach(() => vi.unstubAllGlobals());
  const heicFile = () =>
    new Blob([new Uint8Array([0, 0, 0, 24, ...[...'ftypheic'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63])]);
  const calls: string[] = [];
  registerDecoder('heic', { decode: async () => (calls.push('plugin'), { bitmap: { width: 4, height: 3, close() {} } as ImageBitmap, width: 4, height: 3 }) });

  it('lets the browser decode HEIC first, so the plugin (and its wasm) is not touched where that works', async () => {
    browserDecodes(true);
    calls.length = 0;
    const t = await thumbnail(heicFile(), { width: 4 });
    expect(t).toMatchObject({ width: 4, height: 3, sourceWidth: 8 });
    expect(t.decodedBy).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("reports a RAW file's metadata without carrying its preview JPEG along with the thumbnail", async () => {
    browserDecodes(true);
    const preview = new Blob(['jpeg'], { type: 'image/jpeg' });
    const raw = {
      blob: preview,
      width: 6000,
      height: 4000,
      previewWidth: 1600,
      previewHeight: 1067,
      method: 'embedded',
      camera: 'Canon EOS R5',
      ms: 1,
    } as const;
    registerDecoder('raw', { decode: async () => ({ blob: preview, width: 6000, height: 4000, raw }) });
    const t = await thumbnail(new File([new Uint8Array(64)], 'x.cr3'), { width: 4 });
    expect(t.raw).toEqual({ width: 6000, height: 4000, previewWidth: 1600, previewHeight: 1067, method: 'embedded', camera: 'Canon EOS R5', ms: 1 });
  });

  it('treats raw.width as a floor for the RAW preview: larger than the box is honoured, smaller is not', async () => {
    browserDecodes(true);
    const asked: number[] = [];
    registerDecoder('raw', {
      decode: async (_file, opts) => (asked.push(opts.width), { bitmap: { width: 8, height: 6, close() {} } as ImageBitmap, width: 6000, height: 4000 }),
    });
    const rawFile = new File([new Uint8Array(64)], 'x.cr3');
    await thumbnail(rawFile, { width: 4, raw: { width: 2 } });
    await thumbnail(rawFile, { width: 4, raw: { width: 16 } });
    expect(asked).toEqual([4, 16]);
  });

  it('falls back to the plugin when the browser cannot decode HEIC', async () => {
    browserDecodes(false);
    calls.length = 0;
    expect(await thumbnail(heicFile(), { width: 4 })).toMatchObject({ decodedBy: 'heic', width: 4, height: 3 });
    expect(calls).toEqual(['plugin']);
  });
});
