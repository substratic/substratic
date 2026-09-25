/*
 * capture.c - (substratic image capture): read the frame just drawn.
 *
 *   (%capture-frame w h) -> a bytevector of w*h*4 RGBA8 bytes, rows
 *                           BOTTOM first (GL's order), or #f
 *
 * Natively, glReadPixels on the default framebuffer, called after the
 * frame's end-frame (the drawing has been submitted) and before the next
 * wait-frame swaps the buffers. GL entry points come from sigil-desktop's
 * proc loader (GLFW's glfwGetProcAddress), as sigil-graphics loads its
 * own, so nothing GL is linked. Every piece of GL state it touches (the
 * read framebuffer binding, framebuffer 0's read buffer, the pack alignment
 * and row length) is put back after the read, so sokol's cached state
 * stays true.
 *
 * On the web the page takes the screenshot from the canvas instead
 * (assets/substratic/substratic.js), and this answers #f.
 */
#include "sigil-internal.h"
#include <stdint.h>
#include <string.h>

#if defined(__wasm__)

static Value native_capture_frame(SigilVM *vm, int argc, Value *args)
{
    (void)vm; (void)argc; (void)args;
    return SIGIL_FALSE;
}

#else

typedef unsigned int GLenum;
typedef int GLint;
typedef int GLsizei;
typedef void (*pfn_glReadPixels)(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *);
typedef void (*pfn_glBindFramebuffer)(GLenum, unsigned int);
typedef void (*pfn_glGetIntegerv)(GLenum, GLint *);
typedef void (*pfn_glPixelStorei)(GLenum, GLint);
typedef void (*pfn_glReadBuffer)(GLenum);
typedef GLenum (*pfn_glGetError)(void);

#define SUB_GL_RGBA                     0x1908
#define SUB_GL_UNSIGNED_BYTE            0x1401
#define SUB_GL_READ_FRAMEBUFFER         0x8CA8
#define SUB_GL_READ_FRAMEBUFFER_BINDING 0x8CAA
#define SUB_GL_PACK_ALIGNMENT           0x0D05
#define SUB_GL_READ_BUFFER              0x0C02
#define SUB_GL_BACK                     0x0405
#define SUB_GL_PACK_ROW_LENGTH          0x0D02
#define SUB_GL_PIXEL_PACK_BUFFER_BINDING 0x88ED

extern void *sigil_desktop_gl_get_proc_address(const char *name);

static Value native_capture_frame(SigilVM *vm, int argc, Value *args)
{
    (void)argc;
    if (!sigil_is_fixnum(args[0]) || !sigil_is_fixnum(args[1])) {
        sigil__vm_set_error(vm, SIGIL_ERR_TYPE, "%capture-frame: width and height must be integers");
        return SIGIL_UNDEFINED;
    }
    /* range-checked before narrowing: 2^32+100 must not pass as 100 */
    int64_t w64 = (int64_t)sigil_as_fixnum(args[0]);
    int64_t h64 = (int64_t)sigil_as_fixnum(args[1]);
    if (w64 <= 0 || h64 <= 0 || w64 > 16384 || h64 > 16384) return SIGIL_FALSE;
    int w = (int)w64;
    int h = (int)h64;

    pfn_glReadPixels read_pixels = (pfn_glReadPixels)sigil_desktop_gl_get_proc_address("glReadPixels");
    pfn_glBindFramebuffer bind_fb = (pfn_glBindFramebuffer)sigil_desktop_gl_get_proc_address("glBindFramebuffer");
    pfn_glGetIntegerv get_int = (pfn_glGetIntegerv)sigil_desktop_gl_get_proc_address("glGetIntegerv");
    pfn_glPixelStorei pixel_store = (pfn_glPixelStorei)sigil_desktop_gl_get_proc_address("glPixelStorei");
    pfn_glReadBuffer read_buffer = (pfn_glReadBuffer)sigil_desktop_gl_get_proc_address("glReadBuffer");
    pfn_glGetError get_error = (pfn_glGetError)sigil_desktop_gl_get_proc_address("glGetError");
    if (!read_pixels || !bind_fb || !get_int || !pixel_store || !read_buffer || !get_error) return SIGIL_FALSE;

    Value bv = sigil_make_bytevector(vm, (size_t)w * (size_t)h * 4u);
    if (!sigil_is_bytevector(bv)) return SIGIL_FALSE;

    /* The state touched, saved and put back: the read binding, and on the
     * default framebuffer its read buffer; the pack alignment and row
     * length. With a pixel pack buffer bound the read would go into it,
     * not our memory, so that case answers #f. */
    GLint old_fb = 0, old_align = 4, old_row = 0, old_read0 = SUB_GL_BACK, pack_buf = 0;
    for (int i = 0; i < 16 && get_error() != 0; i++) { /* drain, bounded */ }
    get_int(SUB_GL_PIXEL_PACK_BUFFER_BINDING, &pack_buf);
    if (pack_buf != 0) return SIGIL_FALSE;
    get_int(SUB_GL_READ_FRAMEBUFFER_BINDING, &old_fb);
    get_int(SUB_GL_PACK_ALIGNMENT, &old_align);
    get_int(SUB_GL_PACK_ROW_LENGTH, &old_row);

    bind_fb(SUB_GL_READ_FRAMEBUFFER, 0);
    get_int(SUB_GL_READ_BUFFER, &old_read0);      /* framebuffer 0's own */
    read_buffer(SUB_GL_BACK);
    pixel_store(SUB_GL_PACK_ALIGNMENT, 1);
    pixel_store(SUB_GL_PACK_ROW_LENGTH, 0);
    read_pixels(0, 0, w, h, SUB_GL_RGBA, SUB_GL_UNSIGNED_BYTE, sigil_bytevector_data(bv));
    GLenum err = get_error();

    read_buffer((GLenum)old_read0);
    pixel_store(SUB_GL_PACK_ROW_LENGTH, old_row);
    pixel_store(SUB_GL_PACK_ALIGNMENT, old_align);
    bind_fb(SUB_GL_READ_FRAMEBUFFER, (unsigned int)old_fb);

    if (err != 0) return SIGIL_FALSE;
    return bv;
}

#endif


/*
 * (%encode-png w h rgba bottom-first?) -> the PNG file's bytes
 *
 * The same file (substratic image png)'s rgba->png writes, byte for byte
 * (test/test-png.sgl holds the two to that): 8-bit RGBA, filter 0 on every
 * row, a zlib stream of stored deflate blocks. Here in C because a
 * per-byte loop in the bytecode VM took 12 s for a 640x352 frame, during
 * which the game stood still. Pure C, so every target has it.
 */
static uint32_t crc_table[256];
static int crc_ready = 0;

static void crc_init(void)
{
    for (uint32_t n = 0; n < 256; n++) {
        uint32_t c = n;
        for (int k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        crc_table[n] = c;
    }
    crc_ready = 1;
}

static uint32_t crc_update(uint32_t crc, const uint8_t *p, size_t n)
{
    uint32_t c = crc ^ 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) c = crc_table[(c ^ p[i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

static uint8_t *put32(uint8_t *o, uint32_t v)
{
    o[0] = (uint8_t)(v >> 24); o[1] = (uint8_t)(v >> 16); o[2] = (uint8_t)(v >> 8); o[3] = (uint8_t)v;
    return o + 4;
}

static Value native_encode_png(SigilVM *vm, int argc, Value *args)
{
    (void)argc;
    if (!sigil_is_fixnum(args[0]) || !sigil_is_fixnum(args[1]) || !sigil_is_bytevector(args[2])) {
        sigil__vm_set_error(vm, SIGIL_ERR_TYPE, "%encode-png: expected width, height, bytevector");
        return SIGIL_UNDEFINED;
    }
    long w = (long)sigil_as_fixnum(args[0]);
    long h = (long)sigil_as_fixnum(args[1]);
    int flip = !(args[3] == SIGIL_FALSE);
    if (w <= 0 || h <= 0 || w > 16384 || h > 16384 ||
        sigil_bytevector_length(args[2]) != (size_t)w * (size_t)h * 4u) {
        sigil__vm_set_error(vm, SIGIL_ERR_TYPE, "%encode-png: the bytevector is not w*h*4 bytes");
        return SIGIL_UNDEFINED;
    }
    if (!crc_ready) crc_init();

    size_t row = (size_t)w * 4u;
    size_t raw = (size_t)h * (row + 1u);
    size_t blocks = (raw + 65534u) / 65535u;
    size_t zlen = 2u + 5u * blocks + raw + 4u;
    size_t total = 8u + (12u + 13u) + (12u + zlen) + 12u;

    Value out = sigil_make_bytevector(vm, total);
    if (!sigil_is_bytevector(out)) return SIGIL_FALSE;
    /* the allocation may move nothing we hold but the input: fetch it after */
    const uint8_t *px = sigil_bytevector_data(args[2]);
    uint8_t *o = sigil_bytevector_data(out);

    static const uint8_t sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
    memcpy(o, sig, 8); o += 8;

    /* IHDR */
    uint8_t *chunk = o;
    o = put32(o, 13); memcpy(o, "IHDR", 4); o += 4;
    o = put32(o, (uint32_t)w); o = put32(o, (uint32_t)h);
    *o++ = 8; *o++ = 6; *o++ = 0; *o++ = 0; *o++ = 0;
    o = put32(o, crc_update(0, chunk + 4, 17));

    /* IDAT: the zlib stream, the scanlines streamed through stored blocks */
    chunk = o;
    o = put32(o, (uint32_t)zlen); memcpy(o, "IDAT", 4); o += 4;
    *o++ = 0x78; *o++ = 0x01;
    uint32_t a = 1, b = 0;
    size_t pos = 0;                         /* position in the raw scanline stream */
    for (size_t k = 0; k < blocks; k++) {
        size_t len = raw - pos < 65535u ? raw - pos : 65535u;
        *o++ = (k == blocks - 1) ? 1 : 0;
        *o++ = (uint8_t)(len & 0xFF); *o++ = (uint8_t)(len >> 8);
        *o++ = (uint8_t)(~len & 0xFF); *o++ = (uint8_t)((~len >> 8) & 0xFF);
        for (size_t i = 0; i < len; i++, pos++) {
            size_t y = pos / (row + 1u), x = pos % (row + 1u);
            uint8_t v = 0;
            if (x > 0) {
                size_t sy = flip ? (size_t)h - 1u - y : y;
                v = px[sy * row + (x - 1u)];
            }
            *o++ = v;
            a = (a + v) % 65521u; b = (b + a) % 65521u;
        }
    }
    o = put32(o, (b << 16) | a);
    o = put32(o, crc_update(0, chunk + 4, 4 + zlen));

    /* IEND */
    chunk = o;
    o = put32(o, 0); memcpy(o, "IEND", 4); o += 4;
    o = put32(o, crc_update(0, chunk + 4, 4));
    return out;
}

void sigil__init_substratic_image_capture_module(SigilVM *vm)
{
    SigilModule *module = sigil_begin_module(vm, "(substratic image capture)");
    if (!module) return;
    sigil_module_register_native(vm, "%capture-frame", native_capture_frame,
                                 SIGIL_ARITY_EXACT(2), "Read the frame just drawn as RGBA8, rows bottom first");
    sigil_module_register_native(vm, "%encode-png", native_encode_png,
                                 SIGIL_ARITY_EXACT(4), "RGBA8 bytes to a PNG file's bytes");
    sigil_module_export(vm, "%capture-frame");
    sigil_module_export(vm, "%encode-png");
    sigil_end_module(vm);
}
