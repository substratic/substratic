/*
 * natives.c - substratic's native-init: registers every module with C
 * natives (the package declares one init; this calls each module's).
 */
#include "sigil-internal.h"

extern void sigil__init_substratic_image_capture_module(SigilVM *vm);
extern void sigil__init_substratic_input_pad_module(SigilVM *vm);

void sigil__init_substratic_natives(SigilVM *vm)
{
    sigil__init_substratic_image_capture_module(vm);
    sigil__init_substratic_input_pad_module(vm);
}
