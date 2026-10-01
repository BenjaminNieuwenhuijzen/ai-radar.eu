/* Tests for the local preview server (scripts/model-history/serve.mjs): Pages-like URL
   rules, overlays, 404 handling and path traversal. Each suite builds its own site in a
   temp directory and starts the server in-process on a free port. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createServer, parseCli, parseOverlay, allowedHost, requestUrl, HOST, DEFAULT_PORT } from "../serve.mjs";

const SECRET = "TOP-SECRET-OUTSIDE-ROOT";
const put = (base, p, body) => { const f = join(base, p); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, body); };

// Raw requests (not fetch): fetch would normalise "..", and 301s must not be followed.
// Node sets Host to 127.0.0.1:<port> unless headers override it.
function get(port, path, method = "GET", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}
async function start(opts) {
  const server = createServer(opts);
  await new Promise(r => server.listen(0, HOST, r));
  return { server, port: server.address().port };
}
const stop = s => new Promise(r => { s.closeAllConnections(); s.close(r); });

/* ---------- Site with a 404 page and an overlay ---------- */
let tmp, root, srv;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "mh-serve-"));
  root = join(tmp, "site");
  put(tmp, "secret.txt", SECRET);
  put(root, "index.html", "<h1>root index</h1>");
  put(root, "404.html", "<h1>custom 404</h1>");
  put(root, "about.html", "<h1>about page</h1>");
  put(root, "dir/index.html", "<h1>dir index</h1>");
  put(root, "nodex/readme.txt", "no index here");
  put(root, "page.html", "<h1>page.html wins</h1>");
  put(root, "page/index.html", "<h1>page dir</h1>");
  put(root, "assets/app.css", "body{}");
  put(root, "assets/app.js", "void 0;");
  put(root, "data.json", "{}");
  put(root, "favicon.svg", "<svg/>");
  put(root, "sitemap.xml", "<urlset/>");
  put(root, "robots.txt", "User-agent: *");
  put(root, "img/a.png", "png");
  put(root, "img/b.jpg", "jpg");
  put(root, "img/c.webp", "webp");
  put(root, "img/d.gif", "gif");
  put(root, "img/e.bin", "bin");
  put(root, "model-history/README.md", "# Model History data");
  put(root, "models/index.html", "<h1>REAL models (must be hidden by the overlay)</h1>");
  put(root, ".hidden.txt", "dotfile");
  put(root, ".git/config", "[core]");
  put(root, ".preview/models/index.html", "<h1>preview models</h1>");
  put(root, ".preview/models/example-lab/index.html", "<h1>preview org</h1>");
  put(root, ".preview/models/example-lab/orbit-2/index.html", "<h1>preview orbit 2</h1>");
  put(root, ".preview/models/index.json", "{\"models\":[]}");
  put(root, ".preview/sitemap-models.xml", "<urlset>preview</urlset>");
  const overlays = [parseOverlay("/models=.preview/models", root), parseOverlay("/sitemap-models.xml=.preview/sitemap-models.xml", root)];
  srv = await start({ root, overlays });
});
after(async () => {
  if (srv) await stop(srv.server);
  rmSync(tmp, { recursive: true, force: true });
});

test("root serves index.html with no-cache", async () => {
  const r = await get(srv.port, "/");
  assert.equal(r.status, 200);
  assert.match(r.body, /root index/);
  assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(r.headers["cache-control"], "no-cache");
});

test("directory without slash gets a 301 to the slash URL, query kept", async () => {
  const r = await get(srv.port, "/dir");
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, "/dir/");
  const q = await get(srv.port, "/dir?view=timeline&cat=model-releases");
  assert.equal(q.status, 301);
  assert.equal(q.headers.location, "/dir/?view=timeline&cat=model-releases");
});

test("directory with slash serves its index.html; without index.html it is a 404", async () => {
  const r = await get(srv.port, "/dir/");
  assert.equal(r.status, 200);
  assert.match(r.body, /dir index/);
  const n = await get(srv.port, "/nodex/");
  assert.equal(n.status, 404);
  assert.match(n.body, /custom 404/);
});

test("extensionless URL serves page.html, and page.html wins over a directory page/", async () => {
  const a = await get(srv.port, "/about");
  assert.equal(a.status, 200);
  assert.match(a.body, /about page/);
  assert.equal((await get(srv.port, "/about.html")).status, 200);
  assert.equal((await get(srv.port, "/about/")).status, 404, "Pages gives 404 for /about/ when only about.html exists");
  const p = await get(srv.port, "/page");
  assert.equal(p.status, 200);
  assert.match(p.body, /page\.html wins/);
  assert.match((await get(srv.port, "/page/")).body, /page dir/);
});

test("paths are case-sensitive, as on Pages", async () => {
  assert.equal((await get(srv.port, "/About")).status, 404);
  assert.equal((await get(srv.port, "/about.HTML")).status, 404);
  assert.equal((await get(srv.port, "/DIR/")).status, 404);
  assert.equal((await get(srv.port, "/Assets/app.css")).status, 404);
});

test("content types", async () => {
  const want = {
    "/assets/app.css": "text/css; charset=utf-8", "/assets/app.js": "text/javascript; charset=utf-8",
    "/data.json": "application/json; charset=utf-8", "/favicon.svg": "image/svg+xml",
    "/sitemap.xml": "application/xml; charset=utf-8", "/robots.txt": "text/plain; charset=utf-8",
    "/img/a.png": "image/png", "/img/b.jpg": "image/jpeg", "/img/c.webp": "image/webp", "/img/d.gif": "image/gif",
    "/img/e.bin": "application/octet-stream", "/model-history/README.md": "text/markdown; charset=utf-8"
  };
  for (const [path, type] of Object.entries(want)) {
    const r = await get(srv.port, path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers["content-type"], type, path);
  }
});

test("overlay maps /models to the preview directory, not the real models/", async () => {
  const r = await get(srv.port, "/models/");
  assert.equal(r.status, 200);
  assert.match(r.body, /preview models/);
  assert.doesNotMatch(r.body, /REAL models/);
  const redirect = await get(srv.port, "/models?org=example-lab");
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, "/models/?org=example-lab");
  assert.match((await get(srv.port, "/models/example-lab/")).body, /preview org/);
  assert.match((await get(srv.port, "/models/example-lab/orbit-2/")).body, /preview orbit 2/);
  assert.equal((await get(srv.port, "/models/example-lab/orbit-2")).headers.location, "/models/example-lab/orbit-2/");
  const json = await get(srv.port, "/models/index.json");
  assert.equal(json.headers["content-type"], "application/json; charset=utf-8");
  assert.equal((await get(srv.port, "/models/missing/")).status, 404);
  // An encoded prefix still reaches the overlay, never the real directory.
  assert.match((await get(srv.port, "/mod%65ls/")).body, /preview models/);
});

test("an overlay can map a single file", async () => {
  const r = await get(srv.port, "/sitemap-models.xml");
  assert.equal(r.status, 200);
  assert.match(r.body, /preview/);
  assert.equal(r.headers["content-type"], "application/xml; charset=utf-8");
});

test("unknown paths get the root 404.html with status 404", async () => {
  const r = await get(srv.port, "/does-not-exist");
  assert.equal(r.status, 404);
  assert.match(r.body, /custom 404/);
  assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
});

test("path traversal and dotfiles are never served", async () => {
  const attempts = [
    "/../secret.txt", "/../../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/..%2Fsecret.txt",
    "/..%5csecret.txt", "/dir/..%2F..%2Fsecret.txt", "/models/..%2F..%2F..%2Fsecret.txt",
    "/models/%2e%2e/%2e%2e/%2e%2e/secret.txt", "/%2e%2e%2f%2e%2e%2fsecret.txt", "/C:%5Cwindows%5Cwin.ini",
    "/.hidden.txt", "/.git/config", "/.preview/models/index.html", "/about.html%00.txt"
  ];
  for (const path of attempts) {
    const r = await get(srv.port, path);
    assert.notEqual(r.status, 200, path);
    assert.ok(!r.body.includes(SECRET), `${path} leaked a file outside the root`);
    assert.ok(!/dotfile|\[core\]|preview models/.test(r.body), `${path} served a dotfile`);
  }
});

test("leading double slashes stay part of the path, never a host", async () => {
  // new URL("//models/index.html", base) would make "models" the host and serve the root.
  const m = await get(srv.port, "//models/index.html");
  assert.equal(m.status, 200);
  assert.match(m.body, /preview models/);
  assert.doesNotMatch(m.body, /root index/);
  const evil = await get(srv.port, "//evil.example/");
  assert.equal(evil.status, 404);
  assert.doesNotMatch(evil.body, /root index/);
  const triple = await get(srv.port, "///");
  assert.equal(triple.status, 200, "/// is the root with merged slashes, not a 500");
  assert.match(triple.body, /root index/);
  assert.equal((await get(srv.port, "//dir")).headers.location, "/dir/", "the redirect never starts with //");
  // WHATWG URL parsing treats "\" as "/" in http URLs, so "/\evil" is the same trap.
  assert.equal((await get(srv.port, "/\\evil.example/")).status, 404);
  assert.equal(requestUrl("//models/x").host, "127.0.0.1");
  assert.equal(requestUrl("//models/x").pathname, "//models/x");
  assert.equal(requestUrl("http://evil.example/x"), null);
  assert.equal(requestUrl("*"), null);
});

test("requests addressed to another host name are refused (DNS rebinding)", async () => {
  for (const host of ["evil.example", `evil.example:${srv.port}`, `127.0.0.1:${srv.port + 1}`, "127.0.0.1"]) {
    const r = await get(srv.port, "/about", "GET", { Host: host });
    assert.equal(r.status, 403, host);
    assert.doesNotMatch(r.body, /about page/, host);
  }
  const ok = await get(srv.port, "/about", "GET", { Host: `localhost:${srv.port}` });
  assert.equal(ok.status, 200);
  assert.match(ok.body, /about page/);
  assert.equal((await get(srv.port, "/about", "GET", { Host: `LocalHost:${srv.port}` })).status, 200, "host names are case-insensitive");
  assert.ok(allowedHost(`127.0.0.1:${srv.port}`, srv.port));
  assert.ok(allowedHost("localhost", 80), "a browser omits the default port");
  assert.ok(!allowedHost(undefined, srv.port), "no Host header, no answer");
  assert.ok(!allowedHost("127.0.0.1.evil.example:80", 80));
});

test("a symlink inside the root cannot expose files outside it", async t => {
  // A junction needs no admin rights on Windows; elsewhere "junction" is a plain dir symlink.
  try { symlinkSync(tmp, join(root, "escape"), "junction"); } catch (e) { return t.skip(`cannot create a symlink here: ${e.code}`); }
  const r = await get(srv.port, "/escape/secret.txt");
  assert.equal(r.status, 404);
  assert.ok(!r.body.includes(SECRET));
});

test("a 404.html symlink pointing outside the root is not served", async t => {
  const site = mkdtempSync(join(tmpdir(), "mh-serve-404link-"));
  put(site, "outside.html", SECRET);
  put(site, "root/index.html", "x");
  // File symlinks need admin rights or Developer Mode on Windows; skip there if refused (a
  // junction cannot stand in: it is always a directory). The 404 page goes through the same
  // resolvePath guard that the junction test above exercises on every platform.
  try { symlinkSync(join(site, "outside.html"), join(site, "root", "404.html"), "file"); }
  catch (e) { rmSync(site, { recursive: true, force: true }); return t.skip(`cannot create a file symlink here: ${e.code}`); }
  const s = await start({ root: join(site, "root") });
  try {
    const r = await get(s.port, "/nope");
    assert.equal(r.status, 404);
    assert.ok(!r.body.includes(SECRET), "the linked 404 page leaked a file outside the root");
    assert.match(r.body, /404 Not Found/);
  } finally {
    await stop(s.server);
    rmSync(site, { recursive: true, force: true });
  }
});

test("malformed encoding is a 400, other methods a 405, HEAD has no body", async () => {
  assert.equal((await get(srv.port, "/%E0%A4%A")).status, 400);
  const post = await get(srv.port, "/", "POST");
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  const head = await get(srv.port, "/about", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(Number(head.headers["content-length"]), Buffer.byteLength("<h1>about page</h1>"));
});

test("plain 404 when the root has no 404.html", async () => {
  const bare = mkdtempSync(join(tmpdir(), "mh-serve-bare-"));
  put(bare, "index.html", "x");
  const s = await start({ root: bare });
  try {
    const r = await get(s.port, "/nope");
    assert.equal(r.status, 404);
    assert.equal(r.headers["content-type"], "text/plain; charset=utf-8");
    assert.match(r.body, /404 Not Found/);
  } finally {
    await stop(s.server);
    rmSync(bare, { recursive: true, force: true });
  }
});

test("the server only listens on 127.0.0.1", async () => {
  assert.equal(HOST, "127.0.0.1");
  assert.equal(srv.server.address().address, "127.0.0.1");
});

test("command-line options", () => {
  const d = parseCli([]);
  assert.equal(d.port, DEFAULT_PORT);
  assert.equal(DEFAULT_PORT, 8125);
  assert.deepEqual(d.overlays, []);
  const o = parseCli(["--root", root, "--port", "9001", "--overlay", "/models=.preview/models", "--overlay", "/sitemap-models.xml=.preview/sitemap-models.xml"]);
  assert.equal(o.root, root);
  assert.equal(o.port, 9001);
  assert.deepEqual(o.overlays.map(x => x.prefix), ["/models", "/sitemap-models.xml"]);
  assert.equal(o.overlays[0].dir, join(root, ".preview", "models"), "overlay dirs resolve against --root");
  assert.equal(parseOverlay("/models/=x", root).prefix, "/models");
  assert.throws(() => parseCli(["--port", "abc"]), /--port/);
  assert.throws(() => parseCli(["--bogus"]));
  for (const bad of ["models=x", "/=x", "=x", "/models", "/../x=y", "/.git=y", "/models="]) assert.throws(() => parseOverlay(bad, root), undefined, bad);
});
