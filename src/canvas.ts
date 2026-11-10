import type { DecodeOptions, Fit, Size } from './plugin';

/** The size a `width` x `height` image scales to so it fits inside (`contain`) or fills (`cover`) the box. Never upscales. */
export function fitSize(width: number, height: number, box: { width: number; height?: number; fit?: Fit }): Size {
  const cover = box.fit === 'cover';
  const sx = box.width / width;
  const sy = box.height == null ? (cover ? 0 : Infinity) : box.height / height;
  const s = Math.min(1, cover ? Math.max(sx, sy) : Math.min(sx, sy));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

export function rgbToRgba(rgb: Uint8Array, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const n = width * height;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n * 3; i += 3, j += 4) {
    data[j] = rgb[i]!;
    data[j + 1] = rgb[i + 1]!;
    data[j + 2] = rgb[i + 2]!;
    data[j + 3] = 255;
  }
  return data;
}

/** Bitmap from RGBA pixels, downscaled to `fitSize(width, height, box)`. */
export function bitmapFromRgba(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, box: DecodeOptions): Promise<ImageBitmap> {
  const img = new ImageData(data, width, height);
  const size = fitSize(width, height, box);
  if (size.width === width) return createImageBitmap(img);
  return createImageBitmap(img, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'medium' });
}

/** Applies an EXIF orientation (1-8) and closes the input bitmap. Returns the input itself for 1. */
export async function orientBitmap(bmp: ImageBitmap, orientation: number): Promise<ImageBitmap> {
  if (!orientation || orientation === 1) return bmp;
  const swap = orientation >= 5;
  const canvas = new OffscreenCanvas(swap ? bmp.height : bmp.width, swap ? bmp.width : bmp.height);
  const ctx = canvas.getContext('2d')!;
  const w = bmp.width;
  const h = bmp.height;
  // prettier-ignore
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return canvas.transferToImageBitmap();
}

/** Encodes through a 2D canvas: a bitmaprenderer canvas would encode the un-oriented buffer (see ops.ts). */
export async function bitmapToBlob(bmp: ImageBitmap, type: string, quality: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  return canvas.convertToBlob({ type, quality });
}
