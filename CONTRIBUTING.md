# Contributing

Thanks for helping out. imagefast keeps its core tiny (browser-native decoding only) and puts every
other format behind an opt-in plugin, so most contributions land in one of the decoders.

## Setup

```bash
bun install                        # bun.lock is the lockfile; npm install works too (Node >= 22.12, see .nvmrc)
npx playwright install chromium    # once, for the browser tests
npm run build                      # first: both suites also check dist/
npm test                           # unit (vitest, node) + browser (vitest browser mode, headless Chromium)
npm run test:unit                  # header probes, PSD reader, pool (fake workers), routing, error codes, a consumer build of dist/
npm run test:browser               # real workers, plugins, thumbnails, abort/terminate — fixtures generated in the page
npm run type-check                 # tsc --noEmit
npm run format:check               # prettier
npm run build:wasm                 # rebuild src/libraw.{js,wasm} (needs emsdk >= 4.0 on PATH)
npm run bench                      # headless-Chromium benchmarks, see bench/README.md
npm run site                       # landing page with the live demo on http://localhost:4340
npm run site:build                 # bundle the landing page into site-dist/
```

`wasm/libraw/wrapper.cpp` is the whole C++ surface, a flat C ABI over LibRaw. `wasm/libraw/build.sh` downloads the
LibRaw tarball, builds it with emscripten and links the wrapper.

RAW and HEIC decoding need real camera files, which are not in the repo; `bench/` accepts them via
`IMAGEFAST_RAW` / `IMAGEFAST_HEIC` (see `bench/README.md`).

## Pull requests

- One change per PR. Pure helpers (`probe.ts`, `psddecode.ts`, `pool.ts`) need a unit spec; anything that
  touches routing, workers or canvas needs a case in `src/imagefast.browser.spec.ts`.
- New formats go in as a plugin (`src/<fmt>-plugin.ts` + `src/<fmt>decode.ts` + `src/worker-<fmt>.ts`),
  never into the core worker. See `src/plugin.ts` for the interface and `src/test/xyz-*.ts` for a minimal one.
  The decoder module must build to one file (consumers' bundlers copy it as is); big files it fetches lazily go in
  `RUNTIME_FILES` in `vite.config.ts` and reach the module as `options` URLs.
- Errors thrown to users are `ImageFastError`s with a `code` (`src/errors.ts`); do not throw bare `Error`s.
- Third-party code that ends up in `dist/` must be listed in `THIRD_PARTY_NOTICES.md` with its licence.
- Run `npm run type-check && npm run format:check && npm test && npm run build` before pushing; CI runs the same.

## Reporting bugs

Attach (or link) the file that fails, the browser and version, and whether the failure is in
`dimensions`, `thumbnail` or `decodeRaw`. Camera model matters for RAW issues.
