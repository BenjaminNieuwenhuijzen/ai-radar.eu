/* Model History: derivations shared by the validator and the generator.
   Everything here is pure: it reads a loaded dataset (lib.mjs loadDataset) plus the
   machine state and returns new structures. Nothing is written.

   Sections: index · claims (the normative list) · availability & provenance · evidence ·
   relations graph · timeline. */
import { SECONDARY_MIN, CAPABILITY_KEYS, idLocal, parseDate, sortKey, toInstant } from "./lib.mjs";

/* ---------- Index ---------- */
export function buildIndex(ds) {
  const orgById = new Map(ds.organizations.map(o => [o.id, o]));
  const famById = new Map(ds.families.map(f => [f.id, f]));
  const modelById = new Map(ds.models.map(m => [m.id, m]));
  const srcById = new Map(ds.sources.map(s => [s.id, s]));
  const status = (ds.state.sourceStatus && ds.state.sourceStatus.sources) || {};
  // Top-level ancestor of an organisation (follows parentId; stops on a loop).
  const topOrg = id => {
    const seen = new Set();
    let o = orgById.get(id);
    while (o && o.parentId && orgById.has(o.parentId) && !seen.has(o.id)) { seen.add(o.id); o = orgById.get(o.parentId); }
    return o ? o.id : null;
  };
  const primaryDev = m => ((m.organizations || []).find(x => x.role === "developer" && x.primary) || {}).id || null;
  const routeOrg = m => { const p = primaryDev(m); return p ? topOrg(p) : null; };
  const unitsOf = orgId => ds.organizations.filter(o => o.id !== orgId && topOrg(o.id) === orgId).map(o => o.id);
  return { orgById, famById, modelById, srcById, status, topOrg, primaryDev, routeOrg, unitsOf };
}

/* ---------- Claims ----------
   The normative claim list (spec §19.1). Each entry: { path, kind, claim }.
   kind: "date" | "lifecycle" | "replacedBy" | "milestone" | "relation" | "change" |
         "capability" | "feature" | "summary" | "variant" | "variant-date" |
         "description" | "formerName" | "chapter" */
export function modelClaims(m) {
  const out = [];
  const add = (path, kind, claim) => { if (claim && typeof claim === "object") out.push({ path, kind, claim }); };
  const d = m.dates || {};
  for (const k of ["announced", "released", "deprecated", "retired"]) if (d[k]) add(`dates.${k}`, "date", d[k]);
  add("lifecycle", "lifecycle", m.lifecycle);
  if (m.replacedBy) add("replacedBy", "replacedBy", m.replacedBy);
  (m.milestones || []).forEach((x, i) => x && x.date && add(`milestones[${i}].date`, "milestone", x.date));
  (m.relations || []).forEach((x, i) => add(`relations[${i}]`, "relation", x));
  (m.changes || []).forEach((x, i) => add(`changes[${i}]`, "change", x));
  const c = m.capabilities || {};
  for (const k of CAPABILITY_KEYS) if (c[k]) add(`capabilities.${k}`, "capability", c[k]);
  (c.features || []).forEach((x, i) => add(`capabilities.features[${i}]`, "feature", x));
  if (m.summary) add("summary", "summary", m.summary);
  (m.variants || []).forEach((v, i) => {
    if (v && Array.isArray(v.sources)) add(`variants[${i}]`, "variant", v);
    const vd = (v && v.dates) || {};
    for (const k of ["announced", "released", "deprecated", "retired"]) if (vd[k]) add(`variants[${i}].dates.${k}`, "variant-date", vd[k]);
  });
  return out;
}
export function orgClaims(o) {
  const out = [];
  if (o.description) out.push({ path: "description", kind: "description", claim: o.description });
  (o.formerNames || []).forEach((x, i) => out.push({ path: `formerNames[${i}]`, kind: "formerName", claim: x }));
  ((o.narrative && o.narrative.chapters) || []).forEach((x, i) => out.push({ path: `narrative.chapters[${i}]`, kind: "chapter", claim: x }));
  return out;
}
export const TEXT_CLAIM_KINDS = new Set(["summary", "change", "description", "chapter", "formerName", "relation"]);
// Claims whose empty sources are allowed (with a note) and which assert no sourced fact.
export function isNonAssertion(c) {
  if (c.kind === "capability" || c.kind === "feature") return !!c.claim.disclosure && c.claim.disclosure !== "official";
  return false;
}
export function emptySourcesAllowed(c) {
  if (c.kind === "lifecycle") return c.claim.value === "unknown";
  // A date whose value is unknown asserts nothing (spec §9.4); the note says why.
  if (c.kind === "date" || c.kind === "variant-date" || c.kind === "milestone") return c.claim.value === null;
  return isNonAssertion(c);
}

/* ---------- Availability & provenance ----------
   Curator verdict (source record) vs machine observation (state/source-status.json):
   the machine wins only after a state transition later than the curator's check, so a
   repeated "ok" never undoes a newer curator verdict (spec §17.3). */
export function effAvail(src, st) {
  let basis = src.availability || "unknown";
  // Observations of a URL the curator has since replaced say nothing about the new one.
  if (st && st.url && st.url !== src.url) st = null;
  if (src.healthCheck !== "skip" && st && st.state && st.state !== "unknown" && st.stateSince) {
    const machineAt = Date.parse(st.stateSince), curatorAt = toInstant(src.lastCheckedAt);
    if (curatorAt === null || machineAt > curatorAt) basis = st.state;
  }
  const archiveGone = !!(st && st.archiveState === "gone");
  if ((basis === "unavailable" || basis === "archived") && src.archiveUrl && !archiveGone) return "archived";
  if (basis === "archived" && (!src.archiveUrl || archiveGone)) return "unavailable";
  return basis;
}
export function effProv(src, avail) {
  if (src.provenance === "secondary") return "secondary";
  if (src.provenance === "archived-primary") return "archived-primary";
  return avail === "archived" ? "archived-primary" : "primary";
}
export function sourceView(src, idx) {
  const st = idx.status[src.id] || null;
  const avail = effAvail(src, st);
  return { avail, prov: effProv(src, avail), archiveGone: !!(st && st.archiveState === "gone") };
}

/* ---------- Evidence ---------- */
export const EVIDENCE = ["primary-source", "archived-primary-source", "secondary-sources", "insufficient-evidence"];
export function claimEvidence(c, idx) {
  if (isNonAssertion(c) && !(c.claim.sources || []).length) return { evidence: "not-applicable", originalUnavailable: false };
  const refs = (c.claim.sources || []).map(r => idx.srcById.get(r && r.id)).filter(Boolean);
  const views = refs.map(s => ({ s, ...sourceView(s, idx) }));
  const primaryActive = views.some(v => v.prov === "primary" && v.avail === "active");
  const originalGone = views.some(v => (v.prov === "primary" || v.prov === "archived-primary") && (v.avail === "archived" || v.avail === "unavailable"));
  let evidence = "insufficient-evidence";
  if (primaryActive) evidence = "primary-source";
  else if (views.some(v => v.prov === "archived-primary" && v.s.archiveUrl && !v.archiveGone)) evidence = "archived-primary-source";
  else {
    const pubs = new Set(views.filter(v => v.prov === "secondary" && (v.avail === "active" || v.avail === "archived")).map(v => (v.s.publisher || "").trim().toLowerCase()));
    if (pubs.size >= SECONDARY_MIN) evidence = "secondary-sources";
  }
  return { evidence, originalUnavailable: originalGone && !primaryActive };
}
// Only a value that parses counts; an unknown release date falls back to the announcement.
export function timelineDate(m) {
  const d = m.dates || {};
  if (d.released && parseDate(d.released.value)) return { dv: d.released, kind: "released", path: "dates.released" };
  if (d.announced && parseDate(d.announced.value)) return { dv: d.announced, kind: "announced", path: "dates.announced" };
  return null;
}
export function modelEvidence(m, idx) {
  const claims = modelClaims(m).map(c => ({ ...c, ...claimEvidence(c, idx) }));
  const td = timelineDate(m);
  const tdClaim = td && claims.find(c => c.path === td.path);
  const evidence = tdClaim ? tdClaim.evidence : "insufficient-evidence";
  const flags = [];
  if (tdClaim && tdClaim.originalUnavailable) flags.push("original-unavailable");
  if (claims.some(c => c.evidence === "insufficient-evidence")) flags.push("some-claims-incomplete");
  const summary = Object.fromEntries(EVIDENCE.map(e => [e, 0]));
  let originalUnavailable = 0;
  for (const c of claims) { if (c.evidence in summary) summary[c.evidence]++; if (c.originalUnavailable) originalUnavailable++; }
  summary.originalUnavailable = originalUnavailable;
  return { evidence, flags, summary, claims };
}

/* ---------- Relations graph ---------- */
const PARENT_TYPES = new Set(["variant-of", "revision-of", "derived-from"]);
const SIBLING_TYPES = new Set(["variant-of", "revision-of"]);
export function relationEdges(ds) {
  const edges = [];
  for (const m of ds.models) for (const r of m.relations || []) if (r && r.target) edges.push({ from: m.id, type: r.type, to: r.target, rel: r });
  return edges;
}
// Cycle check over all relation types (the whole graph must be a DAG). Returns one cycle or null.
export function findCycle(edges) {
  const adj = new Map();
  for (const e of edges) { if (!adj.has(e.from)) adj.set(e.from, []); adj.get(e.from).push(e.to); }
  const state = new Map(), stack = [];
  const visit = n => {
    state.set(n, 1); stack.push(n);
    for (const t of adj.get(n) || []) {
      if (state.get(t) === 1) return stack.slice(stack.indexOf(t)).concat(t);
      if (!state.get(t)) { const c = visit(t); if (c) return c; }
    }
    state.set(n, 2); stack.pop();
    return null;
  };
  for (const n of [...adj.keys()].sort()) if (!state.get(n)) { const c = visit(n); if (c) return c; }
  return null;
}
const sortIds = s => [...s].sort();
export function deriveGraph(ds) {
  const edges = relationEdges(ds);
  const ids = ds.models.map(m => m.id);
  const init = () => new Map(ids.map(id => [id, new Set()]));
  const pred = init(), succ = init(), par = init(), chi = init(), sibParents = init();
  for (const e of edges) {
    if (!pred.has(e.from)) continue;
    if (e.type === "successor-of") { pred.get(e.from).add(e.to); if (succ.has(e.to)) succ.get(e.to).add(e.from); }
    else if (PARENT_TYPES.has(e.type)) {
      par.get(e.from).add(e.to); if (chi.has(e.to)) chi.get(e.to).add(e.from);
      if (SIBLING_TYPES.has(e.type)) sibParents.get(e.from).add(e.to);
    }
  }
  const siblings = init();
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    for (const p of sibParents.get(a)) if (sibParents.get(b).has(p)) { siblings.get(a).add(b); break; }
  }
  const closure = (start, next) => {
    const out = new Set(), todo = [...next.get(start) || []];
    while (todo.length) { const n = todo.pop(); if (out.has(n) || n === start) continue; out.add(n); for (const x of next.get(n) || []) todo.push(x); }
    return out;
  };
  const up = new Map(ids.map(id => [id, new Set([...pred.get(id), ...par.get(id)])]));
  const down = new Map(ids.map(id => [id, new Set([...succ.get(id), ...chi.get(id)])]));
  const g = {};
  for (const id of ids) g[id] = {
    predecessors: sortIds(pred.get(id)), successors: sortIds(succ.get(id)),
    parents: sortIds(par.get(id)), children: sortIds(chi.get(id)), siblings: sortIds(siblings.get(id)),
    ancestors: sortIds(closure(id, up)), descendants: sortIds(closure(id, down))
  };
  return { edges, byModel: g };
}

/* ---------- Timeline ---------- */
export function modelSortKey(m) { const td = timelineDate(m); return td ? sortKey(td.dv.value) : sortKey(null); }
export function yearOf(m) { const td = timelineDate(m); const p = td && parseDate(td.dv.value); return p ? p.y : null; }
export const fileNameFor = (m, idx) => `records/${idx.routeOrg(m)}/${idLocal(m.id)}.json`;
