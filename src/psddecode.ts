import { bitmapFromRgba } from './canvas';
import { ImageFastError } from './errors';
import type { Decoder } from './plugin';

export interface PsdPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface PsdThumb {
  width: number;
  height: number;
  jpeg: Uint8Array;
}

/** Composite images above this many pixels are skipped in favour of the embedded thumbnail. */
export const PSD_MAX_PIXELS = 40_000_000;

/**
 * Reads a Photoshop file: the flattened composite ("Maximize compatibility") when present and small enough,
 * otherwise the embedded JPEG thumbnail (image resource 1036). Supports raw and RLE, 8/16-bit, RGB, Grayscale
 * and CMYK.
 */
export function decodePsd(bytes: Uint8Array, maxPixels = PSD_MAX_PIXELS): PsdPixels | PsdThumb | null {
  try {
    return parsePsd(bytes, maxPixels);
  } catch (e) {
    if (e instanceof RangeError) return null; // truncated: an offset ran past the buffer
    throw e;
  }
}

function parsePsd(bytes: Uint8Array, maxPixels: number): PsdPixels | PsdThumb | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 26 || String.fromCharCode(...bytes.subarray(0, 4)) !== '8BPS') return null;
  const psb = dv.getUint16(4) === 2;
  const channels = dv.getUint16(12);
  const height = dv.getUint32(14);
  const width = dv.getUint32(18);
  const depth = dv.getUint16(22);
  const mode = dv.getUint16(24); // 1 gray, 3 rgb, 4 cmyk
  let pos = 26;
  pos += 4 + dv.getUint32(pos); // color mode data
  const resLen = dv.getUint32(pos);
  const resources = { start: pos + 4, end: pos + 4 + resLen };
  pos = resources.end;
  const lenSize = psb ? 8 : 4;
  const len = (at: number) => (psb ? Number(dv.getBigUint64(at)) : dv.getUint32(at));
  // "If the layer count is a negative number, the first alpha channel contains the transparency data for the merged
  // result." Otherwise extra channels are saved selections or spot colours, not transparency.
  // 16-bit files keep their layers in an Lr16 block instead, which is not read: their composite is treated as opaque.
  const transparent = len(pos) > 0 && len(pos + lenSize) > 0 && dv.getInt16(pos + 2 * lenSize) < 0;
  pos += lenSize + len(pos); // layer & mask
  const thumb = () => psdThumbnail(bytes, dv, resources.start, resources.end);

  const colorChannels = mode === 3 ? 3 : mode === 1 ? 1 : 4;
  const composite =
    pos + 2 <= bytes.length &&
    (mode === 1 || mode === 3 || mode === 4) &&
    channels >= colorChannels &&
    (depth === 8 || depth === 16) &&
    width * height <= maxPixels;
  if (!composite) return thumb();
  // Saved selections and spot colours behind these are never drawn, so they are not read either: a forged channel
  // count cannot make this allocate a plane per channel.
  const used = Math.min(channels, colorChannels + (transparent ? 1 : 0));
  const compression = dv.getUint16(pos);
  pos += 2;
  const bps = depth / 8;
  const planeLen = width * height * bps;
  const planes: Uint8Array[] = [];
  if (compression === 0) {
    if (pos + used * planeLen > bytes.length) return thumb(); // truncated: subarray would silently yield black pixels
    for (let c = 0; c < used; c++) planes.push(bytes.subarray(pos + c * planeLen, pos + (c + 1) * planeLen));
  } else if (compression === 1) {
    const rows = height * channels;
    const rowLenSize = psb ? 4 : 2;
    let data = pos + rows * rowLenSize;
    if (data > bytes.length) return thumb(); // truncated, as above
    for (let c = 0; c < used; c++) {
      const plane = new Uint8Array(planeLen);
      for (let y = 0; y < height; y++) {
        const r = c * height + y;
        const len = psb ? dv.getUint32(pos + r * 4) : dv.getUint16(pos + r * 2);
        if (data + len > bytes.length) return thumb();
        unpackBits(bytes, data, len, plane, y * width * bps, width * bps);
        data += len;
      }
      planes.push(plane);
    }
  } else {
    return thumb(); // zip-compressed composites are rare (Photoshop writes RLE)
  }
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const px = (plane: Uint8Array, i: number) => plane[i * bps]!; // 16-bit: big-endian, high byte is enough for previews
  const alpha = planes[colorChannels]; // only read when the file has merged transparency
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (mode === 3) {
      out[j] = px(planes[0]!, i);
      out[j + 1] = px(planes[1]!, i);
      out[j + 2] = px(planes[2]!, i);
    } else if (mode === 1) {
      out[j] = out[j + 1] = out[j + 2] = px(planes[0]!, i);
    } else {
      // Photoshop stores CMYK inverted, so channel value 255 = no ink.
      const k = px(planes[3]!, i);
      out[j] = (px(planes[0]!, i) * k) / 255;
      out[j + 1] = (px(planes[1]!, i) * k) / 255;
      out[j + 2] = (px(planes[2]!, i) * k) / 255;
    }
    out[j + 3] = alpha ? px(alpha, i) : 255;
  }
  return { width, height, data: out };
}

/** PackBits (Apple RLE) into `dst` at `dstOff`, at most `max` bytes. */
function unpackBits(src: Uint8Array, off: number, len: number, dst: Uint8Array, dstOff: number, max: number): void {
  const end = off + len;
  let o = dstOff;
  const stop = dstOff + max;
  while (off < end && o < stop) {
    let n = src[off++]!;
    if (n > 128) {
      n = 257 - n;
      const v = src[off++]!;
      for (let k = 0; k < n && o < stop; k++) dst[o++] = v;
    } else if (n < 128) {
      n += 1;
      for (let k = 0; k < n && o < stop; k++) dst[o++] = src[off++]!;
    }
  }
}

/** Image resource 1036 (Photoshop 5+ thumbnail, JPEG). */
function psdThumbnail(bytes: Uint8Array, dv: DataView, start: number, end: number): PsdThumb | null {
  let pos = start;
  while (pos + 12 <= end) {
    if (String.fromCharCode(...bytes.subarray(pos, pos + 4)) !== '8BIM') return null;
    const id = dv.getUint16(pos + 4);
    const nameLen = bytes[pos + 6]!;
    pos += 6 + ((nameLen + 1 + 1) & ~1); // pascal string padded to even
    const size = dv.getUint32(pos);
    pos += 4;
    if ((id === 1036 || id === 1033) && dv.getUint32(pos) === 1 /* kJpegRGB */) {
      return { width: dv.getUint32(pos + 4), height: dv.getUint32(pos + 8), jpeg: bytes.subarray(pos + 28, pos + size) };
    }
    pos += size + (size & 1); // padded to even; `& ~1` would turn a forged 4 GB size negative and walk backwards
  }
  return null;
}

export const psdDecoder: Decoder = {
  decode: async (file, opts) => {
    const r = decodePsd(new Uint8Array(await file.arrayBuffer()));
    if (!r) throw new ImageFastError('decode-failed', 'not a readable PSD (truncated, or no composite image and no thumbnail)');
    if ('jpeg' in r) return { blob: new Blob([r.jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), width: r.width, height: r.height };
    return { bitmap: await bitmapFromRgba(r.data, r.width, r.height, opts), width: r.width, height: r.height };
  },
};
