/* Tests for the Model History page generator (scripts/model-history/build.mjs).
   Run: node --test scripts/model-history/test/build.test.mjs
   The basic fixture is built through the CLI (as CI does); the tracked fixture
   (fixtures/build/tracked, with a fictional registry in fixtures/build/repo) is built
   through run() so the registry and the validator can be injected. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadDataset, loadRegistry } from "../lib.mjs";
import { buildIndex, deriveGraph } from "../derive.mjs";
import { run, compile, indexJson, finalize, syncInPlace, writeFileAtomic, displayNews, parseArgs, buildTime } from "../build.mjs";
import { modelPage, EVIDENCE_LABEL, EVIDENCE_SHORT, EVIDENCE_GLYPH, NOT_APPLICABLE_LABEL } from "../templates.mjs";
import { layoutTimeline } from "../timeline.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, "..", "build.mjs");
const REPO = join(HERE, "..", "..", "..");
const BASIC = join(HERE, "fixtures", "basic");
const TRACKED = join(HERE, "fixtures", "build", "tracked");
const FAKE_REPO = join(HERE, "fixtures", "build", "repo");
const tmpRoots = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "mh-build-")); tmpRoots.push(d); return d; };
after(() => { for (const d of tmpRoots) rmSync(d, { recursive: true, force: true }); });

const cli = (args, env = {}) => spawnSync(process.execPath, [BUILD, ...args], { encoding: "utf8", env: { ...process.env, MODEL_HISTORY_PUBLISH: "", ...env } });
function tree(dir, base = dir, out = new Map()) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) tree(p, base, out); else out.set(relative(base, p).split("\\").join("/"), readFileSync(p, "utf8"));
  }
  return out;
}
const idsOf = html => [...html.matchAll(/\sid="([^"]*)"/g)].map(m => m[1]);
// A <section> or <aside> by id, up to its closing tag on a line of its own (none of the ones
// tested here nest a same-named element).
const sectionOf = (html, id) => { const m = new RegExp(`<(section|aside)(?: [^>]*)? id="${id}"[^>]*>[\\s\\S]*?\\n</\\1>`).exec(html); return m ? m[0] : ""; };
const listOf = (html, id) => { const m = new RegExp(`<ul id="${id}"[\\s\\S]*?</ul>`).exec(html); return m ? m[0] : ""; };
// The evidence label as the page shows it: glyph (for the four statuses) and short text,
// with the long form in title. data-mh-evidence always matches both (AC-20).
const evLabels = html => [...html.matchAll(/<span class="mh-ev" data-mh-evidence="([^"]+)" title="([^"]+)">(?:<span class="mh-glyph" aria-hidden="true">([^<]+)<\/span> )?([^<]*)<\/span>/g)]
  .map(m => ({ ev: m[1], title: m[2], glyph: m[3] || null, text: m[4] }));
const count = (s, re) => (s.match(re) || []).length;
const quiet = { log() {}, error() {} };

/* ---------- Basic fixture through the CLI ---------- */
let B, OUT, SITEMAP, FILES, FIRST;
before(() => {
  B = tmp(); OUT = join(B, "site", "models"); SITEMAP = join(B, "site", "sitemap-models.xml");
  mkdirSync(join(B, "site"), { recursive: true });
  writeFileSync(join(B, "site", "keep.txt"), "outside the output directory\n");
  const r = cli(["--data", BASIC, "--out", OUT, "--sitemap", SITEMAP, "--publish"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  FILES = tree(OUT);
  FIRST = new Map([...FILES, ["<sitemap>", readFileSync(SITEMAP, "utf8")]]);
});
const page = rel => { const t = FILES.get(rel); assert.ok(t, `missing ${rel}`); return t; };

test("every model has a page, every organisation with models a company page, and no models.html", () => {
  const ds = loadDataset(BASIC), idx = buildIndex(ds);
  for (const m of ds.models) assert.ok(FILES.has(`${idx.routeOrg(m)}/${m.slug}/index.html`), m.id);
  for (const rel of ["index.html", "index.json", "example-lab/index.html", "example-lab/index.json", "other-lab/index.html", "other-lab/index.json"]) assert.ok(FILES.has(rel), rel);
  assert.ok(FILES.has("example-lab/orbit-0/index.html"), "a unit's model routes under the parent organisation");
  assert.ok(!existsSync(join(OUT, "..", "models.html")));
  assert.ok(!FILES.has("example-lab-research/index.html"), "units get no own route");
});

test("the merge lists both parents as sourced claims", () => {
  const html = page("example-lab/orbit-3-merge/index.html");
  // Claims and evidence: each parent relation is its own claim row with its own sources.
  const rel = listOf(html, "relations");
  assert.equal(count(rel, /<li class="mh-claim" /g), 2);
  assert.match(rel, /data-mh-claim="relations\[0\]"/);
  assert.match(rel, /data-mh-claim="relations\[1\]"[\s\S]*?<span class="mh-claim-label">Derived from \(merge\)<\/span>\n<span class="mh-claim-value"><a href="\/models\/other-lab\/nova-7\/">Nova 7<\/a> <span class="mh-org-tag">\(Other Lab\)<\/span>/);
  assert.equal(count(rel, /href="#source-/g) >= 2, true);
  // Lineage: both parents as links.
  const parents = /<ul class="mh-rel" data-mh-lineage="parents">([\s\S]*?)<\/ul>/.exec(sectionOf(html, "lineage"))[1];
  assert.equal(count(parents, /<li>/g), 2);
  assert.match(parents, /href="\/models\/other-lab\/nova-7\/"/);
  assert.match(parents, /derived \(merge\)/);
  // The company page lists the merge under each parent as a link, never a duplicated subtree.
  const co = sectionOf(page("example-lab/index.html"), "lineage");
  assert.match(co, /id="lineage-example-lab\.orbit-3"[\s\S]*?data-mh-lineage="children"[\s\S]*?orbit-3-merge/);
  assert.equal(count(page("example-lab/index.html"), /role="tree"/g), 0);
});

test("stubs are noindex and absent from the sitemap; full pages are listed", () => {
  const sm = readFileSync(SITEMAP, "utf8");
  assert.match(page("other-lab/nova-6/index.html"), /<meta name="robots" content="noindex, follow">/);
  assert.ok(!sm.includes("/models/other-lab/nova-6/"));
  assert.match(page("other-lab/nova-7/index.html"), /<meta name="robots" content="index, follow">/);
  for (const u of ["/models/", "/models/example-lab/", "/models/other-lab/", "/models/other-lab/nova-7/", "/models/example-lab/orbit-2/"]) assert.ok(sm.includes(`<loc>https://ai-radar.eu${u}</loc>`), u);
  assert.match(sm, /<loc>https:\/\/ai-radar\.eu\/models\/example-lab\/orbit-2\/<\/loc>\n    <lastmod>2026-10-01<\/lastmod>/);
  assert.match(page("other-lab/nova-6/index.html"), /<p class="mh-stub">Incomplete record: this model is only partly described\.<\/p>/);
  // The timeline of a full model is listed too; a stub's timeline is noindex like the stub.
  assert.ok(sm.includes("<loc>https://ai-radar.eu/models/example-lab/orbit-2/timeline/</loc>"));
  assert.ok(!sm.includes("/models/other-lab/nova-6/timeline/"));
  assert.match(page("other-lab/nova-6/timeline/index.html"), /<meta name="robots" content="noindex, follow">/);
  assert.match(page("example-lab/orbit-2/timeline/index.html"), /<meta name="robots" content="index, follow">/);
});

test("dates keep their precision: month and year values, no invented day (AC-04, AC-06)", () => {
  const o1 = page("example-lab/orbit-1/index.html");
  assert.match(o1, /<time datetime="2021-03">March 2021<\/time>/);
  assert.ok(!/datetime="2021-03-\d\d"/.test(o1));
  assert.match(page("example-lab/orbit-0/index.html"), /<time datetime="2019">2019<\/time>/);
  assert.match(page("example-lab/orbit-lite-1/index.html"), /<time datetime="2025">2025\?<\/time>/, "uncertain qualifier is visible");
  assert.match(page("example-lab/orbit-2/index.html"), /<time datetime="2025">c\. 2025<\/time>/, "approximate qualifier is visible (AC-05)");
  // Company chronology (design 1a): a month-precision model is listed in its year with "Day
  // not given"; a year-only model under "<year> · exact date unknown"; no date at all last.
  const co = page("example-lab/index.html");
  assert.match(co, /<h3>2021<\/h3>[\s\S]*?<ol class="mh-chrono-items">\n<li class="mh-chrono-item" data-mh-model="example-lab\.orbit-1"[^>]*>\n<div class="mh-chrono-date"><span class="mh-date"><time datetime="2021-03">March 2021<\/time><\/span><span class="mh-prec">Day not given<\/span>/);
  assert.match(co, /<p class="mh-group-head">2019 · exact date unknown<\/p>\n<ol class="mh-chrono-items">\n<li class="mh-chrono-item" data-mh-model="example-lab-research\.orbit-0"/);
  assert.match(co, /<time datetime="2025">2025\?<\/time><\/span><span class="mh-prec">Uncertain year<\/span>/);
  const years = [...co.matchAll(/<div class="mh-year-head"><h3>([^<]+)<\/h3>/g)].map(m => m[1]);
  assert.deepEqual(years, ["2025", "2024", "2021", "2019"], "newest year first");
  assert.match(page("other-lab/index.html"), /<h3>Date unknown<\/h3>[\s\S]*?data-mh-model="other-lab\.nova-6"[\s\S]*?Date unknown<\/span><span class="mh-prec">No timeline date<\/span>/);
  // Every datetime on every page exists as such in the fixture data.
  const raw = [...tree(BASIC)].filter(([rel]) => rel !== "data.json").map(([, t]) => t).join("\n");
  for (const [rel, html] of FILES) if (rel.endsWith(".html")) {
    for (const [, v] of html.matchAll(/datetime="([^"]+)"/g)) assert.ok(raw.includes(`"${v}`), `${rel}: datetime ${v} is not in the data`);
  }
});

test("no leftover __U__, no duplicate ids, no mm-theme, and zero third-party resources", () => {
  for (const [rel, html] of FILES) if (rel.endsWith(".html")) {
    assert.ok(!html.includes("__U__"), rel);
    const ids = idsOf(html), dup = ids.filter((x, k) => ids.indexOf(x) !== k);
    assert.deepEqual(dup, [], `${rel}: duplicate ids`);
    assert.ok(!html.includes("mm-theme"), `${rel}: pre-paint must not read mm-theme`);
    for (const [tag] of html.matchAll(/<(?:link|script|img|iframe|source|video|audio)\b[^>]*>/g)) {
      if (/\brel="canonical"/.test(tag)) continue;   // a canonical link is never fetched
      const url = /\s(?:src|href)="([^"]*)"/.exec(tag);
      if (url) assert.ok(!/^(https?:)?\/\//i.test(url[1]), `${rel}: external resource ${tag}`);
    }
    assert.ok(!/<form\b/.test(html), `${rel}: no forms`);
    assert.ok(!/@import|url\(\s*["']?https?:/i.test(html), rel);
  }
});

test("the page shell follows about.html: head order, header, footer, Model History link", () => {
  const html = page("example-lab/orbit-2/index.html");
  const order = ['<meta charset="utf-8">', '<meta name="viewport"', '<meta name="robots"', "<title>", '<meta name="description"', '<link rel="canonical"',
    '<meta name="theme-color"', '<meta property="og:type"', '<meta name="twitter:card"', '<link rel="icon"', "localStorage.getItem('airadar-theme')",
    '/assets/tokens.css', '/assets/pages.css', '/assets/models.css', '<script src="/assets/pages.js" defer></script>'];
  let last = -1;
  for (const s of order) { const k = html.indexOf(s); assert.ok(k > last, `${s} out of order`); last = k; }
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<a class="skip-link" href="#main">Skip to content<\/a>/);
  assert.match(html, /<a class="nav-link" href="\/models\/" aria-current="true">Model History<\/a>/);
  assert.match(page("index.html"), /<a class="nav-link" href="\/models\/" aria-current="page">Model History<\/a>/);
  assert.match(html, /<a class="nav-link" href="\/">Dashboard<\/a>/);
  assert.match(html, /<footer class="site-footer">[\s\S]*?<a href="\/models\/" aria-current="true">Model History<\/a>/, "also in the footer: the header links are hidden on phones");
  assert.match(html, /<title>Orbit 2 · Example Lab · Model History · AI Radar<\/title>/);
  assert.match(page("example-lab/index.html"), /<title>Example Lab models · Model History · AI Radar<\/title>/);
  assert.match(page("index.html"), /<title>Model History · AI Radar<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/ai-radar\.eu\/models\/example-lab\/orbit-2\/">/);
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(ld["@graph"].map(x => x["@type"]), ["WebPage", "BreadcrumbList"]);
  assert.equal(ld["@graph"][1].itemListElement.length, 4);
  assert.ok(!html.includes("/assets/models.js"), "models.js is only loaded by the Explorer");
  assert.ok(!html.includes("/assets/model-pages.js"), "the model page needs no script at all");
  const desc = /<meta name="description" content="([^"]*)">/.exec(page("example-lab/orbit-3-merge/index.html"))[1];
  assert.ok(desc.length <= 155);
});

test("Explorer follows the HTML contract for models.js (design 1c)", () => {
  const html = page("index.html");
  assert.match(html, /<main id="main" class="mh mh-explorer" data-mh-view="explorer">/);
  assert.match(html, /<script src="\/assets\/models\.js" defer><\/script>/);
  assert.ok(!html.includes("model-pages.js"));
  // Controls: hidden until models.js has the index (the static list works without them).
  assert.match(html, /<div id="mh-controls" class="mh-controls" hidden>/);
  const search = /<input[^>]*id="mh-search"[^>]*>/.exec(html)[0];
  for (const a of ['type="search"', 'aria-label="Search models"', 'autocomplete="off"', 'spellcheck="false"']) assert.ok(search.includes(a), a);
  assert.ok(!/\sname=/.test(search), "no name: nothing is ever submitted");
  const sort = /<div id="mh-sort" class="mh-seg" role="group" aria-label="Sort">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.deepEqual([...sort.matchAll(/data-sort="([^"]+)"/g)].map(m => m[1]), ["date-desc", "date-asc", "name", "org"]);
  assert.deepEqual([...sort.matchAll(/aria-pressed="(true|false)"/g)].map(m => m[1]), ["true", "false", "false", "false"], "newest first is pressed");
  assert.ok([...sort.matchAll(/<button [^>]*>/g)].every(m => m[0].includes('type="button"')));
  assert.match(html, /<button type="button" id="mh-filter-toggle" class="mh-filter-toggle" aria-expanded="false" aria-controls="mh-facets">Filters<\/button>/);
  assert.match(html, /<aside class="mh-facets-col" aria-label="Filters">\n<div id="mh-facets" class="mh-facets"><\/div>/);
  // Results: static count (no JS), hidden clear, empty state and error; the list.
  assert.match(html, /<p id="mh-count" aria-live="polite">11 models from 2 organisations<\/p>/);
  assert.match(html, /<button type="button" id="mh-clear" class="mh-btn-small" hidden>Clear filters<\/button>/);
  assert.match(html, /<div id="mh-empty" class="mh-empty" hidden><p>No models match these filters\.<\/p><button type="button" id="mh-empty-clear" class="mh-btn-dark">Clear filters<\/button><\/div>/);
  assert.match(html, /<p id="mh-error" class="mh-error" hidden>[^<]*<button type="button" id="mh-retry">Retry<\/button><\/p>/);
  assert.match(html, /<div class="mh-cols" aria-hidden="true"><span>Model<\/span><span>Timeline date<\/span><span>Status<\/span><span>Evidence<\/span><\/div>/);
  // Without JS the organisations are still one click away.
  assert.match(html, /<nav class="mh-orglist" aria-label="Organisations">[\s\S]*?<a href="\/models\/example-lab\/">Example Lab<\/a> <span class="mh-num">9<\/span>/);
  const order = [...html.matchAll(/<li [^>]*data-mh-model="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, ["example-lab.orbit-3-merge", "example-lab.orbit-3", "other-lab.nova-7", "example-lab.orbit-lite-1", "example-lab.orbit-2-5",
    "example-lab.orbit-2-2024-09", "example-lab.orbit-2-vision", "example-lab.orbit-2", "example-lab.orbit-1", "example-lab-research.orbit-0", "other-lab.nova-6"]);
  const item = /<li [^>]*data-mh-model="example-lab\.orbit-1"[^>]*>([\s\S]*?)<\/li>/.exec(html)[1];
  for (const s of ['<a class="mh-row-name" href="/models/example-lab/orbit-1/">Orbit 1</a>', '<a href="/models/example-lab/">Example Lab</a>', " · Orbit</span>",
    '<time datetime="2021-03">March 2021</time>', '<span class="mh-prec">Day not given</span>', '<span class="mh-row-life">Retired</span>',
    '<span class="mh-ev" data-mh-evidence="archived-primary-source" title="Archived primary source"><span class="mh-glyph" aria-hidden="true">◐</span> Archived primary</span>',
    '<span class="mh-flag" data-mh-flag="original-unavailable">Original source unavailable</span>']) assert.ok(item.includes(s), s);
  assert.ok(item.indexOf('href="/models/example-lab/"') < item.indexOf('class="mh-row-name"'), "the kicker's organisation link comes first (models.js skips it)");
  const nova6 = /<li [^>]*data-mh-model="other-lab\.nova-6"[^>]*>([\s\S]*?)<\/li>/.exec(html)[1];
  assert.match(nova6, /<span class="mh-date">Date unknown<\/span><span class="mh-prec">No timeline date<\/span>/);
  assert.match(nova6, /<span class="mh-flag" data-mh-flag="stub">Incomplete record<\/span>/);
  assert.match(html, /<li class="mh-row" style="--h:40" data-mh-model="example-lab\.orbit-1" data-mh-prominence="milestone">/);
});

test("model detail: sections, per-claim evidence and sources, source list (AC-31, design 1e)", () => {
  const html = page("example-lab/orbit-2/index.html");
  for (const id of ["identity", "claims", "dates", "lifecycle", "relations", "evidence", "lineage", "variants", "summary", "changes", "capabilities", "sources", "coverage", "variant-mini"]) assert.ok(idsOf(html).includes(id), id);
  const ids = new Set(idsOf(html));
  const claims = [...html.matchAll(/<(li|p)(?: id="[^"]*")? class="(?:[^"]* )?mh-claim(?: [^"]*)?" data-mh-claim="([^"]+)" data-mh-evidence="([^"]+)">([\s\S]*?)<\/\1>/g)];
  assert.ok(claims.length >= 15, `${claims.length} claims`);
  assert.ok(claims.some(c => c[2] === "summary"), "the summary is a claim too");
  const longOf = { ...EVIDENCE_LABEL, "not-applicable": NOT_APPLICABLE_LABEL }, shortOf = { ...EVIDENCE_SHORT, "not-applicable": NOT_APPLICABLE_LABEL };
  for (const [, , path, ev, body] of claims) {
    // "not-applicable": an undisclosed capability without sources makes no claim (spec §9.4).
    assert.ok(Object.hasOwn(longOf, ev), `${path}: ${ev}`);
    assert.ok(/href="#source-/.test(body) || body.includes('<span class="mh-refs mh-refs-none">No source</span>'), `${path} lists its sources`);
    // The visible label always says what the attribute says (AC-20): short text, glyph, long title.
    const shown = evLabels(body);
    assert.equal(shown.length, 1, `${path} shows one evidence label`);
    assert.deepEqual(shown[0], { ev, title: longOf[ev], glyph: EVIDENCE_GLYPH[ev] || null, text: shortOf[ev] }, path);
  }
  for (const [, target] of html.matchAll(/href="#(source-[^"]+)"/g)) assert.ok(ids.has(target), `${target} exists`);
  assert.match(html, /data-mh-claim="relations\[0\]"[\s\S]*?<a class="mh-ref" href="#source-src\.example-lab\.orbit-2-launch" aria-label="Source \d+, first paragraph">\[\d+\]<\/a><span class="mh-locator">first paragraph<\/span>/);
  assert.match(html, /data-mh-claim="capabilities\.parameters" data-mh-evidence="not-applicable">\n<span class="mh-claim-label">Parameters<\/span>\n<span class="mh-claim-value">Not disclosed<span class="mh-note">[^<]*<\/span><\/span>\n<span class="mh-claim-ev"><span class="mh-ev" data-mh-evidence="not-applicable" title="No claim made">No claim made<\/span>/);
  assert.ok(!/data-mh-claim="capabilities\.parameters"[^\n]*(Historical evidence incomplete|Evidence incomplete)/.test(html), "not disclosed is not an evidence gap");
  // Citation numbers follow the first use on the page, and the source list keeps that order.
  const firstUse = [...new Set([...html.matchAll(/<a class="mh-ref" href="#source-([^"]+)"[^>]*>\[(\d+)\]/g)].map(m => `${m[1]}=${m[2]}`))];
  const listed = [...sectionOf(html, "sources").matchAll(/<li id="source-([^"]+)"[^>]*>\n<p class="mh-source-title"><span class="mh-source-n">\[(\d+)\]/g)].map(m => `${m[1]}=${m[2]}`);
  for (const f of firstUse) assert.ok(listed.includes(f), f);
  assert.deepEqual(listed.map(x => Number(x.split("=")[1])), listed.map((x, k) => k + 1));
  const src = /<li id="source-src\.example-lab\.orbit-2-docs"[\s\S]*?<\/li>/.exec(html)[0];
  for (const s of ["<cite>Orbit 2 documentation</cite>", "Documentation · Example Lab", "<dt>Provenance</dt><dd>Primary</dd>",
    '<dt>Availability</dt><dd class="mh-avail" data-mh-availability="active">Active</dd>', '<dt>Last checked</dt><dd><time datetime="2026-10-05T03:11:50Z">',
    '<a href="https://docs.example.org/orbit-2">Original ↗</a>', '<span class="mh-url">https://docs.example.org/orbit-2</span>']) assert.ok(src.includes(s), s);
  assert.match(sectionOf(html, "coverage"), /AI Radar coverage starts in June 2026; no coverage linked yet\./);
  assert.ok(!sectionOf(html, "coverage").includes("?view=timeline"), "no dashboard link without radarCompanyId");
  assert.match(page("example-lab/orbit-0/index.html"), /<p class="mh-none" data-mh-lineage="predecessors">No known predecessor\.<\/p>/);
  assert.match(page("other-lab/nova-6/index.html"), /No known predecessor\./);
  assert.match(html, /<a class="mh-pager-prev" href="\/models\/example-lab\/orbit-1\/"><span class="mh-muted">← Earlier in Orbit<\/span><span>Orbit 1<\/span><\/a>/);
  assert.match(html, /<div><dt>Last reviewed<\/dt><dd><time datetime="2026-10-01">1 October 2026<\/time><\/dd><\/div>/);
  assert.match(html, /<a class="mh-btn-outline" href="\/models\/example-lab\/orbit-2\/timeline\/">Timeline of Orbit 2 →<\/a>/);
  // Inline variant: its note once (the claim row adds it), not twice.
  assert.equal(count(sectionOf(html, "variants").split('<section id="variant-mini"')[1] || "", /Smaller variant released on the same day\./g), 1);
});

test("the evidence labels of spec §16.4 appear with their states", () => {
  const ev = rel => sectionOf(page(rel), "evidence");
  const o2 = ev("example-lab/orbit-2/index.html");
  assert.match(o2, /<h2 class="mh-legend" id="mh-ev-title">Evidence for existence and release<\/h2>/);
  assert.match(o2, /<p class="mh-ev-status"><span class="mh-ev mh-ev-long" data-mh-evidence="primary-source"><span class="mh-glyph" aria-hidden="true">●<\/span> Primary source available<\/span><\/p>/);
  // Its only unsourced claim is an undisclosed capability: no flag (spec §9.4), counted apart.
  assert.ok(!o2.includes("Some details lack sources"), "not disclosed is no evidence gap");
  assert.match(o2, /<span data-mh-summary="not-applicable">No claim made: 1<\/span>/);
  assert.match(o2, /<p class="mh-ev-counts">19 claims · <span data-mh-summary="primary-source">Primary source: 18<\/span>/);
  assert.match(ev("example-lab/orbit-3/index.html"), /<li class="mh-flag" data-mh-flag="some-claims-incomplete">Some details lack sources<\/li>/, "capabilities.features[1] has no sources");
  assert.match(ev("example-lab/orbit-2-vision/index.html"), /<li class="mh-flag" data-mh-flag="some-claims-incomplete">Some details lack sources<\/li>/);
  const item = /<li [^>]*data-mh-model="example-lab\.orbit-2"[^>]*>([\s\S]*?)<\/li>/.exec(page("index.html"))[1];
  assert.ok(!item.includes("some-claims-incomplete"), "no flag in the Explorer either");
  assert.match(ev("example-lab/orbit-1/index.html"), /Archived primary source[\s\S]*?Original source unavailable/);
  assert.match(ev("example-lab/orbit-2-vision/index.html"), /Verified through secondary sources/);
  assert.match(ev("example-lab/orbit-0/index.html"), /Historical evidence incomplete[\s\S]*?Original source unavailable/);
  assert.match(ev("example-lab/orbit-0/index.html"), /<span class="mh-glyph" aria-hidden="true">◌<\/span> Historical evidence incomplete/);
  const o1 = page("example-lab/orbit-1/index.html");
  assert.match(o1, /<li id="source-src\.example-lab\.orbit-1-docs" class="mh-source" data-mh-availability="archived" data-mh-provenance="archived-primary">/);
  assert.match(o1, /<dd class="mh-avail" data-mh-availability="archived">Archived copy<\/dd>/);
  assert.match(o1, /<span class="mh-muted">Original no longer available<\/span>/, "a lost original is not linked as if it worked");
  assert.match(o1, /<a href="https:\/\/web\.archive\.org\/web\/20210401000000\/https:\/\/docs\.example\.org\/orbit-1">Internet Archive capture ↗<\/a>/);
  const o0 = /<li id="source-src\.example-lab-research\.orbit-0-card"[\s\S]*?<\/li>|<li id="source-src\.example-lab\.orbit-0-card"[\s\S]*?<\/li>/.exec(page("example-lab/orbit-0/index.html"))[0];
  assert.match(o0, /data-mh-availability="unavailable"[\s\S]*?<dd class="mh-avail" data-mh-availability="unavailable">Unavailable<\/dd>[\s\S]*?Original no longer available[\s\S]*?https:\/\/example\.org\/orbit-0\/card/);
  assert.ok(!/<a href="https:\/\/example\.org\/orbit-0\/card"/.test(o0), "no link to the lost original");
});

test("every source state has its own words on the page (active, archived, unavailable, not yet verified, archive gone)", () => {
  const TEXT = { active: "Active", archived: "Archived copy", unavailable: "Unavailable", unknown: "Not yet verified" };
  const stateOf = card => /<dd class="mh-avail" data-mh-availability="([^"]+)">([^<]+)<\/dd>/.exec(card).slice(1).join("=");
  const all = [...FILES].filter(([rel]) => rel.endsWith("/index.html")).map(([, h]) => h).join("\n");
  const seen = new Set([...all.matchAll(/<dd class="mh-avail" data-mh-availability="[^"]+">[^<]+<\/dd>/g)].map(m => stateOf(m[0])));
  for (const s of ["active", "archived", "unavailable"]) assert.ok(seen.has(`${s}=${TEXT[s]}`), s);
  // The fixture has no unchecked source and no lost archive: make them in memory.
  const ds = loadDataset(BASIC), sources = ds.state.sourceStatus.sources;
  const docs2 = ds.sources.find(s => s.id === "src.example-lab.orbit-2-docs"), docs1 = ds.sources.find(s => s.id === "src.example-lab.orbit-1-docs");
  docs2.availability = "unknown"; delete docs2.lastCheckedAt; delete sources[docs2.id];
  sources[docs1.id] = { ...(sources[docs1.id] || {}), url: docs1.url, archiveState: "gone" };
  const site = compile(ds);
  const card = (m, id) => new RegExp(`<li id="source-${id.replace(/\./g, "\\.")}"[\\s\\S]*?</li>`).exec(modelPage(site, site.modelById.get(m)))[0];
  const unknown = card("example-lab.orbit-2", docs2.id);
  assert.equal(stateOf(unknown), "unknown=Not yet verified");
  assert.match(unknown, /<dt>Last checked<\/dt><dd>Not yet checked<\/dd>/);
  assert.match(unknown, /<a href="https:\/\/docs\.example\.org\/orbit-2">Original ↗<\/a>/, "an unchecked original is still linked");
  const gone = card("example-lab.orbit-1", docs1.id);
  assert.equal(stateOf(gone), "unavailable=Unavailable", "original and archive both gone");
  assert.match(gone, /<span class="mh-flag">The archived copy is also gone<\/span>/);
  assert.match(gone, /Original no longer available/);
});

test("siblings include the inline variants of the parent record, as anchors (§12.4, §13.3)", () => {
  const sib = /<ul class="mh-rel" data-mh-lineage="siblings">([\s\S]*?)<\/ul>/.exec(sectionOf(page("example-lab/orbit-2-vision/index.html"), "lineage"));
  assert.ok(sib, "Orbit 2 Vision has a siblings list");
  assert.match(sib[1], /<li><a href="\/models\/example-lab\/orbit-2\/#variant-mini">Orbit 2 Mini<\/a> <span class="mh-muted">· inline variant of Orbit 2<\/span><\/li>/);
  assert.ok(idsOf(page("example-lab/orbit-2/index.html")).includes("variant-mini"), "the anchor exists");
  const co = /<li id="lineage-example-lab\.orbit-2-vision">([\s\S]*?)\n<\/li>/.exec(sectionOf(page("example-lab/index.html"), "lineage"))[1];
  assert.match(co, /data-mh-lineage="siblings">[\s\S]*?#variant-mini/);
  // A successor is no variant: its lineage gets no inline siblings.
  assert.ok(!sectionOf(page("example-lab/orbit-3/index.html"), "lineage").includes("#variant-mini"));
});

test("variant capabilities and lifecycle show their sources and are marked as not assessed", () => {
  const ds = loadDataset(TRACKED);
  const v = ds.models.find(m => m.id === "acme.rocket-2").variants[0];
  v.capabilities = { contextWindowTokens: { value: 32000, disclosure: "official", sources: [{ id: "src.acme.rocket-2-launch" }] } };
  v.lifecycle = { value: "retired", sources: [{ id: "src.acme.rocket-2-launch", locator: "footnote" }] };
  const site = compile(ds, { registry: null });
  const sec = /<section id="variant-mini" class="mh-variant">[\s\S]*?<\/section>/.exec(modelPage(site, site.modelById.get("acme.rocket-2")))[0];
  assert.match(sec, /<li data-mh-variant-claim="capabilities\.contextWindowTokens">Context window: <span class="mh-value">32,000 tokens<\/span> <span class="mh-ev mh-ev-unassessed">Evidence not assessed<\/span> <span class="mh-refs"><a class="mh-ref" href="#source-src\.acme\.rocket-2-launch"/);
  assert.match(sec, /<p data-mh-variant-claim="lifecycle">Status: <span class="mh-value">Retired<\/span> <span class="mh-ev mh-ev-unassessed">Evidence not assessed<\/span> [\s\S]*?<span class="mh-locator">footnote<\/span>/);
  assert.ok(!/data-mh-variant-claim[^>]*data-mh-evidence/.test(sec), "no derived evidence is claimed for them");
});

test("company page: organisation facts, families, story, evidence overview, graph data", () => {
  const html = page("example-lab/index.html");
  for (const id of ["organization", "story", "families", "chronology", "lineage", "evidence", "coverage", "sources", "mh-graph", "mh-family-chips", "family-example-lab.orbit", "family-example-lab.orbit-lite"]) assert.ok(idsOf(html).includes(id), id);
  assert.match(html, /<main id="main" class="mh mh-company" style="--h:40" data-mh-view="company" data-mh-org="example-lab">/);
  assert.match(html, /<h1 class="mh-title">Example Lab models<\/h1>/);
  assert.match(html, /<p class="mh-lead">Fictional AI lab[^<]*Known as Example Research until September 2021\.<\/p>/);
  assert.match(html, /data-mh-claim="formerNames\[0\]"[^>]*>\n<span class="mh-claim-label">Former name<\/span>\n<span class="mh-claim-value">Example Research <span class="mh-period">\(until <time datetime="2021-09">September 2021<\/time>\)/);
  assert.match(html, /Example Lab Research/);
  assert.match(html, /data-mh-claim="narrative\.chapters\[0\]"[\s\S]*?Research models/);
  // Family chips (design 1a): hidden without JS, one per family with models, "All" pressed.
  const chips = /<div id="mh-family-chips" class="mh-chips" role="group" aria-label="Family" hidden>([\s\S]*?)<\/div>/.exec(html)[1];
  assert.deepEqual([...chips.matchAll(/data-family="([^"]*)" aria-pressed="(true|false)">([^<]+)</g)].map(m => m.slice(1).join("|")),
    ["|true|All families", "example-lab.orbit|false|Orbit", "example-lab.orbit-lite|false|Orbit Lite"]);
  for (const [, fam] of html.matchAll(/<li class="mh-chrono-item" [^>]*data-mh-family="([^"]*)"/g)) assert.ok(chips.includes(`data-family="${fam}"`), `chip for ${fam}`);
  // Evidence overview: counts per status (glyph + short text), then the lists.
  // Incomplete = insufficient status or some-claims-incomplete; a lost original with a sound
  // archive (Orbit 1) is listed apart, not as incomplete (§16.4).
  const evs = sectionOf(html, "evidence");
  assert.match(evs, /<div data-mh-evidence="primary-source"><dt><span class="mh-glyph" aria-hidden="true">●<\/span> Primary source<\/dt><dd>5<\/dd><\/div>/);
  assert.match(evs, /<div data-mh-flag="original-unavailable"><dt>Original source unavailable<\/dt><dd>2<\/dd><\/div>/);
  const incomplete = /<h3 class="mh-legend">Incomplete evidence<\/h3>\n<ul class="mh-mini-list" data-mh-list="incomplete">([\s\S]*?)<\/ul>/.exec(evs)[1];
  assert.match(incomplete, />Orbit 0<\/a> <span class="mh-muted">Historical evidence incomplete; Some details lack sources</);
  assert.match(incomplete, />Orbit 3<\/a> <span class="mh-muted">Some details lack sources</);
  assert.ok(!incomplete.includes(">Orbit 1<") && !incomplete.includes(">Orbit 2<"));
  assert.match(/<ul class="mh-mini-list" data-mh-list="original-unavailable">([\s\S]*?)<\/ul>/.exec(evs)[1], />Orbit 1<\/a> <span class="mh-muted">Archived primary source</);
  const g = JSON.parse(/<script type="application\/json" id="mh-graph">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(g.edges.find(e => e[2] === "other-lab.nova-7"), ["example-lab.orbit-3-merge", "derived-from", "other-lab.nova-7", "merge", "sourced"]);
  assert.equal(g.externalNodes["other-lab.nova-7"].name, "Nova 7");
  const other = page("other-lab/index.html");
  assert.match(other, /data-mh-model="example-lab\.orbit-3-merge"[\s\S]*?Co-developed; listed under <a href="\/models\/example-lab\/">Example Lab<\/a>/);
  assert.match(sectionOf(html, "coverage"), /no coverage linked yet/);
});

test("models/index.json has the exact short shape of spec §23.1", () => {
  const j = JSON.parse(page("index.json"));
  assert.deepEqual(Object.keys(j).sort(), ["families", "generated", "models", "organizations", "schemaVersion"]);
  assert.equal(j.schemaVersion, 1);
  assert.match(j.generated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(!page("index.json").includes("\n  "), "minified");
  const ex = j.organizations.find(o => o.id === "example-lab");
  assert.deepEqual(Object.keys(ex).sort(), ["id", "models", "name", "names", "radarCompanyId"]);
  assert.equal(ex.models, 9);
  for (const n of ["example lab", "examplelab", "example research", "example lab research"]) assert.ok(ex.names.includes(n), n);
  assert.deepEqual(j.families[0], { id: "example-lab.orbit", name: "Orbit" });
  const keys = ["alias", "cats", "date", "ev", "family", "flags", "gen", "id", "life", "name", "news", "open", "prom", "slug"];
  for (const m of j.models) {
    assert.deepEqual(Object.keys(m).filter(k => k !== "org").sort(), keys, m.id);
    assert.ok([true, false, null].includes(m.open));
    assert.ok(m.flags.every(f => ["original-unavailable", "some-claims-incomplete"].includes(f)));
    assert.ok(m.date === null || (Object.keys(m.date).sort().join() === "k,q,v" && ["released", "announced"].includes(m.date.k)));
  }
  const o2 = j.models.find(m => m.id === "example-lab.orbit-2");
  assert.deepEqual(o2.alias, ["orbit-2", "orbit 2 mini"]);
  assert.deepEqual(o2.date, { k: "released", q: null, v: "2024-06-11" });
  assert.equal(o2.open, true);
  assert.equal(o2.ev, "primary-source");
  assert.deepEqual(o2.flags, [], "an undisclosed capability sets no flag (§9.4)");
  assert.deepEqual(j.models.find(m => m.id === "example-lab.orbit-3").flags, ["some-claims-incomplete"]);
  assert.deepEqual(j.models.find(m => m.id === "example-lab.orbit-lite-1").date, { k: "released", q: "uncertain", v: "2025" });
  assert.equal(j.models.find(m => m.id === "other-lab.nova-6").date, null);
  // A unit's model is routed under the parent: its organisation does not follow from the id.
  assert.equal(j.models.find(m => m.id === "example-lab-research.orbit-0").org, "example-lab");
  assert.equal(j.models.find(m => m.id === "example-lab.orbit-2").org, undefined);
});

test("models/<org>/index.json carries organisation, families, derived sets, externalNodes, sources (§5.2, §12.5)", () => {
  const j = JSON.parse(page("example-lab/index.json"));
  assert.equal(j.organization.formerNames[0].name, "Example Research");
  assert.equal(j.organization.formerNames[0].evidence, "primary-source");
  assert.deepEqual(j.organization.units.map(u => u.id), ["example-lab-research"]);
  assert.equal(j.organization.description.evidence, "primary-source");
  assert.deepEqual(j.organization.narrative.chapters[0].modelIds, ["example-lab-research.orbit-0", "example-lab.orbit-1"]);
  assert.deepEqual(j.families.find(f => f.id === "example-lab.orbit-lite").models, ["example-lab.orbit-lite-1"]);
  const g = deriveGraph(loadDataset(BASIC)).byModel;
  const merge = j.models.find(m => m.id === "example-lab.orbit-3-merge");
  assert.deepEqual(merge.graph, g["example-lab.orbit-3-merge"]);
  assert.deepEqual(merge.graph.parents, ["example-lab.orbit-3", "other-lab.nova-7"]);
  assert.equal(merge.relations[1].targetUrl, "/models/other-lab/nova-7/");
  assert.equal(j.models.find(m => m.id === "example-lab.orbit-2").graph.successors.length, 3, "a model with 3 successors");
  assert.deepEqual(j.externalNodes["other-lab.nova-7"], { coverage: "full", date: { k: "released", q: null, v: "2025-02-14" }, name: "Nova 7", org: "other-lab", slug: "nova-7" });
  assert.equal(j.models.find(m => m.id === "example-lab.orbit-1").claims["dates.released"].evidence, "archived-primary-source");
  assert.deepEqual(j.sources["src.example-lab.orbit-1-docs"].effective, { archiveGone: false, availability: "archived", provenance: "archived-primary" });
  assert.equal(j.sources["src.example-lab.orbit-0-card"].url, "https://example.org/orbit-0/card", "the original URL stays in the data");
  assert.ok(!page("example-lab/index.json").includes('"notes"'));
  const other = JSON.parse(page("other-lab/index.json"));
  assert.deepEqual(other.coDeveloped, ["example-lab.orbit-3-merge"]);
  assert.ok(other.externalNodes["example-lab.orbit-3-merge"] && other.externalNodes["example-lab.orbit-3"]);
  assert.ok(!other.externalNodes["example-lab.orbit-0"], "no ancestry of co-developed models");
});

test("a second run gives byte-identical output, including generated (AC-26)", () => {
  const r = cli(["--data", BASIC, "--out", OUT, "--sitemap", SITEMAP, "--publish"]);
  assert.equal(r.status, 0, r.stderr);
  const again = new Map([...tree(OUT), ["<sitemap>", readFileSync(SITEMAP, "utf8")]]);
  assert.deepEqual([...again.keys()], [...FIRST.keys()]);
  for (const [rel, text] of FIRST) assert.equal(again.get(rel), text, rel);
  assert.match(r.stdout, /output unchanged, sitemap unchanged/);
});

test("generated changes only when the rest of the file changes", () => {
  const d = tmp();
  const text = '{"generated":"@@GENERATED@@","models":[1]}\n';
  writeFileSync(join(d, "index.json"), '{"generated":"2026-01-01T00:00:00Z","models":[1]}\n');
  assert.equal(finalize(new Map([["index.json", text]]), d, "2026-09-30T00:00:00Z").get("index.json"), '{"generated":"2026-01-01T00:00:00Z","models":[1]}\n');
  writeFileSync(join(d, "index.json"), '{"generated":"2026-01-01T00:00:00Z","models":[1]}\r\n');
  assert.equal(finalize(new Map([["index.json", text]]), d, "2026-09-30T00:00:00Z").get("index.json"), '{"generated":"2026-01-01T00:00:00Z","models":[1]}\n', "CRLF checkout");
  writeFileSync(join(d, "index.json"), '{"generated":"2026-01-01T00:00:00Z","models":[2]}\n');
  assert.equal(finalize(new Map([["index.json", text]]), d, "2026-09-30T00:00:00Z").get("index.json"), '{"generated":"2026-09-30T00:00:00Z","models":[1]}\n');
});

test("orphans inside the output directory are removed; files outside it are untouched", () => {
  const parent = dirname(OUT);
  mkdirSync(join(OUT, "example-lab", "old-model"), { recursive: true });
  writeFileSync(join(OUT, "example-lab", "old-model", "index.html"), "stale");
  writeFileSync(join(OUT, "stale.txt"), "stale");
  const r = cli(["--data", BASIC, "--out", OUT, "--sitemap", SITEMAP, "--publish"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(OUT, "example-lab", "old-model")));
  assert.ok(!existsSync(join(OUT, "stale.txt")));
  assert.equal(readFileSync(join(parent, "keep.txt"), "utf8"), "outside the output directory\n");
  assert.deepEqual(readdirSync(parent).sort(), ["keep.txt", "models", "sitemap-models.xml"], "no temporary directories left");
  for (const [rel, text] of FILES) assert.equal(readFileSync(join(OUT, rel), "utf8"), text, rel);
});

test("syncInPlace (the fallback when the directory cannot be swapped) also removes only orphans", () => {
  const d = tmp(), out = join(d, "models");
  mkdirSync(join(out, "a", "gone"), { recursive: true });
  writeFileSync(join(out, "a", "gone", "index.html"), "x");
  writeFileSync(join(d, "outside.txt"), "keep");
  syncInPlace(out, new Map([["index.html", "new"], ["a/b/index.html", "b"]]));
  assert.deepEqual([...tree(out).keys()], ["a/b/index.html", "index.html"]);
  assert.equal(readFileSync(join(d, "outside.txt"), "utf8"), "keep");
});

test("publish gate: without --publish or MODEL_HISTORY_PUBLISH=on nothing is written", () => {
  const d = tmp(), out = join(d, "models"), sm = join(d, "sitemap-models.xml");
  const r = cli(["--data", BASIC, "--out", out, "--sitemap", sm]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Publish gate closed: nothing written/);
  assert.match(r.stdout, /new {5}example-lab\/orbit-2\/index\.html/);
  assert.ok(!existsSync(out) && !existsSync(sm));
  const on = cli(["--data", BASIC, "--out", out, "--sitemap", sm], { MODEL_HISTORY_PUBLISH: "on" });
  assert.equal(on.status, 0, on.stderr);
  assert.ok(existsSync(join(out, "index.html")) && existsSync(sm));
});

test("the build refuses to write when the validator reports errors, or for an unsafe output directory", async () => {
  const d = tmp(), out = join(d, "models");
  const code = await run({ data: BASIC, out, sitemap: join(d, "s.xml"), publish: true, ...quiet,
    validate: async () => [{ code: "E05", level: "error", file: "records/x.json", path: "relations[0]", message: "cycle" }, { code: "W03", level: "warning", message: "w" }] });
  assert.equal(code, 1);
  assert.ok(!existsSync(out));
  const ok = { data: BASIC, sitemap: join(d, "s.xml"), publish: true, validate: async () => [], ...quiet };
  mkdirSync(join(d, "unrelated")); writeFileSync(join(d, "unrelated", "file.txt"), "x");
  assert.equal(await run({ ...ok, out: join(d, "unrelated") }), 1, "a non-empty folder without a previous build");
  assert.equal(readFileSync(join(d, "unrelated", "file.txt"), "utf8"), "x");
  assert.equal(await run({ ...ok, out: REPO }), 1, "the repository itself");
  assert.equal(await run({ ...ok, out: join(BASIC, "records") }), 1, "inside the data");
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
  assert.deepEqual(parseArgs(["--out=x", "--publish"]), { out: "x", publish: true });
});

test("the sitemap path is checked: .xml, outside the output and the data, never someone else's file (AC-23, AC-26)", async () => {
  const d = tmp(), out = join(d, "models"), data = join(d, "data");
  cpSync(BASIC, data, { recursive: true });
  const errs = [];
  const go = sitemap => run({ data, out, sitemap, publish: true, validate: async () => [], registry: null, log() {}, error: s => errs.push(s) });
  assert.equal(await go(join(out, "inside.xml")), 1, "inside the output directory");
  assert.match(errs.pop(), /must not be inside the output directory/);
  assert.equal(await go(join(d, "sitemap-models.json")), 1, "not an .xml file");
  assert.match(errs.pop(), /must end in \.xml/);
  assert.equal(await go(join(data, "sitemap-models.xml")), 1, "inside the data");
  const feed = join(d, "feed.xml"), main = join(d, "sitemap.xml");
  writeFileSync(feed, '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>\n');
  writeFileSync(main, '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://ai-radar.eu/about</loc></url></urlset>\n');
  assert.equal(await go(feed), 1, "an existing feed");
  assert.equal(await go(main), 1, "the site's own sitemap");
  assert.match(errs.pop(), /not a Model History sitemap/);
  assert.match(readFileSync(feed, "utf8"), /<rss/);
  assert.match(readFileSync(main, "utf8"), /\/about/);
  assert.ok(!existsSync(out) && !existsSync(join(data, "sitemap-models.xml")), "nothing written");
  // The dry run refuses the same paths.
  const r = cli(["--data", BASIC, "--out", out, "--sitemap", join(out, "inside.json")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must end in \.xml/);
  // An earlier Model History sitemap is replaced.
  assert.equal(await go(join(d, "sitemap-models.xml")), 0);
  assert.equal(await go(join(d, "sitemap-models.xml")), 0);
});

test("a registry.js that fails to load stops the build (E25), also without the validator's help", async () => {
  const d = tmp(), repo = join(d, "repo"), out = join(d, "models"), sitemap = join(d, "sitemap-models.xml");
  mkdirSync(join(repo, "assets"), { recursive: true });
  writeFileSync(join(repo, "assets", "registry.js"), "throw new Error('broken registry');\n");
  const errs = [];
  const opts = { data: BASIC, out, sitemap, publish: true, repo, log() {}, error: s => errs.push(s) };
  assert.equal(await run(opts), 1);
  assert.ok(errs.some(s => /E25 assets\/registry\.js/.test(s) && /failed to load/.test(s)), errs.join("\n"));
  errs.length = 0;
  assert.equal(await run({ ...opts, validate: async () => [] }), 1, "an injected validator that sees nothing");
  assert.ok(errs.some(s => /E25/.test(s)));
  assert.ok(!existsSync(out) && !existsSync(sitemap));
});

test("CLI edge cases: switches take no value, flags need a real value, SOURCE_DATE_EPOCH is checked", () => {
  assert.throws(() => parseArgs(["--publish=false"]), /takes no value/);
  assert.throws(() => parseArgs(["--out", "--publish"]), /--out needs a value/);
  assert.throws(() => parseArgs(["--sitemap"]), /needs a value/);
  assert.throws(() => parseArgs(["--data="]), /needs a value/);
  const notes = [];
  assert.equal(buildTime({ SOURCE_DATE_EPOCH: "1790000000" }, s => notes.push(s)), new Date(1790000000 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
  assert.match(buildTime({ SOURCE_DATE_EPOCH: "soon" }, s => notes.push(s)), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /not a number of seconds/);
  const d = tmp();
  const r = cli(["--data", BASIC, "--out", join(d, "models"), "--sitemap", join(d, "s.xml")], { SOURCE_DATE_EPOCH: "not-a-number" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SOURCE_DATE_EPOCH "not-a-number" is not a number of seconds/);
  const bad = cli(["--publish=false", "--data", BASIC]);
  assert.equal(bad.status, 2);
});

test("writeFileAtomic removes its own stale temp files from a crashed run, nothing else", () => {
  const d = tmp(), f = join(d, "sitemap-models.xml");
  writeFileSync(join(d, "sitemap-models.xml.tmp-4242"), "stale");
  writeFileSync(join(d, "sitemap.xml.tmp-4242"), "not ours");
  writeFileSync(join(d, "sitemap-models.xml.tmp-x"), "not the pattern");
  assert.equal(writeFileAtomic(f, "<urlset/>\n"), true);
  assert.equal(writeFileAtomic(f, "<urlset/>\n"), false, "unchanged content is not rewritten");
  assert.deepEqual(readdirSync(d).sort(), ["sitemap-models.xml", "sitemap-models.xml.tmp-x", "sitemap.xml.tmp-4242"]);
});

test("syncInPlace removes a linked directory as a link, never the files it points to (§27.1)", t => {
  const d = tmp(), out = join(d, "models"), outside = join(d, "outside");
  mkdirSync(join(out, "example-lab"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "index.html"), "precious");
  // A junction needs no extra rights on Windows; elsewhere this is a directory symlink.
  try { symlinkSync(outside, join(out, "linked"), "junction"); } catch (e) { t.skip(`cannot create a link here (${e.code})`); return; }
  syncInPlace(out, new Map([["index.html", "new"], ["example-lab/index.html", "org"]]));
  assert.equal(readFileSync(join(outside, "index.html"), "utf8"), "precious");
  assert.ok(!existsSync(join(out, "linked")));
  assert.deepEqual([...tree(out).keys()], ["example-lab/index.html", "index.html"]);
});

test("the Explorer is indexable and in the sitemap before any full record exists (§5.1, AC-25)", async () => {
  const d = tmp(), data = join(d, "data");
  mkdirSync(data);
  const code = await run({ data, out: join(d, "models"), sitemap: join(d, "sitemap-models.xml"), publish: true, validate: async () => [], registry: null, now: "2026-10-01T00:00:00Z", ...quiet });
  assert.equal(code, 0);
  assert.match(readFileSync(join(d, "models", "index.html"), "utf8"), /<meta name="robots" content="index, follow">/);
  assert.match(readFileSync(join(d, "sitemap-models.xml"), "utf8"), /<loc>https:\/\/ai-radar\.eu\/models\/<\/loc>/);
});

test("index.json names and aliases are folded like the search term (§23.2)", () => {
  const ds = loadDataset(BASIC);
  const o = ds.organizations.find(x => x.id === "other-lab");
  o.aliases = [...(o.aliases || []), "Ötherlab Ünit"];
  const m = ds.models.find(x => x.id === "other-lab.nova-7");
  m.aliases = [...(m.aliases || []), { text: "Nová Seven", match: "auto" }];
  const j = indexJson(compile(ds));
  assert.ok(j.organizations.find(x => x.id === "other-lab").names.includes("otherlab unit"));
  assert.ok(j.models.find(x => x.id === "other-lab.nova-7").alias.includes("nova seven"));
});

/* The design lives in models.css. Every var() it reads is defined: in tokens.css, in
   models.css itself, or inline by the templates (the timeline geometry, the company hue). */
test("the stylesheet: no external resources, no motion, and every custom property it reads is defined", () => {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, "");
  const css = strip(readFileSync(join(REPO, "assets", "models.css"), "utf8"));
  assert.ok(!/@import|url\(|@font-face|@keyframes|animation|transition/.test(css), "no external resources, no web fonts, no motion");
  const defined = new Set();
  for (const src of [strip(readFileSync(join(REPO, "assets", "tokens.css"), "utf8")), css]) for (const [, n] of src.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(n);
  for (const [, h] of FILES) for (const [, style] of h.matchAll(/\sstyle="([^"]*)"/g)) for (const [, n] of style.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(n);
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
  for (const n of used) assert.ok(defined.has(n), `${n} is read but never defined`);
  assert.ok(Buffer.byteLength(css) <= 40 * 1024, "spec §32: own CSS within budget");
});

// tokens.css derives the company colour for any element whose inline style contains "--h"
// ([style*="--h"]); any other property starting with "--h" would set a bogus hue.
test("inline styles use --h only for the company hue", () => {
  for (const [rel, h] of FILES) for (const [, style] of h.matchAll(/\sstyle="([^"]*)"/g)) {
    for (const m of style.matchAll(/--h[a-z0-9-]*/g)) assert.equal(m[0], "--h", `${rel}: ${m[0]} in style="${style}"`);
  }
});

test("pages stay within the size budgets of spec §32", () => {
  for (const [rel, text] of FILES) if (/^[^/]+\/[^/]+\/(?:timeline\/)?index\.html$/.test(rel)) assert.ok(Buffer.byteLength(text) <= 60 * 1024, rel);
});

/* ---------- Model timeline pages (design 3a) ---------- */
test("every model has a timeline page: the axis, the same events as a list, tools hidden without JS", () => {
  const ds = loadDataset(BASIC), idx = buildIndex(ds), site = compile(ds);
  for (const m of ds.models) {
    const rel = `${idx.routeOrg(m)}/${m.slug}/timeline/index.html`, html = page(rel), i = site.modelById.get(m.id);
    assert.match(html, /<main id="main" class="mh mh-timeline[^"]*"(?: style="--h:\d+")? data-mh-view="timeline"/, rel);
    assert.match(html, /<nav class="mh-crumbs" aria-label="Breadcrumb"><ol>[\s\S]*?<li aria-current="page">Timeline<\/li><\/ol><\/nav>/, rel);
    assert.match(html, new RegExp(`<a href="${i.url}">← The full record of `), `${rel} links back to the record`);
    // The build's layout, rendered as is: one node per axis item, one list row per event.
    const tl = /<div id="mh-tl" class="mh-tl" data-zoom="normal" data-t0="([^"]+)" data-span="([^"]+)" style="([^"]+)">/.exec(html);
    assert.ok(tl, `${rel}: #mh-tl`);
    const nodes = [...html.matchAll(/<div class="mh-tl-node k-(life|mile|lin|src|news)[^"]*" style="([^"]+)" data-above="([cnw ]*)"( data-focus)?>/g)];
    const list = /<ol class="mh-tl-list">([\s\S]*?)<\/ol>/.exec(html)[1];
    const legend = /<li class="mh-tl-count">(\d+) events?<\/li>/.exec(html);
    assert.equal(count(list, /<li>/g), Number(legend[1]), `${rel}: the list has every event`);
    assert.ok(nodes.length >= 1 && nodes.length <= count(list, /<li>/g), `${rel}: grouped on the axis, never more nodes than events`);
    for (const [, , style] of nodes) for (const z of ["c", "n", "w"]) assert.match(style, new RegExp(`--s-${z}:-?1;--o-${z}:\\d+px`), `${rel}: a lane per zoom`);
    // The unknown-date zone only when something has no date; exactly one focus when the model has a date.
    const unknownNodes = nodes.filter(n => /--dx:/.test(n[2])).length;
    assert.equal(html.includes('<div class="mh-tl-unknown-zone">'), unknownNodes > 0, rel);
    assert.equal(nodes.filter(n => n[4]).length, i.td ? 1 : 0, `${rel}: data-focus`);
    // Deterministic "Today": the build's as-of day; model-pages.js moves it in the browser.
    assert.match(html, /<div class="mh-tl-today"><span id="mh-tl-today-label">As of \d{1,2} [A-Z][a-z]+ \d{4}<\/span><\/div>/, rel);
    assert.match(html, /<div id="mh-tl-picker" class="mh-tl-picker" hidden>/);
    assert.match(html, /<div id="mh-tl-zoom" class="mh-seg" role="group" aria-label="Zoom" hidden>/);
    assert.match(html, /<div class="mh-tl-scroll" role="img" tabindex="0" aria-label="Timeline of [^"]+; the same events are listed below">/);
    assert.match(html, /<script src="\/assets\/model-pages\.js" defer><\/script>/);
  }
  // Orbit 2 in detail: grouped release, short meta on the axis, full dates in the list.
  const o2 = page("example-lab/orbit-2/timeline/index.html");
  assert.match(o2, /data-focus><span class="mh-tl-stem"><\/span><span class="mh-tl-dot"><\/span><span class="mh-tl-label"><span class="mh-tl-name">Released \+2<\/span><span class="mh-tl-meta">Lifecycle · 11 Jun 2024<\/span>/);
  assert.match(o2, /<span class="mh-tl-list-date"><time datetime="2024-06-11">11 June 2024<\/time><\/span>\n<span class="mh-tl-list-kind">Lifecycle<\/span>\n<span class="mh-tl-list-label">Released<\/span>/);
  assert.match(o2, /<span class="mh-tl-list-label"><a href="\/models\/example-lab\/orbit-1\/">Predecessor Orbit 1<\/a><\/span>/);
  // A month-precision date is a range bar on the axis, never a day.
  const o1 = page("example-lab/orbit-1/timeline/index.html");
  assert.match(o1, /<div class="mh-tl-node k-life" style="--t:[\d.]+;--r0:[\d.]+;--r1:[\d.]+;[^"]*" data-above="[cnw ]*" data-focus><span class="mh-tl-range"><\/span>/);
  assert.match(o1, /<time datetime="2021-03">March 2021<\/time>/);
  // No date at all: in the "Date unknown" zone, listed last.
  const n6 = page("other-lab/nova-6/timeline/index.html");
  assert.match(n6, /<div class="mh-tl-unknown-zone"><span>Date unknown<\/span><\/div>/);
  assert.match(n6, /<span class="mh-tl-list-date">Date unknown<\/span>\n<span class="mh-tl-list-kind">Lifecycle<\/span>\n<span class="mh-tl-list-label">Released <span class="mh-muted">· No date in any source<\/span><\/span>\n<\/li>\n<\/ol>/);
  // The picker offers every model, the current one selected, as timeline paths.
  const opts = [...o2.matchAll(/<option value="([^"]+)"( selected)?>/g)];
  assert.equal(opts.length, ds.models.length);
  assert.deepEqual(opts.filter(o => o[2]).map(o => o[1]), ["/models/example-lab/orbit-2/timeline/"]);
  assert.ok(opts.every(o => /^\/models\/[a-z0-9-]+\/[a-z0-9-]+\/timeline\/$/.test(o[1])));
  // Same layout as timeline.mjs for the page's own as-of day.
  const i = site.modelById.get("example-lab.orbit-2");
  const t0 = Number(/data-t0="([^"]+)"/.exec(o2)[1]);
  const t = layoutTimeline(i.m, { byId: id => (site.modelById.get(id) || {}).m || null, href: o => (site.modelById.get(o.id) || {}).url || null,
    graph: Object.fromEntries(site.models.map(x => [x.id, x.g])), sources: m => site.modelById.get(m.id).refIds.map(id => site.idx.srcById.get(id)).filter(Boolean),
    status: id => site.idx.status[id] || null, news: m => site.modelById.get(m.id).news, now: new Date(site.asOf + "T12:00:00Z") });
  assert.equal(t.T0, t0);
  assert.equal(count(o2, /<div class="mh-tl-node /g), t.nodes.length);
});

/* ---------- Tracked fixture: registry, redirects, promoted variant, news ---------- */
let T, TF;
before(async () => {
  T = tmp();
  const code = await run({ data: TRACKED, out: join(T, "models"), sitemap: join(T, "sitemap-models.xml"), publish: true, repo: FAKE_REPO,
    registry: loadRegistry(FAKE_REPO), validate: async () => [], now: "2026-09-30T12:00:00Z", ...quiet });
  assert.equal(code, 0);
  TF = tree(join(T, "models"));
});
const tpage = rel => { const t = TF.get(rel); assert.ok(t, `missing ${rel}`); return t; };

test("tracked organisations get the registry hue and inline logos with unique ids (AC-27)", () => {
  const html = tpage("acme/rocket-1/index.html");
  assert.ok(count(html, /<span class="mh-logo"/g) >= 3, "header logo plus both organisations");
  assert.ok(!html.includes("__U__"));
  const ids = idsOf(html);
  assert.deepEqual(ids.filter((x, k) => ids.indexOf(x) !== k), []);
  assert.ok(ids.filter(x => x.startsWith("acmegrad")).length >= 2);
  for (const [, ref] of html.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(ref), `logo reference ${ref} resolves on the page`);
  assert.match(html, /<main id="main" class="mh mh-model" style="--h:255" data-mh-view="model"/);
  assert.match(tpage("quiet-lab/index.html"), /<main id="main" class="mh mh-company co-neutral" data-mh-view="company"/);
  for (const [rel, h] of TF) if (rel.endsWith(".html")) {
    assert.ok(!h.includes("__U__"), rel);
    const all = idsOf(h);
    assert.deepEqual(all.filter((x, k) => all.indexOf(x) !== k), [], rel);
  }
});

test("the dashboard link appears only for organisations with a radarCompanyId", () => {
  const link = 'href="/?view=timeline&amp;cat=model-releases&amp;company=acme"';
  assert.ok(tpage("acme/index.html").includes(link));
  assert.ok(tpage("acme/rocket-2/index.html").includes(link));
  assert.ok(!tpage("quiet-lab/index.html").includes("?view=timeline"));
  assert.ok(!tpage("quiet-lab/whisper-1/index.html").includes("?view=timeline"));
});

test("a company page without a full model is noindex and not in the sitemap", () => {
  const sm = readFileSync(join(T, "sitemap-models.xml"), "utf8");
  assert.match(tpage("quiet-lab/index.html"), /<meta name="robots" content="noindex, follow">/);
  assert.ok(!sm.includes("/models/quiet-lab/"));
  assert.ok(sm.includes("<loc>https://ai-radar.eu/models/zenith/</loc>"));
  const j = JSON.parse(tpage("index.json"));
  assert.equal(j.generated, "2026-09-30T12:00:00Z");
  assert.deepEqual(j.organizations.find(o => o.id === "acme").names, ["acme ai", "acme"]);
  assert.equal(j.organizations.find(o => o.id === "acme").radarCompanyId, "acme");
});

test("old slugs and routes become noindex redirect stubs (§5.4)", () => {
  const sm = readFileSync(join(T, "sitemap-models.xml"), "utf8");
  for (const rel of ["acme/rocket-two/index.html", "zenith/rocket-2/index.html"]) {
    const html = tpage(rel);
    assert.match(html, /<meta http-equiv="refresh" content="0; url=\/models\/acme\/rocket-2\/">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/ai-radar\.eu\/models\/acme\/rocket-2\/">/);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /<a href="\/models\/acme\/rocket-2\/">Rocket 2<\/a>/);
    assert.ok(!html.includes("application/ld+json"));
  }
  assert.ok(!sm.includes("rocket-two") && !sm.includes("/models/zenith/rocket-2/"));
  // The timeline subpage moves along with the model page.
  for (const rel of ["acme/rocket-two/timeline/index.html", "zenith/rocket-2/timeline/index.html"]) {
    const html = tpage(rel);
    assert.match(html, /<meta http-equiv="refresh" content="0; url=\/models\/acme\/rocket-2\/timeline\/">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/ai-radar\.eu\/models\/acme\/rocket-2\/timeline\/">/);
    assert.match(html, /<meta name="robots" content="noindex">/);
  }
  assert.ok(TF.has("acme/rocket-2/timeline/index.html"));
});

test("a promoted variant keeps its old anchor on the original page (§13.1)", () => {
  const html = tpage("acme/rocket-2/index.html");
  assert.match(html, /<section id="variant-pro" class="mh-variant mh-promoted">[\s\S]*?<a href="\/models\/acme\/rocket-2-pro\/">Rocket 2 Pro<\/a>/);
  assert.match(html, /<section id="variant-mini" class="mh-variant">/);
  assert.match(tpage("acme/rocket-2-pro/index.html"), /Previously<\/dt><dd>a variant of <a href="\/models\/acme\/rocket-2\/">Rocket 2<\/a>/);
});

test("news: include + state − exclude, one entry per story within 2 days, newest first, on every linked model (AC-16, AC-30)", () => {
  const cov = sectionOf(tpage("acme/rocket-2/index.html"), "coverage");
  const titles = [...cov.matchAll(/<li class="mh-news-item"><span class="mh-news-title"><a href="([^"]+)">([^<]+)<\/a>/g)].map(m => m[1]);
  assert.deepEqual(titles, ["https://news.example.com/rocket-2-mini", "https://acme.example/blog/rocket-2-again", "https://news.example.com/rocket-compared", "https://news.google.example/redirect/abc"]);
  assert.ok(!cov.includes("rocket-2-review"), "excluded post");
  assert.match(cov, /about Rocket 2 Mini/);
  assert.match(cov, /<time datetime="2026-08-01T07:30:00Z">1 August 2026<\/time>/);
  const r1 = sectionOf(tpage("acme/rocket-1/index.html"), "coverage");
  assert.ok(r1.includes("https://news.example.com/rocket-compared") && r1.includes("Hands-on with Rocket 1"));
  assert.match(r1, /<time datetime="2026-07-02">2 July 2026<\/time>/, "date-only snapshot");
  assert.equal(JSON.parse(tpage("index.json")).models.find(m => m.id === "acme.rocket-2").news, 4);
  const org = JSON.parse(tpage("acme/index.json"));
  assert.deepEqual(org.news.find(n => n.postId === "p4").models.map(x => x.id), ["acme.rocket-1", "acme.rocket-2"]);
  assert.match(sectionOf(tpage("acme/index.html"), "coverage"), /about <a href="\/models\/acme\/rocket-1\/">Rocket 1<\/a>, <a href="\/models\/acme\/rocket-2\/">Rocket 2<\/a>/);
  assert.equal(displayNews([{ postId: "x", link: "javascript:alert(1)", title: "t", publishedAt: "nope", models: [] }]).length, 0);
});

test("escaping, suppressed links, alternatives, qualifiers and private notes", () => {
  const r2 = tpage("acme/rocket-2/index.html");
  assert.ok(r2.includes("Second Rocket model with a &quot;reasoning&quot; mode &amp; tool use."));
  const pro = tpage("acme/rocket-2-pro/index.html");
  const src = /<li id="source-src\.acme\.rocket-2-pro-notes"[\s\S]*?<\/li>/.exec(pro)[0];
  assert.match(src, /<cite>Rocket 2 Pro release notes<\/cite>/);
  assert.ok(!/href="https:\/\/acme\.example\/notes/.test(src));
  assert.ok(src.includes("https://acme.example/notes/rocket-2-pro?utm_source=feed"), "the original URL is shown as text");
  const r1 = tpage("acme/rocket-1/index.html");
  assert.match(r1, /Other sources give: <time datetime="2023-04">April 2023<\/time>/);
  assert.match(r1, /c\. 8K tokens/);
  assert.match(r1, /<time datetime="2024">c\. 2024<\/time>/);
  assert.match(r1, /data-mh-claim="capabilities\.openWeights" data-mh-evidence="primary-source">\n<span class="mh-claim-label">Open weights<\/span>\n<span class="mh-claim-value">No<\/span>/);
  for (const [rel, h] of TF) assert.ok(!h.includes("Internal note"), `${rel}: record notes are not published`);
});
