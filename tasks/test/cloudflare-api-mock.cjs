// A local stand-in for the Cloudflare API calls cloudflare-setup makes, so it
// can be tested without a network or a token. TEST APPARATUS: it answers in
// the shapes the real API documents (success/errors/result), and green here
// is not green on Cloudflare.
//   node cloudflare-api-mock.cjs PORT TOKEN STATE.json
// PORT 0 picks a free port; the first line printed is "mock-cf listening PORT".
// STATE.json: { project: {subdomain, production_branch, domains:[]} | null,
//   deployments: N, bucket: "yes" | "no" | "unknown", zone: "name",
//   records: { "<name>": [{type, name, content, proxied}] } }
// It is re-read on every request, so a test can change it between runs.
// Logs one line per request ("METHOD path"), plus "body <json>" for a POST.
const http = require("http"), fs = require("fs");
const [port, TOKEN, stateFile] = process.argv.slice(2);
const ok = (result) => ({ success: true, errors: [], result });
const err = (code, message) => ({ success: false, errors: [{ code, message }], result: null });
const srv = http.createServer((q, r) => {
  const chunks = []; q.on("data", (c) => chunks.push(c)); q.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const url = new URL(q.url, "http://x");
    const p = url.pathname.replace(/^\/client\/v4/, "");
    console.log(`${q.method} ${p}${url.search}`);
    if (q.method === "POST") console.log(`body ${body}`);
    const send = (code, doc) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(doc)); };
    if (q.headers.authorization !== "Bearer " + TOKEN) return send(403, err(10000, "Authentication error"));
    let m;
    if ((m = p.match(/^\/accounts\/[^/]+\/pages\/projects\/([^/]+)$/)) && q.method === "GET")
      return s.project ? send(200, ok(s.project)) : send(404, err(8000007, "Project not found"));
    if ((m = p.match(/^\/accounts\/[^/]+\/pages\/projects\/([^/]+)\/deployments$/)))
      return send(200, ok(Array.from({ length: s.deployments || 0 }, (_, i) => ({ id: "d" + i }))));
    if ((m = p.match(/^\/accounts\/[^/]+\/pages\/projects\/([^/]+)\/domains$/)) && q.method === "POST")
      return send(200, ok({ name: JSON.parse(body).name }));
    if ((m = p.match(/^\/accounts\/[^/]+\/r2\/buckets\/([^/]+)$/)))
      return s.bucket === "yes" ? send(200, ok({ name: m[1], creation_date: "2026-09-25" }))
        : s.bucket === "no" ? send(404, err(10006, "The specified bucket does not exist."))
        : send(403, err(10000, "Authentication error"));
    if (p === "/zones") return send(200, ok(url.searchParams.get("name") === s.zone ? [{ id: "zone-id-1", name: s.zone }] : []));
    if ((m = p.match(/^\/zones\/zone-id-1\/dns_records$/)) && q.method === "GET")
      return send(200, ok((s.records || {})[url.searchParams.get("name")] || []));
    if ((m = p.match(/^\/zones\/zone-id-1\/dns_records$/)) && q.method === "POST") return send(200, ok({ id: "rec" }));
    send(404, err(7003, "No route for that URI"));
  });
});
srv.listen(Number(port), "127.0.0.1", () => console.log("mock-cf listening " + srv.address().port));
