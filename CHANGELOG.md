# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First public release.

### Added

- `createImageFast()`: a pool of workers that start on demand and exit when idle. `dimensions`, `thumbnail`, `bitmap` and `decodeRaw` return promises, take an `AbortSignal`, and fail with an `ImageFastError` that carries a `code`. `workers: 0` runs everything on the calling thread instead.
- `dimensions(file)`: oriented width and height plus the format, read from the file header for JPEG, PNG, GIF, WebP, AVIF, HEIC, JPEG XL, BMP, TIFF and PSD. Pixels are decoded only as a fallback.
- `thumbnail(file, options)`: a JPEG, WebP or PNG that fits a `width` × `height` box, or fills it with `fit: 'cover'`. Never upscaled, EXIF orientation applied, no metadata in the output.
- `bitmap(file, options)`: the same pixels as a transferred `ImageBitmap`, without an encode.
- `decodeRaw(file, options)`: the smallest embedded JPEG preview of a RAW file that covers the requested size, or a half-size demosaic when there is none.
- Opt-in decoder plugins, each fetched when the first matching file arrives: `imagefast/raw` (LibRaw 0.22.1 as WebAssembly), `imagefast/heic` (libheif), `imagefast/tiff` (UTIF) and `imagefast/psd`.
- Custom plugins: a module that exports `{ container, decoder, matches?, configure? }`.
- Helpers for building your own pipeline: `isRawFile`, `probeDimensions`, `jpegOrientation`, `hasMetadata` and `fitSize`.
