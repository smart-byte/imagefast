import workerUrl from './worker-tiff.ts?worker&url';
import type { ImageFastPlugin } from './plugin';

/** TIFF decoder for `createImageFast({ plugins: [tiff] })`: UTIF (30 KB gzipped). LZW, PackBits, Deflate, JPEG-in-TIFF, 16-bit, CMYK. */
export const tiff: ImageFastPlugin = { module: workerUrl };
