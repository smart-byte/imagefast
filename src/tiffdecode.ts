import UTIF from 'utif';
import { bitmapFromRgba, fitSize, orientBitmap } from './canvas';
import { ImageFastError } from './errors';
import type { Decoder } from './plugin';

/** 16384 squared, the canvas area limit in Chromium and Safari. A forged header could otherwise make UTIF allocate gigabytes. */
const TIFF_MAX_PIXELS = 16384 * 16384;

export const tiffDecoder: Decoder = {
  decode: async (file, opts) => {
    const buf = await file.arrayBuffer();
    const ifds = UTIF.decode(buf);
    const ifd = ifds[0]; // the main image: the header probe reads its size from IFD0 too
    const storedWidth = ifd?.t256?.[0];
    const storedHeight = ifd?.t257?.[0];
    if (!ifd || !storedWidth || !storedHeight) throw new ImageFastError('decode-failed', 'TIFF contains no image');
    if (storedWidth * storedHeight > TIFF_MAX_PIXELS) {
      throw new ImageFastError('decode-failed', `TIFF is too large to decode (${storedWidth} x ${storedHeight})`);
    }
    UTIF.decodeImage(buf, ifd, ifds);
    const rgba = UTIF.toRGBA8(ifd);
    const data = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength);
    const orientation = ifd.t274?.[0] ?? 1;
    const swap = orientation >= 5;
    const width = swap ? ifd.height : ifd.width;
    const height = swap ? ifd.width : ifd.height;
    // Downscale before orienting; for a 90° rotation the oriented width is the stored height.
    const fit = fitSize(width, height, opts);
    const bitmap = await orientBitmap(
      await bitmapFromRgba(data, ifd.width, ifd.height, { ...opts, width: swap ? fit.height : fit.width, height: undefined }),
      orientation,
    );
    return { bitmap, width, height };
  },
};
