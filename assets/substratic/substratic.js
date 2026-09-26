// substratic.js - the page side of a Substratic game on the web.
//
// The generic loader (sigil-web-app.js) boots the wasm, forwards keydown
// and keyup, and the gles3 bridge dispatches ("frame", ms) once per
// requestAnimationFrame. This adds, each part optional:
//
//   params     EVERY URL parameter goes to the game, with no list to keep:
//              ("params", "a=1&b") once, then ("param", "KEY=VALUE") for
//              each one in order ("param", "KEY" for a bare ?key). The
//              game ignores what it does not know.
//   sticks     floating touch sticks: a thumb landing in a stick's zone
//              pops the ring up under it, and the offset is sent as
//              ("stick", "NAME,DX,DY") in ring radii, dy down, the length
//              clamped to 1; lifting sends NAME,0,0. Shown from the first
//              touch, or with ?touch.
//   buttons    on-screen buttons that send ("keydown"/"keyup", KEY), so the
//              game reads them exactly as keys.
//   focus      ("blur", "") when the page loses focus or is hidden, so no
//              key or stick stays held; ("visibility", "visible"|"hidden").
//   update     version.json fetched once (uncached) and handed over as
//              ("update-info", TEXT); SubstraticPage.updateWaiting() (call
//              it from a service worker's "waiting") sends ("update",
//              "waiting").
//   playtest   the report's browser half ((substratic playtest session)):
//              the game's "substratic: playtest capture JSON" console line
//              -> the canvas as a PNG, taken in the same task before the
//              browser composites -> a text field over the canvas (a phone
//              brings up its keyboard) -> POST to the dev server's
//              playtest-report -> ("playtest", "saved DIR" | "failed WHY" |
//              "cancel"). With playtest on, two small buttons (i, report)
//              stand in for F1 and F2 on a phone.
//   gamepad    the browser's Gamepad API, read each animation frame and sent
//              as ("pad", "1,LX,LY,RX,RY,LT,RT,BITS") or ("pad", "0") on change
//              ((substratic input pad) reads it).
//   fullscreen a small corner button where the Fullscreen API exists.
//
// Configure with window.SUBSTRATIC before this script loads; the defaults
// are below.
(function () {
  "use strict";
  var cfg = Object.assign({
    canvas: "#stage",
    sticks: [{ name: "move", zone: "left" }, { name: "look", zone: "right" }],
    stickRadius: 60,
    buttons: [],                     // [{ label: "A", key: " " }, ...]
    playtest: "param",               // true, false, or "param" (on with ?playtest)
    reportUrl: "playtest-report",
    versionUrl: "version.json",      // null: no update check
    fullscreen: true,
    gamepad: true,                   // the browser's Gamepad API, as ("pad", ...)
    focus: true                      // ("blur") and ("visibility", ...) on focus changes
  }, window.SUBSTRATIC || {});

  var params = new URLSearchParams(location.search);
  var playtestOn = cfg.playtest === true || (cfg.playtest === "param" && params.has("playtest"));
  var CAPTURE = "substratic: playtest capture ";
  var app = null;
  var pending = [];                  // dispatches made before the app is ready

  function send(type, payload) {
    if (!app) { pending.push([type, payload]); return 0; }
    return app.dispatch(type, payload);
  }
  function withApp(fn) {
    if (globalThis.SigilWebApp && globalThis.SigilWebApp.started) { fn(globalThis.SigilWebApp); return; }
    document.addEventListener("sigil-web-app-ready", function (e) { fn(e.detail); }, { once: true });
  }
  function canvasEl() { return document.querySelector(cfg.canvas); }

  // ---- styles ---------------------------------------------------------------
  var css = document.createElement("style");
  css.textContent =
    ".sub-ring,.sub-knob{position:fixed;border-radius:50%;pointer-events:none;box-sizing:border-box;display:none;z-index:2}" +
    ".sub-ring{border:2px solid rgba(220,235,255,.35);background:rgba(220,235,255,.05)}" +
    ".sub-knob{background:rgba(220,235,255,.4)}" +
    ".sub-btn{position:fixed;z-index:3;min-width:44px;height:44px;border-radius:22px;border:2px solid rgba(220,235,255,.35);" +
    "background:rgba(10,12,20,.55);color:rgba(220,235,255,.85);font:bold 16px ui-monospace,monospace;touch-action:none;" +
    "-webkit-user-select:none;user-select:none;padding:0 10px}" +
    ".sub-btn.down{background:rgba(220,235,255,.3)}" +
    ".sub-touch-only{display:none}body.sub-touch .sub-touch-only{display:block}" +
    "#sub-note{position:fixed;left:50%;bottom:12%;transform:translateX(-50%);z-index:5;width:min(90vw,640px);display:none;" +
    "background:rgba(0,0,0,.85);border:1px solid rgba(255,230,140,.6);border-radius:8px;padding:10px;font:14px ui-monospace,monospace;color:#ffe68c}" +
    "#sub-note input{width:100%;box-sizing:border-box;font:16px ui-monospace,monospace;padding:6px;margin:6px 0;background:#111;color:#fff;border:1px solid #666}" +
    "#sub-note button{font:14px ui-monospace,monospace;margin-right:8px;padding:4px 10px}" +
    "#sub-note img{max-width:100%;max-height:30vh;display:block;margin-bottom:6px;image-rendering:pixelated}" +
    "#sub-fs{position:fixed;right:10px;top:10px;z-index:3;width:36px;height:36px;border-radius:6px;border:1px solid rgba(220,235,255,.35);" +
    "background:rgba(10,12,20,.45);color:rgba(220,235,255,.8);padding:0;display:flex;align-items:center;justify-content:center;opacity:.6}";
  document.head.appendChild(css);

  // ---- params: all of them, in order -------------------------------------------
  var query = location.search.replace(/^\?/, "");
  function decode(s) { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (err) { return s; } }
  send("params", query);
  query.split("&").forEach(function (part) {
    if (!part) return;
    var eq = part.indexOf("=");
    send("param", eq < 0 ? decode(part) : decode(part.slice(0, eq)) + "=" + decode(part.slice(eq + 1)));
  });
  if (params.has("touch")) document.body.classList.add("sub-touch");

  // ---- focus ------------------------------------------------------------------
  // Off (focus: false) for a page that sends its own focus events.
  if (cfg.focus) {
    window.addEventListener("blur", function () { send("blur", ""); releaseSticks(); });
    document.addEventListener("visibilitychange", function () {
      send("visibility", document.visibilityState);
      if (document.visibilityState === "hidden") { send("blur", ""); releaseSticks(); }
    });
  }

  // ---- sticks -------------------------------------------------------------------
  var R = cfg.stickRadius;
  var sticks = cfg.sticks.map(function (s) {
    var ring = document.createElement("div"); ring.className = "sub-ring";
    var knob = document.createElement("div"); knob.className = "sub-knob";
    ring.style.width = ring.style.height = (2 * R) + "px";
    ring.style.margin = (-R) + "px 0 0 " + (-R) + "px";
    var k = Math.round(R * 0.8);
    knob.style.width = knob.style.height = k + "px";
    knob.style.margin = (-k / 2) + "px 0 0 " + (-k / 2) + "px";
    document.body.appendChild(ring); document.body.appendChild(knob);
    return { name: s.name, zone: s.zone, ring: ring, knob: knob, touch: null };
  });
  function inZone(s, x) {
    var half = window.innerWidth / 2;
    return s.zone === "left" ? x < half : s.zone === "right" ? x >= half : true;
  }
  function show(s) {
    var t = s.touch;
    s.ring.style.display = s.knob.style.display = t ? "block" : "none";
    if (!t) return;
    s.ring.style.left = t.x + "px"; s.ring.style.top = t.y + "px";
    s.knob.style.left = (t.x + t.dx * R) + "px"; s.knob.style.top = (t.y + t.dy * R) + "px";
  }
  function sendStick(s) {
    var t = s.touch;
    send("stick", s.name + "," + (t ? t.dx.toFixed(3) + "," + t.dy.toFixed(3) : "0,0"));
  }
  function releaseSticks() {
    sticks.forEach(function (s) { if (s.touch) { s.touch = null; show(s); sendStick(s); } });
  }
  function onTouchStart(e) {
    document.body.classList.add("sub-touch");
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      for (var j = 0; j < sticks.length; j++) {
        var s = sticks[j];
        if (!s.touch && inZone(s, t.clientX)) {
          s.touch = { id: t.identifier, x: t.clientX, y: t.clientY, dx: 0, dy: 0 };
          show(s); sendStick(s); break;
        }
      }
    }
    // the loader turns a single-touch drag anywhere into an arrow-key pulse
    // (its swipe detector listens on the document): the sticks' touches
    // must never reach it
    e.preventDefault(); e.stopPropagation();
  }
  function onTouchMove(e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      sticks.forEach(function (s) {
        if (!s.touch || s.touch.id !== t.identifier) return;
        var dx = (t.clientX - s.touch.x) / R, dy = (t.clientY - s.touch.y) / R, m = Math.hypot(dx, dy);
        if (m > 1) { dx /= m; dy /= m; }
        s.touch.dx = dx; s.touch.dy = dy; show(s); sendStick(s);
      });
    }
    e.preventDefault(); e.stopPropagation();
  }
  function onTouchEnd(e) {
    e.stopPropagation();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      sticks.forEach(function (s) {
        if (s.touch && s.touch.id === t.identifier) { s.touch = null; show(s); sendStick(s); }
      });
    }
  }

  // ---- buttons (keys) ----------------------------------------------------------
  function button(label, style, onDown, onUp, touchOnly) {
    var b = document.createElement("button");
    b.className = "sub-btn" + (touchOnly ? " sub-touch-only" : "");
    b.textContent = label;
    Object.assign(b.style, style);
    function down(e) { e.preventDefault(); e.stopPropagation(); b.classList.add("down"); onDown(); }
    function up(e) { e.preventDefault(); e.stopPropagation(); if (b.classList.contains("down")) { b.classList.remove("down"); if (onUp) onUp(); } }
    b.addEventListener("pointerdown", down);
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("pointerleave", up);
    ["touchstart", "touchmove", "touchend"].forEach(function (n) {
      b.addEventListener(n, function (e) { e.stopPropagation(); }, { passive: true });
    });
    document.body.appendChild(b);
    return b;
  }
  cfg.buttons.forEach(function (bt, i) {
    button(bt.label, { right: "16px", bottom: (16 + i * 56) + "px" },
           function () { send("keydown", bt.key); }, function () { send("keyup", bt.key); }, true);
  });

  // ---- gamepad -------------------------------------------------------------------
  // The browser's Gamepad API, read once per animation frame, sent as
  // ("pad", "0") or ("pad", "1,LX,LY,RX,RY,LT,RT,BITS") only when it changes.
  // BITS is (substratic input pad)'s button order, GLFW's:
  //   a b x y lb rb back start guide lthumb rthumb up right down left
  // mapped from the browser's standard layout (its button index per bit).
  var STD_FOR_BIT = [0, 1, 2, 3, 4, 5, 8, 9, 16, 10, 11, 12, 15, 13, 14];
  var lastPad = null;
  function q(v) { return (Math.round(v * 100) / 100).toString(); }
  function padPayload() {
    var pads;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; }
    catch (err) { return "0"; }           // e.g. a cross-origin frame without allow="gamepad"
    for (var i = 0; i < pads.length; i++) {
      var p = pads[i];
      // only the standard layout: its button and axis indices are the ones
      // mapped here (natively, only pads GLFW has a mapping for count too)
      if (!p || !p.connected || p.mapping !== "standard") continue;
      var btn = function (k) { var b = p.buttons[k]; return b ? b : { pressed: false, value: 0 }; };
      var bits = 0;
      for (var bit = 0; bit < STD_FOR_BIT.length; bit++) if (btn(STD_FOR_BIT[bit]).pressed) bits |= 1 << bit;
      var ax = function (k) { return p.axes[k] || 0; };
      return ["1", q(ax(0)), q(ax(1)), q(ax(2)), q(ax(3)),
              q(btn(6).value * 2 - 1), q(btn(7).value * 2 - 1), String(bits)].join(",");
    }
    return "0";
  }
  function pollPad() {
    requestAnimationFrame(pollPad);        // first: nothing below can stop the loop
    var s = padPayload();
    if (s !== lastPad) { lastPad = s; send("pad", s); }
  }

  // ---- fullscreen -------------------------------------------------------------------
  // The icon is inline SVG in the button's text colour, not a font glyph: a
  // symbol such as U+26F6 exists only in some fonts, and without one the
  // button shows a missing-glyph box. Four corners point out to enter
  // fullscreen and in to leave it.
  var FS_ENTER = "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5";
  var FS_EXIT = "M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5";
  function fsIcon(d) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "20"); svg.setAttribute("height", "20");
    svg.setAttribute("aria-hidden", "true");
    var p = document.createElementNS(ns, "path");
    p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2"); p.setAttribute("stroke-linecap", "square");
    svg.appendChild(p);
    return svg;
  }
  if (cfg.fullscreen && document.documentElement.requestFullscreen) {
    var fs = document.createElement("button");
    fs.id = "sub-fs";
    var fsShow = function () {
      var on = !!document.fullscreenElement;
      fs.replaceChildren(fsIcon(on ? FS_EXIT : FS_ENTER));
      fs.title = on ? "Leave fullscreen" : "Fullscreen";
      fs.setAttribute("aria-label", fs.title);
    };
    fsShow();
    document.addEventListener("fullscreenchange", fsShow);
    fs.addEventListener("click", function () {
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(function () {});
    });
    document.body.appendChild(fs);
  }

  // ---- playtest --------------------------------------------------------------------------
  // One capture at a time. Each has its own object; an answer from the server
  // acts only if its capture is still the open one, so a late reply to a
  // cancelled report cannot close or end the next.
  var note = null, noteInput = null, noteImg = null, capture = null;
  function buildNote() {
    note = document.createElement("div"); note.id = "sub-note";
    note.innerHTML = '<div>Report: what went wrong here?</div><img alt=""><input type="text" maxlength="200" autocomplete="off" placeholder="one line">' +
                     '<div><button data-a="save">Save</button><button data-a="cancel">Cancel</button><span></span></div>';
    document.body.appendChild(note);
    noteInput = note.querySelector("input");
    noteImg = note.querySelector("img");
    // the note's keys are the note's: they never reach the loader's listener
    ["keydown", "keyup", "keypress"].forEach(function (n) {
      note.addEventListener(n, function (e) {
        e.stopPropagation();
        if (n !== "keydown" || e.isComposing) return;     // an IME's Enter ends the word, not the note
        if (e.key === "Enter") { e.preventDefault(); submit(); }
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
      });
    });
    ["pointerdown", "touchstart", "touchmove", "touchend"].forEach(function (n) {
      note.addEventListener(n, function (e) { e.stopPropagation(); }, { passive: true });
    });
    note.querySelector('[data-a="save"]').addEventListener("click", submit);
    note.querySelector('[data-a="cancel"]').addEventListener("click", cancel);
  }
  function status(text) { note.querySelector("span").textContent = text; }
  function openNote(reportText) {
    if (capture) return;                                   // one at a time
    var png = null;
    try { png = canvasEl().toDataURL("image/png"); } catch (err) { console.log("substratic: playtest screenshot failed " + err.message); }
    capture = { report: reportText, png: png, sending: null };
    if (!note) buildNote();
    noteImg.src = png || "";
    noteImg.style.display = png ? "block" : "none";
    noteInput.value = "";
    status("");
    note.style.display = "block";
    noteInput.focus();
    send("playtest", "opened");
  }
  function closeNote() { note.style.display = "none"; capture = null; var c = canvasEl(); if (c && c.focus) c.focus(); }
  // While a report is being sent, Cancel and Escape wait for the answer: the
  // server may already have written it, and "discarded" must not be said of
  // a report on disk. A send that fails (or takes over SEND-TIMEOUT) leaves
  // the note open with its text, so Enter tries again and Escape discards,
  // as on the desktop.
  var SEND_TIMEOUT = 15000;
  function cancel() {
    if (!capture) return;
    if (capture.sending) { status("saving... (wait for the answer)"); return; }
    closeNote(); send("playtest", "cancel");
  }
  function submit() {
    if (!capture || capture.sending) return;               // Enter twice is one report
    var mine = capture;
    var report;
    try { report = JSON.parse(mine.report); } catch (err) { report = { unparsed: mine.report }; }
    report.note = noteInput.value;
    report.screenshot = mine.png ? "screenshot.png" : null;
    var meta = document.querySelector('meta[name="substratic-version"]');
    report.page = { url: location.href, build: meta ? meta.content : null, userAgent: navigator.userAgent, dpr: window.devicePixelRatio || 1,
                    width: window.innerWidth, height: window.innerHeight };
    status("saving...");
    var ctl = new AbortController();
    mine.sending = ctl;
    var timer = setTimeout(function () { ctl.abort(); }, SEND_TIMEOUT);
    var body = JSON.stringify({ report: report, png: mine.png });
    fetch(cfg.reportUrl, { method: "POST", headers: { "content-type": "application/json" }, body: body, signal: ctl.signal })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: { error: "HTTP " + r.status } }; }); })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok || !res.j.dir) throw new Error((res.j && res.j.error) || "the server said no");
        if (capture !== mine) return;
        closeNote(); send("playtest", "saved " + res.j.dir);
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (capture !== mine) return;
        mine.sending = null;
        var why = err.name === "AbortError" ? "no answer in " + (SEND_TIMEOUT / 1000) + " s" : (err.message || String(err));
        status("NOT saved: " + why + ". Enter tries again, Esc discards.");
        console.log("substratic: playtest not saved " + why);
      });
  }
  if (playtestOn) {
    send("param", "playtest-page");  // the page can take reports
    button("i", { left: "10px", top: "10px" }, function () { send("playtest", "readout"); }, null, true);
    button("report", { left: "64px", top: "10px" }, function () { send("playtest", "capture"); }, null, true);
    // F1 is the browser's help: keep it for the game
    document.addEventListener("keydown", function (e) { if (e.key === "F1" || e.key === "F2") e.preventDefault(); }, true);
  }
  var log = console.log;
  console.log = function () {
    var line = String(arguments[0] || "");
    if (line.indexOf(CAPTURE) === 0) {
      var text = line.slice(CAPTURE.length);
      // the same task as the frame that printed it: the canvas still holds it
      queueMicrotask(function () { openNote(text); });
    }
    return log.apply(console, arguments);
  };

  // ---- the app --------------------------------------------------------------------------
  withApp(function (a) {
    app = a;
    var c = canvasEl();
    if (c && sticks.length) {           // no sticks, no touch handling: the page's own controls keep theirs
      c.addEventListener("touchstart", onTouchStart, { passive: false });
      c.addEventListener("touchmove", onTouchMove, { passive: false });
      c.addEventListener("touchend", onTouchEnd);
      c.addEventListener("touchcancel", onTouchEnd);
    }
    pending.forEach(function (p) { app.dispatch(p[0], p[1]); });
    pending = [];
    if (cfg.gamepad && navigator.getGamepads) requestAnimationFrame(pollPad);
    if (cfg.versionUrl) {
      fetch(cfg.versionUrl, { cache: "no-store" })
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (t) { if (t) send("update-info", t); })
        .catch(function () { /* best-effort: no file, no line */ });
    }
  });

  window.SubstraticPage = {
    send: send,
    updateWaiting: function () { send("update", "waiting"); }
  };
})();
