# Substratic

A small game engine for [Sigil](https://codeberg.org/sigil/sigil), for games
that run as a desktop binary and in the browser from one source tree. It is
the layer the games share: a pixel view at whole-number scales, a store and
settings, a fixed clock and tweens, keys and touch sticks, the version.json
update check, and playtest reports. It grew out of two games, Crash The
Stack and Harkfell, and holds what both of them needed.

Genre pieces (tilemaps, platformer physics, rooms, a 3D walker) are not here.
They live in the games until a second game needs them, then move into an
extension package, `substratic-<area>`.

## Modules

Every module is `(substratic <area> <concept>)`.

| Module | What it does |
|---|---|
| `(substratic view fit)` | Place a fixed-size view on a window at the largest whole scale that fits, centred; "sharp bilinear" where no whole scale fits well; `integer-only:` for a desktop window |
| `(substratic view present)` | Draw a view's render target at its fit, with the sharp-bilinear pass |
| `(substratic view window)` | A desktop window at whole scales of the view: snaps a resize to the scale it fits, remembers it, F11 / Alt+Enter fullscreen, with guards against window managers that choose the size |
| `(substratic store kv)` | Keys to text: files under the user data directory natively, localStorage on the web |
| `(substratic store settings)` | A game's settings table: rows, the values in force, a schema version that resets old stores once |
| `(substratic time clock)` | Render frames into whole 1/60 s ticks, with a cap on catch-up |
| `(substratic time tween)` | Tweens and easing on that clock, frame-rate independent |
| `(substratic input keys)` | Keys down, pressed and released; DOM key names mapped to the desktop's |
| `(substratic input sticks)` | Touch sticks by name; an 8-way reader tuned for platformers, an analogue reader with a dead zone |
| `(substratic input events)` | The web page's key and stick events into the two states |
| `(substratic input pad)` | A gamepad's sticks, triggers and buttons: GLFW's gamepad API natively, the browser's on the web |
| `(substratic update version)` | version.json parsed; versions compared |
| `(substratic update check)` | Whether to show "a new version is ready" or "new in X.Y.Z", once per version |
| `(substratic playtest session)` | F1: a location readout. F2: a report with a screenshot, report.json and a typed note |
| `(substratic web params)` | The page's URL parameters, each split into key and value |
| `(substratic data json)` | JSON in and out, small |
| `(substratic image png)` | RGBA pixels to PNG |
| `(substratic image capture)` | The frame just drawn, read back natively (a C native) |
| `(substratic text font)` | A 5x7 bitmap font drawn as rectangles |

Each module's header says what it does in detail.

## Using it

```scheme
(dependencies: (list
  (from-git url: "github:substratic/substratic" version: "^0.1.0")
  ...))
```

A game on the web also lists `sigil-browser` (and its other web
dependencies) itself: a dependency's own dependencies are not compiled into
the game's bundle unless the game lists them.

### The web page

`web/index.template.html` is a page template: copy it to the game's package
root as `index.template.html`, set the title, and adjust `window.SUBSTRATIC`.
It forwards **every** URL parameter to the game, as `("params", QUERY)` and
then `("param", "KEY=VALUE")` for each, so no list of parameters has to be
kept in step with the game. `assets/substratic/substratic.js`, copied into
the game's `build/web/assets/` by the build, adds floating touch sticks (the
ring pops up under the thumb), on-screen buttons that send keys, focus
handling, the version.json fetch, the playtest report's browser half and a
fullscreen button.

### Playtest reports

```scheme
(define pt (make-playtest game: "my-game" build: stamp platform: 'desktop
                          describe: (lambda () (list (cons 'room "x3y2") (cons 'cell (cons 4 7))))
                          snapshot: (lambda () (save-datum))
                          enabled: dev-build?))
```

Each frame: `playtest-frame!` (desktop), `playtest-tick!`, `playtest-draw!`
inside the frame, `playtest-after-frame!` after it; on the web, route the
page's events through `playtest-dispatch!` first. For a deterministic game,
`playtest-room-entered!` and `playtest-record-input!` put the input since
the room was entered in the report.

On the desktop a report is written to `<data dir>/<game>/reports/<time>/`
(`report.json`, `screenshot.png`). On the web the page POSTs it to the dev
server:

```sh
node tools/serve.mjs build/web 8000 --reports reports
```

which serves the build on 127.0.0.1 (or `--host ADDR`, `--tls CERTDIR`) and
writes each report to `reports/<time>/`.

## Emberlight, the example game

`examples/emberlight` is a tiny game made with Substratic: steer a moth
through a dark room and gather the drifting embers before they burn out.
Each catch grows the pool of light around the moth; each miss lets the dark
close in. Rounds are 60 seconds. It uses only the core modules, and it is
the place to see how they fit together.

```sh
cd examples/emberlight
sigil deps install
../../scripts/dev sigil build                    # desktop, bytecode
../../scripts/dev sigil build --config release   # desktop, native
../../scripts/dev sigil build --config web       # browser (needs wasm-opt)
node ../../tools/serve.mjs build/web 8000        # then http://127.0.0.1:8000/?playtest
```

Arrows or WASD, a gamepad's left stick or d-pad, or one touch stick wherever
the thumb lands; Space, A or a touch starts a round; P changes the palette;
F1 shows the readout and F2 makes a report.

Its frame, in `src/emberlight/shell/core.sgl`, is the whole pattern:

```scheme
(set! *clock* (clock-advance *clock* dt))             ; wall time into 1/60 s ticks
(step-world! (clock-steps *clock*))                   ; keys + pad + stick -> world-step, logged for F2
(let ((f (view-fit win-w win-h VIEW-W VIEW-H integer-only: integer-only)))
  (begin-frame)
  (with-render-target *rt*                            ; the 256x144 room
    (draw-room! *world* *best* line (settings-value TABLE *settings* 'palette)))
  (view-present! *presenter* *rt* f)                  ; at a whole scale, or sharp bilinear
  (playtest-draw! *pt* win-w win-h)                   ; F1's readout, the desktop note
  (end-frame))
(playtest-after-frame! *pt* win-w win-h)              ; F2's screenshot
```

The desktop shell adds the window (`window-scaler-frame!`), the key and pad
polls, and F1/F2's keys; the web shell routes the page's events to
`playtest-dispatch!`, `updater-dispatch!`, `pad-dispatch!` and
`input-dispatch!`, in that order.

`verify-native.sh` and `verify-web.mjs` drive both builds headless and check
each feature end to end, including a scripted gamepad in the browser.

`examples/demo`, six rooms and some gems, is kept as a test fixture: its
`--selftest` (desktop) and `?selftest` (web) run the engine's checks inside a
built game on its own target.

## Tests

```sh
sigil deps install
scripts/dev sigil build
scripts/dev sigil test --sgl                      # bytecode
scripts/dev sigil test --sgl --backend native     # native
```

`scripts/dev` runs a command in the Guix environment the native build needs
(`manifest.scm`).

## Licence

BSD-3-Clause. See `LICENSE`.
