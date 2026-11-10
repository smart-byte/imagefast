import { describe, expect, it } from 'vitest';
import { decodePsd } from './psddecode';

const u16 = (n: number) => [n >> 8, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** 2x2 RGB PSD with the given image-data section. `layerCount` adds a layer info section holding only that count. */
function psd(imageData: number[], opts: { channels?: number; mode?: number; depth?: number; resources?: number[]; layerCount?: number } = {}) {
  const { channels = 3, mode = 3, depth = 8, resources = [], layerCount } = opts;
  const layerInfo = layerCount == null ? [] : [...u32(2), ...u16(layerCount & 0xffff)];
  return new Uint8Array([
    ...str('8BPS'),
    ...u16(1),
    0,
    0,
    0,
    0,
    0,
    0,
    ...u16(channels),
    ...u32(2),
    ...u32(2),
    ...u16(depth),
    ...u16(mode),
    ...u32(0), // color mode data
    ...u32(resources.length),
    ...resources,
    ...u32(layerInfo.length), // layer & mask
    ...layerInfo,
    ...imageData,
  ]);
}

describe('decodePsd', () => {
  it('reads a raw RGB composite (planar)', () => {
    const r = decodePsd(psd([...u16(0), 1, 2, 3, 4, /* R */ 10, 20, 30, 40, /* G */ 100, 110, 120, 130 /* B */]));
    expect(r && 'data' in r ? [...r.data] : null).toEqual([1, 10, 100, 255, 2, 20, 110, 255, 3, 30, 120, 255, 4, 40, 130, 255]);
  });

  it('reads an RLE (PackBits) grayscale composite', () => {
    // rows: [0xff, 7] = repeat 7 twice ; [1, 5, 9] = literal 5, 9
    const rows = [
      [0xff, 7],
      [1, 5, 9],
    ];
    const lens = rows.flatMap((r) => u16(r.length));
    const r = decodePsd(psd([...u16(1), ...lens, ...rows.flat()], { channels: 1, mode: 1 }));
    expect(r && 'data' in r ? [...r.data] : null).toEqual([7, 7, 7, 255, 7, 7, 7, 255, 5, 5, 5, 255, 9, 9, 9, 255]);
  });

  it('takes the high byte of 16-bit data', () => {
    const plane = [0xab, 0xcd, 0x12, 0x34, 0x00, 0x01, 0xff, 0xfe];
    const r = decodePsd(psd([...u16(0), ...plane, ...plane, ...plane], { depth: 16 }));
    expect(r && 'data' in r ? [r.data[0], r.data[4], r.data[8], r.data[12]] : null).toEqual([0xab, 0x12, 0x00, 0xff]);
  });

  // R, G, B planes, then a 4th channel: 0, 128, 255, 64.
  const rgbPlus = [...u16(0), 1, 2, 3, 4, 10, 20, 30, 40, 100, 110, 120, 130, 0, 128, 255, 64];
  const alphas = (r: ReturnType<typeof decodePsd>) => (r && 'data' in r ? [r.data[3], r.data[7], r.data[11], r.data[15]] : null);

  it('keeps a composite opaque when its extra channel is a saved selection (no negative layer count)', () => {
    expect(alphas(decodePsd(psd(rgbPlus, { channels: 4 })))).toEqual([255, 255, 255, 255]);
    expect(alphas(decodePsd(psd(rgbPlus, { channels: 4, layerCount: 2 })))).toEqual([255, 255, 255, 255]);
  });

  it('reads merged transparency from the first extra channel when the layer count is negative', () => {
    expect(alphas(decodePsd(psd(rgbPlus, { channels: 4, layerCount: -2 })))).toEqual([0, 128, 255, 64]);
  });

  it('falls back to the 1036 JPEG thumbnail when the composite is too large', () => {
    const jpeg = [0xff, 0xd8, 0xff, 0xd9];
    const body = [...u32(1), ...u32(160), ...u32(120), ...u32(480), ...u32(57600), ...u32(4), ...u16(24), ...u16(1), ...jpeg];
    const block = [...str('8BIM'), ...u16(1036), 0, 0, ...u32(body.length), ...body];
    const r = decodePsd(psd([...u16(0)], { resources: block }), 1 /* maxPixels */);
    expect(r && 'jpeg' in r ? { w: r.width, h: r.height, jpeg: [...r.jpeg] } : null).toEqual({ w: 160, h: 120, jpeg });
  });

  it('returns null for a raw composite whose planes are truncated (instead of black pixels)', () => {
    expect(decodePsd(psd([...u16(0), 1, 2, 3, 4, 10, 20]))).toBeNull();
  });

  it('returns null for an RLE composite whose rows are truncated (instead of black pixels)', () => {
    const lens = [...u16(2), ...u16(3)];
    expect(decodePsd(psd([...u16(1), ...lens, 0xff, 7, 1], { channels: 1, mode: 1 }))).toBeNull(); // second row cut short
    expect(decodePsd(psd([...u16(1), ...u16(2)], { channels: 1, mode: 1 }))).toBeNull(); // row length table cut short
  });

  it('gives up on a resource block whose size points past the file instead of walking back onto it forever', () => {
    const block = [...str('8BIM'), ...u16(1000), 0, 0, ...u32(0xfffffff4)];
    expect(decodePsd(psd([...u16(0)], { resources: block }), 1 /* maxPixels */)).toBeNull();
  });

  it('returns null when the header claims fewer channels than its colour mode has', () => {
    expect(decodePsd(psd([...u16(0), 1, 2, 3, 4], { channels: 1 }))).toBeNull(); // RGB with one plane
  });

  it('reads only the channels it draws: a composite whose saved selection is cut short still decodes', () => {
    const row = [0xff, 7]; // repeat 7 twice
    // R, G and B rows are complete; the two rows of the 4th channel claim more data than the file holds.
    const lens = [...new Array(6).fill(u16(row.length)).flat(), ...u16(500), ...u16(500)];
    const r = decodePsd(psd([...u16(1), ...lens, ...new Array(6).fill(row).flat()], { channels: 4 }));
    expect(r && 'data' in r ? [...r.data] : null).toEqual(new Array(4).fill([7, 7, 7, 255]).flat());
  });

  it('returns null for non-PSD input', () => {
    expect(decodePsd(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodePsd(new Uint8Array([...str('8BPS'), ...u16(1), 0, 0, 0, 0, 0, 0, ...u16(3), ...u32(2), ...u32(2), ...u16(8), ...u16(3), 0, 0]))).toBeNull(); // truncated header
  });
});
