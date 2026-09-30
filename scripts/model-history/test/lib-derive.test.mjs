/* Unit tests for scripts/model-history/lib.mjs and derive.mjs.
   Run: node --test scripts/model-history/test/lib-derive.test.mjs
   Fixture data is FICTIONAL (fixtures/basic). Tests marked todo document a known defect in
   the shared modules: they describe the correct behaviour and do not fail the run. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "../lib.mjs";
import * as D from "../derive.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures");
const REPO = join(here, "..", "..", "..");
const BASIC = L.loadDataset(join(FIX, "basic"));
const IDX = D.buildIndex(BASIC);
const model = id => IDX.modelById.get(id);
const day = s => Math.floor(Date.parse(s + "T00:00:00Z") / 86400000);

/* ---------- Dates (spec §21) ---------- */
test("parseDate: three precisions, calendar-checked", () => {
  assert.deepEqual(L.parseDate("2024"), { y: 2024, m: null, d: null, precision: "year" });
  assert.deepEqual(L.parseDate("2024-06"), { y: 2024, m: 6, d: null, precision: "month" });
  assert.deepEqual(L.parseDate("2024-02-29"), { y: 2024, m: 2, d: 29, precision: "day" });
  for (const bad of ["2023-02-29", "2023-02-30", "2024-13", "2024-00", "2024-06-00", "2024-6", "24-06", "0000", "2024-06-11T00:00:00Z", "", null, 2024])
    assert.equal(L.parseDate(bad), null, String(bad));
});

test("interval: year, month and day ranges as UTC day numbers", () => {
  assert.deepEqual(L.interval("2024"), [day("2024-01-01"), day("2024-12-31")]);
  assert.deepEqual(L.interval("2024-02"), [day("2024-02-01"), day("2024-02-29")]);
  assert.deepEqual(L.interval("2023-12"), [day("2023-12-01"), day("2023-12-31")]);
  assert.deepEqual(L.interval("2024-06-11"), [day("2024-06-11"), day("2024-06-11")]);
  assert.equal(L.interval("2024-02-30"), null);
});

test("contradictory: only when a cannot be on or before b at the given precisions (§21.5)", () => {
  const cases = [
    ["2024-06", "2024-06-11", false], ["2024-06-11", "2024-06", false], ["2024", "2024-06", false], ["2024-06", "2024", false],
    ["2024-07", "2024-06-30", true], ["2025", "2024-12-31", true], ["2024-06-12", "2024-06-11", true], ["2024-05", "2024-06-11", false],
    ["bad", "2024", false]
  ];
  for (const [a, b, want] of cases) assert.equal(L.contradictory(a, b), want, `${a} vs ${b}`);
});

test("sortKey: YYYY-MM-DD-p, coarser precision first within a period, unknown last (§21.3, AC-04)", () => {
  assert.equal(L.sortKey("2024-06-11"), "2024-06-11-0");
  assert.equal(L.sortKey("2024-06"), "2024-06-00-1");
  assert.equal(L.sortKey("2024"), "2024-00-00-2");
  assert.equal(L.sortKey(null), "9999-99-99-9");
  assert.equal(L.sortKey("2024-02-30"), "9999-99-99-9");
  const sorted = ["2024-06-11", null, "2024", "2023-12-31", "2024-06", "2024-05-31"].sort((a, b) => (L.sortKey(a) < L.sortKey(b) ? -1 : 1));
  assert.deepEqual(sorted, ["2023-12-31", "2024", "2024-05-31", "2024-06", "2024-06-11", null]);
});

test("formatDate: never shows a component the value does not have; qualifiers in the text (§21.4, AC-04/05)", () => {
  assert.equal(L.formatDate({ value: "2024-06-11" }), "11 June 2024");
  assert.equal(L.formatDate({ value: "2023-03" }), "March 2023");
  assert.equal(L.formatDate({ value: "2023" }), "2023");
  assert.equal(L.formatDate({ value: "2024", qualifier: "approximate" }), "c. 2024");
  assert.equal(L.formatDate({ value: "2024-06", qualifier: "approximate" }), "around June 2024");
  assert.equal(L.formatDate({ value: "2025", qualifier: "uncertain" }), "2025?");
  for (const unknown of [null, {}, { value: null }, { value: "2023-02-30" }]) assert.equal(L.formatDate(unknown), "Date unknown");
});

test("datetimeAttr: the value itself for all three precisions, null when unknown", () => {
  assert.equal(L.datetimeAttr({ value: "2023-03" }), "2023-03");
  assert.equal(L.datetimeAttr({ value: "2023" }), "2023");
  assert.equal(L.datetimeAttr({ value: "2024-06-11", qualifier: "approximate" }), "2024-06-11");
  assert.equal(L.datetimeAttr({ value: null }), null);
  assert.equal(L.datetimeAttr(null), null);
});

test("toInstant: a curator date alone counts as 23:59:59Z of that day (§17.3)", () => {
  assert.equal(L.toInstant("2026-10-01"), Date.parse("2026-10-01T23:59:59Z"));
  assert.equal(L.toInstant("2026-10-05T03:11:42Z"), Date.parse("2026-10-05T03:11:42Z"));
  assert.equal(L.toInstant(null), null);
  assert.equal(L.toInstant("not a date"), null);
  assert.equal(L.isIsoInstant("2026-10-05T03:11:42Z"), true);
  assert.equal(L.isIsoInstant("2026-10-05"), false);
  assert.equal(L.isIsoInstant("2026-10-05T03:11:42+02:00"), false);
  assert.equal(L.isCuratorCheck("2026-10-01"), true);
  assert.equal(L.isCuratorCheck("2026-02-30"), false);
});

test("isIsoInstant rejects impossible calendar days", () => {
  assert.equal(L.isIsoInstant("2026-02-30T00:00:00Z"), false);
});

/* ---------- Text ---------- */
test("normalize: NFKC, Unicode hyphens and minus to '-', lowercase, collapsed whitespace", () => {
  assert.equal(L.normalize("GPT‑6"), "gpt-6");                    // non-breaking hyphen (AC-13)
  assert.equal(L.normalize("Orbit–2−Pro"), "orbit-2-pro");   // en dash, minus sign
  assert.equal(L.normalize("ＧＰＴ－４"), "gpt-4"); // full-width forms
  assert.equal(L.normalize("  Orbit   2 \n Mini "), "orbit 2 mini");
  assert.equal(L.normalize(null), "");
});

test("fold and compact: diacritics removed; compact drops separators so gpt4 matches GPT-4", () => {
  assert.equal(L.fold("Ünïcode Café"), "unicode cafe");
  assert.equal(L.compact("GPT-4"), "gpt4");
  assert.equal(L.compact("Orbit 2"), "orbit2");
  assert.equal(L.compact("Orbit 2.5"), "orbit25");
  assert.equal(L.compact("o3_mini/pro"), "o3minipro");
  assert.equal(L.compact("gpt4"), L.compact("GPT‑4"));
});

test("escapeHtml and hasHtml", () => {
  assert.equal(L.escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  assert.equal(L.escapeHtml(null), "");
  for (const yes of ["<b>x</b>", "a<br/>b", "&amp;", "&#39;", "<SCRIPT>"]) assert.equal(L.hasHtml(yes), true, yes);
  for (const no of ["a < b and c > d", "5 > 3", "Orbit <2", "R&D", "plain"]) assert.equal(L.hasHtml(no), false, no);
});

/* ---------- News ids (§22.1-22.2) ---------- */
test("postKey and postId follow the feed build", () => {
  assert.equal(L.postKey("  https://Example.org/a/b/#frag "), "https://example.org/a/b");
  assert.equal(L.postKey("https://x.org///"), "https://x.org");
  assert.equal(L.postKey(null), "");
  assert.equal(L.postId("https://example.org/blog/orbit-2"), "1d6zctsfp9n");
  assert.equal(L.postId("https://example.org/blog/orbit-2/#top"), L.postId("https://EXAMPLE.org/blog/orbit-2"));
  assert.match(L.postId("https://example.org/x"), L.RE.postId);
  assert.notEqual(L.cyrb53("x", 1), L.cyrb53("x", 0));
});

test("postId reproduces the ids in the repository's data.json (collisions are re-hashed there)", () => {
  const items = L.readJson(join(REPO, "data.json")).items.filter(it => it.id && it.link);
  assert.ok(items.length >= 100);
  const same = items.filter(it => it.id === L.postId(it.link)).length;
  assert.ok(same / items.length >= 0.99, `${same} of ${items.length}`);
});

test("extractIdFunctions: the three copies are byte-identical; CRLF is ignored; missing markers give null", () => {
  const read = p => readFileSync(join(REPO, p), "utf8");
  const lib = L.extractIdFunctions(read("scripts/model-history/lib.mjs"));
  assert.ok(lib && lib.startsWith("const cyrb53 = (str, seed = 0) => {") && lib.endsWith("toString(36);"));
  assert.equal(L.extractIdFunctions(read("scripts/build-feed.mjs")), lib);
  assert.equal(L.extractIdFunctions(read("assets/app.js")), lib);
  // The checkout may use either line ending (this Windows worktree has CRLF); both must match.
  const lf = read("assets/app.js").replace(/\r\n/g, "\n");
  assert.equal(L.extractIdFunctions(lf), lib);
  assert.equal(L.extractIdFunctions(lf.replace(/\n/g, "\r\n")), lib);
  assert.equal(L.extractIdFunctions("const x = 1;"), null);
});

/* ---------- Archive allowlist (§18.1) ---------- */
test("ARCHIVE_RULES: only fixed captures per provider; archive.today nowhere", () => {
  const ok = (p, u, ctx) => assert.equal(L.archiveUrlAllowed(p, u, ctx), true, `${p} ${u}`);
  const no = (p, u, ctx) => assert.equal(L.archiveUrlAllowed(p, u, ctx), false, `${p} ${u}`);
  ok("internet-archive", "https://web.archive.org/web/20230101000000/https://docs.example.org/orbit-1");
  no("internet-archive", "https://web.archive.org/web/2023/https://docs.example.org/orbit-1");
  no("internet-archive", "https://web.archive.org/web/20230101000000*/https://docs.example.org/orbit-1");
  no("internet-archive", "https://web.archive.org/web/https://docs.example.org/orbit-1");
  no("internet-archive", "http://web.archive.org/web/20230101000000/https://docs.example.org/orbit-1");
  ok("arxiv", "https://arxiv.org/abs/2401.01234v2");
  no("arxiv", "https://arxiv.org/abs/2401.01234");
  no("arxiv", "https://arxiv.org/pdf/2401.01234v2");
  ok("github", "https://github.com/example-lab/orbit-2/tree/0123abc/docs");
  ok("github", "https://github.com/example-lab/orbit-2/blob/0123456789abcdef0123456789abcdef01234567/README.md");
  ok("github", "https://github.com/example-lab/orbit-2/releases/tag/v1.0");
  no("github", "https://github.com/example-lab/orbit-2/blob/main/README.md");
  no("github", "https://github.com/example-lab/orbit-2");
  ok("huggingface", "https://huggingface.co/example-lab/orbit-2/blob/0123abc/README.md");
  no("huggingface", "https://huggingface.co/example-lab/orbit-2/blob/main/README.md");
  ok("software-heritage", "https://archive.softwareheritage.org/swh:1:dir:0123456789abcdef0123456789abcdef01234567");
  no("software-heritage", "https://softwareheritage.org/swh:1:dir:0123");
  ok("publisher", "https://docs.example.org/v1/orbit-1", { url: "https://example.org/orbit-1" });
  ok("publisher", "https://example.org/archive/orbit-1", { url: "https://other.example/x", website: "https://www.example.org/" });
  ok("publisher", "https://a.example.co.uk/x", { url: "https://b.example.co.uk/y" });
  no("publisher", "https://a.example.co.uk/x", { url: "https://other.co.uk/y" });
  no("publisher", "https://mirror.example.net/orbit-1", { url: "https://example.org/orbit-1" });
  no("publisher", "http://example.org/archive/orbit-1", { url: "https://example.org/orbit-1" });
  no("other-approved", "https://anything.example/");
  no("no-such-provider", "https://web.archive.org/web/20230101000000/https://x.example/");
  for (const p of L.VOCAB.archiveProvider) no(p, "https://archive.ph/abc12", { url: "https://example.org/x" });
});

/* ---------- Loading ---------- */
test("loadDataset: the basic fixture", () => {
  assert.deepEqual(BASIC.parseErrors, []);
  assert.equal(BASIC.models.length, 11);
  assert.equal(BASIC.organizations.length, 3);
  assert.equal(BASIC.families.length, 3);
  assert.equal(BASIC.sources.length, 19);
  assert.ok(BASIC.models.every(m => /^records\/[a-z0-9-]+\/[a-z0-9-]+\.json$/.test(m._file)));
  assert.ok(BASIC.state.sourceStatus && BASIC.state.newsLinks);
});

test("loadDataset: a root with a trailing slash gives the same file paths", () => {
  assert.equal(L.loadDataset(join(FIX, "basic") + "/").models[0]._file, BASIC.models[0]._file);
});

test("loadRegistry: the repository registry (companies, aggregate item, logoFor)", { skip: !existsSync(join(REPO, "assets", "registry.js")) }, () => {
  const r = L.loadRegistry(REPO);
  assert.ok(Array.isArray(r.companies) && r.companies.length >= 12);
  assert.ok(r.companies.some(c => c.id === "across" && c.aggregate === true));
  assert.equal(typeof r.logoFor, "function");
});

/* ---------- Index ---------- */
test("buildIndex: top-level organization, route organization, units", () => {
  assert.equal(IDX.topOrg("example-lab-research"), "example-lab");
  assert.equal(IDX.topOrg("other-lab"), "other-lab");
  assert.equal(IDX.topOrg("nope"), null);
  assert.equal(IDX.primaryDev(model("example-lab.orbit-3-merge")), "example-lab");
  assert.equal(IDX.routeOrg(model("example-lab-research.orbit-0")), "example-lab");
  assert.deepEqual(IDX.unitsOf("example-lab"), ["example-lab-research"]);
  assert.deepEqual(IDX.unitsOf("other-lab"), []);
  const loop = D.buildIndex({ ...BASIC, organizations: [{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }] });
  assert.ok(["a", "b"].includes(loop.topOrg("a")));   // terminates on a parent loop
  for (const m of BASIC.models) assert.equal(D.fileNameFor(m, IDX), m._file, m.id);
});

/* ---------- Claims (§19.1) ---------- */
test("modelClaims: the normative claim list for a full record", () => {
  assert.deepEqual(D.modelClaims(model("example-lab.orbit-2")).map(c => c.path), [
    "dates.announced", "dates.released", "dates.retired", "lifecycle", "replacedBy", "milestones[0].date", "relations[0]",
    "changes[0]", "changes[1]", "capabilities.inputModalities", "capabilities.outputModalities", "capabilities.openWeights",
    "capabilities.contextWindowTokens", "capabilities.parameters", "capabilities.access", "capabilities.features[0]", "summary",
    "variants[0]", "variants[0].dates.released"
  ]);
  assert.deepEqual(D.orgClaims(IDX.orgById.get("example-lab")).map(c => c.path), ["description", "formerNames[0]", "narrative.chapters[0]", "narrative.chapters[1]"]);
});

test("emptySourcesAllowed / isNonAssertion / TEXT_CLAIM_KINDS", () => {
  assert.equal(D.emptySourcesAllowed({ kind: "lifecycle", claim: { value: "unknown", sources: [] } }), true);
  assert.equal(D.emptySourcesAllowed({ kind: "lifecycle", claim: { value: "available", sources: [] } }), false);
  assert.equal(D.emptySourcesAllowed({ kind: "capability", claim: { disclosure: "not-disclosed", sources: [] } }), true);
  assert.equal(D.emptySourcesAllowed({ kind: "capability", claim: { disclosure: "official", sources: [] } }), false);
  assert.equal(D.emptySourcesAllowed({ kind: "capability", claim: { value: ["text"], sources: [] } }), false);
  assert.equal(D.emptySourcesAllowed({ kind: "summary", claim: { text: "x", sources: [] } }), false);
  for (const k of ["summary", "change", "description", "chapter", "formerName", "relation"]) assert.ok(D.TEXT_CLAIM_KINDS.has(k), k);
  assert.ok(!D.TEXT_CLAIM_KINDS.has("date"));
});

test("emptySourcesAllowed: a date claim with value null ('unknown', spec §9.4)", () => {
  assert.equal(D.emptySourcesAllowed({ kind: "date", claim: { value: null, sources: [], note: "Not disclosed." } }), true);
});

/* ---------- Availability & provenance (§16.2, §17.3) ---------- */
const src = extra => ({ id: "src.t.x", type: "announcement", provenance: "primary", availability: "active", lastCheckedAt: "2026-10-01", ...extra });
const ARCHIVE = { archiveUrl: "https://web.archive.org/web/20230101000000/https://example.org/x", archiveProvider: "internet-archive", archivedAt: "2023-01-01T00:00:00Z" };

test("effAvail: without machine state the curator verdict holds", () => {
  assert.equal(D.effAvail(src(), null), "active");
  assert.equal(D.effAvail(src({ availability: "unavailable" }), null), "unavailable");
  assert.equal(D.effAvail(src({ availability: "unavailable", ...ARCHIVE }), null), "archived");
  assert.equal(D.effAvail(src({ availability: "archived", ...ARCHIVE }), null), "archived");
  assert.equal(D.effAvail(src({ availability: "unknown", lastCheckedAt: undefined }), null), "unknown");
});

test("effAvail: a repeated ok without a transition never undoes a newer curator verdict (AC-12)", () => {
  const st = { state: "active", stateSince: "2026-07-01T03:09:00Z", lastCheckedAt: "2026-10-08T03:00:00Z", lastResult: "ok" };
  assert.equal(D.effAvail(src({ availability: "archived", lastCheckedAt: "2026-10-01", ...ARCHIVE }), st), "archived");
});

test("effAvail: a machine transition after the curator's check wins", () => {
  const gone = { state: "unavailable", stateSince: "2026-10-05T03:11:42Z" };
  assert.equal(D.effAvail(src(), gone), "unavailable");
  assert.equal(D.effAvail(src(ARCHIVE), gone), "archived");                          // AC-10: primary + archiveUrl
  assert.equal(D.effAvail(src({ availability: "unavailable" }), { state: "active", stateSince: "2026-10-05T00:00:00Z" }), "active");
});

test("effAvail: a date-only lastCheckedAt counts until 23:59:59Z of that day", () => {
  assert.equal(D.effAvail(src(), { state: "unavailable", stateSince: "2026-10-01T12:00:00Z" }), "active");
  assert.equal(D.effAvail(src(), { state: "unavailable", stateSince: "2026-10-02T00:00:00Z" }), "unavailable");
  assert.equal(D.effAvail(src({ lastCheckedAt: "2026-10-01T06:00:00Z" }), { state: "unavailable", stateSince: "2026-10-01T12:00:00Z" }), "unavailable");
});

test("effAvail: healthCheck skip ignores the machine; missing stateSince changes nothing; archive gone", () => {
  assert.equal(D.effAvail(src({ healthCheck: "skip" }), { state: "unavailable", stateSince: "2026-10-05T00:00:00Z" }), "active");
  assert.equal(D.effAvail(src(), { state: "unavailable" }), "active");
  assert.equal(D.effAvail(src({ availability: "unavailable", ...ARCHIVE }), { archiveState: "gone" }), "unavailable");
  assert.equal(D.effAvail(src({ availability: "archived", ...ARCHIVE }), { archiveState: "gone" }), "unavailable");
  assert.equal(D.effAvail(src({ availability: "unknown", lastCheckedAt: undefined }), { state: "active", stateSince: "2026-10-05T00:00:00Z" }), "active");
});

// A machine state "unknown" never comes with a stateSince: check-sources.mjs only transitions to
// active or unavailable, and validate.mjs rejects a hand-edited one (E12). effAvail follows the
// §17.3 pseudo-code, so no extra guard is needed there.

test("effProv: derived from provenance and effective availability (§16.2)", () => {
  assert.equal(D.effProv(src({ provenance: "secondary" }), "archived"), "secondary");
  assert.equal(D.effProv(src({ provenance: "archived-primary" }), "active"), "archived-primary");
  assert.equal(D.effProv(src(), "archived"), "archived-primary");
  assert.equal(D.effProv(src(), "unavailable"), "primary");
  assert.equal(D.effProv(src(), "active"), "primary");
});

test("sourceView on the fixture: the source situations of §15.2", () => {
  const v = id => D.sourceView(IDX.srcById.get(id), IDX);
  assert.deepEqual(v("src.example-lab.orbit-2-launch"), { avail: "active", prov: "primary", archiveGone: false });
  assert.deepEqual(v("src.example-lab.orbit-1-docs"), { avail: "archived", prov: "archived-primary", archiveGone: false });
  assert.deepEqual(v("src.example-lab.orbit-0-card"), { avail: "unavailable", prov: "primary", archiveGone: false });
  assert.deepEqual(v("src.example-lab.orbit-2-docs"), { avail: "active", prov: "primary", archiveGone: false });   // older machine ok
  assert.deepEqual(v("src.shared.news-report-1"), { avail: "active", prov: "secondary", archiveGone: false });
});

/* ---------- Evidence (§16.3) ---------- */
const S = (id, extra) => ({ ...src({ id, ...extra }) });
const EV_SOURCES = [
  S("src.t.pa"), S("src.t.pu", { availability: "unavailable" }), S("src.t.pr", { availability: "archived", ...ARCHIVE }),
  S("src.t.pg", { availability: "unavailable", ...ARCHIVE }), S("src.t.ap", { provenance: "archived-primary", availability: "archived", ...ARCHIVE }),
  S("src.t.s1", { provenance: "secondary", publisher: "Example News" }), S("src.t.s1b", { provenance: "secondary", publisher: " example news " }),
  S("src.t.s2", { provenance: "secondary", publisher: "Sample Weekly" }), S("src.t.su", { provenance: "secondary", publisher: "Third Paper", availability: "unavailable" }),
  S("src.t.sa", { provenance: "secondary", publisher: "Fourth Paper", availability: "archived", ...ARCHIVE }),
  S("src.t.pk", { availability: "unknown", lastCheckedAt: undefined })
];
const EV_IDX = D.buildIndex({ organizations: [], families: [], models: [], sources: EV_SOURCES, state: { sourceStatus: { sources: { "src.t.pg": { archiveState: "gone" } } } } });
const ev = (...ids) => D.claimEvidence({ kind: "date", claim: { value: "2024", sources: ids.map(id => ({ id: `src.t.${id}` })) } }, EV_IDX);

test("claimEvidence: primary, archived primary, secondary, insufficient", () => {
  assert.equal(L.SECONDARY_MIN, 2);
  assert.deepEqual(ev("pa"), { evidence: "primary-source", originalUnavailable: false });
  assert.deepEqual(ev("pa", "pu"), { evidence: "primary-source", originalUnavailable: false });
  assert.deepEqual(ev("pu"), { evidence: "insufficient-evidence", originalUnavailable: true });
  assert.deepEqual(ev("pr"), { evidence: "archived-primary-source", originalUnavailable: true });
  assert.deepEqual(ev("ap"), { evidence: "archived-primary-source", originalUnavailable: true });
  assert.deepEqual(ev("s1", "s2"), { evidence: "secondary-sources", originalUnavailable: false });
  assert.deepEqual(ev("s1", "sa"), { evidence: "secondary-sources", originalUnavailable: false });   // archived secondary counts
  assert.deepEqual(ev("s1", "s1b"), { evidence: "insufficient-evidence", originalUnavailable: false }); // one publisher (SECONDARY_MIN = 2)
  assert.deepEqual(ev("s1", "su"), { evidence: "insufficient-evidence", originalUnavailable: false }); // unavailable secondary does not count
  assert.deepEqual(ev("pk"), { evidence: "insufficient-evidence", originalUnavailable: false });      // unknown is not proven
  assert.deepEqual(ev("nope"), { evidence: "insufficient-evidence", originalUnavailable: false });
});

test("claimEvidence: an archive copy that is gone falls back to secondary sources or insufficient (AC-10)", () => {
  assert.deepEqual(ev("pg"), { evidence: "insufficient-evidence", originalUnavailable: true });
  assert.deepEqual(ev("pg", "s1", "s2"), { evidence: "secondary-sources", originalUnavailable: true });
  assert.deepEqual(ev("pg", "s1"), { evidence: "insufficient-evidence", originalUnavailable: true });
});

test("claimEvidence: an undisclosed capability without sources is not applicable", () => {
  assert.deepEqual(D.claimEvidence({ kind: "capability", claim: { value: null, disclosure: "not-disclosed", sources: [] } }, EV_IDX), { evidence: "not-applicable", originalUnavailable: false });
});

test("modelEvidence on the fixture: status and flags per situation (§16.4, AC-07)", () => {
  const me = id => { const e = D.modelEvidence(model(id), IDX); return [e.evidence, e.flags]; };
  assert.deepEqual(me("example-lab.orbit-2"), ["primary-source", []]);
  assert.deepEqual(me("example-lab.orbit-1"), ["archived-primary-source", ["original-unavailable"]]);
  assert.deepEqual(me("example-lab-research.orbit-0"), ["insufficient-evidence", ["original-unavailable", "some-claims-incomplete"]]);
  assert.deepEqual(me("example-lab.orbit-2-vision"), ["secondary-sources", ["some-claims-incomplete"]]);
  assert.deepEqual(me("example-lab.orbit-lite-1"), ["insufficient-evidence", ["some-claims-incomplete"]]);
  assert.deepEqual(me("other-lab.nova-6"), ["insufficient-evidence", ["some-claims-incomplete"]]);
  const s = D.modelEvidence(model("example-lab.orbit-2"), IDX);
  assert.equal(s.claims.length, 19);
  assert.deepEqual(s.summary, { "primary-source": 18, "archived-primary-source": 0, "secondary-sources": 0, "insufficient-evidence": 0, originalUnavailable: 0 });
});

test("modelEvidence: a vanished original behind another claim shows in the summary, not as a model flag (AC-07)", () => {
  const m = structuredClone(model("example-lab.orbit-2"));
  m.changes.push({ id: "api", aspect: "availability", direction: "added", relativeTo: "example-lab.orbit-1", text: "API access.", sources: [{ id: "src.example-lab.orbit-1-docs" }] });
  const e = D.modelEvidence(m, IDX);
  assert.equal(e.evidence, "primary-source");
  assert.deepEqual(e.flags, []);
  assert.equal(e.summary.originalUnavailable, 1);
  assert.equal(e.summary["archived-primary-source"], 1);
});

/* ---------- Relations graph (§12.5, AC-01) ---------- */
test("deriveGraph on the fixture: branches, merges, siblings, closures", () => {
  const g = D.deriveGraph(BASIC).byModel;
  assert.equal(D.deriveGraph(BASIC).edges.length, 10);
  assert.deepEqual(g["example-lab.orbit-2"].successors, ["example-lab.orbit-2-5", "example-lab.orbit-3", "example-lab.orbit-lite-1"]);
  assert.deepEqual(g["example-lab.orbit-2"].children, ["example-lab.orbit-2-2024-09", "example-lab.orbit-2-vision"]);
  assert.deepEqual(g["example-lab.orbit-3-merge"].parents, ["example-lab.orbit-3", "other-lab.nova-7"]);
  assert.deepEqual(g["example-lab.orbit-3-merge"].predecessors, []);
  assert.deepEqual(g["example-lab.orbit-2-vision"].siblings, ["example-lab.orbit-2-2024-09"]);
  assert.deepEqual(g["example-lab.orbit-2-2024-09"].siblings, ["example-lab.orbit-2-vision"]);
  assert.deepEqual(g["example-lab.orbit-2"].siblings, []);
  assert.deepEqual(g["example-lab-research.orbit-0"].predecessors, []);
  assert.deepEqual(g["example-lab.orbit-1"].predecessors, ["example-lab-research.orbit-0"]);
  assert.deepEqual(g["other-lab.nova-7"].children, ["example-lab.orbit-3-merge"]);   // across organizations
  assert.deepEqual(g["example-lab.orbit-3-merge"].ancestors, ["example-lab-research.orbit-0", "example-lab.orbit-1", "example-lab.orbit-2", "example-lab.orbit-3", "other-lab.nova-6", "other-lab.nova-7"]);
  assert.deepEqual(g["other-lab.nova-6"].descendants, ["example-lab.orbit-3-merge", "other-lab.nova-7"]);
  assert.deepEqual(g["example-lab-research.orbit-0"].descendants, ["example-lab.orbit-1", "example-lab.orbit-2", "example-lab.orbit-2-2024-09", "example-lab.orbit-2-5",
    "example-lab.orbit-2-vision", "example-lab.orbit-3", "example-lab.orbit-3-merge", "example-lab.orbit-lite-1"]);
});

test("findCycle: none in the fixture; finds a cycle and a self-loop", () => {
  const edges = D.relationEdges(BASIC);
  assert.equal(D.findCycle(edges), null);
  const c = D.findCycle(edges.concat({ from: "example-lab.orbit-1", to: "example-lab.orbit-2", type: "successor-of" }));
  assert.ok(c && c[0] === c[c.length - 1] && c.includes("example-lab.orbit-1") && c.includes("example-lab.orbit-2"), String(c));
  assert.deepEqual(D.findCycle([{ from: "a", to: "a" }]), ["a", "a"]);
});

/* ---------- Timeline (§21.3) ---------- */
test("timelineDate, modelSortKey, yearOf and the chronological order of the fixture", () => {
  assert.deepEqual(D.timelineDate(model("example-lab.orbit-2")), { dv: model("example-lab.orbit-2").dates.released, kind: "released", path: "dates.released" });
  assert.equal(D.timelineDate(model("other-lab.nova-6")), null);
  assert.equal(D.timelineDate({ dates: { announced: { value: "2025" }, released: null } }).kind, "announced");
  assert.equal(D.modelSortKey(model("example-lab.orbit-2")), "2024-06-11-0");
  assert.equal(D.modelSortKey(model("example-lab.orbit-1")), "2021-03-00-1");
  assert.equal(D.modelSortKey(model("example-lab-research.orbit-0")), "2019-00-00-2");
  assert.equal(D.modelSortKey(model("other-lab.nova-6")), "9999-99-99-9");
  assert.equal(D.yearOf(model("example-lab.orbit-lite-1")), 2025);
  assert.equal(D.yearOf(model("other-lab.nova-6")), null);
  const order = [...BASIC.models].sort((a, b) => (D.modelSortKey(a) + a.name < D.modelSortKey(b) + b.name ? -1 : 1)).map(m => m.id);
  assert.deepEqual(order, ["example-lab-research.orbit-0", "example-lab.orbit-1", "example-lab.orbit-2", "example-lab.orbit-2-vision", "example-lab.orbit-2-2024-09",
    "example-lab.orbit-2-5", "example-lab.orbit-lite-1", "other-lab.nova-7", "example-lab.orbit-3", "example-lab.orbit-3-merge", "other-lab.nova-6"]);
});

test("timelineDate skips a released date whose value is unknown", () => {
  assert.equal(D.timelineDate({ dates: { released: { value: null, sources: [], note: "Unknown." }, announced: { value: "2025" } } }).kind, "announced");
});

/* ---------- Vocabularies ---------- */
test("vocabularies: quantity aspects are aspects; numeric capabilities are capability keys", () => {
  assert.ok(L.VOCAB.quantityAspect.every(a => L.VOCAB.aspect.includes(a)));
  assert.ok(L.NUMERIC_CAPABILITIES.every(k => L.CAPABILITY_KEYS.includes(k)));
  for (const [k, v] of Object.entries(L.VOCAB)) assert.equal(new Set(v).size, v.length, `duplicate value in VOCAB.${k}`);
});
