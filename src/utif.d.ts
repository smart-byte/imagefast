declare module 'utif' {
  export interface Ifd {
    /** Set by `decodeImage`; before that only the tags below exist. */
    width: number;
    height: number;
    /** ImageWidth, ImageLength and Orientation tags. */
    t256?: number[];
    t257?: number[];
    t274?: number[];
    data?: Uint8Array;
    [tag: string]: unknown;
  }
  const UTIF: {
    decode(buffer: ArrayBuffer): Ifd[];
    decodeImage(buffer: ArrayBuffer, ifd: Ifd, ifds?: Ifd[]): void;
    toRGBA8(ifd: Ifd): Uint8Array;
    encodeImage(rgba: Uint8Array, width: number, height: number, metadata?: Record<string, unknown>): ArrayBuffer;
  };
  export default UTIF;
}
