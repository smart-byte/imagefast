import workerUrl from './worker-psd.ts?worker&url';
import type { ImageFastPlugin } from './plugin';

/** PSD decoder for `createImageFast({ plugins: [psd] })` (1.5 KB gzipped): the flattened composite (raw or RLE, 8/16-bit, RGB, gray, CMYK), else the embedded JPEG thumbnail. */
export const psd: ImageFastPlugin = { module: workerUrl };
