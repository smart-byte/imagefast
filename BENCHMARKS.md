# Benchmarks

Measured on **2026-11-10** with `npm run bench` ([`bench/run.mjs`](bench/run.mjs) driving
[`bench/page.ts`](bench/page.ts) in headless Chromium through Playwright). Raw output of the run:
[`bench/results/2026-11-10.json`](bench/results/2026-11-10.json) /
[`.md`](bench/results/2026-11-10.md).

| | |
|---|---|
| Machine | MacBook Pro, Apple M3 Max (12 P + 4 E cores), 48 GB, macOS 26.5.1; load average 8.6 before the run |
| Browser | Chromium 156.0.8078.4 (Playwright 1.64.1 headless shell), `navigator.hardwareConcurrency` = 16, 60 Hz |
| imagefast | 0.1.0, served from `src/` via Vite dev server (unminified, HMR client attached) |
| Compared with | `browser-image-compression` 2.0.2, `pica` 10.0.3, `compressorjs` 1.4.0, `blueimp-load-image` 5.16.0, `image-size` 2.1.0 |
| Iterations | 20 per cell, **median** reported; 3 for forced demosaic |

Every number is wall-clock `performance.now()` around the public API on the page, including the
`postMessage` round-trip to the worker and the structured clone of the result. The benchmark ran three
times back to back; the tables show the last run.

## `dimensions()` — header probe vs. decode

One file per format, 4000×3000 for the synthetic ones. "pool" is the full `fast.dimensions(file)` call
through the worker pool; "probe" is the exported `probeDimensions()` on the main thread with a
512 KB head slice; `image-size` gets the same slice on the main thread; "decode" is
`createImageBitmap(file)` on the main thread, which is what you do when you have no header parser.

| file | size | `fast.dimensions` (pool) | `probeDimensions` (main thread) | `image-size` (main thread) | `createImageBitmap` |
|---|---|---|---|---|---|
| JPEG 4000×3000 | 5.0 MB | 0.3 ms | 0.3 ms | 0.4 ms | 54.2 ms |
| PNG 4000×3000 | 27.3 MB | 0.2 ms | 0.3 ms | 0.3 ms | 126 ms |
| WebP 4000×3000 | 5.0 MB | 0.2 ms | 0.2 ms | 0.2 ms | 259 ms |
| PSD 4000×3000 (raw RGB) | 36.0 MB | 0.2 ms | 0.2 ms | 0.3 ms | n/a (browser cannot decode) |
| TIFF 475×330 (real file) | 0.6 MB | 0.3 ms | n/a (slice too short) | 0.2 ms (whole file) | n/a |
| HEIC 3388×2185 (iPhone) | 0.7 MB | 0.2 ms | 0.2 ms | 0.2 ms (reports 3387×2185) | n/a (Chromium has no HEIC) |

- **A header parser never touches pixels**, so its cost does not grow with the image; decode cost does
  (180 to 1,300 times slower for 12 MP files). All six went through imagefast's `header` path.
- **imagefast and `image-size` tie on speed.** Both parse a few hundred bytes. The difference is around
  the parse: imagefast takes a `File`, reads only the ranges it needs and applies EXIF orientation;
  `image-size` takes bytes you have already loaded and covers more formats.
- **The TIFF row** is a file that keeps its directory at the end. The head slice alone answers
  neither parser: `fast.dimensions` reads a second range at the directory's offset, `image-size`
  needed the whole file (0.6 MB here; the read grows with the file).

## `thumbnail()` — 40 × 4000×3000 JPEG (198 MB) → 1024 px JPEG, quality 0.8

All 40 files are handed over at once (`Promise.all`). "per-file" is the median time from call to
resolved promise and therefore includes queueing. Frame gaps come from a `requestAnimationFrame` loop
running alongside: the longest gap is the longest the page went without painting, and one frame at
60 Hz is 16.7 ms. Every approach produced a 1024×768 JPEG.

| approach | total wall | per-file median | longest frame gap | frames > 50 ms | output size |
|---|---|---|---|---|---|
| **imagefast, worker pool** (15 workers) | **303 ms** | 214 ms | **16.9 ms** | **0** | 55 KB |
| imagefast, `workers: 0` (same code on the main thread) | 1002 ms | 905 ms | 137 ms | 6 | 55 KB |
| `browser-image-compression` 2.0.2, `useWebWorker: true` | 501 ms | 424 ms | 17.7 ms | 0 | 138 KB |
| `blueimp-load-image` 5.16.0, canvas + `toBlob` | 2585 ms | 2524 ms | 124 ms | 21 | 71 KB |
| `<img>` + `canvas.toBlob` on the main thread | 2637 ms | 2574 ms | 124 ms | 22 | 71 KB |
| `compressorjs` 1.4.0 | 2763 ms | 2696 ms | 119 ms | 24 | 71 KB |
| `pica` 10.0.3, `createImageBitmap` + `resize` + `toBlob` | 2923 ms | 1908 ms | 228 ms | 6 | 62 KB |

Total wall of the three back-to-back runs:

| approach | run 1 | run 2 | run 3 |
|---|---|---|---|
| imagefast, worker pool | 424 ms | 316 ms | 303 ms |
| imagefast, `workers: 0` | 987 ms | 1018 ms | 1002 ms |
| `browser-image-compression` | 494 ms | 757 ms | 501 ms |
| `blueimp-load-image` | 2691 ms | 2581 ms | 2585 ms |
| `<img>` + `canvas.toBlob` | 2598 ms | 2643 ms | 2637 ms |
| `compressorjs` | 2765 ms | 2720 ms | 2763 ms |
| `pica` | 2896 ms | 3376 ms | 2923 ms |

What the rows tell you:

- **The worker pool keeps the page painting.** No frame arrived late, where every main-thread
  approach held the page for 119 to 137 ms at a time; 40 × 12 MP in a third of a second.
- **`compressorjs` and `blueimp-load-image` cost what a hand-written `<img>` + canvas costs**, because
  that is what they do: decode, draw and encode on the main thread, with more than 20 late frames.
- **`browser-image-compression` also stays off the main thread** and comes closest (1.2 to 2.4 times the
  pool's time across the three runs). It starts one worker per call, 40 here, so it varies with
  scheduling; its files are 2.5 times as large at the same pixel size.
- **`pica` is the slowest here and is not built for this race.** It resamples with its own
  high-quality filter (`mks2013`, which also sharpens) in at most 4 workers, and part of its work
  runs on the main thread, which shows as frame gaps. Use it where the downscale quality matters.
- **`createImageBitmap` + `OffscreenCanvas` is 2.6× faster than `<img>` + `canvas.toBlob`** even
  without workers (1002 vs 2637 ms), because the browser decodes straight to a bitmap and the encode
  happens without a DOM canvas.
- Pool speed-up over `workers: 0` is 3.3×, not 15×: Chromium's JPEG decode and encode are already
  partly parallel internally and the pool is limited by memory bandwidth for 200 MB of input.

## Plugin decoders — `thumbnail(file, { width: 1024 })`, 1 worker

"cold" is the first call (loads the decoder module and, for HEIC, the 2 MB libheif-js bundle);
"warm" is the median of 20 more.

| file | size | source | decoded by | cold | warm |
|---|---|---|---|---|---|
| PSD 4000×3000 raw RGB (synthetic) | 36.0 MB | 4000×3000 | `imagefast/psd` | 107 ms | 76 ms |
| TIFF (real file) | 0.6 MB | 475×330 | `imagefast/tiff` | 11.1 ms | 2.8 ms |
| HEIC (iPhone) | 0.7 MB | 3388×2185 | `imagefast/heic` (libheif-js) | 327 ms | 211 ms |

## RAW — `imagefast/raw` (LibRaw 0.22.1 → WebAssembly), 1 worker

Real camera files. The Canon 1000D / 350D files are private test files; the others are free sample
RAWs from signatureedits.com. Camera names are what LibRaw reports. One worker so the
1 MB wasm module is instantiated exactly once ("cold" row includes that). `decodeRaw` picks the
smallest embedded preview ≥ 1024 px and returns it as stored, which is why it costs little more than
`dimensions`. "forced demosaic" asks for a width no preview can satisfy and so runs LibRaw's
half-size `dcraw_process`.

| camera | file | image | cold (incl. wasm init) | `dimensions` | `decodeRaw` 1024 (embedded) | forced demosaic | `thumbnail` 1024 |
|---|---|---|---|---|---|---|---|
| Canon EOS 1000D (CR2) | 11.7 MB | 2591×3888 | 37.1 ms | 2.0 ms | 2.4 ms (1288×1936) | 214 ms (1296×1944) | 30.2 ms |
| Canon EOS 350D (DNG) | 6.4 MB | 3456×2303 | 5.2 ms | 1.4 ms | 1.4 ms (1024×683) | 166 ms (1728×1152) | 7.0 ms |
| Nikon D60 (NEF) | 8.8 MB | 2613×3900 | 10.5 ms | 2.0 ms | 2.4 ms (2592×3872, only preview) | 205 ms (1307×1950) | 63.2 ms |
| Nikon D810 (NEF) | 75.3 MB | 4928×7380 | 42.4 ms | 11.5 ms | 13.2 ms (1080×1620) | 283 ms (2464×3690) | 37.5 ms |
| Sony ILCE-7C (ARW) | 25.3 MB | 6000×4000 | 13.1 ms | 3.6 ms | 4.0 ms (1616×1080) | 192 ms (3000×2000) | 24.5 ms |
| Sony ILCE-7M4 (ARW) | 16.4 MB | 4608×3072 | 9.1 ms | 2.8 ms | 2.9 ms (1616×1080) | never needed: 3.2 ms (embedded 4608×3072) | 18.2 ms |
| Canon EOS 7D (DNG) | 16.2 MB | 5184×3456 | 9.6 ms | 2.8 ms | 2.7 ms (1024×866) | 363 ms (2592×1728) | 8.2 ms |

All seven files at once on a fresh pool, LibRaw instantiating cold in every worker:
**52 ms for 160 MB**, longest main-thread frame gap 16.9 ms.

- **The D60 row shows the trade-off honestly:** its only embedded preview is almost full size, so
  `thumbnail` has to decode and downscale a 10 MP JPEG (63 ms). Still 3× faster than demosaicing.
- **The 7M4 embeds a preview as large as the image**, so imagefast never needs to demosaic it.

## Bundle size (`dist/`, Vite library build)

What a page actually fetches, per path. Every decoder is one self-contained module, loaded by workers and by
`workers: 0` alike, and only once a file needs it. Measured on the build of November 9, 2026 (gzip level 9).

| what | raw | gzip |
|---|---|---|
| core: `imagefast.js` | 19.6 KB | 6.8 KB |
| core worker (fetched on first call) | 11.2 KB | 4.5 KB |
| each plugin entry (`imagefast/raw`, `/tiff`, `/psd`, `/heic`) | ≤ 233 B | ≤ 190 B |
| `imagefast/raw` decoder module (fetched on first RAW file) | 18.3 KB | 7.5 KB |
| `libraw.wasm` (fetched on first RAW file, compiled while it streams) | 1.08 MB | 402 KB |
| `imagefast/tiff` decoder module (UTIF + pako) | 86.6 KB | 30.2 KB |
| `imagefast/psd` decoder module | 3.0 KB | 1.5 KB |
| `imagefast/heic` decoder module | 1.3 KB | 0.8 KB |
| `libheif.js` (fetched on the first HEIC the browser cannot decode itself) | 2.04 MB | 714 KB |

## Caveats

- **Single machine, headless, and not idle.** An M3 Max with 16 cores flatters the worker pool. On a 4-core laptop
  expect a smaller gap between pool and `workers: 0`, and the same gap in main-thread blocking. Unrelated
  processes kept the load average between 7.7 and 8.6 during the three runs; that costs the parallel rows
  (pool, `workers: 0`, `browser-image-compression`) first and explains most of their spread.
- **Synthetic JPEGs.** The 4000×3000 files are canvas-rendered gradients with a noise overlay
  (~5 MB each), not camera JPEGs. Decode cost of real photos is similar; encode cost depends on
  content.
- **Dev server, not `dist/`.** The library ran unminified from `src/` with Vite's HMR client on the
  page. Production builds are slightly faster, never slower.
- **Every other library ran with its defaults** plus the target: 1024 px wide, JPEG, quality 0.8. That makes
  the comparison "what a drop-in thumbnailer costs", not a like-for-like resize:
  - `browser-image-compression`: `maxWidthOrHeight: 1024, fileType: 'image/jpeg', initialQuality: 0.8,
    useWebWorker: true`. It does more than a resize (iterative size targeting).
  - `pica`: fed an `ImageBitmap` from `createImageBitmap(file)`, the fastest input it accepts, then
    `resize()` with its default `mks2013` filter and `toBlob()`.
  - `compressorjs`: `maxWidth: 1024, quality: 0.8, mimeType: 'image/jpeg'`.
  - `blueimp-load-image`: `maxWidth: 1024, canvas: true, orientation: true`, then `canvas.toBlob`.
- **Output sizes differ** with each library's scaler and encoder settings. Image quality was not compared.
- **The RAW sample set** is seven files from four vendors. LibRaw supports more than 1,200 cameras; times
  scale with sensor size and with what previews the vendor embeds.
- **Not measured:** Safari and Firefox (no Playwright run yet; both support the required APIs, see
  the README), Windows, low-end mobile.

## Reproduce

```bash
cd bench && npm install && npx playwright install chromium && cd ..
npm run bench
# optional real files (never copied into the repo):
IMAGEFAST_RAW="a.cr2:b.nef" IMAGEFAST_HEIC=x.heic IMAGEFAST_TIFF=y.tiff npm run bench
```
