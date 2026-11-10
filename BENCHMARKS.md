# Benchmarks

Measured on **2026-09-07** with `npm run bench` ([`bench/run.mjs`](bench/run.mjs) driving
[`bench/page.ts`](bench/page.ts) in headless Chromium through Playwright). Raw output of the run:
[`bench/results/2026-09-07.json`](bench/results/2026-09-07.json) /
[`.md`](bench/results/2026-09-07.md).

| | |
|---|---|
| Machine | MacBook Pro, Apple M3 Max (12 P + 4 E cores), 48 GB, macOS 26.5.1 |
| Browser | Chromium 148.0.7778.96 (Playwright 1.60 headless shell), `navigator.hardwareConcurrency` = 16 |
| imagefast | 0.1.0, served from `src/` via Vite dev server (unminified, HMR client attached) |
| Iterations | 20 per cell, **median** reported; 3 for forced demosaic |

Every number is wall-clock `performance.now()` around the public API on the page, including the
`postMessage` round-trip to the worker and the structured clone of the result.

## `dimensions()` — header probe vs. decode

One file per format, 4000×3000 for the synthetic ones. "pool" is the full `fast.dimensions(file)` call
through the worker pool; "probe" is the exported `probeDimensions()` on the main thread with the same
512 KB head slice; "decode" is `createImageBitmap(file)` on the main thread, which is what you do when
you have no header parser.

| file | size | `fast.dimensions` (pool) | `probeDimensions` (main thread) | `createImageBitmap` |
|---|---|---|---|---|
| JPEG 4000×3000 | 5.0 MB | 0.3 ms | 0.2 ms | 47.5 ms |
| PNG 4000×3000 | 27.3 MB | 0.2 ms | 0.2 ms | 116 ms |
| WebP 4000×3000 | 5.0 MB | 0.2 ms | 0.2 ms | 250.7 ms |
| PSD 4000×3000 (raw RGB) | 36.0 MB | 0.2 ms | 0.2 ms | n/a (browser cannot decode) |
| TIFF 475×330 (real file) | 0.6 MB | 0.3 ms | 0.2 ms | n/a |
| HEIC 3388×2185 (iPhone) | 0.7 MB | 0.2 ms | 0.2 ms | n/a (Chromium has no HEIC) |

The probe never touches pixels, so its cost does not grow with the image; decode cost does
(**~150–1000× slower** for 12 MP files). All six went through the `header` path.

## `thumbnail()` — 40 × 4000×3000 JPEG (198 MB) → 1024 px JPEG, quality 0.8

All 40 files are handed over at once (`Promise.all`). "per-file" is the median time from call to
resolved promise and therefore includes queueing. Frame gaps come from a `requestAnimationFrame` loop
running alongside: the longest gap is the longest the page went without painting.

| approach | total wall | per-file median | longest frame gap | frames > 50 ms |
|---|---|---|---|---|
| **imagefast, worker pool** (15 workers) | **262 ms** | 183 ms | **9.6 ms** | **0** |
| imagefast, `workers: 0` (same code on the main thread) | 699 ms | 632 ms | 109 ms | 5 |
| `<img>` + `canvas.toBlob` on the main thread | 2560 ms | 2497 ms | 123 ms | 21 |
| `browser-image-compression` 2.0.2, `useWebWorker: true` | 1294 ms | 1283 ms | 18.7 ms | 0 |

Same section, three back-to-back runs (total wall): imagefast pool 386 / 276 / 262 ms,
`browser-image-compression` 950 / 554 / 1294 ms, `<img>` + canvas 2505 / 2489 / 2560 ms,
`workers: 0` 736 / 692 / 699 ms. The pool and main-thread rows are stable; `browser-image-compression`
spawns one worker per call (40 here) and varies a lot with scheduling.

What the rows tell you:

- **`createImageBitmap` + `OffscreenCanvas` is ~3.6× faster than `<img>` + `canvas.toBlob`** even
  on one thread (699 vs 2560 ms), because the browser decodes straight to a bitmap and the encode
  happens without a DOM canvas.
- **The worker pool keeps the page painting.** 9.6 ms longest gap vs 109–123 ms for either
  main-thread approach; 40 × 12 MP in a quarter second.
- Pool speed-up over `workers: 0` is 2.7×, not 15×: Chromium's JPEG decode and encode are already
  partly parallel internally and the pool is limited by memory bandwidth for 200 MB of input.

## Plugin decoders — `thumbnail(file, { width: 1024 })`, 1 worker

"cold" is the first call (loads the decoder module and, for HEIC, the 2 MB libheif-js bundle);
"warm" is the median of 20 more.

| file | size | source | decoded by | cold | warm |
|---|---|---|---|---|---|
| PSD 4000×3000 raw RGB (synthetic) | 36.0 MB | 4000×3000 | `imagefast/psd` | 101 ms | 73 ms |
| TIFF (real file) | 0.6 MB | 475×330 | `imagefast/tiff` | 8.1 ms | 2.2 ms |
| HEIC (iPhone) | 0.7 MB | 3388×2185 | `imagefast/heic` (libheif-js) | 282 ms | 203 ms |

## RAW — `imagefast/raw` (LibRaw 0.22.1 → WebAssembly), 1 worker

Real camera files. The Canon 1000D / 350D files are private test files; the others are free sample
RAWs from signatureedits.com. Camera names are what LibRaw reports. One worker so the
1 MB wasm module is instantiated exactly once ("cold" row includes that). `decodeRaw` picks the
smallest embedded preview ≥ 1024 px; "forced demosaic" asks for a width no preview can satisfy and
so runs LibRaw's half-size `dcraw_process`.

| camera | file | image | cold (incl. wasm init) | `dimensions` | `decodeRaw` 1024 (embedded) | forced demosaic | `thumbnail` 1024 |
|---|---|---|---|---|---|---|---|
| Canon EOS 1000D (CR2) | 11.7 MB | 2602×3906 | 44.8 ms | 1.9 ms | 10.7 ms (1288×1936) | 223 ms (1301×1953) | 38.5 ms |
| Canon EOS 350D (DNG) | 6.4 MB | 3474×2314 | 4.7 ms | 1.2 ms | 2.6 ms (1024×683) | 164 ms (1737×1157) | 7.2 ms |
| Nikon D60 (NEF) | 8.8 MB | 2613×3900 | 23.6 ms | 1.4 ms | 22.4 ms (2592×3872, only preview) | 192 ms (1307×1950) | 80 ms |
| Nikon D810 (NEF) | 75.3 MB | 4928×7380 | 33.6 ms | 9.7 ms | 17.7 ms (1080×1620) | 269 ms (2464×3690) | 42.8 ms |
| Sony ILCE-7C (ARW) | 25.3 MB | 6024×4024 | 19.1 ms | 3.5 ms | 11.9 ms (1616×1080) | 211 ms (3012×2012) | 31.3 ms |
| Sony ILCE-7M4 (ARW) | 16.4 MB | 4692×3132 | 11.5 ms | 2.8 ms | 7.1 ms (1616×1080) | 121 ms (2346×1566) | 20.7 ms |
| Canon EOS 7D (DNG) | 16.2 MB | 5202×3464 | 8.4 ms | 2.4 ms | 4.0 ms (1024×866) | 365 ms (2601×1732) | 7.9 ms |

All seven files at once on a fresh pool, LibRaw instantiating cold in every worker:
**58 ms for 160 MB**, longest main-thread frame gap 8.9 ms.

The D60 row shows the trade-off honestly: its only embedded preview is full size, so the "fast path"
re-encodes a 10 MP JPEG (22 ms) and `thumbnail` has to downscale it (80 ms). Still 2.4× faster than
demosaicing.

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

- **Single machine, headless.** An M3 Max with 16 cores flatters the worker pool. On a 4-core laptop
  expect a smaller gap between pool and `workers: 0`, and the same gap in main-thread blocking.
- **Synthetic JPEGs.** The 4000×3000 files are canvas-rendered gradients with a noise overlay
  (~5 MB each), not camera JPEGs. Decode cost of real photos is similar; encode cost depends on
  content.
- **Dev server, not `dist/`.** The library ran unminified from `src/` with Vite's HMR client on the
  page. Production builds are slightly faster, never slower.
- **`browser-image-compression`** was run with its defaults plus `maxWidthOrHeight: 1024,
  fileType: 'image/jpeg', initialQuality: 0.8, useWebWorker: true`. It does more than a resize
  (iterative size targeting), so the comparison is "what a drop-in thumbnailer costs", not a
  like-for-like resize. It also starts a worker per call; imagefast reuses a pool.
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
