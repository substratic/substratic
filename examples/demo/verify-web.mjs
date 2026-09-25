#!/usr/bin/env node
// verify-web.mjs [BUILD-DIR] - drive the demo's web build in headless Chrome
// and check what the engine does in a browser:
//
//   selftest   the engine's checks pass in the wasm (?selftest)
//   params     every URL parameter reaches the game, including ones nobody
//              listed anywhere (?trace-color=7, a bare ?playtest)
//   update     version.json is fetched and the "new in" line comes up for a
//              player who last saw an older version (?seen=0.0.9)
//   stick      a touch on the left half pops the ring up under the thumb,
//              and dragging it moves the player (the report's position)
//   report     F2 -> the note field over the canvas, focused -> typed note,
//              Enter -> tools/serve.mjs writes report.json and a PNG the size
//              of the canvas, not blank -> the game hears "saved"
//   keys       the note's typing never reached the game as keys
//   console    no uncaught error
//
// Serves BUILD-DIR (default build/web) with ../../tools/serve.mjs on
// 127.0.0.1, reports to a fresh directory under /tmp. Chrome over the
// DevTools protocol with Node's own WebSocket; no npm packages. Prints one
// PASS/FAIL per check, then GREEN / RED (exit 1), or SETUP-FAILED (exit 2).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(process.argv[2] || path.join(here, "build/web"));
const PORT = Number(process.env.PORT || 8195);
const CDP_PORT = Number(process.env.CDP_PORT || 9335);
const CHROME = process.env.CHROME || "google-chrome";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "substratic-verify-web-"));
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

// ---- the server ----------------------------------------------------------------
const server = spawn("node", [path.join(here, "../../tools/serve.mjs"), buildDir, String(PORT), "--reports", reports],
                     { detached: true, stdio: ["ignore", "pipe", "pipe"] });
procs.push(server);
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
for (let i = 0; !serverLog.includes("serving"); i++) { if (i > 50) setupFailed(`server: ${serverLog}`); await sleep(100); }

// ---- Chrome and the protocol --------------------------------------------------------
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(work, "chrome")}`,
                              "--no-first-run", "--no-default-browser-check", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                              "--window-size=1280,720", "--mute-audio", "about:blank"],
                     { detached: true, stdio: ["ignore", "ignore", "pipe"] });
procs.push(chrome);
let target = null;
for (let i = 0; i < 100 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
  } catch { /* not up yet */ }
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
    // the loader reports a handler's failure with console.error, not a throw
    if (m.params.type === "error") errors.push(`console.error: ${text}`);
  }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
function cdp(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => waiting.set(id, res));
}
async function evaluate(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true });
  return r.result?.result?.value;
}
async function waitLine(pred, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const l = lines.find(pred); if (l) return l; await sleep(100); }
  return null;
}
async function key(k, code, vk) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
}

await cdp("Runtime.enable");
await cdp("Page.enable");
await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
const url = `http://127.0.0.1:${PORT}/?selftest&playtest&seen=0.0.9&trace-color=7&a%20b=c%26d&trace-keys`;
await cdp("Page.navigate", { url });

// ---- selftest and params ----------------------------------------------------------------
const ready = await waitLine((l) => l.startsWith("substratic-demo: ready"), 60000);
if (!ready) { console.log(lines.slice(-20).join("\n")); setupFailed("the game never said ready"); }
const done = await waitLine((l) => l.startsWith("selftest: DONE"), 30000);
if (done === "selftest: DONE platform=web pass=15 fail=0 of=15") pass("selftest (15 of 15 in wasm)");
else fail("selftest", `${done} ${lines.filter((l) => l.startsWith("selftest: FAIL")).join("; ")}`);

for (const p of ["selftest", "playtest", "seen=0.0.9", "trace-color=7", "a b=c&d"]) {
  if (lines.includes(`substratic-demo: param ${p}`)) pass(`param ${p}`); else fail("params", `no "param ${p}"`);
}

const upd = await waitLine((l) => l.startsWith("substratic-demo: update "), 10000);
if (upd === "substratic-demo: update new-in New in 0.1.0: The first demo: six rooms, six gems, and F2.") pass("update line (new in)");
else fail("update", String(upd));

// ---- the loader's key dispatches, watched below the game --------------------------
// A spy on the app's dispatch records every keydown the loader delivers,
// before any game-side guard can hide it: the stick drag must add no arrow
// key (the loader's swipe detector would), q pressed outside the note must
// show up (the positive control), and the note's typing must not.
await evaluate(`(() => { const a = globalThis.SigilWebApp; window.__keys = []; const d = a.dispatch.bind(a);
  a.dispatch = function (t, p) { if (t === "keydown") window.__keys.push(p); return d(t, p); }; return true; })()`);

// ---- a touch stick ---------------------------------------------------------------------
const box = await evaluate("(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return [r.width, r.height]; })()");
const [W, H] = box;
const x0 = Math.round(W * 0.2), y0 = Math.round(H * 0.6);
await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0, id: 1 }] });
await sleep(100);
const ringAt = await evaluate("(() => { const r = document.querySelector('.sub-ring'); return [r.style.display, r.style.left, r.style.top]; })()");
if (ringAt[0] === "block" && ringAt[1] === `${x0}px` && ringAt[2] === `${y0}px`) pass("stick pops up under the thumb");
else fail("stick", `ring ${JSON.stringify(ringAt)} for a touch at ${x0},${y0}`);
for (let dx = 10; dx <= 60; dx += 10) {
  await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + dx, y: y0, id: 1 }] });
  await sleep(50);
}
await sleep(1500);
await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await sleep(300);
const swiped = (await evaluate("window.__keys")).filter((k) => k.startsWith("Arrow"));
if (swiped.length === 0) pass("the stick drag sent no arrow key"); else fail("stick", `the drag also sent ${swiped.join(", ")} (the loader's swipe)`);

await key("q", "KeyQ", 81);
await sleep(200);
if ((await evaluate("window.__keys")).includes("q")) pass("a key outside the note reaches the loader's dispatch (the spy works)");
else fail("keys", "the positive control: q never reached the dispatch, so the note's leak check below would prove nothing");

// ---- F2, a note, Enter -------------------------------------------------------------------
await key("F2", "F2", 113);
const cap = await waitLine((l) => l.startsWith("substratic: playtest capture "), 10000);
if (!cap) fail("report", "no capture line");
await sleep(300);
const noteOpen = await evaluate("(() => { const n = document.getElementById('sub-note'); return !!n && n.style.display === 'block' && document.activeElement === n.querySelector('input'); })()");
if (noteOpen) pass("the note field is open and focused"); else fail("report", "the note field is not open and focused");
const keysBefore = (await evaluate("window.__keys")).length;
// typed key by key (insertText fires no keydown, and the leak check needs them)
for (const c of "web: the gem is stuck") {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: c, text: c, unmodifiedText: c });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: c });
}
await key("Enter", "Enter", 13);
const saved = await waitLine((l) => l.startsWith("substratic: playtest report "), 10000);
if (saved) pass(`the game heard "saved" (${saved.slice(28)})`); else fail("report", `the game never heard saved; server: ${serverLog.trim().split("\n").pop()}`);

const dirs = fs.existsSync(reports) ? fs.readdirSync(reports) : [];
if (dirs.length !== 1) fail("report", `${dirs.length} report directories`);
else {
  const d = path.join(reports, dirs[0]);
  const r = JSON.parse(fs.readFileSync(path.join(d, "report.json"), "utf8"));
  if (r.note === "web: the gem is stuck") pass("report note"); else fail("report note", JSON.stringify(r.note));
  if (r.platform === "web" && r.location && r.location.room) pass(`report location (${r.location.room})`); else fail("report location", JSON.stringify(r.location));
  // x across rooms (each 320 wide; the player starts at 160 in x0y0): the
  // stick may carry the player through a doorway. An arrow-key pulse alone
  // (the loader's swipe, blocked now) would give about 10 px, well short of 200.
  const m = r.location && r.location.room && /^x(\d+)y\d+$/.exec(r.location.room);
  const x = m && r.location.position && Number(m[1]) * 320 + r.location.position[0];
  if (typeof x === "number" && x > 200) pass(`the stick moved the player (x ${x.toFixed(1)} across rooms)`); else fail("stick", `room ${r.location && r.location.room} position ${JSON.stringify(r.location && r.location.position)}`);
  if (r.page && r.page.build && r.page.build !== "__VERSION__") pass(`report build ${r.page.build}`); else fail("report build", JSON.stringify(r.page));
  const png = fs.readFileSync(path.join(d, "screenshot.png"));
  const canvas = await evaluate("[document.querySelector('#stage').width, document.querySelector('#stage').height]");
  const info = pngInfo(png);
  if (info.w === canvas[0] && info.h === canvas[1]) pass(`screenshot ${info.w}x${info.h}, the canvas's size`); else fail("screenshot", `${info.w}x${info.h} against canvas ${canvas}`);
  if (info.lit > 0.2) pass(`screenshot not blank (${(info.lit * 100).toFixed(0)}% of pixels lit)`); else fail("screenshot", `only ${(info.lit * 100).toFixed(1)}% of pixels lit`);
}
const leaked = (await evaluate("window.__keys")).slice(keysBefore);
if (leaked.length === 0) pass("the note's typing never reached the game"); else fail("keys", leaked.join("; "));
if (errors.length === 0) pass("no uncaught error"); else fail("console", errors.slice(0, 3).join(" | "));

say(`artifacts in ${work}`);
if (fails === 0) { say("GREEN"); process.exit(0); } else { say(`RED (${fails})`); process.exit(1); }

// A PNG's size, and the share of pixels not black, decoded here (zlib and
// the PNG filters) so the check does not trust the encoder that wrote it.
function pngInfo(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return { w: 0, h: 0, lit: 0 };
  let off = 8, w = 0, h = 0, bpp = 4, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
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
