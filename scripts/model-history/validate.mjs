/* Model History validator (spec §26): structure, reference, graph, date, provenance and
   content rules over the curated data in model-history/ (or a test fixture). Node built-ins
   only: a JSON Schema library would need a package.json (P7), so schema/*.schema.json
   documents the structure for editors and this file enforces it.

   Usage: node scripts/model-history/validate.mjs [--data <dir>] [--repo <dir>]
            [--registry <path>|--no-registry] [--json]
   Defaults: --data <repo>/model-history, --repo the current directory. Exit code 1 when
   there is at least one error. build.mjs and the tests call validate() directly.

   Sections: codes · helpers · shape · field checks · organizations · families · models ·
   sources · state · dataset-wide rules · repository guards · validate() · CLI. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { SCHEMA_VERSION, VOCAB, CAPABILITY_KEYS, NUMERIC_CAPABILITIES, LIMITS, RE, idPrefix, parseDate, contradictory,
  isIsoInstant, toInstant, normalize, hasHtml, postKey, postId, extractIdFunctions, archiveUrlAllowed, loadDataset,
  loadRegistry, readJson } from "./lib.mjs";
import { buildIndex, modelClaims, orgClaims, TEXT_CLAIM_KINDS, emptySourcesAllowed, sourceView, claimEvidence, modelEvidence,
  relationEdges, findCycle, fileNameFor } from "./derive.mjs";

/* ---------- Codes ----------
   One line per rule, as listed in spec §26.2/§26.3 (W06/W07 were dropped there). E29 is the
   design-preview guard of A5/AC-28. The tests check that every code here has a case. */
export const CODES = {
  E01: "invalid JSON, unknown schemaVersion, wrong structure, or a required field missing (unless a specific rule covers it: E08 sources, E17 snapshot, E19-E21, E23, E24)",
  E02: "id does not match the pattern of its kind, or duplicate id",
  E03: "invalid or duplicate slug, previousSlugs or previousRoutes",
  E04: "unknown reference",
  E05: "self-reference or cycle (relations, replacedBy, organization or family parents)",
  E06: "invalid date (format or calendar)",
  E07: "contradictory date order without qualifier",
  E08: "claim without sources, or empty sources where not allowed",
  E09: "inconsistent provenance/availability",
  E10: "archiveUrl does not match its provider's pattern",
  E11: "URL not https where required, invalid, or with credentials",
  E12: "value outside a vocabulary",
  E13: "capability disclosure rules (a value only with disclosure official; official needs a primary source)",
  E14: "HTML in a text field, or text too long",
  E15: "record file path does not match route organization and id",
  E16: "duplicate variant id within a record",
  E17: "incomplete news snapshot or invalid postId",
  E18: "copies of cyrb53/postKey/postId are not byte-identical",
  E19: "coverage rules (full needs summary and timeline date; stub without dates needs dates.note)",
  E20: "change without relativeTo while the model has zero or several predecessors",
  E21: "editorial relation without note",
  E22: "duplicate relation (source, type, target)",
  E23: "derived-from without method",
  E24: "not exactly one organizations[] entry with role developer and primary true",
  E25: "tracked/radarCompanyId consistency, radarCompanyId points to an aggregate item, or assets/registry.js fails to load",
  E26: "forbidden aspect/direction combination",
  E27: "suppressLink without a reason in notes",
  E28: "promotedFrom points to an unknown model, or the variant is still inline there",
  E29: "design previews must not be on main",
  W01: "same normalized alias on more than one model",
  W02: "successor strictly before its predecessor",
  W03: "insufficient evidence or some claims incomplete",
  W04: "lastReviewedAt older than 12 months",
  W05: "source not used by any claim",
  W08: "benchmark or marketing-like text",
  W09: "external organization without hue (or a hue on an organization with a radarCompanyId)",
  W10: "lastCheckedAt in the future (also lastReviewedAt and archivedAt)",
  W11: "archive capture taken after a known content change",
  W12: "many dates on day 1 or 15 (possibly padded precision)",
  W13: "healthCheck skip without a reason in notes",
  W14: "http:// source URL",
  W15: "round number without asStated",
  W16: "contradictory date order with a qualifier",
  W17: "variant or milestone date before the record's announcement or release",
  W18: "postId or radarPostId differs from the id in data.json"
};

/* ---------- Helpers ---------- */
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = v => typeof v === "string" && v.trim() !== "";
const has = v => v !== undefined && v !== null;
const pj = (base, k) => (typeof k === "number" ? `${base}[${k}]` : base ? `${base}.${k}` : k);
const q = v => (v === undefined ? "(missing)" : typeof v === "string" ? `'${v}'` : JSON.stringify(v));
const tag = x => (isObj(x) && isStr(x.id) ? `${x.id}: ` : "");
const safe = fn => { try { return fn(); } catch (e) { return null; } };
// lib.isIsoInstant accepts 2026-02-30T… because Date.parse rolls the day over; add the calendar check.
const isInstant = v => isIsoInstant(v) && !!parseDate(v.slice(0, 10));
const isDay = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !!parseDate(v);
const isCheck = v => isDay(v) || isInstant(v);
const startOf = v => (isDay(v) ? Date.parse(v + "T00:00:00Z") : Date.parse(v));
// W10: a calendar date is only "in the future" once it is later than the latest date anywhere
// on earth (UTC+14), so a curator's local "today" never warns, whatever the time zone of CI.
const inFuture = (v, now) => (isDay(v) ? v > new Date(now + 14 * 3600e3).toISOString().slice(0, 10) : Date.parse(v) > now);
// Spec §9.4: a capability with a disclosure other than official asserts nothing.
const undisclosed = c => VOCAB.disclosure.includes(c.disclosure) && c.disclosure !== "official";
const heldValue = c => has(c.value) && !(Array.isArray(c.value) && !c.value.length);
const DATE_KEYS = ["announced", "released", "deprecated", "retired"];
const DATE_KINDS = new Set(["date", "variant-date", "milestone"]);
const SNAPSHOT_FIELDS = ["postId", "link", "title", "publishedAt", "dateOnly", "company", "source"];
const ROUTE_RE = /^\/models\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MACHINE_STATE = ["active", "unavailable", "unknown"], ARCHIVE_STATE = ["active", "gone", "unknown"];
// W12: by chance ~7% of day dates fall on the 1st or 15th; far more suggests filled-in precision.
const W12_MIN_DATES = 6, W12_SHARE = 0.25;
const LIB_FILE = fileURLToPath(new URL("./lib.mjs", import.meta.url));

// W08 patterns (spec §26.3): percentages next to scores/evaluations, SOTA, rankings, superlatives.
const EVALS = "mmlu|humaneval|gsm8k|gpqa|swe-?bench|hellaswag|big-?bench|mmmu|aime|livecodebench|math-500|arc-agi|truthfulqa|winogrande|mgsm|mbpp|chatbot arena|lmarena|elo";
const SCORE = `\\b(?:scores?|scored|benchmarks?|accuracy|evals?|evaluations?|pass@\\d+|${EVALS})\\b`;
const PCT = "\\d+(?:[.,]\\d+)?\\s?%";
const W08_RULES = [
  [new RegExp(`${PCT}.*${SCORE}|${SCORE}.*${PCT}`, "i"), "percentage next to a score or benchmark"],
  [/\bstate[- ]of[- ]the[- ]art\b|\bsota\b/i, "state-of-the-art claim"],
  // Hyphenated compounds are neutral technical terms: "low-rank adapters" (LoRA), "rank-1", "best-effort".
  [/\bleaderboards?\b|(?<![\w-])rank(?:s|ed|ing|ings)?\b(?!-)/i, "ranking"],
  [/\bbest\b(?!-effort)|\b(?:fastest|smartest|strongest|greatest|highest|largest)\b|\bmost (?:capable|powerful|advanced|intelligent|efficient|accurate|performant)\b|\b(?:industry|world|market)[- ]leading\b|\bworld'?s (?:first|best|leading|most)\b|\b(?:best-in-class|revolutionary|groundbreaking|unprecedented|cutting[- ]edge|game[- ]changing|unmatched|unrivall?ed|superior|top-tier)\b/i, "superlative or marketing language"]
];
const marketing = t => (typeof t === "string" ? (W08_RULES.find(([re]) => re.test(t)) || [])[1] || null : null);

/* ---------- Shape ----------
   derive.mjs expects lists to be lists. Wrong container types are reported once here (E01)
   and replaced by empty values, so every later rule and derivation can run without crashing. */
function listOf(cx, f, path, v) {
  if (!has(v)) return [];
  if (Array.isArray(v)) return v;
  cx.E("E01", f, path, "must be a list");
  return [];
}
function objOrDrop(cx, f, path, v) {
  if (!has(v) || isObj(v)) return v;
  cx.E("E01", f, path, "must be an object");
  return undefined;
}
const MODEL_LISTS = ["aliases", "organizations", "categories", "previousSlugs", "previousRoutes", "milestones", "relations", "variants", "changes"];
const MODEL_OBJECTS = ["dates", "lifecycle", "summary", "capabilities", "news", "replacedBy"];
function shapeModel(cx, m) {
  const f = m._file, mm = { ...m }, dropped = new Set();
  // Non-enumerable, so it never shows up in derived output; checkModel skips "required" for these.
  Object.defineProperty(mm, "_dropped", { value: dropped });
  for (const k of MODEL_LISTS) mm[k] = listOf(cx, f, k, m[k]);
  for (const k of MODEL_OBJECTS) { mm[k] = objOrDrop(cx, f, k, m[k]); if (has(m[k]) && mm[k] === undefined) dropped.add(k); }
  // Non-object entries keep their index (paths stay right) but cannot crash primaryDev().
  mm.organizations = mm.organizations.map((o, i) => (isObj(o) ? o : (cx.E("E01", f, `organizations[${i}]`, "must be { id, role, primary? }"), {})));
  if (isObj(mm.capabilities) && has(mm.capabilities.features)) mm.capabilities = { ...mm.capabilities, features: listOf(cx, f, "capabilities.features", mm.capabilities.features) };
  if (isObj(mm.news)) mm.news = { ...mm.news, include: listOf(cx, f, "news.include", mm.news.include), exclude: listOf(cx, f, "news.exclude", mm.news.exclude) };
  return mm;
}
function shapeOrg(cx, o, i) {
  const f = "organizations.json", p = `organizations[${i}]`, oo = { ...o };
  oo.aliases = listOf(cx, f, pj(p, "aliases"), o.aliases);
  oo.formerNames = listOf(cx, f, pj(p, "formerNames"), o.formerNames);
  oo.description = objOrDrop(cx, f, pj(p, "description"), o.description);
  oo.narrative = objOrDrop(cx, f, pj(p, "narrative"), o.narrative);
  if (isObj(oo.narrative)) oo.narrative = { ...oo.narrative, chapters: listOf(cx, f, pj(p, "narrative.chapters"), oo.narrative.chapters) };
  return oo;
}

/* ---------- Field checks ---------- */
function textCheck(cx, f, path, v, limit, required = false) {
  if (!has(v) || v === "") { if (required) cx.E("E01", f, path, "required text is missing"); return; }
  if (typeof v !== "string") return cx.E("E01", f, path, "must be a string");
  if (required && !v.trim()) return cx.E("E01", f, path, "required text is empty");
  if (hasHtml(v)) cx.E("E14", f, path, "HTML tags or entities in a plain-text field");
  if (limit && [...v].length > LIMITS[limit]) cx.E("E14", f, path, `text is ${[...v].length} characters, the limit is ${LIMITS[limit]}`);
}
// A missing required field is E01 like any other missing field; E12 is a value outside the list.
function vocabCheck(cx, f, path, v, name, required = true) {
  if (!has(v)) { if (required) cx.E("E01", f, path, `required; one of: ${VOCAB[name].join(", ")}`); return; }
  if (!VOCAB[name].includes(v)) cx.E("E12", f, path, `${q(v)} is not one of: ${VOCAB[name].join(", ")}`);
}
// URL rules (E11): parseable http(s), never credentials; https where the site links to a copy
// or a website it chose; a historical http:// original is only a warning (W14).
function urlCheck(cx, f, path, v, { https = false, historical = false } = {}) {
  let u;
  try { u = new URL(v); } catch (e) { return cx.E("E11", f, path, `not a valid URL: ${q(v)}`); }
  if (u.username || u.password) cx.E("E11", f, path, "URL contains credentials (user:pass@)");
  if (u.protocol === "https:") return;
  if (u.protocol !== "http:") return cx.E("E11", f, path, `unsupported scheme ${q(u.protocol)}`);
  if (https) cx.E("E11", f, path, "must be https");
  else if (historical) cx.W("W14", f, path, "http:// URL (kept as the historical original)");
}
function refsCheck(cx, f, path, refs) {
  if (!Array.isArray(refs)) return;   // a missing or malformed list is E08 where a claim needs one
  refs.forEach((r, i) => {
    const p = pj(path, i);
    if (!isObj(r) || !isStr(r.id)) return cx.E("E01", f, p, "source reference must be { id, locator? }");
    cx.used.add(r.id);
    if (!cx.idx.srcById.has(r.id)) cx.E("E04", f, pj(p, "id"), `unknown source ${q(r.id)}`);
    if (has(r.locator)) textCheck(cx, f, pj(p, "locator"), r.locator, null);
  });
}
// One DateValue; returns the parsed value or null. Its own sources are checked with the claim
// it belongs to; alternatives carry their own sources and are checked here.
function dateCheck(cx, f, path, dv, allowNull = false) {
  if (!isObj(dv)) { cx.E("E01", f, path, "must be a date value { value, qualifier?, sources }"); return null; }
  let p = null;
  if (!(dv.value === null && allowNull) && !(p = parseDate(dv.value)))
    cx.E("E06", f, pj(path, "value"), `invalid date ${q(dv.value)}: use YYYY, YYYY-MM or YYYY-MM-DD with a real calendar day`);
  vocabCheck(cx, f, pj(path, "qualifier"), dv.qualifier, "qualifier", false);
  if (has(dv.note)) textCheck(cx, f, pj(path, "note"), dv.note, "note");
  listOf(cx, f, pj(path, "alternatives"), dv.alternatives).forEach((a, i) => {
    const ap = pj(pj(path, "alternatives"), i);
    if (!isObj(a)) return cx.E("E01", f, ap, "alternative must be { value, sources, note }");
    if (!parseDate(a.value)) cx.E("E06", f, pj(ap, "value"), `invalid date ${q(a.value)}`);
    if (!Array.isArray(a.sources) || !a.sources.length) cx.E("E08", f, pj(ap, "sources"), "an alternative value needs its own sources");
    refsCheck(cx, f, pj(ap, "sources"), a.sources);
    if (has(a.note)) textCheck(cx, f, pj(ap, "note"), a.note, "note");
  });
  return p;
}
// Spec §21.5: every ordered pair of the chain, precision-aware; qualified dates may touch (W16).
function chainCheck(cx, f, base, d) {
  const ks = DATE_KEYS.filter(k => isObj(d[k]) && parseDate(d[k].value));
  for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
    const a = d[ks[i]], b = d[ks[j]];
    if (!contradictory(a.value, b.value)) continue;
    const msg = `${ks[i]} ${a.value} is after ${ks[j]} ${b.value}`;
    if (a.qualifier || b.qualifier) cx.W("W16", f, pj(base, ks[j]), msg + " (at least one date is qualified)");
    else cx.E("E07", f, pj(base, ks[j]), msg);
  }
}
function rangeCheck(cx, f, path, from, until) {
  if (!from || !until || !parseDate(from.value) || !parseDate(until.value) || !contradictory(from.value, until.value)) return;
  const msg = `from ${from.value} is after until ${until.value}`;
  if (from.qualifier || until.qualifier) cx.W("W16", f, path, msg); else cx.E("E07", f, path, msg);
}
// Claim rules of §9.4: a sources list is always required; empty only for unknown dates or
// lifecycle and for capabilities with disclosure not-disclosed/unknown, and then with a note.
// Text claims never. Such a capability asserts nothing: a value (or asStated/qualifier) it still
// holds is E13 in disclosureCheck, so `openWeights: { value: true, disclosure: "unknown",
// sources: [] }` is blocked there and not reported a second time as E08. A feature always
// asserts its key, so derive.isNonAssertion's allowance for features is not taken over.
function claimCheck(cx, f, c) {
  const { claim, path, kind } = c;
  if (!isObj(claim)) return;
  const sp = pj(path, "sources");
  if (!Array.isArray(claim.sources)) return cx.E("E08", f, sp, "claim has no sources list (spec §19.1)");
  refsCheck(cx, f, sp, claim.sources);
  if (claim.sources.length) return;
  if (TEXT_CLAIM_KINDS.has(kind)) return cx.E("E08", f, sp, "text claims need at least one source");
  // Lifecycle "unknown" via derive.emptySourcesAllowed; a date claim whose value is null
  // ("unknown", spec §9.4) is allowed here as well; capabilities only when they assert nothing.
  const allowed = kind === "lifecycle" ? emptySourcesAllowed(c)
    : kind === "capability" ? undisclosed(claim)
    : DATE_KINDS.has(kind) && claim.value === null;
  if (!allowed) return cx.E("E08", f, sp, kind === "feature" ? "a feature always asserts its key and needs at least one source; leave it out when it is not disclosed"
    : "empty sources are only allowed for unknown dates or lifecycle and for capabilities with disclosure not-disclosed or unknown (and no value)");
  if (!isStr(claim.note)) cx.E("E08", f, pj(path, "note"), "a claim without sources needs a note");
}
function aliasesCheck(cx, f, path, list) {
  listOf(cx, f, path, list).forEach((a, i) => {
    const p = pj(path, i);
    if (!isObj(a)) return cx.E("E01", f, p, "alias must be { text, match }");
    textCheck(cx, f, pj(p, "text"), a.text, "alias", true);
    vocabCheck(cx, f, pj(p, "match"), a.match, "aliasMatch", false);
  });
}
function localIds(cx, f, path, list, code = "E02") {
  const seen = new Set();
  list.forEach((x, i) => {
    if (!isObj(x)) return;
    const p = pj(pj(path, i), "id");
    if (!has(x.id)) return cx.E("E01", f, p, "required id is missing");
    if (!isStr(x.id) || !RE.local.test(x.id)) return cx.E("E02", f, p, `id ${q(x.id)} must be lowercase letters, digits and hyphens`);
    if (seen.has(x.id)) cx.E(code, f, p, `duplicate id ${q(x.id)} in ${path}`);
    seen.add(x.id);
  });
}

/* ---------- Organizations ---------- */
function ancestorsOf(orgById, id) {
  const out = [], seen = new Set([id]);
  let o = orgById.get(id);
  while (o && isStr(o.parentId) && !seen.has(o.parentId) && orgById.has(o.parentId)) { out.push(o.parentId); seen.add(o.parentId); o = orgById.get(o.parentId); }
  return out;
}
function checkOrganizations(cx) {
  const f = "organizations.json", { idx } = cx;
  cx.sds.organizations.forEach((o, i) => {
    const p = `organizations[${i}]`, at = k => pj(p, k), t = tag(o);
    if (!has(o.id)) cx.E("E01", f, at("id"), "required organization id is missing");
    else if (!isStr(o.id) || !RE.org.test(o.id)) cx.E("E02", f, at("id"), `organization id ${q(o.id)} must be lowercase letters, digits and hyphens`);
    textCheck(cx, f, at("name"), o.name, "name", true);
    vocabCheck(cx, f, at("type"), o.type, "orgType");
    vocabCheck(cx, f, at("coverage"), o.coverage, "orgCoverage");
    if (has(o.parentId) && o.parentId !== o.id && !idx.orgById.has(o.parentId)) cx.E("E04", f, at("parentId"), `${t}unknown organization ${q(o.parentId)}`);
    // Registry link (§10.4, E25). Checks that need the registry degrade to a warning without it.
    const rid = o.radarCompanyId, tracked = o.coverage === "tracked";
    // An empty string is no link at all: it must neither satisfy "tracked" nor skip the lookups.
    if (has(rid) && !isStr(rid)) cx.E("E01", f, at("radarCompanyId"), `${t}must be a non-empty string or null`);
    if (VOCAB.orgCoverage.includes(o.coverage) && tracked !== isStr(rid))
      cx.E("E25", f, at("radarCompanyId"), tracked ? `${t}coverage tracked needs a radarCompanyId` : `${t}radarCompanyId is set, so coverage must be tracked`);
    if (tracked && isStr(rid) && !has(o.parentId) && rid !== o.id) cx.E("E25", f, at("radarCompanyId"), `${t}a top-level tracked organization needs id == radarCompanyId (${q(rid)})`);
    if (isStr(rid)) {
      if (!cx.companies) cx.W("E25", f, at("radarCompanyId"), `${t}registry not available: radarCompanyId ${q(rid)} not checked (E04/E25)`);
      else {
        const c = cx.companies.find(x => isObj(x) && x.id === rid);
        if (!c) cx.E("E04", f, at("radarCompanyId"), `${t}unknown AI Radar company ${q(rid)}`);
        else if (c.aggregate) cx.E("E25", f, at("radarCompanyId"), `${t}${q(rid)} is an aggregate item, not a company`);
      }
    }
    o.aliases.forEach((a, j) => textCheck(cx, f, pj(at("aliases"), j), a, "alias", true));
    o.formerNames.forEach((fn, j) => {
      const fp = pj(at("formerNames"), j);
      if (!isObj(fn)) return cx.E("E01", f, fp, "former name must be { name, from?, until?, sources }");
      textCheck(cx, f, pj(fp, "name"), fn.name, "name", true);
      for (const k of ["from", "until"]) if (has(fn[k])) { dateCheck(cx, f, pj(fp, k), fn[k]); if (isObj(fn[k])) refsCheck(cx, f, pj(pj(fp, k), "sources"), fn[k].sources); }
      rangeCheck(cx, f, pj(fp, "until"), fn.from, fn.until);
    });
    if (has(o.website)) urlCheck(cx, f, at("website"), o.website, { https: true });
    if (isObj(o.description)) {
      textCheck(cx, f, at("description.text"), o.description.text, "description", true);
      const hit = marketing(o.description.text); if (hit) cx.W("W08", f, at("description.text"), `${t}${hit}: keep the text neutral and factual`);
    }
    if (isObj(o.narrative)) {
      const members = new Set(isStr(o.id) ? [o.id, ...cx.sds.organizations.filter(x => ancestorsOf(idx.orgById, x.id).includes(o.id)).map(x => x.id)] : []);
      o.narrative.chapters.forEach((ch, j) => {
        const cp = pj(at("narrative.chapters"), j);
        if (!isObj(ch)) return cx.E("E01", f, cp, "chapter must be an object");
        textCheck(cx, f, pj(cp, "title"), ch.title, "chapterTitle", true);
        textCheck(cx, f, pj(cp, "text"), ch.text, "chapterText", true);
        for (const k of ["title", "text"]) { const hit = marketing(ch[k]); if (hit) cx.W("W08", f, pj(cp, k), `${hit}: keep the text neutral and factual`); }
        if (has(ch.period)) {
          if (!isObj(ch.period)) cx.E("E01", f, pj(cp, "period"), "must be { from, to }");
          else {
            for (const k of ["from", "to"]) if (has(ch.period[k]) && !parseDate(ch.period[k])) cx.E("E06", f, pj(pj(cp, "period"), k), `invalid date ${q(ch.period[k])}`);
            if (parseDate(ch.period.from) && parseDate(ch.period.to) && contradictory(ch.period.from, ch.period.to)) cx.E("E07", f, pj(cp, "period"), `from ${ch.period.from} is after to ${ch.period.to}`);
          }
        }
        listOf(cx, f, pj(cp, "modelIds"), ch.modelIds).forEach((id, k) => {
          const m = idx.modelById.get(id), mp = pj(pj(cp, "modelIds"), k);
          if (!m) cx.E("E04", f, mp, `unknown model ${q(id)}`);
          else if (!m.organizations.some(x => members.has(x.id))) cx.E("E04", f, mp, `${q(id)} does not belong to ${q(o.id)} or its units`);
        });
      });
      localIds(cx, f, at("narrative.chapters"), o.narrative.chapters);
    }
    if (has(o.hue) && !(typeof o.hue === "number" && o.hue >= 0 && o.hue <= 360)) cx.E("E01", f, at("hue"), `${t}must be a number from 0 to 360, or null`);
    // An explicit null is the curator's choice for neutral grey; only a missing hue is flagged.
    if (o.coverage === "external" && o.hue === undefined) cx.W("W09", f, at("hue"), `${t}external organization without a hue renders neutral; set a hue, or null to confirm`);
    // §10.1: hue is only for organizations without a radarCompanyId; the registry colour wins.
    if (isStr(rid) && has(o.hue)) cx.W("W09", f, at("hue"), `${t}hue is ignored for an organization with a radarCompanyId (the AI Radar colour applies); remove it`);
    for (const c of orgClaims(o)) claimCheck(cx, f, { ...c, path: pj(p, c.path) });
  });
}

/* ---------- Families ---------- */
function checkFamilies(cx) {
  const f = "families.json", { idx } = cx;
  cx.sds.families.forEach((fa, i) => {
    const p = `families[${i}]`, at = k => pj(p, k), t = tag(fa);
    if (!has(fa.id)) cx.E("E01", f, at("id"), "required family id is missing");
    else if (!isStr(fa.id) || !RE.scoped.test(fa.id)) cx.E("E02", f, at("id"), `family id ${q(fa.id)} must match <orgId>.<name>`);
    else if (!idx.orgById.has(idPrefix(fa.id))) cx.E("E02", f, at("id"), `id prefix ${q(idPrefix(fa.id))} is not an organization id`);
    if (!has(fa.organizationId)) cx.E("E01", f, at("organizationId"), `${t}required organizationId is missing`);
    else if (!idx.orgById.has(fa.organizationId)) cx.E("E04", f, at("organizationId"), `${t}unknown organization ${q(fa.organizationId)}`);
    textCheck(cx, f, at("name"), fa.name, "name", true);
    if (has(fa.parentId) && fa.parentId !== fa.id && !idx.famById.has(fa.parentId)) cx.E("E04", f, at("parentId"), `${t}unknown family ${q(fa.parentId)}`);
    const d = objOrDrop(cx, f, at("description"), fa.description);
    if (isObj(d)) {
      textCheck(cx, f, at("description.text"), d.text, "description", true);
      const hit = marketing(d.text); if (hit) cx.W("W08", f, at("description.text"), `${t}${hit}: keep the text neutral and factual`);
      claimCheck(cx, f, { path: at("description"), kind: "description", claim: d });
    }
  });
}

/* ---------- Models ---------- */
// Disclosure (spec §11.3, §9.4), for every capability that carries one: only "official" lets a
// capability hold a figure (no third-party estimates), and "official" needs a primary or
// archived-primary source. `figure` names the field that holds one, or is null. A disclosure
// outside the vocabulary is E12 only; E13 is not added on top of it.
function disclosureCheck(cx, f, p, c, figure, required, hint) {
  vocabCheck(cx, f, pj(p, "disclosure"), c.disclosure, "disclosure", required);
  if (figure && undisclosed(c)) cx.E("E13", f, pj(p, figure), `${figure} only with disclosure official (is ${q(c.disclosure)}); ${hint}`);
  if (c.disclosure === "official") {
    const ok = Array.isArray(c.sources) && c.sources.some(r => {
      const s = isObj(r) && cx.idx.srcById.get(r.id);
      return s && ["primary", "archived-primary"].includes(safe(() => sourceView(s, cx.idx).prov));
    });
    if (!ok) cx.E("E13", f, pj(p, "sources"), "disclosure official needs at least one primary or archived-primary source");
  }
}
function numericCheck(cx, f, p, c) {
  if (has(c.value) && !(typeof c.value === "number" && Number.isFinite(c.value) && c.value >= 0)) cx.E("E01", f, pj(p, "value"), "must be a non-negative number or null");
  if (has(c.asStated)) textCheck(cx, f, pj(p, "asStated"), c.asStated, "label");
  vocabCheck(cx, f, pj(p, "qualifier"), c.qualifier, "qualifier", false);
  // asStated and qualifier describe a figure too, so an undisclosed one cannot carry them (§11.3).
  disclosureCheck(cx, f, p, c, ["value", "asStated", "qualifier"].find(k => has(c[k])) || null, true, "no third-party estimates");
  if (typeof c.value === "number" && !isStr(c.asStated) && c.value >= 1000 && (c.value % 1000 === 0 || c.value % 1024 === 0))
    cx.W("W15", f, pj(p, "asStated"), `round number ${c.value} without asStated: give the figure as the source states it`);
}
// Returns the claims it found, so variant capabilities (not in derive's list) can be checked as claims.
function capabilitiesCheck(cx, f, base, caps) {
  if (!isObj(caps)) { cx.E("E01", f, base, "must be an object"); return []; }
  for (const k of Object.keys(caps).sort()) if (k !== "features" && !CAPABILITY_KEYS.includes(k)) cx.E("E12", f, pj(base, k), `unknown capability key ${q(k)}`);
  const claims = [];
  const one = (k, fn) => {
    const c = caps[k], p = pj(base, k);
    if (!has(c)) return;
    if (!isObj(c)) return cx.E("E01", f, p, "must be a claim object");
    claims.push({ path: p, kind: "capability", claim: c });
    if (has(c.note)) textCheck(cx, f, pj(p, "note"), c.note, "note");
    // A non-numeric capability may say "not disclosed" (§9.4) as long as it then holds nothing:
    // null, or an empty list. openWeights false is a value like true.
    if (!NUMERIC_CAPABILITIES.includes(k)) disclosureCheck(cx, f, p, c, heldValue(c) ? "value" : null, false, "a capability that is not disclosed holds null or an empty list");
    fn(c, p);
  };
  const list = vocab => (c, p) => {
    if (c.value === null && undisclosed(c)) return;
    if (!Array.isArray(c.value)) return cx.E("E01", f, pj(p, "value"), "must be a list (null only with disclosure not-disclosed or unknown)");
    c.value.forEach((x, i) => vocabCheck(cx, f, pj(pj(p, "value"), i), x, vocab));
  };
  one("inputModalities", list("modality"));
  one("outputModalities", list("modality"));
  one("access", list("access"));
  one("openWeights", (c, p) => {
    if (c.value === undefined) cx.E("E01", f, pj(p, "value"), "required: true, false or null (not recorded)");
    else if (![true, false, null].includes(c.value)) cx.E("E12", f, pj(p, "value"), "must be true, false or null (not recorded)");
  });
  for (const k of NUMERIC_CAPABILITIES) one(k, (c, p) => numericCheck(cx, f, p, c));
  listOf(cx, f, pj(base, "features"), caps.features).forEach((x, i) => {
    const p = pj(pj(base, "features"), i);
    if (!isObj(x)) return cx.E("E01", f, p, "feature must be { key, sources }");
    vocabCheck(cx, f, pj(p, "key"), x.key, "feature");
    if (has(x.note)) textCheck(cx, f, pj(p, "note"), x.note, "note");
    // The key is the feature's value: it always asserts that the model has the feature.
    disclosureCheck(cx, f, p, x, has(x.key) ? "key" : null, false, "a feature always asserts its key; leave it out when it is not disclosed");
    claims.push({ path: p, kind: "feature", claim: x });
  });
  return claims;
}
// A news snapshot (§22.3, §22.5), in news.include or state/news-links.json. variantIds: the
// variant ids valid for it, or null to skip that check (unknown model, reported elsewhere).
function snapshotCheck(cx, f, p, s, variantIds, where = "this record") {
  if (!isObj(s)) return cx.E("E17", f, p, `news snapshot must be an object with ${SNAPSHOT_FIELDS.join(", ")}`);
  const missing = SNAPSHOT_FIELDS.filter(k => (k === "dateOnly" ? typeof s[k] !== "boolean" : !isStr(s[k])));
  if (missing.length) cx.E("E17", f, p, `incomplete snapshot: missing ${missing.join(", ")}`);
  if (isStr(s.postId) && !RE.postId.test(s.postId)) cx.E("E17", f, pj(p, "postId"), `invalid postId ${q(s.postId)} (base-36, 1-16 characters)`);
  if (isStr(s.publishedAt) && !isInstant(s.publishedAt)) cx.E("E17", f, pj(p, "publishedAt"), "publishedAt must be an ISO UTC timestamp ending in Z");
  else if (s.dateOnly === true && isStr(s.publishedAt) && !/T00:00(?::00(?:\.0+)?)?Z$/.test(s.publishedAt)) cx.E("E17", f, pj(p, "publishedAt"), "date-only items use T00:00:00Z");
  if (isStr(s.link)) urlCheck(cx, f, pj(p, "link"), s.link);
  // Escaped on output anyway; E14 keeps the stored snapshot plain text (a decoded copy of data.json).
  for (const [k, limit] of [["title", "title"], ["company", "name"], ["source", "name"]]) if (isStr(s[k])) textCheck(cx, f, pj(p, k), s[k], limit);
  if (variantIds && has(s.variantId) && !variantIds.has(s.variantId)) cx.E("E04", f, pj(p, "variantId"), `unknown variant ${q(s.variantId)} in ${where}`);
}
const validDate = dv => isObj(dv) && !!parseDate(dv.value);
const tlDate = m => ["released", "announced"].map(k => isObj(m.dates) && m.dates[k]).find(validDate) || null;

function checkModel(cx, m) {
  const f = m._file, { idx } = cx, W = (...a) => cx.W(...a), E = (...a) => cx.E(...a);
  // Identity
  if (!has(m.id)) E("E01", f, "id", "required model id is missing");
  else if (!isStr(m.id) || !RE.scoped.test(m.id)) E("E02", f, "id", `model id ${q(m.id)} must match <orgId>.<name> (lowercase letters, digits, hyphens)`);
  else if (!idx.orgById.has(idPrefix(m.id))) E("E02", f, "id", `id prefix ${q(idPrefix(m.id))} is not an organization id`);
  if (!has(m.slug)) E("E01", f, "slug", "required slug is missing");
  else if (!isStr(m.slug) || !RE.slug.test(m.slug)) E("E03", f, "slug", `slug ${q(m.slug)} must be lowercase letters, digits and hyphens, without dots`);
  m.previousSlugs.forEach((s, i) => { if (!isStr(s) || !RE.slug.test(s)) E("E03", f, `previousSlugs[${i}]`, `invalid slug ${q(s)}`); });
  m.previousRoutes.forEach((r, i) => { if (!isStr(r) || !ROUTE_RE.test(r)) E("E03", f, `previousRoutes[${i}]`, `invalid route ${q(r)} (expected /models/<org>/<slug>/)`); });
  textCheck(cx, f, "name", m.name, "name", true);
  aliasesCheck(cx, f, "aliases", m.aliases);
  // Organizations (E24): exactly one primary developer decides route, folder and slug scope.
  if (!m.organizations.length) E("E24", f, "organizations", "needs at least one entry, exactly one with role developer and primary true");
  const orgSeen = new Set();
  m.organizations.forEach((o, i) => {
    const p = `organizations[${i}]`;
    if (!has(o.id)) E("E01", f, pj(p, "id"), "required organization id is missing");
    else if (!idx.orgById.has(o.id)) E("E04", f, pj(p, "id"), `unknown organization ${q(o.id)}`);
    // One entry per organization: a second role (developer and publisher) would render twice
    // and make "the" role of an organization ambiguous.
    if (isStr(o.id) && orgSeen.has(o.id)) E("E02", f, pj(p, "id"), `duplicate organization id ${q(o.id)} in organizations[]`);
    orgSeen.add(o.id);
    vocabCheck(cx, f, pj(p, "role"), o.role, "role");
    if (has(o.primary) && typeof o.primary !== "boolean") E("E01", f, pj(p, "primary"), "must be true or false");
    if (o.primary === true && has(o.role) && o.role !== "developer") E("E24", f, pj(p, "primary"), "only the developer entry can be primary");
  });
  const primaries = m.organizations.filter(o => o.role === "developer" && o.primary === true).length;
  if (m.organizations.length && primaries !== 1) E("E24", f, "organizations", `${primaries} entries have role developer and primary true; exactly one is required`);
  if (has(m.familyId) && !idx.famById.has(m.familyId)) E("E04", f, "familyId", `unknown family ${q(m.familyId)}`);
  if (has(m.generation) && typeof m.generation !== "string") E("E01", f, "generation", "must be a string or null");
  else if (has(m.generation)) textCheck(cx, f, "generation", m.generation, "label");
  if (!m.categories.length) E("E01", f, "categories", `required: at least one of ${VOCAB.category.join(", ")}`);
  m.categories.forEach((c, i) => vocabCheck(cx, f, `categories[${i}]`, c, "category"));
  vocabCheck(cx, f, "prominence", m.prominence, "prominence");
  vocabCheck(cx, f, "coverage", m.coverage, "modelCoverage");
  if (has(m.promotedFrom)) {
    const [pid, vid, extra] = String(m.promotedFrom).split("#"), from = idx.modelById.get(pid);
    if (typeof m.promotedFrom !== "string" || !vid || extra !== undefined || !RE.local.test(vid)) E("E28", f, "promotedFrom", "must be <model-id>#<variant-id>");
    else if (!from || pid === m.id) E("E28", f, "promotedFrom", `unknown model ${q(pid)}`);
    else if (from.variants.some(v => isObj(v) && v.id === vid)) E("E28", f, "promotedFrom", `variant ${q(vid)} is still inline in ${pid}; remove it there`);
  }
  // Lifecycle and dates
  if (!isObj(m.lifecycle)) { if (!m._dropped.has("lifecycle")) E("E01", f, "lifecycle", "required claim { value, sources, note? }"); }
  else {
    vocabCheck(cx, f, "lifecycle.value", m.lifecycle.value, "lifecycle");
    if (has(m.lifecycle.note)) textCheck(cx, f, "lifecycle.note", m.lifecycle.note, "note");
  }
  if (!isObj(m.dates) && !m._dropped.has("dates")) E("E01", f, "dates", "required object with announced, released, deprecated, retired");
  const dates = isObj(m.dates) ? m.dates : {};
  for (const k of DATE_KEYS) if (has(dates[k])) dateCheck(cx, f, `dates.${k}`, dates[k], true);
  if (has(dates.note)) textCheck(cx, f, "dates.note", dates.note, "note");
  chainCheck(cx, f, "dates", dates);
  const tl = tlDate(m);
  if (m.coverage === "full") {
    if (!isObj(m.summary)) E("E19", f, "summary", "coverage full needs a summary");
    if (!tl) E("E19", f, "dates", "coverage full needs dates.released or dates.announced");
  } else if (m.coverage === "stub" && !tl && !isStr(dates.note)) E("E19", f, "dates.note", "a stub without dates needs dates.note");
  // W17: nothing about the record happens before it was first announced (or released).
  const first = ["announced", "released"].map(k => dates[k]).find(validDate);
  m.milestones.forEach((x, i) => {
    const p = `milestones[${i}]`;
    if (!isObj(x)) return E("E01", f, p, "milestone must be { id, label, date }");
    textCheck(cx, f, pj(p, "label"), x.label, "label", true);
    const hit = marketing(x.label); if (hit) W("W08", f, pj(p, "label"), `${hit}: keep the text neutral and factual`);
    if (!has(x.date)) E("E01", f, pj(p, "date"), "required date value");
    else if (dateCheck(cx, f, pj(p, "date"), x.date, true) && first && contradictory(first.value, x.date.value)) W("W17", f, pj(p, "date"), `milestone ${x.date.value} is before the record's first date ${first.value}`);
  });
  localIds(cx, f, "milestones", m.milestones);
  if (isObj(m.replacedBy) && !has(m.replacedBy.modelId)) E("E01", f, "replacedBy.modelId", "required model id is missing");
  else if (isObj(m.replacedBy) && m.replacedBy.modelId === m.id) E("E05", f, "replacedBy.modelId", "replacedBy points to the model itself");
  else if (isObj(m.replacedBy) && !idx.modelById.has(m.replacedBy.modelId)) E("E04", f, "replacedBy.modelId", `unknown model ${q(m.replacedBy.modelId)}`);
  // Relations (§12)
  const seenRel = new Set();
  m.relations.forEach((r, i) => {
    const p = `relations[${i}]`;
    if (!isObj(r)) return E("E01", f, p, "relation must be { type, target, basis, sources }");
    vocabCheck(cx, f, pj(p, "type"), r.type, "relationType");
    if (!has(r.target)) E("E01", f, pj(p, "target"), "required relation target is missing");
    else if (!isStr(r.target)) E("E04", f, pj(p, "target"), `unknown model ${q(r.target)}`);
    else if (r.target === m.id) E("E05", f, pj(p, "target"), "relation to itself");
    else if (!idx.modelById.has(r.target)) E("E04", f, pj(p, "target"), `unknown model ${q(r.target)}`);
    vocabCheck(cx, f, pj(p, "basis"), r.basis, "basis");
    if (r.type === "derived-from") { if (!has(r.method)) E("E23", f, pj(p, "method"), "derived-from needs a method"); else vocabCheck(cx, f, pj(p, "method"), r.method, "derivedMethod"); }
    else if (has(r.method)) E("E12", f, pj(p, "method"), "method is only allowed on derived-from");
    if (r.basis === "editorial" && !isStr(r.note)) E("E21", f, pj(p, "note"), "an editorial relation needs a note");
    if (has(r.note)) textCheck(cx, f, pj(p, "note"), r.note, "note");
    const key = `${r.type}|${r.target}`;
    if (seenRel.has(key)) E("E22", f, p, `duplicate relation ${r.type} ${q(r.target)}`);
    seenRel.add(key);
    // W02: a successor must not be dated strictly before its predecessor.
    const target = idx.modelById.get(r.target), a = target && tlDate(target);
    if (r.type === "successor-of" && a && tl && contradictory(a.value, tl.value)) W("W02", f, p, `dated ${tl.value}, before its predecessor ${r.target} (${a.value})`);
  });
  // Variants (§13)
  const variantIds = new Set();
  m.variants.forEach((v, i) => {
    const p = `variants[${i}]`;
    if (!isObj(v)) return E("E01", f, p, "variant must be an object");
    if (isStr(v.id)) variantIds.add(v.id);   // pattern and duplicates (E02/E16): localIds below
    textCheck(cx, f, pj(p, "name"), v.name, "name", true);
    aliasesCheck(cx, f, pj(p, "aliases"), v.aliases);
    const vd = objOrDrop(cx, f, pj(p, "dates"), v.dates) || {};
    for (const k of DATE_KEYS) if (has(vd[k]) && dateCheck(cx, f, pj(p, `dates.${k}`), vd[k], true) && first && contradictory(first.value, vd[k].value))
      W("W17", f, pj(p, `dates.${k}`), `variant ${k} ${vd[k].value} is before the record's first date ${first.value}`);
    chainCheck(cx, f, pj(p, "dates"), vd);
    const vl = objOrDrop(cx, f, pj(p, "lifecycle"), v.lifecycle);
    // Same claim rules as the record's lifecycle (and the schema's lifecycleClaim): a sources
    // list is required, empty only for "unknown" with a note. Not in derive's claim list.
    if (isObj(vl)) {
      vocabCheck(cx, f, pj(p, "lifecycle.value"), vl.value, "lifecycle");
      if (has(vl.note)) textCheck(cx, f, pj(p, "lifecycle.note"), vl.note, "note");
      claimCheck(cx, f, { path: pj(p, "lifecycle"), kind: "lifecycle", claim: vl });
    }
    // Variant capabilities hold only differences; they are claims too but not in derive's list.
    if (has(v.capabilities)) for (const c of capabilitiesCheck(cx, f, pj(p, "capabilities"), v.capabilities)) claimCheck(cx, f, c);
    if (has(v.note)) { textCheck(cx, f, pj(p, "note"), v.note, "note"); const hit = marketing(v.note); if (hit) W("W08", f, pj(p, "note"), `${hit}: keep the text neutral and factual`); }
    // A variant's existence needs evidence: its own sources, or at least one known date (whose
    // sources claimCheck requires). Dates that are all unknown (value null) prove nothing.
    if (has(v.sources) && !Array.isArray(v.sources)) E("E08", f, pj(p, "sources"), "sources must be a list");
    else if (!has(v.sources) && !DATE_KEYS.some(k => validDate(vd[k]))) E("E08", f, pj(p, "sources"), "a variant needs sources, or at least one known date with sources");
  });
  localIds(cx, f, "variants", m.variants, "E16");
  // Summary and changes (§14)
  if (isObj(m.summary)) {
    textCheck(cx, f, "summary.text", m.summary.text, "summary", true);
    const hit = marketing(m.summary.text); if (hit) W("W08", f, "summary.text", `${hit}: keep the text neutral and factual`);
  }
  const preds = new Set(m.relations.filter(r => isObj(r) && r.type === "successor-of" && isStr(r.target)).map(r => r.target));
  m.changes.forEach((c, i) => {
    const p = `changes[${i}]`;
    if (!isObj(c)) return E("E01", f, p, "change must be { id, aspect, direction?, relativeTo?, text, sources }");
    vocabCheck(cx, f, pj(p, "aspect"), c.aspect, "aspect");
    vocabCheck(cx, f, pj(p, "direction"), c.direction, "direction", false);
    if ((c.direction === "increased" || c.direction === "decreased") && VOCAB.aspect.includes(c.aspect) && !VOCAB.quantityAspect.includes(c.aspect))
      E("E26", f, pj(p, "direction"), `${c.direction} is only allowed for ${VOCAB.quantityAspect.join(", ")}; use added, removed or changed for ${c.aspect}`);
    if (has(c.relativeTo)) {
      if (c.relativeTo === m.id) E("E05", f, pj(p, "relativeTo"), "a change relative to the model itself");
      else if (!idx.modelById.has(c.relativeTo)) E("E04", f, pj(p, "relativeTo"), `unknown model ${q(c.relativeTo)}`);
    }
    else if (preds.size !== 1) E("E20", f, pj(p, "relativeTo"), `required: the model has ${preds.size} predecessors`);
    textCheck(cx, f, pj(p, "text"), c.text, "change", true);
    const hit = marketing(c.text); if (hit) W("W08", f, pj(p, "text"), `${hit}: keep the text neutral and factual`);
  });
  localIds(cx, f, "changes", m.changes);
  if (has(m.capabilities)) capabilitiesCheck(cx, f, "capabilities", m.capabilities);
  // News (§22.5)
  if (isObj(m.news)) {
    m.news.include.forEach((s, i) => snapshotCheck(cx, f, `news.include[${i}]`, s, variantIds));
    m.news.exclude.forEach((x, i) => { if (typeof x !== "string" || !RE.postId.test(x)) E("E17", f, `news.exclude[${i}]`, `invalid postId ${q(x)}`); });
  }
  // Review metadata
  if (!has(m.lastReviewedAt)) E("E01", f, "lastReviewedAt", "required (YYYY-MM-DD)");
  else if (!isDay(m.lastReviewedAt)) E("E06", f, "lastReviewedAt", `invalid date ${q(m.lastReviewedAt)} (YYYY-MM-DD)`);
  else {
    const d = parseDate(m.lastReviewedAt);
    if (Date.UTC(d.y + 1, d.m - 1, d.d) < cx.now) W("W04", f, "lastReviewedAt", `last reviewed ${m.lastReviewedAt}, more than 12 months ago`);
    // Same rule as W10 for lastCheckedAt: a review date after today is a typo, and it would hide W04.
    else if (inFuture(m.lastReviewedAt, cx.now)) W("W10", f, "lastReviewedAt", `${m.lastReviewedAt} is in the future`);
  }
  if (has(m.notes)) textCheck(cx, f, "notes", m.notes, null);
  // File location (E15): records/<route organization>/<id after the first dot>.json
  const want = isStr(m.id) && RE.scoped.test(m.id) && idx.routeOrg(m) ? fileNameFor(m, idx) : null;
  if (want && want !== f) E("E15", f, "", `file must be ${want} (route organization / id after the first dot)`);
  // Claims (§19.1) and evidence (§16.3)
  for (const c of modelClaims(m)) claimCheck(cx, f, c);
  // The model status comes from the timeline claim (§16.3). derive.timelineDate also picks a
  // dates.released whose value is null (unknown); tlDate skips it, as E19/W02 do.
  const ev = safe(() => modelEvidence(m, idx));
  const tdEv = tl ? safe(() => claimEvidence({ kind: "date", path: "", claim: tl }, idx).evidence) || "insufficient-evidence" : "insufficient-evidence";
  if (ev && (tdEv === "insufficient-evidence" || ev.flags.includes("some-claims-incomplete"))) {
    const weak = ev.claims.filter(c => c.evidence === "insufficient-evidence").map(c => c.path);
    W("W03", f, "", `evidence ${tdEv}${weak.length ? `; insufficient evidence for ${weak.slice(0, 6).join(", ")}${weak.length > 6 ? ", ..." : ""}` : ""}`);
  }
}

/* ---------- Sources ---------- */
// Earliest moment the original is known to have changed or gone: a failing streak or a changed
// title seen by source-health, or the curator's own verdict that the original is gone.
function knownChangeAt(s, st) {
  const at = [];
  if (st && (st.consecutiveFailures > 0 || st.state === "unavailable") && isInstant(st.firstFailureAt)) at.push(Date.parse(st.firstFailureAt));
  const a = st && st.firstFingerprint, b = st && st.lastFingerprint;
  if (isObj(a) && isObj(b) && a.title !== b.title && isInstant(st.lastCheckedAt)) at.push(Date.parse(st.lastCheckedAt));
  if (["archived", "unavailable"].includes(s.availability) && isCheck(s.lastCheckedAt)) at.push(toInstant(s.lastCheckedAt));
  return at.length ? Math.min(...at) : null;
}
function checkSources(cx) {
  const { idx } = cx;
  for (const s of cx.sds.sources) {
    const { file: f, path: p } = cx.srcLoc.get(s), at = k => pj(p, k), t = tag(s);
    if (!has(s.id)) cx.E("E01", f, at("id"), "required source id is missing");
    else if (!isStr(s.id) || !RE.source.test(s.id)) cx.E("E02", f, at("id"), `source id ${q(s.id)} must match src.<orgId|shared>.<name>`);
    else { const o = RE.source.exec(s.id)[1]; if (o !== "shared" && !idx.orgById.has(o)) cx.E("E02", f, at("id"), `id part ${q(o)} is neither an organization id nor 'shared'`); }
    vocabCheck(cx, f, at("type"), s.type, "sourceType");
    textCheck(cx, f, at("title"), s.title, "title", true);
    textCheck(cx, f, at("publisher"), s.publisher, "name", true);
    if (!isStr(s.url)) cx.E("E01", f, at("url"), `${t}required: the original URL as published`);
    else urlCheck(cx, f, at("url"), s.url, { historical: true });
    if (has(s.publisherOrgId) && !idx.orgById.has(s.publisherOrgId)) cx.E("E04", f, at("publisherOrgId"), `${t}unknown organization ${q(s.publisherOrgId)}`);
    if (has(s.publishedAt)) dateCheck(cx, f, at("publishedAt"), s.publishedAt);
    if (has(s.language) && !(typeof s.language === "string" && LANG_RE.test(s.language))) cx.E("E12", f, at("language"), `${t}${q(s.language)} is not a BCP 47 language tag`);
    vocabCheck(cx, f, at("provenance"), s.provenance, "provenance");
    vocabCheck(cx, f, at("availability"), s.availability, "availability");
    vocabCheck(cx, f, at("healthCheck"), s.healthCheck, "healthCheck", false);
    // Provenance and availability (E09, §15-18)
    if (!has(s.lastCheckedAt)) { if (["active", "archived", "unavailable"].includes(s.availability)) cx.E("E09", f, at("lastCheckedAt"), `${t}availability ${s.availability} needs lastCheckedAt`); }
    else if (!isCheck(s.lastCheckedAt)) cx.E("E09", f, at("lastCheckedAt"), `${t}${q(s.lastCheckedAt)} is not YYYY-MM-DD or an ISO UTC timestamp`);
    else if (inFuture(s.lastCheckedAt, cx.now)) cx.W("W10", f, at("lastCheckedAt"), `${t}${s.lastCheckedAt} is in the future`);
    const archived = isStr(s.archiveUrl);
    if (has(s.archiveUrl) && !archived) cx.E("E01", f, at("archiveUrl"), `${t}must be a URL or null`);
    if (s.provenance === "archived-primary" && !archived) cx.E("E09", f, at("archiveUrl"), `${t}archived-primary needs archiveUrl and archiveProvider`);
    if (s.availability === "archived" && !archived) cx.E("E09", f, at("archiveUrl"), `${t}availability archived needs an archiveUrl`);
    if (archived) {
      urlCheck(cx, f, at("archiveUrl"), s.archiveUrl, { https: true });
      if (!has(s.archiveProvider)) cx.E("E09", f, at("archiveProvider"), `${t}an archiveUrl needs archiveProvider`);
      else {
        vocabCheck(cx, f, at("archiveProvider"), s.archiveProvider, "archiveProvider");
        const org = idx.orgById.get(s.publisherOrgId) || (isStr(s.id) && idx.orgById.get((RE.source.exec(s.id) || [])[1]));
        if (VOCAB.archiveProvider.includes(s.archiveProvider) && !archiveUrlAllowed(s.archiveProvider, s.archiveUrl, { url: s.url, website: org && org.website }))
          cx.E("E10", f, at("archiveUrl"), `${t}does not match the allowlist pattern of ${s.archiveProvider} (spec §18.1)`);
      }
      if (!has(s.archivedAt)) cx.E("E09", f, at("archivedAt"), `${t}an archiveUrl needs archivedAt`);
      else if (!isCheck(s.archivedAt)) cx.E("E06", f, at("archivedAt"), `${t}invalid timestamp ${q(s.archivedAt)}`);
      else if (inFuture(s.archivedAt, cx.now)) cx.W("W10", f, at("archivedAt"), `${t}${s.archivedAt} is in the future`);
      else {
        const change = knownChangeAt(s, idx.status[s.id]);
        if (change !== null && startOf(s.archivedAt) > change) cx.W("W11", f, at("archivedAt"), `${t}capture ${s.archivedAt} is after a known change of the original (${new Date(change).toISOString()})`);
      }
    }
    if (has(s.alternativeOf) && (s.alternativeOf === s.id || !idx.srcById.has(s.alternativeOf))) cx.E("E04", f, at("alternativeOf"), `${t}unknown source ${q(s.alternativeOf)}`);
    if (has(s.radarPostId) && !(typeof s.radarPostId === "string" && RE.postId.test(s.radarPostId))) cx.E("E17", f, at("radarPostId"), `${t}invalid postId ${q(s.radarPostId)}`);
    if (s.healthCheck === "skip" && !isStr(s.notes)) cx.W("W13", f, at("notes"), `${t}healthCheck skip needs the reason in notes`);
    if (has(s.suppressLink) && typeof s.suppressLink !== "boolean") cx.E("E01", f, at("suppressLink"), `${t}must be true or false`);
    if (s.suppressLink === true && !isStr(s.notes)) cx.E("E27", f, at("notes"), `${t}suppressLink needs the reason in notes`);
    if (has(s.notes)) textCheck(cx, f, at("notes"), s.notes, null);
  }
}

/* ---------- State (machine-written; checked for shape and references only) ---------- */
function checkState(cx) {
  const { idx } = cx, ss = cx.ds.state.sourceStatus, nl = cx.ds.state.newsLinks;
  if (ss) {
    const f = "state/source-status.json";
    if (!isObj(ss.sources)) cx.E("E01", f, "sources", "must be an object keyed by source id");
    else for (const id of Object.keys(ss.sources).sort()) {
      const st = ss.sources[id], p = `sources[${q(id)}]`;
      if (!isObj(st)) { cx.E("E01", f, p, "must be an object"); continue; }
      if (has(st.state) && !MACHINE_STATE.includes(st.state)) cx.E("E12", f, pj(p, "state"), `${q(st.state)} is not one of: ${MACHINE_STATE.join(", ")}`);
      if (has(st.stateSince) && !isInstant(st.stateSince)) cx.E("E06", f, pj(p, "stateSince"), `invalid timestamp ${q(st.stateSince)}`);
      // check-sources.mjs only ever transitions to active or unavailable, so "unknown" never has a
      // stateSince. A hand-edited one would outrank the curator in effAvail (§17.3, AC-09).
      if (st.state === "unknown" && has(st.stateSince)) cx.E("E12", f, pj(p, "stateSince"), "state unknown is never a transition; stateSince must be null");
      if (has(st.archiveState) && !ARCHIVE_STATE.includes(st.archiveState)) cx.E("E12", f, pj(p, "archiveState"), `${q(st.archiveState)} is not null or one of: ${ARCHIVE_STATE.join(", ")}`);
    }
  }
  if (nl) {
    const f = "state/news-links.json";
    listOf(cx, f, "links", nl.links).forEach((l, i) => {
      const p = `links[${i}]`;
      if (!isObj(l)) return cx.E("E01", f, p, "must be an object");
      const m = idx.modelById.get(l.modelId);
      if (!has(l.modelId)) cx.E("E01", f, pj(p, "modelId"), "required model id is missing");
      else if (!m) cx.E("E04", f, pj(p, "modelId"), `unknown model ${q(l.modelId)}`);
      // The generator renders these snapshots like news.include (same shape, §22.3/§22.5), so
      // they get the same checks: https/http link, ISO publishedAt, dateOnly, plain text.
      // Links are append-only: a variant promoted to its own record stays valid via promotedFrom.
      const vids = m ? new Set([...m.variants.filter(v => isObj(v) && isStr(v.id)).map(v => v.id),
        ...cx.sds.models.map(x => typeof x.promotedFrom === "string" && x.promotedFrom.startsWith(`${l.modelId}#`) ? x.promotedFrom.slice(l.modelId.length + 1) : null).filter(Boolean)]) : null;
      snapshotCheck(cx, f, p, l, vids, l.modelId);
    });
  }
}

/* ---------- Dataset-wide rules ---------- */
function checkFiles(cx) {
  const { ds } = cx, failed = new Set(ds.parseErrors.map(x => x.file));
  if (!existsSync(ds.root)) cx.E("E01", "", "", `data directory not found: ${ds.root}`);
  for (const x of ds.parseErrors) cx.E("E01", x.file, "", `cannot read: ${x.message}`);
  const version = (file, j) => { if (!isObj(j) || j.schemaVersion !== SCHEMA_VERSION) cx.E("E01", file, "schemaVersion", `unknown schemaVersion ${q(isObj(j) ? j.schemaVersion : undefined)} (expected ${SCHEMA_VERSION})`); };
  for (const [file, j, list] of [["organizations.json", ds.orgFile, "organizations"], ["families.json", ds.famFile, "families"]]) {
    if (!j) { if (!failed.has(file) && existsSync(ds.root)) cx.E("E01", file, "", "file is missing"); continue; }
    version(file, j);
    if (!Array.isArray(j[list])) cx.E("E01", file, list, "must be a list");
  }
  for (const s of ds.sourceFiles || []) if (s.schemaVersion !== SCHEMA_VERSION) cx.E("E01", s.file, "schemaVersion", `unknown schemaVersion ${q(s.schemaVersion)} (expected ${SCHEMA_VERSION})`);
  for (const m of ds.models) version(m._file, m);
  if (ds.state.sourceStatus) version("state/source-status.json", ds.state.sourceStatus);
  if (ds.state.newsLinks) version("state/news-links.json", ds.state.newsLinks);
}
function duplicateIds(cx, list, kind, loc) {
  const seen = new Map();
  for (const x of list) {
    if (!isStr(x.id)) continue;
    const { file, path } = loc(x);
    if (seen.has(x.id)) cx.E("E02", file, pj(path, "id"), `duplicate ${kind} id ${q(x.id)} (first in ${seen.get(x.id)})`);
    else seen.set(x.id, file);
  }
}
// E03: slugs and redirect paths must be unique per route organization, so no stub or page
// overwrites another one. Current slugs are claimed first, so the report lands on the newcomer.
function checkRoutes(cx) {
  const { idx } = cx, taken = new Map(), routes = new Map();
  const models = cx.sds.models.filter(m => isStr(idx.routeOrg(m)));
  const claim = (m, slug, path, what) => {
    if (!isStr(slug) || !RE.slug.test(slug)) return;
    const org = idx.routeOrg(m), key = `/models/${org}/${slug}/`;
    if (taken.has(key)) return cx.E("E03", m._file, path, `slug ${q(slug)} is already ${taken.get(key)} in ${org}`);
    taken.set(key, `${what} of ${m.id}`);
    routes.set(key, `${what} of ${m.id}`);
  };
  for (const m of models) claim(m, m.slug, "slug", "the slug");
  for (const m of models) m.previousSlugs.forEach((s, i) => claim(m, s, `previousSlugs[${i}]`, "a previous slug"));
  for (const m of cx.sds.models) m.previousRoutes.forEach((r, i) => {
    if (!isStr(r) || !ROUTE_RE.test(r)) return;
    if (routes.has(r)) return cx.E("E03", m._file, `previousRoutes[${i}]`, `route ${r} is already ${routes.get(r)}`);
    routes.set(r, `a previous route of ${m.id}`);
  });
}
// E05 over all relation types: the graph must be a DAG. Self-references are reported per
// relation; here each cycle is reported once, on the relation that closes it.
function checkCycles(cx) {
  const { idx } = cx;
  let edges = relationEdges(cx.sds).filter(e => e.from !== e.to && idx.modelById.has(e.to));
  for (let n = 0; n < 50; n++) {
    const cyc = findCycle(edges);
    if (!cyc) break;
    const [a, b] = cyc.slice(-2), m = idx.modelById.get(a), i = m.relations.findIndex(r => isObj(r) && r.target === b);
    cx.E("E05", m._file, `relations[${i}]`, `cycle in the relation graph: ${cyc.join(" -> ")}`);
    edges = edges.filter(e => !(e.from === a && e.to === b));
  }
}
function checkParentLoops(cx, list, file, label, kind) {
  const byId = new Map(list.filter(x => isStr(x.id)).map(x => [x.id, x])), reported = new Set();
  list.forEach((x, i) => {
    if (!isStr(x.id)) return;
    const seen = [x.id];
    let cur = byId.get(x.parentId);
    while (cur && !seen.includes(cur.id)) { seen.push(cur.id); cur = byId.get(cur.parentId); }
    if (!cur || cur.id !== x.id) return;
    const key = [...seen].sort().join("|");
    if (reported.has(key)) return;
    reported.add(key);
    cx.E("E05", file, `${label}[${i}].parentId`, `${kind} parents form a loop: ${seen.concat(x.id).join(" -> ")}`);
  });
}
function checkAliases(cx) {
  const owners = new Map();   // normalized alias -> Map(modelId -> { file, path })
  const note = (m, a, path) => {
    if (!isObj(a) || !isStr(a.text) || a.match === "never") return;
    const k = normalize(a.text);
    if (!owners.has(k)) owners.set(k, new Map());
    if (!owners.get(k).has(m.id)) owners.get(k).set(m.id, { file: m._file, path });
  };
  for (const m of cx.sds.models) {
    if (!isStr(m.id)) continue;
    m.aliases.forEach((a, i) => note(m, a, `aliases[${i}]`));
    m.variants.forEach((v, i) => isObj(v) && Array.isArray(v.aliases) && v.aliases.forEach((a, j) => note(m, a, `variants[${i}].aliases[${j}]`)));
  }
  for (const [k, byModel] of owners) if (byModel.size > 1) for (const [id, { file, path }] of byModel)
    cx.W("W01", file, path, `alias ${q(k)} is also used by ${[...byModel.keys()].filter(x => x !== id).join(", ")} (ambiguous for the news matcher)`);
}
function checkPaddedDays(cx) {
  const byOrg = new Map();
  for (const m of cx.sds.models) {
    const org = cx.idx.routeOrg(m);
    if (!org) continue;
    const dvs = [...DATE_KEYS.map(k => isObj(m.dates) && m.dates[k]), ...m.milestones.map(x => isObj(x) && x.date),
      ...m.variants.flatMap(v => (isObj(v) && isObj(v.dates) ? DATE_KEYS.map(k => v.dates[k]) : []))];
    const days = dvs.map(dv => isObj(dv) && parseDate(dv.value)).filter(p => p && p.precision === "day");
    if (!byOrg.has(org)) byOrg.set(org, []);
    byOrg.get(org).push(...days);
  }
  for (const [org, days] of byOrg) {
    const hits = days.filter(p => p.d === 1 || p.d === 15).length;
    if (days.length >= W12_MIN_DATES && hits / days.length > W12_SHARE)
      cx.W("W12", `records/${org}/`, "", `${hits} of ${days.length} day-precision dates fall on day 1 or 15; check that no unknown day was filled in`);
  }
}
// W18: the id in data.json leads (the feed build re-hashes on collisions, F6).
function checkNewsIds(cx) {
  const dj = cx.dataJson;
  if (!isObj(dj) || !Array.isArray(dj.items)) return;
  const byKey = new Map();
  for (const it of dj.items) if (isObj(it) && typeof it.link === "string") byKey.set(postKey(it.link), typeof it.id === "string" && RE.postId.test(it.id) ? it.id : postId(it.link));
  for (const m of cx.sds.models) if (isObj(m.news)) m.news.include.forEach((s, i) => {
    const id = isObj(s) && isStr(s.link) && byKey.get(postKey(s.link));
    if (id && isStr(s.postId) && id !== s.postId) cx.W("W18", m._file, `news.include[${i}].postId`, `data.json has id ${q(id)} for this link (re-hashed id?)`);
  });
  for (const s of cx.sds.sources) {
    const id = isStr(s.radarPostId) && isStr(s.url) && byKey.get(postKey(s.url));
    if (id && id !== s.radarPostId) { const { file, path } = cx.srcLoc.get(s); cx.W("W18", file, pj(path, "radarPostId"), `${tag(s)}data.json has id ${q(id)} for this URL`); }
  }
}

/* ---------- Repository guards ---------- */
// E18 (§22.2): the news id functions exist three times and must stay byte-identical. The
// reference is the lib.mjs next to this file (the copy the pipeline itself runs with); line
// endings do not count, so a CRLF checkout on Windows compares equal.
function checkIdFunctions(cx, repoRoot) {
  if (!repoRoot) return cx.W("E18", "", "", "no repository root given: id-function copies not compared");
  const ref = extractIdFunctions(readFileSync(LIB_FILE, "utf8"));
  if (!ref) return cx.E("E18", "scripts/model-history/lib.mjs", "", "cyrb53/postKey/postId not found");
  for (const rel of ["scripts/build-feed.mjs", "assets/app.js"]) {
    const p = join(repoRoot, rel);
    if (!existsSync(p)) { cx.W("E18", rel, "", "file not found: id-function copy not compared"); continue; }
    const copy = extractIdFunctions(readFileSync(p, "utf8"));
    if (!copy) { cx.E("E18", rel, "cyrb53/postKey/postId", "id functions not found; they must stay byte-identical to scripts/model-history/lib.mjs"); continue; }
    if (copy === ref) continue;
    const a = ref.split("\n"), b = copy.split("\n"), n = a.findIndex((l, i) => l !== b[i]);
    const line = n < 0 ? a.length + 1 : n + 1;
    cx.E("E18", rel, "cyrb53/postKey/postId", `not byte-identical to scripts/model-history/lib.mjs (first difference in line ${line} of the functions: ${q((b[line - 1] || "").trim())})`);
  }
}
// E29 (A5, AC-28): design prototypes live on their own branch, never on main.
function checkDesignGuard(cx, repoRoot, env) {
  if (!repoRoot) return;
  const d = join(repoRoot, "design");
  if (!existsSync(d) || !statSync(d).isDirectory()) return;
  if (env.GITHUB_REF === "refs/heads/main" || env.GITHUB_BASE_REF === "main")
    cx.E("E29", "design/", "", "design previews must not be on main (spec A5, AC-28); keep them on the design/model-history branch");
}

/* ---------- validate() ----------
   opts.registry: object with companies[] ({ id, aggregate? }); undefined = load
     <repoRoot>/assets/registry.js (a file that fails to load is E25); null or no such file =
     not available (E25/E04 become warnings).
   opts.dataJson: parsed data.json; undefined = <repoRoot>/data.json when present (unreadable =
     a W18 warning); null = skip W18.
   opts.repoRoot: repository root for E18/E29 (null skips them, E18 with a warning).
   opts.now (ms, Date or ISO string) and opts.env (default process.env) keep tests deterministic. */
// The registry is in the workflow's path filter so that a change to it gets validated: only a
// missing file means "not available"; a file that fails to run or sets no companies list is an
// error, never a silent downgrade of E25 to warnings.
function repoRegistry(cx, repoRoot) {
  const rel = "assets/registry.js";
  if (!existsSync(join(repoRoot, "assets", "registry.js"))) return null;
  let r;
  try { r = loadRegistry(repoRoot); } catch (e) { cx.E("E25", rel, "", `registry failed to load: ${e.message}`); return null; }
  if (!isObj(r) || !Array.isArray(r.companies)) { cx.E("E25", rel, "", "registry failed to load: window.AIRadarRegistry.companies is not a list"); return null; }
  return r;
}
// W18 is only a warning, so an unreadable data.json does not fail the run, but it is said.
function repoDataJson(cx, repoRoot) {
  const p = join(repoRoot, "data.json");
  if (!existsSync(p)) return null;
  let dj;
  try { dj = readJson(p); } catch (e) { cx.W("W18", "data.json", "", `data.json unreadable (${e.message}): W18 not checked`); return null; }
  if (!isObj(dj) || !Array.isArray(dj.items)) { cx.W("W18", "data.json", "items", "data.json has no items list: W18 not checked"); return null; }
  return dj;
}
export function validate(ds, opts = {}) {
  const out = [];
  const add = level => (code, file, path, message) => out.push({ code, level, file: file || "", path: path || "", message });
  const cx = { ds, E: add("error"), W: add("warning"), used: new Set(),
    now: opts.now === undefined ? Date.now() : new Date(opts.now).getTime() };
  const repoRoot = opts.repoRoot || null;
  const registry = opts.registry !== undefined ? opts.registry : repoRoot ? repoRegistry(cx, repoRoot) : null;
  cx.dataJson = opts.dataJson !== undefined ? opts.dataJson : repoRoot ? repoDataJson(cx, repoRoot) : null;
  cx.companies = registry ? (Array.isArray(registry) ? registry : Array.isArray(registry.companies) ? registry.companies : null) : null;
  checkFiles(cx);
  // Shape first, then index the shaped copy: every rule below may rely on lists being lists.
  cx.sds = { ...ds, organizations: ds.organizations.map((o, i) => shapeOrg(cx, o, i)), models: ds.models.map(m => shapeModel(cx, m)) };
  cx.idx = buildIndex(cx.sds);
  const perFile = new Map();
  cx.srcLoc = new Map(ds.sources.map(s => { const i = perFile.get(s._file) || 0; perFile.set(s._file, i + 1); return [s, { file: s._file, path: `sources[${i}]` }]; }));
  duplicateIds(cx, cx.sds.organizations, "organization", o => ({ file: "organizations.json", path: `organizations[${cx.sds.organizations.indexOf(o)}]` }));
  duplicateIds(cx, cx.sds.families, "family", x => ({ file: "families.json", path: `families[${cx.sds.families.indexOf(x)}]` }));
  duplicateIds(cx, cx.sds.models, "model", m => ({ file: m._file, path: "" }));
  duplicateIds(cx, cx.sds.sources, "source", s => cx.srcLoc.get(s));
  checkOrganizations(cx);
  checkFamilies(cx);
  for (const m of cx.sds.models) checkModel(cx, m);
  checkSources(cx);
  checkState(cx);
  checkRoutes(cx);
  checkCycles(cx);
  checkParentLoops(cx, cx.sds.organizations, "organizations.json", "organizations", "organization");
  checkParentLoops(cx, cx.sds.families, "families.json", "families", "family");
  checkAliases(cx);
  checkPaddedDays(cx);
  checkNewsIds(cx);
  for (const s of cx.sds.sources) if (isStr(s.id) && !cx.used.has(s.id)) { const { file, path } = cx.srcLoc.get(s); cx.W("W05", file, pj(path, "id"), `${s.id} is not used by any claim`); }
  checkIdFunctions(cx, repoRoot);
  checkDesignGuard(cx, repoRoot, opts.env || process.env);
  // Deterministic: errors first, then by file, path (list indexes numerically), code and message;
  // exact duplicates dropped.
  const rank = { error: 0, warning: 1 }, cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0), seen = new Set();
  const nat = s => s.replace(/\[(\d+)\]/g, (x, n) => `[${n.padStart(6, "0")}]`);
  return out.sort((a, b) => rank[a.level] - rank[b.level] || cmp(a.file, b.file) || cmp(nat(a.path), nat(b.path)) || cmp(a.code, b.code) || cmp(a.message, b.message))
    .filter(x => { const k = JSON.stringify(x); return !seen.has(k) && seen.add(k); });
}

/* ---------- CLI ---------- */
const USAGE = "usage: node scripts/model-history/validate.mjs [--data <dir>] [--repo <dir>] [--registry <path>|--no-registry] [--json]";
function parseArgs(argv) {
  const a = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], val = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
    if (k === "--data") a.data = val();
    else if (k === "--repo") a.repo = val();
    else if (k === "--registry") a.registry = val();
    else if (k === "--no-registry") a.noRegistry = true;
    else if (k === "--json") a.json = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}
// --registry takes a registry.js (classic script setting window.AIRadarRegistry) or a JSON file.
function loadRegistryFile(p) {
  let r;
  if (p.endsWith(".json")) r = readJson(p);
  else {
    const sandbox = { window: {} };
    vm.runInNewContext(readFileSync(p, "utf8"), sandbox, { filename: p });
    r = sandbox.window.AIRadarRegistry;
  }
  // An explicit --registry that yields no companies is a usage error, not "registry not available".
  if (!Array.isArray(r) && !(isObj(r) && Array.isArray(r.companies))) throw new Error("no companies list (expected window.AIRadarRegistry.companies or a JSON { companies: [] })");
  return r;
}
function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message + "\n" + USAGE); process.exitCode = 2; return; }
  if (args.help) { console.log(USAGE); return; }
  const repo = resolve(args.repo || process.cwd());
  // resolve() also drops a trailing slash, which loadDataset's relative paths cannot handle.
  const data = resolve(args.data || join(repo, "model-history"));
  let registry;   // undefined: validate() loads <repo>/assets/registry.js
  try { registry = args.noRegistry ? null : args.registry ? loadRegistryFile(resolve(args.registry)) : undefined; }
  catch (e) { console.error(`cannot load registry ${args.registry}: ${e.message}`); process.exitCode = 2; return; }
  const ds = loadDataset(data);
  const findings = validate(ds, { registry, repoRoot: repo });
  const errors = findings.filter(x => x.level === "error").length, warnings = findings.length - errors;
  if (args.json) console.log(JSON.stringify(findings, null, 2));
  else {
    for (const x of findings) console.log(`${x.code} ${x.level}  ${x.file || "-"}  ${x.path || "-"}  ${x.message}`);
    const byCode = {};
    for (const x of findings) byCode[x.code] = (byCode[x.code] || 0) + 1;
    if (findings.length) console.log("");
    console.log(`Model History validation: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} ` +
      `(${ds.models.length} models, ${ds.organizations.length} organizations, ${ds.families.length} families, ${ds.sources.length} sources)` +
      (findings.length ? `\nby code: ${Object.keys(byCode).sort().map(k => `${k} ${byCode[k]}`).join(", ")}` : ""));
  }
  process.exitCode = errors ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main();
