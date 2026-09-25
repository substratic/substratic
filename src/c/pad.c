/*
 * pad.c - (substratic input pad)'s native: the first connected gamepad.
 *
 *   (%pad-read) -> an 8-byte bytevector, or #f when no gamepad is connected
 *       bytes 0..5  the axes LX LY RX RY LT RT, each -1..1 as 1..255
 *                   (value = (byte - 128) / 127, so centre is exactly 0)
 *       bytes 6..7  the 15 buttons as bits, low byte first, in GLFW's order:
 *                   A B X Y LB RB BACK START GUIDE LTHUMB RTHUMB UP RIGHT DOWN LEFT
 *
 * Natively, GLFW's gamepad API (3.3+), which sigil-desktop builds in with
 * its joystick backends; GLFW maps known controllers to the standard
 * layout from its built-in database. Called after wait-frame, whose event
 * poll updates the state. Before GLFW is initialised the calls fail
 * harmlessly and this answers #f.
 *
 * On the web the page reads the browser's Gamepad API instead
 * (assets/substratic/substratic.js), and this answers #f.
 */
#include "sigil-internal.h"
#include <stdint.h>

#if defined(__wasm__)

static Value native_pad_read(SigilVM *vm, int argc, Value *args)
{
    (void)vm; (void)argc; (void)args;
    return SIGIL_FALSE;
}

#else

typedef struct { unsigned char buttons[15]; float axes[6]; } sub_gamepad_state;
extern int glfwJoystickIsGamepad(int jid);
extern int glfwGetGamepadState(int jid, sub_gamepad_state *state);

static Value native_pad_read(SigilVM *vm, int argc, Value *args)
{
    (void)argc; (void)args;
    for (int jid = 0; jid < 16; jid++) {
        sub_gamepad_state st;
        if (!glfwJoystickIsGamepad(jid) || !glfwGetGamepadState(jid, &st)) continue;
        Value bv = sigil_make_bytevector(vm, 8);
        if (!sigil_is_bytevector(bv)) return SIGIL_FALSE;
        uint8_t *o = sigil_bytevector_data(bv);
        for (int i = 0; i < 6; i++) {
            float a = st.axes[i];
            if (a < -1.0f) a = -1.0f;
            if (a > 1.0f) a = 1.0f;
            int q = 128 + (int)(a * 127.0f + (a < 0 ? -0.5f : 0.5f));
            o[i] = (uint8_t)(q < 1 ? 1 : (q > 255 ? 255 : q));
        }
        unsigned int bits = 0;
        for (int b = 0; b < 15; b++) if (st.buttons[b]) bits |= 1u << b;
        o[6] = (uint8_t)(bits & 0xFF);
        o[7] = (uint8_t)(bits >> 8);
        return bv;
    }
    return SIGIL_FALSE;
}

#endif

void sigil__init_substratic_input_pad_module(SigilVM *vm)
{
    SigilModule *module = sigil_begin_module(vm, "(substratic input pad)");
    if (!module) return;
    sigil_module_register_native(vm, "%pad-read", native_pad_read,
                                 SIGIL_ARITY_EXACT(0), "The first connected gamepad's axes and buttons, or #f");
    sigil_module_export(vm, "%pad-read");
    sigil_end_module(vm);
}
