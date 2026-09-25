#!/usr/bin/env node
// serve.mjs - a dev preview server for a Substratic game's web build, with
// the playtest report endpoint.
//
//   node serve.mjs DIR PORT [--host ADDR] [--tls CERTDIR] [--reports DIR]
//
//   DIR        the built site (build/web, or a snapshot of it)
//   --host     the address to bind (default 127.0.0.1; a wildcard is refused)
//   --tls      serve HTTPS with CERTDIR/key.pem and CERTDIR/cert.pem
//   --reports  where reports are written (default ./reports)
//
// POST .../playtest-report with JSON {report: OBJECT, png: "data:image/png;base64,..." | null}
// writes REPORTS/<local time>[-N]/report.json and screenshot.png, and
// answers {"dir": "reports/<local time>"}. Each report is also one line on
// stdout. Nothing else is written; nothing outside DIR is served.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const [dir, portArg] = args;
if (!dir || !portArg) { console.error("usage: serve.mjs DIR PORT [--host ADDR] [--tls CERTDIR] [--reports DIR]"); process.exit(2); }
const port = Number(portArg);
const host = flag("--host") || "127.0.0.1";
if (host === "0.0.0.0" || host === "::" || host === "*") { console.error(`serve: refusing to bind to ${host}`); process.exit(2); }
const tlsDir = flag("--tls");
const root = path.resolve(dir);
const reports = path.resolve(flag("--reports") || "reports");
const MAX_BODY = 48 * 1024 * 1024;
if (!fs.existsSync(path.join(root, "index.html"))) { console.error(`serve: ${root}/index.html missing`); process.exit(1); }

const MIME = { html: "text/html; charset=utf-8", js: "text/javascript", wasm: "application/wasm", json: "application/json",
  css: "text/css", png: "image/png", txt: "text/plain; charset=utf-8", svg: "image/svg+xml" };

function two(n) { return String(n).padStart(2, "0"); }
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}
function freeDir(base) {
  for (let n = 1; ; n++) {
    const d = n === 1 ? base : `${base}-${n}`;
    if (!fs.existsSync(d)) return d;
  }
}
function answer(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function report(req, res) {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) { answer(res, 413, { error: "report too large" }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return answer(res, 400, { error: "not JSON" }); }
    if (!body || typeof body.report !== "object" || body.report === null) return answer(res, 400, { error: "no report" });
    let png = null;
    if (typeof body.png === "string") {
      const m = body.png.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
      if (!m) return answer(res, 400, { error: "png is not a PNG data URL" });
      png = Buffer.from(m[1], "base64");
      if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return answer(res, 400, { error: "png is not a PNG" });
    }
    try {
      const out = freeDir(path.join(reports, stamp()));
      fs.mkdirSync(out, { recursive: true });
      const r = Object.assign({}, body.report, { screenshot: png ? "screenshot.png" : null });
      fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(r, null, 2) + "\n");
      if (png) fs.writeFileSync(path.join(out, "screenshot.png"), png);
      const rel = path.join(path.basename(reports), path.basename(out));
      console.log(`report ${new Date().toISOString()} ${req.socket.remoteAddress} ${rel} ${JSON.stringify(r.note || "")}`);
      answer(res, 200, { dir: rel });
    } catch (err) {
      answer(res, 500, { error: String(err.message || err) });
    }
  });
}

function handler(req, res) {
  const u = new URL(req.url, "http://x");
  if (u.pathname.endsWith("/playtest-report")) {
    if (req.method !== "POST") return answer(res, 405, { error: "POST a report" });
    return report(req, res);
  }
  let urlPath;
  try { urlPath = decodeURIComponent(u.pathname); } catch { res.writeHead(400); res.end(); return; }
  let fp = path.normalize(path.join(root, urlPath));
  if (fp !== root && !fp.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try { if (fs.statSync(fp).isDirectory()) fp = path.join(fp, "index.html"); } catch { /* the read reports it */ }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(fp).slice(1)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(buf);
  });
}

const server = tlsDir
  ? https.createServer({ key: fs.readFileSync(path.join(tlsDir, "key.pem")), cert: fs.readFileSync(path.join(tlsDir, "cert.pem")) }, handler)
  : http.createServer(handler);
server.listen(port, host, () => console.log(`serve: ${tlsDir ? "https" : "http"}://${host}:${port}/ serving ${root}, reports to ${reports}`));
