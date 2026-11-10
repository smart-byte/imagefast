import { isRawFile } from './raw';
import { fitSize } from './canvas';
import { hasMetadata, isHeic, isPsd, parseTiffIfd, probeDimensions, tiffHeader, type ProbedFormat } from './probe';
import { ImageFastError } from './errors';
import type { Container, DecodeOptions, Decoder, Fit, ImageFastPlugin, Matcher, PluginModule, Size } from './plugin';
import type { RawDecodeOptions, RawDecodeResult } from './rawdecode';

/** Resampling filter used when the bitmap is drawn down to the target size. Does not affect the encoder. */
export type Resampling = 'pixelated' | 'low' | 'medium' | 'high';

const decoders = new Map<Container, { decoder: Decoder; matches?: Matcher }>();

/** Makes `container` decodable. Built-in formats are detected before `matches` is asked. */
export function registerDecoder(container: Exclude<Container, 'native'>, decoder: Decoder, matches?: Matcher): void {
  decoders.set(container, { decoder, matches });
}

/** Imports, configures and registers a plugin's decoder module. */
export async function loadPlugin({ module, options = {} }: ImageFastPlugin): Promise<void> {
  const mod: Partial<PluginModule> = await import(/* @vite-ignore */ /* webpackIgnore: true */ module);
  // An empty chunk (bundler dropped the exports) would otherwise register `undefined` and fail later as 'no-decoder'.
  if (typeof mod.container !== 'string' || typeof mod.decoder?.decode !== 'function') {
    throw new ImageFastError('no-decoder', `plugin module ${module} has no \`container\` / \`decoder\` export (see PluginModule)`);
  }
  mod.configure?.(options);
  registerDecoder(mod.container, mod.decoder, mod.matches);
}

const BUILTIN = new Set(['raw', 'tiff', 'psd', 'heic']);

function notLoaded(container: Container): ImageFastError {
  const hint = BUILTIN.has(container) ? ` import { ${container} } from 'imagefast/${container}' and pass createImageFast({ plugins: [${container}] })` : '';
  return new ImageFastError('no-decoder', `${container.toUpperCase()} file but no ${container} decoder is loaded.${hint}`);
}

/** First read for a header: covers every format's size field and ordinary EXIF blocks. */
const PROBE_BYTES = 64 * 1024;
/** Second read before falling back to a decode: big EXIF/ICC/XMP blocks ahead of a JPEG's SOF or a HEIC's meta box. */
const PROBE_MORE_BYTES = 512 * 1024;
/** Covers every magic number `detect` looks at. */
const DETECT_BYTES = 64;

async function head(file: Blob, n: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, n).arrayBuffer());
}

/** Which decoder a file needs. RAW is decided by name/mime first because NEF/CR2/DNG are TIFF inside. */
export function detect(file: Blob, bytes: Uint8Array): Container {
  if (isRawFile(file)) return 'raw';
  if (isPsd(bytes)) return 'psd';
  if (tiffHeader(bytes)) return 'tiff';
  if (isHeic(bytes)) return 'heic';
  for (const [container, d] of decoders) if (d.matches?.(bytes, file)) return container;
  return 'native';
}

export interface Dimensions extends Size {
  /** 'header' = parsed from the file header (no decode), 'decode' = pixels were decoded, 'plugin' = a plugin read the metadata (LibRaw for RAW). */
  method: 'header' | 'decode' | 'plugin';
  /** What the file is: the header format, or the plugin container ('raw', ...). Absent when only the browser could tell. */
  format?: ProbedFormat | Exclude<Container, 'native'>;
  /** Time spent on the op itself (worker side); queueing and message transfer are not included. */
  ms: number;
}

export async function dimensions(file: Blob): Promise<Dimensions> {
  const t0 = performance.now();
  const bytes = await head(file, PROBE_BYTES);
  const container = detect(file, bytes);
  const format = container === 'native' ? undefined : container;
  const done = (size: Size, method: Dimensions['method'], f = format): Dimensions => ({
    width: size.width,
    height: size.height,
    method,
    format: f,
    ms: performance.now() - t0,
  });
  if (container === 'raw') {
    const d = decoders.get('raw')?.decoder;
    if (!d?.dimensions) throw notLoaded('raw');
    return done(await d.dimensions(file), 'plugin');
  }
  let probed = probeDimensions(bytes);
  if (!probed && file.size > PROBE_BYTES && container !== 'tiff') probed = probeDimensions(await head(file, PROBE_MORE_BYTES));
  if (!probed && container === 'tiff') {
    // IFD0 sits at the end of many TIFFs; read it from there.
    const { ifd, le } = tiffHeader(bytes)!;
    probed = parseTiffIfd(new Uint8Array(await file.slice(ifd, ifd + 64 * 1024).arrayBuffer()), 0, le);
  }
  if (probed) return done(probed, 'header', probed.format);
  const decoder = decoders.get(container)?.decoder;
  if (decoder?.dimensions) return done(await decoder.dimensions(file), 'plugin');
  const bmp = await decodeToBitmap(file, container, { width: 1, quality: 0.5 });
  try {
    return done({ width: bmp.width, height: bmp.height }, 'decode');
  } finally {
    bmp.bitmap.close();
  }
}

export interface BitmapOptions {
  /** Box width. Default 1024. Never upscales. */
  width?: number;
  /** Box height. Default: none, only `width` bounds the result. */
  height?: number;
  /** 'contain' (default): the whole image fits in the box. 'cover': fills the box, cropped around the centre (square grid thumbnails). */
  fit?: Fit;
  /** Scaler filter: 'pixelated' disables smoothing, 'high' is slower on 12 MP inputs. Default 'medium'; rarely worth changing. */
  resampling?: Resampling;
  /** RAW inputs are decoded first (see `decodeRaw`). Its `width` can ask for a larger preview than the box, never a smaller one. */
  raw?: RawDecodeOptions;
}

export interface ThumbnailOptions extends BitmapOptions {
  /** Encoder quality 0..1 (JPEG/WebP). Default 0.8. */
  quality?: number;
  /** Output encoding. Default 'image/jpeg'. */
  type?: 'image/jpeg' | 'image/webp' | 'image/png';
  /**
   * Return the source blob untouched when it already is `type`, fits the box as is, is smaller than this many bytes and free of
   * EXIF/XMP/IPTC metadata (a re-encode drops it, so GPS tags never pass through). Default 250 000; 0 always re-encodes.
   */
  reuseSourceBelowBytes?: number;
}

export interface BitmapResult extends Size {
  /** Transferred to the calling thread: draw it, then `close()` it. */
  bitmap: ImageBitmap;
  /** Oriented size of the source image. */
  sourceWidth: number;
  sourceHeight: number;
  /** Which plugin decoded the file; absent when the browser decoded it natively. */
  decodedBy?: Exclude<Container, 'native'>;
  /** Present when the input was a RAW file: what `decodeRaw` reports, minus the preview JPEG itself. */
  raw?: Omit<RawDecodeResult, 'blob'>;
  /** Time spent on the op itself (worker side); queueing and message transfer are not included. */
  ms: number;
}

export interface ThumbnailResult extends Omit<BitmapResult, 'bitmap'> {
  /** The encoded thumbnail, or the source file itself when `reusedSource` is true. */
  blob: Blob;
  /** The source was returned untouched (see `reuseSourceBelowBytes`). */
  reusedSource: boolean;
}

const ORIENTED = { imageOrientation: 'from-image' } as const;

const withoutPreview = ({ blob: _, ...meta }: RawDecodeResult): Omit<RawDecodeResult, 'blob'> => meta;

interface Source {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  blob?: Blob;
  decodedBy?: Exclude<Container, 'native'>;
  raw?: RawDecodeResult;
}

/** Containers some browsers decode themselves (Safari: HEIC, TIFF). The browser gets the first try, so the plugin's wasm is never fetched there. */
const NATIVE_FIRST = new Set<Container>(['heic', 'tiff']);

async function decodeToBitmap(file: Blob, container: Container, opts: DecodeOptions): Promise<Source> {
  const decoder = decoders.get(container)?.decoder;
  if (container !== 'raw' && (!decoder || NATIVE_FIRST.has(container))) {
    try {
      const bitmap = await createImageBitmap(file, ORIENTED);
      return { bitmap, width: bitmap.width, height: bitmap.height, blob: file };
    } catch (e) {
      if (!decoder) throw container === 'native' ? new ImageFastError('decode-failed', e instanceof Error ? e.message : String(e)) : notLoaded(container);
    }
  }
  if (!decoder) throw notLoaded(container);
  const out = await decoder.decode(file, opts);
  const bitmap = 'bitmap' in out ? out.bitmap : await createImageBitmap(out.blob, ORIENTED);
  return { bitmap, width: out.width, height: out.height, blob: 'blob' in out ? out.blob : undefined, decodedBy: container, raw: out.raw };
}

async function decodeIntoBox(file: Blob, opts: BitmapOptions, quality: number) {
  const box = { width: opts.width ?? 1024, height: opts.height, fit: opts.fit };
  const container = detect(file, await head(file, DETECT_BYTES));
  // `raw.width` is a floor for the preview, never a shrink: the output must still reach the requested box.
  const raw = container === 'raw' ? opts.raw : undefined;
  const src = await decodeToBitmap(file, container, { ...box, quality, ...raw, width: Math.max(box.width, raw?.width ?? 0) });
  // `cover` overflows the box on one side; the canvas is the box and the overflow is cropped around the centre.
  const scaled = fitSize(src.bitmap.width, src.bitmap.height, box);
  const width = Math.min(scaled.width, box.width);
  const height = Math.min(scaled.height, box.height ?? Infinity);
  const base = { sourceWidth: src.width, sourceHeight: src.height, decodedBy: src.decodedBy, raw: src.raw && withoutPreview(src.raw), width, height };
  const draw = () => {
    // Scale with drawImage on a 2D context. createImageBitmap(bitmap, { resizeWidth }) + a bitmaprenderer canvas
    // is marginally faster but Chromium encodes the *un-oriented* buffer for EXIF-rotated sources (portrait
    // JPEGs come out landscape), so we draw instead.
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    const { resampling = 'medium' } = opts;
    ctx.imageSmoothingEnabled = resampling !== 'pixelated';
    ctx.imageSmoothingQuality = resampling === 'pixelated' ? 'low' : resampling;
    ctx.drawImage(src.bitmap, (width - scaled.width) / 2, (height - scaled.height) / 2, scaled.width, scaled.height);
    return canvas;
  };
  return { src, base, draw };
}

export async function thumbnail(file: Blob, opts: ThumbnailOptions = {}): Promise<ThumbnailResult> {
  const t0 = performance.now();
  const { quality = 0.8, type = 'image/jpeg', reuseSourceBelowBytes = 250_000 } = opts;
  const { src, base, draw } = await decodeIntoBox(file, opts, quality);
  try {
    const { blob: source } = src;
    const asIs = base.width === base.sourceWidth && base.height === base.sourceHeight;
    if (asIs && source?.type === type && source.size <= reuseSourceBelowBytes && !hasMetadata(new Uint8Array(await source.arrayBuffer()))) {
      return { ...base, blob: source, reusedSource: true, ms: performance.now() - t0 };
    }
    const blob = await draw().convertToBlob({ type, quality });
    return { ...base, blob, reusedSource: false, ms: performance.now() - t0 };
  } finally {
    src.bitmap.close();
  }
}

export async function bitmap(file: Blob, opts: BitmapOptions = {}): Promise<BitmapResult> {
  const t0 = performance.now();
  const { src, base, draw } = await decodeIntoBox(file, opts, 0.9);
  try {
    return { ...base, bitmap: draw().transferToImageBitmap(), ms: performance.now() - t0 };
  } finally {
    src.bitmap.close();
  }
}

export async function decodeRaw(file: Blob, opts: RawDecodeOptions = {}): Promise<RawDecodeResult> {
  const d = decoders.get('raw')?.decoder;
  if (!d) throw notLoaded('raw');
  const out = await d.decode(file, { width: opts.width ?? 1024, quality: opts.quality ?? 0.9 });
  if (!out.raw) throw new ImageFastError('decode-failed', 'raw decoder returned no RawDecodeResult');
  return out.raw;
}
