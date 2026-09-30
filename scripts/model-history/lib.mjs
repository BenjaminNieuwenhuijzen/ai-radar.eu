/* Model History: shared helpers for the validator, the page generator, the news
   matcher and the source-health checker. Node built-ins only, no dependencies, the same
   as scripts/build-feed.mjs.

   Sections: constants & vocabularies · ids · dates · text · news ids (copied from the
   feed build) · archive allowlist · JSON loading · registry. */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import vm from "node:vm";

/* ---------- Constants & vocabularies ---------- */
export const SCHEMA_VERSION = 1;
export const SECONDARY_MIN = 2;          // independent secondary publishers needed without a primary source
export const SITE = "https://ai-radar.eu";

export const VOCAB = {
  orgType: ["company", "research-lab", "unit", "nonprofit", "academic", "consortium", "government"],
  orgCoverage: ["tracked", "external"],
  role: ["developer", "co-developer", "publisher"],
  category: ["language", "multimodal", "code", "reasoning", "image-generation", "video-generation", "audio-speech",
    "music", "embedding", "retrieval-reranking", "agentic", "robotics", "scientific", "game-playing",
    "safety-classifier", "other"],
  prominence: ["milestone", "standard", "minor"],
  lifecycle: ["announced", "preview", "available", "deprecated", "retired", "research-only", "unknown"],
  relationType: ["successor-of", "variant-of", "revision-of", "derived-from"],
  derivedMethod: ["fine-tune", "distillation", "quantization", "merge", "adapter", "continued-pretraining", "other"],
  basis: ["sourced", "editorial"],
  aspect: ["modality", "context-length", "reasoning", "tool-use", "languages", "efficiency", "size", "training-data",
    "safety", "licensing", "availability", "architecture", "other"],
  direction: ["added", "removed", "increased", "decreased", "changed"],
  quantityAspect: ["context-length", "size", "languages"],   // the only aspects that may use increased/decreased
  modality: ["text", "image", "audio", "video", "code", "3d", "structured-data", "actions"],
  feature: ["tool-use", "function-calling", "reasoning-mode", "long-context", "fine-tuning-available", "multilingual",
    "real-time", "computer-use", "retrieval", "other"],
  disclosure: ["official", "not-disclosed", "unknown"],
  access: ["api", "consumer-app", "open-weights-download", "cloud-partner", "research-only", "on-device"],
  sourceType: ["announcement", "blog-post", "model-card", "system-card", "technical-report", "research-paper",
    "documentation", "api-reference", "release-notes", "changelog", "deprecation-notice", "press-release",
    "repository", "code-release", "model-hub-page", "news-article", "interview", "encyclopedia", "other"],
  provenance: ["primary", "archived-primary", "secondary"],
  availability: ["active", "archived", "unavailable", "unknown"],
  archiveProvider: ["internet-archive", "publisher", "arxiv", "github", "huggingface", "software-heritage", "other-approved"],
  healthCheck: ["check", "skip"],
  aliasMatch: ["auto", "candidate", "never"],
  modelCoverage: ["full", "stub"],
  qualifier: ["approximate", "uncertain"]
};

// Capability keys that hold a single claim object (features is a list of claims).
export const CAPABILITY_KEYS = ["inputModalities", "outputModalities", "openWeights", "contextWindowTokens", "parameters", "access"];
export const NUMERIC_CAPABILITIES = ["contextWindowTokens", "parameters"];

// Text limits (characters).
export const LIMITS = { summary: 500, change: 200, description: 500, chapterText: 1200, chapterTitle: 120,
  name: 120, alias: 120, note: 1000, title: 300, label: 120 };

/* ---------- Ids ---------- */
const SEG = "[a-z0-9]+(?:-[a-z0-9]+)*";
export const RE = {
  org: new RegExp(`^${SEG}$`),
  scoped: new RegExp(`^(${SEG})\\.(${SEG})$`),            // family and model ids: <orgId>.<name>
  source: new RegExp(`^src\\.(${SEG})\\.(${SEG})$`),      // src.<orgId|shared>.<name>
  slug: new RegExp(`^${SEG}$`),                           // no dots (a convention, see the spec)
  local: new RegExp(`^${SEG}$`),                          // variant, change, milestone and chapter ids
  postId: /^[0-9a-z]{1,16}$/
};
export const idPrefix = id => (RE.scoped.exec(id) || [])[1] || null;
export const idLocal = id => (RE.scoped.exec(id) || [])[2] || null;

/* ---------- Dates ----------
   A date value is "YYYY", "YYYY-MM" or "YYYY-MM-DD" (ISO 8601 reduced precision = EDTF
   level 0). The precision follows from the format; an unknown day or month is never
   filled in. Model dates are calendar dates as the source states them: no time zone. */
const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
export function parseDate(v) {
  if (typeof v !== "string") return null;
  const m = DATE_RE.exec(v);
  if (!m) return null;
  const y = +m[1], mo = m[2] ? +m[2] : null, d = m[3] ? +m[3] : null;
  if (y < 1) return null;
  if (mo !== null && (mo < 1 || mo > 12)) return null;
  if (d !== null) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  }
  return { y, m: mo, d, precision: d !== null ? "day" : mo !== null ? "month" : "year" };
}
const DAY_MS = 86400000;
const dayNo = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
// Earliest and latest day the value can mean, as UTC day numbers.
export function interval(v) {
  const p = typeof v === "string" ? parseDate(v) : v;
  if (!p) return null;
  if (p.precision === "day") { const n = dayNo(p.y, p.m, p.d); return [n, n]; }
  if (p.precision === "month") return [dayNo(p.y, p.m, 1), dayNo(p.y, p.m + 1, 1) - 1];
  return [dayNo(p.y, 1, 1), dayNo(p.y + 1, 1, 1) - 1];
}
// a should be on or before b; contradictory only when that is impossible at the given precisions.
export function contradictory(a, b) {
  const ia = interval(a), ib = interval(b);
  return !!(ia && ib && ia[0] > ib[1]);
}
const PREC_RANK = { day: 0, month: 1, year: 2 };
const pad = (n, w) => String(n).padStart(w, "0");
// "YYYY-MM-DD-p" with 00 for an unknown month or day; unknown dates sort last.
export function sortKey(v) {
  const p = typeof v === "string" ? parseDate(v) : v;
  if (!p) return "9999-99-99-9";
  return `${pad(p.y, 4)}-${pad(p.m || 0, 2)}-${pad(p.d || 0, 2)}-${PREC_RANK[p.precision]}`;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// English display text; never shows a component the value does not have.
export function formatDate(dv) {
  if (!dv || !dv.value) return "Date unknown";
  const p = parseDate(dv.value);
  if (!p) return "Date unknown";
  let s = p.precision === "day" ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : p.precision === "month" ? `${MONTHS[p.m - 1]} ${p.y}` : String(p.y);
  if (dv.qualifier === "approximate") s = (p.precision === "year" ? "c. " : "around ") + s;
  if (dv.qualifier === "uncertain") s = s + "?";
  return s;
}
// All three precisions are valid <time datetime> values (month string, date string, year).
export const datetimeAttr = dv => (dv && parseDate(dv.value) ? dv.value : null);
// Curator dates without a time count as the end of that day, so a same-day recheck wins.
export function toInstant(v) {
  if (!v || typeof v !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Date.parse(v + "T23:59:59Z");
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
// Date.parse rolls impossible days over (2026-02-30 → 2 March), so the day is checked separately.
export const isIsoInstant = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(v) && !!parseDate(v.slice(0, 10)) && !Number.isNaN(Date.parse(v));
export const isCuratorCheck = v => typeof v === "string" && (/^\d{4}-\d{2}-\d{2}$/.test(v) ? !!parseDate(v) : isIsoInstant(v));

/* ---------- Text ---------- */
// NFKC, every Unicode hyphen or dash (U+2010–U+2015) and minus (U+2212) to "-",
// lowercase, collapsed whitespace. Used for aliases, search and news matching.
export function normalize(s) {
  return String(s || "").normalize("NFKC").replace(/[‐-―−]/g, "-").toLowerCase().replace(/\s+/g, " ").trim();
}
export const fold = s => normalize(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
export const compact = s => fold(s).replace(/[\s\-_.·/]+/g, "");
export const escapeHtml = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export const hasHtml = s => /<\/?[a-z][^>]*>|&[a-z]+;|&#\d+;/i.test(String(s || ""));

/* ---------- News ids ----------
   Byte-identical copy of the id functions in scripts/build-feed.mjs and assets/app.js
   (validate.mjs checks this, error E18). The id in data.json stays leading: the feed build
   re-hashes with a seed when two links collide. */
const cyrb53 = (str, seed = 0) => {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};
const postKey = link => (link || "").trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
const postId = link => cyrb53(postKey(link)).toString(36);
export { cyrb53, postKey, postId };

// The text of the three functions, from "const cyrb53 = " up to and including the postId line.
export function extractIdFunctions(source) {
  const start = source.indexOf("const cyrb53 = (str, seed = 0) => {");
  const endMarker = "const postId = link => cyrb53(postKey(link)).toString(36);";
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) return null;
  return source.slice(start, end + endMarker.length).replace(/\r\n/g, "\n");
}

/* ---------- Archive allowlist ----------
   Per provider a host + path rule, so only fixed (immutable) captures count. archive.today
   is deliberately absent (deprecated by English Wikipedia in 2026). */
export const OTHER_APPROVED = [];   // add RegExps here only after an explicit decision
export function registrableDomain(u) {
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
    const parts = h.split(".");
    // Naive eTLD+1 with the common two-part suffixes; good enough for publisher archives.
    const two = parts.slice(-2).join(".");
    if (/^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(two) && parts.length >= 3) return parts.slice(-3).join(".");
    return two;
  } catch (e) { return null; }
}
export const ARCHIVE_RULES = {
  "internet-archive": u => /^https:\/\/web\.archive\.org\/web\/\d{14}\//.test(u),
  arxiv: u => /^https:\/\/arxiv\.org\/abs\/[^?#]+v\d+$/.test(u),
  github: u => /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:(?:tree|blob)\/[0-9a-f]{7,40}(?:\/|$)|releases\/tag\/[^/?#]+$)/.test(u),
  huggingface: u => /^https:\/\/huggingface\.co\/.+\/(?:blob|tree)\/[0-9a-f]{7,40}(?:\/|$)/.test(u),
  "software-heritage": u => /^https:\/\/archive\.softwareheritage\.org\//.test(u),
  publisher: (u, ctx = {}) => {
    const d = registrableDomain(u);
    return !!d && u.startsWith("https://") && [ctx.url, ctx.website].some(x => x && registrableDomain(x) === d);
  },
  "other-approved": u => OTHER_APPROVED.some(re => re.test(u))
};
export const archiveUrlAllowed = (provider, url, ctx) => !!(ARCHIVE_RULES[provider] && ARCHIVE_RULES[provider](url, ctx));

/* ---------- JSON loading ---------- */
export function readJson(path) {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw.replace(/^﻿/, ""));
}
function listJson(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listJson(p));
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}
const rel = (root, p) => relative(root, p).replace(/\\/g, "/");

/* Loads a data root (model-history/ or a test fixture). Parse errors are collected, not
   thrown, so the validator can report every broken file in one run. */
export function loadDataset(root) {
  const ds = { root, parseErrors: [], organizations: [], families: [], models: [], sources: [], state: { sourceStatus: null, newsLinks: null } };
  const load = (p, fn) => {
    try { fn(readJson(p)); } catch (e) { ds.parseErrors.push({ file: rel(root, p), message: e.message }); }
  };
  const orgFile = join(root, "organizations.json");
  if (existsSync(orgFile)) load(orgFile, j => { ds.orgFile = j; ds.organizations = (j.organizations || []).map(o => ({ ...o, _file: "organizations.json" })); });
  const famFile = join(root, "families.json");
  if (existsSync(famFile)) load(famFile, j => { ds.famFile = j; ds.families = (j.families || []).map(f => ({ ...f, _file: "families.json" })); });
  for (const p of listJson(join(root, "records"))) load(p, j => ds.models.push({ ...j, _file: rel(root, p) }));
  for (const p of listJson(join(root, "sources"))) load(p, j => { for (const s of j.sources || []) ds.sources.push({ ...s, _file: rel(root, p) }); ds.sourceFiles = (ds.sourceFiles || []).concat({ file: rel(root, p), schemaVersion: j.schemaVersion }); });
  const ss = join(root, "state", "source-status.json"), nl = join(root, "state", "news-links.json");
  if (existsSync(ss)) load(ss, j => { ds.state.sourceStatus = j; });
  if (existsSync(nl)) load(nl, j => { ds.state.newsLinks = j; });
  return ds;
}

/* ---------- Registry ----------
   assets/registry.js is a classic browser script that sets window.AIRadarRegistry
   (companies, logos, logoFor). The generator runs it in a sandbox to reuse the same hues
   and inline logos as the dashboard. Tests can pass a plain object instead. */
export function loadRegistry(repoRoot) {
  const p = join(repoRoot, "assets", "registry.js");
  if (!existsSync(p)) return null;
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(p, "utf8"), sandbox, { filename: "registry.js" });
  return sandbox.window.AIRadarRegistry || null;
}
