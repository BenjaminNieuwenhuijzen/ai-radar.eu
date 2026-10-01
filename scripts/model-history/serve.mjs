/* Model History: local preview server. Node built-ins only, no dependencies.

   Serves the repository (or any --root) with the URL rules GitHub Pages applies to this
   site, so a page that works here also works on ai-radar.eu:
     /dir        → 301 to /dir/ (query string kept)
     /dir/       → dir/index.html
     /page       → page.html when it exists; page.html wins over a directory page/
     paths are case-sensitive (checked per segment, since Windows and macOS are not)
     not found   → the root 404.html with status 404, or a plain 404
   --overlay /models=.preview/models serves a path prefix from another directory (or, like
   /sitemap-models.xml=.preview/sitemap-models.xml, a single file), so a fixture build can
   be previewed without writing to models/. Binds to 127.0.0.1 only, answers only requests
   addressed to 127.0.0.1 or localhost (DNS rebinding), and never serves anything outside
   the root or an overlay directory.

   Run: node scripts/model-history/serve.mjs [--root <dir>] [--port <n>]
        [--overlay <prefix>=<dir>]...   (overlay dirs are relative to --root) */
import { createServer as createHttpServer } from "node:http";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_PORT = 8125;
export const HOST = "127.0.0.1";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
  // Pages (with .nojekyll) serves Markdown as text, so README.md opens in the browser there too.
  ".md": "text/markdown; charset=utf-8", ".pdf": "application/pdf"
};
const typeOf = p => TYPES[extname(p).toLowerCase()] || "application/octet-stream";

/* ---------- Options ---------- */
// "/models=.preview/models" → { prefix: "/models", dir: <root>/.preview/models }. Relative
// dirs resolve against the root, not the working directory, so a launcher started from
// another folder still finds the preview build.
export function parseOverlay(spec, root) {
  const i = String(spec).indexOf("=");
  if (i < 1) throw new Error(`--overlay needs <prefix>=<dir>, got "${spec}"`);
  const prefix = spec.slice(0, i).replace(/\/+$/, ""), dir = spec.slice(i + 1);
  const segs = prefix.split("/").slice(1);
  if (!prefix.startsWith("/") || !segs.length || segs.some(s => !safeSegment(s))) throw new Error(`--overlay prefix must look like /models, got "${spec.slice(0, i)}"`);
  if (!dir) throw new Error(`--overlay "${spec}" has no directory`);
  return { prefix, dir: isAbsolute(dir) ? resolve(dir) : resolve(root, dir) };
}
export function parseCli(argv) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    root: { type: "string" }, port: { type: "string" }, overlay: { type: "string", multiple: true },
    quiet: { type: "boolean" }, help: { type: "boolean", short: "h" }
  } });
  const root = values.root ? resolve(values.root) : REPO_ROOT;
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0-65535, got "${values.port}"`);
  return { root, port, overlays: (values.overlay || []).map(o => parseOverlay(o, root)), quiet: !!values.quiet, help: !!values.help };
}

/* ---------- Path resolution ---------- */
// One decoded URL segment. Dot segments and dotfiles (.git, .github, .preview) are never
// served; separators, NUL and ":" (Windows drive letters and alternate data streams)
// would let a single segment reach outside its directory.
function safeSegment(s) {
  return s.length > 0 && !s.startsWith(".") && !/[\\/:\0]/.test(s);
}
// Walks the segments with an exact, case-sensitive name match per directory level.
async function lookup(base, segs) {
  let cur = base;
  for (const s of segs) {
    let names;
    try { names = await readdir(cur); } catch { return null; }
    if (!names.includes(s)) return null;
    cur = join(cur, s);
  }
  try {
    const st = await stat(cur);
    return st.isFile() ? { kind: "file", path: cur } : st.isDirectory() ? { kind: "dir", path: cur } : null;
  } catch { return null; }
}
// Symlinks could still point elsewhere: the real path must stay inside the real base.
async function inside(base, file) {
  try {
    const [rb, rf] = await Promise.all([realpath(base), realpath(file)]);
    return rf === rb || rf.startsWith(rb.endsWith(sep) ? rb : rb + sep);
  } catch { return false; }
}

const withHtml = segs => [...segs.slice(0, -1), segs[segs.length - 1] + ".html"];
const encodePath = segs => "/" + segs.map(encodeURIComponent).join("/");

/* Maps a request path to { file } | { redirect: <path> } | { notFound } | { badRequest }.
   mounts: { segs, dir }, overlays with the most segments first, the root ({ segs: [] }) last.
   Segments are decoded before the mount is chosen, so /mod%65ls hits the /models overlay. */
export async function resolvePath(pathname, mounts) {
  let all;
  try { all = pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { return { badRequest: true }; }
  if (all.some(s => !safeSegment(s))) return { notFound: true };
  const mount = mounts.find(m => m.segs.every((s, i) => all[i] === s));
  const segs = all.slice(mount.segs.length);
  const serve = async (dir, hit) => (hit && hit.kind === "file" && await inside(dir, hit.path) ? { file: hit.path } : { notFound: true });

  if (pathname.endsWith("/")) {                               // "/dir/" (and "/" itself)
    const dir = await lookup(mount.dir, segs);
    return dir && dir.kind === "dir" ? serve(mount.dir, await lookup(mount.dir, [...segs, "index.html"])) : { notFound: true };
  }
  const hit = await lookup(mount.dir, segs);
  if (hit && hit.kind === "file") return serve(mount.dir, hit);
  // Extensionless page: page.html takes precedence over a directory page/ (as on Pages).
  // For an overlay prefix itself ("/models") that sibling lives in the enclosing mount.
  const parent = !segs.length && mounts.find(m => m.segs.length < mount.segs.length && m.segs.every((s, i) => mount.segs[i] === s));
  const html = segs.length ? { dir: mount.dir, segs: withHtml(segs) } : parent ? { dir: parent.dir, segs: withHtml(mount.segs.slice(parent.segs.length)) } : null;
  if (html) {
    const page = await lookup(html.dir, html.segs);
    if (page && page.kind === "file") return serve(html.dir, page);
  }
  // Built from the decoded segments, so the Location can never start with "//".
  if (hit && hit.kind === "dir") return { redirect: encodePath(all) + "/" };
  return { notFound: true };
}

/* ---------- Server ---------- */
// Binding to 127.0.0.1 does not stop DNS rebinding: a web page open in the developer's
// browser can point its own host name at 127.0.0.1 and read the worktree (including
// untracked files) through the preview. Such requests still carry the foreign name in
// Host, so only the loopback names on the port the request arrived at are accepted.
export function allowedHost(host, port) {
  const h = String(host || "").toLowerCase();
  return ["127.0.0.1", "localhost"].some(n => h === `${n}:${port}` || (port === 80 && h === n));
}
// The request target as a URL whose authority is always our own. new URL(req.url, base)
// would read "//models/x" (or "/\evil/x") as a protocol-relative URL with host "models"
// and serve the wrong file; appending the target to a fixed origin keeps every byte of it
// in the path, where empty segments are dropped (as Pages merges slashes). Absolute-form
// or "*" targets are not something a browser sends to this server: null = 400.
export function requestUrl(target) {
  if (typeof target !== "string" || !target.startsWith("/")) return null;
  try { return new URL(`http://${HOST}${target}`); } catch { return null; }
}

export function createServer({ root = REPO_ROOT, overlays = [], quiet = true, log = console.log } = {}) {
  const base = resolve(root);
  const mounts = overlays.map(o => ({ segs: o.prefix.split("/").filter(Boolean), dir: resolve(base, o.dir) }))
    .sort((a, b) => b.segs.length - a.segs.length || (a.segs.join("/") > b.segs.join("/")) - (a.segs.join("/") < b.segs.join("/")))
    .concat({ segs: [], dir: base });
  const send = (req, res, status, headers, body) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || "", "utf8");
    res.writeHead(status, { "Cache-Control": "no-cache", "Content-Length": buf.length, ...headers });
    res.end(req.method === "HEAD" ? undefined : buf);
    if (!quiet) log(`${req.method} ${req.url} ${status}`);
  };
  // The 404 page goes through resolvePath on the root alone (never an overlay), so it gets
  // the same case-sensitive lookup and realpath check as every other file: a 404.html
  // symlink pointing outside the root would otherwise be served on every miss.
  const notFound = async (req, res) => {
    const page = await resolvePath("/404.html", [{ segs: [], dir: base }]);
    if (page.file) return send(req, res, 404, { "Content-Type": TYPES[".html"] }, await readFile(page.file));
    send(req, res, 404, { "Content-Type": TYPES[".txt"] }, "404 Not Found\n");
  };
  return createHttpServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host, req.socket.localPort)) return send(req, res, 403, { "Content-Type": TYPES[".txt"] }, "403 Forbidden: unknown Host header\n");
      if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, { Allow: "GET, HEAD", "Content-Type": TYPES[".txt"] }, "405 Method Not Allowed\n");
      // The URL parser already folds "." and ".." segments (also %2e%2e), so a raw
      // "/../x" becomes "/x"; encoded separators are caught per segment in resolvePath.
      const url = requestUrl(req.url);
      if (!url) return send(req, res, 400, { "Content-Type": TYPES[".txt"] }, "400 Bad Request\n");
      const r = await resolvePath(url.pathname, mounts);
      if (r.badRequest) return send(req, res, 400, { "Content-Type": TYPES[".txt"] }, "400 Bad Request\n");
      if (r.redirect) return send(req, res, 301, { Location: r.redirect + url.search, "Content-Type": TYPES[".txt"] }, "301 Moved Permanently\n");
      if (r.file) return send(req, res, 200, { "Content-Type": typeOf(r.file) }, await readFile(r.file));
      return notFound(req, res);
    } catch (e) {
      if (!res.headersSent) send(req, res, 500, { "Content-Type": TYPES[".txt"] }, "500 Internal Server Error\n");
      else res.destroy(e);
    }
  });
}

/* ---------- CLI ---------- */
const USAGE = `Usage: node scripts/model-history/serve.mjs [--root <dir>] [--port <n>] [--overlay <prefix>=<dir>]... [--quiet]
  --root     directory to serve (default: the repository root)
  --port     port on ${HOST} (default: ${DEFAULT_PORT})
  --overlay  serve a path prefix from another directory, relative to --root; repeatable
             e.g. --overlay /models=.preview/models --overlay /sitemap-models.xml=.preview/sitemap-models.xml`;

// Run directly (not imported by the tests)? Node resolves the entry point with realpath, so
// compare real paths: a short 8.3 name or other letter case on Windows must still match.
function isMain() {
  try {
    const a = realpathSync(process.argv[1] || ""), b = fileURLToPath(import.meta.url);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
}

if (isMain()) {
  let opts;
  try { opts = parseCli(process.argv.slice(2)); } catch (e) { console.error(e.message + "\n\n" + USAGE); process.exit(2); }
  if (opts.help) { console.log(USAGE); process.exit(0); }
  if (!existsSync(opts.root)) { console.error(`Root does not exist: ${opts.root}`); process.exit(2); }
  // A missing overlay is only a warning: the preview build may run after the server starts.
  for (const o of opts.overlays) if (!existsSync(o.dir)) console.warn(`Warning: overlay ${o.prefix} → ${o.dir} does not exist (yet)`);
  const server = createServer({ root: opts.root, overlays: opts.overlays, quiet: opts.quiet });
  server.on("error", e => { console.error(e.code === "EADDRINUSE" ? `Port ${opts.port} is already in use (try --port)` : e.message); process.exit(1); });
  server.listen(opts.port, HOST, () => {
    const { port } = server.address();
    console.log(`Serving ${opts.root} on http://${HOST}:${port}/`);
    for (const o of opts.overlays) console.log(`  ${o.prefix}/ → ${o.dir}`);
  });
}
