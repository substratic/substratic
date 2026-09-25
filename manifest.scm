;; substratic - the development environment for the native builds and the
;; demo. Use through scripts/dev, which runs a command as
;;   guix shell -m manifest.scm -- sh -c 'CPATH=$GUIX_ENVIRONMENT/include LIBRARY_PATH=$GUIX_ENVIRONMENT/lib <cmd>'
;;
;; Build side: sigil-desktop's vendored GLFW compiles against the X11 and
;; Wayland headers (it links none of them); no GL headers are needed
;; (sigil-graphics loads GL through sigil-desktop at run time). The C
;; compiler is the zig sigil pins, not anything here.
;;
;; Run side, for the demo and its native checks: mesa (libGL, libEGL,
;; llvmpipe), the X libraries GLFW dlopens under Xvfb, and wayland +
;; libxkbcommon for a Wayland compositor. libglvnd must NOT be here: Guix's
;; mesa is built without it and a vendorless libGLX.so.0 breaks GLFW's GLX.
;;
;; binaryen supplies wasm-opt for the web build; without it the build still
;; exits 0 and silently skips the optimize pass.

(specifications->manifest
 '("pkg-config"

   ;; GLFW compile-time headers (sigil-desktop)
   "libx11" "libxcursor" "libxrandr" "libxinerama" "libxi" "libxext" "xorgproto"
   "wayland" "libxkbcommon"

   ;; Run time: GL and the X libraries GLFW loads
   "mesa"
   "libxrender"

   ;; Web build
   "binaryen"))     ; wasm-opt
