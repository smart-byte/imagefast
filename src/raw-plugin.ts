import workerUrl from './worker-raw.ts?worker&url';
import type { ImageFastPlugin } from './plugin';

/** Camera RAW decoder for `createImageFast({ plugins: [raw] })`: LibRaw 0.22 as WebAssembly (about 410 KB gzipped), fetched when the first RAW file arrives. */
export const raw: ImageFastPlugin = {
  module: workerUrl,
  options: { wasm: new URL('./libraw.wasm', import.meta.url).href },
};
