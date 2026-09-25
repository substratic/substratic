# Changelog

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
