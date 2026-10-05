/* Model History: links AI Radar news items to model records (spec §22).
   Reads data.json (never writes it), the curated aliases and excludes in the records and
   the previous state/news-links.json, and appends new (modelId, postId) pairs to that file.

   Title matching only decides WHETHER a link is made; the stored relation is the pair.
   Only aliases the curator set to match "auto" create links. "candidate" hits go to a
   report for manual review, "never" aliases are ignored and news.exclude always wins.
   Links are never removed: the snapshot stays when the post rolls out of data.json.

   Usage: node scripts/model-history/match-news.mjs [--data <dir>] [--feed <data.json>] [--dry-run]
     defaults: <repo>/model-history and <repo>/data.json, where <repo> is found from this
     script's own location, so the run does not depend on the working directory.
   stdout gets the full report; GITHUB_STEP_SUMMARY (public, size-limited) gets a capped one.
   Exits 0 when the run is skipped by the data.json guard (a feed problem is not ours to
   fail on), 1 when our own files are broken (then nothing is written). */
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { SCHEMA_VERSION, RE, normalize, postId, isIsoInstant, loadDataset } from "./lib.mjs";

export const MIN_ITEMS = 100;           // fewer items means a broken feed build: skip (AC-15)
export const SUMMARY_LIMIT = 200;       // lines per list in the job summary (1 MiB cap, public)
export const STATE_FILE = join("state", "news-links.json");
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Field order of a link record (spec §22.3); fixed so the state file diffs stay small.
export const FIELDS = ["modelId", "variantId", "postId", "link", "title", "publishedAt", "dateOnly",
  "company", "source", "method", "alias", "firstSeenAt", "firstSeenIn"];

export const arr = x => (Array.isArray(x) ? x : []);
const str = x => (typeof x === "string" ? x.trim() : "");
// Code-unit comparison: the same order on every machine, unlike localeCompare.
const cmp = (a, b) => { a = String(a ?? ""); b = String(b ?? ""); return a < b ? -1 : a > b ? 1 : 0; };
// ISO UTC in the format of the spec examples: ".000" is dropped, real milliseconds stay, so
// publishedAt keeps the exact instant (dateOnly depends on it).
export const iso = t => new Date(t).toISOString().replace(/\.000Z$/, "Z");
// firstSeenAt in whole seconds: data.json "generated" has milliseconds, commit times do not,
// and live runs and the backfill must write one format.
export const isoSec = t => iso(Math.floor(t / 1000) * 1000);
export const pairKey = x => x.modelId + "\u0000" + x.postId;
export const sortLinks = links => [...links].sort((a, b) => cmp(a.modelId, b.modelId) || cmp(a.publishedAt, b.publishedAt) || cmp(a.postId, b.postId));

/* ---------- Curator input ---------- */
// Every alias of a record and of its inline variants (§13.3), normalised. A missing or
// unknown match value counts as "candidate" (the default), so only an explicit "auto" links.
// "never" aliases are left out before matching (§22.4: only aliases with match ≠ never), so
// a longer "never" alias does not block a shorter "auto" one; that takes an exclude.
export function collectAliases(ds) {
  const out = [], seen = new Set();
  const add = (modelId, variantId, a) => {
    if (!a || typeof a.text !== "string") return;
    const match = a.match === "auto" || a.match === "never" ? a.match : "candidate";
    const text = normalize(a.text);
    if (match === "never" || !text) return;
    const k = [modelId, variantId, text, match].join("\u0000");
    if (!seen.has(k)) { seen.add(k); out.push({ modelId, variantId, text, match }); }
  };
  for (const m of ds.models) {
    if (typeof m.id !== "string" || !RE.scoped.test(m.id)) continue;
    for (const a of arr(m.aliases)) add(m.id, null, a);
    for (const v of arr(m.variants)) if (v && typeof v.id === "string" && RE.local.test(v.id)) for (const a of arr(v.aliases)) add(m.id, v.id, a);
  }
  return out.sort((x, y) => y.text.length - x.text.length || cmp(x.text, y.text) || cmp(x.modelId, y.modelId) || cmp(x.variantId, y.variantId) || cmp(x.match, y.match));
}
// Per model the excluded and the manually included post ids. Two records with one id are a
// validator error, but this script also runs without validate: their lists are merged,
// because a dropped exclude would let in a link that can never be removed.
export function prepare(ds) {
  const exclude = new Map(), include = new Map();
  const addTo = (map, id, ids) => { const s = map.get(id) || new Set(); for (const x of ids) if (x) s.add(x); map.set(id, s); };
  for (const m of ds.models) {
    const n = (m && m.news) || {};
    addTo(exclude, m.id, arr(n.exclude).map(x => (typeof x === "string" ? x : x && x.postId)));
    addTo(include, m.id, arr(n.include).map(x => x && x.postId));
  }
  return { aliases: collectAliases(ds), exclude, include };
}

/* ---------- Matching ---------- */
const WORD = /[a-z0-9]/;
const leftOk = (s, i) => i === 0 || !WORD.test(s[i - 1]);
// Not followed by a letter, digit or "_", nor by ".<digit>" or "-<letter|digit>": those make a
// longer name or version, so "orbit 2" does not match "orbit 2x", "orbit 2.5" or "orbit 2-vision".
function rightOk(s, j) {
  const c = s[j], n = s[j + 1] || "";
  if (c === undefined) return true;
  if (WORD.test(c) || c === "_") return false;
  return !((c === "." && /[0-9]/.test(n)) || (c === "-" && WORD.test(n)));
}
// Hits of all aliases in an already normalised text. On overlap the longest alias wins
// ("orbit 2 mini" over "orbit 2"), whatever the match values. Hits on exactly the same span
// (one text used as alias of two models, warning W01) all stay: each model then follows its
// own match value, and the report notes the shared alias.
export function findHits(text, aliases) {
  const hits = [];
  for (const alias of aliases) {
    for (let i = text.indexOf(alias.text); i >= 0; i = text.indexOf(alias.text, i + 1)) {
      const end = i + alias.text.length;
      if (leftOk(text, i) && rightOk(text, end)) hits.push({ start: i, end, alias });
    }
  }
  hits.sort((x, y) => (y.end - y.start) - (x.end - x.start) || x.start - y.start);
  const kept = [];
  for (const h of hits) if (kept.every(k => h.end <= k.start || h.start >= k.end || (h.start === k.start && h.end === k.end))) kept.push(h);
  return kept.sort((x, y) => x.start - y.start || (y.end - y.start) - (x.end - x.start));
}

// A feed date as an instant. Date.parse reads a date-time without a zone as LOCAL time, so a
// local backfill run (Europe/Amsterdam) would shift such dates against CI. The two zone-less
// shapes a feed can carry are read as UTC; anything else (with a zone, or an unknown shape)
// goes to Date.parse unchanged. build-feed writes toUTCString() dates, so this only matters
// for old snapshots.
export function feedTime(v) {
  if (typeof v !== "string") return NaN;
  const s = v.trim();
  if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(s)) return Date.parse(s + "Z");
  if (/^(?:[a-z]{3},\s*)?\d{1,2}\s+[a-z]{3}\s+\d{4}(?:\s+\d\d:\d\d(?::\d\d)?)?$/i.test(s)) return Date.parse(s + " GMT");
  return Date.parse(s);
}
// Google News titles end in " - Outlet". The dashboard shows the outlet as the source and
// the headline as the title (app.js normalize(), same rule); the snapshot stores them the
// same way, so the model pages show what the dashboard shows and the 2-day same-title merge
// (§22.4) compares headlines, not headlines with different outlet suffixes. Idempotent: after
// a split the source is no longer "Google News".
export function splitOutlet(title, source) {
  if (source === "Google News") {
    const i = title.lastIndexOf(" - ");
    if (i > 0 && title.length - i <= 60) return { title: title.slice(0, i).trim(), source: title.slice(i + 3).trim() };
  }
  return { title, source };
}

// A data.json item as the matcher sees it, or null when it cannot become a valid snapshot.
// Only the id rule (a valid build id is leading, else hash the link), the link check, the
// Google News split and the first-occurrence dedupe follow app.js normalize(). app.js also
// drops companies it does not know; the matcher keeps them, which is harmless for the
// stored (modelId, postId) pair. Some feeds (xAI) give no source; the snapshot then names the
// link's host ("x.ai"), because the validator requires a source on every snapshot (E17). The
// match text uses the item title as it is in data.json (§22.4), as app.js does for its own
// classification.
const hostOf = link => { try { return new URL(link).hostname.replace(/^www\./, ""); } catch { return ""; } };
export function itemView(it) {
  if (!it || typeof it !== "object") return null;
  const link = typeof it.link === "string" && /^https?:\/\/\S+$/i.test(it.link.trim()) ? it.link.trim() : "";
  const t = feedTime(it.date), rawTitle = str(it.title);
  if (!link || !Number.isFinite(t) || !rawTitle) return null;
  const d = new Date(t);
  // Date-only feeds are stored at exactly 00:00:00 UTC (F14): keep that fact explicit.
  const dateOnly = !d.getUTCHours() && !d.getUTCMinutes() && !d.getUTCSeconds() && !d.getUTCMilliseconds();
  const { title, source } = splitOutlet(rawTitle, str(it.source));
  return {
    postId: typeof it.id === "string" && RE.postId.test(it.id) ? it.id : postId(link),
    link, title, publishedAt: iso(t), dateOnly, company: str(it.company), source: source || hostOf(link),
    text: normalize(rawTitle + " " + str(it.summary))
  };
}

/* Matches all items. found: link records without firstSeen*; candidates: pairs with only
   candidate hits. Excludes are applied here; the state is applied by mergeLinks.
   ambiguous (report only, never stored): the pair rests only on an alias that also hit
   another model on the same span (W01). Both models still follow their own match value
   (§22.4); the validator warns about W01 and the curator excludes where a link is wrong. */
export function matchItems(items, ctx) {
  const found = [], candidates = [], seen = new Set();
  for (const raw of arr(items)) {
    const it = itemView(raw);
    if (!it || seen.has(it.postId)) continue;          // first occurrence wins, as in app.js
    seen.add(it.postId);
    const hits = findHits(it.text, ctx.aliases), byModel = new Map();
    for (const h of hits) {
      const shared = hits.some(k => k.start === h.start && k.end === h.end && k.alias.modelId !== h.alias.modelId);
      if (!byModel.has(h.alias.modelId)) byModel.set(h.alias.modelId, []);
      byModel.get(h.alias.modelId).push({ ...h, shared });
    }
    for (const [modelId, hs] of [...byModel].sort((a, b) => cmp(a[0], b[0]))) {
      const ex = ctx.exclude.get(modelId);
      if (ex && ex.has(it.postId)) continue;             // exclude always wins
      const snap = { modelId, variantId: null, postId: it.postId, link: it.link, title: it.title, publishedAt: it.publishedAt,
        dateOnly: it.dateOnly, company: it.company, source: it.source };
      const auto = hs.filter(h => h.alias.match === "auto"), use = auto.length ? auto : hs;
      // A link to a variant counts for the record (§13.3); the variant is named only when
      // every deciding hit is that one variant, so "Orbit 2 vs Orbit 2 Mini" links the record.
      // Candidates get the same rule, so the report says which alias (or include) to accept.
      const vs = new Set(use.map(h => h.alias.variantId));
      const variantId = vs.size === 1 ? [...vs][0] : null;
      const ambiguous = use.every(h => h.shared);
      if (auto.length) {
        // The stored alias is the one that decided: of the named variant, unshared if possible.
        const fit = auto.filter(h => h.alias.variantId === variantId), pool = fit.length ? fit : auto;
        found.push({ ...snap, variantId, method: "auto", alias: (pool.find(h => !h.shared) || pool[0]).alias.text, ambiguous });
      } else {
        candidates.push({ ...snap, variantId, aliases: [...new Set(hs.map(h => h.alias.text))].sort(cmp), ambiguous });
      }
    }
  }
  return { found, candidates };
}
// Report copies of link records with the W01 note of the pairs in keys; the records
// themselves (and so the state file) never carry it.
export const flagW01 = (records, keys) => records.map(r => (keys.has(pairKey(r)) ? { ...r, ambiguous: true } : r));
export const w01Keys = found => new Set(found.filter(f => f.ambiguous).map(pairKey));

// Appends the pairs that are not in the state yet. Existing records are never changed.
export function mergeLinks(links, found, { firstSeenAt, firstSeenIn }) {
  const have = new Set(arr(links).map(pairKey)), added = [];
  for (const f of found) {
    const k = pairKey(f);
    if (have.has(k)) continue;
    have.add(k);
    added.push(Object.fromEntries(FIELDS.map(n => [n, n === "firstSeenAt" ? firstSeenAt : n === "firstSeenIn" ? firstSeenIn : f[n]])));
  }
  return { links: sortLinks([...arr(links), ...added]), added: sortLinks(added) };
}
// Candidates that are still open: not linked (state) and not included by hand.
export function openCandidates(candidates, links, ctx) {
  const linked = new Set(links.map(pairKey));
  return sortLinks(candidates.filter(c => !linked.has(pairKey(c)) && !(ctx.include.get(c.modelId) || new Set()).has(c.postId)));
}

/* ---------- Input and state files ---------- */
export function feedProblem(json, minItems = MIN_ITEMS) {
  if (!json || typeof json !== "object" || !Array.isArray(json.items)) return "data.json has no items array";
  if (json.items.length < minItems) return `data.json has ${json.items.length} items (fewer than ${minItems})`;
  return null;
}
export function readFeed(path) {
  if (!existsSync(path)) return { problem: `${path} not found` };
  let json;
  try { json = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")); } catch (e) { return { problem: `data.json is not valid JSON (${e.message})` }; }
  const problem = feedProblem(json);
  return problem ? { problem } : { json };
}
// The raw text is kept so an unchanged state is never rewritten. A broken state file throws:
// overwriting it would silently drop every stored link.
export function readState(path) {
  if (!existsSync(path)) return { raw: null, links: [] };
  const raw = readFileSync(path, "utf8");
  const j = JSON.parse(raw.replace(/^﻿/, ""));
  if (!j || j.schemaVersion !== SCHEMA_VERSION || !Array.isArray(j.links)) throw new Error(`${path}: expected { schemaVersion: ${SCHEMA_VERSION}, links: [] }`);
  return { raw, links: j.links };
}
export const serializeState = links => JSON.stringify({ schemaVersion: SCHEMA_VERSION, links: sortLinks(links) }, null, 2) + "\n";
// Writes only on a content change (a CRLF checkout counts as unchanged), via a temp file so
// a crash never leaves half a state file behind. Returns whether it wrote.
export function writeIfChanged(path, raw, text) {
  if (raw !== null && raw.replace(/\r\n/g, "\n") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", text);
  renameSync(path + ".tmp", path);
  return true;
}
// The commit that holds this data.json, abbreviated like the spec example. "unknown" outside
// git, for an untracked file or one with local edits (no commit holds that content).
// git is injectable so the tests need no repository.
const gitIn = cwd => args => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
export function feedCommit(path, git = gitIn(dirname(path))) {
  try {
    const f = basename(path);
    if (git(["status", "--porcelain", "--", f])) return "unknown";
    const h = git(["log", "-1", "--format=%H", "--", f]);
    if (!/^[0-9a-f]{40}$/.test(h)) return "unknown";
    // In a shallow checkout (actions/checkout defaults to depth 1) the oldest commit present
    // shows no parent, so git log reports it as touching every file: its hash proves nothing.
    // CI therefore needs enough depth to reach the last data.json commit (fetch-depth: 50).
    if (git(["rev-parse", "--is-shallow-repository"]) === "true" && git(["rev-list", "--parents", "-n", "1", h]).split(/\s+/).length < 2) return "unknown";
    return h.slice(0, 7);
  } catch (e) { return "unknown"; }
}
// The build time of data.json is when AI Radar saw the item; it also keeps two runs on the
// same input identical. Falls back to the run time for a missing or future value.
export function seenAt(feed, now) {
  const g = feed && feed.generated;
  return isoSec(isIsoInstant(g) && Date.parse(g) <= now ? Date.parse(g) : now);
}

/* ---------- Report (job summary: public, only material that is public already, §28.4) ---------- */
// Feed titles come from third parties: one line each, and no markdown syntax of their own.
export const md = s => String(s ?? "").replace(/\s+/g, " ").trim().replace(/[\\`*_[\]<>|#]/g, "\\$&");
const mdUrl = u => String(u).replace(/[()<>\s]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
export const target = x => "`" + x.modelId + (x.variantId ? "#" + x.variantId : "") + "`";
export const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const W01_NOTE = " · alias also on another model (W01): check, exclude if wrong";
export const linkLine = x => `- ${target(x)}: [${md(x.title)}](${mdUrl(x.link)}) · ${String(x.publishedAt).slice(0, 10)} · alias "${md(x.alias)}"`
  + (x.ambiguous ? W01_NOTE : "");
export const candidateLine = x => `- ${target(x)}: [${md(x.title)}](${mdUrl(x.link)}) · ${String(x.publishedAt).slice(0, 10)} · ${x.aliases.map(a => `"${md(a)}"`).join(", ")} · post \`${x.postId}\``
  + (x.ambiguous ? " · alias also on another model (W01)" : "");
export const MORE_HINT = "run `node scripts/model-history/match-news.mjs --dry-run` locally for the full list.";
// The first `limit` lines of a sorted list, then one line that says how many were left out.
export const capped = (xs, line, limit, what, more = MORE_HINT) =>
  xs.length > limit ? [...xs.slice(0, limit).map(line), "", `${xs.length - limit} more ${what} not shown here; ${more}`] : xs.map(line);
// limit caps each list (the facts line keeps the totals); Infinity gives the full report.
export function formatReport({ heading = "Model History: news matching", facts = [], added = [], candidates = [], newNames = [], dryRun = false, skipped = null, limit = Infinity, more = MORE_HINT }) {
  const out = [`### ${heading}`, ""];
  if (skipped) return out.concat(`Skipped: ${md(skipped)}. Nothing was changed.`).join("\n") + "\n";
  out.push([...facts, plural(added.length, "new link"), plural(candidates.length, "candidate")].join(" · ") + (dryRun ? " (dry run: nothing written)" : ""));
  if (added.length) out.push("", "#### New links", "", ...capped(added, linkLine, limit, "new links", more));
  if (candidates.length) out.push("", "#### Candidates for review", "",
    "Only aliases set to `auto` link automatically. To accept a candidate, set the alias to `auto` or add a `news.include` to the record; otherwise ignore it.",
    "", ...capped(candidates, candidateLine, limit, "candidates", more));
  if (newNames.length) out.push("", "#### Possible new models", "",
    "Versioned model names in AI Radar titles that no record or alias knows yet. Add a record (or an alias) if the organisation released it.",
    "", ...capped(newNames, newNameLine, Math.min(limit, 50), "names", more));
  return out.join("\n") + "\n";
}
// stdout gets the full report, the public job summary the capped one.
export function emitReport(report, summary = report) {
  process.stdout.write(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}

/* ---------- Possible new models (§28.4) ----------
   Versioned names of the tracked companies' model lines in feed titles that no record knows
   yet: the curator's to-do list for new releases. Report only; nothing is linked or stored.
   A name is known when a record name, variant name or alias (any match value, "never" too)
   equals it or starts with it at a word boundary ("gemini 2.5" is known from "gemini 2.5 pro"). */
const V = "\\d+(?:\\.\\d+)?";
export const NEW_NAME_RE = new RegExp("(?<![a-z0-9])(?:" + [
  `gpt-${V}o?(?:[ -](?:mini|nano|pro|turbo))?`, `o\\d(?:-(?:mini|pro|preview))?`, `gpt-oss`,
  `claude (?:(?:opus|sonnet|haiku|fable|mythos) ${V}|${V}(?: (?:opus|sonnet|haiku))?)`,
  `gemini ${V}(?: (?:pro|flash|ultra|nano)(?:[ -]lite)?)?`, `gemma ${V}n?`, `llama ${V}`, `grok[ -]${V}(?: (?:mini|fast|heavy))?`,
  `(?:mistral|magistral|ministral|pixtral|mixtral)(?: (?:large|medium|small))? ${V}`, `deepseek[ -](?:v${V}|r\\d+)`,
  `phi-${V}(?:-(?:mini|reasoning|multimodal))?`, `nemotron(?:[ -]${V})?(?: (?:nano|super|ultra))?`,
  `command (?:a(?: (?:vision|reasoning))?|r7b|r\\+?)`, `aya (?:expanse|vision|${V})`, `sonar(?: (?:pro|reasoning(?: pro)?|deep research))?`,
  `smollm${V}?`, `smolvlm${V}?`
].join("|") + ")(?![a-z0-9]|\\.\\d)", "g");
export function knownNames(ds) {
  const out = new Set();
  const add = t => { const n = typeof t === "string" ? normalize(t) : ""; if (n) out.add(n); };
  for (const m of ds.models) {
    add(m && m.name);
    for (const a of arr(m && m.aliases)) add(a && a.text);
    for (const v of arr(m && m.variants)) { add(v && v.name); for (const a of arr(v && v.aliases)) add(a && a.text); }
  }
  return out;
}
export function newModelNames(items, ds) {
  const known = [...knownNames(ds)];
  const isKnown = n => known.some(k => k === n || (k.startsWith(n) && /^[ -]/.test(k.slice(n.length))));
  const found = new Map();
  for (const it of arr(items)) {
    const v = itemView(it);
    if (!v) continue;
    for (const m of normalize(v.title).matchAll(NEW_NAME_RE)) {
      const n = m[0];
      if (isKnown(n)) continue;
      const e = found.get(n) || { name: n, count: 0, title: v.title, link: v.link, publishedAt: v.publishedAt };
      e.count++;
      if (v.publishedAt > e.publishedAt) Object.assign(e, { title: v.title, link: v.link, publishedAt: v.publishedAt });
      found.set(n, e);
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count || cmp(a.name, b.name));
}
export const newNameLine = x => `- "${md(x.name)}" · ${plural(x.count, "title")} · latest: [${md(x.title)}](${mdUrl(x.link)}) · ${String(x.publishedAt).slice(0, 10)}`;

/* ---------- Run ---------- */
export function loadCurated(dataDir) {
  if (!existsSync(dataDir)) throw new Error(`data directory not found: ${dataDir}`);
  const ds = loadDataset(dataDir);
  // A record that fails to parse could hold an exclude; linking without it is not undoable.
  if (ds.parseErrors.length) throw new Error("dataset does not parse: " + ds.parseErrors.map(e => `${e.file} (${e.message})`).join("; "));
  return ds;
}
export function runMatch({ dataDir, feedPath, dryRun = false, now = Date.now(), commit } = {}) {
  dataDir = resolve(dataDir); feedPath = resolve(feedPath);
  // Guard first: with an unusable data.json nothing else is read and nothing is written.
  const feed = readFeed(feedPath);
  if (feed.problem) {
    const report = formatReport({ skipped: feed.problem });
    return { status: "skipped", reason: feed.problem, added: [], candidates: [], written: false, report, summary: report };
  }
  const ds = loadCurated(dataDir), ctx = prepare(ds);
  const statePath = join(dataDir, STATE_FILE), state = readState(statePath);
  const { found, candidates } = matchItems(feed.json.items, ctx);
  const newNames = newModelNames(feed.json.items, ds);
  const merged = mergeLinks(state.links, found, { firstSeenAt: seenAt(feed.json, now), firstSeenIn: commit || feedCommit(feedPath) });
  const open = openCandidates(candidates, merged.links, ctx);
  const text = serializeState(merged.links);
  const changed = state.raw === null || state.raw.replace(/\r\n/g, "\n") !== text;
  const written = !dryRun && writeIfChanged(statePath, state.raw, text);
  const rep = { facts: [plural(feed.json.items.length, "feed item")], added: flagW01(merged.added, w01Keys(found)), candidates: open, newNames, dryRun };
  return { status: "ok", added: merged.added, candidates: open, newNames, links: merged.links, changed, written,
    report: formatReport(rep), summary: formatReport({ ...rep, limit: SUMMARY_LIMIT }) };
}

/* ---------- CLI ---------- */
// An empty value is an error, not "use the default": "--data=" would otherwise run against
// the real repo data.
export function parseArgs(argv, { flags = [], options = [] }) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], m = /^--([a-z-]+)(?:=(.*))?$/s.exec(a);
    if (m && flags.includes(m[1])) {
      if (m[2] !== undefined) throw new Error(`--${m[1]} takes no value`);
      out[m[1]] = true;
    } else if (m && options.includes(m[1])) {
      const v = m[2] !== undefined ? m[2] : argv[++i];
      if (v === undefined || !v.trim() || v.startsWith("--")) throw new Error(`--${m[1]} needs a value`);
      out[m[1]] = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}
export function isMain(url) {
  try {
    const a = resolve(process.argv[1] || ""), b = fileURLToPath(url);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch (e) { return false; }
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ["dry-run"], options: ["data", "feed"] });
    const r = runMatch({
      dataDir: args.data || join(REPO, "model-history"),
      feedPath: args.feed || join(REPO, "data.json"),
      dryRun: !!args["dry-run"]
    });
    if (r.status === "skipped") console.log(`match-news: skipped, ${r.reason}; nothing changed`);
    else console.log(`match-news: ${r.added.length} new, ${r.links.length} total, ${r.candidates.length} candidates; ${r.written ? "state written" : r.changed ? "state not written (dry run)" : "state unchanged"}`);
    emitReport(r.report, r.summary);
  } catch (e) {
    console.error("match-news: " + e.message);
    process.exitCode = 1;
  }
}
