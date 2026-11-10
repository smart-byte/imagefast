# Third-party notices

imagefast's own code is the `src/` TypeScript and `wasm/libraw/wrapper.cpp`. The following third-party
components are compiled or bundled into the distributed files. Their licences apply to those files.

## `dist/libraw.wasm` and the LibRaw glue in `dist/assets/worker-raw-*.js` (used by `imagefast/raw`)

- **LibRaw 0.22.1** — Copyright (C) 2008-2025 LibRaw LLC (https://www.libraw.org). Used under the
  **Common Development and Distribution License (CDDL) 1.0** (LibRaw is dual-licensed LGPL 2.1 / CDDL 1.0;
  we choose CDDL). The licence text and LibRaw's copyright notices ship next to the binary in
  `dist/libraw.LICENSE.txt`. Unmodified sources: https://www.libraw.org/data/LibRaw-0.22.1.tar.gz, which the
  build script in `wasm/libraw/build.sh` fetches.
  LibRaw itself includes code from dcraw.c (Copyright 1997-2018 Dave Coffin), DCB demosaic / FBDD denoise
  (Copyright 2010 Jacek Gozdz, BSD-like) and the X3F library (Copyright 2010 Roland Karlsson, BSD-style); see
  LibRaw's `COPYRIGHT` file.
- **libjpeg** (via the emscripten port) — Independent JPEG Group; "this software is based in part on the work of
  the Independent JPEG Group".
- **zlib** (via the emscripten port) — Copyright (C) 1995-2024 Jean-loup Gailly and Mark Adler, zlib licence.
- **Emscripten runtime** — MIT / University of Illinois/NCSA.

Not enabled in this build: the Adobe DNG SDK, LibRaw demosaic packs (GPL), RawSpeed, LCMS.

## `dist/assets/worker-tiff-*.js` (used by `imagefast/tiff`)

- **UTIF.js 3.1.0** — Copyright (c) 2017 Photopea, MIT licence. Text: `dist/utif.LICENSE.txt`.
- **pako 1.0.11** — Copyright (C) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn, MIT licence. Text:
  `dist/pako.LICENSE.txt`.

## `dist/libheif.js` (used by `imagefast/heic`)

- **libheif-js 1.23.5** (`libheif-wasm/libheif-bundle.mjs`, https://github.com/catdad-experiments/libheif-js) — an
  Emscripten build of **libheif** (Copyright (c) struktur AG, LGPL-3.0) and **libde265** (Copyright (c) struktur AG,
  LGPL-3.0). Distributed unmodified as a separate file, which imagefast imports at runtime by URL and never combines
  with its own code: replace `dist/libheif.js` with another build of the same interface to use your own. The licence
  texts ship next to it in `dist/libheif.LICENSE.txt`; the corresponding sources are libheif
  (https://github.com/strukturag/libheif) and libde265 (https://github.com/strukturag/libde265) at the versions
  libheif-js 1.23.5 builds.
