/* Model History: one-off backfill of news links from the git history of data.json (spec §22.6).
   data.json rolls over, so the live matcher only sees recent posts. This walks every commit
   that changed data.json, oldest to newest, and applies the same matcher and the same guard
   to each snapshot. The first commit that shows a pair sets its firstSeenAt (commit time)
   and firstSeenIn (commit hash). Snapshots from before 30 September 2026 carry no ids, so
   those are computed from the link (F6), the same rule the dashboard uses.

   Read-only on git (git log, git show); writes only model-history/state/news-links.json,
   and only on a content change. Links are never removed. Existing links are kept unchanged,
   except that the opt-in --refresh-first-seen (an addition to §22.6) lowers firstSeenAt and
   firstSeenIn, and only those, of an existing auto link to an earlier sighting in the history
   (a live run that linked a post after an alias became "auto" records the run time, not when
   AI Radar first carried the post). Run it locally in a full (not shallow) clone and send the
   result as a PR.

   Usage: node scripts/model-history/backfill-news.mjs [--since <date>] [--limit <n>] [--data <dir>] [--refresh-first-seen] [--dry-run]
     --since  only commits at or after this date (anything Date.parse accepts, e.g. 2026-06-15)
     --limit  only the first n commits (oldest first, after --since)
     --refresh-first-seen  also move firstSeenAt/firstSeenIn of existing links back to an
              earlier sighting; no other field changes
     --data   default <repo>/model-history; the repo is found from this script's location */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { REPO, STATE_FILE, MIN_ITEMS, SUMMARY_LIMIT, arr, isoSec, pairKey, prepare, matchItems, mergeLinks, openCandidates, feedProblem, sortLinks,
  readState, serializeState, writeIfChanged, formatReport, emitReport, loadCurated, parseArgs, isMain, capped, md, plural, target,
  flagW01, w01Keys } from "./match-news.mjs";

const FEED = "data.json";                  // path of the feed inside the repo
const MAX_BUFFER = 512 * 1024 * 1024;      // one data.json snapshot is about 1 MB; generous on purpose
const MORE = "the full list is on stdout of the local backfill run.";

/* ---------- Git (read-only) ---------- */
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
// "git log --reverse --format=%H %ct" output → [{ commit, time }] (time in ms), oldest first.
export function parseLog(text) {
  return String(text).split(/\r?\n/).map(l => /^([0-9a-f]{40}) (\d+)$/.exec(l.trim())).filter(Boolean)
    .map(m => ({ commit: m[1], time: +m[2] * 1000 }));
}
export const listCommits = (repo, path = FEED) => parseLog(git(["log", "--reverse", "--format=%H %ct", "--", path], repo));
// Filtering in JS instead of git's --since: git stops walking at the first older commit it
// meets, which misses commits when timestamps are out of order.
export function filterCommits(commits, { since, limit } = {}) {
  let out = commits;
  if (since !== undefined && since !== null) {
    const t = Date.parse(since);
    if (!Number.isFinite(t)) throw new Error(`--since: not a date: ${since}`);
    out = out.filter(c => c.time >= t);
  }
  if (limit !== undefined && limit !== null) {
    if (!/^\d+$/.test(String(limit)) || +limit < 1) throw new Error(`--limit: not a positive whole number: ${limit}`);
    out = out.slice(0, +limit);
  }
  return out;
}
// A snapshot's parsed data.json, or null when it is missing or not JSON in that commit.
export function readSnapshot(repo, commit, path = FEED) {
  try { return JSON.parse(git(["show", `${commit}:${path}`], repo).replace(/^﻿/, "")); } catch (e) { return null; }
}

/* ---------- Processing (pure; the tests feed it synthetic snapshots) ---------- */
// Existing auto links that this snapshot matched again and that were first seen later than
// this snapshot: only firstSeenAt/firstSeenIn move back, every other field stays as it is.
// found comes from matchItems, so an excluded pair is never touched.
export function lowerFirstSeen(links, found, { firstSeenAt, firstSeenIn }) {
  const t = Date.parse(firstSeenAt), hit = new Set(found.map(pairKey));
  return links.map(l => (hit.has(pairKey(l)) && l.method === "auto" && Date.parse(l.firstSeenAt) > t ? { ...l, firstSeenAt, firstSeenIn } : l));
}
/* snapshots: any iterable of { commit, time (ms or ISO), data (parsed data.json or null) },
   oldest first. The CLI passes a generator, so only one snapshot is in memory at a time.
   refreshFirstSeen: see lowerFirstSeen; off by default, so existing links stay unchanged. */
export function processSnapshots(snapshots, ctx, links = [], { minItems = MIN_ITEMS, refreshFirstSeen = false } = {}) {
  const before = new Map(arr(links).map(l => [pairKey(l), l])), addedKeys = new Set(), w01 = new Set(), skipped = [], cand = new Map();
  let processed = 0;
  for (const s of snapshots) {
    const problem = s.data == null ? "data.json missing or not valid JSON" : feedProblem(s.data, minItems);
    const time = typeof s.time === "number" ? s.time : Date.parse(s.time);
    if (problem || !Number.isFinite(time)) { skipped.push({ commit: s.commit, reason: problem || "no commit time" }); continue; }
    const r = matchItems(s.data.items, ctx);
    const seen = { firstSeenAt: isoSec(time), firstSeenIn: /^[0-9a-f]{7,40}$/.test(s.commit || "") ? s.commit.slice(0, 7) : "unknown" };
    const m = mergeLinks(links, r.found, seen);
    // Commit times can be out of order (rebases), so a pair added by an earlier snapshot of
    // this run is lowered too; the final state decides what counts as added or corrected.
    links = refreshFirstSeen ? lowerFirstSeen(m.links, r.found, seen) : m.links;
    for (const a of m.added) addedKeys.add(pairKey(a));
    for (const k of w01Keys(r.found)) w01.add(k);
    // The latest snapshot of a candidate wins, so the report shows the item as it was last seen.
    for (const c of r.candidates) cand.set(pairKey(c), c);
    processed++;
  }
  links = sortLinks(arr(links));
  const added = links.filter(l => addedKeys.has(pairKey(l)));
  const refreshed = links.filter(l => before.has(pairKey(l)) && before.get(pairKey(l)).firstSeenAt !== l.firstSeenAt)
    .map(l => ({ ...l, previousFirstSeenAt: before.get(pairKey(l)).firstSeenAt, previousFirstSeenIn: before.get(pairKey(l)).firstSeenIn }));
  // w01: pairs that some snapshot linked only through an alias shared with another model
  // (report note only).
  return { links, added, refreshed, candidates: openCandidates([...cand.values()], links, ctx), processed, skipped, w01 };
}

/* ---------- CLI ---------- */
function* snapshotsFrom(repo, commits, log) {
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    if (log && (i + 1) % 100 === 0) log(`backfill: ${i + 1}/${commits.length} commits read`);
    yield { commit: c.commit, time: c.time, data: readSnapshot(repo, c.commit) };
  }
}
/* ---------- Report ---------- */
export const refreshedLine = x => `- ${target(x)}: ${md(x.title)} · first seen ${x.previousFirstSeenAt} (\`${md(x.previousFirstSeenIn)}\`) → ${x.firstSeenAt} (\`${md(x.firstSeenIn)}\`)`;
// limit caps each list, as in the matcher's job summary; Infinity gives the full report.
export function backfillReport(r, { commits, dryRun = false, refreshFirstSeen = false, limit = Infinity } = {}) {
  const facts = [`${r.processed} of ${commits} commits processed`, `${r.skipped.length} skipped`];
  if (refreshFirstSeen) facts.push(plural(r.refreshed.length, "first-seen correction"));
  const added = flagW01(r.added, r.w01 || new Set());
  let out = formatReport({ heading: "Model History: news backfill", facts, added, candidates: r.candidates, dryRun, limit, more: MORE });
  if (r.refreshed.length) out += "\n#### First seen corrected\n\n" + capped(r.refreshed, refreshedLine, limit, "corrections", MORE).join("\n") + "\n";
  if (r.skipped.length) out += "\n#### Skipped commits\n\n"
    + capped(r.skipped, s => `- \`${md(String(s.commit).slice(0, 7))}\`: ${md(s.reason)}`, limit, "skipped commits", MORE).join("\n") + "\n";
  return out;
}

export function runBackfill({ dataDir, repo = REPO, since, limit, dryRun = false, refreshFirstSeen = false, log = () => {} } = {}) {
  dataDir = resolve(dataDir);
  // A shallow clone has only the newest commits, and its oldest one looks as if it added
  // every file: the first sightings would be too late, and without --refresh-first-seen
  // they could never be corrected. Fail instead of writing them.
  if (git(["rev-parse", "--is-shallow-repository"], repo).trim() === "true") throw new Error("shallow clone: run git fetch --unshallow first");
  const ctx = prepare(loadCurated(dataDir));
  const statePath = join(dataDir, STATE_FILE), state = readState(statePath);
  const commits = filterCommits(listCommits(repo), { since, limit });
  log(`backfill: ${commits.length} commits of ${FEED} to read`);
  const r = processSnapshots(snapshotsFrom(repo, commits, log), ctx, state.links, { refreshFirstSeen });
  const text = serializeState(r.links);
  const changed = state.raw === null || state.raw.replace(/\r\n/g, "\n") !== text;
  const written = !dryRun && writeIfChanged(statePath, state.raw, text);
  const opts = { commits: commits.length, dryRun, refreshFirstSeen };
  return { ...r, commits: commits.length, changed, written, report: backfillReport(r, opts), summary: backfillReport(r, { ...opts, limit: SUMMARY_LIMIT }) };
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ["dry-run", "refresh-first-seen"], options: ["since", "limit", "data"] });
    const r = runBackfill({
      dataDir: args.data || join(REPO, "model-history"),
      since: args.since, limit: args.limit, dryRun: !!args["dry-run"], refreshFirstSeen: !!args["refresh-first-seen"],
      log: m => console.error(m)
    });
    console.log(`backfill-news: ${r.added.length} new, ${r.refreshed.length} first-seen corrected, ${r.links.length} total, ${r.candidates.length} candidates; ${r.written ? "state written" : r.changed ? "state not written (dry run)" : "state unchanged"}`);
    emitReport(r.report, r.summary);
  } catch (e) {
    console.error("backfill-news: " + e.message);
    process.exitCode = 1;
  }
}
