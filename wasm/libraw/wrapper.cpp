// imagefast: minimal C ABI over LibRaw, called from src/rawdecode.ts via the exported wasm functions.
// Kept deliberately flat (ints, pointers) so no Embind is needed.
#include <algorithm>
#include <emscripten.h>
#include "libraw/libraw.h"

#define API extern "C" EMSCRIPTEN_KEEPALIVE

API LibRaw *lr_new() { return new LibRaw(); }
API void lr_free(LibRaw *p) { delete p; }
API const char *lr_strerror(int code) { return LibRaw::strerror(code); }

// LibRaw's visible area keeps a border the camera crops away (D850: 8288x5520, camera 8256x5504). The camera's own
// frame (DNG DefaultCrop, vendor tags) goes in as params.cropbox, which also realigns the CFA pattern for odd offsets
// (adjust_to_raw_inset_crop() only moves the margins). Makernote crops can be junk: one is used only when it starts
// inside the visible area and keeps at least 55% of it either way (that function's threshold).
static void use_camera_crop(LibRaw *p) {
  libraw_image_sizes_t &s = p->imgdata.sizes;
  const libraw_raw_inset_crop_t &c = s.raw_inset_crops[0];
  unsigned *box = p->imgdata.params.cropbox;
  box[0] = box[1] = 0;
  box[2] = box[3] = UINT_MAX;
  int x = c.cleft - s.left_margin, y = c.ctop - s.top_margin;
  if (c.cleft == 0xffff || c.ctop == 0xffff || x < 0 || y < 0 || p->is_fuji_rotated()) return;
  int w = std::min<int>(c.cwidth, s.width - x), h = std::min<int>(c.cheight, s.height - y);
  if (w < int(s.width * 0.55f) || h < int(s.height * 0.55f)) return;
  box[0] = x;
  box[1] = y;
  box[2] = w;
  box[3] = h;
}

/** Parses headers/metadata only (no pixel decode). `buf` must stay alive until lr_free/next lr_open. */
API int lr_open(LibRaw *p, const void *buf, size_t len) {
  p->recycle();
  int r = p->open_buffer(buf, len);
  if (r == LIBRAW_SUCCESS) use_camera_crop(p);
  return r;
}
API const char *lr_make(LibRaw *p) { return p->imgdata.idata.make; }
API const char *lr_model(LibRaw *p) { return p->imgdata.idata.model; }
/** dcraw flip code: 0 none, 3 = 180°, 5 = 90° CCW, 6 = 90° CW. Applied by lr_process, NOT to embedded previews. */
API int lr_flip(LibRaw *p) { return p->imgdata.sizes.flip; }
static bool swapped(LibRaw *p) { int f = p->imgdata.sizes.flip; return f == 5 || f == 6; }
static int crop_w(LibRaw *p) { unsigned w = p->imgdata.params.cropbox[2]; return w != UINT_MAX ? w : p->imgdata.sizes.width; }
static int crop_h(LibRaw *p) { unsigned h = p->imgdata.params.cropbox[3]; return h != UINT_MAX ? h : p->imgdata.sizes.height; }
/** Oriented output size of a full decode. (adjust_sizes_info_only() would do this but breaks a later unpack().) */
API int lr_width(LibRaw *p) { return swapped(p) ? crop_h(p) : crop_w(p); }
API int lr_height(LibRaw *p) { return swapped(p) ? crop_w(p) : crop_h(p); }

// ---- embedded previews (thumbs_list lists every preview LibRaw found in the file) ----
API int lr_thumb_count(LibRaw *p) { return p->imgdata.thumbs_list.thumbcount; }
API int lr_thumb_format(LibRaw *p, int i) { return p->imgdata.thumbs_list.thumblist[i].tformat; }
API int lr_thumb_width(LibRaw *p, int i) { return p->imgdata.thumbs_list.thumblist[i].twidth; }
API int lr_thumb_height(LibRaw *p, int i) { return p->imgdata.thumbs_list.thumblist[i].theight; }
/** Legacy single-preview fields (imgdata.thumbnail), for files where thumbs_list stays empty. */
API int lr_thumb_default_width(LibRaw *p) { return p->imgdata.thumbnail.twidth; }
/** i < 0 selects LibRaw's default preview. */
API int lr_unpack_thumb(LibRaw *p, int i) { return i < 0 ? p->unpack_thumb() : p->unpack_thumb_ex(i); }

// ---- processed images (both previews and full decodes come out as libraw_processed_image_t) ----
static int g_last_err = 0;
API libraw_processed_image_t *lr_make_thumb(LibRaw *p) { return p->dcraw_make_mem_thumb(&g_last_err); }
API libraw_processed_image_t *lr_make_image(LibRaw *p) { return p->dcraw_make_mem_image(&g_last_err); }
API int lr_last_error() { return g_last_err; }
API int lr_img_type(libraw_processed_image_t *i) { return i->type; } // LIBRAW_IMAGE_JPEG = 1, LIBRAW_IMAGE_BITMAP = 2
API int lr_img_width(libraw_processed_image_t *i) { return i->width; }
API int lr_img_height(libraw_processed_image_t *i) { return i->height; }
API int lr_img_colors(libraw_processed_image_t *i) { return i->colors; }
API int lr_img_bits(libraw_processed_image_t *i) { return i->bits; }
API unsigned lr_img_size(libraw_processed_image_t *i) { return i->data_size; }
API const void *lr_img_data(libraw_processed_image_t *i) { return i->data; }
API void lr_free_image(libraw_processed_image_t *i) { LibRaw::dcraw_clear_mem(i); }

/** unpack + dcraw_process. half_size skips demosaic (fastest); output is 8-bit sRGB, camera flip applied. */
API int lr_process(LibRaw *p, int half_size, int use_camera_wb, int use_auto_wb, int highlight, int quality) {
  libraw_output_params_t &o = p->imgdata.params;
  o.half_size = half_size;
  o.use_camera_wb = use_camera_wb;
  o.use_auto_wb = use_auto_wb;
  o.highlight = highlight;
  o.user_qual = quality;
  o.output_bps = 8;
  o.output_color = 1; // sRGB
  o.user_flip = -1;   // use camera orientation
  int r = p->unpack();
  if (r != LIBRAW_SUCCESS) return r;
  return p->dcraw_process();
}
