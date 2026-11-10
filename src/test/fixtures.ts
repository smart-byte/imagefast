const u16 = (n: number) => [n >> 8, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));

const le16 = (n: number) => [n & 0xff, n >> 8];
const le32 = (n: number) => [...le16(n & 0xffff), ...le16(n >>> 16)];
const TIFF_TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4 }; // BYTE, ASCII, SHORT, LONG

/** 32x24 16-bit RGGB DNG whose DefaultCrop keeps 28x20: the frame the camera actually uses, minus a sensor border. */
export function dngFile(): File {
  const w = 32;
  const h = 24;
  const tags: [tag: number, type: number, value: number[]][] = [
    [256, 4, le32(w)],
    [257, 4, le32(h)],
    [258, 3, le16(16)],
    [259, 3, le16(1)], // uncompressed
    [262, 3, le16(32803)], // CFA
    [271, 2, [...str('imagefast'), 0]],
    [273, 4, le32(8)], // pixels right after the header, then the IFD
    [277, 3, le16(1)],
    [278, 4, le32(h)],
    [279, 4, le32(w * h * 2)],
    [33421, 3, [...le16(2), ...le16(2)]], // CFARepeatPatternDim
    [33422, 1, [0, 1, 1, 2]], // CFAPattern: R G / G B
    [50706, 1, [1, 4, 0, 0]], // DNGVersion
    [50708, 2, [...str('imagefast test'), 0]], // UniqueCameraModel
    [50717, 4, le32(0xffff)], // WhiteLevel
    [50719, 4, [...le32(2), ...le32(2)]], // DefaultCropOrigin
    [50720, 4, [...le32(28), ...le32(20)]], // DefaultCropSize
  ];
  const pixels = new Array<number>(w * h * 2).fill(0x80);
  const ifdAt = 8 + pixels.length;
  const extraAt = ifdAt + 2 + tags.length * 12 + 4;
  const ifd = le16(tags.length);
  const extra: number[] = [];
  for (const [tag, type, value] of tags) {
    ifd.push(...le16(tag), ...le16(type), ...le32(value.length / TIFF_TYPE_SIZE[type]!));
    if (value.length <= 4) ifd.push(...value, ...Array(4 - value.length).fill(0));
    else {
      ifd.push(...le32(extraAt + extra.length));
      extra.push(...value, ...(value.length % 2 ? [0] : []));
    }
  }
  return new File([new Uint8Array([...str('II'), ...le16(42), ...le32(ifdAt), ...pixels, ...ifd, 0, 0, 0, 0, ...extra])], 'crop.dng');
}

/** 2x2 RGB PSD, raw (uncompressed) composite. */
export function psdFile(): File {
  const header = [...str('8BPS'), ...u16(1), 0, 0, 0, 0, 0, 0, ...u16(3), ...u32(2), ...u32(2), ...u16(8), ...u16(3)];
  const body = [...u32(0), ...u32(0), ...u32(0), ...u16(0), 1, 2, 3, 4, 10, 20, 30, 40, 100, 110, 120, 130];
  return new File([new Uint8Array([...header, ...body])], 'two.psd');
}
