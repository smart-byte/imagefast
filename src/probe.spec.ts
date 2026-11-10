import { describe, expect, it } from 'vitest';
import { hasMetadata, isHeic, jpegOrientation, orientJpeg, parseTiffIfd, probeDimensions, tiffHeader } from './probe';

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const u16 = (n: number) => [n >> 8, n & 0xff];
const u16le = (n: number) => [n & 0xff, n >> 8];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));

const sof = (w: number, h: number) => [0xff, 0xc0, ...u16(17), 8, ...u16(h), ...u16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
/** JPEG with a JFIF segment and no EXIF at all. */
const plainJpeg = (w = 4000, h = 3000) => bytes([0xff, 0xd8], [0xff, 0xe0, ...u16(16)], 'JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0], sof(w, h), [0xff, 0xda]);
/** JPEG with an APP1 Exif segment (little endian, one IFD0 entry) carrying `orientation`. */
const exifJpeg = (orientation: number, w = 4000, h = 3000) => {
  const tiff = [...'II']
    .map((c) => c.charCodeAt(0))
    .concat(u16le(0x2a), [8, 0, 0, 0], u16le(1), u16le(0x0112), u16le(3), [1, 0, 0, 0], u16le(orientation), [0, 0], [0, 0, 0, 0]);
  return bytes([0xff, 0xd8], [0xff, 0xe1, ...u16(2 + 6 + tiff.length)], 'Exif\0\0', tiff, sof(w, h), [0xff, 0xda]);
};

describe('probeDimensions', () => {
  it('png', () => {
    const png = bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], u32(13), 'IHDR', u32(640), u32(480), [8, 6, 0, 0, 0]);
    expect(probeDimensions(png)).toEqual({ format: 'png', width: 640, height: 480 });
  });

  it('gif', () => {
    expect(probeDimensions(bytes('GIF89a', u16le(300), u16le(200), [0, 0, 0, 0, 0, 0]))).toEqual({ format: 'gif', width: 300, height: 200 });
  });

  it('webp VP8 / VP8L / VP8X', () => {
    const vp8 = bytes('RIFF', u32(0), 'WEBP', 'VP8 ', u32(0), [0, 0, 0, 0x9d, 0x01, 0x2a], u16le(1024), u16le(768), [0, 0]);
    expect(probeDimensions(vp8)).toEqual({ format: 'webp', width: 1024, height: 768 });
    const w = 1023;
    const h = 511;
    const b = (w - 1) | ((h - 1) << 14);
    const vp8l = bytes('RIFF', u32(0), 'WEBP', 'VP8L', u32(0), [0x2f], [b & 0xff, (b >> 8) & 0xff, (b >> 16) & 0xff, (b >>> 24) & 0xff], [0, 0, 0, 0]);
    expect(probeDimensions(vp8l)).toEqual({ format: 'webp', width: w, height: h });
    const vp8x = bytes('RIFF', u32(0), 'WEBP', 'VP8X', u32(10), [0, 0, 0, 0], [0x0f, 0x00, 0x00], [0x37, 0x00, 0x00], [0, 0]);
    expect(probeDimensions(vp8x)).toEqual({ format: 'webp', width: 16, height: 56 });
  });

  it('jpeg SOF0 with EXIF orientation swap', () => {
    const plain = plainJpeg();
    expect(probeDimensions(plain)).toEqual({ format: 'jpeg', width: 4000, height: 3000 });
    const rotated = exifJpeg(6); // rotate 90
    expect(probeDimensions(rotated)).toEqual({ format: 'jpeg', width: 3000, height: 4000 });
    expect(jpegOrientation(rotated)).toBe(6);
    expect(jpegOrientation(plain)).toBeNull();
    expect(jpegOrientation(bytes('not a jpeg'))).toBeNull();
  });

  it('returns null for unknown or truncated input', () => {
    expect(probeDimensions(bytes('hello world, not an image'))).toBeNull();
    expect(probeDimensions(bytes([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]))).toBeNull();
    expect(probeDimensions(new Uint8Array(4))).toBeNull();
    expect(probeDimensions(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], u32(13), 'IHDR', [0, 0]))).toBeNull();
    expect(probeDimensions(bytes('BM', new Array(14).fill(0)))).toBeNull(); // ends before the header-size field
  });

  it('jpeg: only the first Exif APP1 counts, even when it has no orientation tag (what Chromium decodes by)', () => {
    /** APP1 Exif segment (little endian) whose IFD0 holds one SHORT entry. */
    const exifApp1 = (tag: number, value: number) => {
      const tiff = [...str('II'), ...u16le(0x2a), 8, 0, 0, 0, ...u16le(1), ...u16le(tag), ...u16le(3), 1, 0, 0, 0, ...u16le(value), 0, 0, 0, 0, 0, 0];
      return [0xff, 0xe1, ...u16(2 + 6 + tiff.length), ...str('Exif\0\0'), ...tiff];
    };
    const RESOLUTION_UNIT = 0x0128;
    const ORIENTATION = 0x0112;
    const twoExif = bytes([0xff, 0xd8], exifApp1(RESOLUTION_UNIT, 2), exifApp1(ORIENTATION, 6), sof(4000, 3000), [0xff, 0xda]);
    expect(probeDimensions(twoExif)).toEqual({ format: 'jpeg', width: 4000, height: 3000 });
    expect(jpegOrientation(twoExif)).toBeNull();
  });

  it('psd header', () => {
    expect(probeDimensions(bytes('8BPS', u16(1), [0, 0, 0, 0, 0, 0], u16(3), u32(3000), u32(4000), u16(8), u16(3)))).toEqual({
      format: 'psd',
      width: 4000,
      height: 3000,
    });
  });

  it('tiff IFD0 (little endian, inline) and big endian with orientation', () => {
    const entryLE = (tag: number, type: number, v: number) => [
      ...u16le(tag),
      ...u16le(type),
      ...[1, 0, 0, 0],
      ...(type === 3 ? [...u16le(v), 0, 0] : [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, 0]),
    ];
    const le = bytes('II', u16le(42), [8, 0, 0, 0], u16le(2), entryLE(256, 4, 70000), entryLE(257, 3, 500), [0, 0, 0, 0]);
    expect(probeDimensions(le)).toEqual({ format: 'tiff', width: 70000, height: 500 });
    const entryBE = (tag: number, v: number) => [...u16(tag), ...u16(3), ...u32(1), ...u16(v), 0, 0];
    const be = bytes('MM', u16(42), u32(8), u16(3), entryBE(256, 640), entryBE(257, 480), entryBE(274, 6), u32(0));
    expect(probeDimensions(be)).toEqual({ format: 'tiff', width: 480, height: 640 });
    // IFD beyond the buffer: header parse works, probe returns null, the tail can be parsed separately
    const far = bytes('MM', u16(42), u32(100000));
    expect(tiffHeader(far)).toEqual({ le: false, ifd: 100000 });
    expect(probeDimensions(far)).toBeNull();
    expect(parseTiffIfd(be.subarray(8), 0, false)).toEqual({ format: 'tiff', width: 480, height: 640 });
  });

  it('heic ispe + irot, and avif is not heic', () => {
    const box = (type: string, body: number[]) => [...u32(8 + body.length), ...str(type), ...body];
    const ftyp = box('ftyp', [...str('heic'), ...u32(0), ...str('mif1'), ...str('heic')]);
    const ispe = (w: number, h: number) => box('ispe', [...u32(0), ...u32(w), ...u32(h)]);
    const ipco = box('ipco', [...ispe(320, 240), ...ispe(4032, 3024), ...box('irot', [1])]);
    const meta = box('meta', [...u32(0), ...box('iprp', ipco)]);
    const heic = bytes(ftyp, meta);
    expect(isHeic(heic)).toBe(true);
    expect(probeDimensions(heic)).toEqual({ format: 'heic', width: 3024, height: 4032 });
    expect(isHeic(bytes(box('ftyp', [...str('avif'), ...u32(0), ...str('mif1')])))).toBe(false);
  });

  it('avif ispe + irot', () => {
    const box = (type: string, body: number[]) => [...u32(8 + body.length), ...str(type), ...body];
    const ispe = box('ispe', [...u32(0), ...u32(1920), ...u32(1080)]);
    const meta = box('meta', [...u32(0), ...box('iprp', box('ipco', [...ispe, ...box('irot', [3])]))]);
    const avif = bytes(box('ftyp', [...str('avif'), ...u32(0), ...str('mif1'), ...str('miaf')]), meta);
    expect(probeDimensions(avif)).toEqual({ format: 'avif', width: 1080, height: 1920 });
  });

  it('bmp: BITMAPINFOHEADER (negative height = top-down) and the old 12-byte core header', () => {
    const i32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
    expect(probeDimensions(bytes('BM', i32le(0), i32le(0), i32le(54), i32le(40), i32le(640), i32le(-480), u16le(1), u16le(24)))).toEqual({
      format: 'bmp',
      width: 640,
      height: 480,
    });
    expect(probeDimensions(bytes('BM', i32le(0), i32le(0), i32le(26), i32le(12), u16le(320), u16le(200), u16le(1), u16le(24)))).toEqual({
      format: 'bmp',
      width: 320,
      height: 200,
    });
  });

  it('jxl codestream: div8 size, aspect-ratio width, explicit width with orientation, and the ISOBMFF container', () => {
    // Bit-packed SizeHeader + ImageMetadata (LSB first), derived by hand from ISO/IEC 18181-1.
    expect(probeDimensions(bytes([0xff, 0x0a, 0x4f, 0x02], new Array(12).fill(0)))).toEqual({ format: 'jxl', width: 64, height: 64 });
    expect(probeDimensions(bytes([0xff, 0x0a, 0xba, 0x21, 0x0d], new Array(12).fill(0)))).toEqual({ format: 'jxl', width: 1920, height: 1080 });
    const rotated = [0xff, 0x0a, 0x38, 0x06, 0x56, 0x5a];
    expect(probeDimensions(bytes(rotated, new Array(12).fill(0)))).toEqual({ format: 'jxl', width: 200, height: 300 });
    const box = (type: string, body: number[]) => [...u32(8 + body.length), ...str(type), ...body];
    const signature = [0, 0, 0, 0x0c, ...str('JXL '), 0x0d, 0x0a, 0x87, 0x0a];
    const ftyp = box('ftyp', [...str('jxl '), ...u32(0), ...str('jxl ')]);
    expect(probeDimensions(bytes(signature, ftyp, box('jxlc', [...rotated, 0, 0])))).toEqual({ format: 'jxl', width: 200, height: 300 });
    expect(probeDimensions(bytes(signature, ftyp, box('Exif', [0, 0, 0, 0]), box('jxlp', [...u32(0), ...rotated, 0, 0])))).toEqual({
      format: 'jxl',
      width: 200,
      height: 300,
    });
  });
});

describe('orientJpeg', () => {
  it('inserts an orientation tag into a JPEG that has none, leaving every other byte untouched', () => {
    const plain = plainJpeg();
    const out = orientJpeg(plain, 6)!;
    expect(jpegOrientation(out)).toBe(6);
    expect(probeDimensions(out)).toEqual({ format: 'jpeg', width: 3000, height: 4000 });
    expect([...out.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...out.subarray(out.length - (plain.length - 2))]).toEqual([...plain.subarray(2)]);
  });

  it('overwrites an existing orientation tag in place, without touching the input', () => {
    const rotated = exifJpeg(1);
    const out = orientJpeg(rotated, 8)!;
    expect(out.length).toBe(rotated.length);
    expect(jpegOrientation(out)).toBe(8);
    expect(jpegOrientation(rotated)).toBe(1);
  });

  it('keeps a big-endian EXIF block big-endian', () => {
    const tiff = [...str('MM'), ...u16(0x2a), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(1), 0, 0, ...u32(0)];
    const be = bytes([0xff, 0xd8], [0xff, 0xe1, ...u16(2 + 6 + tiff.length)], 'Exif\0\0', tiff, sof(4000, 3000), [0xff, 0xda]);
    expect(jpegOrientation(orientJpeg(be, 6)!)).toBe(6);
  });

  it('returns null when the bytes are not a JPEG', () => {
    expect(orientJpeg(bytes('not a jpeg'), 6)).toBeNull();
  });
});

describe('hasMetadata', () => {
  const app = (marker: number, payload: (number[] | string)[]) => {
    const body = bytes(...payload);
    return [0xff, marker, ...u16(2 + body.length), ...body];
  };
  const jpegWith = (...segments: number[][]) => bytes([0xff, 0xd8], ...segments, sof(40, 30), [0xff, 0xda], [1, 2, 3], [0xff, 0xd9]);
  const chunk = (type: string, data: number[]) => [...u32(data.length), ...str(type), ...data, 0, 0, 0, 0];
  const png = (...chunks: number[][]) =>
    bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], chunk('IHDR', [...u32(4), ...u32(3), 8, 6, 0, 0, 0]), ...chunks, chunk('IEND', []));
  const riff = (type: string, data: number[]) => [...str(type), ...u16le(data.length), 0, 0, ...data, ...(data.length % 2 ? [0] : [])];
  const webp = (...chunks: number[][]) => bytes('RIFF', u32(0), 'WEBP', ...chunks);

  it('finds EXIF, XMP and IPTC segments in a JPEG, but not JFIF or an ICC profile', () => {
    expect(hasMetadata(plainJpeg())).toBe(false);
    expect(hasMetadata(jpegWith(app(0xe2, ['ICC_PROFILE\0', [1, 1, 0, 0]])))).toBe(false);
    expect(hasMetadata(exifJpeg(1))).toBe(true);
    expect(hasMetadata(jpegWith(app(0xe1, ['http://ns.adobe.com/xap/1.0/\0', '<x:xmpmeta/>'])))).toBe(true);
    expect(hasMetadata(jpegWith(app(0xed, ['Photoshop 3.0\0', '8BIM'])))).toBe(true);
  });

  it('finds eXIf and text chunks in a PNG', () => {
    expect(hasMetadata(png(chunk('IDAT', [1, 2, 3])))).toBe(false);
    expect(hasMetadata(png(chunk('eXIf', [...str('MM'), 0, 42]), chunk('IDAT', [1])))).toBe(true);
    expect(hasMetadata(png(chunk('iTXt', str('XML:com.adobe.xmp')), chunk('IDAT', [1])))).toBe(true);
    expect(hasMetadata(png(chunk('tEXt', str('Comment\0hi')), chunk('IDAT', [1])))).toBe(true);
  });

  it('finds EXIF and XMP chunks in a WebP', () => {
    expect(hasMetadata(webp(riff('VP8 ', [1, 2, 3])))).toBe(false);
    expect(hasMetadata(webp(riff('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), riff('VP8 ', [1]), riff('EXIF', [1, 2, 3])))).toBe(true);
    expect(hasMetadata(webp(riff('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), riff('VP8 ', [1]), riff('XMP ', [1, 2])))).toBe(true);
  });

  it('stops at a WebP chunk whose size points past the file instead of looping on it', () => {
    expect(hasMetadata(webp([...str('JUNK'), 0xf8, 0xff, 0xff, 0xff], new Array(8).fill(0)))).toBe(false);
  });
});
