export { createImageFast } from './imagefast';
export type { ImageFast, ImageFastOptions, CallOptions } from './imagefast';
export { ImageFastError } from './errors';
export type { ImageFastErrorCode } from './errors';
export type { ImageFastPlugin, PluginModule, Container, Decoder, Decoded, DecodeOptions, Fit, Matcher, Size } from './plugin';
export { isRawFile, RAW_EXTENSIONS, RAW_MIME_TYPES } from './raw';
export type { Dimensions, ThumbnailOptions, ThumbnailResult, BitmapOptions, BitmapResult, Resampling } from './ops';
export type { RawDecodeOptions, RawDecodeResult } from './rawdecode';
export type { PoolStats } from './pool';

// Lower-level helpers: not covered by semver before 1.0.
export { probeDimensions, jpegOrientation, hasMetadata } from './probe';
export { fitSize } from './canvas';
export type { Probed, ProbedFormat } from './probe';
