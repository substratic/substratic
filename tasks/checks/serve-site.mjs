#!/usr/bin/env node
// serve-site.mjs - serve a staged site tree the way Cloudflare Pages does, as
// far as a static server can. Ported from the games' serve-site scripts.
//
//   node serve-site.mjs DIR PORT [--host ADDR | --iface NAME] [--tls --tls-dir D] [--log]
//
//   --iface NAME   bind to NAME's one IPv4 address (a private network
//                  interface, e.g. a VPN's); refused if it has none or several
//
// Used by check-site.mjs (loopback) and substratic's host-site task (--iface), so
// the check and the preview see the same behaviour. What it copies from Pages:
//   _headers    the tree's own root _headers file is parsed and applied (URL
//               patterns with * splats, headers merged across every matching
//               rule), so the check tests the header FILE that ships.
//   404         a missing path answers the nearest 404.html up the tree with
//               status 404. With no 404.html anywhere, it answers the root
//               index.html with 200, which is what Pages does and the trap in
//               a missing page answered 200 with the landing page.
//   pretty URLs a directory asked for without its slash is a 308 to the slash;
//               /x/index.html is a 308 to /x/.
//   _redirects  the tree's root _redirects file: "FROM TO [STATUS]" per line,
//               the first matching rule wins, a trailing /* in FROM carries
//               the rest of the path into :splat in TO, the status defaults to
//               302; the query string goes along, as Pages does
//   hidden      _headers and _redirects are consumed, not served (404).
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript",
  ".mjs": "application/javascript", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".cts": "text/plain; charset=utf-8", ".b64": "text/plain; charset=utf-8", ".sexp": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".xml": "application/xml",
};

// Pages' _headers: a line starting at column 0 is a URL pattern, an indented
// "Name: value" line is a header for the pattern above it, # starts a comment.
export function parseHeaders(text) {
  const rules = [];
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    if (!/^\s/.test(line)) {
      const pat = line.trim();
      const re = new RegExp("^" + pat.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z]\w*/g, "[^/]+")).join(".*") + "$");
      cur = { pattern: pat, re, headers: [] };
      rules.push(cur);
    } else {
      const m = line.trim().match(/^([^:]+):\s*(.*)$/);
      if (!m || !cur) throw new Error(`_headers: cannot read the line "${line}"`);
      cur.headers.push([m[1].trim().toLowerCase(), m[2].trim()]);
    }
  }
  return rules;
}

export function headersFor(rules, urlPath) {
  const out = {};
  for (const r of rules) if (r.re.test(urlPath)) for (const [k, v] of r.headers) out[k] = v;
  return out;
}

// The request handler for the tree at ROOT. onRequest(method, path, status)
// is called for every request, for a caller that wants the log.
export function parseRedirects(text) {
  return text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).map((l) => {
    const [from, to, status] = l.split(/\s+/);
    return { from, to, status: status ? Number(status) : 302 };
  });
}

export function createHandler(root, onRequest = () => {}) {
  root = path.resolve(root);
  const hfile = path.join(root, "_headers");
  const rules = fs.existsSync(hfile) ? parseHeaders(fs.readFileSync(hfile, "utf8")) : [];
  const rfile = path.join(root, "_redirects");
  const redirects = fs.existsSync(rfile) ? parseRedirects(fs.readFileSync(rfile, "utf8")) : [];
  const inside = (fp) => fp === root || fp.startsWith(root + path.sep);
  const isFile = (fp) => { try { return fs.statSync(fp).isFile(); } catch { return false; } };
  const isDir = (fp) => { try { return fs.statSync(fp).isDirectory(); } catch { return false; } };

  function send(res, method, urlPath, status, fp, extra = {}) {
    const body = fs.readFileSync(fp);
    const headers = {
      "content-type": TYPES[path.extname(fp)] || "application/octet-stream",
      "cache-control": "no-cache",
      ...headersFor(rules, urlPath),
      ...extra,
    };
    res.writeHead(status, headers);
    res.end(method === "HEAD" ? undefined : body);
    onRequest(method, urlPath, status);
  }

  function notFound(res, method, urlPath) {
    // the nearest 404.html up the tree, as Pages does; none at all is the
    // single-page-app fallback: the root index.html with a 200
    let dir = path.join(root, path.dirname(urlPath.endsWith("/") ? urlPath + "x" : urlPath));
    while (inside(dir)) {
      const cand = path.join(dir, "404.html");
      if (isFile(cand)) return send(res, method, urlPath, 404, cand);
      if (dir === root) break;
      dir = path.dirname(dir);
    }
    return send(res, method, urlPath, 200, path.join(root, "index.html"));
  }

  return (req, res) => {
    const method = req.method || "GET";
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url || "/", "http://x").pathname); } catch { res.writeHead(400).end(); onRequest(method, req.url, 400); return; }
    if (method !== "GET" && method !== "HEAD") { res.writeHead(405).end(); onRequest(method, urlPath, 405); return; }
    const fp = path.normalize(path.join(root, urlPath));
    if (!inside(fp)) { res.writeHead(403).end(); onRequest(method, urlPath, 403); return; }
    const base = path.basename(urlPath);
    if (urlPath === "/_headers" || urlPath === "/_redirects") return notFound(res, method, urlPath);
    for (const r of redirects) {
      const splat = r.from.endsWith("/*") ? (urlPath.startsWith(r.from.slice(0, -1)) ? urlPath.slice(r.from.length - 1) : null)
                                          : (urlPath === r.from ? "" : null);
      if (splat !== null) {
        // the query string goes along, as Pages does (wrangler pages dev, 2026-09-29:
        // /play/?go=14 -> /badge-in/?go=14; Phantom's serve-site, 2c1ff55)
        const q = new URL(req.url || "/", "http://x").search;
        res.writeHead(r.status, { location: r.to.replace(":splat", splat) + q }).end(); onRequest(method, urlPath, r.status); return;
      }
    }
    if (base === "index.html") {
      const to = urlPath.slice(0, -"index.html".length);
      res.writeHead(308, { location: to }).end(); onRequest(method, urlPath, 308); return;
    }
    if (isDir(fp)) {
      if (!urlPath.endsWith("/")) { res.writeHead(308, { location: urlPath + "/" }).end(); onRequest(method, urlPath, 308); return; }
      const idx = path.join(fp, "index.html");
      return isFile(idx) ? send(res, method, urlPath, 200, idx) : notFound(res, method, urlPath);
    }
    return isFile(fp) ? send(res, method, urlPath, 200, fp) : notFound(res, method, urlPath);
  };
}

function ifaceAddress(name) {
  if (!/^[A-Za-z0-9._-]{1,15}$/.test(name || "")) return "";
  let out = "";
  try { out = execSync(`ip -4 -o addr show dev ${name}`, { encoding: "utf8" }); } catch { return ""; }
  const addrs = [...out.matchAll(/inet (\d+\.\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  return addrs.length === 1 ? addrs[0] : "";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const [dir, portArg] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--host" && args[i - 1] !== "--tls-dir" && args[i - 1] !== "--iface");
  if (!dir || !portArg) { console.error("usage: serve-site.mjs DIR PORT [--host ADDR | --iface NAME] [--tls --tls-dir D] [--log]"); process.exit(2); }
  const root = path.resolve(dir);
  if (!fs.existsSync(path.join(root, "index.html"))) { console.error(`serve-site: ${root}/index.html missing`); process.exit(1); }
  const hi = args.indexOf("--host");
  const ii = args.indexOf("--iface");
  const host = ii >= 0 ? ifaceAddress(args[ii + 1]) : (hi >= 0 ? args[hi + 1] : "127.0.0.1");
  if (!host || host === "0.0.0.0" || host === "*") { console.error(`serve-site: refusing to bind to '${host || "<empty>"}' (the interface has no single IPv4 address?)`); process.exit(1); }
  const log = args.includes("--log");
  const handler = createHandler(root, (m, p, s) => { if (log) console.log(`${new Date().toISOString()} ${s} ${m} ${p}`); });
  const tls = args.includes("--tls");
  const ti = args.indexOf("--tls-dir");
  const tlsDir = ti >= 0 ? args[ti + 1] : "build/tls";
  const server = tls
    ? https.createServer({ key: fs.readFileSync(path.join(tlsDir, "key.pem")), cert: fs.readFileSync(path.join(tlsDir, "cert.pem")) }, handler)
    : http.createServer(handler);
  server.listen(Number(portArg), host, () => console.log(`serve-site: ${tls ? "https" : "http"}://${host}:${portArg}/ serving ${root}`));
}
