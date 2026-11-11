import createLibRaw, { type LibRawModule } from './libraw.js';
import { bitmapToBlob, canvasToBlob, fitSize, orientBitmap, rgbToRgba } from './canvas';
import { jpegOrientation, orientJpeg, probeDimensions } from './probe';
import { ImageFastError } from './errors';
import { lazy } from './lazy';
import type { DecodeOptions, Decoder } from './plugin';

let wasmUrl: string | undefined;

/** Called once per thread with `raw.options` (`wasm`: the URL of libraw.wasm, resolved by the consumer's bundler). */
export function configure(options: Record<string, string>): void {
  wasmUrl = options.wasm;
}

// The emscripten glue fetches the URL itself with instantiateStreaming: compiles while downloading, and lets the
// browser cache the compiled code for every other worker.
export const loadLibRaw = lazy((): Promise<LibRawModule> =>
  createLibRaw({ locateFile: () => wasmUrl! }).catch((e: unknown) => {
    throw new ImageFastError('decode-failed', `could not load libraw.wasm from ${wasmUrl}: ${e instanceof Error ? e.message : e}`);
  }),
);

// thumbs_list uses LibRaw's *internal* thumbnail enum (libraw_const.h: LibRaw_internal_thumbnail_formats).
// 16-bit PPM (8) is deliberately 'other': dcraw_make_mem_thumb keeps it 16-bit and imageToJpeg only takes 8-bit.
const ITHUMB_JPEG = 4;
const ITHUMB_PPM = 7;
const IMAGE_JPEG = 1; // libraw_processed_image_t.type

export interface RawPreviewInfo {
  format: 'jpeg' | 'bitmap' | 'other';
  width: number;
  height: number;
}

export interface RawInfo {
  /** Oriented size of a full decode. */
  width: number;
  height: number;
  /** dcraw flip code: 0 none, 3 = 180°, 5 = 90° CCW, 6 = 90° CW. */
  flip: number;
  camera: string;
  previews: RawPreviewInfo[];
}

interface Session {
  m: LibRawModule;
  p: number;
  buf: number;
}

// One LibRaw module per worker, calls serialised. Parallelism comes from the worker pool, not from here.
let chain: Promise<unknown> = Promise.resolve();

async function withRaw<T>(file: Blob, fn: (s: Session) => Promise<T> | T): Promise<T> {
  const job = chain.then(async () => {
    const m = await loadLibRaw();
    // _malloc takes a 32-bit size (a larger one would wrap) and returns 0 when the heap cannot grow that far.
    const buf = file.size < 2 ** 32 ? m._malloc(file.size) : 0;
    if (!buf) throw new ImageFastError('decode-failed', `RAW file is too large to load (${Math.round(file.size / 2 ** 20)} MB)`);
    const p = m._lr_new();
    try {
      // Streamed straight into the heap: no second full-size copy of a 50-100 MB file on the JS side.
      const reader = file.stream().getReader();
      for (let off = 0, r; !(r = await reader.read()).done; off += r.value.byteLength) m.HEAPU8.set(r.value, buf + off);
      check(m, m._lr_open(p, buf, file.size), 'open');
      return await fn({ m, p, buf });
    } finally {
      m._lr_free(p);
      m._free(buf);
    }
  });
  chain = job.catch(() => undefined);
  return job;
}

function check(m: LibRawModule, code: number, what: string): void {
  if (code !== 0) throw new ImageFastError('decode-failed', `libraw ${what} failed: ${m.UTF8ToString(m._lr_strerror(code))}`);
}

function readInfo({ m, p }: Session): RawInfo {
  const previews: RawPreviewInfo[] = [];
  const n = m._lr_thumb_count(p);
  for (let i = 0; i < n; i++) {
    const f = m._lr_thumb_format(p, i);
    previews.push({
      format: f === ITHUMB_JPEG ? 'jpeg' : f === ITHUMB_PPM ? 'bitmap' : 'other',
      width: m._lr_thumb_width(p, i),
      height: m._lr_thumb_height(p, i),
    });
  }
  return {
    width: m._lr_width(p),
    height: m._lr_height(p),
    flip: m._lr_flip(p),
    camera: `${m.UTF8ToString(m._lr_make(p))} ${m.UTF8ToString(m._lr_model(p))}`.trim(),
    previews,
  };
}

export function rawInfo(file: Blob): Promise<RawInfo> {
  return withRaw(file, readInfo);
}

export interface RawDecodeOptions {
  /** The smallest embedded preview that covers a box this wide is returned; without one, a half-size demosaic. Default 1024. */
  width?: number;
  /** JPEG quality when a preview has to be (re)encoded. Default 0.9. */
  quality?: number;
}

export interface RawDecodeResult {
  /**
   * The camera's own JPEG preview, with the camera orientation in its EXIF tag rather than baked into the pixels
   * (no re-encode, no generation loss). Browsers apply it; a consumer that strips EXIF loses the rotation.
   */
  blob: Blob;
  /** Dimensions of the RAW image (what a full decode would produce). */
  width: number;
  height: number;
  /** Oriented size of `blob`, as a browser displays it. */
  previewWidth: number;
  previewHeight: number;
  /** Where the preview came from: the file's embedded JPEG, or a demosaic of the sensor data. */
  method: 'embedded' | 'demosaic';
  /** Camera make and model as LibRaw reports them. */
  camera: string;
  /** Time spent on the decode itself (worker side); queueing and message transfer are not included. */
  ms: number;
}

/** The decoder behind `ops.decodeRaw`, which is the public entry and holds the defaults. */
export function decodeRaw(file: Blob, opts: DecodeOptions): Promise<RawDecodeResult> {
  const t0 = performance.now();
  return withRaw(file, async (s) => {
    const { m, p } = s;
    const info = readInfo(s);
    // Smallest listed preview that still covers the box; else LibRaw's default (largest) preview if it does (some
    // entries, e.g. the full-size JPEG in CR3, are listed with unknown 0x0 size); else demosaic. Previews are stored
    // unrotated and share the image's aspect ratio, so long edges compare regardless of orientation.
    const need = fitSize(info.width, info.height, opts);
    const long = Math.max(need.width, need.height);
    const candidates = info.previews
      .map((t, i) => ({ ...t, i, long: Math.max(t.width, t.height) }))
      .filter((t) => t.format !== 'other' && t.long >= long)
      .sort((a, b) => a.long - b.long);
    const thumbIndex = candidates.length ? candidates[0]!.i : m._lr_thumb_default_width(p) >= long ? -1 : null;
    // A preview LibRaw cannot unpack (corrupt, unsupported codec) is not fatal: demosaic instead.
    const embedded = thumbIndex !== null && m._lr_unpack_thumb(p, thumbIndex) === 0;
    let img = 0;
    try {
      if (embedded) img = m._lr_make_thumb(p);
      else {
        check(m, m._lr_process(p, 1, 1, 0, 0, 0), 'process');
        img = m._lr_make_image(p);
      }
      if (!img)
        throw new ImageFastError(
          'decode-failed',
          `libraw ${embedded ? 'make_thumb' : 'make_image'} failed: ${m.UTF8ToString(m._lr_strerror(m._lr_last_error()))}`,
        );
      // Demosaic output already has the camera flip applied by dcraw_process; embedded previews do not.
      const preview = await imageToJpeg(m, img, embedded ? info.flip : 0, opts.quality);
      return {
        blob: preview.blob,
        width: info.width,
        height: info.height,
        previewWidth: preview.width,
        previewHeight: preview.height,
        method: embedded ? 'embedded' : 'demosaic',
        camera: info.camera,
        ms: performance.now() - t0,
      };
    } finally {
      if (img) m._lr_free_image(img);
    }
  });
}

/** A JPEG blob and its oriented pixel size (as a browser will display it). */
interface Jpeg {
  blob: Blob;
  width: number;
  height: number;
}

/** libraw_processed_image_t -> JPEG, applying `flip` as an EXIF tag (JPEG previews) or to the pixels (bitmaps). */
async function imageToJpeg(m: LibRawModule, img: number, flip: number, quality: number): Promise<Jpeg> {
  const size = m._lr_img_size(img);
  const data = m.HEAPU8.slice(m._lr_img_data(img), m._lr_img_data(img) + size);
  if (m._lr_img_type(img) === IMAGE_JPEG) {
    // A preview that carries its own EXIF orientation is left alone (browsers apply it on decode, and Chrome
    // no longer lets us opt out via imageOrientation: 'none'). An untagged preview, or the lazy `1` some cameras
    // write, gets LibRaw's flip written into an EXIF tag: the camera's own pixels are kept byte for byte.
    const exif = FLIP_TO_EXIF[flip] ?? 1;
    const tagged = jpegOrientation(data);
    const oriented = exif !== 1 && (tagged == null || tagged === 1) ? orientJpeg(data, exif) : data;
    if (oriented) {
      const blob = new Blob([oriented], { type: 'image/jpeg' });
      const probed = probeDimensions(oriented);
      if (probed) return { blob, width: probed.width, height: probed.height };
      return sized(blob, await createImageBitmap(blob)); // no SOF in the first bytes: decode to measure
    }
    // Too malformed to tag (no SOI): rotate the pixels instead, which at least goes through a real decoder.
    return rotate(await createImageBitmap(new Blob([data], { type: 'image/jpeg' })), flip, quality);
  }
  const width = m._lr_img_width(img);
  const height = m._lr_img_height(img);
  if (m._lr_img_colors(img) !== 3 || m._lr_img_bits(img) !== 8) throw new ImageFastError('decode-failed', 'unexpected libraw bitmap layout');
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(new ImageData(rgbToRgba(data, width, height), width, height), 0, 0);
  if (!flip) return { blob: await canvasToBlob(canvas, 'image/jpeg', quality), width, height };
  return rotate(canvas.transferToImageBitmap(), flip, quality);
}

/** dcraw flip code -> EXIF orientation. */
const FLIP_TO_EXIF: Record<number, number> = { 0: 1, 3: 3, 5: 8, 6: 6 };

async function rotate(bmp: ImageBitmap, flip: number, quality: number): Promise<Jpeg> {
  const oriented = await orientBitmap(bmp, FLIP_TO_EXIF[flip] ?? 1);
  return sized(await bitmapToBlob(oriented, 'image/jpeg', quality), oriented);
}

function sized(blob: Blob, bmp: ImageBitmap): Jpeg {
  const out = { blob, width: bmp.width, height: bmp.height };
  bmp.close();
  return out;
}

export const rawDecoder: Decoder = {
  dimensions: async (file) => {
    const info = await rawInfo(file);
    return { width: info.width, height: info.height };
  },
  decode: async (file, opts) => {
    const raw = await decodeRaw(file, opts);
    return { blob: raw.blob, width: raw.width, height: raw.height, raw };
  },
};
