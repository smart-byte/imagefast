import workerUrl from './worker-heic.ts?worker&url';
import type { ImageFastPlugin } from './plugin';

/**
 * HEIC/HEIF decoder for `createImageFast({ plugins: [heic] })`: libheif as WebAssembly (LGPL-3, a separate file, about
 * 715 KB gzipped), fetched for the first HEIC the browser cannot decode itself. Safari never fetches it.
 */
export const heic: ImageFastPlugin = {
  module: workerUrl,
  // libheif-js's self-contained ESM build, unmodified; the library build ships a copy next to this entry.
  options: { libheif: new URL('../node_modules/libheif-js/libheif-wasm/libheif-bundle.mjs', import.meta.url).href },
};
