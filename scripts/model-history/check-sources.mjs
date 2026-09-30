/* Model History: source-health checker (spec §20).

   Observes whether the original URLs and the archive copies (archiveUrl) of the curated
   sources still work, keeps a machine state with hysteresis per source in
   state/source-status.json, proposes Wayback captures and prints a report (stdout and the
   GitHub job summary). Curated files (records/, sources/, organizations.json,
   families.json) are only read. The state file is the only file written, and nothing is
   deleted: state entries whose source disappeared are kept and reported.

   Run:  node scripts/model-history/check-sources.mjs [--data <dir>] [--now <ISO>]
           [--limit <n>] [--dry-run] [--no-archive-lookup] [--no-respect-robots] [--budget-min <n>]
   --dry-run still makes the requests but writes nothing. Tests call run() with a fake
   fetch, sleep and clock, so they never touch the network.

   Additions to and deviations from §20 (to be recorded in the spec):
   - §20.5 fields: every entry also has "url" (the URL the observations belong to),
     "firstCheckedAt" (for "unverifiable" without any decisive result) and "archiveCheck"
     (the same bookkeeping for archiveUrl, whose state is published as archiveState).
   - A url or archiveUrl replaced by the curator starts that URL's bookkeeping over (state
     unknown, due at once); an old streak or fingerprint describes another page.
   - §20.2 "lopende fout": only a running streak of decisive failures (consecutiveFailures
     > 0) is rechecked after 3 days; blocked, error or moved without a streak waits 6 days.
   - Intervals (6 and 3 days, the 9-day span, 90 days) are elapsed time minus a 2-hour
     tolerance for cron drift.
   - Only public hosts are requested (also redirect targets): otherwise "error".
   - robots.txt is respected by default (open decision O5); a disallow, and a robots.txt
     that cannot be read, is "blocked". Uncovered answers (other 4xx, a 3xx without
     Location, more than 5 redirects, an empty 2xx) are "error".
   - archive.org: after a 403 or 429 no further lookups in the run (circuit breaker); at
     most LOOKUP_LIMIT lookups per run.
   - A run stops starting checks and lookups after --budget-min (default 45) minutes and
     writes what it completed, so the 60-minute job limit never discards a whole run.
   - The first machine verdict is dated when it is made (no backdating to a curator
     verdict; see "Hysteresis"). */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isIP } from "node:net";
import { SCHEMA_VERSION, loadDataset, parseDate, interval, normalize, archiveUrlAllowed, registrableDomain, toInstant } from "./lib.mjs";

/* ---------- Settings (spec §20.2) ---------- */
export const UA = "Mozilla/5.0 (compatible; AIRadarBot/1.0)";   // same family as the feed build
const ROBOTS_TOKEN = "airadarbot";                               // product token looked up in robots.txt
export const ACCEPT = "text/html,application/pdf;q=0.9,*/*;q=0.8";
export const MAX_BYTES = 256 * 1024;       // read limit per page; beyond it the fingerprint is "truncated"
const ROBOTS_MAX_BYTES = 512 * 1024;       // RFC 9309 asks parsers to read at least 500 KiB
const API_MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
export const HOST_DELAY_MS = 5000;         // per host: sequential, at least this long between requests
export const ARCHIVE_DELAY_MS = 2000;      // archive.org APIs: at most one request per 2 s
export const RUN_LIMIT = 300;              // sources per run
export const LOOKUP_LIMIT = 100;           // archive lookups per run (up to 2 archive.org requests each)
/* Wall-clock budget per run. The job is killed at 60 minutes (source-health.yml) and the
   state is written once, at the end: without a budget a slow run (all archive copies share
   one archive.org lane at 5 s, the lookups follow at 2 s, latency on top) would lose every
   observation, and the same set would be due again the next day. */
export const BUDGET_MS = 45 * 60000;
const CONCURRENCY = 4;                     // hosts checked in parallel; each host stays sequential
const HEALTHY_DAYS = 6, FAILING_DAYS = 3;  // recheck intervals
const FAIL_COUNT = 3, FAIL_SPAN_DAYS = 9;  // hysteresis (§20.4), after InternetArchiveBot
const UNVERIFIABLE_DAYS = 90;
const SIZE_RATIO = 0.25, SIZE_MIN_DROP = 1024;   // "content much smaller than the first observation"
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_DATA = join(REPO_ROOT, "model-history");

export const RESULTS = ["ok", "moved", "blocked", "error", "gone", "soft-404"];
const DECISIVE = new Set(["ok", "gone", "soft-404"]);
const FAILURE = new Set(["gone", "soft-404"]);

/* ---------- Time ----------
   Elapsed time with a small tolerance: the daily cron drifts by minutes (GitHub also delays
   scheduled runs), and a check at 03:40 six days after one at 03:41 must still count as six
   days, or the 9-day span of the hysteresis would often need a fourth run. Calendar days
   were too lenient: 23:59 to 00:01 counted as a day, so a late manual run could make a
   source unavailable almost a day early. */
const DAY = 86400000;
const DRIFT_MS = 2 * 3600000;
const validIso = v => typeof v === "string" && !Number.isNaN(Date.parse(v));
export const atLeastDays = (a, b, n) => Date.parse(b) - Date.parse(a) >= n * DAY - DRIFT_MS;
export function isoSeconds(v) {
  const t = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`invalid time: ${v}`);
  return new Date(Math.floor(t / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/* ---------- State entries (§20.5) ----------
   A tracker holds the observations of one URL. The original's tracker is the entry itself
   (the fields of §20.5). The archive copy follows the same rules separately (§20.4), so it
   needs the same bookkeeping: that lives in "archiveCheck", and its state is published as
   archiveState (active · gone · unknown, null without an archiveUrl). "firstCheckedAt" is
   needed for "unverifiable" when a URL never had a decisive result. "url" is the URL the
   observations belong to: when the curator replaces a source's url, the old streak, state
   and fingerprint describe another page and must not carry over. All three are additions
   to the field list of §20.5 (additive, §9.3). */
const TRACKER_FIELDS = ["url", "state", "stateSince", "lastCheckedAt", "lastResult", "httpStatus", "finalUrl", "lastDefinitiveAt",
  "consecutiveFailures", "firstFailureAt", "lastOkAt", "firstCheckedAt", "firstFingerprint", "lastFingerprint"];
const ARCHIVE_FIELDS = TRACKER_FIELDS.filter(k => k !== "state");
const TO_ARCHIVE_STATE = { active: "active", unavailable: "gone", unknown: "unknown" };
const FROM_ARCHIVE_STATE = { active: "active", gone: "unavailable", unknown: "unknown" };
export const freshTracker = () => ({ url: null, state: "unknown", stateSince: null, lastCheckedAt: null, lastResult: null, httpStatus: null,
  finalUrl: null, lastDefinitiveAt: null, consecutiveFailures: 0, firstFailureAt: null, lastOkAt: null, firstCheckedAt: null,
  firstFingerprint: null, lastFingerprint: null });
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));

/* reset: the entry observed another url than the source has now, so the original starts
   over (state unknown, never checked: due at once, and effAvail falls back to the
   curator). An entry written before "url" existed adopts the current url as it is. */
export function trackersFor(src, entry) {
  const known = pick(entry, TRACKER_FIELDS);
  const reset = typeof known.url === "string" && known.url !== src.url;
  const orig = reset ? { ...freshTracker(), url: src.url } : { ...freshTracker(), ...known, url: src.url };
  let archive = null;
  if (src.archiveUrl) {
    const ac = entry && entry.archiveCheck;
    const state = FROM_ARCHIVE_STATE[entry && entry.archiveState] || "unknown";
    if (ac && ac.url === src.archiveUrl) archive = { ...freshTracker(), ...pick(ac, ARCHIVE_FIELDS), state, url: src.archiveUrl };
    else if (!ac && entry && entry.archiveState) archive = { ...freshTracker(), state, url: src.archiveUrl };   // entry without bookkeeping
    else archive = { ...freshTracker(), url: src.archiveUrl };                                                 // new or replaced archiveUrl
  }
  return { orig, archive, reset };
}
const archivePart = a => (a ? { ...pick({ ...freshTracker(), ...a }, ARCHIVE_FIELDS), url: a.url } : null);
export function joinEntry(orig, archive, suggestion) {
  return { ...pick({ ...freshTracker(), ...orig }, TRACKER_FIELDS), archiveState: archive ? TO_ARCHIVE_STATE[archive.state] : null,
    archiveSuggestion: suggestion || null, archiveCheck: archivePart(archive) };
}
// An entry that was not checked this run only follows curator edits of url and archiveUrl.
function reconcile(raw, src, orig, archive) {
  let e = { ...raw };
  if (raw.url !== src.url) e = typeof raw.url === "string" ? { ...e, ...pick(orig, TRACKER_FIELDS) } : { ...e, url: src.url };
  if (!src.archiveUrl) {
    if (e.archiveState != null) e.archiveState = null;
    if (e.archiveCheck) e.archiveCheck = null;
  } else if (e.archiveCheck && e.archiveCheck.url !== src.archiveUrl) {
    e.archiveState = "unknown"; e.archiveCheck = archivePart(archive);
  }
  if (e.archiveSuggestion && !keepSuggestion(e.archiveSuggestion, src, e.archiveState)) e.archiveSuggestion = null;
  return e;
}
// §20.6: a suggestion is wanted while there is no usable archive copy, and it must be a
// capture of the current url (the curator may have replaced it since).
const needsSuggestion = (src, archiveState) => !src.archiveUrl || archiveState === "gone";
const keepSuggestion = (sug, src, archiveState) => needsSuggestion(src, archiveState) && !!sug && sug.url === waybackUrl(sug.timestamp, src.url);

/* ---------- Hysteresis (§20.4) ----------
   unavailable only after FAIL_COUNT decisive failures in a row spanning FAIL_SPAN_DAYS;
   one ok makes it active; blocked, error and moved change nothing and do not break the
   streak. stateSince moves only on a transition, which is what §17.3 compares with the
   curator's lastCheckedAt. The first verdict (unknown → active or unavailable) is a
   transition too (§17.4) and is dated when it is made, as §20.5 defines stateSince. So a
   first ok on a later day than the curator's check outranks a curator verdict "archived":
   the report lists it ("machine state differs from the curator"), and the curator keeps the
   verdict by checking again and refreshing lastCheckedAt (§17.3). A check on the curator's
   own day does not outrank it (a date-only lastCheckedAt means the end of that day), which
   is the AC-12 case. An earlier version backdated the first verdict to the curator's check;
   that ignored the age of the curator verdict and is dropped (to confirm with Benjamin). */
export function applyObservation(prev, obs, now) {
  const t = { ...freshTracker(), ...prev };
  t.firstCheckedAt = t.firstCheckedAt || t.lastCheckedAt || now;
  t.lastCheckedAt = now;
  t.lastResult = obs.result;
  t.httpStatus = obs.httpStatus ?? null;
  t.finalUrl = obs.finalUrl ?? null;
  if (obs.fingerprint) t.lastFingerprint = obs.fingerprint;
  let next = t.state;
  if (DECISIVE.has(obs.result)) {
    t.lastDefinitiveAt = now;
    if (obs.result === "ok") {
      t.consecutiveFailures = 0; t.firstFailureAt = null; t.lastOkAt = now;
      if (!t.firstFingerprint && obs.fingerprint) t.firstFingerprint = obs.fingerprint;
      next = "active";
    } else {
      t.consecutiveFailures = (t.consecutiveFailures || 0) + 1;
      t.firstFailureAt = t.firstFailureAt || now;
      if (t.consecutiveFailures >= FAIL_COUNT && atLeastDays(t.firstFailureAt, now, FAIL_SPAN_DAYS)) next = "unavailable";
    }
  }
  if (next !== t.state) { t.stateSince = now; t.state = next; }
  return t;
}
// ≥ 90 days with only non-decisive results (reported, the state does not change).
export function isUnverifiable(t, now) {
  if (!t || !validIso(t.lastCheckedAt) || DECISIVE.has(t.lastResult)) return false;
  const since = t.lastDefinitiveAt || t.firstCheckedAt || t.lastCheckedAt;
  return validIso(since) && atLeastDays(since, now, UNVERIFIABLE_DAYS);
}

/* ---------- Who is due (§20.2) ----------
   A URL with a running streak of decisive failures ("lopende reeks", §20.5) after 3 days,
   every other URL after 6; never-checked URLs first, then the oldest lastCheckedAt; at most
   `limit` sources. A blocked or error result without a streak waits the full 6 days: the
   quicker retry only serves the hysteresis, and it would double the load on exactly the
   hosts that push back. A source is due when its original or its archive copy is due, and
   only the due URLs are checked. */
export function isDue(t, now) {
  if (!t || !validIso(t.lastCheckedAt)) return true;
  const failing = (t.consecutiveFailures || 0) > 0;
  return atLeastDays(t.lastCheckedAt, now, failing ? FAILING_DAYS : HEALTHY_DAYS);
}
export function selectDue(items, now, limit = RUN_LIMIT) {
  const due = [];
  for (const it of items) {
    const targets = [];
    if (isDue(it.orig, now)) targets.push("original");
    if (it.archive && isDue(it.archive, now)) targets.push("archive");
    if (!targets.length) continue;
    const lasts = targets.map(k => (k === "original" ? it.orig : it.archive).lastCheckedAt);
    const never = lasts.some(x => !validIso(x));
    due.push({ item: it, targets, never, oldest: never ? 0 : Math.min(...lasts.map(Date.parse)) });
  }
  due.sort((a, b) => (a.never !== b.never ? (a.never ? -1 : 1) : 0) || a.oldest - b.oldest || (a.item.src.id < b.item.src.id ? -1 : a.item.src.id > b.item.src.id ? 1 : 0));
  return { selected: due.slice(0, limit), deferred: due.slice(limit) };
}

/* ---------- URLs ---------- */
const WAYBACK = /^https?:\/\/web\.archive\.org\/web\/(\d{1,14})(?:[a-z]{2}_)?\/(.+)$/i;
/* Site root, also a bare locale root (/en/, /en-us, /zh-hans/) or index file: the classic
   soft-404 target. Only real language codes count as a locale, so a redirect to /ai/, /ml
   or /go is an ordinary path (moved), not a decisive soft-404. */
const LOCALES = new Set("ar bg bn ca cs da de el en es et eu fa fi fr ga gl he hi hr hu id is it ja ko lt lv ms mt nb nl nn no pl pt ro ru sk sl sr sv th tl tr uk ur vi zh".split(" "));
const ROOT_PATH = /^\/(?:([a-z]{2})(?:[-_](?:[a-z]{2}|hans|hant|latn|cyrl|\d{3}))?\/?)?(?:index\.(?:html?|php))?$/i;
const NOT_FOUND_PATH = /(?:^|\/)(?:404|not[-_]?found|page[-_]?not[-_]?found|error[-_]?404)(?:\.[a-z]+)?\/?$/i;
export function isRoot(u) {
  try {
    const x = new URL(u), m = ROOT_PATH.exec(x.pathname);
    return !!m && !x.search && (!m[1] || LOCALES.has(m[1].toLowerCase()));
  } catch (e) { return false; }
}
// "The root of the site" means the same site: a product page that moved to its own domain
// (ai.example.com/orbit/ → orbit.example/) is a move, not a soft-404.
export const sameSite = (a, b) => { const x = registrableDomain(a); return !!x && x === registrableDomain(b); };

/* Only public hosts are requested. Source URLs are reviewed, but redirect targets are chosen
   by remote servers, and the page title of whatever answers is committed to the public repo.
   Hostnames that resolve to private addresses (DNS rebinding) are not caught here; that
   would need a custom resolver in fetch. */
function privateV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privateV6(ip) {
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d); the URL parser writes it as two hex groups.
  const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(s);
  if (m) {
    if (m[1]) return privateV4(m[1]);
    const hi = parseInt(m[2], 16), lo = parseInt(m[3], 16);
    return privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."));
  }
  return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);   // ULA, link-local, multicast
}
export function publicHost(u) {
  let h;
  try { h = new URL(u).hostname.toLowerCase(); } catch (e) { return false; }
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const v = isIP(h);
  if (v === 4) return !privateV4(h);
  if (v === 6) return !privateV6(h);
  const name = h.replace(/\.$/, "");
  return name.includes(".") && !/(?:^|\.)(?:localhost|internal|local|localdomain|home\.arpa)$/.test(name);
}
function docKey(u) {
  try {
    const x = new URL(u);
    let p = x.pathname; try { p = decodeURIComponent(p); } catch (e) { /* keep encoded */ }
    return `${x.hostname.toLowerCase().replace(/^www\./, "")}:${x.port}${p.toLowerCase().replace(/\/+$/, "")}${x.search}`;
  } catch (e) { return u; }
}
/* Same document despite the redirect: http→https, www, trailing slash, case (§20.3). For a
   Wayback URL a jump to the nearest capture timestamp is the same document too: Wayback
   answers a timestamp that is off by seconds (or a placeholder like ...000000) with a 302
   to the real capture. A jump of more than a month is another version: "moved". */
const WAYBACK_TOLERANCE_DAYS = 31;
export function sameDocument(a, b) {
  const wa = WAYBACK.exec(a), wb = WAYBACK.exec(b);
  const emb = s => (/^https?:\/\//i.test(s) ? s : "http://" + s);
  if (wa && wb) {
    if (docKey(emb(wa[2])) !== docKey(emb(wb[2]))) return false;
    return wa[1].length < 8 || wb[1].length < 8 || Math.abs(tsDay(wa[1]) - tsDay(wb[1])) <= WAYBACK_TOLERANCE_DAYS;
  }
  return docKey(a) === docKey(b);
}
// Pacing key: all archive.org hosts share one budget.
export function paceKey(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "archive.org" || h.endsWith(".archive.org") ? "archive.org" : h;
  } catch (e) { return "invalid"; }
}

/* ---------- HTML fingerprint ----------
   Only a title and a size are kept (§20.5): no page content is stored. The heading and
   canonical are read for the soft-404 signals and then dropped. */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’",
  lsquo: "‘", ldquo: "“", rdquo: "”", middot: "·", copy: "©", reg: "®", trade: "™" };
const decodeEntities = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") {
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  }
  return ENT[e.toLowerCase()] ?? m;
});
const cleanText = s => {
  if (s == null) return null;
  const t = decodeEntities(String(s).replace(/<[^>]*>/g, " ")).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  return t || null;
};
/* The body comes from a remote server, so every scan is linear: the first opening tag, then
   one forward search for its end and for the closing tag. A lazy regex over the whole body
   rescanned the rest of it from every unclosed <title> (seconds per 256 KB page). Only the
   first TEXT_MAX raw characters of an element are cleaned (the result keeps 300 anyway). */
const TEXT_MAX = 2000, LINK_TAG_MAX = 2048;
function elementText(text, name) {
  const open = new RegExp(`<${name}\\b`, "i").exec(text);
  if (!open) return null;
  const gt = text.indexOf(">", open.index);
  if (gt < 0) return null;
  const close = new RegExp(`</${name}\\s*>`, "gi");
  close.lastIndex = gt + 1;
  const end = close.exec(text);
  return end ? cleanText(text.slice(gt + 1, Math.min(end.index, gt + 1 + TEXT_MAX))) : null;
}
export function parseHtml(text) {
  const title = elementText(text, "title"), heading = elementText(text, "h1");
  let canonical = null;
  const linkRe = /<link\b/gi;
  for (let m; !canonical && (m = linkRe.exec(text));) {
    const end = text.indexOf(">", m.index);
    if (end < 0) break;              // no complete tag after this point
    linkRe.lastIndex = end + 1;      // tags do not overlap, so every character is scanned once
    if (end - m.index > LINK_TAG_MAX) continue;
    const tag = text.slice(m.index, end + 1);
    if (!/\brel\s*=\s*["']?[^"'>]*\bcanonical\b/i.test(tag)) continue;
    const h = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    if (h) canonical = decodeEntities(h[1] ?? h[2] ?? h[3]).trim();
  }
  return { title, heading, canonical };
}

/* ---------- Classification (§20.3) ----------
   First matching row wins. Everything the table does not cover (other 4xx, a 3xx without
   Location, too many redirects, an empty 2xx) is "error": non-decisive, so an unforeseen
   answer can never make a source unavailable. */
const CHALLENGE_HEADERS = [["cf-mitigated", /challenge/i], ["x-vercel-mitigated", /challenge/i], ["x-amzn-waf-action", /challenge|captcha/i]];
const CHALLENGE_TITLE = /^(?:just a moment\b|attention required!? \| cloudflare|checking your browser|(?:vercel )?security checkpoint|ddos-guard|pardon our interruption|human verification|robot check|are you a (?:robot|human)|verify(?:ing)? (?:that )?you are (?:a )?human)/i;
/* Soft-404 wording. A title counts only when one of its parts (split at " | ", " - ", " – ",
   ": " and the like, which separate the site name) is nothing but a typical error title, so
   a real document called "HTTP 404 explained" is not a soft-404 on its first check (it
   would never get a baseline, since firstFingerprint is only taken from an ok). A heading
   may be a sentence ("Sorry, we couldn't find that page"), so there the phrases count
   anywhere, but a bare "404" only as the whole heading. */
const ERROR_PART = /^(?:(?:oops|whoops|sorry|uh oh)[\s,]*)?(?:(?:http\s+)?(?:error\s+)?(?:404|410)(?:\s+error)?(?:\s*[-:–—]?\s*(?:(?:the\s+)?page\s+)?(?:not\s+found|gone))?|(?:error\s*[-:]?\s*)?(?:(?:the\s+)?(?:page|file|document|content|resource)\s+)?not\s+found|(?:(?:this|the|that)\s+)?page\s+(?:does\s+not|doesn['’]t|no\s+longer)\s+exists?|(?:(?:this|the|that)\s+)?page\s+(?:can(?:not|['’]t)|could\s+not|couldn['’]t)\s+be\s+found|(?:we\s+)?(?:can(?:not|['’]t)|could\s+not|couldn['’]t)\s+find\s+(?:that|this|the)\s+page)$/i;
const NOT_FOUND_PHRASE = /not found|page (?:does not|doesn['’]t|no longer) exists?|(?:can(?:not|['’]t)|could not|couldn['’]t) (?:be found|find (?:that|this|the) page)/i;
const titleParts = t => t.split(/\s*[|·–—]\s*|\s+[-:]\s+|:\s+/).map(p => p.replace(/[!.?…()[\]"“”]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
export const titleSaysNotFound = t => !!t && titleParts(t).some(p => ERROR_PART.test(p));
export function headingSaysNotFound(h, title) {
  if (!h) return false;
  // The same words as the title (or one of its parts) were already judged by the title rule.
  const n = normalize(h);
  if (title && (n === normalize(title) || titleParts(title).some(p => normalize(p) === n))) return false;
  const parts = titleParts(h);
  return NOT_FOUND_PHRASE.test(h) || (parts.length === 1 && ERROR_PART.test(parts[0]));
}
const PARKING_HOST = /(?:^|\.)(?:sedoparking\.com|parkingcrew\.net|bodis\.com|parklogic\.com|above\.com|afternic\.com|dan\.com|hugedomains\.com|undeveloped\.com|sedo\.com)$/i;
const PARKED_TITLE = /\b(?:domain (?:is )?(?:for sale|parked)|this domain (?:may be|is) for sale|buy this domain|parked (?:free|domain))\b/i;

export function classifyError(e) {
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return { result: "error", detail: "timeout" };
  const c = e && e.cause;
  const code = (c && (c.code || (c.errors && c.errors[0] && c.errors[0].code))) || (e && e.code) || null;
  // NXDOMAIN; a temporary resolver failure is EAI_AGAIN and stays non-decisive.
  if (code === "ENOTFOUND") return { result: "gone", detail: "DNS NXDOMAIN" };
  if (code && /CERT|TLS|SSL/i.test(code)) return { result: "error", detail: `TLS error (${code})` };
  return { result: "error", detail: code ? `network error (${code})` : "network error" };
}
// The header value is not echoed: it comes from the remote server and the detail ends up
// in the public job summary.
function challengeSignal(headers, title) {
  for (const [h, re] of CHALLENGE_HEADERS) { const v = headers && headers.get(h); if (v && re.test(v)) return `challenge page (${h})`; }
  return title && CHALLENGE_TITLE.test(title) ? "challenge page (title)" : null;
}
function soft404Signal(o, baseline, withSize) {
  // A title that is unchanged since the first ok observation is the document itself, even
  // if it happens to contain "404" or "not found".
  const titleChanged = !baseline || !baseline.title || normalize(baseline.title) !== normalize(o.title || "");
  if (titleChanged) {
    if (titleSaysNotFound(o.title)) return "title says not found";
    if (headingSaysNotFound(o.heading, o.title)) return "heading says not found";
    if (o.canonical && isRoot(o.canonical) && !isRoot(o.finalUrl) && sameSite(o.canonical, o.finalUrl)) return "canonical points to the site root";
  }
  if (withSize && baseline && Number.isFinite(baseline.bytes) && !baseline.truncated && !o.truncated &&
      o.bytes < baseline.bytes * SIZE_RATIO && baseline.bytes - o.bytes >= SIZE_MIN_DROP)
    return `content much smaller than the first observation (${o.bytes} vs ${baseline.bytes} bytes)`;
  return null;
}
/* o: { status, headers, requestedUrl, finalUrl, title, heading, canonical, bytes, truncated }
   or { error } or { robots: "<reason>" }. baseline: the tracker's firstFingerprint. */
export function classify(o, baseline = null) {
  if (o.robots) return { result: "blocked", detail: o.robots };
  if (o.error) return classifyError(o.error);
  const s = o.status;
  if (s === 401 || s === 403 || s === 429) return { result: "blocked", detail: `HTTP ${s}` };
  const ch = challengeSignal(o.headers, o.title);
  if (ch) return { result: "blocked", detail: ch };
  if (s >= 500) return { result: "error", detail: `HTTP ${s}` };
  if (s === 404 || s === 410) return { result: "gone", detail: `HTTP ${s}` };
  let host = ""; try { host = new URL(o.finalUrl).hostname; } catch (e) { /* keep empty */ }
  if (PARKING_HOST.test(host) || (o.title && PARKED_TITLE.test(o.title))) return { result: "gone", detail: "parked domain" };
  if (!(s >= 200 && s <= 299)) return { result: "error", detail: `HTTP ${s} (not covered by the classification)` };
  const redirected = o.finalUrl !== o.requestedUrl;
  const sameDoc = !redirected || sameDocument(o.requestedUrl, o.finalUrl);
  if (redirected && !sameDoc) {
    if (isRoot(o.finalUrl) && !isRoot(o.requestedUrl) && sameSite(o.requestedUrl, o.finalUrl)) return { result: "soft-404", detail: "redirect to the site root" };
    let p = ""; try { p = new URL(o.finalUrl).pathname; } catch (e) { /* keep empty */ }
    if (NOT_FOUND_PATH.test(p)) return { result: "soft-404", detail: "redirect to a not-found page" };
  }
  // The size rule compares with the first observation of the same document, so it does not
  // apply after a redirect to another path.
  const sig = soft404Signal(o, baseline, sameDoc);
  if (sig) return { result: "soft-404", detail: redirected ? `redirect target: ${sig}` : sig };
  if (redirected && !sameDoc) return { result: "moved", detail: "redirect to another path" };
  if (!o.bytes) return { result: "error", detail: "empty response" };
  return { result: "ok", detail: redirected ? "redirect to the same document" : `HTTP ${s}` };
}

/* ---------- robots.txt (RFC 9309; open decision O5, default on) ---------- */
export function parseRobots(text) {
  const groups = [];
  let cur = null, inAgents = false;
  for (const raw of String(text).split(/\r\n|\r|\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/#.*$/, ""));
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "user-agent") {
      if (!inAgents) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(m[2].toLowerCase()); inAgents = true;
    } else if (key === "allow" || key === "disallow") {
      if (cur) cur.rules.push({ allow: key === "allow", path: m[2] });
      inAgents = false;
    }
    // Other records (Sitemap, Crawl-delay, ...) do not end a run of user-agent lines, as in
    // Google's parser: a Sitemap line between two User-agent lines keeps them one group.
  }
  return groups;
}
/* Rules come from a remote file, so matching is a plain wildcard scan (O(pattern × path)),
   not a regex: a rule like /*a*a*a*...*b backtracks exponentially in a regex engine.
   Percent-escapes are compared case-insensitively (%3c = %3C), and non-ASCII in a rule is
   percent-encoded per code point (the u flag): per UTF-16 unit, an astral character such as
   an emoji splits into lone surrogates and encodeURIComponent throws. A rule that still
   cannot be encoded, or is absurdly long, is ignored. */
const RULE_MAX = 2048;
const upPct = s => s.replace(/%[0-9a-f]{2}/gi, m => m.toUpperCase());
function wildcardMatch(p, t) {
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < t.length) {
    if (i < p.length && p[i] === "*") { star = i++; mark = j; }
    else if (i < p.length && p[i] === t[j]) { i++; j++; }
    else if (star >= 0) { i = star + 1; j = ++mark; }
    else return false;
  }
  while (i < p.length && p[i] === "*") i++;
  return i === p.length;
}
function robotsMatch(pattern, target) {
  if (pattern.length > RULE_MAX) return false;
  let p;
  try { p = upPct(pattern.replace(/[^\x00-\x7f]/gu, c => encodeURIComponent(c))); } catch (e) { return false; }
  // A rule matches a prefix of the path unless it ends in $ (then the whole path).
  return p.endsWith("$") ? wildcardMatch(p.slice(0, -1), target) : wildcardMatch(p + "*", target);
}
// Own group(s) if present, else "*"; longest matching rule wins, allow wins a tie.
export function robotsAllowed(groups, url) {
  const u = new URL(url);
  if (u.pathname === "/robots.txt") return true;
  const mine = groups.filter(g => g.agents.some(a => a.split("/")[0].trim() === ROBOTS_TOKEN));
  const rules = (mine.length ? mine : groups.filter(g => g.agents.includes("*"))).flatMap(g => g.rules);
  const target = upPct(u.pathname + u.search);
  let best = null;
  for (const r of rules) {
    if (!r.path || !robotsMatch(r.path, target)) continue;
    if (!best || r.path.length > best.len || (r.path.length === best.len && r.allow && !best.allow)) best = { len: r.path.length, allow: r.allow };
  }
  return !best || best.allow;
}

/* ---------- Requests ---------- */
// One promise chain per pacing key keeps a host sequential; the gap runs from the end of the
// previous request to that host.
export function makePacer(sleep, clock) {
  const last = new Map(), chains = new Map();
  return (key, gap, fn) => {
    const go = async () => {
      if (last.has(key)) { const wait = last.get(key) + gap - clock(); if (wait > 0) await sleep(wait); }
      try { return await fn(); } finally { last.set(key, clock()); }
    };
    const p = (chains.get(key) || Promise.resolve()).then(go, go);
    chains.set(key, p.catch(() => {}));
    return p;
  };
}
async function readBody(res, max) {
  if (!res.body) return { buf: Buffer.alloc(0), bytes: 0, truncated: false };
  const reader = res.body.getReader(), parts = [];
  let n = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - n;
    if (value.length > room) { parts.push(value.subarray(0, room)); n = max; truncated = true; break; }
    parts.push(value); n += value.length;
  }
  if (truncated) reader.cancel().catch(() => {});
  return { buf: Buffer.concat(parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength))), bytes: n, truncated };
}
// GET (never HEAD), redirects handled by the caller so every hop is paced and the final URL is known.
function request(url, d, { max = MAX_BYTES, accept = ACCEPT, gap = d.hostDelayMs, text = false } = {}) {
  return d.pace(paceKey(url), gap, async () => {
    const res = await d.fetchImpl(url, { method: "GET", redirect: "manual", headers: { "user-agent": UA, accept }, signal: AbortSignal.timeout(d.timeoutMs) });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location) { try { await (res.body && res.body.cancel()); } catch (e) { /* ignore */ } return { status: res.status, headers: res.headers, location }; }
    const b = await readBody(res, max);
    const ct = res.headers.get("content-type") || "";
    const head = b.buf.subarray(0, 64).toString("latin1");
    const isHtml = /html|xml/i.test(ct) || (!ct && /^\s*</.test(head));
    return { status: res.status, headers: res.headers, location: null, bytes: b.bytes, truncated: b.truncated, isHtml,
      text: text || isHtml ? new TextDecoder("utf-8").decode(b.buf) : "" };
  });
}
async function fetchChain(url, d, opts = {}) {
  const chain = [url];
  for (let hop = 0; ; hop++) {
    const cur = chain[chain.length - 1];
    // Before robots.txt too, so nothing at all is requested from a non-public host.
    if (!publicHost(cur)) return { chain, fail: "non-public address", status: null };
    if (opts.beforeHop) {
      // beforeHop returns a reason to stop, or null. If it fails unexpectedly (a robots.txt
      // nobody foresaw), the URL is treated as disallowed: blocked, so non-decisive, and the
      // run goes on.
      let stop;
      try { stop = await opts.beforeHop(cur); } catch (e) { stop = "robots.txt unreadable (treated as disallow)"; }
      if (stop) return { chain, stop };
    }
    let r;
    try { r = await request(cur, d, opts); } catch (error) { return { chain, error }; }
    if (!r.location) return { chain, response: r };
    if (hop >= MAX_REDIRECTS) return { chain, fail: `more than ${MAX_REDIRECTS} redirects`, status: r.status };
    let next;
    try { next = new URL(r.location, cur).href; } catch (e) { return { chain, fail: "invalid redirect location", status: r.status }; }
    if (!/^https?:$/.test(new URL(next).protocol)) return { chain, fail: "redirect to an unsupported scheme", status: r.status };
    if (chain.includes(next)) return { chain, fail: "redirect loop", status: r.status };
    chain.push(next);
  }
}
/* robots.txt per origin, fetched once per run. 4xx means no restrictions; 429, 5xx and
   network failures count as "disallow everything" (RFC 9309), which makes the check blocked,
   so non-decisive. An NXDOMAIN host is let through so the page check itself says gone. */
function makeRobots(d) {
  const cache = new Map();
  const load = async origin => {
    const r = await fetchChain(origin + "/robots.txt", d, { max: ROBOTS_MAX_BYTES, accept: "text/plain,*/*;q=0.8", text: true });
    if (r.error) return classifyError(r.error).result === "gone" ? { all: true } : { all: false, why: "robots.txt unreachable (treated as disallow)" };
    if (!r.response) return { all: true };
    const s = r.response.status;
    if (s >= 200 && s <= 299) return { groups: parseRobots(r.response.text) };
    if (s === 429 || s >= 500) return { all: false, why: `robots.txt HTTP ${s} (treated as disallow)` };
    return { all: true };
  };
  return async url => {
    const origin = new URL(url).origin;
    if (!cache.has(origin)) cache.set(origin, load(origin));
    const r = await cache.get(origin);
    if (r.groups) return robotsAllowed(r.groups, url) ? { allowed: true } : { allowed: false, why: "robots.txt disallows this URL" };
    return r.all ? { allowed: true } : { allowed: false, why: r.why };
  };
}
// One observation of one URL: { result, detail, httpStatus, finalUrl, fingerprint }.
export async function observe(url, d, baseline = null) {
  let start;
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw new Error("scheme"); start = u.href; }
  catch (e) { return { result: "error", detail: "invalid or unsupported URL", httpStatus: null, finalUrl: null, fingerprint: null }; }
  const beforeHop = d.respectRobots ? async u => { const r = await d.robots(u); return r.allowed ? null : r.why || "robots.txt disallows this URL"; } : null;
  const out = await fetchChain(start, d, { beforeHop });
  const last = out.chain[out.chain.length - 1];
  const finalUrl = last !== start ? last : null;
  if (out.stop) return { ...classify({ robots: out.stop }), httpStatus: null, finalUrl, fingerprint: null };
  if (out.error) return { ...classify({ error: out.error }), httpStatus: null, finalUrl, fingerprint: null };
  if (out.fail) return { result: "error", detail: out.fail, httpStatus: out.status, finalUrl, fingerprint: null };
  const r = out.response;
  const html = r.isHtml ? parseHtml(r.text) : { title: null, heading: null, canonical: null };
  let canonical = null;
  if (html.canonical) { try { canonical = new URL(html.canonical, last).href; } catch (e) { /* ignore */ } }
  const c = classify({ status: r.status, headers: r.headers, requestedUrl: start, finalUrl: last, title: html.title, heading: html.heading,
    canonical, bytes: r.bytes, truncated: r.truncated }, baseline);
  return { ...c, httpStatus: r.status, finalUrl, fingerprint: { title: html.title, bytes: r.bytes, truncated: r.truncated } };
}

/* ---------- Archive suggestions (§20.6) ----------
   Primary: the Wayback CDX API (captures with status 200 from publishedAt on); fallback: the
   Availability API. The suggestion embeds the source URL, not the CDX "original" (which can
   be a www/userinfo variant of the same capture key). Suggestions go into the state and the
   report only; the curator checks the capture and sets archiveUrl. */
const ymd = dayNumber => new Date(dayNumber * DAY).toISOString().slice(0, 10).replace(/-/g, "");
const tsDay = ts => Math.floor(Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8)) / DAY);
export function parseCdx(text) {
  const j = JSON.parse(text);
  if (!Array.isArray(j) || j.length < 2 || !Array.isArray(j[0])) return [];
  const ti = j[0].indexOf("timestamp"), si = j[0].indexOf("statuscode");
  if (ti < 0) return [];
  return j.slice(1).filter(r => Array.isArray(r) && /^\d{14}$/.test(String(r[ti])) && (si < 0 || String(r[si]) === "200")).map(r => String(r[ti]));
}
// Closest to the publishedAt interval (inside it = distance 0, the earliest wins a tie); latest without a date.
export function pickCapture(timestamps, iv) {
  const ts = [...new Set(timestamps)].sort();
  if (!ts.length) return null;
  if (!iv) return ts[ts.length - 1];
  const dist = t => { const n = tsDay(t); return n < iv[0] ? iv[0] - n : n > iv[1] ? n - iv[1] : 0; };
  return ts.reduce((best, t) => (best === null || dist(t) < dist(best) ? t : best), null);
}
const waybackUrl = (ts, url) => `https://web.archive.org/web/${ts}/${url}`;
/* Circuit breaker: going over archive.org's (unpublished) limit leads to a temporary block
   (§20.6), and hammering on would extend it. After a 429 or 403 from an archive.org API
   (or a 429 on an archive copy, same budget) no further lookup is made in this run; the
   sources stay without a suggestion and are looked up again on their next check. */
const ARCHIVE_STOP = new Set([403, 429]);
async function apiGet(url, d) {
  if (d.archiveBlocked) return null;
  const r = await fetchChain(url, d, { max: API_MAX_BYTES, accept: "application/json", gap: d.archiveDelayMs, text: true });
  const status = r.response ? r.response.status : r.status ?? null;
  if (ARCHIVE_STOP.has(status)) { d.archiveBlocked = `HTTP ${status}`; return null; }
  return r.response && status === 200 && !r.response.truncated ? r.response.text : null;
}
export async function lookupArchive(src, d) {
  if (d.archiveBlocked) return null;
  const iv = src.publishedAt && parseDate(src.publishedAt.value) ? interval(src.publishedAt.value) : null;
  // Only a fixed capture that passes the allowlist, and never the archiveUrl that just went away.
  const make = (ts, via) => {
    const url = ts && waybackUrl(ts, src.url);
    return url && archiveUrlAllowed("internet-archive", url) && url !== src.archiveUrl ? { timestamp: ts, url, via } : null;
  };
  const q = encodeURIComponent(src.url);
  try {
    const text = await apiGet(`https://web.archive.org/cdx/search/cdx?url=${q}&output=json&filter=statuscode:200` + (iv ? `&from=${ymd(iv[0])}&limit=10` : "&limit=-10"), d);
    const s = text && make(pickCapture(parseCdx(text), iv), "wayback-cdx-api");
    if (s) return s;
  } catch (e) { /* fall back */ }
  try {
    const text = await apiGet(`https://archive.org/wayback/available?url=${q}` + (iv ? `&timestamp=${ymd(iv[0])}` : ""), d);
    const c = text && ((JSON.parse(text).archived_snapshots || {}).closest);
    const ts = c && c.available && String(c.status) === "200" && /^\d{14}$/.test(String(c.timestamp)) ? String(c.timestamp) : null;
    const s = make(ts, "wayback-availability-api");
    if (s) return s;
  } catch (e) { /* no suggestion this run */ }
  return null;
}

/* ---------- Output ---------- */
const sortDeep = v => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortDeep(v[k])])) : v);
export const stableStringify = v => JSON.stringify(sortDeep(v), null, 2) + "\n";
const md = s => "`" + String(s ?? "").replace(/[`\r\n]/g, "") + "`";
// Details are our own wording, but may carry a code from the network stack: keep them plain.
export const plain = s => String(s ?? "").replace(/[^\w .:()/,-]/g, "").slice(0, 120);

// Public report: source ids, URLs, classes and HTTP statuses only (§20.7; the repo is public).
export function renderReport(rep) {
  const L = [`## Model History source health, ${rep.now.slice(0, 10)}`, ""];
  L.push(`Checked ${rep.checkedSources} sources (${rep.checkedUrls} URLs): ${RESULTS.map(r => `${rep.counts[r]} ${r}`).join(", ")}.`);
  L.push(`Not due: ${rep.notDue}. Deferred over the limit of ${rep.limit}: ${rep.deferred}. Skipped (healthCheck "skip"): ${rep.skipped}.`);
  if (rep.budgetSkipped) L.push(`Time budget of ${+(rep.budgetMs / 60000).toFixed(1)} min used up: ${rep.budgetSkipped} URLs not checked; they stay due and are first in line next run.`);
  if (rep.archivePaused) L.push(`Archive lookups paused (${plain(rep.archivePaused)} from archive.org): ${rep.archiveSkipped} skipped, retried on the next check.`);
  if (rep.lookupsDeferred) L.push(`Archive lookups left for a later check (limit of ${rep.lookupLimit} per run, or the time budget): ${rep.lookupsDeferred}.`);
  L.push(rep.dryRun ? "Dry run: nothing written." : rep.changed ? "State updated: state/source-status.json." : "State unchanged.");
  const line = x => `${md(x.id)} ${x.target}: ${x.result}${x.detail ? ` (${plain(x.detail)})` : ""} · ${md(x.url)}`;
  const section = (title, items, fmt = line) => { if (items.length) L.push("", `### ${title}`, "", ...items.map(x => "- " + fmt(x))); };
  section("Now unavailable (3 decisive failures in a row over at least 9 days)", rep.nowUnavailable);
  section("New failures (streak started; not unavailable yet)", rep.newFailures);
  section("Recovered", rep.recovered);
  section("URL replaced by the curator (machine state started over)", rep.urlReset, x => `${md(x.id)} · ${md(x.url)}`);
  section("Machine state differs from the curator's availability (review; §17.3 decides)", rep.curatorDiffers,
    x => `${md(x.id)}: curator ${x.curator}, machine ${x.machine}${x.kept ? " (curator verdict still applies: checked on the curator's date)" : " (machine verdict applies until the curator checks again)"} · ${md(x.url)}`);
  section("Moved (redirect to another path; final URL for the curator)", rep.moved, x => `${line(x)} → ${md(x.finalUrl)}`);
  section("Possible content change (title differs from the first observation; new since the previous check)", rep.contentChanged);
  section("Archive suggestions (check the capture before adopting it as archiveUrl)", rep.suggestions,
    x => `${md(x.id)} · ${md(x.url)} → ${md(x.suggestion.url)} (${x.suggestion.via})`);
  section("Unverifiable (only non-decisive results for at least 90 days)", rep.unverifiable, x => `${md(x.id)} ${x.target}: last ${x.result} · ${md(x.url)}`);
  section("State entries without a source (kept; nothing is deleted)", rep.orphans, x => md(x.id));
  return L.join("\n") + "\n";
}

/* ---------- Run ---------- */
// Everything that talks to the network, in one injectable bundle (tests pass fakes).
export function makeDeps({ fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), clock = Date.now,
  hostDelayMs = HOST_DELAY_MS, archiveDelayMs = ARCHIVE_DELAY_MS, timeoutMs = TIMEOUT_MS, respectRobots = true } = {}) {
  const d = { fetchImpl, pace: makePacer(sleep, clock), hostDelayMs, archiveDelayMs, timeoutMs, respectRobots };
  d.robots = makeRobots(d);
  return d;
}
async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } }));
}
const CURATOR_AS_MACHINE = { active: "active", archived: "unavailable", unavailable: "unavailable" };
const jsonFiles = dir => (!existsSync(dir) ? [] : readdirSync(dir).sort().flatMap(name => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? jsonFiles(p) : name.endsWith(".json") ? [p] : [];
}));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const failedObservation = detail => ({ result: "error", detail, httpStatus: null, finalUrl: null, fingerprint: null });

/* opts: data, now, limit, dryRun, archiveLookup, concurrency, budgetMs, lookupLimit, log,
   summaryFile, plus the network options of makeDeps (fetchImpl, sleep, clock, hostDelayMs,
   archiveDelayMs, timeoutMs, respectRobots). */
export async function run(opts = {}) {
  const o = { data: DEFAULT_DATA, now: Date.now(), limit: RUN_LIMIT, dryRun: false, archiveLookup: true, concurrency: CONCURRENCY,
    budgetMs: BUDGET_MS, lookupLimit: LOOKUP_LIMIT, log: console.log, summaryFile: process.env.GITHUB_STEP_SUMMARY || null, ...opts };
  const clock = typeof o.clock === "function" ? o.clock : Date.now;
  const deadline = clock() + o.budgetMs;
  const now = isoSeconds(o.now);
  // Normalised first: loadDataset derives the relative paths in parseErrors from the length
  // of this string, and a trailing separator shifted them past the guard below.
  const data = resolve(o.data);
  if (!existsSync(data)) throw new Error(`data directory not found: ${data}`);
  const ds = loadDataset(data);
  const statePath = join(data, "state", "source-status.json");
  // Never overwrite a state we could not read, and never judge against a partial source list.
  // Also checked on what was loaded, so the guard does not hang on how a path is spelled.
  const broken = ds.parseErrors.filter(e => e.file.startsWith("sources/") || e.file === "state/source-status.json").map(e => `${e.file} (${e.message})`);
  if (existsSync(statePath) && !ds.state.sourceStatus && !broken.some(b => b.startsWith("state/"))) broken.push("state/source-status.json");
  if ((ds.sourceFiles || []).length !== jsonFiles(join(data, "sources")).length && !broken.some(b => b.startsWith("sources/"))) broken.push("sources/ (a file could not be loaded)");
  if (broken.length) throw new Error("cannot read " + broken.join(", "));
  const prevRaw = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
  const prev = ds.state.sourceStatus || { schemaVersion: SCHEMA_VERSION, generated: null, sources: {} };
  if (prev.schemaVersion !== SCHEMA_VERSION) throw new Error(`unknown schemaVersion in state/source-status.json: ${prev.schemaVersion}`);
  const prevEntries = prev.sources || {};

  const byId = new Map();
  for (const s of ds.sources) if (s && typeof s.id === "string" && !byId.has(s.id)) byId.set(s.id, s);   // duplicates: E02 in the validator
  const sources = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const skipped = sources.filter(s => s.healthCheck === "skip");
  const items = sources.filter(s => s.healthCheck !== "skip").map(src => ({ src, ...trackersFor(src, prevEntries[src.id]), checked: false }));
  const { selected, deferred } = selectDue(items, now, o.limit);

  const d = makeDeps({ ...o, clock });

  /* Checks: grouped by host, hosts in parallel, each host sequential in id order. No new
     check starts after the deadline; what was not checked stays due. One URL can never
     abort the run: an unexpected exception becomes a non-decisive "error". */
  const targets = selected.flatMap(({ item, targets: ks }) => ks.map(kind => ({ item, kind, key: kind === "original" ? "orig" : "archive",
    url: kind === "original" ? item.src.url : item.src.archiveUrl, obs: null })));
  const groups = new Map();
  for (const t of targets) { const k = paceKey(t.url); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  await pool([...groups.keys()].sort().map(k => groups.get(k)), o.concurrency, async list => {
    for (const t of list) {
      if (clock() >= deadline) continue;
      try { t.obs = await observe(t.url, d, t.item[t.key].firstFingerprint); }
      catch (e) { o.log(`${t.item.src.id} ${t.kind}: internal error (${plain(e && e.message)})`); t.obs = failedObservation("internal error"); }
    }
  });
  const done = targets.filter(t => t.obs);
  for (const t of done) {
    t.before = t.item[t.key];
    t.item[t.key] = applyObservation(t.before, t.obs, now);
    t.after = t.item[t.key];
    t.item.checked = true;
    if (paceKey(t.url) === "archive.org" && t.obs.httpStatus === 429) d.archiveBlocked = "HTTP 429";
    o.log(`${t.item.src.id} ${t.kind}: ${t.obs.result} (${plain(t.obs.detail)})`);
  }

  /* Suggestions for the sources checked in this run, one archive.org request per 2 s, at most
     lookupLimit per run and not after the deadline. Sources that went away go first, then
     id order; the rest are looked up on their next check. */
  const suggestions = [];
  let archiveSkipped = 0, lookupsDeferred = 0, lookups = 0;
  const checked = items.filter(it => it.checked);
  const urgent = it => (it.archive && it.archive.state === "unavailable") || it.orig.state === "unavailable" || it.orig.consecutiveFailures > 0;
  for (const item of [...checked].sort((a, b) => (urgent(b) - urgent(a)) || cmp(a.src.id, b.src.id))) {
    const raw = prevEntries[item.src.id], archiveState = item.archive ? TO_ARCHIVE_STATE[item.archive.state] : null;
    let sug = raw && keepSuggestion(raw.archiveSuggestion, item.src, archiveState) ? raw.archiveSuggestion : null;
    if (!sug && o.archiveLookup && needsSuggestion(item.src, archiveState)) {
      if (d.archiveBlocked) archiveSkipped++;
      else if (lookups >= o.lookupLimit || clock() >= deadline) lookupsDeferred++;
      else {
        lookups++;
        try { sug = await lookupArchive(item.src, d); } catch (e) { sug = null; o.log(`${item.src.id} archive lookup: internal error (${plain(e && e.message)})`); }
        if (sug) suggestions.push({ id: item.src.id, url: item.src.url, suggestion: sug });
      }
    }
    item.suggestion = sug;
  }
  suggestions.sort((a, b) => cmp(a.id, b.id));

  // New state: every previous entry is kept (skip sources and orphans untouched).
  const entries = { ...prevEntries };
  for (const it of items) {
    if (it.checked) entries[it.src.id] = joinEntry(it.orig, it.archive, it.suggestion);
    else if (prevEntries[it.src.id]) entries[it.src.id] = reconcile(prevEntries[it.src.id], it.src, it.orig, it.archive);
  }
  const strip = s => stableStringify({ ...s, generated: null });
  const next = { schemaVersion: SCHEMA_VERSION, generated: prev.generated ?? null, sources: entries };
  const changed = prevRaw === null || strip(prev) !== strip(next);
  if (changed) next.generated = now;
  const text = stableStringify(next);
  let written = false;
  if (!o.dryRun && text !== prevRaw) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath + ".tmp", text);
    renameSync(statePath + ".tmp", statePath);
    written = true;
  }

  // Report.
  const rep = { now, limit: o.limit, dryRun: o.dryRun, changed, checkedSources: checked.length, checkedUrls: done.length,
    counts: Object.fromEntries(RESULTS.map(r => [r, 0])), notDue: items.length - selected.length - deferred.length, deferred: deferred.length,
    skipped: skipped.length, archivePaused: o.archiveLookup ? d.archiveBlocked || null : null, archiveSkipped,
    budgetMs: o.budgetMs, budgetSkipped: targets.length - done.length, lookupLimit: o.lookupLimit, lookupsDeferred,
    nowUnavailable: [], newFailures: [], recovered: [], curatorDiffers: [], moved: [], contentChanged: [], suggestions, unverifiable: [],
    urlReset: items.filter(it => it.reset).map(it => ({ id: it.src.id, url: it.src.url })),
    orphans: Object.keys(prevEntries).filter(id => !byId.has(id)).sort().map(id => ({ id })) };
  const titleOf = fp => (fp && typeof fp.title === "string" && fp.title ? normalize(fp.title) : null);
  for (const t of [...done].sort((a, b) => cmp(a.item.src.id, b.item.src.id) || cmp(b.kind, a.kind))) {
    const { obs, before, after } = t;
    const x = { id: t.item.src.id, target: t.kind, url: t.url, result: obs.result, detail: obs.detail, finalUrl: obs.finalUrl };
    rep.counts[obs.result]++;
    if (before.state !== "unavailable" && after.state === "unavailable") rep.nowUnavailable.push(x);
    else if (FAILURE.has(obs.result) && !before.consecutiveFailures) rep.newFailures.push(x);
    if (obs.result === "ok" && (before.state === "unavailable" || before.consecutiveFailures > 0)) rep.recovered.push(x);
    if (obs.result === "moved") rep.moved.push(x);
    // A title change is listed once: when the previous check was an ok with this same title,
    // it was listed then (or is the baseline), so it is not repeated every 6 days.
    const base = titleOf(before.firstFingerprint), title = obs.result === "ok" ? titleOf(obs.fingerprint) : null;
    if (base && title && title !== base && !(before.lastResult === "ok" && titleOf(before.lastFingerprint) === title)) rep.contentChanged.push(x);
    const cur = CURATOR_AS_MACHINE[t.item.src.availability];
    if (t.kind === "original" && before.state !== after.state && cur && cur !== after.state) {
      const curAt = toInstant(t.item.src.lastCheckedAt);
      rep.curatorDiffers.push({ id: x.id, url: x.url, curator: t.item.src.availability, machine: after.state, kept: curAt !== null && Date.parse(after.stateSince) <= curAt });
    }
  }
  for (const it of items) {
    if (isUnverifiable(it.orig, now)) rep.unverifiable.push({ id: it.src.id, target: "original", url: it.src.url, result: it.orig.lastResult });
    if (it.archive && isUnverifiable(it.archive, now)) rep.unverifiable.push({ id: it.src.id, target: "archive", url: it.archive.url, result: it.archive.lastResult });
  }
  const markdown = renderReport(rep);
  o.log(markdown);
  if (o.summaryFile) appendFileSync(o.summaryFile, markdown);
  return { now, changed, written, state: next, text, report: rep, markdown };
}

/* ---------- CLI ---------- */
function parseArgs(argv) {
  const a = { respectRobots: true, archiveLookup: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], val = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
    if (k === "--data") a.data = resolve(val());
    else if (k === "--now") a.now = isoSeconds(val());
    else if (k === "--limit") { const n = Number(val()); if (!Number.isInteger(n) || n < 0) throw new Error("--limit must be a whole number ≥ 0"); a.limit = n; }
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--no-archive-lookup") a.archiveLookup = false;
    else if (k === "--respect-robots") a.respectRobots = true;
    else if (k === "--no-respect-robots") a.respectRobots = false;
    else if (k === "--budget-min") { const n = Number(val()); if (!(n > 0)) throw new Error("--budget-min must be a number > 0"); a.budgetMs = n * 60000; }
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}
const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  run(args).catch(e => { console.error(`source health failed: ${e.message}`); process.exit(1); });
}
