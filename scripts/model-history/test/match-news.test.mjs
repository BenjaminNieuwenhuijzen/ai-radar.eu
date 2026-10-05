/* Tests for the news matcher (match-news.mjs) and the backfill (backfill-news.mjs).
   Run: node --test scripts/model-history/test/match-news.test.mjs
   Everything that writes works on a temporary copy of fixtures/basic; basic/ stays untouched. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { loadDataset, postId } from "../lib.mjs";
import { prepare, findHits, matchItems, itemView, runMatch, parseArgs, feedCommit, seenAt, FIELDS, collectAliases,
  openCandidates, formatReport, md, SUMMARY_LIMIT, splitOutlet, feedTime, newModelNames, knownNames } from "../match-news.mjs";
import { processSnapshots, parseLog, filterCommits, backfillReport } from "../backfill-news.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASIC = join(HERE, "fixtures", "basic");
const SCRIPT = join(HERE, "..", "match-news.mjs");
const readJ = p => JSON.parse(readFileSync(p, "utf8"));
const basicFeed = () => readJ(join(BASIC, "data.json"));
const ctxBasic = () => prepare(loadDataset(BASIC));
const byTitle = (items, title) => items.find(i => i.title === title);
const L = { intro: "https://example.org/blog/orbit-2", nbh: "https://news.example.com/orbit-2-open", mini: "https://news.example.com/orbit-2-mini",
  vision: "https://news.example.com/orbit-2-vision-leak", both: "https://news.example.com/orbit-3-vs-nova-7", roadmap: "https://news.example.com/orbit-roadmap",
  v25: "https://example.org/blog/orbit-2-5" };

// A fresh copy of the basic fixture in a temp dir; the callback gets its paths.
function withCopy(fn, edit) {
  const dir = mkdtempSync(join(tmpdir(), "mh-match-"));
  try {
    cpSync(BASIC, dir, { recursive: true });
    const p = { dir, feed: join(dir, "data.json"), state: join(dir, "state", "news-links.json") };
    if (edit) edit(p);
    return fn(p);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const editJson = (path, fn) => { const j = readJ(path); fn(j); writeFileSync(path, JSON.stringify(j, null, 2) + "\n"); };
const filler = (n, tag = "f") => Array.from({ length: n }, (_, i) => ({ company: "Across AI", source: "Filler", title: `Unrelated story ${tag}${i}`,
  link: `https://filler.example.com/${tag}-${i}`, date: "Tue, 01 Sep 2026 00:00:00 GMT", summary: "" }));
const run = (p, extra = {}) => runMatch({ dataDir: p.dir, feedPath: p.feed, commit: "abc1234", now: Date.parse("2026-10-02T00:00:00Z"), ...extra });
const pairs = links => links.map(l => `${l.modelId}|${l.variantId}|${l.postId}`).sort();

/* ---------- Boundaries and overlap ---------- */
test("boundary rules: left no [a-z0-9]; right not [a-z0-9], _, .<digit>, -[a-z0-9]", () => {
  const al = [{ modelId: "x.a", variantId: null, text: "orbit 2", match: "auto" }];
  const hit = t => findHits(t, al).length > 0;
  for (const t of ["orbit 2", "introducing orbit 2", "orbit 2 is here", "orbit 2.", "orbit 2, now", "(orbit 2)", "orbit 2-", "orbit 2 - review", "orbit 2's", "orbit 2: notes", "new-orbit 2"]) assert.ok(hit(t), t);
  for (const t of ["orbit 2x", "orbit 20", "orbit 2_beta", "orbit 2.5", "orbit 2-vision", "orbit 2-1", "xorbit 2", "9orbit 2", "orbit"]) assert.ok(!hit(t), t);
});

test("overlap: the longest alias wins; separate mentions all count", () => {
  const al = collectAliases({ models: [
    { id: "x.a", aliases: [{ text: "Orbit 2", match: "auto" }], variants: [{ id: "mini", aliases: [{ text: "Orbit 2 Mini", match: "auto" }] }] }
  ] });
  const h1 = findHits("hands-on with orbit 2 mini", al);
  assert.deepEqual(h1.map(h => h.alias.text), ["orbit 2 mini"]);
  const h2 = findHits("orbit 2 vs orbit 2 mini", al);
  assert.deepEqual(h2.map(h => h.alias.text), ["orbit 2", "orbit 2 mini"]);
});

/* ---------- Decisions on synthetic records ---------- */
const it1 = (title, link = "https://a.example/1") => ({ company: "Across AI", source: "X", title, link, date: "2026-09-01T10:00:00Z", summary: "" });
const orbitWith = (miniMatch, extra = {}) => ({ id: "x.a", aliases: [{ text: "Orbit 2", match: "auto" }],
  variants: [{ id: "mini", aliases: [{ text: "Orbit 2 Mini", ...(miniMatch ? { match: miniMatch } : {}) }] }], ...extra });

test("'Orbit 2 vs Orbit 2 Mini' links the record: variantId null, alias 'orbit 2'", () => {
  const { found } = matchItems([it1("Orbit 2 vs Orbit 2 Mini")], prepare({ models: [orbitWith("auto")] }));
  assert.equal(found.length, 1);
  assert.equal(found[0].variantId, null); assert.equal(found[0].alias, "orbit 2");
});

test("a longer candidate alias blocks a shorter auto alias; the candidate keeps its variantId", () => {
  const ctx = prepare({ models: [orbitWith(null)] });                   // variant alias left at the default
  const { found, candidates } = matchItems([it1("Hands-on with Orbit 2 Mini")], ctx);
  assert.equal(found.length, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].variantId, "mini"); assert.deepEqual(candidates[0].aliases, ["orbit 2 mini"]);
  assert.match(formatReport({ candidates }), /`x\.a#mini`/);
});

test("openCandidates leaves out pairs that are in news.include (or already linked)", () => {
  const ctx = prepare({ models: [orbitWith(null, { news: { include: [{ postId: postId("https://a.example/1") }] } })] });
  const { found, candidates } = matchItems([it1("Hands-on with Orbit 2 Mini"), it1("Orbit 2 Mini review", "https://a.example/2")], ctx);
  assert.equal(found.length, 0);
  assert.deepEqual(openCandidates(candidates, [], ctx).map(c => c.link), ["https://a.example/2"]);
  assert.deepEqual(openCandidates(candidates, [{ modelId: "x.a", postId: postId("https://a.example/2") }], ctx), []);
});

test("one alias on two models on the same span (W01): each model follows its own match value, the report notes it", () => {
  const ctx = prepare({ models: [{ id: "x.nova", aliases: [{ text: "Nova 7", match: "auto" }] }, { id: "y.nova", aliases: [{ text: "Nova 7", match: "auto" }] }] });
  const { found, candidates } = matchItems([it1("Nova 7 benchmarks")], ctx);
  assert.deepEqual(found.map(f => [f.modelId, f.alias, f.ambiguous]), [["x.nova", "nova 7", true], ["y.nova", "nova 7", true]]);
  assert.equal(candidates.length, 0);
  assert.match(formatReport({ added: found }), /`x\.nova`.*W01[\s\S]*`y\.nova`.*W01/);
  // A candidate alias on another model does not block an auto link; both lines get the note.
  const ctx2 = prepare({ models: [{ id: "x.nova", aliases: [{ text: "Nova 7", match: "auto" }] }, { id: "y.nova", aliases: [{ text: "Nova 7" }] }] });
  const r2 = matchItems([it1("Nova 7 benchmarks")], ctx2);
  assert.deepEqual(r2.found.map(f => [f.modelId, f.ambiguous]), [["x.nova", true]]);
  assert.deepEqual(r2.candidates.map(c => [c.modelId, c.ambiguous]), [["y.nova", true]]);
  assert.match(formatReport({ candidates: r2.candidates }), /W01/);
  // An unshared auto hit elsewhere in the text decides: stored alias, and no W01 note.
  const ctx3 = prepare({ models: [{ id: "x.nova", aliases: [{ text: "Nova 7", match: "auto" }, { text: "Nova 7 Pro", match: "auto" }] },
    { id: "y.nova", aliases: [{ text: "Nova 7", match: "auto" }] }] });
  const r3 = matchItems([it1("Nova 7 and Nova 7 Pro compared")], ctx3);
  assert.deepEqual(r3.found.map(f => [f.modelId, f.alias, f.ambiguous]), [["x.nova", "nova 7 pro", false], ["y.nova", "nova 7", true]]);
  // The flag reaches the report only, never the state file.
  withCopy(p => {
    const r = run(p);
    assert.equal(r.added.find(a => a.modelId === "example-lab.orbit-3").ambiguous, undefined);
    assert.match(r.report, /`example-lab\.orbit-3`.*W01/);
    assert.ok(!readFileSync(p.state, "utf8").includes("ambiguous"));
  }, p => editJson(join(p.dir, "records", "other-lab", "nova-7.json"), j => { j.aliases.push({ text: "Orbit 3", match: "candidate" }); }));
});

test("two records with one id: their excludes and includes are merged, not replaced", () => {
  const ex = postId("https://a.example/1");
  const ctx = prepare({ models: [
    { id: "y.nova", aliases: [{ text: "Nova 7", match: "auto" }], news: { exclude: [ex], include: [{ postId: "p1" }] } },
    { id: "y.nova", aliases: [], news: { exclude: [], include: [{ postId: "p2" }] } }] });
  assert.deepEqual([...ctx.exclude.get("y.nova")], [ex]);
  assert.deepEqual([...ctx.include.get("y.nova")].sort(), ["p1", "p2"]);
  assert.equal(matchItems([it1("Nova 7 benchmarks")], ctx).found.length, 0);
});

test("report: feed titles stay on one line; long lists are capped in the summary only", () => {
  assert.equal(md("Orbit 2\n# Injected  heading\r\n"), "Orbit 2 \\# Injected heading");
  const one = { modelId: "x.a", variantId: null, postId: "p", link: "https://a.example/1", title: "Orbit 2\n# Injected heading",
    publishedAt: "2026-09-01T10:00:00Z", aliases: ["orbit 2"] };
  assert.equal(formatReport({ candidates: [one] }).split("\n").filter(l => l.startsWith("- ")).length, 1);
  const many = Array.from({ length: SUMMARY_LIMIT + 5 }, (_, i) => ({ ...one, postId: "p" + i, title: "t" + i }));
  const full = formatReport({ candidates: many }), cut = formatReport({ candidates: many, limit: SUMMARY_LIMIT });
  assert.equal(full.split("\n").filter(l => l.startsWith("- ")).length, SUMMARY_LIMIT + 5);
  assert.equal(cut.split("\n").filter(l => l.startsWith("- ")).length, SUMMARY_LIMIT);
  assert.match(cut, new RegExp(`${SUMMARY_LIMIT + 5} candidates`));             // the facts line keeps the total
  assert.match(cut, /5 more candidates not shown here; run `node scripts\/model-history\/match-news\.mjs --dry-run` locally/);
});

test("aliases: 'never' is dropped, a missing match is 'candidate', text is normalised", () => {
  const al = collectAliases({ models: [{ id: "x.a", aliases: [{ text: "Orbit", match: "never" }, { text: "Orbit‑3" }, { text: "  ORBIT   4 ", match: "auto" }] }] });
  assert.deepEqual(al.map(a => [a.text, a.match]), [["orbit 4", "auto"], ["orbit-3", "candidate"]]);
});

/* ---------- The basic fixture ---------- */
test("basic fixture: every expected link and nothing else", () => {
  const { found, candidates } = matchItems(basicFeed().items, ctxBasic());
  const get = link => found.filter(f => f.link === link);
  const one = (link, modelId, variantId, alias) => {
    const f = get(link);
    assert.equal(f.length, 1, link);
    assert.equal(f[0].modelId, modelId); assert.equal(f[0].variantId, variantId); assert.equal(f[0].alias, alias);
    assert.equal(f[0].postId, postId(link)); assert.equal(f[0].method, "auto");
  };
  one(L.intro, "example-lab.orbit-2", null, "orbit 2");                   // 'Introducing Orbit 2'
  one(L.nbh, "example-lab.orbit-2", null, "orbit-2");                     // U+2011 non-breaking hyphen
  one(L.mini, "example-lab.orbit-2", "mini", "orbit 2 mini");             // variant, and no plain orbit-2 link
  assert.equal(get(L.vision).length, 0);                                  // 'Orbit 2-Vision' links nothing
  assert.deepEqual(get(L.both).map(f => f.modelId).sort(), ["example-lab.orbit-3", "other-lab.nova-7"]);
  assert.equal(get(L.roadmap).length, 0);                                 // generic family name is 'never'
  one(L.v25, "example-lab.orbit-2-5", null, "orbit 2.5");                 // not orbit-2
  assert.equal(found.length, 6);
  assert.equal(candidates.length, 0);
});

test("snapshot fields: ISO UTC publishedAt, dateOnly for 00:00:00 UTC, company and source", () => {
  const items = basicFeed().items;
  const a = itemView(byTitle(items, "Introducing Orbit 2")), b = itemView(byTitle(items, "Orbit‑2 is now open weights"));
  assert.equal(a.publishedAt, "2024-06-11T16:00:00Z"); assert.equal(a.dateOnly, false);
  assert.equal(b.publishedAt, "2024-07-15T00:00:00Z"); assert.equal(b.dateOnly, true);
  assert.equal(a.company, "Across AI"); assert.equal(a.source, "Example News");
  // A valid build id is leading; an invalid one falls back to the link hash (the app.js rule).
  assert.equal(itemView({ ...byTitle(items, "Introducing Orbit 2"), id: "zz9" }).postId, "zz9");
  assert.equal(itemView({ ...byTitle(items, "Introducing Orbit 2"), id: "Bad-Id" }).postId, postId(L.intro));
  assert.equal(itemView({ title: "x", link: "javascript:alert(1)", date: "2026-01-01" }), null);
  assert.equal(itemView({ title: "x", link: "https://a.example/", date: "not a date" }), null);
  // A feed without a source (xAI) names the link's host, so the snapshot passes E17.
  assert.equal(itemView({ title: "x", link: "https://www.x.ai/news/grok", date: "2026-01-01" }).source, "x.ai");
});

test("firstSeenAt comes from data.json 'generated', else the run time, in whole seconds", () => {
  assert.equal(seenAt({ generated: "2026-10-01T00:00:00Z" }, Date.parse("2026-10-02T00:00:00Z")), "2026-10-01T00:00:00Z");
  assert.equal(seenAt({ generated: "2026-09-30T16:26:51.736Z" }, Date.parse("2026-10-02T00:00:00Z")), "2026-09-30T16:26:51Z");   // build-feed format
  assert.equal(seenAt({ generated: "2027-01-01T00:00:00Z" }, Date.parse("2026-10-02T00:00:00Z")), "2026-10-02T00:00:00Z");
  assert.equal(seenAt({}, Date.parse("2026-10-02T03:04:05.678Z")), "2026-10-02T03:04:05Z");
});

test("Google News: the outlet suffix becomes the source, as on the dashboard; matching uses the item title", () => {
  const gn = (title, link, date = "Thu, 03 Sep 2026 10:00:00 GMT") => ({ company: "Across AI", source: "Google News", title, link, date, summary: "" });
  const a = itemView(gn("Orbit 2 tops the charts - The Verge", "https://news.google.com/rss/articles/AAA"));
  assert.deepEqual([a.title, a.source], ["Orbit 2 tops the charts", "The Verge"]);
  assert.match(a.text, /the verge$/);                                                        // match text: title as in data.json
  // Only Google News, only a suffix of at most 60 characters, and splitting twice changes nothing.
  assert.equal(itemView({ ...gn("Orbit 2 - a review", "https://a.example/r"), source: "Example News" }).title, "Orbit 2 - a review");
  const long = "Orbit 2 - " + "x".repeat(60);
  assert.equal(itemView(gn(long, "https://news.google.com/rss/articles/BBB")).title, long);
  assert.deepEqual(splitOutlet("Orbit 2 tops the charts", "The Verge"), { title: "Orbit 2 tops the charts", source: "The Verge" });
  // Two outlets, one story, two post ids: two links whose titles now match, so the display
  // can merge them within 2 days (§22.4).
  const { found } = matchItems([gn("Orbit 2 tops the charts - The Verge", "https://news.google.com/rss/articles/AAA"),
    gn("Orbit 2 tops the charts - Reuters", "https://news.google.com/rss/articles/CCC", "Fri, 04 Sep 2026 08:00:00 GMT")], ctxBasic());
  assert.deepEqual(found.map(f => [f.title, f.source]).sort(), [["Orbit 2 tops the charts", "Reuters"], ["Orbit 2 tops the charts", "The Verge"]]);
  assert.notEqual(found[0].postId, found[1].postId);
});

test("feed dates without a zone are read as UTC, whatever the local time zone", () => {
  const tz = process.env.TZ;
  try {
    process.env.TZ = "Europe/Amsterdam";
    assert.notEqual(Date.parse("2026-09-01T10:00:00"), Date.parse("2026-09-01T10:00:00Z"));   // the zone switch took effect
    const at = date => itemView({ title: "x", link: "https://a.example/", date });
    assert.equal(at("2026-09-01T10:00:00").publishedAt, "2026-09-01T10:00:00Z");
    assert.equal(at("2026-09-01 10:00").publishedAt, "2026-09-01T10:00:00Z");
    assert.equal(at("Tue, 01 Sep 2026 10:00:00").publishedAt, "2026-09-01T10:00:00Z");
    const day = at("Tue, 01 Sep 2026");
    assert.deepEqual([day.publishedAt, day.dateOnly], ["2026-09-01T00:00:00Z", true]);
    // With a zone nothing changes.
    assert.equal(at("Tue, 01 Sep 2026 10:00:00 +0200").publishedAt, "2026-09-01T08:00:00Z");
    assert.equal(at("Tue, 01 Sep 2026 10:00:00 EDT").publishedAt, "2026-09-01T14:00:00Z");
    assert.equal(at("2026-09-01T10:00:00.250Z").publishedAt, "2026-09-01T10:00:00.250Z");
    assert.equal(feedTime(42), NaN);
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
});

test("feedCommit is 'unknown' outside git, for local edits and for a shallow boundary commit", () => {
  assert.equal(feedCommit(join(tmpdir(), "mh-no-such-dir", "data.json")), "unknown");
  const H = "a47100f" + "0".repeat(33), P = "04a5c06" + "0".repeat(33);
  // A fake git: answers by the first argument; parents lists the parents of H.
  const fake = ({ status = "", shallow = "false", parents = [P] } = {}) => args => ({
    status, log: H, "rev-parse": shallow, "rev-list": [H, ...parents].join(" ") })[args[0]];
  assert.equal(feedCommit("/repo/data.json", fake()), "a47100f");
  assert.equal(feedCommit("/repo/data.json", fake({ status: " M data.json" })), "unknown");
  assert.equal(feedCommit("/repo/data.json", fake({ shallow: "true", parents: [] })), "unknown");   // depth-1 checkout
  assert.equal(feedCommit("/repo/data.json", fake({ shallow: "true" })), "a47100f");                // within the fetched depth
});

/* ---------- Runs on a copy ---------- */
test("run writes sorted records with the spec fields; a second run adds nothing", () => withCopy(p => {
  const r1 = run(p);
  assert.equal(r1.status, "ok"); assert.equal(r1.added.length, 6); assert.equal(r1.written, true);
  const st = readJ(p.state);
  assert.equal(st.schemaVersion, 1);
  assert.deepEqual(Object.keys(st), ["schemaVersion", "links"]);
  for (const l of st.links) {
    assert.deepEqual(Object.keys(l), FIELDS);
    assert.equal(l.firstSeenAt, "2026-10-01T00:00:00Z"); assert.equal(l.firstSeenIn, "abc1234");
  }
  const keys = st.links.map(l => [l.modelId, l.publishedAt, l.postId].join(" "));
  assert.deepEqual(keys, [...keys].sort());
  const bytes = readFileSync(p.state, "utf8"), mtime = statSync(p.state).mtimeMs;
  const r2 = run(p, { commit: "def5678", now: Date.parse("2026-10-03T00:00:00Z") });
  assert.equal(r2.added.length, 0); assert.equal(r2.changed, false); assert.equal(r2.written, false);
  assert.equal(readFileSync(p.state, "utf8"), bytes);
  assert.equal(statSync(p.state).mtimeMs, mtime);
}));

test("a candidate alias only reaches the report", () => withCopy(p => {
  const r = run(p);
  assert.ok(!r.links.some(l => l.modelId === "other-lab.nova-6"));
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].modelId, "other-lab.nova-6");
  assert.deepEqual(r.candidates[0].aliases, ["nova 6"]);
  assert.match(r.report, /Candidates for review/);
  assert.match(r.report, /`other-lab\.nova-6`: \[Nova 6 gets a quiet update\]/);
  assert.ok(!readFileSync(p.state, "utf8").includes("nova-6"));
}, p => editJson(p.feed, j => j.items.push({ company: "Across AI", source: "Example News", title: "Nova 6 gets a quiet update",
  link: "https://news.example.com/nova-6", date: "Mon, 03 Mar 2025 10:00:00 GMT", summary: "" }))));

test("an exclude suppresses a link (and its candidate); an existing link is never removed", () => {
  const ex = postId(L.intro);
  withCopy(p => {
    const r = run(p);
    assert.ok(!r.links.some(l => l.modelId === "example-lab.orbit-2" && l.postId === ex));
    assert.equal(r.links.length, 5);
  }, p => editJson(join(p.dir, "records", "example-lab", "orbit-2.json"), j => { j.news.exclude = [ex]; }));
  // First linked, then excluded: the stored link stays (display hides it), nothing is added.
  withCopy(p => {
    run(p);
    editJson(join(p.dir, "records", "example-lab", "orbit-2.json"), j => { j.news.exclude = [ex]; });
    const r = run(p);
    assert.equal(r.added.length, 0);
    assert.ok(readJ(p.state).links.some(l => l.modelId === "example-lab.orbit-2" && l.postId === ex));
  });
  // A candidate for an excluded post is not reported either.
  withCopy(p => { assert.equal(run(p).candidates.length, 0); }, p => {
    editJson(p.feed, j => j.items.push({ company: "Across AI", source: "X", title: "Nova 6 notes", link: "https://news.example.com/n6", date: "2025-03-03T10:00:00Z" }));
    editJson(join(p.dir, "records", "other-lab", "nova-6.json"), j => { j.news = { include: [], exclude: [postId("https://news.example.com/n6")] }; });
  });
});

test("guard: fewer than 100 items, missing or invalid data.json → skipped, state untouched", () => {
  const seed = { schemaVersion: 1, links: [{ modelId: "example-lab.orbit-1", variantId: null, postId: "old1", link: "https://example.org/old", title: "Old",
    publishedAt: "2021-03-01T00:00:00Z", dateOnly: true, company: "Across AI", source: "X", method: "auto", alias: "orbit 1", firstSeenAt: "2026-06-15T08:22:52Z", firstSeenIn: "dfd8ebe" }] };
  const setup = p => writeFileSync(p.state, JSON.stringify(seed, null, 2) + "\n");
  const cases = [
    ["50 items", p => editJson(p.feed, j => { j.items = j.items.slice(0, 50); })],
    ["missing", p => rmSync(p.feed)],
    ["invalid JSON", p => writeFileSync(p.feed, "{ not json")],
    ["no items array", p => writeFileSync(p.feed, JSON.stringify({ generated: "2026-10-01T00:00:00Z" }))]
  ];
  for (const [name, edit] of cases) withCopy(p => {
    const before = readFileSync(p.state, "utf8"), mtime = statSync(p.state).mtimeMs;
    const r = run(p);
    assert.equal(r.status, "skipped", name); assert.equal(r.written, false, name);
    assert.equal(readFileSync(p.state, "utf8"), before, name);
    assert.equal(statSync(p.state).mtimeMs, mtime, name);
    assert.match(r.report, /Skipped: .*Nothing was changed/, name);
  }, p => { setup(p); edit(p); });
});

test("append-only: a stored link survives when its post leaves data.json", () => withCopy(p => {
  run(p);
  editJson(p.feed, j => { j.items = j.items.filter(i => i.link !== L.intro).concat(filler(5, "extra")); });
  const r = run(p);
  assert.equal(r.added.length, 0);
  assert.ok(readJ(p.state).links.some(l => l.link === L.intro));
}));

test("dry run writes nothing; a broken state file is an error and stays as it is", () => {
  withCopy(p => {
    const before = readFileSync(p.state, "utf8");
    const r = run(p, { dryRun: true });
    assert.equal(r.added.length, 6); assert.equal(r.changed, true); assert.equal(r.written, false);
    assert.equal(readFileSync(p.state, "utf8"), before);
  });
  withCopy(p => {
    writeFileSync(p.state, "{ broken");
    assert.throws(() => run(p));
    assert.equal(readFileSync(p.state, "utf8"), "{ broken");
  });
  withCopy(p => {
    writeFileSync(join(p.dir, "records", "example-lab", "orbit-2.json"), "{ broken");
    assert.throws(() => run(p), /does not parse/);
  });
});

test("a missing state file is created", () => withCopy(p => {
  rmSync(p.state);
  const r = run(p);
  assert.equal(r.written, true);
  assert.equal(readJ(p.state).links.length, 6);
}));

test("CLI: arguments, stdout report and GITHUB_STEP_SUMMARY", () => withCopy(p => {
  const summary = join(p.dir, "summary.md");
  const out = execFileSync(process.execPath, [SCRIPT, "--data", p.dir, "--feed=" + p.feed, "--dry-run"],
    { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  assert.match(out, /6 new/);
  assert.match(out, /#### New links/);
  assert.match(readFileSync(summary, "utf8"), /`example-lab\.orbit-2#mini`/);
  assert.equal(readJ(p.state).links.length, 0);                          // dry run
  assert.throws(() => parseArgs(["--bogus"], { flags: ["dry-run"], options: ["data"] }), /unknown argument/);
  assert.throws(() => parseArgs(["--data"], { flags: [], options: ["data"] }), /needs a value/);
  for (const a of [["--data="], ["--data", ""], ["--data", "  "], ["--data", "--dry-run"]]) assert.throws(() => parseArgs(a, { flags: ["dry-run"], options: ["data"] }), /--data needs a value/, a.join(" "));
  assert.throws(() => parseArgs(["--dry-run=1"], { flags: ["dry-run"], options: [] }), /--dry-run takes no value/);
  assert.deepEqual(parseArgs(["--data", "x", "--dry-run"], { flags: ["dry-run"], options: ["data"] }), { data: "x", "dry-run": true });
  // The CLI refuses an empty --feed= instead of falling back to the real data.json.
  const r = spawnSync(process.execPath, [SCRIPT, "--data", p.dir, "--feed="], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /--feed needs a value/);
}));

test("CLI: a skipped run still reports to GITHUB_STEP_SUMMARY and leaves the state alone", () => withCopy(p => {
  const summary = join(p.dir, "summary.md"), before = readFileSync(p.state, "utf8"), mtime = statSync(p.state).mtimeMs;
  const out = execFileSync(process.execPath, [SCRIPT, "--data", p.dir, "--feed", p.feed],
    { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  assert.match(out, /skipped, data\.json has 50 items/);
  assert.match(readFileSync(summary, "utf8"), /Skipped: data\.json has 50 items .*Nothing was changed/);
  assert.equal(readFileSync(p.state, "utf8"), before);
  assert.equal(statSync(p.state).mtimeMs, mtime);
}, p => editJson(p.feed, j => { j.items = j.items.slice(0, 50); })));

/* ---------- Backfill ---------- */
const H1 = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", H2 = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", H3 = "3333333ccccccccccccccccccccccccccccccccc";
const item = (title, link, date = "Tue, 11 Jun 2024 16:00:00 GMT", extra = {}) => ({ company: "Across AI", source: "Example News", title, link, date, summary: "", ...extra });

test("backfill: oldest sighting wins, ids from the link when missing, commit time and hash", () => {
  const snaps = [
    { commit: H1, time: Date.parse("2026-06-15T08:22:52Z"), data: { generated: "x", items: [item("Introducing Orbit 2", L.intro), ...filler(100)] } },
    { commit: H2, time: "2026-06-15T09:17:20Z", data: null },                                  // unreadable snapshot
    { commit: H3, time: Date.parse("2026-09-30T10:00:00Z"), data: { items: [
      item("Introducing Orbit 2 (updated title)", L.intro, "Tue, 11 Jun 2024 16:00:00 GMT", { id: postId(L.intro) }),
      item("Orbit 3 and Nova 7 compared", L.both, "Fri, 20 Jun 2025 10:00:00 GMT", { id: "k3j9x0a1q" }),
      item("Nova 6 gets a quiet update", "https://news.example.com/nova-6", "Mon, 03 Mar 2025 10:00:00 GMT"), ...filler(100)] } }
  ];
  const r = processSnapshots(snaps, ctxBasic(), []);
  assert.equal(r.processed, 2);
  assert.deepEqual(r.skipped, [{ commit: H2, reason: "data.json missing or not valid JSON" }]);
  const o2 = r.links.find(l => l.modelId === "example-lab.orbit-2");
  assert.equal(o2.postId, postId(L.intro));
  assert.equal(o2.title, "Introducing Orbit 2");                                                // first snapshot kept
  assert.equal(o2.firstSeenAt, "2026-06-15T08:22:52Z"); assert.equal(o2.firstSeenIn, "1111111");
  const o3 = r.links.find(l => l.modelId === "example-lab.orbit-3");
  assert.equal(o3.postId, "k3j9x0a1q");                                                         // build id is leading
  assert.equal(o3.firstSeenAt, "2026-09-30T10:00:00Z"); assert.equal(o3.firstSeenIn, "3333333");
  assert.deepEqual(pairs(r.links), pairs(r.added));
  assert.equal(r.links.length, 3);
  assert.deepEqual(r.candidates.map(c => c.modelId), ["other-lab.nova-6"]);
});

test("backfill: keeps existing links, respects excludes and the item guard", () => {
  const ds = loadDataset(BASIC);
  const m = ds.models.find(x => x.id === "other-lab.nova-7");
  m.news = { include: [], exclude: [postId(L.both)] };
  const ctx = prepare(ds);
  const existing = [{ modelId: "example-lab.orbit-2", variantId: null, postId: postId(L.intro), link: L.intro, title: "Introducing Orbit 2",
    publishedAt: "2024-06-11T16:00:00Z", dateOnly: false, company: "Across AI", source: "Example News", method: "auto", alias: "orbit 2",
    firstSeenAt: "2026-10-01T00:00:00Z", firstSeenIn: "a47100f" }];
  const snaps = [
    { commit: H1, time: Date.parse("2026-06-20T00:00:00Z"), data: { items: [item("Orbit 3 and Nova 7 compared", L.both), ...filler(40)] } },   // < 100: skipped
    { commit: H2, time: Date.parse("2026-06-21T00:00:00Z"), data: { items: [item("Introducing Orbit 2", L.intro), item("Orbit 3 and Nova 7 compared", L.both), ...filler(100)] } }
  ];
  const r = processSnapshots(snaps, ctx, existing);
  assert.equal(r.skipped.length, 1); assert.match(r.skipped[0].reason, /fewer than 100/);
  assert.deepEqual(r.links.find(l => l.modelId === "example-lab.orbit-2"), existing[0]);       // unchanged
  assert.deepEqual(r.added.map(a => a.modelId), ["example-lab.orbit-3"]);                      // nova-7 excluded
  assert.equal(r.added[0].firstSeenIn, "2222222");
  // Same input again: nothing new.
  assert.equal(processSnapshots(snaps, ctx, r.links).added.length, 0);
});

test("backfill --refresh-first-seen: an earlier sighting lowers firstSeen*, nothing else changes", () => {
  const ds = loadDataset(BASIC);
  ds.models.find(x => x.id === "other-lab.nova-7").news = { include: [], exclude: [postId(L.both)] };
  const ctx = prepare(ds);
  const rec = (modelId, link, title, alias) => ({ modelId, variantId: null, postId: postId(link), link, title, publishedAt: "2025-06-20T10:00:00Z",
    dateOnly: false, company: "Across AI", source: "Example News", method: "auto", alias, firstSeenAt: "2026-10-01T00:00:00Z", firstSeenIn: "a47100f" });
  // The nova-7 link predates its exclude: it stays, and an excluded pair is never refreshed.
  const existing = [rec("example-lab.orbit-2", L.intro, "Stored title", "orbit 2"), rec("other-lab.nova-7", L.both, "Orbit 3 and Nova 7 compared", "nova 7")];
  const snaps = [
    { commit: H1, time: Date.parse("2026-06-20T00:00:00Z"), data: { items: [item("Introducing Orbit 2 (old title)", L.intro), item("Orbit 3 and Nova 7 compared", L.both), ...filler(100)] } },
    { commit: H2, time: Date.parse("2026-11-01T00:00:00Z"), data: { items: [item("Introducing Orbit 2", L.intro), ...filler(100)] } }
  ];
  const off = processSnapshots(snaps, ctx, existing);
  assert.deepEqual(off.links.filter(l => l.firstSeenIn === "a47100f"), existing);                  // default: unchanged
  assert.deepEqual(off.refreshed, []);
  const on = processSnapshots(snaps, ctx, existing, { refreshFirstSeen: true });
  const o2 = on.links.find(l => l.modelId === "example-lab.orbit-2");
  assert.deepEqual(o2, { ...existing[0], firstSeenAt: "2026-06-20T00:00:00Z", firstSeenIn: "1111111" });  // title etc. kept
  assert.deepEqual(on.links.find(l => l.modelId === "other-lab.nova-7"), existing[1]);          // excluded: untouched
  assert.deepEqual(on.refreshed.map(x => [x.modelId, x.previousFirstSeenAt, x.firstSeenAt]), [["example-lab.orbit-2", "2026-10-01T00:00:00Z", "2026-06-20T00:00:00Z"]]);
  assert.deepEqual(on.added.map(a => a.modelId), ["example-lab.orbit-3"]);
  assert.match(backfillReport(on, { commits: 2, refreshFirstSeen: true }), /1 first-seen correction[^s][\s\S]*#### First seen corrected[\s\S]*2026-10-01T00:00:00Z \(`a47100f`\) → 2026-06-20T00:00:00Z \(`1111111`\)/);
  // Running it again changes nothing more.
  const again = processSnapshots(snaps, ctx, on.links, { refreshFirstSeen: true });
  assert.deepEqual(again.links, on.links); assert.deepEqual(again.refreshed, []); assert.deepEqual(again.added, []);
});

test("backfill: firstSeenAt in whole seconds; the W01 note reaches the report, not the links", () => {
  const ds = loadDataset(BASIC);
  ds.models.find(x => x.id === "other-lab.nova-7").aliases.push({ text: "Orbit 3", match: "candidate" });
  const snaps = [{ commit: H1, time: "2026-06-15T08:22:52.900Z", data: { items: [item("Orbit 3 and Nova 7 compared", L.both), ...filler(100)] } }];
  const r = processSnapshots(snaps, prepare(ds), []);
  assert.deepEqual(r.links.map(l => [l.modelId, l.firstSeenAt]), [["example-lab.orbit-3", "2026-06-15T08:22:52Z"], ["other-lab.nova-7", "2026-06-15T08:22:52Z"]]);
  assert.ok(r.links.every(l => !("ambiguous" in l)));
  const rep = backfillReport(r, { commits: 1 });
  assert.match(rep, /`example-lab\.orbit-3`.*W01/);
  assert.doesNotMatch(rep, /`other-lab\.nova-7`.*W01/);
});

test("backfill: git log parsing and --since/--limit", () => {
  const commits = parseLog(`${H1} 1781511772\r\n\n${H2} 1781515040\n${H3} 1790000000\nnot a line\n`);
  assert.deepEqual(commits.map(c => c.commit), [H1, H2, H3]);
  assert.equal(commits[0].time, 1781511772000);
  assert.deepEqual(filterCommits(commits, { since: "2026-06-15T09:00:00Z" }).map(c => c.commit), [H2, H3]);
  assert.deepEqual(filterCommits(commits, { limit: "2" }).map(c => c.commit), [H1, H2]);
  assert.deepEqual(filterCommits(commits, { since: "2026-06-15T09:00:00Z", limit: 1 }).map(c => c.commit), [H2]);
  assert.throws(() => filterCommits(commits, { since: "yesterday-ish" }), /not a date/);
  assert.throws(() => filterCommits(commits, { limit: "0" }), /positive/);
});

test("the basic fixture itself is not modified by the tests", () => {
  assert.deepEqual(readJ(join(BASIC, "state", "news-links.json")), { schemaVersion: 1, links: [] });
  assert.ok(!existsSync(join(BASIC, "state", "news-links.json.tmp")));
});

/* ---------- Possible new models (job summary) ---------- */
test("possible new models: versioned names in titles that no record, variant or alias knows", () => {
  const ds = loadDataset(BASIC);
  ds.models.push({ id: "openai.gpt-5", name: "GPT-5", aliases: [{ text: "gpt-5-2025-08-07", match: "auto" }],
    variants: [{ id: "mini", name: "GPT-5 mini", aliases: [{ text: "GPT-5 nano", match: "never" }] }] },
    { id: "google.gemini-2-5-pro", name: "Gemini 2.5 Pro" });
  const item = (title, date = "2026-09-20T10:00:00Z", n = title) => ({ title, link: `https://example.org/${encodeURIComponent(n)}`, date, company: "x", source: "y" });
  const items = [item("Introducing GPT-6"), item("GPT-6 in practice", "2026-09-28T10:00:00Z"), item("GPT-5 mini and GPT-5 nano for everyone"),
    item("What GPT-5 means"), item("Gemini 2.5 rollout"), item("Gemini 3.8 Flash arrives"), item("Claude Opus 4.10 is not a thing either"),
    item("GPT-5.2 prompting guide"), item("Nothing versioned here"), item("Llama 3.1 405B weights")];
  const found = newModelNames(items, ds);
  const names = found.map(x => x.name);
  assert.deepEqual(names.slice(0, 1), ["gpt-6"], "most titles first");
  assert.equal(found[0].count, 2);
  assert.match(found[0].title, /in practice/, "the latest title is the example");
  for (const n of ["gemini 3.8 flash", "gpt-5.2", "llama 3.1", "claude opus 4.10"]) assert.ok(names.includes(n), n);
  for (const n of ["gpt-5", "gpt-5 mini", "gpt-5 nano", "gemini 2.5"]) assert.ok(!names.includes(n), `${n} is known (name, variant, never-alias or prefix of a name)`);
  assert.ok(knownNames(ds).has("gpt-5 nano"), "never aliases count as known: the curator decided");
  const rep = formatReport({ newNames: found });
  assert.match(rep, /#### Possible new models/);
  assert.match(rep, /- "gpt-6" · 2 titles · latest: \[GPT-6 in practice\]/);
  assert.ok(!formatReport({}).includes("Possible new models"), "no section without names");
});