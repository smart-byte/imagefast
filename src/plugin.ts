import type { RawDecodeResult } from './rawdecode';

export interface Size {
  width: number;
  height: number;
}

/** File containers imagefast routes to a decoder. 'native' = the browser decodes it itself; plugins may add their own names. */
export type Container = 'native' | 'raw' | 'tiff' | 'psd' | 'heic' | (string & {});

/** How an image is scaled into a width x height box: whole image inside it, or filling it (and cropped by the caller). */
export type Fit = 'contain' | 'cover';

/**
 * The box the caller scales the decoded image into. A decoder may downscale to `fitSize(fullWidth, fullHeight, options)`
 * (exported for plugins) but no further.
 */
export interface DecodeOptions {
  width: number;
  height?: number;
  fit?: Fit;
  /** Encoder quality 0..1, for decoders that have to produce a JPEG. */
  quality: number;
}

/** A browser-decodable blob (e.g. a JPEG preview) or already-decoded pixels, plus the full image size. */
export type Decoded = ({ blob: Blob } | { bitmap: ImageBitmap }) & {
  /** Dimensions of the full image (a `bitmap` may already be downscaled to fit the requested box). */
  width: number;
  height: number;
  raw?: RawDecodeResult;
};

export interface Decoder {
  /** Optional cheap size read; falls back to header probing or decoding. */
  dimensions?(file: Blob): Promise<Size>;
  decode(file: Blob, opts: DecodeOptions): Promise<Decoded>;
}

/** Sniffs the first bytes of a file (at least 64) for a custom container. Built-in formats are checked first. */
export type Matcher = (bytes: Uint8Array, file: Blob) => boolean;

/** What a plugin's decoder module exports; imagefast imports it inside each worker and, for `workers: 0`, on the calling thread. */
export interface PluginModule {
  container: Exclude<Container, 'native'>;
  decoder: Decoder;
  matches?: Matcher;
  /** Receives `ImageFastPlugin.options` before the first decode. */
  configure?(options: Record<string, string>): void;
}

/** What `imagefast/raw`, `imagefast/tiff`, `imagefast/psd` and `imagefast/heic` export. */
export interface ImageFastPlugin {
  /**
   * URL of the decoder module (`import url from './x.ts?worker&url'` in Vite). It is imported by URL at runtime, so a
   * pre-built module shipped in a package must not import other files: their names change in the consumer's build.
   */
  module: string;
  /** Passed to the module's `configure()` on every thread, e.g. URLs of files it fetches lazily. */
  options?: Record<string, string>;
}
