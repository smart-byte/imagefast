/** Types for the emscripten module built by wasm/libraw/build.sh (see wasm/libraw/wrapper.cpp). */
export interface LibRawModule {
  HEAPU8: Uint8Array;
  UTF8ToString(ptr: number): string;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _lr_new(): number;
  _lr_free(p: number): void;
  _lr_strerror(code: number): number;
  _lr_open(p: number, buf: number, len: number): number;
  _lr_make(p: number): number;
  _lr_model(p: number): number;
  _lr_width(p: number): number;
  _lr_height(p: number): number;
  _lr_flip(p: number): number;
  _lr_thumb_count(p: number): number;
  _lr_thumb_format(p: number, i: number): number;
  _lr_thumb_width(p: number, i: number): number;
  _lr_thumb_height(p: number, i: number): number;
  _lr_thumb_default_width(p: number): number;
  _lr_unpack_thumb(p: number, i: number): number;
  _lr_make_thumb(p: number): number;
  _lr_make_image(p: number): number;
  _lr_last_error(): number;
  _lr_img_type(img: number): number;
  _lr_img_width(img: number): number;
  _lr_img_height(img: number): number;
  _lr_img_colors(img: number): number;
  _lr_img_bits(img: number): number;
  _lr_img_size(img: number): number;
  _lr_img_data(img: number): number;
  _lr_free_image(img: number): void;
  _lr_process(p: number, halfSize: number, useCameraWb: number, useAutoWb: number, highlight: number, quality: number): number;
}

export default function createLibRaw(opts?: { locateFile?: (path: string) => string }): Promise<LibRawModule>;
