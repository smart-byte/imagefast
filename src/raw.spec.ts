import { describe, expect, it } from 'vitest';
import { isRawFile } from './raw';
import { rgbToRgba } from './canvas';

describe('isRawFile', () => {
  it('detects by mime type or extension', () => {
    expect(isRawFile({ name: 'IMG_0001.CR2', type: '' })).toBe(true);
    expect(isRawFile({ name: 'shot.dng', type: 'image/x-adobe-dng' })).toBe(true);
    expect(isRawFile({ name: 'shot.jpg', type: 'image/jpeg' })).toBe(false);
    expect(isRawFile({ name: 'noext', type: '' })).toBe(false);
    expect(isRawFile({})).toBe(false);
  });
});

describe('rgbToRgba', () => {
  it('adds an opaque alpha channel', () => {
    expect([...rgbToRgba(new Uint8Array([1, 2, 3, 4, 5, 6]), 2, 1)]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });
});
