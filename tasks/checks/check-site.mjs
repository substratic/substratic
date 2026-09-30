#!/usr/bin/env node
// check-site.mjs - the shared legs of the local gate for a staged site tree,
// run by substratic's check-site task (tasks/check-site.sgl), which checks
// the manifest first and writes DIR.verified only when this exits 0. From
// games' check-site scripts; their game-only legs (the
// root page's content, the boots) moved to the game's arm.
//
//   node check-site.mjs DIR [--arm ARM.mjs]
//
// What it knows of the site comes from DIR.manifest's header, written by
// stage-web: # game (the app's path), # app (its wasm is <app>.wasm),
// # route (the wasm's directory), # indexing (noindex or index).
//
// Serves DIR on loopback through serve-site.mjs (Pages' rules: the tree's own
// _headers and _redirects, real 404s from 404.html, pretty URLs) and checks:
//   old-path   every _redirects source is named in no root file but
//              _redirects, and has no directory in the tree
//   root       / is 200 html
//   robots     (noindex) /robots.txt disallows everything
//   noindex    (noindex) every response carries X-Robots-Tag: noindex
//   files      every file in the manifest is served 200 byte for byte, and
//              nothing but .html is served as html
//   missing    a missing path is a 404 with 404.html's body, at the root and
//              under the game; /_headers and /_redirects are not served; the
//              wasm's unhashed name under the game and an unknown hash under
//              the route are 404
//   slash      /<game> redirects (308) to /<game>/
//   redirect   every _redirects rule answers its status and Location
//   wasm       exactly one wasm, at <route>/<sha16>/<app>.wasm, named by its
//              own sha256; the page's data-wasm names it
//   arm        the game's own legs: `node ARM BASE DIR` while this server
//              runs (BASE is its http://127.0.0.1:PORT); its lines are relayed,
//              and exit 0 is green, 1 red, anything else a setup failure.
//              Bounded at 1500 s. The arm gets SUBSTRATIC_CHECKS, this directory.
//   fetched    with an arm: the page (as the arm loaded it) fetched its wasm
//              from /<route>/<sha16>/ and no other wasm
// Exit 0 green, 1 red, 2 setup failed.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHandler, parseRedirects } from "./serve-site.mjs";

const args = process.argv.slice(2);
const ai = args.indexOf("--arm");
const ARM = ai >= 0 ? path.resolve(args[ai + 1] || "") : null;
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--arm"));
const DIR = path.resolve((positional[0] || "").replace(/\/$/, ""));
const setup = (why) => { console.log(`SETUP-FAILED: ${why}`); process.exit(2); };
if (!positional[0] || !fs.existsSync(path.join(DIR, "index.html"))) setup(`${DIR}/index.html missing`);
const MAN = DIR + ".manifest";
if (!fs.existsSync(MAN)) setup(`${MAN} missing (stage-web)`);
if (ARM && !fs.existsSync(ARM)) setup(`the arm ${ARM} is missing`);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const manText = fs.readFileSync(MAN, "utf8");
const header = (k) => (manText.match(new RegExp(`^# ${k} (\\S+)$`, "m")) || [])[1];
const SLUG = header("game"), APP = header("app"), ROUTE = header("route"), INDEXING = header("indexing");
if (!SLUG || !APP || !ROUTE || !INDEXING) setup(`${MAN} lacks a # game, # app, # route or # indexing line (stage it with substratic's stage-web)`);
if (!fs.statSync(path.join(DIR, SLUG), { throwIfNoEntry: false })?.isDirectory()) setup(`the manifest names the game at /${SLUG}/, which is not in the tree`);
const NOINDEX = INDEXING === "noindex";
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

let pass = 0, fail = 0;
const ok = (leg, what) => { pass++; console.log(`  ok   ${leg}: ${what}`); };
const bad = (leg, what) => { fail++; console.log(`  FAIL ${leg}: ${what}`); };

// the files, from the manifest (the task checked the tree against it first)
const files = manText.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.slice(66)).filter((f) => !f.startsWith("@"));
const REDIRECTS = fs.existsSync(path.join(DIR, "_redirects")) ? parseRedirects(fs.readFileSync(path.join(DIR, "_redirects"), "utf8")) : [];

// old-path: a redirect source lives on only as a redirect
const OLD = REDIRECTS.map((r) => r.from.replace(/\/\*$/, "").replace(/^\//, "")).filter((p, i, a) => p && a.indexOf(p) === i);
if (OLD.length) {
  // the site's own text files: everything but the game's directory and the
  // wasm's route. A name counts as a path (/NAME), not a substring:
  // "display" does not name /play/ (Phantom's check-site, 2c1ff55)
  const TEXT = files.filter((f) => !f.startsWith(SLUG + "/") && !f.startsWith(ROUTE + "/") && f !== "_redirects"
    && !/(^|\/)(OFL|LICEN[CS]E)[^/]*\.txt$/i.test(f) && /\.(html|xml|json|txt|css)$|^_headers$/.test(f));
  let named = 0;
  for (const f of TEXT) {
    const t = fs.readFileSync(path.join(DIR, f), "utf8");
    const hit = OLD.filter((p) => new RegExp("/" + reEsc(p) + "(?![A-Za-z0-9_-])").test(t));
    if (hit.length) { named++; bad("old-path", `${f} names ${hit.map((p) => "/" + p).join(" ")}`); }
  }
  if (!TEXT.length) bad("old-path", "no site text files to check");
  else if (!named) ok("old-path", `checked ${TEXT.length} site text files for ${OLD.map((p) => "/" + p).join(" ")}`);
  for (const p of OLD) fs.existsSync(path.join(DIR, p)) ? bad("old-path", `${p} exists in the tree`) : ok("old-path", `/${p}/ is only a redirect`);
}

// wasm: one, content-named, and what the page points at
const wasms = files.filter((f) => f.endsWith(".wasm"));
const WASM = wasms.length === 1 ? wasms[0] : null;
const m = WASM && WASM.match(new RegExp(`^${reEsc(ROUTE)}\\/([0-9a-f]{16})\\/${reEsc(APP)}\\.wasm$`));
if (!m) bad("wasm", `want one wasm at ${ROUTE}/<sha16>/${APP}.wasm, found: ${wasms.join(" ") || "none"}`);
else if (sha(fs.readFileSync(path.join(DIR, WASM))).slice(0, 16) !== m[1]) bad("wasm", `${WASM} does not hash to its name`);
else ok("wasm", `the wasm is ${WASM}, named by its sha256`);
const page = fs.readFileSync(path.join(DIR, SLUG, "index.html"), "utf8");
m && page.includes(`data-wasm="/${ROUTE}/${m[1]}/${APP}"`) && !page.includes(`data-wasm="${APP}"`)
  ? ok("wasm", "the page's data-wasm names it") : bad("wasm", "the page's data-wasm does not name the staged wasm");

// every request from here on, to see where the page took its wasm from
const asked = new Set();
const handler = createHandler(DIR);
const server = http.createServer((req, res) => { asked.add(decodeURIComponent(req.url.split("?")[0])); handler(req, res); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
async function get(p) {
  const r = await fetch(BASE + p, { redirect: "manual" });
  return { status: r.status, type: r.headers.get("content-type") || "", robots: r.headers.get("x-robots-tag") || "",
           location: r.headers.get("location") || "", body: Buffer.from(await r.arrayBuffer()) };
}

// root, robots
const root = await get("/");
root.status === 200 && root.type.startsWith("text/html") ? ok("root", "/ is 200 html") : bad("root", `/ is ${root.status} ${root.type}`);
{
  const robots = await get("/robots.txt");
  const t = robots.body.toString();
  if (NOINDEX)
    robots.status === 200 && /User-agent:\s*\*/i.test(t) && /^Disallow:\s*\/\s*$/m.test(t)
      ? ok("robots", "disallows everything") : bad("robots", `status ${robots.status}: ${t.slice(0, 60)}`);
  else
    robots.status === 200 && /User-agent:\s*\*/i.test(t) && /^Allow:\s*\/\s*$/mi.test(t) && !/^Disallow:\s*\S/mi.test(t)
      ? ok("robots", "allows everything") : bad("robots", `status ${robots.status}: ${t.slice(0, 60)}`);
}
// a <meta> for robots (or a named crawler) whose content says noindex, its
// attributes in any order (Phantom's check-site, 2c1ff55)
const asksNoindex = (html) => [...html.matchAll(/<meta\b[^>]*>/gi)].some(([mm]) =>
  /\bname\s*=\s*["']?(robots|googlebot|bingbot)\b/i.test(mm) && /\bcontent\s*=\s*["'][^"']*noindex/i.test(mm));

// files, noindex
let served = 0, noidx = 0;
const indexedNoidx = [];   // index mode: files served with X-Robots-Tag: noindex
for (const f of files) {
  if (f === "_headers" || f === "_redirects") continue;   // consumed by Pages, never served
  const url = "/" + f.split("/").map(encodeURIComponent).join("/");
  const r = await get(url.endsWith("/index.html") ? url.slice(0, -"index.html".length) : url);
  const same = r.status === 200 && sha(r.body) === sha(fs.readFileSync(path.join(DIR, f)));
  const htmlOk = f.endsWith(".html") || !r.type.startsWith("text/html");
  if (same && htmlOk) served++; else bad("files", `${f}: ${r.status} ${r.type}${same ? "" : " (bytes differ)"}`);
  if (NOINDEX) { if (/noindex/.test(r.robots)) noidx++; else bad("noindex", `${f} has no X-Robots-Tag: noindex`); }
  else if (/noindex/.test(r.robots)) indexedNoidx.push(f);
}
const nfiles = files.filter((f) => f !== "_headers" && f !== "_redirects").length;
if (served === nfiles) ok("files", `${served} of ${nfiles} served byte for byte`);
if (NOINDEX && noidx === nfiles) ok("noindex", `all ${noidx} files carry X-Robots-Tag: noindex`);
// indexable (index): no response says X-Robots-Tag: noindex, no page but the
// 404 asks not to be indexed, and the 404 does (one FAIL line for all)
if (!NOINDEX) {
  const has404 = fs.existsSync(path.join(DIR, "404.html"));
  let n = 0;
  if (indexedNoidx.length) { n++; bad("indexable", `${indexedNoidx.length} files are served with X-Robots-Tag: noindex, e.g. ${indexedNoidx.slice(0, 5).join(" ")}`); }
  for (const f of files.filter((x) => x.endsWith(".html") && x !== "404.html"))
    if (asksNoindex(fs.readFileSync(path.join(DIR, f), "utf8"))) { n++; bad("indexable", `${f} asks not to be indexed`); }
  if (!has404 || !asksNoindex(fs.readFileSync(path.join(DIR, "404.html"), "utf8"))) { n++; bad("indexable", "404.html does not ask not to be indexed"); }
  if (!n) ok("indexable", `none of ${nfiles} files carries X-Robots-Tag: noindex; 404.html alone says noindex`);
}

// missing
const four = fs.existsSync(path.join(DIR, "404.html")) ? fs.readFileSync(path.join(DIR, "404.html")) : Buffer.from("(no 404.html)");
for (const p of ["/no-such-page", "/no-such-dir/", `/${SLUG}/no-such-file.js`, "/_headers", "/_redirects",
                 `/${SLUG}/${APP}.wasm`, `/${ROUTE}/0000000000000000/${APP}.wasm`]) {
  const r = await get(p);
  r.status === 404 && sha(r.body) === sha(four) && (!NOINDEX || /noindex/.test(r.robots))
    ? ok("missing", `${p} is a 404 with 404.html`) : bad("missing", `${p}: ${r.status}`);
}
const slash = await get(`/${SLUG}`);
slash.status === 308 && slash.location === `/${SLUG}/` ? ok("slash", `/${SLUG} redirects to /${SLUG}/`) : bad("slash", `${slash.status} -> ${slash.location}`);
// redirect: each rule, with a sample path under a splat
for (const r of REDIRECTS) {
  const tail = r.from.endsWith("/*") ? "assets/sigil-web-app.js" : "";
  const from = r.from.endsWith("/*") ? r.from.slice(0, -1) + tail : r.from;
  const want = r.to.replace(":splat", tail);
  // with a query string, which Pages keeps (Phantom: ?go=14 must survive the move)
  const g = await get(from + "?go=14");
  g.status === r.status && g.location === want + "?go=14" ? ok("redirect", `${from}?go=14 ${r.status} -> ${want}?go=14`) : bad("redirect", `${from}?go=14: ${g.status} -> ${g.location} (want ${r.status} -> ${want}?go=14)`);
}

// the arm: the game's own legs, against this server (asynchronously: this
// process is also the server the arm's browser talks to)
let armFailed = false;
if (ARM) {
  asked.clear();   // the probes above are not the page's
  const r = await new Promise((resolve) => {
    const ch = spawn(process.execPath, [ARM, BASE, DIR], { stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SUBSTRATIC_CHECKS: path.dirname(fileURLToPath(import.meta.url)) } });
    let o = "";
    ch.stdout.on("data", (d) => { o += d; }); ch.stderr.on("data", (d) => { o += d; });
    const kill = setTimeout(() => { o += "\nTIMED-OUT: the arm ran 1500 s\n"; ch.kill("SIGKILL"); }, 1500000);
    ch.on("close", (code) => { clearTimeout(kill); resolve({ status: code, out: o }); });
  });
  for (const l of r.out.split("\n")) {
    if (/^\s+ok\s/.test(l)) { pass++; console.log(l); }
    else if (/^\s+FAIL\s/.test(l)) { fail++; console.log(l); }
    else if (l.trim()) console.log(`  arm| ${l}`);
  }
  if (r.status === 1) { if (!/^\s+FAIL\s/m.test(r.out)) bad("arm", `${path.basename(ARM)} exited 1 without a FAIL line`); }
  else if (r.status !== 0) { armFailed = true; console.log(`SETUP-FAILED: the arm ${path.basename(ARM)} exited ${r.status}`); }
  else if (!/^\s+ok\s/m.test(r.out)) bad("arm", `${path.basename(ARM)} exited 0 but reported no leg`);
  if (m && !armFailed) {
    const want = `/${ROUTE}/${m[1]}/${APP}.wasm`;
    const other = [...asked].filter((u) => u.endsWith(".wasm") && u !== want);
    asked.has(want) && other.length === 0
      ? ok("fetched", `the page fetched its wasm from /${ROUTE}/<sha16>/ and no other wasm`)
      : bad("fetched", `the page's wasm requests: ${[...asked].filter((u) => u.endsWith(".wasm")).join(" ") || "none"}`);
  }
}
server.close();

if (armFailed) { console.log(`SETUP-FAILED: ${pass} pass, ${fail} fail, the arm did not give a verdict`); process.exit(2); }
if (fail === 0) { console.log(`GREEN: ${pass} pass, 0 fail`); process.exit(0); }
console.log(`RED: ${pass} pass, ${fail} fail`);
process.exit(1);
