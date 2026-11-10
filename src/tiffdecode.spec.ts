import { describe, expect, it } from 'vitest';
import UTIF from 'utif';
import { tiffDecoder } from './tiffdecode';
import { tiffHeader } from './probe';

/** A valid 2x2 TIFF whose IFD0 claims `width` x `height` instead. */
function tiffClaiming(width: number, height: number): Blob {
  const bytes = new Uint8Array(UTIF.encodeImage(new Uint8Array(16).fill(200), 2, 2));
  const dv = new DataView(bytes.buffer);
  const { ifd, le } = tiffHeader(bytes)!;
  for (let i = 0; i < dv.getUint16(ifd, le); i++) {
    const entry = ifd + 2 + i * 12;
    const tag = dv.getUint16(entry, le);
    if (tag !== 256 && tag !== 257) continue;
    const value = tag === 256 ? width : height;
    if (dv.getUint16(entry + 2, le) === 3) dv.setUint16(entry + 8, value, le);
    else dv.setUint32(entry + 8, value, le);
  }
  return new Blob([bytes]);
}

const box = { width: 100, quality: 0.8 };

describe('tiffDecoder', () => {
  it('refuses a header that claims more pixels than a canvas can hold, before anything is allocated for them', async () => {
    await expect(tiffDecoder.decode(tiffClaiming(60000, 60000), box)).rejects.toMatchObject({
      code: 'decode-failed',
      message: expect.stringContaining('60000'),
    });
  });

  it('rejects a TIFF without an image with decode-failed instead of a TypeError from the decoder', async () => {
    const empty = new Blob([new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
    await expect(tiffDecoder.decode(empty, box)).rejects.toMatchObject({ code: 'decode-failed' });
  });
});
