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
 * own, so nothing GL is linked. The read framebuffer binding and the pack
 * alignment are restored after the read, so sokol's cached state stays
 * true.
 *
 * On the web the page takes the screenshot from the canvas instead
 * (web/substratic.js), and this answers #f.
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

extern void *sigil_desktop_gl_get_proc_address(const char *name);

static Value native_capture_frame(SigilVM *vm, int argc, Value *args)
{
    (void)argc;
    if (!sigil_is_fixnum(args[0]) || !sigil_is_fixnum(args[1])) {
        sigil__vm_set_error(vm, SIGIL_ERR_TYPE, "%capture-frame: width and height must be integers");
        return SIGIL_UNDEFINED;
    }
    int w = (int)sigil_as_fixnum(args[0]);
    int h = (int)sigil_as_fixnum(args[1]);
    if (w <= 0 || h <= 0 || w > 16384 || h > 16384) return SIGIL_FALSE;

    pfn_glReadPixels read_pixels = (pfn_glReadPixels)sigil_desktop_gl_get_proc_address("glReadPixels");
    pfn_glBindFramebuffer bind_fb = (pfn_glBindFramebuffer)sigil_desktop_gl_get_proc_address("glBindFramebuffer");
    pfn_glGetIntegerv get_int = (pfn_glGetIntegerv)sigil_desktop_gl_get_proc_address("glGetIntegerv");
    pfn_glPixelStorei pixel_store = (pfn_glPixelStorei)sigil_desktop_gl_get_proc_address("glPixelStorei");
    pfn_glReadBuffer read_buffer = (pfn_glReadBuffer)sigil_desktop_gl_get_proc_address("glReadBuffer");
    pfn_glGetError get_error = (pfn_glGetError)sigil_desktop_gl_get_proc_address("glGetError");
    if (!read_pixels || !bind_fb || !get_int || !pixel_store || !read_buffer || !get_error) return SIGIL_FALSE;

    Value bv = sigil_make_bytevector(vm, (size_t)w * (size_t)h * 4u);
    if (!sigil_is_bytevector(bv)) return SIGIL_FALSE;

    GLint old_fb = 0, old_align = 4, old_read = SUB_GL_BACK;
    while (get_error() != 0) { /* clear anything pending */ }
    get_int(SUB_GL_READ_FRAMEBUFFER_BINDING, &old_fb);
    get_int(SUB_GL_PACK_ALIGNMENT, &old_align);
    get_int(SUB_GL_READ_BUFFER, &old_read);

    bind_fb(SUB_GL_READ_FRAMEBUFFER, 0);
    read_buffer(SUB_GL_BACK);
    pixel_store(SUB_GL_PACK_ALIGNMENT, 1);
    read_pixels(0, 0, w, h, SUB_GL_RGBA, SUB_GL_UNSIGNED_BYTE, sigil_bytevector_data(bv));
    GLenum err = get_error();

    pixel_store(SUB_GL_PACK_ALIGNMENT, old_align);
    bind_fb(SUB_GL_READ_FRAMEBUFFER, (unsigned int)old_fb);
    if (old_fb != 0) read_buffer((GLenum)old_read);

    if (err != 0) return SIGIL_FALSE;
    return bv;
}

#endif

void sigil__init_substratic_image_capture_module(SigilVM *vm)
{
    SigilModule *module = sigil_begin_module(vm, "(substratic image capture)");
    if (!module) return;
    sigil_module_register_native(vm, "%capture-frame", native_capture_frame,
                                 SIGIL_ARITY_EXACT(2), "Read the frame just drawn as RGBA8, rows bottom first");
    sigil_module_export(vm, "%capture-frame");
    sigil_end_module(vm);
}
