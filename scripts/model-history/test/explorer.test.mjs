/* Tests for the Explorer enhancement (assets/models.js).
   The browser script runs in a node:vm sandbox with __MH_TEST__ set and no DOM, so its pure
   functions can be tested directly. Its copies of normalize/fold/compact/sortKey and of the
   vocabularies are compared with lib.mjs/derive.mjs. The fixture tests use the generator's
   real output (build.mjs compile/indexJson/renderSite, in memory), so a change to the index
   shape, the page links or the list markup breaks them. A small fake DOM, filled from the
   rendered /models/ page, drives the real browser path (load, facets, search, URL, retry).
   Run: node --test scripts/model-history/test/explorer.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import { VOCAB, loadDataset, normalize, fold, compact, parseDate, sortKey } from "../lib.mjs";
import { buildIndex, modelEvidence, timelineDate, EVIDENCE } from "../derive.mjs";
import { compile, indexJson, renderSite } from "../build.mjs";
import { fakeDom } from "./fake-dom.mjs";
import { EVIDENCE_SHORT, EVIDENCE_GLYPH, FLAG_LABEL, LIFECYCLE_LABEL, label } from "../templates.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const SCRIPT_PATH = join(repo, "assets", "models.js");
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");
const FIXTURE = join(here, "fixtures", "basic");
// Objects from the vm realm have their own prototypes; compare them as plain JSON.
const plain = x => JSON.parse(JSON.stringify(x));

function loadApi() {
  const sandbox = { __MH_TEST__: true, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox, { filename: "models.js" });
  return sandbox.__MH__;
}
const api = loadApi();

// Deterministic pseudo-random numbers (mulberry32), so failures can be reproduced.
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];

/* The generator's output for the basic fixture, built in memory (the publish gate keeps
   models/ out of the repo, so there is no file to read). hrefOrg is what start() reads in
   the browser: the organisation in each list item's first model link (the organisation
   link in the row's kicker comes first and is skipped, as start() skips it). */
const ORIGIN = "https://ai-radar.eu";
function generated(dir) {
  const ds = loadDataset(dir), site = compile(ds);
  const index = indexJson(site), html = renderSite(site).files.get("index.html");
  const main = fakeDom().parse(/<main[\s>][\s\S]*<\/main>/.exec(html)[0]);
  const list = main.getElementsByTagName("ol").find(n => n.getAttribute("id") === "mh-list");
  const items = list.children.map(li => ({ id: li.getAttribute("data-mh-model"),
    href: (li.getElementsByTagName("a").map(a => a.getAttribute("href")).find(h => api.orgFromHref(h, ORIGIN)) || null) }));
  const hrefOrg = Object.fromEntries(items.map(it => [it.id, api.orgFromHref(it.href, ORIGIN)]));
  return { ds, idx: buildIndex(ds), index, html, items, hrefOrg };
}
const FX = generated(FIXTURE);
const fixtureCtx = () => api.buildRecords(FX.index, FX.hrefOrg);
const dsModel = id => FX.ds.models.find(m => m.id === id);
const emptySel = () => Object.fromEntries(api.FACET_KEYS.map(f => [f, []]));
const st = (over = {}) => ({ query: "", sort: "date-desc", ...over, sel: { ...emptySel(), ...(over.sel || {}) } });
const ids = list => Array.from(list, r => r.id);   // Array.from: a test-realm array

/* ---------- Loading & privacy ---------- */
test("loads in a sandbox without a DOM and exposes the pure functions", () => {
  assert.ok(api, "__MH__ is set when __MH_TEST__ is true");
  for (const k of ["normalize", "compact", "sortKey", "buildRecords", "matchQuery", "applyFilters", "facetCounts", "parseUrlState", "serializeUrlState"])
    assert.equal(typeof api[k], "function", k);
});

test("the test hook needs __MH_TEST__ === true (a clobbered, merely truthy value does not expose the API)", () => {
  for (const v of [1, "true", {}, [], () => true]) {
    const sandbox = { __MH_TEST__: v, URLSearchParams };   // no document: start() is not reached either
    vm.createContext(sandbox);
    vm.runInContext(SCRIPT, sandbox, { filename: "models.js" });
    assert.equal(sandbox.__MH__, undefined, String(v));
  }
});

test("the script makes no storage access and exactly one same-origin request", () => {
  const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");   // comments may mention them
  for (const word of ["localStorage", "sessionStorage", "indexedDB", "cookie", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource", "import(", "innerHTML", "insertAdjacentHTML", "document.write"])
    assert.ok(!code.includes(word), `models.js must not use ${word}`);
  assert.equal(code.match(/fetch\(/g).length, 1);
  assert.match(code, /fetch\(INDEX_URL, \{ cache: "no-cache" \}\)/);
  assert.match(code, /const INDEX_URL = "\/models\/index\.json";/);
  assert.ok(!/["'`]https?:/.test(code), "no absolute URL literals (no third-party requests)");
  assert.ok(Buffer.byteLength(SCRIPT.replace(/\r\n/g, "\n")) <= 30 * 1024, "spec §32: own JS ≤ 30 KB (as published: LF line endings)");
});

/* ---------- Parity with lib.mjs / derive.mjs ---------- */
test("vocabularies match lib.mjs and derive.mjs", () => {
  assert.deepEqual(plain(api.CATEGORIES), VOCAB.category);
  assert.deepEqual(plain(api.LIFECYCLE), VOCAB.lifecycle);
  assert.deepEqual(plain(api.EVIDENCE), EVIDENCE);
  assert.deepEqual(plain(api.FLAGS), ["original-unavailable", "some-claims-incomplete"]);
  assert.deepEqual(plain(api.FACET_KEYS), ["org", "family", "category", "year", "status", "evidence", "open"]);
  assert.deepEqual(plain(api.SORT_KEYS), ["date-desc", "date-asc", "name", "org"]);
  for (const f of ["category", "status", "evidence", "open"]) for (const v of Object.keys(api.LABELS[f])) assert.ok(api.LABELS[f][v]);
  for (const c of VOCAB.category) assert.ok(api.LABELS.category[c], c);
  for (const l of VOCAB.lifecycle) assert.ok(api.LABELS.status[l], l);
});

// The facet labels must read like the list items the generator renders (templates.mjs):
// the short evidence forms and glyphs of the rows (design 1c), open weights as on the model page.
test("facet labels match the page labels in templates.mjs", () => {
  assert.deepEqual(plain(api.LABELS.evidence), { ...EVIDENCE_SHORT, ...FLAG_LABEL });
  assert.deepEqual(plain(api.GLYPHS), EVIDENCE_GLYPH);
  // The one intentional difference: inside the Status fieldset "Unknown", on the page "Status unknown".
  assert.deepEqual(plain(api.LABELS.status), { ...LIFECYCLE_LABEL, unknown: "Unknown" });
  assert.equal(LIFECYCLE_LABEL.unknown, "Status unknown");
  assert.deepEqual(plain(api.LABELS.category), Object.fromEntries(VOCAB.category.map(c => [c, label(c)])));
  assert.deepEqual(plain(api.LABELS.open), { yes: "Yes", no: "No", unknown: "Not recorded" });
  assert.deepEqual(plain(api.LABELS.year), { unknown: "Unknown" });
});

test("count text: all models, or how many of them are shown", () => {
  assert.equal(api.countText(11, 11, false), "All 11 models");
  assert.equal(api.countText(4, 11, true), "Showing 4 of 11 models");
  assert.equal(api.countText(0, 11, true), "Showing 0 of 11 models");
  assert.equal(api.countText(1, 1, false), "1 model");
  assert.equal(api.countText(1, 1, true), "Showing 1 of 1 model");
});

test("normalize, fold and compact are identical to lib.mjs", () => {
  const fixed = ["GPT-4", "gpt4", "GPT\u20114", "GPT\u20134", "GPT\u20144", "GPT\u22124", "\uff27\uff30\uff34\uff0d\uff14", "\uff27\uff30\uff34-\uff14", "Orbit 2", "orbit2", "Orbit 2.5",
    "  Orbit\t\n 2  ", "Mistral M\u00e9dium", "\u00d1and\u00fa", "\u00c5ngstr\u00f6m", "\ufb01ne-tune", "\u216b", "x\u00b2", "Orbit\u00b72", "orbit_2/mini", "\u0130stanbul",
    "\u00df", "\u03a3\u03af\u03c3\u03c5\u03c6\u03bf\u03c2", "\u65e5\u672c\u8a9e\u30e2\u30c7\u30eb", "\uff76\uff80\uff76\uff85", "", " ", null, undefined, 0, 42, false, "a\u0301", "e\u0308\u0301", "\u00a0nbsp\u00a0",
    "\u2003em space", "Claude 3.5 Sonnet", "Llama-3.1-405B", "o1-preview", "DALL\u00b7E 3", "🤖 bot", "𝐀BC"];
  const r = rng(7), alphabet = "aAzZ\u00e9\u00c9\u00e8\u00fc\u00dc\u00f10129 -_./\u00b7\u2010\u2011\u2012\u2013\u2014\u2015\u2212\t\n\uff27\uff30\uff14\ufb01\u0130\u00df\u03a3\u0301\u00a0()'+";
  const random = Array.from({ length: 3000 }, () => Array.from({ length: 1 + Math.floor(r() * 14) }, () => pick(r, [...alphabet])).join(""));
  for (const s of fixed.concat(random)) {
    assert.equal(api.normalize(s), normalize(s), `normalize ${JSON.stringify(s)}`);
    assert.equal(api.fold(s), fold(s), `fold ${JSON.stringify(s)}`);
    assert.equal(api.compact(s), compact(s), `compact ${JSON.stringify(s)}`);
  }
  assert.equal(api.compact("GPT-4"), api.compact("gpt4"));
  assert.equal(api.compact("Orbit 2"), "orbit2");
});

test("parseDate and sortKey are identical to lib.mjs", () => {
  const fixed = ["2024", "2024-06", "2024-06-11", "2024-02-29", "2023-02-29", "2024-02-30", "2024-13", "2024-00", "2024-06-00",
    "2024-06-31", "0000", "0001", "0001-01-01", "9999-12-31", "2024-6", "2024-06-1", "24-06-11", " 2024", "2024 ", "2024-06-11T00:00:00Z",
    "2024/06/11", "", "abcd", "20240611", "1900-02-29", "2000-02-29", "2100-02-29", null, undefined];
  const r = rng(11), parts = () => {
    const y = pick(r, ["0000", "0001", "1999", "2000", "2024", "2025", "9999", "123", "20245"]);
    const m = pick(r, [null, "00", "01", "02", "06", "12", "13", "1"]);
    const d = pick(r, [null, "00", "01", "15", "28", "29", "30", "31", "32", "5"]);
    return y + (m === null ? "" : "-" + m + (d === null ? "" : "-" + d));
  };
  const random = Array.from({ length: 3000 }, parts);
  for (const v of fixed.concat(random)) {
    assert.deepEqual(plain(api.parseDate(v)), plain(parseDate(v)), `parseDate ${JSON.stringify(v)}`);
    assert.equal(api.sortKey(v), sortKey(v), `sortKey ${JSON.stringify(v)}`);
  }
  assert.equal(api.sortKey("2024-06-11"), "2024-06-11-0");
  assert.equal(api.sortKey("2024-06"), "2024-06-00-1");
  assert.equal(api.sortKey("2024"), "2024-00-00-2");
  assert.equal(api.sortKey(null), "9999-99-99-9");
});

/* ---------- Records ---------- */
test("buildRecords derives organisation, year, sort key and facet values", () => {
  const ctx = fixtureCtx(), by = Object.fromEntries(ctx.records.map(r => [r.id, r]));
  assert.equal(ctx.records.length, 11);
  for (const m of FX.ds.models) {
    assert.equal(FX.hrefOrg[m.id], FX.idx.routeOrg(m), `page link of ${m.id} = derive.routeOrg`);
    assert.equal(by[m.id].org, FX.hrefOrg[m.id], m.id);
  }
  // The unit's model is listed under the parent route (link), and without links via its "org".
  assert.equal(by["example-lab-research.orbit-0"].org, "example-lab");
  const noLinks = api.buildRecords(FX.index);
  for (const r of noLinks.records) assert.equal(r.org, FX.hrefOrg[r.id], `fallback ${r.id}`);
  assert.equal(by["example-lab.orbit-2"].sk, "2024-06-11-0");
  assert.equal(by["example-lab.orbit-2"].year, "2024");
  assert.equal(by["other-lab.nova-6"].year, "unknown");
  assert.equal(by["other-lab.nova-6"].sk, "9999-99-99-9");
  assert.deepEqual(plain(by["example-lab.orbit-2"].fv.open), ["yes"]);
  assert.deepEqual(plain(by["other-lab.nova-7"].fv.open), ["unknown"]);
  assert.deepEqual(plain(by["example-lab.orbit-1"].fv.evidence), ["archived-primary-source", "original-unavailable"]);
  assert.deepEqual(plain(by["example-lab-research.orbit-0"].fv.evidence), ["insufficient-evidence", "original-unavailable", "some-claims-incomplete"]);
  // Facet values in display order; categories, lifecycle, evidence and open follow the vocabularies.
  assert.deepEqual(plain(ctx.values.org.map(v => [v.value, v.label])), [["example-lab", "Example Lab"], ["other-lab", "Other Lab"]]);
  assert.deepEqual(plain(ctx.values.year.map(v => v.value)), ["2025", "2024", "2021", "2019", "unknown"]);
  assert.deepEqual(plain(ctx.domains.category), VOCAB.category);
  assert.deepEqual(plain(ctx.domains.evidence), EVIDENCE.concat(["original-unavailable", "some-claims-incomplete"]));
  assert.deepEqual(plain(ctx.domains.open), ["yes", "no", "unknown"]);
  assert.deepEqual(plain(ctx.values.family.find(v => v.value === "example-lab.orbit-lite").orgs), ["example-lab"]);
  assert.equal(ctx.values.category.find(v => v.value === "robotics").occurs, false);
  assert.equal(ctx.values.category.find(v => v.value === "code").occurs, true);
});

test("buildRecords: the page link wins, then the family prefix, then the model prefix", () => {
  const index = { organizations: [{ id: "a", name: "A", names: [] }, { id: "b", name: "B", names: [] }],
    families: [{ id: "b.fam", name: "Fam" }, { id: "x.fam", name: "Fam" }],
    models: [
      { id: "a.one", name: "One", family: "b.fam", date: null },
      { id: "a.two", name: "Two", family: null, date: { v: "2024-13" } },
      { id: "zz.three", name: "Three", family: "x.fam", date: { v: "2020" } },
      { id: "a.four", name: "Four", family: "b.fam" },
      { id: "a.four", name: "Duplicate", family: "b.fam" },
      { id: "", name: "No id" }, null] };
  const ctx = api.buildRecords(index, { "a.four": "a" });
  const by = Object.fromEntries(ctx.records.map(r => [r.id, r]));
  assert.deepEqual(Object.keys(by), ["a.one", "a.two", "zz.three", "a.four"]);
  assert.equal(by["a.one"].org, "b");         // family prefix before model prefix
  assert.equal(by["a.two"].org, "a");         // model prefix
  assert.equal(by["zz.three"].org, null);     // neither names a known organisation
  assert.equal(by["a.four"].org, "a");        // page link
  assert.equal(by["a.four"].name, "Four");    // first entry wins
  assert.equal(by["a.two"].year, "unknown");  // invalid date = unknown, not guessed
  assert.equal(by["zz.three"].fv.org.length, 0);
  // Two families named "Fam": the label carries the organisation.
  // (x.fam has no model with a known organisation, so it keeps the plain name.)
  assert.deepEqual(plain(ctx.values.family.map(v => [v.value, v.label])), [["x.fam", "Fam"], ["b.fam", "Fam (A, B)"]]);
});

test("buildRecords: the optional org on a model or family beats the prefixes, unknown orgs are ignored", () => {
  const index = { organizations: [{ id: "lab", name: "Lab" }, { id: "other", name: "Other" }],
    families: [{ id: "lab-unit.fam", name: "Unit fam", org: "lab" }, { id: "other.fam", name: "Fam", org: "ghost" }],
    models: [
      { id: "lab-unit.a", name: "A", family: null, org: "lab" },          // a unit's model without a family
      { id: "lab-unit.b", name: "B", family: "lab-unit.fam" },            // the family's org
      { id: "other.c", name: "C", family: "other.fam", org: "ghost" },    // unknown org: prefixes decide
      { id: "lab-unit.d", name: "D", family: null, org: "other" },
      { id: "lab-unit.e", name: "E", family: null, org: 42 }] };
  const by = Object.fromEntries(api.buildRecords(index, { "lab-unit.d": "lab" }).records.map(r => [r.id, r.org]));
  assert.deepEqual(by, { "lab-unit.a": "lab", "lab-unit.b": "lab", "other.c": "other", "lab-unit.d": "lab", "lab-unit.e": null });
});

test("buildRecords: a missing or unknown evidence status is filed as insufficient-evidence, like the page label", () => {
  const ctx = api.buildRecords({ organizations: [{ id: "lab", name: "Lab" }], families: [],
    models: [{ id: "lab.a", name: "A" }, { id: "lab.b", name: "B", ev: "made-up", flags: ["original-unavailable", "bogus"] },
      { id: "lab.c", name: "C", ev: "secondary-sources", flags: "not-a-list" }] });
  const ev = Object.fromEntries(ctx.records.map(r => [r.id, plain(r.fv.evidence)]));
  assert.deepEqual(ev, { "lab.a": ["insufficient-evidence"], "lab.b": ["insufficient-evidence", "original-unavailable"], "lab.c": ["secondary-sources"] });
  const st0 = { query: "", sort: "date-desc", sel: { ...emptySel(), evidence: ["insufficient-evidence"] } };
  assert.deepEqual(ids(api.applyFilters(ctx.records, st0)).sort(), ["lab.a", "lab.b"]);
});

test("orgFromHref accepts same-origin model links only", () => {
  const o = (h, origin = ORIGIN) => api.orgFromHref(h, origin);
  assert.equal(o("/models/example-lab/orbit-2/"), "example-lab");
  assert.equal(o("/models/example-lab/orbit-2"), "example-lab");
  assert.equal(o("/models/example-lab/orbit-2/#sources"), "example-lab");
  assert.equal(o("https://ai-radar.eu/models/example-lab/orbit-2/"), "example-lab");
  assert.equal(o("https://evil.example/models/example-lab/orbit-2/"), null, "another site");
  assert.equal(o("https://ai-radar.eu.evil.example/models/example-lab/orbit-2/"), null, "look-alike host");
  assert.equal(o("//evil.example/models/example-lab/orbit-2/"), null, "protocol-relative");
  assert.equal(o("http://ai-radar.eu/models/example-lab/orbit-2/"), null, "other scheme is another origin");
  assert.equal(o("/models/example-lab/"), null, "company page, not a model page");
  assert.equal(o("/models/Example-Lab/orbit-2/"), null);
  assert.equal(o("/models/../x/y/"), null);
  assert.equal(o(null), null);
  assert.equal(o("/models/example-lab/orbit-2/", undefined), "example-lab");
});

/* ---------- Search ---------- */
test("search: separator-free variant, NFKC, diacritics and hyphens", () => {
  const ctx = api.buildRecords({ organizations: [{ id: "lab", name: "Lab", names: ["lab"] }], families: [],
    models: [{ id: "lab.gpt-4", slug: "gpt-4", name: "GPT-4", alias: [] }, { id: "lab.medium", slug: "medium-3", name: "M\u00e9dium 3", alias: [] },
      { id: "lab.o1", slug: "o1", name: "o1-preview", alias: ["o1 preview"] }] });
  const [gpt, med, o1] = ctx.records;
  for (const q of ["gpt4", "GPT-4", "gpt 4", "gpt\u20114", "\uff27\uff30\uff34\uff0d\uff14", "Gpt_4", "gpt.4"]) assert.equal(api.matchQuery(gpt, q), 0, q);
  assert.equal(api.matchQuery(gpt, "gpt"), 1);
  assert.equal(api.matchQuery(gpt, "pt-4"), 2);
  assert.equal(api.matchQuery(med, "medium"), 1);
  assert.equal(api.matchQuery(med, "M\u00c9DIUM 3"), 0);
  assert.equal(api.matchQuery(o1, "o1 preview"), 0);
  assert.equal(api.matchQuery(o1, "preview"), 2);
  assert.equal(api.matchQuery(gpt, "claude"), -1);
  assert.equal(api.matchQuery(gpt, "   "), 0, "an empty query matches everything");
  assert.equal(api.matchQuery(gpt, "lab"), 1, "organisation name");
  assert.equal(api.matchQuery(gpt, "lab claude"), -1);
});

test("search: a query of separators only is empty; only the three ranks of spec §23.2 exist", () => {
  const ctx = api.buildRecords({ organizations: [{ id: "lab", name: "Lab", names: ["lab"] }], families: [],
    models: [{ id: "lab.gpt-4", slug: "gpt-4", name: "GPT-4", alias: [] }, { id: "lab.x", slug: "x", name: "X", alias: [] }] });
  const [gpt] = ctx.records;
  for (const q of ["-", " - ", "/", ".", "_", "--", " / . "]) {
    assert.equal(api.prepQuery(q), null, JSON.stringify(q));
    assert.deepEqual(ids(api.applyFilters(ctx.records, st({ query: q }))).sort(), ["lab.gpt-4", "lab.x"], `${q} filters nothing`);
    assert.equal(api.isActive(st({ query: q })), false, `${q} is not an active filter`);
  }
  assert.equal(api.matchQuery(gpt, "gpt -"), 1, "trailing separators do not block a prefix match");
  // No fourth "every word somewhere" rank: words from different fields do not combine.
  for (const q of ["lab gpt", "lab gpt - 4", "lab 4", "lab gpt4", "gpt lab"]) assert.equal(api.matchQuery(gpt, q), -1, q);
  const ranks = new Set();
  for (const q of ["gpt-4", "gpt", "pt-4", "4", "g", "lab", "zzz", "gpt4 lab"]) ranks.add(api.matchQuery(gpt, q));
  assert.deepEqual([...ranks].sort((a, b) => a - b), [-1, 0, 1, 2]);
});

test("search on the fixture: names, aliases, variant names, family, organisation and former names", () => {
  const ctx = fixtureCtx();
  const find = q => ids(api.applyFilters(ctx.records, st({ query: q, sort: "name" })));
  const orbit2 = find("orbit2");
  assert.equal(orbit2[0], "example-lab.orbit-2", "exact beats prefix");
  assert.deepEqual(orbit2.slice().sort(), ["example-lab.orbit-2", "example-lab.orbit-2-2024-09", "example-lab.orbit-2-5", "example-lab.orbit-2-vision"]);
  assert.deepEqual(find("orbit 2 mini"), ["example-lab.orbit-2"], "variant name (via alias)");
  assert.deepEqual(find("orbit-2-5"), ["example-lab.orbit-2-5"], "slug / dotted version");
  assert.deepEqual(find("orbit 2.5"), ["example-lab.orbit-2-5"]);
  assert.equal(find("example lab").length, 9, "organisation name");
  assert.equal(find("examplelab").length, 9, "organisation without separators");
  assert.equal(find("example research").length, 9, "former name");
  assert.deepEqual(find("nova").slice().sort(), ["other-lab.nova-6", "other-lab.nova-7"], "family and name");
  assert.deepEqual(find("orbit lite"), ["example-lab.orbit-lite-1"]);
  assert.deepEqual(find("other lab 7"), [], "organisation and name do not combine (spec §23.2: three ranks)");
  assert.deepEqual(find("zzz"), []);
  // Ranking: exact alias > starts with > contains, and within a rank the chosen sort.
  const ranked = api.applyFilters(ctx.records, st({ query: "orbit 3", sort: "date-asc" }));
  assert.deepEqual(ids(ranked), ["example-lab.orbit-3", "example-lab.orbit-3-merge"]);
  const rank = api.rankAll(ctx.records, "vision");
  assert.equal(rank[ctx.records.findIndex(r => r.id === "example-lab.orbit-2-vision")], 2);
});

/* ---------- Facets ---------- */
test("facets: OR within a facet, AND across facets, year unknown, open, evidence flags", () => {
  const ctx = fixtureCtx(), R = ctx.records;
  const f = sel => ids(api.applyFilters(R, st({ sel, sort: "date-asc" })));
  assert.deepEqual(f({ org: ["other-lab"] }), ["other-lab.nova-7", "other-lab.nova-6"], "unknown date last");
  assert.deepEqual(f({ category: ["code", "reasoning"] }), ["other-lab.nova-7", "example-lab.orbit-3"]);
  assert.deepEqual(f({ org: ["example-lab"], category: ["reasoning"] }), ["example-lab.orbit-3"]);
  assert.deepEqual(f({ org: ["other-lab"], category: ["reasoning"] }), []);
  assert.deepEqual(f({ year: ["unknown"] }), ["other-lab.nova-6"]);
  assert.deepEqual(f({ year: ["2019", "2021"] }), ["example-lab-research.orbit-0", "example-lab.orbit-1"]);
  assert.deepEqual(f({ open: ["yes"] }), ["example-lab.orbit-2"]);
  assert.deepEqual(f({ open: ["no"] }), []);
  assert.equal(f({ open: ["unknown"] }).length, 10);
  assert.deepEqual(f({ evidence: ["original-unavailable"] }), ["example-lab-research.orbit-0", "example-lab.orbit-1"]);
  assert.deepEqual(f({ evidence: ["archived-primary-source", "secondary-sources"] }), ["example-lab.orbit-1", "example-lab.orbit-2-vision"]);
  // Whatever flags the generator writes, the facet finds exactly those models (spec §9.4 is
  // checked separately below).
  assert.deepEqual(f({ evidence: ["some-claims-incomplete"] }).slice().sort(),
    FX.index.models.filter(m => m.flags.includes("some-claims-incomplete")).map(m => m.id).sort());
  assert.deepEqual(f({ status: ["research-only", "preview"] }), ["example-lab-research.orbit-0", "example-lab.orbit-3-merge"]);
  assert.deepEqual(f({ family: ["example-lab.orbit-lite"] }), ["example-lab.orbit-lite-1"]);
});

test("facet counts respect the other active facets and the search", () => {
  const ctx = fixtureCtx(), R = ctx.records;
  let c = plain(api.facetCounts(R, st()));
  assert.deepEqual(c.org, { "example-lab": 9, "other-lab": 2 });
  assert.equal(c.year.unknown, 1);
  assert.deepEqual(c.open, { yes: 1, unknown: 10 });
  c = plain(api.facetCounts(R, st({ sel: { org: ["other-lab"] } })));
  assert.deepEqual(c.org, { "example-lab": 9, "other-lab": 2 }, "a facet ignores its own selection");
  assert.deepEqual(c.category, { language: 2, code: 1 }, "other facets follow the selection");
  assert.deepEqual(c.family, { "other-lab.nova": 2 });
  c = plain(api.facetCounts(R, st({ query: "orbit", sel: { category: ["reasoning"] } })));
  assert.deepEqual(c.org, { "example-lab": 1 });
  assert.equal(c.category.language, 8, "Orbit 2 Vision is multimodal only");
  assert.equal(c.category.reasoning, 1);
});

// Independent brute-force implementation of spec §23.3, compared over many random states.
function bruteForce(ctx, s) {
  const R = Array.from(ctx.records), ranks = R.map(r => api.matchQuery(r, s.query));
  const pass = (r, f) => !s.sel[f].length || r.fv[f].some(v => s.sel[f].includes(v));
  const list = R.filter((r, i) => ranks[i] >= 0 && api.FACET_KEYS.every(f => pass(r, f)));
  const counts = {};
  for (const f of api.FACET_KEYS) {
    counts[f] = {};
    for (const v of ctx.domains[f]) {
      const n = R.filter((r, i) => ranks[i] >= 0 && r.fv[f].includes(v) && api.FACET_KEYS.every(g => g === f || pass(r, g))).length;
      if (n) counts[f][v] = n;
    }
  }
  return { ids: list.map(r => r.id).sort(), counts };
}
function randomState(ctx, r, queries) {
  const sel = emptySel();
  const n = Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const f = pick(r, api.FACET_KEYS), dom = ctx.domains[f];
    const k = 1 + Math.floor(r() * 2);
    for (let j = 0; j < k; j++) { const v = pick(r, dom); if (!sel[f].includes(v)) sel[f].push(v); }
  }
  return { query: r() < 0.5 ? "" : pick(r, queries), sort: pick(r, api.SORT_KEYS), sel };
}
const sortedCounts = c => Object.fromEntries(Object.entries(c).map(([f, o]) => [f, Object.fromEntries(Object.entries(o).sort())]));

test("filters and counts match a brute-force implementation (fixture, 500 random states)", () => {
  const ctx = fixtureCtx(), r = rng(3);
  const queries = ["orbit", "orbit 2", "nova", "example", "lite", "2", "o", "vision merge", "other lab", "zzz", "orbit2", "research"];
  for (let i = 0; i < 500; i++) {
    const s = randomState(ctx, r, queries), exp = bruteForce(ctx, s);
    assert.deepEqual(ids(api.applyFilters(ctx.records, s)).sort(), exp.ids, JSON.stringify(s));
    assert.deepEqual(sortedCounts(plain(api.facetCounts(ctx.records, s))), sortedCounts(exp.counts), JSON.stringify(s));
  }
});

/* ---------- Sorting ---------- */
test("sorting: date both ways with unknown last and coarse precision first, name, organisation", () => {
  const ctx = api.buildRecords({ organizations: [{ id: "b", name: "Beta" }, { id: "a", name: "Alpha" }], families: [],
    models: [
      { id: "a.m10", name: "M 10", date: { v: "2024-06-11" } }, { id: "a.m2", name: "M 2", date: { v: "2024-06" } },
      { id: "b.x", name: "X", date: { v: "2024" } }, { id: "b.y", name: "Y", date: null },
      { id: "b.z", name: "Z", date: { v: "2023-12-31" } }, { id: "a.same", name: "A same day", date: { v: "2024-06-11" } }] });
  const order = sort => ids(api.applyFilters(ctx.records, st({ sort })));
  assert.deepEqual(order("date-asc"), ["b.z", "b.x", "a.m2", "a.same", "a.m10", "b.y"]);
  assert.deepEqual(order("date-desc"), ["a.same", "a.m10", "a.m2", "b.x", "b.z", "b.y"]);
  assert.deepEqual(order("name"), ["a.same", "a.m2", "a.m10", "b.x", "b.y", "b.z"], "numeric collation: M 2 before M 10");
  assert.deepEqual(order("org"), ["a.m2", "a.same", "a.m10", "b.z", "b.x", "b.y"]);
  assert.deepEqual(order("constructor"), order("date-desc"), "unknown sort falls back to the default");
});

/* ---------- URL state ---------- */
test("parseUrlState ignores unknown keys and values (hasOwnProperty guard) and never reads a search term", () => {
  const { domains } = fixtureCtx();
  const s = plain(api.parseUrlState("?org=other-lab&org=constructor&org=__proto__&family=example-lab.orbit,toString,other-lab.nova" +
    "&category=code&category=code&category=robotics&year=2024&year=1999&year=unknown&status=retired&evidence=original-unavailable" +
    "&open=yes&open=maybe&sort=constructor&q=secret&search=secret&foo=bar", domains, "date-desc"));
  assert.deepEqual(s.sel, { org: ["other-lab"], family: ["example-lab.orbit", "other-lab.nova"], category: ["code", "robotics"],
    year: ["2024", "unknown"], status: ["retired"], evidence: ["original-unavailable"], open: ["yes"] });
  assert.equal(s.sort, "date-desc");
  assert.equal(s.query, "");
  assert.equal(plain(api.parseUrlState("?sort=name", domains, "date-desc")).sort, "name");
  assert.equal(plain(api.parseUrlState("?sort=hasOwnProperty", domains, "date-asc")).sort, "date-asc");
  assert.equal(api.urlHasState("?foo=1&q=x"), false);
  assert.equal(api.urlHasState("?year=2024"), true);
});

test("serializeUrlState is deterministic, keeps other parameters and never writes the search term", () => {
  const { domains } = fixtureCtx();
  const s = st({ query: "my secret search", sort: "name", sel: { year: ["2025", "2024"], org: ["other-lab", "example-lab"], open: ["unknown"] } });
  const out = api.serializeUrlState(s, "?utm_source=mail&org=old&sort=org#x", "date-desc");
  assert.equal(out, "?utm_source=mail&org=example-lab&org=other-lab&year=2024&year=2025&open=unknown&sort=name");
  assert.ok(!/secret/.test(out));
  assert.equal(api.serializeUrlState(st({ query: "secret" }), "", "date-desc"), "", "default state = no query string");
  assert.equal(api.serializeUrlState(st({ sort: "date-asc" }), "?sort=name", "date-asc"), "", "default sort is left out");
  // Round trip.
  const back = plain(api.parseUrlState(out, domains, "date-desc"));
  assert.deepEqual(back.sel.org, ["example-lab", "other-lab"]);
  assert.deepEqual(back.sel.year, ["2024", "2025"]);
  assert.equal(back.sort, "name");
});

test("serializeUrlState keeps other parameters byte for byte and removes its own keys as URLSearchParams reads them", () => {
  const s = st({ sel: { org: ["example-lab"] } });
  assert.equal(api.serializeUrlState(s, "?ref=a%20b&flag&x=1+2&&y=%E2%82%AC", "date-desc"), "?ref=a%20b&flag&x=1+2&y=%E2%82%AC&org=example-lab");
  // Own keys in any spelling URLSearchParams accepts are replaced, so parse and serialize agree.
  assert.equal(api.serializeUrlState(s, "?%6Frg=old&sort=name&ref=1&org", "date-desc"), "?ref=1&org=example-lab");
  assert.equal(api.serializeUrlState(st(), "?", "date-desc"), "");
  assert.equal(api.serializeUrlState(st(), "?ref=a%20b", "date-desc"), "?ref=a%20b", "nothing re-encoded when no state is written");
  // Idempotent: serialising the result again changes nothing.
  const once = api.serializeUrlState(s, "?b=2&a=1&year=2024", "date-desc");
  assert.equal(api.serializeUrlState(s, once, "date-desc"), once);
});

/* ---------- Performance (spec §32, AC-18) ---------- */
function syntheticIndex(n, seed) {
  const r = rng(seed), words = ["Orbit", "Nova", "Atlas", "Comet", "Pulse", "Vega", "Echo", "Quill", "Lumen", "Rift", "Sable", "Tide"];
  const organizations = Array.from({ length: 12 }, (_, i) => ({ id: `org-${i}`, name: `Org ${String.fromCharCode(65 + i)} Labs`,
    names: [`org ${String.fromCharCode(97 + i)} labs`, `org${String.fromCharCode(97 + i)}labs`], radarCompanyId: null, models: 0 }));
  const families = [];
  organizations.forEach((o, i) => { for (let k = 0; k < 5; k++) families.push({ id: `${o.id}.${words[(i + k) % 12].toLowerCase()}-${k}`, name: `${words[(i + k) % 12]} ${k}` }); });
  const models = Array.from({ length: n }, (_, i) => {
    const fam = pick(r, families), org = fam.id.split(".")[0], gen = `${1 + Math.floor(r() * 9)}${r() < 0.3 ? ".5" : ""}`;
    const name = `${fam.name.split(" ")[0]} ${gen}${r() < 0.3 ? " " + pick(r, ["Mini", "Pro", "Vision", "Turbo", "Flash"]) : ""}`;
    const y = 2015 + Math.floor(r() * 12), m = 1 + Math.floor(r() * 12), d = 1 + Math.floor(r() * 28), p = r();
    const v = p < 0.05 ? null : p < 0.6 ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : p < 0.85 ? `${y}-${String(m).padStart(2, "0")}` : String(y);
    const cats = [...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, VOCAB.category)))];
    return { id: `${org}.model-${i}`, slug: `model-${i}`, name, alias: [normalize(name), normalize(name + " " + i)], family: fam.id, gen,
      cats, prom: pick(r, VOCAB.prominence), date: v ? { v, k: "released", q: null } : null, life: pick(r, VOCAB.lifecycle),
      ev: pick(r, EVIDENCE), flags: ["original-unavailable", "some-claims-incomplete"].filter(() => r() < 0.3),
      open: pick(r, [true, false, null]), news: Math.floor(r() * 5) };
  });
  return { schemaVersion: 1, generated: "2026-10-05T00:00:00Z", organizations, families, models };
}

test("1000 models: every filter or search update takes < 50 ms and stays correct", () => {
  const index = syntheticIndex(1000, 42);
  const t0 = performance.now();
  const ctx = api.buildRecords(index);
  const buildMs = performance.now() - t0;
  assert.equal(ctx.records.length, 1000);
  const r = rng(99), names = index.models.map(m => m.name);
  const queries = [];
  for (let i = 0; i < 60; i++) {
    const nm = pick(r, names);
    queries.push(nm, nm.slice(0, 1 + Math.floor(r() * nm.length)), compact(nm), pick(r, ["org c", "orgclabs", "vision", "zz", "2.5", "nova 3 pro", "e"]));
  }
  let max = 0, total = 0;
  for (let i = 0; i < 200; i++) {
    const s = randomState(ctx, r, queries);
    const a = performance.now();
    const ranks = api.rankAll(ctx.records, s.query);
    const list = api.applyFilters(ctx.records, s, ranks);
    api.facetCounts(ctx.records, s, ranks);
    const ms = performance.now() - a;
    max = Math.max(max, ms);
    total += ms;
    if (i % 25 === 0) assert.deepEqual(ids(list).sort(), bruteForce(ctx, s).ids, JSON.stringify(s));
  }
  console.log(`# explorer perf: build ${buildMs.toFixed(1)} ms, 200 updates: max ${max.toFixed(2)} ms, avg ${(total / 200).toFixed(2)} ms`);
  assert.ok(max < 50, `slowest update ${max.toFixed(2)} ms`);
});

/* ---------- Contract with the generator (build.mjs output, always on) ---------- */
const MODEL_KEYS = ["alias", "cats", "date", "ev", "family", "flags", "gen", "id", "life", "name", "news", "open", "prom", "slug"];
test("generator contract: index.json shape (spec §23.1) and the pre-rendered list describe the same models", () => {
  const index = FX.index;
  assert.equal(index.schemaVersion, 1);
  for (const k of ["organizations", "families", "models"]) assert.ok(Array.isArray(index[k]), k);
  for (const o of index.organizations) assert.deepEqual(Object.keys(o).sort(), ["id", "models", "name", "names", "radarCompanyId"], o.id);
  for (const f of index.families) assert.ok(Object.keys(f).every(k => ["id", "name", "org"].includes(k)) && f.id && f.name, f.id);
  for (const m of index.models) {
    // "org" is optional: build.mjs writes it where the id prefix is not the route organisation.
    assert.deepEqual(Object.keys(m).filter(k => k !== "org").sort(), MODEL_KEYS, m.id);
    if ("org" in m) assert.notEqual(m.org, m.id.split(".")[0], `${m.id}: org only where the prefix is wrong`);
    assert.ok(EVIDENCE.includes(m.ev), `${m.id} ev`);
    assert.ok(m.flags.every(f => api.FLAGS.includes(f)), `${m.id} flags`);
    assert.ok(m.open === true || m.open === false || m.open === null, `${m.id} open`);
    const td = timelineDate(dsModel(m.id));
    assert.equal(m.date ? m.date.v : null, td ? td.dv.value : null, `${m.id} date = derive.timelineDate`);
  }
  // Same models, same order: the list is pre-rendered newest first, as date-desc sorts.
  assert.deepEqual(FX.items.map(it => it.id), index.models.map(m => m.id));
  for (const it of FX.items) assert.ok(it.href && FX.hrefOrg[it.id], `${it.id} has a same-origin model link`);
  const ctx = fixtureCtx();
  assert.deepEqual(ids(ctx.sorted["date-desc"]), FX.items.map(it => it.id), "no reorder on the first load");
  for (const r of ctx.records) {
    const m = index.models.find(x => x.id === r.id);
    assert.deepEqual(plain(r.fv.evidence), [m.ev].concat(m.flags), `${r.id} evidence facet = index ev + flags`);
    assert.equal(r.sk, sortKey(m.date && m.date.v), `${r.id} sort key`);
    assert.ok(r.org, `${r.id} has an organisation`);
  }
});

// Spec §9.4: a capability with disclosure != official and no sources makes no claim; it gets
// not-applicable and does not count for some-claims-incomplete. The index must carry
// derive.modelEvidence unchanged (an earlier build.mjs remapped it, flagging Orbit 2).
test("spec §9.4: the index carries derive.modelEvidence's status and flags (Orbit 2 has no flags)", () => {
  for (const m of FX.index.models) {
    const e = modelEvidence(dsModel(m.id), FX.idx);
    assert.equal(m.ev, e.evidence, `${m.id} ev`);
    assert.deepEqual(m.flags, e.flags, `${m.id} flags`);
  }
  assert.deepEqual(FX.index.models.find(m => m.id === "example-lab.orbit-2").flags, []);
  const n = api.applyFilters(fixtureCtx().records, st({ sel: { evidence: ["some-claims-incomplete"] } })).length;
  assert.equal(n, 5);
});

/* ---------- DOM smoke test (fake DOM, the real browser path) ---------- */
/* The real /models/ page from the generator (or another html): its <main> goes into a fake
   DOM, then models.js runs against it. extraItems adds list items; mutate(el) runs before
   the script. */
function explorerPage(url, fetchImpl, { extraItems = [], mutate = null, html = FX.html } = {}) {
  const { h, root, document, touched, parse } = fakeDom();
  const main = parse(/<main[\s>][\s\S]*<\/main>/.exec(html)[0]);
  root.appendChild(h("body", {}, main));
  const el = {};
  for (const k of ["controls", "search", "sort", "facets", "clear", "count", "empty", "error", "retry", "list", "empty-clear", "filter-toggle"]) el[k] = document.getElementById("mh-" + k);
  el.main = main;
  extraItems.forEach(([id, href]) => el.list.appendChild(h("li", { "data-mh-model": id }, h("a", { href }, id))));
  if (mutate) mutate(el);
  // The children of every list item before the script runs: they must survive untouched.
  const contents = new Map(el.list.children.map(li => [li, li.childNodes.slice()]));
  const [path, search = ""] = url.split("?");
  const location = { origin: ORIGIN, pathname: path, search: search ? "?" + search : "", hash: "" };
  const replaced = [], fetched = [], timers = new Map();
  let timerId = 0;
  const sandbox = {
    document, location, URLSearchParams, console,
    window: { addEventListener: () => { throw new Error("readyState is complete: no load listener expected"); } },
    history: { state: null, replaceState(s, t, u) { replaced.push(u); const [p, rest = ""] = u.split("#")[0].split("?"); location.pathname = p; location.search = rest ? "?" + rest : ""; } },
    fetch: async (u, o) => { fetched.push([u, plain(o)]); return fetchImpl(fetched.length); },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => { timers.delete(id); }
  };
  for (const k of ["localStorage", "sessionStorage", "indexedDB"]) Object.defineProperty(sandbox, k, { get() { touched.push(k); return undefined; } });
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox, { filename: "models.js" });
  const flushTimers = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()); };
  const visible = () => el.list.children.filter(li => !li.hidden).map(li => li.getAttribute("data-mh-model"));
  const input = (f, v) => el.facets.getElementsByTagName("input").find(i => i.getAttribute("data-mh-facet") === f && i.value === v);
  const untouched = () => [...contents].every(([li, kids]) => li.childNodes.length === kids.length && kids.every((k, n) => li.childNodes[n] === k));
  // The sort is a group of buttons (design 1c): click one; read the pressed one.
  const sortButtons = () => el.sort.getElementsByTagName("button");
  const sortBy = mode => sortButtons().find(b => b.getAttribute("data-sort") === mode).dispatch("click");
  const pressed = () => sortButtons().filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.getAttribute("data-sort"));
  return { el, location, replaced, fetched, touched, flushTimers, visible, input, document, untouched, sortBy, pressed };
}
// A model's own link in a pre-rendered row (the kicker's organisation link comes first).
const modelLinkOf = li => li.getElementsByTagName("a").find(a => a.getAttribute("class") === "mh-row-name");
const rowOf = n => { while (n && n.tagName !== "LI") n = n.parentNode; return n; };
const tick = () => new Promise(r => setImmediate(r));
const ok = () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(FX.index)) });

test("DOM: loads the index, applies URL state, filters in place, keeps the search out of the URL", async () => {
  const p = explorerPage("/models/?utm_source=x&org=example-lab&org=constructor&sort=name&q=secret", ok);
  for (let i = 0; i < 5; i++) await tick();
  const { el } = p;
  assert.deepEqual(p.fetched, [["/models/index.json", { cache: "no-cache" }]]);
  assert.equal(el.controls.hidden, false);
  assert.equal(el.error.hidden, true);
  assert.equal(el.search.value, "", "?q= is never read into the search field");
  assert.deepEqual(p.pressed(), ["name"], "the URL's sort is the one pressed button");
  assert.match(el.main.getAttribute("class"), /(^| )mh-js( |$)/, "main gets mh-js once the controls work");
  assert.equal(el.facets.getElementsByTagName("fieldset").length, 7);
  assert.equal(p.input("org", "example-lab").checked, true);
  assert.equal(p.visible().length, 9);
  assert.ok(p.visible().every(id => FX.hrefOrg[id] === "example-lab"));
  assert.equal(el.count.textContent, "Showing 9 of 11 models");
  assert.equal(el.count.getAttribute("aria-live"), null, "the first count is written while the region is not live");
  assert.deepEqual(p.replaced, [], "loading does not rewrite the URL");
  assert.equal(el.clear.hidden, false, "Clear filters shows while a filter is active");
  assert.equal(el["filter-toggle"].textContent, "Filters (1)");
  // Families follow the organisation filter.
  assert.equal(p.input("family", "other-lab.nova").parentNode.parentNode.hidden, true);
  assert.equal(p.input("family", "example-lab.orbit").parentNode.parentNode.hidden, false);
  // Facet labels: name, then the count with a screen-reader unit. Evidence has the rows' glyph.
  assert.equal(p.input("org", "other-lab").parentNode.textContent, "Other Lab 2 models");
  const primary = p.input("evidence", "primary-source").parentNode;
  assert.equal(primary.textContent, "● Primary source 5 models");
  assert.equal(primary.getElementsByTagName("span").find(s => s.className === "mh-glyph").getAttribute("aria-hidden"), "true");
  assert.equal(p.input("open", "unknown").parentNode.textContent.replace(/ \d+ models?$/, ""), "Not recorded");

  // Typing filters at once; the live count waits for a pause. The first action makes the
  // region live before its text changes.
  el.search.value = "orbit2";
  el.search.dispatch("input");
  assert.equal(p.visible()[0], "example-lab.orbit-2");
  assert.equal(p.visible().length, 4);
  assert.equal(el.count.getAttribute("aria-live"), "polite");
  assert.equal(el.count.textContent, "Showing 9 of 11 models");
  p.flushTimers();
  assert.equal(el.count.textContent, "Showing 4 of 11 models");
  assert.deepEqual(p.replaced, [], "search never touches the URL");

  el.search.value = "nothing like this";
  el.search.dispatch("input");
  assert.equal(p.visible().length, 0);
  assert.equal(el.empty.hidden, false);

  // Clear (here the one in the empty state): search and facets reset, sort stays, other
  // parameters stay. A focused Clear button disappears, so focus moves to the search field.
  el["empty-clear"].focus();
  el["empty-clear"].dispatch("click");
  assert.equal(el.search.value, "");
  assert.equal(p.document.activeElement, el.search);
  assert.equal(p.visible().length, 11);
  assert.equal(el.empty.hidden, true);
  assert.equal(el.clear.hidden, true, "nothing to clear");
  assert.equal(el["filter-toggle"].textContent, "Filters");
  assert.equal(el.count.textContent, "All 11 models");
  assert.equal(p.input("org", "example-lab").checked, false);
  assert.equal(p.location.search, "?utm_source=x&q=secret&sort=name");

  // A facet change writes the URL with replaceState.
  const code = p.input("category", "code");
  code.checked = true;
  code.dispatch("change");
  assert.deepEqual(p.visible(), ["other-lab.nova-7"]);
  assert.equal(p.location.search, "?utm_source=x&q=secret&category=code&sort=name");
  assert.equal(p.input("org", "example-lab").parentNode.textContent, "Example Lab 0 models");
  assert.equal(p.input("org", "other-lab").parentNode.textContent, "Other Lab 1 model");

  // Sorting reorders the existing items. The count stays "All 11 models", yet the change is
  // announced: the live region text toggles a trailing no-break space (spec §6).
  code.focus();
  el.clear.dispatch("click");
  assert.equal(p.document.activeElement, code, "focus stays where it was when Clear was not focused");
  const said = el.count.textContent;
  p.sortBy("date-asc");
  assert.deepEqual(p.pressed(), ["date-asc"]);
  assert.notEqual(el.count.textContent, said, "a sort change re-announces the count");
  assert.equal(el.count.textContent.trim(), "All 11 models");
  p.sortBy("date-asc");
  assert.equal(el.count.textContent, said, "and again on the next unchanged action");
  const order = el.list.children.map(li => li.getAttribute("data-mh-model"));
  assert.equal(order[0], "example-lab-research.orbit-0");
  assert.equal(order[order.length - 1], "other-lab.nova-6", "unknown date last");
  assert.equal(p.location.search, "?utm_source=x&q=secret&sort=date-asc");
  assert.equal(el.list.children.length, 11, "items are moved, never rebuilt or duplicated");
  const box = el.list.parentNode;
  assert.equal(box.getAttribute("class"), "mh-results", "the list is back in place after a reorder");
  assert.equal(box.children[box.children.length - 1], el.list);
  // A click between the buttons (on the group itself) changes nothing.
  el.sort.dispatch("click");
  assert.deepEqual(p.pressed(), ["date-asc"]);
  assert.ok(p.untouched(), "item contents untouched");
  assert.ok(p.replaced.every(u => !/orbit2|nothing/.test(u)));
  assert.deepEqual(p.touched, [], "no cookies or storage");
});

test("DOM: the Filters button opens and closes the facets column (phones)", async () => {
  const p = explorerPage("/models/", ok);
  for (let i = 0; i < 5; i++) await tick();
  const t = p.el["filter-toggle"], col = p.el.facets.parentNode;
  assert.equal(t.getAttribute("aria-expanded"), "false");
  assert.equal(t.getAttribute("aria-controls"), "mh-facets");
  t.dispatch("click");
  assert.equal(t.getAttribute("aria-expanded"), "true");
  assert.ok(col.hasAttribute("data-open"));
  t.dispatch("click");
  assert.equal(t.getAttribute("aria-expanded"), "false");
  assert.ok(!col.hasAttribute("data-open"));
});

test("DOM: a failed load keeps the static list and offers Retry; a failed Retry is announced", async () => {
  const offline = () => Promise.reject(new TypeError("offline"));
  const p = explorerPage("/models/", n => (n === 1 || n === 3 ? offline() : n === 2 ? { ok: false, status: 404 } : ok()));
  const note = () => p.el.error.getElementsByTagName("span").find(s => s.className === "mh-error-note");
  for (let i = 0; i < 5; i++) await tick();
  const { el } = p;
  assert.equal(el.error.hidden, false);
  assert.equal(el.error.getAttribute("role"), "status", "a status region, so its changes are announced");
  assert.equal(note(), undefined, "the first failure shows the message only");
  assert.equal(el.controls.hidden, true);
  assert.equal(el.clear.hidden, true);
  assert.doesNotMatch(el.main.getAttribute("class"), /mh-js/, "without working controls the facets column is not collapsed on phones");
  assert.equal(p.visible().length, 11, "the pre-rendered list stays");
  el.retry.focus();
  el.retry.dispatch("click");
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(el.error.hidden, false, "HTTP 404 is an error too");
  assert.equal(el.retry.textContent, "Retry");
  assert.equal(note().textContent, " Still unavailable.", "the region changes, so the failed Retry is heard");
  el.retry.dispatch("click");
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(note().textContent, " Still unavailable.\xa0", "and it changes again on the next failure");
  assert.ok(el.error.textContent.startsWith("Search and filters could not be loaded."), "the generator's message stays");
  el.retry.dispatch("click");
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(el.error.hidden, true);
  assert.equal(el.controls.hidden, false);
  assert.equal(p.document.activeElement, el.search, "focus moves from the hidden Retry to the search field");
  assert.equal(p.fetched.length, 4);
  assert.equal(el.count.textContent, "All 11 models");
  assert.equal(el.count.getAttribute("aria-live"), null);
  p.flushTimers();
  assert.equal(el.count.getAttribute("aria-live"), "polite", "live again after a pause, with no text change");
  assert.equal(el.count.textContent, "All 11 models");
  assert.deepEqual(p.touched, []);
});

test("DOM: a template role on #mh-error is left alone", async () => {
  const p = explorerPage("/models/", () => Promise.reject(new TypeError("offline")), { mutate: el => el.error.setAttribute("role", "alert") });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(p.el.error.getAttribute("role"), "alert");
});

test("DOM: a focused facet checkbox is never hidden under the keyboard (spec §31)", async () => {
  // Nova is checked outside the selected organisation, so it shows only because it is checked.
  const p = explorerPage("/models/?family=other-lab.nova&org=example-lab", ok);
  for (let i = 0; i < 5; i++) await tick();
  const nova = p.input("family", "other-lab.nova"), item = nova.parentNode.parentNode, fs = item.parentNode.parentNode;
  assert.equal(nova.checked, true);
  assert.equal(item.hidden, false);
  nova.focus();   // Tab to Nova, press Space
  nova.checked = false;
  nova.dispatch("change");
  assert.equal(p.location.search, "?org=example-lab");
  assert.equal(item.hidden, false, "the focused checkbox stays visible");
  assert.equal(fs.hidden, false);
  assert.equal(p.document.activeElement, nova);
  // Once focus has moved on, the next update hides it.
  const code = p.input("category", "code");
  code.focus();
  code.checked = true;
  code.dispatch("change");
  assert.equal(item.hidden, true, "hidden on the next update, after focus left it");
  assert.equal(p.document.activeElement, code);
  assert.equal(code.parentNode.parentNode.hidden, false);
});

test("DOM: list items the index does not know stay listed until something filters", async () => {
  const p = explorerPage("/models/", ok, { extraItems: [["ghost-lab.ghost-1", "/models/ghost-lab/ghost-1/"]] });
  for (let i = 0; i < 5; i++) await tick();
  const { el } = p, ghost = () => el.list.children.find(li => li.getAttribute("data-mh-model") === "ghost-lab.ghost-1");
  assert.equal(el.controls.hidden, false);
  assert.equal(ghost().hidden, false);
  assert.equal(el.count.textContent, "All 12 models");
  assert.equal(el.list.children[el.list.children.length - 1], ghost(), "kept after the known items");
  el.search.value = "orbit";
  el.search.dispatch("input");
  p.flushTimers();
  assert.equal(ghost().hidden, true);
  assert.equal(el.count.textContent, "Showing 9 of 12 models");
  el.clear.dispatch("click");
  assert.equal(ghost().hidden, false);
  assert.equal(el.list.children.length, 12);
});

test("DOM: only same-origin page links decide the organisation", async () => {
  const relink = (el, id, href) => modelLinkOf(el.list.children.find(li => li.getAttribute("data-mh-model") === id)).setAttribute("href", href);
  const p = explorerPage("/models/?org=example-lab", ok, { mutate: el => {
    relink(el, "other-lab.nova-7", "https://evil.example/models/example-lab/nova-7/");       // ignored: prefix says other-lab
    relink(el, "example-lab.orbit-2", "https://ai-radar.eu/models/example-lab/orbit-2/");    // same origin: accepted
  } });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(p.visible().length, 9);
  assert.ok(!p.visible().includes("other-lab.nova-7"));
  assert.ok(p.visible().includes("example-lab.orbit-2"));
  assert.equal(p.input("org", "other-lab").parentNode.textContent, "Other Lab 2 models");
});

test("DOM: a link focused in the list keeps focus when the index loads and reorders the list", async () => {
  const link = el => modelLinkOf(el.list.children.find(li => li.getAttribute("data-mh-model") === "other-lab.nova-7"));
  // ?sort=name starts the load at once and needs a reorder (the page is newest first).
  const p = explorerPage("/models/?sort=name", ok);
  link(p.el).focus();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(p.el.controls.hidden, false);
  assert.notDeepEqual(p.el.list.children.map(li => li.getAttribute("data-mh-model")), FX.items.map(it => it.id), "the list was reordered");
  assert.equal(p.document.activeElement, link(p.el), "focus is back on the same link");
  assert.ok(p.untouched());
  // An item the URL filters out is hidden, so focus is not put back there.
  const q = explorerPage("/models/?org=example-lab&sort=name", ok);
  link(q.el).focus();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(rowOf(link(q.el)).hidden, true);
  assert.notEqual(q.document.activeElement, link(q.el));
});

/* AC-18 with the DOM half included: 1000 pre-rendered <li>, updates driven through the real
   input/change/click handlers (filter, rank, counts, hidden toggles, reorder, syncFacets
   over ~120 facet items, count). The fake DOM is not a browser, so this bounds the script's
   own work; the sign-off in a browser uses the snippet in the explorer report. */
test("DOM, 1000 models: every update through the real handlers takes < 50 ms and shows the right items in order", async () => {
  const index = syntheticIndex(1000, 42);
  const lis = index.models.map(m => `<li class="mh-row" data-mh-model="${m.id}">\n<a class="mh-row-name" href="/models/${m.id.split(".")[0]}/${m.slug}/">${m.name}</a>\n` +
    `<span class="mh-date">${m.date ? m.date.v : "Date unknown"}</span>\n</li>`);
  // The minimal markup models.js needs; #mh-empty-clear and #mh-filter-toggle are optional.
  const html = `<main id="main" class="mh mh-explorer" data-mh-view="explorer">
<div id="mh-controls" hidden><input type="search" id="mh-search"><div id="mh-sort" role="group" aria-label="Sort"><button type="button" data-sort="date-desc" aria-pressed="true">Newest first</button>
<button type="button" data-sort="date-asc" aria-pressed="false">Oldest first</button><button type="button" data-sort="name" aria-pressed="false">Name</button><button type="button" data-sort="org" aria-pressed="false">Organisation</button></div></div>
<div><div id="mh-facets"></div></div><section class="mh-results"><p id="mh-count" aria-live="polite"></p><button type="button" id="mh-clear" hidden>Clear filters</button><div id="mh-empty" hidden>No models match these filters.</div>
<p id="mh-error" hidden>Search and filters could not be loaded. <button type="button" id="mh-retry">Retry</button></p>
<ol id="mh-list">\n${lis.join("\n")}\n</ol></section></main>`;
  const p = explorerPage("/models/", () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(index)) }), { html });
  for (let i = 0; i < 5; i++) await tick();
  const { el } = p;
  assert.equal(el.controls.hidden, false);
  const ctx = api.buildRecords(index), inputs = el.facets.getElementsByTagName("input");
  assert.ok(inputs.length > 100, `${inputs.length} facet checkboxes`);
  const shown = inp => !inp.parentNode.parentNode.hidden && !inp.parentNode.parentNode.parentNode.parentNode.hidden;
  const r = rng(2024), names = index.models.map(m => m.name);
  const queries = ["", "", "orbit", "nova 3", "org c labs", "orgclabs", "vision", "2.5", "zz", "e", "atlas 7 pro"];
  let max = 0, total = 0;
  for (let i = 0; i < 200; i++) {
    const k = r(), a = performance.now();
    if (k < 0.45) { const inp = pick(r, inputs.filter(shown)); inp.checked = !inp.checked; inp.dispatch("change"); }
    else if (k < 0.8) { const nm = pick(r, names); el.search.value = r() < 0.5 ? pick(r, queries) : nm.slice(0, 1 + Math.floor(r() * nm.length)); el.search.dispatch("input"); }
    else if (k < 0.95) p.sortBy(pick(r, api.SORT_KEYS));
    else el.clear.dispatch("click");
    const ms = performance.now() - a;
    max = Math.max(max, ms);
    total += ms;
    if (i % 20 === 0) {
      // The visible items, in DOM order, are exactly the pure result for the page's state.
      const sel = emptySel();
      for (const inp of inputs) if (inp.checked) sel[inp.getAttribute("data-mh-facet")].push(inp.value);
      const exp = ids(api.applyFilters(ctx.records, { query: el.search.value, sort: p.pressed()[0], sel }));
      assert.deepEqual(p.visible(), exp, `update ${i}`);
    }
  }
  assert.equal(el.list.children.length, 1000, "no item lost or duplicated");
  assert.ok(p.untouched(), "item contents untouched");
  console.log(`# explorer DOM perf (fake DOM, 1000 items): 200 updates: max ${max.toFixed(2)} ms, avg ${(total / 200).toFixed(2)} ms`);
  assert.ok(max < 50, `slowest update ${max.toFixed(2)} ms`);
});
