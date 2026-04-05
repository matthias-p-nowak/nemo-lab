package tiles

// #cgo pkg-config: libpng
// #cgo LDFLAGS: -ljpeg
// #include <stdio.h>
// #include <stdlib.h>
// #include <string.h>
// #include <png.h>
// #include <jpeglib.h>
// #include <setjmp.h>
//
// // ── PNG ──────────────────────────────────────────────────────────────────────
//
// typedef struct {
//     unsigned char *data;
//     int width, height;
//     char err[256];
// } png_result;
//
// static void png_error_fn(png_structp p, png_const_charp msg) {
//     png_result *r = (png_result *)png_get_error_ptr(p);
//     strncpy(r->err, msg, sizeof(r->err)-1);
//     longjmp(png_jmpbuf(p), 1);
// }
//
// png_result decode_png(const char *path) {
//     png_result r = {0};
//     FILE *fp = fopen(path, "rb");
//     if (!fp) { strncpy(r.err, "cannot open file", sizeof(r.err)-1); return r; }
//
//     png_structp png = png_create_read_struct(PNG_LIBPNG_VER_STRING, &r, png_error_fn, NULL);
//     if (!png) { fclose(fp); strncpy(r.err, "png_create_read_struct failed", sizeof(r.err)-1); return r; }
//
//     png_infop info = png_create_info_struct(png);
//     if (!info) { png_destroy_read_struct(&png, NULL, NULL); fclose(fp); strncpy(r.err, "png_create_info_struct failed", sizeof(r.err)-1); return r; }
//
//     if (setjmp(png_jmpbuf(png))) {
//         png_destroy_read_struct(&png, &info, NULL);
//         fclose(fp);
//         return r;
//     }
//
//     png_init_io(png, fp);
//     png_read_info(png, info);
//
//     int w = png_get_image_width(png, info);
//     int h = png_get_image_height(png, info);
//     png_byte color_type = png_get_color_type(png, info);
//     png_byte bit_depth = png_get_bit_depth(png, info);
//
//     // Normalize to 8-bit RGBA
//     if (bit_depth == 16) png_set_strip_16(png);
//     if (color_type == PNG_COLOR_TYPE_PALETTE) png_set_palette_to_rgb(png);
//     if (color_type == PNG_COLOR_TYPE_GRAY && bit_depth < 8) png_set_expand_gray_1_2_4_to_8(png);
//     if (png_get_valid(png, info, PNG_INFO_tRNS)) png_set_tRNS_to_alpha(png);
//     if (color_type == PNG_COLOR_TYPE_RGB || color_type == PNG_COLOR_TYPE_GRAY || color_type == PNG_COLOR_TYPE_PALETTE)
//         png_set_filler(png, 0xFF, PNG_FILLER_AFTER);
//     if (color_type == PNG_COLOR_TYPE_GRAY || color_type == PNG_COLOR_TYPE_GRAY_ALPHA)
//         png_set_gray_to_rgb(png);
//     png_read_update_info(png, info);
//
//     unsigned char *data = (unsigned char *)malloc(w * h * 4);
//     if (!data) { strncpy(r.err, "out of memory", sizeof(r.err)-1); png_destroy_read_struct(&png, &info, NULL); fclose(fp); return r; }
//
//     png_bytep *rows = (png_bytep *)malloc(h * sizeof(png_bytep));
//     if (!rows) { free(data); strncpy(r.err, "out of memory", sizeof(r.err)-1); png_destroy_read_struct(&png, &info, NULL); fclose(fp); return r; }
//     for (int y = 0; y < h; y++) rows[y] = data + y * w * 4;
//
//     png_read_image(png, rows);
//     free(rows);
//     png_destroy_read_struct(&png, &info, NULL);
//     fclose(fp);
//
//     r.data = data; r.width = w; r.height = h;
//     return r;
// }
//
// // ── JPEG ─────────────────────────────────────────────────────────────────────
//
// typedef struct {
//     unsigned char *data;
//     int width, height;
//     char err[256];
// } jpeg_result;
//
// struct my_error_mgr {
//     struct jpeg_error_mgr pub;
//     jmp_buf setjmp_buf;
//     char msg[256];
// };
//
// static void my_error_exit(j_common_ptr cinfo) {
//     struct my_error_mgr *myerr = (struct my_error_mgr *)cinfo->err;
//     (*cinfo->err->format_message)(cinfo, myerr->msg);
//     longjmp(myerr->setjmp_buf, 1);
// }
//
// jpeg_result decode_jpeg(const char *path) {
//     jpeg_result r = {0};
//     FILE *fp = fopen(path, "rb");
//     if (!fp) { strncpy(r.err, "cannot open file", sizeof(r.err)-1); return r; }
//
//     struct jpeg_decompress_struct cinfo;
//     struct my_error_mgr jerr;
//     cinfo.err = jpeg_std_error(&jerr.pub);
//     jerr.pub.error_exit = my_error_exit;
//
//     if (setjmp(jerr.setjmp_buf)) {
//         strncpy(r.err, jerr.msg, sizeof(r.err)-1);
//         jpeg_destroy_decompress(&cinfo);
//         fclose(fp);
//         return r;
//     }
//
//     jpeg_create_decompress(&cinfo);
//     jpeg_stdio_src(&cinfo, fp);
//     jpeg_read_header(&cinfo, TRUE);
//     cinfo.out_color_space = JCS_EXT_RGBA;
//     jpeg_start_decompress(&cinfo);
//
//     int w = cinfo.output_width;
//     int h = cinfo.output_height;
//     unsigned char *data = (unsigned char *)malloc(w * h * 4);
//     if (!data) { strncpy(r.err, "out of memory", sizeof(r.err)-1); jpeg_destroy_decompress(&cinfo); fclose(fp); return r; }
//
//     while (cinfo.output_scanline < cinfo.output_height) {
//         unsigned char *row = data + cinfo.output_scanline * w * 4;
//         jpeg_read_scanlines(&cinfo, &row, 1);
//     }
//
//     jpeg_finish_decompress(&cinfo);
//     jpeg_destroy_decompress(&cinfo);
//     fclose(fp);
//
//     r.data = data; r.width = w; r.height = h;
//     return r;
// }
import "C"

import (
	"fmt"
	"image"
	"strings"
	"unsafe"
)

// decodeImageNative decodes a PNG or JPEG using native libraries (libpng /
// libjpeg), returning an *image.RGBA directly. Returns (nil, nil) for formats
// that should fall through to the pure-Go decoder.
func decodeImageNative(path string) (*image.RGBA, error) {
	lower := strings.ToLower(path)
	switch {
	case strings.HasSuffix(lower, ".png"):
		return decodePNGNative(path)
	case strings.HasSuffix(lower, ".jpg"), strings.HasSuffix(lower, ".jpeg"):
		return decodeJPEGNative(path)
	default:
		return nil, nil // fall through to pure Go
	}
}

func decodePNGNative(path string) (*image.RGBA, error) {
	cpath := C.CString(path)
	defer C.free(unsafe.Pointer(cpath))

	r := C.decode_png(cpath)
	if r.data == nil {
		return nil, fmt.Errorf("libpng: %s", C.GoString(&r.err[0]))
	}
	defer C.free(unsafe.Pointer(r.data))

	w, h := int(r.width), int(r.height)
	pix := C.GoBytes(unsafe.Pointer(r.data), C.int(w*h*4))
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	copy(img.Pix, pix)
	return img, nil
}

func decodeJPEGNative(path string) (*image.RGBA, error) {
	cpath := C.CString(path)
	defer C.free(unsafe.Pointer(cpath))

	r := C.decode_jpeg(cpath)
	if r.data == nil {
		return nil, fmt.Errorf("libjpeg: %s", C.GoString(&r.err[0]))
	}
	defer C.free(unsafe.Pointer(r.data))

	w, h := int(r.width), int(r.height)
	pix := C.GoBytes(unsafe.Pointer(r.data), C.int(w*h*4))
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	copy(img.Pix, pix)
	return img, nil
}
