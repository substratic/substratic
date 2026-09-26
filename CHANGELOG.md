# Changelog

## Unreleased

- `substratic.js`: the fullscreen button draws its icon as inline SVG. It
  was the character U+26F6, which many fonts lack, so browsers without
  one showed a missing-glyph box. It now shows four corners pointing out,
  and pointing in while the page is fullscreen.
- Substratic's own lock and the examples' locks are on Sigil 0.22.8. The
  package still asks for Sigil 0.22.7 or later, so games on 0.22.7 are
  unaffected.

## 0.2.1 (2026-09-26)

- sigil-graphics `>=0.12.0, <0.14.0` (was `^0.12.0`): a game can take
  sigil-graphics 0.13 (the text atlas) with Substratic, and one locked to
  0.12 keeps working. Substratic uses nothing new from it; its own lock
  and the examples are on 0.13.0.

## 0.2.0 (2026-09-25)

- `examples/emberlight`: a tiny game made with Substratic, its showcase and
  integration test; the six-room demo stays as a test fixture.
- `(substratic store settings)`: `version: #f` makes a table with no schema
  version that never resets, for a game adopting the module with players
  whose settings have no version key.
- `substratic.js`: a `focus` option (off for a page that sends its own focus
  events), and no canvas touch handling when a page configures no sticks.
- `(substratic input pad)`: a gamepad, natively through GLFW's gamepad API
  (a small C native), on the web through the browser's Gamepad API, which
  `substratic.js` now polls and sends as `("pad", ...)`.

## 0.1.0 (2026-09-25)

The first modules, extracted from Crash The Stack and Harkfell, and the
playtest reports.

- `(substratic view fit)`, `(substratic view present)`: a view at whole
  scales, sharp bilinear where none fits well, integer-only for a desktop
  window.
- `(substratic view window)`: a desktop window that snaps to whole scales
  in screen units and remembers them; F11 and Alt+Enter fullscreen.
- `(substratic store kv)`, `(substratic store settings)`: files natively,
  localStorage on the web; a settings table with a schema-version reset.
- `(substratic time clock)`, `(substratic time tween)`: the fixed clock and
  tweens.
- `(substratic input keys)`, `(substratic input sticks)`,
  `(substratic input events)`: keys and touch sticks on both targets.
- `(substratic update version)`, `(substratic update check)`: version.json,
  the desktop comparison, and the once-per-version "new in" line.
- `(substratic playtest session)`: F1 readout, F2 report (screenshot,
  report.json, a typed note), natively and on the web.
- `(substratic web params)`: the page's URL parameters as key and value.
- `(substratic data json)`, `(substratic image png)`,
  `(substratic image capture)`, `(substratic text font)`: what those need.
- `web/index.template.html` and `assets/substratic/substratic.js`: a page
  that forwards every URL parameter, floating touch sticks, the report's
  browser half. `tools/serve.mjs`: a dev server that writes reports.
- `examples/demo`: six rooms, both targets, `--selftest`, and two headless
  verifiers.
