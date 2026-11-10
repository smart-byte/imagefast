import type { LibHeif } from 'libheif-js/libheif-wasm/libheif-bundle.mjs';
import { bitmapFromRgba } from './canvas';
import { ImageFastError } from './errors';
import { lazy } from './lazy';
import type { Decoder } from './plugin';

let libheifUrl: string | undefined;

/** Called once per thread with `heic.options` (`libheif`: the URL of libheif-js's ESM bundle, resolved by the consumer's bundler). */
export function configure(options: Record<string, string>): void {
  libheifUrl = options.libheif;
}

const libheif = lazy(() =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ libheifUrl!).then((m: { default: () => LibHeif | Promise<LibHeif> }) => m.default()),
);

export const heicDecoder: Decoder = {
  decode: async (file, opts) => {
    const heif = await libheif();
    const images = new heif.HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()));
    if (!images.length) throw new ImageFastError('decode-failed', 'HEIC contains no image');
    const image = images.find((i) => i.is_primary()) ?? images[0]!;
    const width = image.get_width(); // libheif applies irot/imir, so this is the display size
    const height = image.get_height();
    const data = new Uint8ClampedArray(width * height * 4);
    try {
      await new Promise<void>((resolve, reject) =>
        image.display({ data, width, height }, (r) => (r ? resolve() : reject(new ImageFastError('decode-failed', 'HEIC decode failed')))),
      );
    } finally {
      for (const i of images) i.free();
    }
    return { bitmap: await bitmapFromRgba(data, width, height, opts), width, height };
  },
};
