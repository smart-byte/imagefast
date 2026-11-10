# imagefast

Image dimensions, thumbnails and RAW previews in the browser, on a worker pool. Zero dependencies, 11 KB gzipped,
with opt-in decoders for camera RAW, HEIC, TIFF and PSD.

[![npm](https://img.shields.io/npm/v/imagefast.svg)](https://www.npmjs.com/package/imagefast)
[![CI](https://github.com/smart-byte/imagefast/actions/workflows/ci.yml/badge.svg)](https://github.com/smart-byte/imagefast/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[Live demo at imagefast.dev](https://imagefast.dev)**

```bash
npm install imagefast
```

```ts
import { createImageFast } from 'imagefast';

const fast = createImageFast(); // one instance per app, created in browser code

const { width, height } = await fast.dimensions(file); // reads the header: no decode, well under 1 ms
const { blob } = await fast.thumbnail(file, { width: 1024 }); // decoded, resized and encoded in a worker
```

- **Dimensions without decoding.** Width, height and format come from the file header, EXIF orientation applied:
  0.3 ms for a 12 MP JPEG instead of 54 ms.
- **The page keeps painting.** 40 twelve-megapixel JPEGs become thumbnails in 303 ms on the worker pool, and no
  frame arrives late (longest gap 17 ms at 60 Hz).
- **RAW in tens of milliseconds.** The camera's embedded preview is used before any demosaic: 7 RAW files (160 MB)
  in 52 ms.
- **Pay for what you use.** The RAW, HEIC, TIFF and PSD decoders are plugins that download when the first such file
  arrives.
- **Safe output.** Thumbnails are oriented, never upscaled and carry no EXIF, so GPS tags do not leak.

Measured on an Apple M3 Max in Chromium 156; method and full tables in [BENCHMARKS.md](BENCHMARKS.md).

## Usage

```ts
import { createImageFast, isRawFile } from 'imagefast';
import { raw } from 'imagefast/raw'; // optional decoders: bundled only if you import them
import { heic } from 'imagefast/heic';

const fast = createImageFast({ plugins: [raw, heic] });

// A square grid tile: fills the box, cropped around the centre
const tile = await fast.thumbnail(file, { width: 256, height: 256, fit: 'cover', type: 'image/webp' });
img.src = URL.createObjectURL(tile.blob);

// Pixels for a canvas, without an encode
const { bitmap } = await fast.bitmap(file, { width: 800 });
ctx.drawImage(bitmap, 0, 0);
bitmap.close();

// The camera's own JPEG preview of a RAW file
if (isRawFile(file)) {
  const { blob, camera, method } = await fast.decodeRaw(file, { width: 1024 });
}

// Cancel or time out any call
await fast.thumbnail(file, { signal: AbortSignal.timeout(10_000) });

fast.terminate(); // optional: workers exit on their own after 5 s of idle time
```

## API

### `createImageFast(options?)`

| option    | default                           |                                                                     |
| --------- | --------------------------------- | ------------------------------------------------------------------- |
| `plugins` | `[]`                              | decoders from `imagefast/raw`, `/heic`, `/tiff`, `/psd`, or your own |
| `workers` | `hardwareConcurrency - 1`, min 1  | pool size; `0` runs everything on the calling thread                |
| `idleMs`  | `5000`                            | idle time after which the workers are terminated                    |

Throws `ImageFastError('unsupported')` where `OffscreenCanvas`, `createImageBitmap` or `Worker` is missing. Create the
instance in browser-only code: after mount when you render on the server, never at module scope.

### Methods

Each takes a `File` or `Blob`, plus an optional `signal` among its options.

| method                      | resolves with                                                                             |                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `dimensions(file)`          | `{ width, height, format?, method, ms }`                                                  | oriented size; `method` is `'header'`, `'decode'` or `'plugin'`              |
| `thumbnail(file, options?)` | `{ blob, width, height, sourceWidth, sourceHeight, reusedSource, decodedBy?, raw?, ms }`  | an encoded image that fits the box                                           |
| `bitmap(file, options?)`    | `{ bitmap, width, height, sourceWidth, sourceHeight, decodedBy?, raw?, ms }`              | the same pixels as a transferred `ImageBitmap`; `close()` it after drawing   |
| `decodeRaw(file, options?)` | `{ blob, width, height, previewWidth, previewHeight, method, camera, ms }`                | a RAW file's JPEG preview; needs `imagefast/raw`                             |
| `stats()`                   | `{ size, workers, busy, queued }`                                                         | synchronous                                                                  |
| `terminate()`               |                                                                                           | kills the workers; pending calls reject, the next call starts new workers    |

`decodedBy` names the plugin that decoded the file. `raw` is the `decodeRaw` result without its `blob`, present for RAW
inputs. `ms` is the time spent in the worker, without queueing.

### `thumbnail` and `bitmap` options

| option                  | default        |                                                                                                              |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| `width`                 | `1024`         | box width; the result is never upscaled                                                                      |
| `height`                | none           | box height                                                                                                   |
| `fit`                   | `'contain'`    | `'cover'` fills the box and crops around the centre                                                          |
| `resampling`            | `'medium'`     | scaler filter: `'pixelated'`, `'low'`, `'medium'` or `'high'`                                                |
| `raw`                   |                | `decodeRaw` options, used for RAW inputs; its `width` can ask for a larger preview than the box, not a smaller |
| `type`                  | `'image/jpeg'` | `thumbnail` only: or `'image/webp'`, `'image/png'`                                                           |
| `quality`               | `0.8`          | `thumbnail` only: encoder quality from 0 to 1                                                                |
| `reuseSourceBelowBytes` | `250000`       | `thumbnail` only: a source of the right type that fits the box, is smaller than this and has no EXIF, XMP or IPTC is returned untouched (`reusedSource: true`); `0` always re-encodes |

`decodeRaw` options: `width` (default 1024; the smallest embedded preview that covers a box this wide is returned,
otherwise a half-size demosaic) and `quality` (default 0.9; only used when a preview has to be encoded).

### Errors

Calls reject with an `ImageFastError`; branch on its `code`.

| code             | when                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `unsupported`    | thrown by `createImageFast` where a required browser API is missing                                    |
| `no-decoder`     | the file needs a plugin that was not passed in; the message names the import                           |
| `decode-failed`  | the browser or a plugin could not decode the file                                                      |
| `aborted`        | the call's `signal` fired: a queued job is dropped, a running job's worker is terminated and replaced  |
| `terminated`     | `terminate()` was called while the job was pending                                                     |
| `worker-crashed` | the worker died, or could not start (bad URL, CSP), which fails every queued job                       |

Bad arguments are refused before any work starts: a `file` that is not a `Blob` rejects with a `TypeError`, a `width`
or `height` that is not a positive number with a `RangeError`, and options that cannot be cloned into a worker (a
function, say) with the browser's `DataCloneError`. With `workers: 0` a running job cannot be aborted.

### Orientation and metadata

`thumbnail` and `bitmap` rotate the pixels and return no EXIF at all, so the result displays correctly everywhere.
`decodeRaw` returns the camera's preview with its compressed pixels untouched and the orientation written into its EXIF
tag: browsers apply it, a consumer that strips EXIF sees the unrotated image. For baked pixels from a RAW file, call
`thumbnail`.

## Formats

Whatever the browser decodes works without a plugin: JPEG, PNG, WebP, GIF, AVIF, BMP. `dimensions` reads the header
of JPEG, PNG, GIF, WebP, AVIF, HEIC, JPEG XL, BMP, TIFF and PSD without any plugin or decode.

| plugin           | reads                                                                                         | decoder                         | download (gzip), on first use        |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------ |
| `imagefast/raw`  | camera RAW from 1,200+ cameras: CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2 and more                | LibRaw 0.22.1 as WebAssembly    | 7.5 KB + `libraw.wasm` 402 KB        |
| `imagefast/heic` | HEIC and HEIF, rotation and mirroring applied; not fetched where the browser decodes HEIC     | libheif-js 1.23.5 (LGPL-3)      | 0.8 KB + `libheif.js` 714 KB         |
| `imagefast/tiff` | uncompressed, LZW, PackBits, Deflate and JPEG-in-TIFF; 16-bit, CMYK, orientation              | UTIF                            | 30 KB                                |
| `imagefast/psd`  | the flattened composite (raw or RLE, 8/16-bit, RGB, gray, CMYK), else the embedded thumbnail  | built in                        | 1.5 KB                               |

- RAW files are recognised by file name or MIME type (`isRawFile`), so pass a `File`, or a `Blob` with a `type`.
- DNG 1.7 with JPEG XL data and Nikon HE/HE\* NEF cannot be demosaiced; their embedded previews still work.
- A PSD composite above 40 megapixels falls back to the embedded thumbnail. A TIFF above 268 megapixels is rejected.
- With the RAW plugin each worker holds a LibRaw heap that starts at 64 MB and grows to the largest file it has seen,
  until the worker goes idle. For large RAW files on many-core machines, set a smaller `workers`.

### Your own plugin

A plugin is one decoder module plus an object that points at it. `src/test/xyz-*.ts` is a complete example that the
browser tests run.

```ts
// my-decoder.ts: imported by URL in every worker, and on the calling thread with `workers: 0`
import type { Decoder } from 'imagefast';

export const container = 'xyz'; // any name; 'raw', 'tiff', 'psd' or 'heic' replaces a built-in decoder
export const matches = (bytes: Uint8Array) => bytes[0] === 0x58; // sees the first 64 bytes; built-in formats win
export const configure = (options: Record<string, string>) => {}; // optional: receives the plugin's `options`
export const decoder: Decoder = {
  // `box` is { width, height?, fit? }: downscale to fitSize(fullWidth, fullHeight, box), no further
  decode: async (file, box) => ({ blob, width, height }), // or { bitmap, width, height }
};

// my-plugin.ts
import type { ImageFastPlugin } from 'imagefast';
import moduleUrl from './my-decoder.ts?worker&url'; // Vite; other bundlers have an equivalent

export const xyz: ImageFastPlugin = { module: moduleUrl, options: { wasm: new URL('./my.wasm', import.meta.url).href } };
```

Vite builds `?worker&url` modules as standalone scripts and drops their exports. Keep them with
`worker: { plugins: () => [{ name: 'keep-exports', options: (o) => ({ ...o, preserveEntrySignatures: 'strict' }) }] }`.
A decoder module shipped pre-built in a package must be a single file: reference anything it fetches through `options`
URLs.

## Requirements

- **Browsers:** Chrome and Edge 94+, Firefox 114+, Safari 17+. It needs module workers, `OffscreenCanvas` and
  `createImageBitmap` with `imageOrientation`, and ships as ES2022. There is no polyfill path.
- **Bundlers:** ESM only, with TypeScript types. Works with any bundler that emits `new URL('./file', import.meta.url)`
  assets and module workers (Vite, webpack 5, Rollup, Parcel 2, esbuild with `--splitting`), and unbundled from a
  `<script type="module">`.

## Lower-level exports

Not covered by semver before 1.0.

| export                                                | what                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `probeDimensions(bytes)`                              | `{ format, width, height }` from a file's first bytes, or `null`                  |
| `jpegOrientation(bytes)`                              | EXIF orientation 1 to 8 of a JPEG, or `null`                                      |
| `hasMetadata(bytes)`                                  | whether a JPEG, PNG or WebP carries EXIF, XMP or IPTC                             |
| `fitSize(width, height, box)`                         | the size an image scales to for `{ width, height?, fit? }`; for plugin decoders   |
| `isRawFile(file)`, `RAW_EXTENSIONS`, `RAW_MIME_TYPES` | RAW detection by MIME type or extension                                           |

Types: `ImageFast`, `ImageFastOptions`, `CallOptions`, `ImageFastError`, `ImageFastErrorCode`, `Dimensions`,
`ThumbnailOptions`, `ThumbnailResult`, `BitmapOptions`, `BitmapResult`, `RawDecodeOptions`, `RawDecodeResult`,
`PoolStats`, `Resampling`, `Fit`, `Size`, `ImageFastPlugin`, `PluginModule`, `Decoder`, `Decoded`, `DecodeOptions`,
`Matcher`, `Container`, `Probed`, `ProbedFormat`.

## Compared with

From each project's README as of September 2026; sizes are min+gzip from bundlephobia; the two timing rows are from
[BENCHMARKS.md](BENCHMARKS.md), each library with its defaults.

|                             | imagefast                                                     | browser-image-compression 2.0 | pica 10                   | compressorjs 1.4 | blueimp-load-image 5.16 | exifr 7                  | image-size 2    |
| --------------------------- | ------------------------------------------------------------- | ----------------------------- | ------------------------- | ---------------- | ----------------------- | ------------------------ | --------------- |
| Off the main thread         | ✅ reused worker pool                                         | ✅ one worker per call        | ✅ resampling only        | ❌               | ❌                      | ✅ manual                | n/a             |
| Takes a `File` or `Blob`    | ✅                                                            | ✅                            | ❌ needs a canvas         | ✅               | ✅                      | ❌ metadata only         | ❌ headers only |
| Thumbnails                  | ✅                                                            | ✅                            | ✅ high-quality filters   | ✅               | ✅                      | ❌                       | ❌              |
| Header-only dimensions      | ✅ 10 formats                                                 | ❌                            | ❌                        | ❌               | ❌                      | partial, from EXIF       | ✅ 20+ formats  |
| EXIF orientation            | ✅                                                            | ✅                            | ❌                        | ✅ JPEG          | ✅                      | reads it                 | reads it        |
| Camera RAW                  | ✅ plugin, 1,200+ cameras                                     | ❌                            | ❌                        | ❌               | ❌                      | ❌                       | ❌              |
| TIFF, PSD, HEIC decode      | ✅ plugins                                                    | ❌                            | ❌                        | ❌               | ❌                      | ❌                       | sizes only      |
| Runtime dependencies        | 0                                                             | 1                             | 2                         | 2                | 0                       | 0                        | 0               |
| Size (gzip)                 | 6.8 KB + 4.5 KB worker                                        | 19.6 KB                       | 16.6 KB                   | 4.6 KB           | 9.1 KB                  | 26 KB                    | 4.2 KB          |
| 40 × 12 MP → 1024 px        | 303 ms                                                        | 501 ms                        | 2,923 ms                  | 2,763 ms         | 2,585 ms                | n/a                      | n/a             |
| Longest frame gap           | 17 ms                                                         | 18 ms                         | 228 ms                    | 119 ms           | 124 ms                  | n/a                      | n/a             |
| Runs in                     | browser                                                       | browser                       | browser                   | browser          | browser                 | browser, Node            | Node, browser   |

On a server, use [sharp](https://sharp.pixelplumbing.com/). When final-quality downscaling matters more than
throughput, pica's filters beat the browser's scaler that imagefast uses; the two combine well.

## Develop

Setup, tests and the WebAssembly build are in [CONTRIBUTING.md](CONTRIBUTING.md). New formats go in as plugins, never
into the core worker.

## Licence

imagefast is [MIT](LICENSE). The distributed files also contain third-party code with their own licences, listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): LibRaw 0.22.1 (CDDL 1.0) in `imagefast/raw`, UTIF and pako (MIT)
in `imagefast/tiff`, and libheif with libde265 (LGPL-3), which `imagefast/heic` loads from `dist/libheif.js`, a
separate and replaceable file with its licence next to it.
