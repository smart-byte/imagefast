import { afterEach, describe, expect, it } from 'vitest';
import UTIF from 'utif';
import { createImageFast, type ImageFast, type ImageFastPlugin } from './index';
import { psd } from './psd-plugin';
import { raw } from './raw-plugin';
import { tiff } from './tiff-plugin';
import { xyz } from './test/xyz-plugin';
import { dngFile, psdFile } from './test/fixtures';
import { hasMetadata, orientJpeg } from './probe';

async function canvasBlob(width: number, height: number, type: 'image/png' | 'image/jpeg'): Promise<Blob> {
  const c = new OffscreenCanvas(width, height);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#c33';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#33c';
  ctx.fillRect(0, 0, width / 2, height / 2);
  return c.convertToBlob({ type, quality: 0.9 });
}

const u16 = (n: number) => [n >> 8, n & 0xff];
const u16le = (n: number) => [n & 0xff, n >> 8];
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Splices an APP1 Exif segment with the given orientation right after SOI. */
async function jpegWithOrientation(width: number, height: number, orientation: number): Promise<File> {
  const bytes = new Uint8Array(await (await canvasBlob(width, height, 'image/jpeg')).arrayBuffer());
  const tiffIfd = [...str('II'), ...u16le(0x2a), 8, 0, 0, 0, ...u16le(1), ...u16le(0x0112), ...u16le(3), 1, 0, 0, 0, ...u16le(orientation), 0, 0, 0, 0, 0, 0];
  const app1 = [0xff, 0xe1, ...u16(2 + 6 + tiffIfd.length), ...str('Exif\0\0'), ...tiffIfd];
  return new File([bytes.subarray(0, 2), new Uint8Array(app1), bytes.subarray(2)], 'rotated.jpg', { type: 'image/jpeg' });
}

function tiffFile(width: number, height: number, tags?: Record<string, unknown>): File {
  const rgba = new Uint8Array(width * height * 4).fill(200);
  return new File([UTIF.encodeImage(rgba, width, height, tags)], 'gray.tif', { type: 'image/tiff' });
}

async function xyzFile(width: number, height: number): Promise<File> {
  return new File([new Uint8Array(str('XYZ!')), await canvasBlob(width, height, 'image/png')], 'a.xyz');
}

let fast: ImageFast | undefined;
afterEach(() => fast?.terminate());

describe('createImageFast (workers)', () => {
  it('reads PNG dimensions from the header', async () => {
    fast = createImageFast();
    const d = await fast.dimensions(await canvasBlob(320, 200, 'image/png'));
    expect(d).toMatchObject({ width: 320, height: 200, method: 'header', format: 'png' });
    expect(fast.stats().workers).toBe(1);
  });

  it('scales a thumbnail down, keeping the aspect ratio', async () => {
    fast = createImageFast();
    const t = await fast.thumbnail(await canvasBlob(400, 300, 'image/png'), { width: 100 });
    expect(t).toMatchObject({ width: 100, height: 75, sourceWidth: 400, sourceHeight: 300, reusedSource: false });
    expect(t.blob.type).toBe('image/jpeg');
    expect(t.decodedBy).toBeUndefined();
  });

  it('fits a thumbnail into a width x height box', async () => {
    fast = createImageFast();
    const t = await fast.thumbnail(await canvasBlob(300, 400, 'image/png'), { width: 200, height: 200 });
    expect(t).toMatchObject({ width: 150, height: 200, sourceWidth: 300, sourceHeight: 400 });
  });

  it('fills the box and crops around the centre with fit: cover', async () => {
    fast = createImageFast();
    const c = new OffscreenCanvas(400, 200);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#f00';
    ctx.fillRect(0, 0, 200, 200);
    ctx.fillStyle = '#00f';
    ctx.fillRect(200, 0, 200, 200);
    const t = await fast.thumbnail(await c.convertToBlob(), { width: 100, height: 100, fit: 'cover', type: 'image/png' });
    expect(t).toMatchObject({ width: 100, height: 100 });
    // A centred square of a red|blue image is red on the left, blue on the right.
    const out = new OffscreenCanvas(100, 100).getContext('2d')!;
    out.drawImage(await createImageBitmap(t.blob), 0, 0);
    expect([...out.getImageData(20, 50, 1, 1).data.slice(0, 3)]).toEqual([255, 0, 0]);
    expect([...out.getImageData(80, 50, 1, 1).data.slice(0, 3)]).toEqual([0, 0, 255]);
  });

  it('hands back the scaled, oriented pixels as an ImageBitmap without encoding them', async () => {
    fast = createImageFast();
    const b = await fast.bitmap(await jpegWithOrientation(400, 300, 6), { width: 150 });
    expect(b).toMatchObject({ width: 150, height: 200, sourceWidth: 300, sourceHeight: 400 });
    expect(b.bitmap).toBeInstanceOf(ImageBitmap);
    expect([b.bitmap.width, b.bitmap.height]).toEqual([150, 200]);
  });

  it('applies EXIF orientation to dimensions and thumbnails', async () => {
    fast = createImageFast();
    const file = await jpegWithOrientation(400, 300, 6);
    expect(await fast.dimensions(file)).toMatchObject({ width: 300, height: 400, method: 'header' });
    const t = await fast.thumbnail(file, { width: 150 });
    expect(t).toMatchObject({ width: 150, height: 200, sourceWidth: 300, sourceHeight: 400 });
  });

  it('returns small sources untouched', async () => {
    fast = createImageFast();
    const src = await canvasBlob(50, 40, 'image/jpeg');
    const t = await fast.thumbnail(src, { width: 100 });
    expect(t.reusedSource).toBe(true);
    expect(t.blob.size).toBe(src.size);
  });

  it('re-encodes a small source that carries EXIF instead of passing its metadata (GPS, orientation) through', async () => {
    fast = createImageFast();
    const t = await fast.thumbnail(await jpegWithOrientation(40, 20, 6), { width: 100 });
    expect(t).toMatchObject({ reusedSource: false, width: 20, height: 40 });
    expect(hasMetadata(new Uint8Array(await t.blob.arrayBuffer()))).toBe(false);
  });

  it('re-encodes a small source when the requested type differs from it', async () => {
    fast = createImageFast();
    const t = await fast.thumbnail(await canvasBlob(50, 40, 'image/png'), { width: 100, type: 'image/webp' });
    expect(t).toMatchObject({ reusedSource: false, width: 50, height: 40 });
    expect(t.blob.type).toBe('image/webp');
  });

  // The RAW decoder tags previews instead of rotating their pixels; a real decoder has to honour those bytes.
  it('writes an EXIF orientation that the browser applies on decode', async () => {
    const src = new Uint8Array(await (await canvasBlob(40, 20, 'image/jpeg')).arrayBuffer());
    const file = new File([orientJpeg(src, 6)!], 'tagged.jpg', { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    expect([bitmap.width, bitmap.height]).toEqual([20, 40]);
    bitmap.close();
    fast = createImageFast();
    expect(await fast.dimensions(file)).toMatchObject({ width: 20, height: 40, method: 'header' });
    expect(await fast.thumbnail(file, { width: 10 })).toMatchObject({ width: 10, height: 20, sourceWidth: 20, sourceHeight: 40 });
  });

  it('orients a rotated TIFF and still hits the target width', async () => {
    fast = createImageFast({ plugins: [tiff] });
    const file = tiffFile(64, 32, { t274: [6] });
    expect(await fast.dimensions(file)).toMatchObject({ width: 32, height: 64, method: 'header' });
    expect(await fast.thumbnail(file, { width: 16 })).toMatchObject({ width: 16, height: 32, sourceWidth: 32, sourceHeight: 64, decodedBy: 'tiff' });
  });

  it('rejects with no-decoder and an import hint when the plugin is missing', async () => {
    fast = createImageFast();
    const err = await fast.thumbnail(psdFile()).catch((e) => e);
    expect(err).toMatchObject({ name: 'ImageFastError', code: 'no-decoder' });
    expect(err.message).toContain('imagefast/psd');
    await expect(fast.dimensions(new File([], 'x.cr2'))).rejects.toMatchObject({ code: 'no-decoder' });
  });

  it('rejects undecodable native input with decode-failed', async () => {
    fast = createImageFast();
    await expect(fast.thumbnail(new Blob([new Uint8Array(64)]))).rejects.toMatchObject({ code: 'decode-failed' });
  });

  it('decodes PSD and TIFF through their plugins inside the worker', async () => {
    fast = createImageFast({ plugins: [psd, tiff] });
    const p = await fast.thumbnail(psdFile(), { width: 2 });
    expect(p).toMatchObject({ width: 2, height: 2, decodedBy: 'psd' });
    expect(await fast.dimensions(psdFile())).toMatchObject({ width: 2, height: 2, method: 'header' });
    const t = await fast.thumbnail(tiffFile(64, 32), { width: 16 });
    expect(t).toMatchObject({ width: 16, height: 8, sourceWidth: 64, sourceHeight: 32, decodedBy: 'tiff' });
    expect(await fast.dimensions(tiffFile(64, 32))).toMatchObject({ width: 64, height: 32, method: 'header' });
  });

  it("sizes a RAW file by the camera's crop, not the whole sensor area LibRaw keeps", async () => {
    fast = createImageFast({ plugins: [raw] });
    expect(await fast.dimensions(dngFile())).toMatchObject({ width: 28, height: 20 });
    const t = await fast.thumbnail(dngFile(), { width: 14 });
    expect(t).toMatchObject({ width: 14, height: 10, sourceWidth: 28, sourceHeight: 20, decodedBy: 'raw' });
  });

  it('routes a custom container through its matcher', async () => {
    fast = createImageFast({ plugins: [xyz] });
    const t = await fast.thumbnail(await xyzFile(40, 20), { width: 20 });
    expect(t).toMatchObject({ width: 20, height: 10, decodedBy: 'xyz' });
  });

  it('aborts a queued job and rejects pending jobs on terminate', async () => {
    fast = createImageFast({ workers: 1 });
    const big = await canvasBlob(1200, 900, 'image/png');
    const first = fast.thumbnail(big);
    const ctl = new AbortController();
    const second = fast.thumbnail(big, { signal: ctl.signal });
    ctl.abort();
    await expect(second).rejects.toMatchObject({ code: 'aborted' });
    await expect(first).resolves.toMatchObject({ width: 1024 });
    const third = fast.thumbnail(big);
    fast.terminate();
    await expect(third).rejects.toMatchObject({ code: 'terminated' });
  });
  it('rejects options that cannot be cloned into a worker and keeps that worker usable', async () => {
    fast = createImageFast({ workers: 1 });
    const png = await canvasBlob(40, 20, 'image/png');
    await expect(fast.thumbnail(png, { width: 20, onProgress: () => {} } as never)).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(fast.stats().busy).toBe(0);
    await expect(fast.thumbnail(png, { width: 20 })).resolves.toMatchObject({ width: 20 });
  });

  it('rejects a width that is not a positive number before any worker starts', async () => {
    fast = createImageFast({ workers: 1 });
    await expect(fast.thumbnail(await canvasBlob(40, 20, 'image/png'), { width: 0 })).rejects.toBeInstanceOf(RangeError);
    expect(fast.stats().workers).toBe(0);
  });
});

describe('createImageFast({ workers: 0 })', () => {
  // `psd` and `xyz` name their decoder modules as worker files, and Vitest starts every worker file with a stub of its
  // own page state. Imported into this page, which is what `workers: 0` does, the stub replaces the real state and the
  // runner dies after the test. So the same modules are named as plain module URLs here.
  const psdOnPage: ImageFastPlugin = { module: new URL('./worker-psd.ts', import.meta.url).href };
  const xyzOnPage: ImageFastPlugin = { module: new URL('./test/xyz-module.ts', import.meta.url).href };

  it('runs on the calling thread with plugins loaded', async () => {
    fast = createImageFast({ workers: 0, plugins: [psdOnPage, xyzOnPage] });
    expect(fast.stats()).toEqual({ size: 0, workers: 0, busy: 0, queued: 0 });
    expect(await fast.thumbnail(psdFile(), { width: 2 })).toMatchObject({ width: 2, height: 2, decodedBy: 'psd' });
    expect(await fast.thumbnail(await xyzFile(40, 20), { width: 20 })).toMatchObject({ decodedBy: 'xyz' });
    expect(await fast.dimensions(await canvasBlob(30, 10, 'image/png'))).toMatchObject({ width: 30, height: 10 });
  });

  it('retries plugin loading after a failed load instead of caching the rejection', async () => {
    let attempts = 0;
    const flaky: ImageFastPlugin = {
      get module() {
        return attempts++ ? psdOnPage.module : `data:text/javascript,${encodeURIComponent("throw new Error('flaky')")}`;
      },
    };
    fast = createImageFast({ workers: 0, plugins: [flaky] });
    await expect(fast.thumbnail(psdFile(), { width: 2 })).rejects.toThrow('flaky');
    expect(await fast.thumbnail(psdFile(), { width: 2 })).toMatchObject({ width: 2, height: 2, decodedBy: 'psd' });
  });
});
