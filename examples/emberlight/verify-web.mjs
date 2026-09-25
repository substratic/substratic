#!/usr/bin/env node
// verify-web.mjs [BUILD-DIR] - drive Emberlight's web build in headless
// Chrome and check what the engine does in a browser:
//
//   page       the icons are served; every URL parameter reaches the game
//   update     version.json is fetched and the "new" line comes up for a
//              player who last saw an older version (?seen=0.0.9)
//   gamepad    a scripted gamepad (navigator.getGamepads replaced before the
//              page loads): A starts round 1, the left stick moves the moth
//   stick      a touch drag moves the moth back, and sends no arrow key (the
//              loader's swipe detector must never see the stick's touches)
//   report     F2 opens the note over the canvas, focused; typed key by key
//              and Enter, tools/serve.mjs writes report.json (note, phase,
//              the moth) and a PNG the size of the canvas, not blank; the
//              game hears "saved"; no typed key reached the game
//   store      P stores the palette in localStorage under emberlight:
//   console    no uncaught error, no console.error
//
// Chrome over the DevTools protocol with Node's own WebSocket; the server is
// ../../tools/serve.mjs on 127.0.0.1. One PASS/FAIL per check, then GREEN /
// RED (exit 1), or SETUP-FAILED (exit 2).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(process.argv[2] || path.join(here, "build/web"));
const PORT = Number(process.env.PORT || 8205);
const CDP_PORT = Number(process.env.CDP_PORT || 9345);
const CHROME = process.env.CHROME || "google-chrome";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "emberlight-verify-web-"));
const reports = path.join(work, "reports");
let fails = 0;
const say = (s) => console.log(`verify-web: ${s}`);
const pass = (name) => say(`PASS ${name}`);
const fail = (name, why) => { say(`FAIL ${name} (${why})`); fails++; };
const procs = [];
function cleanup() { for (const p of procs) { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } } }
function setupFailed(why) { say(`SETUP-FAILED ${why}`); cleanup(); process.exit(2); }
process.on("exit", cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(buildDir, "index.html"))) setupFailed(`no ${buildDir}/index.html`);

const server = spawn("node", [path.join(here, "../../tools/serve.mjs"), buildDir, String(PORT), "--reports", reports],
                     { detached: true, stdio: ["ignore", "pipe", "pipe"] });
procs.push(server);
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
for (let i = 0; !serverLog.includes("serving"); i++) { if (i > 50) setupFailed(`server: ${serverLog}`); await sleep(100); }

const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(work, "chrome")}`,
                              "--no-first-run", "--no-default-browser-check", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                              "--window-size=1280,720", "--mute-audio", "about:blank"],
                     { detached: true, stdio: ["ignore", "ignore", "pipe"] });
procs.push(chrome);
let target = null;
for (let i = 0; i < 100 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === "page"); } catch { /* not up yet */ }
  if (!target) await sleep(200);
}
if (!target) setupFailed("no Chrome page target");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const waiting = new Map();
const lines = [];
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled") {
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    lines.push(text);
    if (m.params.type === "error") errors.push(`console.error: ${text}`);
  }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
function cdp(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => waiting.set(id, res));
}
async function evaluate(expr) { return (await cdp("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value; }
async function waitLine(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const l = lines.find(pred); if (l) return l; await sleep(100); }
  return null;
}
async function key(k, code, vk) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
}
// The scripted gamepad: set window.__pad = { axes: [...4], pressed: [indices] }.
const FAKE_PAD = `
  window.__pad = null;
  navigator.getGamepads = function () {
    const p = window.__pad;
    if (!p) return [null];
    const buttons = [];
    for (let i = 0; i < 17; i++) { const on = p.pressed.indexOf(i) >= 0; buttons.push({ pressed: on, value: on ? 1 : 0 }); }
    return [{ connected: true, mapping: "standard", axes: p.axes, buttons: buttons }];
  };`;
async function pad(axes, pressed) { await evaluate(`window.__pad = { axes: ${JSON.stringify(axes)}, pressed: ${JSON.stringify(pressed)} }; true`); }

// A report: F2, the note typed key by key, Enter; answers the report's JSON.
async function report(note) {
  const n0 = lines.filter((l) => l.startsWith("substratic: playtest report ")).length;
  await key("F2", "F2", 113);
  if (!(await waitLine((l) => l.startsWith("substratic: playtest capture "), 5000))) return null;
  await sleep(300);
  const open = await evaluate("(() => { const n = document.getElementById('sub-note'); return !!n && n.style.display === 'block' && document.activeElement === n.querySelector('input'); })()");
  if (!open) return null;
  for (const c of note) {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: c, text: c, unmodifiedText: c });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: c });
  }
  await key("Enter", "Enter", 13);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const got = lines.filter((l) => l.startsWith("substratic: playtest report "));
    if (got.length > n0) {
      const dir = path.join(reports, path.basename(got[got.length - 1].slice(28)));
      return { dir, json: JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")) };
    }
    await sleep(100);
  }
  return null;
}
const mothX = (r) => r && r.json.location && r.json.location.moth && r.json.location.moth[0];

await cdp("Runtime.enable");
await cdp("Page.enable");
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_PAD });
await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await cdp("Page.navigate", { url: `http://127.0.0.1:${PORT}/?playtest&seen=0.0.9&trace-color=7&trace-keys` });

if (!(await waitLine((l) => l === "emberlight: ready", 60000))) { console.log(lines.slice(-20).join("\n")); setupFailed("the game never said ready"); }

// ---- the page ----------------------------------------------------------------------
for (const icon of ["assets/icons/favicon.ico", "assets/icons/substratic-icon-192.png"]) {
  const r = await fetch(`http://127.0.0.1:${PORT}/${icon}`);
  if (r.ok) pass(`icon ${icon}`); else fail("icons", `${icon} ${r.status}`);
}
for (const p of ["playtest", "seen=0.0.9", "trace-color=7", "trace-keys"]) {
  if (lines.includes(`emberlight: param ${p}`)) pass(`param ${p}`); else fail("params", `no "param ${p}"`);
}
const upd = await waitLine((l) => l.startsWith("emberlight: update "), 10000);
if (upd === "emberlight: update new-in new: The first Emberlight: one room, one moth, sixty seconds.") pass("update line (new)");
else fail("update", String(upd));

// ---- the loader's key dispatches, watched below the game ------------------------------
await evaluate(`(() => { const a = globalThis.SigilWebApp; window.__keys = []; const d = a.dispatch.bind(a);
  a.dispatch = function (t, p) { if (t === "keydown") window.__keys.push(p); return d(t, p); }; return true; })()`);

// ---- the gamepad ---------------------------------------------------------------------------
await pad([0, 0, 0, 0], [0]);                    // A held
await sleep(300);
await pad([0, 0, 0, 0], []);
if (await waitLine((l) => l === "emberlight: round 1", 3000)) pass("gamepad A started round 1");
else fail("gamepad", "A did not start a round");
const r1 = await report("pad");
if (r1) pass(`report (note ${JSON.stringify(r1.json.note)}, phase ${r1.json.location.phase})`); else fail("report", "the first report never arrived");
await pad([1, 0, 0, 0], []);                     // the left stick hard right
await sleep(1200);
await pad([0, 0, 0, 0], []);
await sleep(600);
const r2 = await report("stick right");
if (r1 && r2 && mothX(r2) > mothX(r1) + 10) pass(`gamepad stick moved the moth (x ${mothX(r1)} -> ${mothX(r2)})`);
else fail("gamepad", `x ${mothX(r1)} -> ${mothX(r2)}`);

// ---- the touch stick -------------------------------------------------------------------------
const [W, H] = await evaluate("(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return [r.width, r.height]; })()");
const x0 = Math.round(W * 0.6), y0 = Math.round(H * 0.6);
const k0 = (await evaluate("window.__keys")).length;
await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0, id: 1 }] });
for (let dx = 10; dx <= 60; dx += 10) { await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 - dx, y: y0, id: 1 }] }); await sleep(50); }
await sleep(1200);
await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await sleep(600);
const swiped = (await evaluate("window.__keys")).slice(k0).filter((k) => k.startsWith("Arrow"));
if (swiped.length === 0) pass("the stick drag sent no arrow key"); else fail("stick", `the drag also sent ${swiped.join(", ")}`);
const r3 = await report("stick left");
if (r2 && r3 && mothX(r3) < mothX(r2) - 10) pass(`touch stick moved the moth (x ${mothX(r2)} -> ${mothX(r3)})`);
else fail("stick", `x ${mothX(r2)} -> ${mothX(r3)}`);

// ---- the report's files; the note's keys ---------------------------------------------------
if (r1) {
  if (r1.json.note === "pad") pass("report note"); else fail("report note", JSON.stringify(r1.json.note));
  const png = fs.readFileSync(path.join(r1.dir, "screenshot.png"));
  const canvas = await evaluate("[document.querySelector('#stage').width, document.querySelector('#stage').height]");
  const info = pngInfo(png);
  if (info.w === canvas[0] && info.h === canvas[1]) pass(`screenshot ${info.w}x${info.h}, the canvas's size`); else fail("screenshot", `${info.w}x${info.h} against ${canvas}`);
  if (info.lit > 0.01) pass(`screenshot not blank (${(info.lit * 100).toFixed(1)}% lit)`); else fail("screenshot", `${(info.lit * 100).toFixed(2)}% lit`);
}
// keys the game received since the spy: F2 (a key outside the note, the
// positive control), and nothing of the three notes typed
const got = await evaluate("window.__keys");
if (got.includes("F2")) pass("a key outside the note reaches the loader's dispatch (the spy works)");
else fail("keys", "the positive control: F2 never reached the dispatch");
const leaked = got.filter((k) => k.length === 1);
if (leaked.length === 0) pass("the notes' typing never reached the game"); else fail("keys", leaked.join(""));

// ---- the store --------------------------------------------------------------------------------
await key("p", "KeyP", 80);
await sleep(500);
const stored = await evaluate("localStorage.getItem('emberlight:palette')");
if (stored === "moon") pass("store (P stored emberlight:palette = moon)"); else fail("store", JSON.stringify(stored));

if (errors.length === 0) pass("no uncaught error, no console.error"); else fail("console", errors.slice(0, 3).join(" | "));
say(`artifacts in ${work}`);
if (fails === 0) { say("GREEN"); process.exit(0); } else { say(`RED (${fails})`); process.exit(1); }

function pngInfo(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return { w: 0, h: 0, lit: 0 };
  let off = 8, w = 0, h = 0, bpp = 4; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bpp = data[9] === 6 ? 4 : 3; }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  let lit = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i], a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      cur[i] = (x + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
    for (let i = 0; i < stride; i += bpp) if (cur[i] + cur[i + 1] + cur[i + 2] > 30) lit++;
    cur.copy(prev);
  }
  return { w, h, lit: lit / (w * h) };
}
