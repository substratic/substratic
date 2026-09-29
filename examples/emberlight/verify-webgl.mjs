#!/usr/bin/env node
// verify-webgl.mjs [BUILD-DIR] - substratic.js's WebGL 2 check, in headless
// Chrome against Emberlight's web build. A browser with no WebGL 2 used to
// get the loader's "Failed to start: sigil_wasm_start failed (rc -1)"; now:
//
//   off      Chrome with WebGL off (--disable-webgl): the message
//            (#sub-webgl, data-webgl "none") names get.webgl.org/webgl2 and
//            links it; the loader's tag is switched off; the loader never
//            runs; neither the wasm nor the bridges are requested; no
//            "Failed to start" on the page
//   webgl1   getContext("webgl2") null on every canvas, WebGL 1 still there:
//            the same, with data-webgl "webgl1" and its own reason
//   late     getContext("webgl2") null on #stage alone, so the page's probe
//            passes and the game fails to get its context: the message
//            (data-webgl "late") in place of the loader's raw error
//   text     WebGL off and window.SUBSTRATIC.webglText.title set: the
//            message carries the page's title
//   optout   WebGL off and window.SUBSTRATIC.webglCheck false: no message,
//            the loader runs and fetches the wasm (the old behaviour)
//   on       the positive control: the game says ready, no message, the
//            loader's tag untouched, SigilWebApp started
//
// The build must carry this checkout's substratic.js (the build copies it
// into assets/substratic/), or the check stops: SETUP-FAILED. Chrome over
// the DevTools protocol, one Chrome per case, silent (--mute-audio and
// PULSE_SINK=worker-null); the server is ../../tools/serve.mjs. One
// PASS/FAIL per check, then GREEN / RED (exit 1), or SETUP-FAILED (exit 2).
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(process.argv[2] || path.join(here, "build/web"));
const PORT = Number(process.env.PORT || 8206);
const CDP_PORT = Number(process.env.CDP_PORT || 9346);
const CHROME = process.env.CHROME || "google-chrome";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "emberlight-verify-webgl-"));
let fails = 0;
const say = (s) => console.log(`verify-webgl: ${s}`);
const pass = (name) => say(`PASS ${name}`);
const fail = (name, why) => { say(`FAIL ${name} (${why})`); fails++; };
const procs = [];
function kill(p) { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch { /* gone */ } } }
function cleanup() { for (const p of procs) kill(p); try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* scratch */ } }
function setupFailed(why) { say(`SETUP-FAILED ${why}`); cleanup(); process.exit(2); }
process.on("exit", cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

if (!fs.existsSync(path.join(buildDir, "index.html"))) setupFailed(`no ${buildDir}/index.html`);
const built = path.join(buildDir, "assets/substratic/substratic.js"), mine = path.join(here, "../../assets/substratic/substratic.js");
if (!fs.existsSync(built)) setupFailed(`no ${built}`);
if (sha(built) !== sha(mine)) setupFailed(`${built} is not this checkout's assets/substratic/substratic.js: rebuild`);
say(`substratic.js ${sha(mine).slice(0, 16)} (the build's is the same)`);

try {
  const sinks = execFileSync("pactl", ["list", "short", "sinks"], { encoding: "utf8" });
  if (!/\bworker-null\b/.test(sinks)) execFileSync("pactl", ["load-module", "module-null-sink", "sink_name=worker-null"]);
} catch { /* no pulse here */ }

const server = spawn("node", [path.join(here, "../../tools/serve.mjs"), buildDir, String(PORT)], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
procs.push(server);
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
for (let i = 0; !serverLog.includes("serving"); i++) { if (i > 50) setupFailed(`server: ${serverLog}`); await sleep(100); }

const NO_WEBGL2_EVERYWHERE = `(() => { const no = (k) => /^(webgl2|experimental-webgl2)$/.test(String(k));
  for (const C of [HTMLCanvasElement, self.OffscreenCanvas].filter(Boolean)) {
    const g = C.prototype.getContext;
    C.prototype.getContext = function (k, o) { return no(k) ? null : g.call(this, k, o); };
  } })();`;
const NO_WEBGL2_ON_STAGE = `(() => { const g = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (k, o) {
    return this.id === "stage" && /^(webgl2|experimental-webgl2)$/.test(String(k)) ? null : g.call(this, k, o); }; })();`;
// the page sets window.SUBSTRATIC itself: merge into whatever it sets
const withConfig = (extra) => `(() => { let v; Object.defineProperty(window, "SUBSTRATIC", { configurable: true,
  get() { return v; }, set(x) { v = Object.assign({}, x, ${JSON.stringify(extra)}); } }); })();`;

// one Chrome, one page load; answers what the page and the network showed
async function run(name, { webgl = true, init = [] }) {
  const flags = webgl ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] : ["--disable-webgl", "--disable-webgl2"];
  const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(work, "chrome-" + name)}`,
                                "--no-first-run", "--no-default-browser-check", "--window-size=1280,720", "--mute-audio", ...flags, "about:blank"],
                       { detached: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PULSE_SINK: "worker-null" } });
  procs.push(chrome);
  try {
    let target = null;
    for (let i = 0; i < 100 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === "page"); } catch { /* not up yet */ }
      if (!target) await sleep(200);
    }
    if (!target) setupFailed(`${name}: no Chrome page target`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let nextId = 1;
    const waiting = new Map(), lines = [], requests = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
      if (m.method === "Runtime.consoleAPICalled") lines.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      if (m.method === "Runtime.exceptionThrown") lines.push("exception: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
    };
    const cdp = (method, params = {}) => { const id = nextId++; ws.send(JSON.stringify({ id, method, params })); return new Promise((res) => waiting.set(id, res)); };
    const evaluate = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
    await cdp("Runtime.enable"); await cdp("Page.enable"); await cdp("Network.enable");
    await cdp("Network.setCacheDisabled", { cacheDisabled: true });
    for (const source of init) await cdp("Page.addScriptToEvaluateOnNewDocument", { source });
    await cdp("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if (lines.includes("emberlight: ready") || await evaluate("!!document.getElementById('sub-webgl')")) break;
      await sleep(100);
    }
    await sleep(2500);   // time for a late request, or a late "Failed to start"
    const st = await evaluate(`(() => {
      const box = document.getElementById("sub-webgl"), a = box && box.querySelector("a"), r = box && box.getBoundingClientRect();
      return { panel: box ? box.getAttribute("data-webgl") : null, text: box ? box.innerText : "", link: a ? a.href : "",
               visible: !!(r && r.width > 100 && r.height > 50 && getComputedStyle(box).display !== "none" && getComputedStyle(box).visibility !== "hidden"),
               loaderOff: document.querySelectorAll("script[data-substratic-off]").length,
               loader: !!globalThis.SigilWebApp, started: !!(globalThis.SigilWebApp && globalThis.SigilWebApp.started),
               level: globalThis.SubstraticPage ? globalThis.SubstraticPage.webgl : null,
               failed: /Failed to start|sigil_wasm_start failed/.test(document.body.innerText) };
    })()`);
    ws.close();
    if (!st) setupFailed(`${name}: could not read the page`);
    if (!requests.some((u) => u.startsWith(`http://127.0.0.1:${PORT}/`))) setupFailed(`${name}: the page was never requested`);
    return { ...st, lines, wasm: requests.filter((u) => /\.wasm(\?|$)/.test(u)).length, bridges: requests.filter((u) => /sigil-wasm-bridges\.js(\?|$)/.test(u)).length };
  } finally {
    kill(chrome);
    await sleep(500);
  }
}
const check = (name, cond, why) => (cond ? pass(name) : fail(name, why));

for (const [name, opts, level] of [["off", { webgl: false }, "none"], ["webgl1", { init: [NO_WEBGL2_EVERYWHERE] }, "webgl1"]]) {
  const s = await run(name, opts);
  check(`${name} message`, s.panel === level && s.visible, `panel ${JSON.stringify(s.panel)}, visible ${s.visible}`);
  check(`${name} level`, s.level === level, `SubstraticPage.webgl ${JSON.stringify(s.level)}`);
  check(`${name} text`, /needs WebGL 2/.test(s.text) && /get\.webgl\.org\/webgl2/.test(s.text) &&
        (level === "webgl1" ? /has WebGL, but not WebGL 2/ : /WebGL is turned off/).test(s.text), JSON.stringify(s.text.slice(0, 160)));
  check(`${name} link`, s.link === "https://get.webgl.org/webgl2/", s.link || "no link");
  check(`${name} no boot`, s.loaderOff === 1 && !s.loader && s.wasm === 0 && s.bridges === 0,
        `loader tags off ${s.loaderOff}, loader ran ${s.loader}, wasm ${s.wasm}, bridges ${s.bridges}`);
  check(`${name} no raw error`, !s.failed, "the raw error is on the page");
}
{
  const s = await run("late", { init: [NO_WEBGL2_ON_STAGE] });
  check("late message", s.panel === "late" && s.visible, `panel ${JSON.stringify(s.panel)}, visible ${s.visible}`);
  check("late booted first", s.wasm >= 1 && s.lines.some((l) => /no WebGL2 context/.test(l)), `wasm ${s.wasm}, "no WebGL2 context" said: ${s.lines.some((l) => /no WebGL2 context/.test(l))}`);
  check("late text", /couldn.t give the game a WebGL 2 context/.test(s.text), JSON.stringify(s.text.slice(0, 160)));
  check("late no raw error", !s.failed, "the raw error is left on the page");
}
{
  const s = await run("text", { webgl: false, init: [withConfig({ webglText: { title: "Emberlight needs WebGL 2." } })] });
  check("text title", s.panel === "none" && /^Emberlight needs WebGL 2\./.test(s.text), JSON.stringify(s.text.slice(0, 80)));
}
{
  const s = await run("optout", { webgl: false, init: [withConfig({ webglCheck: false })] });
  check("optout", s.panel === null && s.level === "off" && s.loaderOff === 0 && s.loader && s.wasm >= 1,
        `panel ${JSON.stringify(s.panel)}, level ${JSON.stringify(s.level)}, loader ran ${s.loader}, wasm ${s.wasm}`);
}
{
  const s = await run("on", {});
  check("on ready", s.lines.includes("emberlight: ready"), `no ready line; console: ${JSON.stringify(s.lines.slice(-8))}`);
  check("on no message", s.panel === null && s.level === "webgl2" && s.loaderOff === 0 && s.started && s.wasm >= 1,
        `panel ${JSON.stringify(s.panel)}, level ${JSON.stringify(s.level)}, loader tags off ${s.loaderOff}, started ${s.started}, wasm ${s.wasm}`);
}
if (fails === 0) { say("GREEN"); process.exit(0); } else { say(`RED (${fails})`); process.exit(1); }
