import type { Size } from './plugin';

export type ProbedFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'tiff' | 'heic' | 'avif' | 'jxl' | 'bmp' | 'psd';

export interface Probed extends Size {
  format: ProbedFormat;
}

/** Oriented width, height and format from a file's first bytes, without decoding. Null for an unknown format or a header that is not in `bytes`. */
export function probeDimensions(bytes: Uint8Array): Probed | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = (i: number) => bytes[i]!;
  const ascii = (i: number, n: number) => String.fromCharCode(...bytes.subarray(i, i + n));
  if (bytes.length < 16) return null;

  if (ascii(1, 3) === 'PNG' && u8(0) === 0x89 && ascii(12, 4) === 'IHDR' && bytes.length >= 24) {
    return { format: 'png', width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (ascii(0, 4) === 'GIF8') {
    return { format: 'gif', width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      return { format: 'webp', width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const b = dv.getUint32(21, true);
      return { format: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && bytes.length >= 30) {
      const w = u8(24) | (u8(25) << 8) | (u8(26) << 16);
      const h = u8(27) | (u8(28) << 8) | (u8(29) << 16);
      return { format: 'webp', width: w + 1, height: h + 1 };
    }
    return null;
  }
  if (u8(0) === 0xff && u8(1) === 0xd8) return probeJpeg(bytes, dv);
  if (isPsd(bytes) && bytes.length >= 26) {
    return { format: 'psd', width: dv.getUint32(18), height: dv.getUint32(14) };
  }
  if (bytes.length >= 26 && ascii(0, 2) === 'BM' && BMP_HEADERS.has(dv.getUint32(14, true))) {
    const core = dv.getUint32(14, true) === 12; // OS/2 BITMAPCOREHEADER: 16-bit sizes
    const height = core ? dv.getUint16(20, true) : Math.abs(dv.getInt32(22, true)); // negative = stored top-down
    return { format: 'bmp', width: core ? dv.getUint16(18, true) : dv.getInt32(18, true), height };
  }
  if ((u8(0) === 0xff && u8(1) === 0x0a) || ascii(4, 8) === 'JXL \r\n\x87\n') return probeJxl(bytes, dv);
  const tiff = tiffHeader(bytes);
  if (tiff) return parseTiffIfd(bytes, tiff.ifd, tiff.le);
  const brands = ftypBrands(bytes);
  if (brands?.some(isAvifBrand)) return probeIsobmff(bytes, dv, 'avif');
  if (isHeic(bytes)) return probeIsobmff(bytes, dv, 'heic');
  return null;
}

/** BMP info header sizes (core, V1 to V5). */
const BMP_HEADERS = new Set([12, 40, 52, 56, 64, 108, 124]);

const PNG_METADATA = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);

/**
 * Whether an image carries metadata that a re-encode would drop: EXIF or XMP (JPEG APP1, PNG eXIf/text chunks, WebP
 * EXIF/XMP chunks) or IPTC (JPEG APP13). JFIF headers and ICC profiles do not count. False for other formats.
 */
export function hasMetadata(bytes: Uint8Array): boolean {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (i: number) => String.fromCharCode(...bytes.subarray(i, i + 4));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2;
    while (pos + 4 <= bytes.length && bytes[pos] === 0xff) {
      const marker = bytes[pos + 1]!;
      if (marker === 0xff)
        pos++; // fill byte
      else if (marker === 0xda || marker === 0xd9)
        return false; // SOS / EOI: no more metadata segments
      else if (marker === 0xe1 || marker === 0xed) return true;
      else pos += 2 + dv.getUint16(pos + 2);
    }
    return false;
  }
  if (bytes[0] === 0x89 && tag(1).startsWith('PNG')) {
    for (let pos = 8; pos + 8 <= bytes.length; pos += 12 + dv.getUint32(pos)) if (PNG_METADATA.has(tag(pos + 4))) return true;
    return false;
  }
  if (tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    // Chunks are padded to even sizes. Plain arithmetic: `& ~1` would turn a forged 4 GB size negative and never advance.
    for (let pos = 12, size = 0; pos + 8 <= bytes.length; pos += 8 + size + (size & 1)) {
      if (tag(pos) === 'EXIF' || tag(pos) === 'XMP ') return true;
      size = dv.getUint32(pos + 4, true);
    }
  }
  return false;
}

/** Photoshop document magic (`8BPS`). */
export function isPsd(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53;
}

/** Byte order and IFD0 offset of a TIFF (also the base of NEF/CR2/DNG). */
export function tiffHeader(bytes: Uint8Array): { le: boolean; ifd: number } | null {
  if (bytes.length < 8) return null;
  const le = bytes[0] === 0x49 && bytes[1] === 0x49;
  const be = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!le && !be) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(2, le) !== 42) return null;
  return { le, ifd: dv.getUint32(4, le) };
}

/**
 * Reads ImageWidth/ImageLength/Orientation from the IFD at `ifd` (relative to `bytes`). Big TIFFs keep
 * IFD0 at the end of the file, so callers may pass a slice taken at `tiffHeader().ifd` with `ifd = 0`.
 */
export function parseTiffIfd(bytes: Uint8Array, ifd: number, le: boolean): Probed | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ifd + 2 > bytes.length) return null;
  const count = dv.getUint16(ifd, le);
  let width = 0;
  let height = 0;
  let orientation = 1;
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > bytes.length) break;
    const tag = dv.getUint16(e, le);
    const type = dv.getUint16(e + 2, le);
    const value = type === 3 ? dv.getUint16(e + 8, le) : dv.getUint32(e + 8, le);
    if (tag === 256) width = value;
    else if (tag === 257) height = value;
    else if (tag === 274) orientation = value;
  }
  if (!width || !height) return null;
  const swap = orientation >= 5 && orientation <= 8;
  return { format: 'tiff', width: swap ? height : width, height: swap ? width : height };
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const isAvifBrand = (b: string) => b.startsWith('avif') || b === 'avis';

/** Major and compatible brands of a leading `ftyp` box, or null when there is none. */
function ftypBrands(bytes: Uint8Array): string[] | null {
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') return null;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const brands: string[] = [];
  for (let o = 8; o + 4 <= Math.min(size, bytes.length); o += 4) {
    if (o === 12) continue; // minor version
    brands.push(String.fromCharCode(...bytes.subarray(o, o + 4)));
  }
  return brands;
}

/** ISO-BMFF with a HEIF brand (and not AVIF, which browsers decode natively). */
export function isHeic(bytes: Uint8Array): boolean {
  const brands = ftypBrands(bytes);
  return !!brands && !brands.some(isAvifBrand) && brands.some((b) => HEIC_BRANDS.has(b));
}

/** Largest `ispe` (pixel size) box, swapped for `irot` 90°/270°. */
function probeIsobmff(bytes: Uint8Array, dv: DataView, format: 'heic' | 'avif'): Probed | null {
  let best: Size | null = null;
  let rot = 0;
  const walk = (start: number, end: number) => {
    let pos = start;
    while (pos + 8 <= end) {
      let size = dv.getUint32(pos);
      const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
      let head = 8;
      if (size === 1) {
        if (pos + 16 > end) return;
        size = Number(dv.getBigUint64(pos + 8));
        head = 16;
      } else if (size === 0) size = end - pos; // box extends to the end
      if (size < head) return;
      const boxEnd = Math.min(pos + size, end);
      if (type === 'meta')
        walk(pos + head + 4, boxEnd); // full box
      else if (type === 'iprp' || type === 'ipco') walk(pos + head, boxEnd);
      else if (type === 'ispe' && pos + head + 12 <= boxEnd) {
        const w = dv.getUint32(pos + head + 4);
        const h = dv.getUint32(pos + head + 8);
        if (!best || w * h > best.width * best.height) best = { width: w, height: h };
      } else if (type === 'irot' && pos + head + 1 <= boxEnd) rot = bytes[pos + head]! & 3;
      pos = boxEnd;
    }
  };
  walk(0, bytes.length);
  if (!best) return null;
  const b: Size = best;
  const swap = rot === 1 || rot === 3;
  return { format, width: swap ? b.height : b.width, height: swap ? b.width : b.height };
}

/** SizeHeader aspect ratios (index = the 3-bit `ratio` field), as numerator/denominator. */
const JXL_RATIOS = [null, [1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]] as const;

/** SizeHeader and orientation of a JPEG XL codestream (ISO/IEC 18181-1), bare or inside the ISO-BMFF container. */
function probeJxl(bytes: Uint8Array, dv: DataView): Probed | null {
  let start = 0;
  if (bytes[0] !== 0xff) {
    // Container: the codestream sits in a jxlc box, or is split over jxlp boxes that start with a 4-byte index.
    start = -1;
    for (let pos = 0; pos + 8 <= bytes.length && start < 0;) {
      const size = dv.getUint32(pos);
      const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
      if (type === 'jxlc') start = pos + 8;
      else if (type === 'jxlp') start = pos + 12;
      else if (size < 8) return null;
      else pos += size;
    }
    if (start < 0 || bytes[start] !== 0xff || bytes[start + 1] !== 0x0a) return null;
  }
  let bit = (start + 2) * 8;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v |= ((bytes[bit >> 3]! >> (bit & 7)) & 1) << i;
    return v;
  };
  const u32 = () => read([9, 13, 18, 30][read(2)]!) + 1;
  const small = read(1);
  const height = small ? (read(5) + 1) * 8 : u32();
  const ratio = JXL_RATIOS[read(3)];
  const width = ratio ? Math.floor((height * ratio[0]) / ratio[1]) : small ? (read(5) + 1) * 8 : u32();
  const orientation = !read(1) /* all_default */ && read(1) /* extra_fields */ ? read(3) + 1 : 1;
  if (bit > bytes.length * 8) return null; // truncated
  const swap = orientation > 4;
  return { format: 'jxl', width: swap ? height : width, height: swap ? width : height };
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** An EXIF orientation tag found in a JPEG, with what it takes to overwrite it. */
interface ExifOrientationTag {
  value: number;
  /** Byte offset of the tag's 16-bit value within the JPEG. */
  offset: number;
  le: boolean;
}

/** Walks JPEG marker segments until SOF, collecting the EXIF orientation on the way. Null when not a JPEG. */
function scanJpeg(bytes: Uint8Array, dv: DataView): { sof: Size | null; orientation: ExifOrientationTag | null } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let pos = 2;
  let orientation: ExifOrientationTag | null = null;
  let exifSeen = false;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) break;
    const marker = bytes[pos + 1]!;
    if (marker === 0xff) {
      pos++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS before any SOF
    const len = dv.getUint16(pos + 2);
    if (SOF.has(marker)) {
      if (pos + 9 > bytes.length) break;
      return { sof: { width: dv.getUint16(pos + 7), height: dv.getUint16(pos + 5) }, orientation };
    }
    if (marker === 0xe1 && !exifSeen && String.fromCharCode(...bytes.subarray(pos + 4, pos + 10)) === 'Exif\0\0') {
      // Chromium orients by the first Exif APP1 only, even when that one has no orientation tag.
      exifSeen = true;
      orientation = exifOrientation(dv, pos + 10, Math.min(bytes.length, pos + 2 + len));
    }
    pos += 2 + len;
  }
  return { sof: null, orientation };
}

function probeJpeg(bytes: Uint8Array, dv: DataView): Probed | null {
  const j = scanJpeg(bytes, dv);
  if (!j?.sof) return null;
  const o = j.orientation?.value;
  const swap = o != null && o >= 5 && o <= 8;
  return { format: 'jpeg', width: swap ? j.sof.height : j.sof.width, height: swap ? j.sof.width : j.sof.height };
}

/** EXIF orientation (1-8) of a JPEG, or null when the file carries no orientation tag. */
export function jpegOrientation(bytes: Uint8Array): number | null {
  return scanJpeg(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength))?.orientation?.value ?? null;
}

/**
 * APP1 marker, segment length (34), "Exif\0\0", a little-endian TIFF header pointing at IFD0, and an IFD0 holding
 * one Orientation entry (tag 0x0112, SHORT, count 1). 36 bytes, the smallest thing that states an orientation.
 */
const EXIF_APP1 = new Uint8Array([
  0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00,
  0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
/** Where the orientation value sits inside `EXIF_APP1` (little endian). */
const EXIF_APP1_VALUE = 28;

/**
 * A copy of `bytes` that displays with EXIF `orientation` (1-8): an existing Orientation tag is overwritten,
 * otherwise a minimal Exif APP1 segment is inserted after SOI. The compressed pixels are copied verbatim, so
 * this costs no decode, no re-encode and no generation loss. Null when `bytes` is not a JPEG.
 */
export function orientJpeg(bytes: Uint8Array, orientation: number): Uint8Array<ArrayBuffer> | null {
  const scan = scanJpeg(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (!scan) return null;
  const tag = scan.orientation;
  const out = new Uint8Array(bytes.length + (tag ? 0 : EXIF_APP1.length));
  if (tag) {
    out.set(bytes);
    new DataView(out.buffer).setUint16(tag.offset, orientation, tag.le);
    return out;
  }
  out.set(bytes.subarray(0, 2)); // SOI
  out.set(EXIF_APP1, 2);
  out.set(bytes.subarray(2), 2 + EXIF_APP1.length);
  new DataView(out.buffer).setUint16(2 + EXIF_APP1_VALUE, orientation, true);
  return out;
}

/** Parses the TIFF header at `start` for IFD0 tag 0x0112. */
function exifOrientation(dv: DataView, start: number, end: number): ExifOrientationTag | null {
  if (start + 8 > end) return null;
  const le = dv.getUint16(start) === 0x4949;
  if (dv.getUint16(start + 2, le) !== 0x2a) return null;
  const ifd = start + dv.getUint32(start + 4, le);
  if (ifd + 2 > end) return null;
  const count = dv.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (dv.getUint16(entry, le) === 0x0112) return { value: dv.getUint16(entry + 8, le), offset: entry + 8, le };
  }
  return null;
}
