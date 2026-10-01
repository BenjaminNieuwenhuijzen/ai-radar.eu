/* Tests for the source-health checker (spec §20). Only fake fetches: no test touches the
   network. End-to-end runs work on a temporary copy of fixtures/basic, never on the
   fixture itself. Run: node --test scripts/model-history/test/check-sources.test.mjs */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  run, observe, makeDeps, classify, classifyError, applyObservation, freshTracker, isDue, selectDue, trackersFor, isUnverifiable,
  parseRobots, robotsAllowed, parseCdx, pickCapture, sameDocument, isRoot, parseHtml, stableStringify, atLeastDays, publicHost, plain,
  UA, ACCEPT, MAX_BYTES
} from "../check-sources.mjs";
import { loadDataset, interval } from "../lib.mjs";
import { buildIndex, effAvail } from "../derive.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASIC = join(HERE, "fixtures", "basic");
const SCRIPT = join(HERE, "..", "check-sources.mjs");
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const copyFixture = () => { const d = mkdtempSync(join(tmpdir(), "mh-sources-")); temps.push(d); cpSync(BASIC, d, { recursive: true }); return d; };
const readJ = p => JSON.parse(readFileSync(p, "utf8"));
const editJ = (p, fn) => { const j = readJ(p); fn(j); writeFileSync(p, JSON.stringify(j, null, 2) + "\n"); };
const statePath = dir => join(dir, "state", "source-status.json");
// Day n after 2026-10-06 03:41 UTC (the fixture state was last written on 2026-10-05).
const at = (n, hh = 3, mm = 41) => new Date(Date.UTC(2026, 9, 6 + n, hh, mm)).toISOString().replace(".000Z", "Z");

/* ---------- Fake network ---------- */
const page = (title, { extra = "", h1 = title, pad = 5000 } = {}) =>
  `<!doctype html><html><head><title>${title}</title>${extra}</head><body><h1>${h1}</h1><p>${"x".repeat(pad)}</p></body></html>`;
const JSON_CT = { "content-type": "application/json" };
function defaultRoute(url) {
  if (url.endsWith("/robots.txt")) return { status: 404, body: "" };
  if (url.startsWith("https://web.archive.org/cdx/")) return { status: 200, body: "[]", headers: JSON_CT };
  if (url.startsWith("https://archive.org/wayback/available")) return { status: 200, body: "{}", headers: JSON_CT };
  return { status: 200, body: page("Page " + new URL(url).pathname) };
}
// route(url, init) returns a response spec, an Error to throw, or undefined for the default.
function fakeFetch(route = () => undefined, calls = [], clock = null) {
  return async (url, init) => {
    calls.push({ url, init, t: clock ? clock() : 0 });
    let r = route(url, init);
    if (r === undefined) r = defaultRoute(url);
    if (r instanceof Error) throw r;
    const headers = { ...(r.headers || {}) };
    if (r.location) headers.location = r.location;
    if (r.body != null && !headers["content-type"]) headers["content-type"] = "text/html; charset=utf-8";
    return new Response(r.body ?? null, { status: r.status || 200, headers });
  };
}
const byUrl = map => url => map[url];
const netError = code => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
const noSleep = async () => {};

// One observation of a URL through the real request path.
async function see(route, url = "https://example.org/docs/orbit", baseline = null, extra = {}) {
  const calls = [];
  const d = makeDeps({ fetchImpl: fakeFetch(route, calls), sleep: noSleep, respectRobots: false, ...extra });
  const o = await observe(url, d, baseline);
  return { ...o, calls };
}
const U = "https://example.org/docs/orbit";

/* ---------- Classification (§20.3), one test per row ---------- */
test("row 1: 401, 403, 429 and challenge pages are blocked (non-decisive)", async () => {
  for (const status of [401, 403, 429]) assert.equal((await see(byUrl({ [U]: { status, body: page("Denied") } }))).result, "blocked", `HTTP ${status}`);
  assert.equal((await see(byUrl({ [U]: { status: 503, body: page("Just a moment..."), headers: { "cf-mitigated": "challenge" } } }))).result, "blocked");
  assert.equal((await see(byUrl({ [U]: { status: 200, body: page("Orbit"), headers: { "cf-mitigated": "challenge" } } }))).result, "blocked");
  assert.equal((await see(byUrl({ [U]: { status: 200, body: page("Just a moment...") } }))).result, "blocked");
  assert.equal((await see(byUrl({ [U]: { status: 202, body: "", headers: { "x-amzn-waf-action": "challenge" } } }))).result, "blocked");
  // Row 1 wins over rows 3 and 6.
  assert.equal((await see(byUrl({ [U]: { status: 403, body: page("Page not found") } }))).result, "blocked");
  assert.equal((await see(byUrl({ [U]: { status: 404, body: page("x"), headers: { "cf-mitigated": "challenge" } } }))).result, "blocked");
});

test("row 2: 5xx, timeout, TLS errors and dropped connections are error (non-decisive)", async () => {
  for (const status of [500, 502, 503]) assert.equal((await see(byUrl({ [U]: { status, body: page("Oops") } }))).result, "error");
  const timeout = await see(byUrl({ [U]: new DOMException("The operation was aborted due to timeout", "TimeoutError") }));
  assert.deepEqual([timeout.result, timeout.detail, timeout.httpStatus], ["error", "timeout", null]);
  assert.equal((await see(byUrl({ [U]: netError("CERT_HAS_EXPIRED") }))).result, "error");
  assert.equal((await see(byUrl({ [U]: netError("ECONNRESET") }))).result, "error");
  assert.equal((await see(byUrl({ [U]: netError("EAI_AGAIN") }))).result, "error", "temporary DNS failure is not NXDOMAIN");
  assert.equal(classifyError(new TypeError("fetch failed", { cause: { errors: [{ code: "ECONNREFUSED" }] } })).result, "error");
});

test("row 3: 404 and 410 are gone (decisive)", async () => {
  for (const status of [404, 410]) {
    const o = await see(byUrl({ [U]: { status, body: page("Not here") } }));
    assert.deepEqual([o.result, o.httpStatus], ["gone", status]);
    assert.equal(o.fingerprint.title, "Not here", "the last fingerprint describes the error page");
  }
});

test("row 4: DNS NXDOMAIN and parked domains are gone", async () => {
  assert.deepEqual((await see(byUrl({ [U]: netError("ENOTFOUND") }))).result, "gone");
  assert.equal((await see(byUrl({ [U]: { status: 200, body: page("example.org - This domain is for sale!") } }))).result, "gone");
  const parked = await see(byUrl({ [U]: { status: 302, location: "https://www.sedoparking.com/example.org" }, "https://www.sedoparking.com/example.org": { status: 200, body: page("Welcome") } }));
  assert.equal(parked.result, "gone");
});

test("row 5: a redirect to the site root or to a page with soft-404 signals is soft-404", async () => {
  const root = await see(byUrl({ [U]: { status: 301, location: "/" } }));
  assert.deepEqual([root.result, root.finalUrl], ["soft-404", "https://example.org/"]);
  assert.equal((await see(byUrl({ [U]: { status: 302, location: "https://example.org/en-us/" } }))).result, "soft-404", "locale root");
  assert.equal((await see(byUrl({ [U]: { status: 302, location: "https://example.org/404.html" } }))).result, "soft-404");
  assert.equal((await see(byUrl({ [U]: { status: 301, location: "/docs/other" }, "https://example.org/docs/other": { status: 200, body: page("Page not found") } }))).result, "soft-404");
  // Row 3 has precedence: a redirect to the root that ends in a 404 is gone.
  assert.equal((await see(byUrl({ [U]: { status: 301, location: "/" }, "https://example.org/": { status: 404, body: page("x") } }))).result, "gone");
});

test("row 6: 200 with a not-found title or heading, a canonical to the root, or much smaller content is soft-404", async () => {
  assert.equal((await see(byUrl({ [U]: { status: 200, body: page("404 | Example") } }))).result, "soft-404");
  assert.equal((await see(byUrl({ [U]: { status: 200, body: page("Example docs", { h1: "Sorry, this page can’t be found" }) } }))).result, "soft-404");
  assert.equal((await see(byUrl({ [U]: { status: 200, body: page("Example docs", { extra: '<link rel="canonical" href="https://example.org/">' }) } }))).result, "soft-404");
  const base = { title: "Orbit docs", bytes: 50000, truncated: false };
  const small = await see(byUrl({ [U]: { status: 200, body: page("Orbit docs", { pad: 100 }) } }), U, base);
  assert.equal(small.result, "soft-404");
  assert.match(small.detail, /much smaller/);
});

test("row 6: the size rule is skipped when either read hit the limit", async () => {
  const small = byUrl({ [U]: { status: 200, body: page("Orbit docs", { pad: 100 }) } });
  assert.equal((await see(small, U, { title: "Orbit docs", bytes: MAX_BYTES, truncated: true })).result, "ok", "first read truncated");
  const big = await see(byUrl({ [U]: { status: 200, body: page("Orbit docs", { pad: 300 * 1024 }) } }), U, { title: "Orbit docs", bytes: 2 * 1024 * 1024, truncated: false });
  assert.equal(big.result, "ok", "current read truncated");
  assert.deepEqual([big.fingerprint.bytes, big.fingerprint.truncated], [MAX_BYTES, true]);
});

test("row 6: a title that is unchanged since the first ok is not a soft-404 signal", async () => {
  const o = await see(byUrl({ [U]: { status: 200, body: page("Error 404 explained") } }), U, { title: "Error 404 explained", bytes: 5100, truncated: false });
  assert.equal(o.result, "ok");
});

test("row 6: only typical error titles count, so a real document about 404s is ok on its first check", async () => {
  for (const title of ["HTTP 404 explained", "Why your API returns 404 | Example Lab", "Kubernetes: fixing image not found errors"]) {
    assert.equal((await see(byUrl({ [U]: { status: 200, body: page(title) } }))).result, "ok", title);
  }
  assert.equal((await see(byUrl({ [U]: { status: 200, body: page("HTTP status codes", { h1: "HTTP 404 and 410 compared" }) } }))).result, "ok", "a bare 404 inside a heading");
  for (const title of ["404 Not Found", "Page not found – Example Lab", "Example Lab: Page Not Found", "Error 404 - Example", "Oops! That page can’t be found.", "Not Found"]) {
    assert.equal((await see(byUrl({ [U]: { status: 200, body: page(title, { h1: "Example" }) } }))).result, "soft-404", title);
  }
  assert.equal((await see(byUrl({ [U]: { status: 200, body: page("Example Lab", { h1: "404" }) } }))).result, "soft-404", "heading that is only 404");
  assert.equal((await see(byUrl({ [U]: { status: 200, body: page("Example Lab", { h1: "Sorry, we couldn't find that page" }) } }))).result, "soft-404");
});

test("root rule: only real locale roots, and only on the same site", async () => {
  const to = (location, target, body = page("Other")) => byUrl({ [U]: { status: 301, location }, [target]: { status: 200, body } });
  assert.equal((await see(to("/ai/", "https://example.org/ai/"))).result, "moved", "/ai/ is not a locale");
  assert.equal((await see(to("/go", "https://example.org/go"))).result, "moved");
  assert.equal((await see(to("/de-de/", "https://example.org/de-de/"))).result, "soft-404", "a real locale root");
  assert.equal((await see(to("https://orbit.example/", "https://orbit.example/"))).result, "moved", "root of another site: a real move");
  assert.equal((await see(to("https://www.example.org/", "https://www.example.org/"))).result, "soft-404", "www is the same site");
  assert.ok(!isRoot("https://example.org/ai/") && !isRoot("https://example.org/ml") && isRoot("https://example.org/zh-hans/") && isRoot("https://example.org/es-419"));
  const canonicalElsewhere = await see(byUrl({ [U]: { status: 200, body: page("Orbit", { extra: '<link rel="canonical" href="https://orbit.example/">' }) } }));
  assert.equal(canonicalElsewhere.result, "ok", "canonical to the root of another site");
});

test("a challenge header value is not echoed into the detail (it reaches the public summary)", async () => {
  const o = await see(byUrl({ [U]: { status: 403, body: page("x"), headers: { "cf-mitigated": "challenge" } } }));
  assert.equal(o.result, "blocked");
  const c = await see(byUrl({ [U]: { status: 200, body: page("Orbit"), headers: { "cf-mitigated": "challenge [x](https://evil.example/)" } } }));
  assert.deepEqual([c.result, c.detail], ["blocked", "challenge page (cf-mitigated)"]);
  assert.equal(plain("a `b` [x](https://e.example/) <img src=x>"), "a b x(https://e.example/) img srcx");
});

test("non-public hosts are never requested, also not as a redirect target", async () => {
  for (const url of ["http://127.0.0.1/x", "http://localhost:8080/x", "http://[::1]/x", "http://10.1.2.3/x", "http://169.254.169.254/latest/meta-data/",
    "http://printer.local/x", "http://metadata/x", "http://[::ffff:127.0.0.1]/x", "http://2130706433/x"]) {
    const o = await see(() => undefined, url, null, { respectRobots: true });
    assert.deepEqual([o.result, o.detail, o.calls.length], ["error", "non-public address", 0], url);
  }
  const hop = await see(byUrl({ [U]: { status: 302, location: "http://192.168.1.1/admin" } }));
  assert.deepEqual([hop.result, hop.detail, hop.calls.map(c => c.url)], ["error", "non-public address", [U]]);
  assert.ok(publicHost("https://example.org/") && publicHost("https://8.8.8.8/") && publicHost("https://[2001:4860:4860::8888]/"));
  assert.ok(!publicHost("http://[fd00::1]/") && !publicHost("http://[fe80::1]/") && !publicHost("http://172.20.0.1/") && !publicHost("http://100.64.0.1/"));
});

test("row 7: a redirect to the same document is ok (scheme, www, slash, case, Wayback timestamp)", async () => {
  const cases = [
    ["http://example.org/docs/orbit", "https://example.org/docs/orbit"],
    ["https://example.org/docs/orbit", "https://www.example.org/docs/orbit/"],
    ["https://example.org/Docs/Orbit", "https://example.org/docs/orbit"]
  ];
  for (const [from, to] of cases) {
    const o = await see(byUrl({ [from]: { status: 301, location: to }, [to]: { status: 200, body: page("Orbit") } }), from);
    assert.deepEqual([o.result, o.finalUrl], ["ok", to], from);
  }
  const wb = "https://web.archive.org/web/20210401000000/https://docs.example.org/orbit-1";
  const wbReal = "https://web.archive.org/web/20210401093012/https://docs.example.org/orbit-1";
  assert.equal((await see(byUrl({ [wb]: { status: 302, location: wbReal }, [wbReal]: { status: 200, body: page("Orbit 1") } }), wb)).result, "ok");
  const wbFar = "https://web.archive.org/web/20240101000000/https://docs.example.org/orbit-1";
  assert.equal((await see(byUrl({ [wb]: { status: 302, location: wbFar }, [wbFar]: { status: 200, body: page("Orbit 1") } }), wb)).result, "moved", "another version");
});

test("row 8: a redirect to another path without soft-404 signals is moved, with finalUrl", async () => {
  const to = "https://docs.example.org/v2/orbit";
  const o = await see(byUrl({ [U]: { status: 308, location: to }, [to]: { status: 200, body: page("Orbit v2") } }));
  assert.deepEqual([o.result, o.finalUrl, o.httpStatus], ["moved", to, 200]);
});

test("row 9: 2xx with content is ok; uncovered answers are non-decisive errors", async () => {
  const o = await see(byUrl({ [U]: { status: 200, body: page("Orbit") } }));
  assert.deepEqual([o.result, o.finalUrl, o.fingerprint.title], ["ok", null, "Orbit"]);
  const pdf = await see(byUrl({ [U]: { status: 200, body: "%PDF-1.7 ...", headers: { "content-type": "application/pdf" } } }));
  assert.deepEqual([pdf.result, pdf.fingerprint.title], ["ok", null]);
  assert.equal((await see(byUrl({ [U]: { status: 200, body: "" } }))).result, "error", "empty");
  assert.equal((await see(byUrl({ [U]: { status: 400, body: page("Bad") } }))).result, "error", "other 4xx");
  assert.equal((await see(byUrl({ [U]: { status: 301, location: U } }))).result, "error", "loop");
  const hops = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`https://example.org/r${i}`, { status: 302, location: `/r${i + 1}` }]));
  const many = await see(byUrl(hops), "https://example.org/r0");
  assert.equal(many.result, "error");
  assert.match(many.detail, /more than 5 redirects/);
  assert.equal((await see(() => undefined, "ftp://example.org/x")).result, "error");
});

test("classify() can be called directly with an observation", () => {
  const base = { status: 200, headers: new Headers(), requestedUrl: U, finalUrl: U, title: "Orbit", heading: "Orbit", canonical: null, bytes: 5000, truncated: false };
  assert.equal(classify(base).result, "ok");
  assert.equal(classify({ robots: "robots.txt disallows this URL" }).result, "blocked");
  assert.equal(classify({ ...base, finalUrl: "https://example.org/" }).result, "soft-404");
});

test("helpers: sameDocument, isRoot, parseHtml", () => {
  assert.ok(sameDocument("http://Example.org/a/", "https://www.example.org/A"));
  assert.ok(!sameDocument("https://example.org/a", "https://example.org/b"));
  assert.ok(!sameDocument("https://example.org/a?x=1", "https://example.org/a?x=2"));
  assert.ok(isRoot("https://example.org/") && isRoot("https://example.org/en/") && isRoot("https://example.org/index.html"));
  assert.ok(!isRoot("https://example.org/blog/x") && !isRoot("https://example.org/?p=12"));
  assert.deepEqual(parseHtml(`<head><title> A &amp; B&#39;s\n page </title><link href='/c' rel="canonical"></head><h1><span>Hi</span> there</h1>`),
    { title: "A & B's page", heading: "Hi there", canonical: "/c" });
});

test("parseHtml stays linear on hostile bodies (unclosed and overlapping tags)", () => {
  const bodies = ["<title>x".repeat(20000), "<h1>".repeat(30000), "<link rel=canonical href=/ ".repeat(10000), "<link ".repeat(40000) + ">",
    "<title>" + "<".repeat(200000) + "</title>"];
  for (const body of bodies) {
    const t0 = performance.now();
    parseHtml(body);
    const ms = performance.now() - t0;
    assert.ok(ms < 250, `${body.slice(0, 12)}…: ${Math.round(ms)} ms`);
  }
  assert.deepEqual(parseHtml("<title>x".repeat(20000)), { title: null, heading: null, canonical: null });
  const many = '<link rel="stylesheet" href="/a.css">'.repeat(500) + '<link rel="canonical" href="https://example.org/x">';
  assert.equal(parseHtml(many).canonical, "https://example.org/x");
});

/* ---------- Request shape and politeness (§20.2) ---------- */
test("requests are GET with the bot User-Agent, the Accept header, manual redirects and a timeout", async () => {
  const o = await see(byUrl({ [U]: { status: 301, location: "/docs/orbit-2" } }));
  assert.equal(o.calls.length, 2, "the redirect is followed by hand");
  for (const c of o.calls) {
    assert.equal(c.init.method, "GET");
    assert.equal(c.init.redirect, "manual");
    assert.equal(c.init.headers["user-agent"], UA);
    assert.equal(c.init.headers.accept, ACCEPT);
    assert.ok(c.init.signal instanceof AbortSignal);
  }
  assert.equal(UA, "Mozilla/5.0 (compatible; AIRadarBot/1.0)");
});

test("per host sequential with at least 5 s between requests; other hosts are not delayed", async () => {
  let t = 0;
  const clock = () => t, sleeps = [];
  const sleep = async ms => { sleeps.push(ms); t += ms; };
  const calls = [];
  const d = makeDeps({ fetchImpl: fakeFetch(() => undefined, calls, clock), sleep, clock, respectRobots: false });
  await Promise.all([observe("https://a.example/1", d), observe("https://a.example/2", d), observe("https://b.example/1", d), observe("https://a.example/3", d)]);
  const aTimes = calls.filter(c => c.url.startsWith("https://a.example/")).map(c => c.t);
  assert.equal(aTimes.length, 3);
  for (let i = 1; i < aTimes.length; i++) assert.ok(aTimes[i] - aTimes[i - 1] >= 5000, `gap ${aTimes[i] - aTimes[i - 1]}`);
  assert.deepEqual(sleeps, [5000, 5000], "only the second and third request to a.example wait; b.example does not");
});

/* ---------- robots.txt (O5: respected by default) ---------- */
test("robots.txt: parser follows RFC 9309 (own group over *, longest match, allow on a tie, * and $)", () => {
  const g = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: AIRadarBot\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$\n# comment\n");
  assert.ok(robotsAllowed(g, "https://example.org/docs"));
  assert.ok(!robotsAllowed(g, "https://example.org/private/x"));
  assert.ok(robotsAllowed(g, "https://example.org/private/open/x"));
  assert.ok(!robotsAllowed(g, "https://example.org/files/a.pdf"));
  assert.ok(robotsAllowed(g, "https://example.org/files/a.pdf?x=1"));
  assert.ok(!robotsAllowed(parseRobots("User-agent: *\nDisallow: /"), "https://example.org/docs"));
  assert.ok(robotsAllowed(parseRobots("User-agent: *\nDisallow:"), "https://example.org/docs"));
  assert.ok(robotsAllowed(parseRobots("User-agent: *\nDisallow: /a\nAllow: /a"), "https://example.org/a"), "allow wins a tie");
});

test("robots.txt: a disallow makes the check blocked without requesting the page", async () => {
  const route = byUrl({ "https://example.org/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /docs/", headers: { "content-type": "text/plain" } } });
  const o = await see(route, U, null, { respectRobots: true });
  assert.deepEqual([o.result, o.detail], ["blocked", "robots.txt disallows this URL"]);
  assert.deepEqual(o.calls.map(c => c.url), ["https://example.org/robots.txt"]);
  const off = await see(route, U, null, { respectRobots: false });
  assert.equal(off.result, "ok", "--no-respect-robots");
});

test("robots.txt: 404 allows, 5xx counts as disallow, NXDOMAIN still yields gone; fetched once per origin", async () => {
  const calls = [];
  const d = makeDeps({ fetchImpl: fakeFetch(() => undefined, calls), sleep: noSleep, respectRobots: true });
  assert.equal((await observe("https://example.org/a", d)).result, "ok");
  assert.equal((await observe("https://example.org/b", d)).result, "ok");
  assert.equal(calls.filter(c => c.url.endsWith("/robots.txt")).length, 1);
  assert.equal((await see(byUrl({ "https://example.org/robots.txt": { status: 503, body: "" } }), U, null, { respectRobots: true })).result, "blocked");
  assert.equal((await see(url => netError("ENOTFOUND"), U, null, { respectRobots: true })).result, "gone");
});

test("robots.txt: non-ASCII and astral rules are encoded per code point; a rule that cannot be encoded is ignored", async () => {
  const g = parseRobots("User-agent: *\nDisallow: /\u{1F600}\nDisallow: /café\n");
  assert.ok(!robotsAllowed(g, "https://example.org/\u{1F600}/x"), "emoji path");
  assert.ok(!robotsAllowed(g, "https://example.org/%F0%9F%98%80/x"));
  assert.ok(!robotsAllowed(g, "https://example.org/caf%C3%A9"));
  assert.ok(robotsAllowed(g, "https://example.org/docs"));
  // A lone surrogate (only possible when parseRobots gets a JS string) must not throw.
  const lone = parseRobots("User-agent: *\nDisallow: /\uD83D\nDisallow: /private\n");
  assert.ok(robotsAllowed(lone, "https://example.org/docs"));
  assert.ok(!robotsAllowed(lone, "https://example.org/private/x"));
  const route = byUrl({ "https://example.org/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /\u{1F600}\n", headers: { "content-type": "text/plain; charset=utf-8" } } });
  assert.deepEqual([(await see(route, "https://example.org/\u{1F600}/orbit", null, { respectRobots: true })).result,
    (await see(route, U, null, { respectRobots: true })).result], ["blocked", "ok"]);
});

test("robots.txt: Sitemap and other records do not split a group; percent-escapes compare case-insensitively", () => {
  const g = parseRobots("User-agent: AIRadarBot\nSitemap: https://example.org/sitemap.xml\nUser-agent: other\nDisallow: /\n\nUser-agent: *\nAllow: /\n");
  assert.ok(!robotsAllowed(g, "https://example.org/docs"), "the Disallow belongs to AIRadarBot too (RFC 9309, Google)");
  const c = parseRobots("User-agent: *\nCrawl-delay: 10\nDisallow: /a%3c\n");
  assert.ok(!robotsAllowed(c, "https://example.org/a%3Cb"));
  assert.ok(!robotsAllowed(c, "https://example.org/a<b"), "the URL parser encodes < as %3C");
});

test("robots.txt: a hostile wildcard rule cannot stall the matcher", () => {
  const g = parseRobots("User-agent: *\nDisallow: /" + "*e".repeat(40) + "*z\n" + "Disallow: /" + "*".repeat(5000) + "q\n");
  const t0 = performance.now();
  assert.ok(robotsAllowed(g, "https://example.org/" + "e".repeat(200) + "-release-notes-were-here-before-the-rename"));
  assert.ok(performance.now() - t0 < 200, `${Math.round(performance.now() - t0)} ms`);
});

test("robots.txt: a robots lookup that fails unexpectedly counts as a disallow (blocked), nothing is requested", async () => {
  const calls = [];
  const d = makeDeps({ fetchImpl: fakeFetch(() => undefined, calls), sleep: noSleep, respectRobots: true });
  d.robots = async () => { throw new URIError("URI malformed"); };
  const o = await observe(U, d);
  assert.deepEqual([o.result, o.detail, calls.length], ["blocked", "robots.txt unreadable (treated as disallow)", 0]);
});

/* ---------- Hysteresis (§20.4) ---------- */
const O = result => ({ result, httpStatus: result === "ok" ? 200 : result === "gone" ? 404 : null, finalUrl: null,
  fingerprint: result === "ok" ? { title: "Orbit", bytes: 5000, truncated: false } : null });
const seq = (results, days, start = freshTracker()) => results.reduce((t, r, i) => applyObservation(t, O(r), at(days[i])), start);

test("3 decisive failures over 9 days make a source unavailable", () => {
  const t = seq(["gone", "soft-404", "gone"], [0, 3, 9]);
  assert.deepEqual([t.state, t.stateSince, t.consecutiveFailures, t.firstFailureAt], ["unavailable", at(9), 3, at(0)]);
});

test("3 decisive failures within 5 days are not enough; a later one completes the span", () => {
  const t = seq(["gone", "gone", "gone"], [0, 2, 5]);
  assert.deepEqual([t.state, t.stateSince, t.consecutiveFailures], ["unknown", null, 3]);
  const t2 = applyObservation(t, O("gone"), at(9));
  assert.deepEqual([t2.state, t2.stateSince], ["unavailable", at(9)]);
});

test("non-decisive results neither count nor break the streak (fail, blocked, fail, fail)", () => {
  const t = seq(["gone", "blocked", "gone", "gone"], [0, 3, 6, 9]);
  assert.deepEqual([t.state, t.consecutiveFailures, t.lastResult], ["unavailable", 3, "gone"]);
  const t2 = seq(["gone", "error", "moved", "blocked"], [0, 3, 6, 9]);
  assert.deepEqual([t2.consecutiveFailures, t2.firstFailureAt, t2.lastDefinitiveAt], [1, at(0), at(0)]);
});

test("one ok resets the streak and makes the source active", () => {
  const start = seq(["ok"], [0]);
  const t = seq(["gone", "gone", "ok", "gone", "gone"], [1, 4, 7, 10, 13], start);
  assert.deepEqual([t.state, t.consecutiveFailures, t.firstFailureAt, t.lastOkAt], ["active", 2, at(10), at(7)]);
  const down = seq(["gone", "gone", "gone"], [0, 3, 9]);
  const up = applyObservation(down, O("ok"), at(12));
  assert.deepEqual([up.state, up.stateSince, up.consecutiveFailures, up.firstFailureAt], ["active", at(12), 0, null]);
});

test("intervals are elapsed time with a 2-hour drift tolerance, not calendar days", () => {
  const fails = whens => whens.reduce((x, when) => applyObservation(x, O("gone"), when), freshTracker());
  assert.equal(fails([at(0, 3, 41), at(3, 3, 40), at(9, 3, 39)]).state, "unavailable", "cron drift of minutes does not cost a run");
  // 8 days 0 h 2 min: calendar days counted this as 9, which declared the source dead a day early.
  const late = fails(["2026-10-01T23:59:00Z", "2026-10-05T03:41:00Z", "2026-10-10T00:01:00Z"]);
  assert.deepEqual([late.state, late.consecutiveFailures], ["unknown", 3]);
  assert.ok(!atLeastDays("2026-10-01T23:59:00Z", "2026-10-02T00:01:00Z", 1));
  assert.ok(atLeastDays(at(0, 3, 41), at(6, 1, 45), 6) && !atLeastDays(at(0, 3, 41), at(6, 1, 30), 6));
  const tr = { lastResult: "ok", lastCheckedAt: at(0, 3, 41), consecutiveFailures: 0 };
  assert.ok(isDue(tr, at(6, 1, 45)) && !isDue(tr, at(6, 1, 30)));
});

test("stateSince changes only on a transition; lastCheckedAt on every check", () => {
  const t1 = applyObservation(freshTracker(), O("ok"), at(0));
  const t2 = applyObservation(t1, O("ok"), at(6));
  const t3 = applyObservation(t2, O("blocked"), at(12));
  assert.deepEqual([t1.state, t1.stateSince], ["active", at(0)]);
  assert.deepEqual([t2.stateSince, t2.lastCheckedAt, t2.lastDefinitiveAt], [at(0), at(6), at(6)]);
  assert.deepEqual([t3.stateSince, t3.lastCheckedAt, t3.lastDefinitiveAt, t3.lastResult], [at(0), at(12), at(6), "blocked"]);
  assert.deepEqual(t2.firstFingerprint, t1.firstFingerprint, "the first fingerprint is kept");
});

test("the first verdict is a transition dated when it is made (§17.4, §20.5): no backdating to a curator verdict", () => {
  const archiveUrl = "https://web.archive.org/web/20210401000000/" + U;
  const t1 = applyObservation(freshTracker(), O("ok"), at(0));
  assert.deepEqual([t1.state, t1.stateSince, t1.lastCheckedAt], ["active", at(0), at(0)]);
  // An old curator verdict: the page came back, and the first ok says so.
  assert.equal(effAvail({ id: "src.x.y", url: U, availability: "unavailable", lastCheckedAt: "2025-01-01" }, t1), "active");
  // AC-12: a curator verdict of the same day (date only = end of that day) is not outranked,
  // and later oks without a transition do not undo it.
  const src = { id: "src.x.y", url: U, archiveUrl, availability: "archived", lastCheckedAt: at(0).slice(0, 10) };
  assert.equal(effAvail(src, t1), "archived");
  const t2 = applyObservation(t1, O("ok"), at(6));
  assert.deepEqual([t2.stateSince, effAvail(src, t2)], [at(0), "archived"]);
  // A real later transition wins over the curator again.
  const down = seq(["gone", "gone", "gone"], [12, 15, 21], t2);
  const up = applyObservation(down, O("ok"), at(24));
  assert.deepEqual([down.stateSince, up.state, up.stateSince], [at(21), "active", at(24)]);
  assert.equal(effAvail(src, up), "active");
});

test("AC-09: ten non-decisive results in a row change nothing, also not the effective availability", () => {
  const kinds = ["blocked", "error", "blocked", "error", "blocked", "error", "moved", "blocked", "error", "blocked"];
  for (const start of [seq(["ok"], [0]), seq(["gone", "gone", "gone"], [0, 3, 9])]) {
    const t = kinds.reduce((x, r, i) => applyObservation(x, O(r), at(20 + 3 * i)), start);
    assert.deepEqual([t.state, t.stateSince, t.consecutiveFailures], [start.state, start.stateSince, start.consecutiveFailures]);
    const src = { id: "src.x.y", availability: "active", lastCheckedAt: "2026-10-01", url: U };
    assert.equal(effAvail(src, t), effAvail(src, start));
  }
});

test("unverifiable: at least 90 days with only non-decisive results", () => {
  const now = "2026-12-31T03:41:00Z";
  assert.ok(isUnverifiable({ lastCheckedAt: now, lastResult: "blocked", lastDefinitiveAt: "2026-09-01T00:00:00Z" }, now));
  assert.ok(!isUnverifiable({ lastCheckedAt: now, lastResult: "blocked", lastDefinitiveAt: "2026-11-01T00:00:00Z" }, now));
  assert.ok(isUnverifiable({ lastCheckedAt: now, lastResult: "error", lastDefinitiveAt: null, firstCheckedAt: "2026-09-01T00:00:00Z" }, now));
  assert.ok(!isUnverifiable({ lastCheckedAt: now, lastResult: "ok", lastDefinitiveAt: now }, now));
});

/* ---------- Due selection (§20.2) ---------- */
test("due: a running streak of decisive failures after 3 days, everything else after 6, never checked always", () => {
  const tr = (r, consecutiveFailures = 0) => ({ lastResult: r, lastCheckedAt: at(0), consecutiveFailures });
  assert.ok(isDue(null, at(0)) && isDue(freshTracker(), at(0)));
  for (const r of ["ok", "moved", "blocked", "error"]) assert.ok(!isDue(tr(r), at(5)) && isDue(tr(r), at(6)), `${r} without a streak`);
  // A running streak keeps the short interval, also when the last result was non-decisive.
  for (const r of ["gone", "soft-404", "blocked", "error", "moved"]) assert.ok(!isDue(tr(r, 1), at(2)) && isDue(tr(r, 1), at(3)), `${r} in a streak`);
});

test("due selection: never-checked first, then the oldest lastCheckedAt, capped", () => {
  const item = (id, orig, archive = null) => ({ src: { id }, orig: { ...freshTracker(), ...orig }, archive });
  const items = [
    item("src.x.c", { lastResult: "ok", lastCheckedAt: at(-7) }),
    item("src.x.e", { lastResult: "ok", lastCheckedAt: at(-2) }),                       // not due
    item("src.x.b", { lastResult: "ok", lastCheckedAt: at(-10) }),
    item("src.x.d", { lastResult: "gone", lastCheckedAt: at(-3), consecutiveFailures: 1 }),
    item("src.x.f", { lastResult: "blocked", lastCheckedAt: at(-3) }),                  // not due: no streak
    item("src.x.z", {}),
    item("src.x.a", { lastResult: "ok", lastCheckedAt: at(-1) }, { ...freshTracker(), url: "https://web.archive.org/web/20200101000000/x" })
  ];
  const all = selectDue(items, at(0), 300);
  assert.deepEqual(all.selected.map(s => s.item.src.id), ["src.x.a", "src.x.z", "src.x.b", "src.x.c", "src.x.d"]);
  assert.deepEqual(all.selected[0].targets, ["archive"], "only the due URL of a source is checked");
  const capped = selectDue(items, at(0), 2);
  assert.deepEqual(capped.selected.map(s => s.item.src.id), ["src.x.a", "src.x.z"]);
  assert.deepEqual(capped.deferred.map(s => s.item.src.id), ["src.x.b", "src.x.c", "src.x.d"]);
});

/* ---------- Archive suggestions (§20.6) ---------- */
test("pickCapture: closest to publishedAt (inside the interval counts as 0, earliest wins), latest without a date", () => {
  const ts = ["20240501000000", "20240613120000", "20240612010203", "20250101000000"];
  assert.equal(pickCapture(ts, interval("2024-06-11")), "20240612010203");
  assert.equal(pickCapture(ts, interval("2024-06")), "20240612010203");
  assert.equal(pickCapture(ts, interval("2024-05-02")), "20240501000000");
  assert.equal(pickCapture(ts, null), "20250101000000");
  assert.equal(pickCapture([], null), null);
  const cdx = JSON.stringify([["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
    ["k", "20240612010203", "https://example.org/x", "text/html", "200", "D", "1"], ["k", "20240612", "bad", "text/html", "200", "D", "1"],
    ["k", "20240613010203", "https://example.org/x", "text/html", "301", "D", "1"]]);
  assert.deepEqual(parseCdx(cdx), ["20240612010203"]);
  assert.deepEqual(parseCdx("[]"), []);
});

/* ---------- End to end on a copy of the fixture ---------- */
async function runOn(dir, now, route = () => undefined, extra = {}) {
  const calls = [], logs = [];
  const res = await run({ data: dir, now, fetchImpl: fakeFetch(route, calls, extra.clock || null), sleep: noSleep, log: m => logs.push(m), summaryFile: null, ...extra });
  return { ...res, calls, logs };
}
function snapshot(dir) {
  const out = {};
  const walk = rel => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(join(dir, r)).isDirectory()) walk(r);
      else out[r] = createHash("sha256").update(readFileSync(join(dir, r))).digest("hex");
    }
  };
  walk("");
  return out;
}

test("AC-08: three 404s over 9 days → unavailable in state/; curator files byte-identical, nothing else written", async () => {
  const dir = copyFixture();
  const before = snapshot(dir);
  const launch = "https://example.org/blog/orbit-2";
  const route = byUrl({ [launch]: { status: 404, body: page("Page not found") } });
  for (const n of [0, 3, 9]) await runOn(dir, at(n), route);
  const st = readJ(statePath(dir));
  const e = st.sources["src.example-lab.orbit-2-launch"];
  assert.deepEqual([e.state, e.stateSince, e.consecutiveFailures, e.lastResult, e.httpStatus], ["unavailable", at(9), 3, "gone", 404]);
  const afterSnap = snapshot(dir);
  for (const [file, hash] of Object.entries(before)) if (file !== "state/source-status.json") assert.equal(afterSnap[file], hash, file);
  assert.deepEqual(Object.keys(afterSnap).sort(), Object.keys(before).sort(), "no files added or removed");
  // The model keeps its record; only the machine state changed.
  const ds = loadDataset(dir);
  assert.ok(ds.models.some(m => m.id === "example-lab.orbit-2"));
  const idx = buildIndex(ds);
  assert.equal(effAvail(idx.srcById.get("src.example-lab.orbit-2-launch"), idx.status["src.example-lab.orbit-2-launch"]), "unavailable");
});

test("archive copy: its own hysteresis gives archiveState gone, effAvail falls back and a suggestion is proposed", async () => {
  const dir = copyFixture();
  const archive = "https://web.archive.org/web/20210401000000/https://docs.example.org/orbit-1";
  const cdx = JSON.stringify([["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
    ["k", "20210310000000", "https://docs.example.org/orbit-1", "text/html", "200", "D", "1"]]);
  const route = url => {
    if (url === archive) return { status: 404, body: page("Wayback Machine") };
    if (url === "https://docs.example.org/orbit-1") return { status: 404, body: page("Not found") };
    if (url.startsWith("https://web.archive.org/cdx/") && url.includes(encodeURIComponent("https://docs.example.org/orbit-1"))) return { status: 200, body: cdx, headers: JSON_CT };
    return undefined;
  };
  const r1 = await runOn(dir, at(0), route);
  let e = r1.state.sources["src.example-lab.orbit-1-docs"];
  assert.deepEqual([e.archiveState, e.archiveCheck.url, e.archiveCheck.consecutiveFailures, e.archiveSuggestion], ["unknown", archive, 1, null]);
  let idx = buildIndex(loadDataset(dir));
  assert.equal(effAvail(idx.srcById.get("src.example-lab.orbit-1-docs"), idx.status["src.example-lab.orbit-1-docs"]), "archived");
  await runOn(dir, at(3), route);
  const r3 = await runOn(dir, at(9), route);
  e = r3.state.sources["src.example-lab.orbit-1-docs"];
  assert.deepEqual([e.state, e.archiveState, e.archiveCheck.stateSince], ["unavailable", "gone", at(9)]);
  assert.deepEqual(e.archiveSuggestion, { timestamp: "20210310000000", url: "https://web.archive.org/web/20210310000000/https://docs.example.org/orbit-1", via: "wayback-cdx-api" });
  idx = buildIndex(loadDataset(dir));
  assert.equal(effAvail(idx.srcById.get("src.example-lab.orbit-1-docs"), idx.status["src.example-lab.orbit-1-docs"]), "unavailable");
  assert.match(r3.markdown, /Now unavailable[\s\S]*orbit-1-docs` archive: gone/);
});

test("CDX suggestion: the query follows §20.6 and the closest capture to publishedAt is chosen", async () => {
  const dir = copyFixture();
  const cdxCalls = [];
  const rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
    ["k", "20240501000000", "https://example.org/blog/orbit-2", "text/html", "200", "D", "1"],
    ["k", "20240620000000", "https://example.org/blog/orbit-2", "text/html", "200", "D", "1"],
    ["k", "20240612010203", "http://user@example.org/blog/orbit-2", "text/html", "200", "D", "1"],
    ["k", "20250101000000", "https://example.org/blog/orbit-2", "text/html", "200", "D", "1"]];
  const route = url => {
    if (!url.startsWith("https://web.archive.org/cdx/")) return undefined;
    cdxCalls.push(url);
    return new URL(url).searchParams.get("url") === "https://example.org/blog/orbit-2" ? { status: 200, body: JSON.stringify(rows), headers: JSON_CT } : undefined;
  };
  const r = await runOn(dir, at(0), route);
  const e = r.state.sources["src.example-lab.orbit-2-launch"];
  assert.deepEqual(e.archiveSuggestion, { timestamp: "20240612010203", url: "https://web.archive.org/web/20240612010203/https://example.org/blog/orbit-2", via: "wayback-cdx-api" });
  const q = new URL(cdxCalls.find(u => new URL(u).searchParams.get("url") === "https://example.org/blog/orbit-2")).searchParams;
  assert.deepEqual([q.get("output"), q.get("filter"), q.get("from"), q.get("limit")], ["json", "statuscode:200", "20240611", "10"]);
  const noDate = new URL(cdxCalls.find(u => new URL(u).searchParams.get("url") === "https://example.org/blog/history")).searchParams;
  assert.deepEqual([noDate.get("from"), noDate.get("limit")], [null, "-10"], "no publishedAt: the latest captures");
  assert.equal(r.state.sources["src.example-lab.orbit-1-docs"].archiveSuggestion, null, "an active archive copy needs no suggestion");
  assert.match(r.markdown, /Archive suggestions[\s\S]*orbit-2-launch/);
});

test("Availability API is only the fallback; --no-archive-lookup makes no archive.org requests", async () => {
  const dir = copyFixture();
  const stamps = [];
  const route = url => {
    if (url.startsWith("https://archive.org/wayback/available") && new URL(url).searchParams.get("url") === "https://example.org/blog/orbit-2") {
      stamps.push(new URL(url).searchParams.get("timestamp"));
      return { status: 200, headers: JSON_CT, body: JSON.stringify({ archived_snapshots: { closest: { status: "200", available: true, url: "http://web.archive.org/web/20240615000000/https://example.org/blog/orbit-2", timestamp: "20240615000000" } } }) };
    }
    return undefined;   // the CDX API answers [] by default
  };
  const r = await runOn(dir, at(0), route);
  assert.deepEqual(stamps, ["20240611"]);
  assert.deepEqual(r.state.sources["src.example-lab.orbit-2-launch"].archiveSuggestion,
    { timestamp: "20240615000000", url: "https://web.archive.org/web/20240615000000/https://example.org/blog/orbit-2", via: "wayback-availability-api" });
  const dir2 = copyFixture();
  const r2 = await runOn(dir2, at(0), route, { archiveLookup: false });
  assert.ok(!r2.calls.some(c => /archive\.org\/(cdx|wayback)/.test(c.url)));
});

test("archive.org lookups are paced at one request per 2 s", async () => {
  const dir = copyFixture();
  let t = 0;
  const clock = () => t;
  const r = await runOn(dir, at(0), () => undefined, { clock, sleep: async ms => { t += ms; } });
  const times = r.calls.filter(c => /archive\.org\/(cdx|wayback)/.test(c.url)).map(c => c.t);
  assert.ok(times.length > 2);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 2000);
});

test("stateSince only changes on transitions across runs; generated only when the content changes", async () => {
  const dir = copyFixture();
  const r1 = await runOn(dir, at(0));
  assert.equal(r1.state.generated, at(0));
  const text1 = readFileSync(statePath(dir), "utf8");
  const r2 = await runOn(dir, at(1));                     // nothing due yet
  assert.deepEqual([r2.changed, r2.written, r2.report.checkedUrls], [false, false, 0]);
  assert.equal(readFileSync(statePath(dir), "utf8"), text1, "byte-identical, so no commit");
  const r3 = await runOn(dir, at(6));                     // healthy sources are due again, all ok
  const e = r3.state.sources["src.example-lab.orbit-2-launch"];
  assert.deepEqual([e.state, e.stateSince, e.lastCheckedAt, r3.state.generated], ["active", at(0), at(6), at(6)]);
});

test("determinism: two runs with the same fake responses give identical files, with sorted keys", async () => {
  const route = byUrl({ "https://example.org/blog/history": { status: 301, location: "/" }, "https://other.example/about": { status: 403, body: page("Denied") } });
  const a = copyFixture(), b = copyFixture();
  await runOn(a, at(0), route);
  await runOn(b, at(0), route);
  const ta = readFileSync(statePath(a), "utf8"), tb = readFileSync(statePath(b), "utf8");
  assert.equal(ta, tb);
  assert.equal(ta, stableStringify(JSON.parse(ta)), "keys sorted, 2 spaces, trailing newline");
  assert.ok(!ta.includes("\r"));
  const j = JSON.parse(ta);
  for (const [id, e] of Object.entries(j.sources)) {
    assert.deepEqual(Object.keys(e), [...Object.keys(e)].sort(), id);
    if (e.lastCheckedAt === at(0)) for (const k of ["state", "stateSince", "lastCheckedAt", "lastResult", "httpStatus", "finalUrl", "lastDefinitiveAt",
      "consecutiveFailures", "firstFailureAt", "lastOkAt", "firstFingerprint", "lastFingerprint", "archiveState", "archiveSuggestion"]) assert.ok(k in e, `${id}.${k}`);
  }
});

test("existing state: a recovered source is reported; skip sources, orphans and fields are handled", async () => {
  const dir = copyFixture();
  editJ(join(dir, "sources", "shared.json"), j => { j.sources[0].healthCheck = "skip"; j.sources[0].notes = "Blocks bots with HTTP 403 (private reason text)"; });
  editJ(statePath(dir), j => { j.sources["src.shared.news-report-1"] = { state: "active", stateSince: "2026-07-01T00:00:00Z", lastCheckedAt: "2026-07-01T00:00:00Z" };
    j.sources["src.example-lab.removed"] = { state: "active", stateSince: "2026-07-01T00:00:00Z" }; });
  const skipBefore = readJ(statePath(dir)).sources["src.shared.news-report-1"];
  const summary = join(dir, "..", `summary-${Date.now()}.md`); temps.push(summary);
  const r = await runOn(dir, at(3), () => undefined, { summaryFile: summary });   // orbit-0-card: failing, due after 3 days, now ok
  assert.ok(!r.calls.some(c => c.url === "https://news.example.com/orbit-2"), "healthCheck skip is never requested");
  assert.deepEqual(r.state.sources["src.shared.news-report-1"], skipBefore, "skip entry untouched");
  assert.ok(r.state.sources["src.example-lab.removed"], "orphans are kept");
  const e = r.state.sources["src.example-lab.orbit-0-card"];
  assert.deepEqual([e.state, e.stateSince, e.consecutiveFailures, e.firstFailureAt], ["active", at(3), 0, null]);
  const md = readFileSync(summary, "utf8");
  assert.equal(md, r.markdown);
  assert.match(md, /### Recovered\n\n- `src\.example-lab\.orbit-0-card` original: ok/);
  assert.match(md, /curator unavailable, machine active/);
  assert.match(md, /State entries without a source[\s\S]*src\.example-lab\.removed/);
  assert.match(md, /Skipped \(healthCheck "skip"\): 1/);
  // Public report: no notes and no scraped page titles.
  assert.ok(!md.includes("private reason text") && !md.includes("Original removed") && !md.includes("Page /"));
});

test("archiveUrl edits by the curator reset or clear the archive bookkeeping without a check", async () => {
  const dir = copyFixture();
  await runOn(dir, at(0));
  const newArchive = "https://web.archive.org/web/20210402000000/https://docs.example.org/orbit-1";
  editJ(join(dir, "sources", "example-lab.json"), j => { j.sources.find(s => s.id === "src.example-lab.orbit-1-docs").archiveUrl = newArchive; });
  const r = await runOn(dir, at(1), () => undefined, { limit: 0 });
  let e = r.state.sources["src.example-lab.orbit-1-docs"];
  assert.deepEqual([e.archiveState, e.archiveCheck.url, e.archiveCheck.lastCheckedAt, e.lastCheckedAt], ["unknown", newArchive, null, at(0)]);
  editJ(join(dir, "sources", "example-lab.json"), j => { const s = j.sources.find(x => x.id === "src.example-lab.orbit-1-docs"); delete s.archiveUrl; });
  e = (await runOn(dir, at(1), () => undefined, { limit: 0 })).state.sources["src.example-lab.orbit-1-docs"];
  assert.deepEqual([e.archiveState, e.archiveCheck], [null, null]);
  // A suggestion is dropped once the curator has an archive copy.
  editJ(statePath(dir), j => { j.sources["src.example-lab.orbit-2-launch"].archiveSuggestion = { timestamp: "20240612010203", url: "https://web.archive.org/web/20240612010203/https://example.org/blog/orbit-2", via: "wayback-cdx-api" }; });
  editJ(join(dir, "sources", "example-lab.json"), j => { Object.assign(j.sources.find(s => s.id === "src.example-lab.orbit-2-launch"),
    { archiveUrl: "https://web.archive.org/web/20240612010203/https://example.org/blog/orbit-2", archiveProvider: "internet-archive", archivedAt: "2024-06-12T01:02:03Z" }); });
  e = (await runOn(dir, at(1), () => undefined, { limit: 0 })).state.sources["src.example-lab.orbit-2-launch"];
  assert.equal(e.archiveSuggestion, null);
});

test("a url replaced by the curator starts over: no old streak, state or fingerprint carries over", async () => {
  const dir = copyFixture();
  const id = "src.example-lab.orbit-2-launch", oldUrl = "https://example.org/blog/orbit-2", newUrl = "https://example.org/blog/orbit-2-launch";
  const big = page("Orbit 2 launch", { pad: 50000 }), small = page("Orbit 2 is here", { pad: 1800 });
  const r1 = await runOn(dir, at(0), byUrl({ [oldUrl]: { status: 200, body: big } }));
  let e = r1.state.sources[id];
  assert.deepEqual([e.url, e.state, e.firstFingerprint.bytes > 50000], [oldUrl, "active", true]);
  // Legacy entries without "url" adopt the current url without losing their bookkeeping.
  const legacy = r1.state.sources["src.example-lab.orbit-0-card"];
  assert.deepEqual([legacy.url, legacy.consecutiveFailures, legacy.state], ["https://example.org/orbit-0/card", 3, "unavailable"]);
  // The old url starts failing, then the curator replaces it with a working, smaller page.
  await runOn(dir, at(6), byUrl({ [oldUrl]: { status: 404, body: page("Not found") } }));
  editJ(statePath(dir), j => { j.sources[id].archiveSuggestion = { timestamp: "20240612010203", url: `https://web.archive.org/web/20240612010203/${oldUrl}`, via: "wayback-cdx-api" }; });
  editJ(join(dir, "sources", "example-lab.json"), j => { j.sources.find(s => s.id === id).url = newUrl; });
  const r2 = await runOn(dir, at(7), byUrl({ [newUrl]: { status: 200, body: small } }));
  e = r2.state.sources[id];
  assert.ok(r2.calls.some(c => c.url === newUrl), "due at once although the last check was yesterday");
  assert.deepEqual([e.url, e.lastResult, e.state, e.consecutiveFailures, e.firstFailureAt], [newUrl, "ok", "active", 0, null]);
  assert.deepEqual(e.firstFingerprint, e.lastFingerprint, "the baseline is the new page");
  assert.equal(e.firstFingerprint.title, "Orbit 2 is here");
  assert.equal(e.archiveSuggestion, null, "a suggestion for the old url is dropped");
  assert.match(r2.markdown, /URL replaced by the curator[\s\S]*orbit-2-launch/);
  assert.doesNotMatch(r2.markdown, /Possible content change/);
  // Without a check (over the cap) the entry is reset as well, so effAvail falls back to the curator.
  editJ(join(dir, "sources", "example-lab.json"), j => { j.sources.find(s => s.id === id).url = oldUrl; });
  e = (await runOn(dir, at(8), () => undefined, { limit: 0 })).state.sources[id];
  assert.deepEqual([e.url, e.state, e.stateSince, e.lastCheckedAt, e.firstFingerprint], [oldUrl, "unknown", null, null, null]);
});

test("AC-12 and §17.3 with orbit-1-docs (curator: archived): a later first ok is reported, the curator keeps the verdict by checking again", async () => {
  const dir = copyFixture();
  const id = "src.example-lab.orbit-1-docs", url = "https://docs.example.org/orbit-1";
  const avail = () => { const idx = buildIndex(loadDataset(dir)); return effAvail(idx.srcById.get(id), idx.status[id]); };
  const setCuratorDate = day => editJ(join(dir, "sources", "example-lab.json"), j => { j.sources.find(s => s.id === id).lastCheckedAt = day; });
  // The curator checked on 2026-10-01; the first check on 10-06 is a transition after that.
  const r1 = await runOn(dir, at(0));
  const e = r1.state.sources[id];
  assert.deepEqual([e.state, e.lastResult, e.stateSince], ["active", "ok", at(0)]);
  assert.equal(avail(), "active");
  assert.match(r1.markdown, /orbit-1-docs`: curator archived, machine active \(machine verdict applies until the curator checks again\)/);
  // The curator looks again and confirms "archived": later oks without a transition do not undo it (AC-12).
  setCuratorDate(at(0).slice(0, 10));
  assert.equal(avail(), "archived");
  await runOn(dir, at(6));
  assert.equal(avail(), "archived");
  const gone = byUrl({ [url]: { status: 404, body: page("Not found") } });
  for (const n of [12, 15, 21]) await runOn(dir, at(n), gone);
  assert.equal(avail(), "archived", "unavailable with a working archive copy");
  await runOn(dir, at(24));
  assert.equal(avail(), "active", "the recovery is a transition after the curator's check");
});

test("AC-12: a first check on the curator's own day does not outrank the curator verdict", async () => {
  const dir = copyFixture();
  const id = "src.example-lab.orbit-1-docs";
  editJ(join(dir, "sources", "example-lab.json"), j => { j.sources.find(s => s.id === id).lastCheckedAt = at(0).slice(0, 10); });
  const r = await runOn(dir, at(0));
  const idx = buildIndex(loadDataset(dir));
  assert.equal(effAvail(idx.srcById.get(id), idx.status[id]), "archived");
  assert.match(r.markdown, /orbit-1-docs`: curator archived, machine active \(curator verdict still applies/);
});

test("archive.org circuit breaker: after a 429 no further lookups in this run", async () => {
  const dir = copyFixture();
  const api = u => /archive\.org\/(cdx|wayback)/.test(u);
  const r = await runOn(dir, at(0), u => (api(u) ? { status: 429, body: "slow down", headers: { "content-type": "text/plain" } } : undefined));
  assert.equal(r.calls.filter(c => api(c.url)).length, 1, "one CDX request, no Availability fallback, no further lookups");
  assert.match(r.markdown, /Archive lookups paused \(HTTP 429 from archive\.org\): 15 skipped/);
  // A 429 on an archive copy (same budget) pauses the lookups before the first one.
  const dir2 = copyFixture();
  const copy = "https://web.archive.org/web/20210401000000/https://docs.example.org/orbit-1";
  const r2 = await runOn(dir2, at(0), byUrl({ [copy]: { status: 429, body: page("Too many requests") } }));
  assert.equal(r2.calls.filter(c => api(c.url)).length, 0);
  assert.match(r2.markdown, /Archive lookups paused \(HTTP 429 from archive\.org\): 16 skipped/);
  assert.equal(r2.state.sources["src.example-lab.orbit-1-docs"].archiveState, "unknown", "a 429 is non-decisive");
});

test("cap and dry run: at most --limit sources, oldest first; --dry-run writes nothing", async () => {
  const dir = copyFixture();
  const before = readFileSync(statePath(dir), "utf8");
  const r = await runOn(dir, at(0), () => undefined, { limit: 3, dryRun: true });
  assert.equal(r.report.checkedSources, 3);
  assert.equal(r.report.deferred, 14);
  assert.equal(readFileSync(statePath(dir), "utf8"), before);
  assert.equal(r.written, false);
  assert.match(r.markdown, /Dry run: nothing written/);
  const ids = [...new Set(r.calls.filter(c => !c.url.endsWith("/robots.txt") && !/archive\.org/.test(c.url)).map(c => c.url))];
  assert.equal(ids.length, 3);
});

test("unverifiable sources are reported, their state does not change", async () => {
  const dir = copyFixture();
  editJ(statePath(dir), j => { Object.assign(j.sources["src.example-lab.orbit-2-docs"], { lastCheckedAt: at(0), lastResult: "blocked", lastDefinitiveAt: "2026-07-01T03:00:00Z" }); });
  const r = await runOn(dir, at(1), () => undefined, { limit: 0 });
  assert.match(r.markdown, /Unverifiable[\s\S]*src\.example-lab\.orbit-2-docs` original: last blocked/);
  assert.equal(r.state.sources["src.example-lab.orbit-2-docs"].state, "active");
});

test("trackersFor migrates an entry without archive bookkeeping", () => {
  const src = { id: "src.x.y", url: U, archiveUrl: "https://web.archive.org/web/20200101000000/" + U };
  const { orig, archive } = trackersFor(src, { state: "active", stateSince: at(0), archiveState: "gone" });
  assert.deepEqual([orig.state, orig.consecutiveFailures, archive.state, archive.url, archive.lastCheckedAt], ["active", 0, "unavailable", src.archiveUrl, null]);
  assert.equal(trackersFor({ id: "src.x.z", url: U }, { archiveState: "active" }).archive, null);
});

test("CLI: flags parse, unknown flags exit 2, a run without due sources needs no network", () => {
  const dir = copyFixture();
  const ok = spawnSync(process.execPath, [SCRIPT, "--data", dir, "--now", at(0), "--limit", "0", "--dry-run", "--no-archive-lookup", "--no-respect-robots"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Checked 0 sources/);
  const bad = spawnSync(process.execPath, [SCRIPT, "--bogus"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--budget-min", "0"], { encoding: "utf8" }).status, 2);
  const budget = spawnSync(process.execPath, [SCRIPT, "--data", dir, "--now", at(0), "--limit", "0", "--dry-run", "--budget-min", "30"], { encoding: "utf8" });
  assert.equal(budget.status, 0, budget.stderr);
  const missing = spawnSync(process.execPath, [SCRIPT, "--data", join(dir, "nope"), "--limit", "0"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.ok(!existsSync(join(dir, "nope")));
});

test("a broken state file is never overwritten, also with a trailing separator on the data path", async () => {
  const dir = copyFixture();
  for (const [content, data] of [["{ broken", dir], ["{ broken", dir + sep], ["{ broken", dir + "/"], ["null", dir]]) {
    writeFileSync(statePath(dir), content);
    await assert.rejects(runOn(data, at(0)), /cannot read state\/source-status\.json/, JSON.stringify([content, data.slice(-1)]));
    assert.equal(readFileSync(statePath(dir), "utf8"), content);
  }
});

test("a broken sources file is refused and nothing is written", async () => {
  const dir = copyFixture();
  writeFileSync(join(dir, "sources", "shared.json"), "{ broken");
  const before = snapshot(dir);
  for (const data of [dir, dir + sep]) await assert.rejects(runOn(data, at(0)), /cannot read sources\/shared\.json/);
  writeFileSync(join(dir, "sources", "shared.json"), JSON.stringify({ schemaVersion: 1, sources: 5 }));
  await assert.rejects(runOn(dir, at(0)), /cannot read sources\/shared\.json/, "parses, but cannot be loaded");
  writeFileSync(join(dir, "sources", "shared.json"), "{ broken");
  assert.deepEqual(snapshot(dir), before);
});

test("one URL that fails unexpectedly cannot abort the run; the others are written", async () => {
  const dir = copyFixture();
  const hostile = "https://example.org/blog/history", sync = "https://other.example/about";
  const base = fakeFetch();
  // Not async on purpose: the first URL throws before any promise exists; the second answers
  // with headers that throw on a later read, outside the request's own error handling.
  const fetchImpl = (url, init) => {
    if (url === sync) throw new Error("synchronous failure");
    if (url === hostile) return Promise.resolve({ status: 200, body: null, headers: { get: n => { if (n === "content-type") return "text/html"; throw new Error("boom"); } } });
    return base(url, init);
  };
  const r = await runOn(dir, at(0), undefined, { fetchImpl });
  const st = readJ(statePath(dir));
  assert.deepEqual([st.sources["src.example-lab.history"].lastResult, st.sources["src.example-lab.history"].state], ["error", "unknown"]);
  assert.equal(st.sources["src.other-lab.site"].lastResult, "error");
  assert.equal(st.sources["src.example-lab.orbit-2-launch"].lastResult, "ok");
  assert.ok(r.logs.some(l => /src\.example-lab\.history original: internal error/.test(l)));
});

test("robots.txt with an emoji rule: the run completes and the matching source is blocked", async () => {
  const dir = copyFixture();
  editJ(join(dir, "sources", "example-lab.json"), j => { j.sources.find(s => s.id === "src.example-lab.orbit-2-launch").url = "https://example.org/\u{1F600}/orbit-2"; });
  const route = byUrl({ "https://example.org/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /\u{1F600}\n", headers: { "content-type": "text/plain; charset=utf-8" } } });
  const r = await runOn(dir, at(0), route);
  assert.equal(r.written, true);
  assert.deepEqual([r.state.sources["src.example-lab.orbit-2-launch"].lastResult, r.state.sources["src.example-lab.history"].lastResult], ["blocked", "ok"]);
});

test("determinism: interleaving does not matter (random per-URL delays, two different seeds)", async () => {
  const route = byUrl({ "https://example.org/blog/history": { status: 301, location: "/" }, "https://other.example/about": { status: 403, body: page("Denied") },
    "https://example.org/blog/orbit-2": { status: 404, body: page("Not found") } });
  const jittered = seed => {
    const base = fakeFetch(route);
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    return async (url, init) => { await new Promise(res => setTimeout(res, Math.floor(rnd() * 8))); return base(url, init); };
  };
  const a = copyFixture(), b = copyFixture();
  const ra = await runOn(a, at(0), undefined, { fetchImpl: jittered(1) });
  const rb = await runOn(b, at(0), undefined, { fetchImpl: jittered(987654) });
  assert.equal(readFileSync(statePath(a), "utf8"), readFileSync(statePath(b), "utf8"));
  assert.equal(ra.markdown, rb.markdown);
});

test("time budget: no check or lookup starts after the deadline; what completed is written, the rest goes first next run", async () => {
  const dir = copyFixture();
  let t = 0;
  const clock = () => t, sleep = async ms => { t += ms; };
  const r1 = await runOn(dir, at(0), () => undefined, { clock, sleep, budgetMs: 60000, hostDelayMs: 20000 });
  assert.ok(r1.report.checkedUrls > 0 && r1.report.budgetSkipped > 0, JSON.stringify([r1.report.checkedUrls, r1.report.budgetSkipped]));
  assert.equal(r1.report.checkedUrls + r1.report.budgetSkipped, 18, "17 due sources, one of them with an archive copy");
  assert.ok(r1.report.lookupsDeferred > 0);
  assert.equal(r1.written, true);
  assert.match(r1.markdown, /Time budget of 1 min used up: \d+ URLs not checked/);
  const touched = Object.values(readJ(statePath(dir)).sources).filter(e => e.lastCheckedAt === at(0) || (e.archiveCheck && e.archiveCheck.lastCheckedAt === at(0)));
  assert.equal(touched.length, r1.report.checkedSources, "what completed is in the written state");
  const r2 = await runOn(dir, at(0), () => undefined, { clock, sleep });
  assert.equal(r2.report.checkedUrls, r1.report.budgetSkipped, "exactly the URLs left over, still due");
  assert.equal(r2.report.budgetSkipped, 0);
});

test("archive lookups: at most lookupLimit per run, sources that went away first", async () => {
  const dir = copyFixture();
  const cdx = [];
  const route = url => {
    if (url.startsWith("https://web.archive.org/cdx/")) cdx.push(new URL(url).searchParams.get("url"));
    return url === "https://example.org/blog/orbit-2" ? { status: 404, body: page("Not found") } : undefined;
  };
  const r = await runOn(dir, at(0), route, { lookupLimit: 1 });
  assert.deepEqual(cdx, ["https://example.org/blog/orbit-2"], "the failing source is looked up first");
  assert.equal(r.report.lookupsDeferred, 15);
  assert.match(r.markdown, /Archive lookups left for a later check \(limit of 1 per run, or the time budget\): 15\./);
});

test("a title change is reported once, not on every later check", async () => {
  const dir = copyFixture();
  const url = "https://example.org/blog/orbit-2";
  const titled = title => byUrl({ [url]: { status: 200, body: page(title) } });
  const content = md => /### Possible content change[^#]*orbit-2-launch/.test(md);
  assert.ok(!content((await runOn(dir, at(0), titled("Orbit 2 launch"))).markdown), "the first ok is the baseline");
  assert.ok(content((await runOn(dir, at(6), titled("Orbit 2 is here"))).markdown), "new title");
  assert.ok(!content((await runOn(dir, at(12), titled("Orbit 2 is here"))).markdown), "same new title again");
  assert.ok(content((await runOn(dir, at(18), titled("Orbit 2, a year on"))).markdown), "changed again");
});
