// Model History page generator (spec §27.1). Compiles the curated data in model-history/
// plus the machine state into static, same-origin pages and JSON:
//   models/index.html, models/index.json                 Explorer + search index (§6, §23.1)
//   models/<org>/index.html, models/<org>/index.json     Company Model History (§7, §5.2)
//   models/<org>/<slug>/index.html                       Model Detail (§8), plus redirect stubs (§5.4)
//   sitemap-models.xml                                   indexable pages only (§30)
// Node built-ins only. Deterministic: sorted keys, stable order, no timestamps in HTML;
// "generated" in the JSON only changes when the rest of that file changes.
//
// Usage: node scripts/model-history/build.mjs [--data <dir>] [--out <dir>] [--sitemap <file>]
//        [--repo <dir>] [--publish]
// Publish gate (§27.9): files are written only with --publish or MODEL_HISTORY_PUBLISH=on;
// otherwise the build validates and reports what it would write.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, lstatSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute, basename, parse as parsePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SITE, RE, idPrefix, normalize, fold, parseDate, toInstant, loadDataset, loadRegistry } from "./lib.mjs";
import { buildIndex, deriveGraph, modelEvidence, orgClaims, claimEvidence, sourceView, timelineDate, modelSortKey } from "./derive.mjs";
import { explorerPage, companyPage, modelPage, timelinePage, redirectPage } from "./templates.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const readOr = p => { try { return readFileSync(p, "utf8"); } catch (e) { return null; } };
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BUDGET = { model: 60 * 1024, company: 150 * 1024, index: 350 * 1024 };   // §32
const TWO_DAYS = 2 * 86400000;
const UNKNOWN_KEY = "9999-99-99-9";

// Route segments that may become a path inside the output directory: <org>/, <org>/<slug>/.
// The last guard against a bad id writing outside it when validation is skipped (C8).
// /models/, /models/<org>/, /models/<org>/<slug>/ and the per-model timeline /models/<org>/<slug>/timeline/.
const OUT_PATH = /^(?:(?:[a-z0-9]+(?:-[a-z0-9]+)*\/){0,2}index\.(?:html|json)|[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/timeline\/index\.html)$/;

/* ---------- News (state links + news.include − news.exclude, §22) ---------- */
const newsTime = n => { const t = Date.parse(n && n.publishedAt); return Number.isNaN(t) ? null : t; };
const validSnap = n => n && typeof n.postId === "string" && RE.postId.test(n.postId) && typeof n.link === "string" && typeof n.title === "string" && newsTime(n) !== null;
function addModels(target, list) {
  for (const x of list) if (!target.some(y => y.id === x.id && y.variantId === x.variantId)) target.push(x);
  target.sort((a, b) => cmp(a.id, b.id) || cmp(a.variantId || "", b.variantId || ""));
}
// One entry per post, newest first; the same story under two post ids (Google News
// redirect links) is merged when the normalised titles match within 2 days (§22.4).
export function displayNews(list) {
  const byPost = new Map();
  for (const n of list) {
    if (!validSnap(n)) continue;
    const prev = byPost.get(n.postId);
    if (prev) addModels(prev.models, n.models); else byPost.set(n.postId, { ...n, models: [...n.models] });
  }
  const sorted = [...byPost.values()].sort((a, b) => newsTime(b) - newsTime(a) || cmp(a.postId, b.postId));
  const kept = [];
  for (const n of sorted) {
    const same = kept.find(k => normalize(k.title) === normalize(n.title) && Math.abs(newsTime(k) - newsTime(n)) <= TWO_DAYS);
    if (same) addModels(same.models, n.models); else kept.push(n);
  }
  return kept;
}
const snap = (n, modelId) => ({ postId: n.postId, variantId: n.variantId || null, link: n.link, title: n.title, publishedAt: n.publishedAt,
  dateOnly: !!n.dateOnly, company: n.company || null, source: n.source || null, models: [{ id: modelId, variantId: n.variantId || null }] });
function newsFor(m, links) {
  const excl = new Set(((m.news && m.news.exclude) || []).filter(x => typeof x === "string"));
  const include = ((m.news && m.news.include) || []).map(n => snap(n || {}, m.id));   // curated snapshots first
  const state = links.filter(l => l && l.modelId === m.id).map(l => snap(l, m.id));
  return displayNews([...include, ...state].filter(n => !excl.has(n.postId)));
}

// Every source id a record refers to, in document order (claims, alternatives, variants...).
function refIds(obj, out = new Set()) {
  if (Array.isArray(obj)) obj.forEach(x => refIds(x, out));
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (k === "sources" && Array.isArray(v)) v.forEach(r => r && typeof r.id === "string" && out.add(r.id));
      else if (k !== "news" && k !== "_file") refIds(v, out);
    }
  }
  return out;
}

/* ---------- Compile: lookups and derivations (§27.1 steps 1–2) ---------- */
export function compile(ds, { registry = null } = {}) {
  const idx = buildIndex(ds);
  const graph = deriveGraph(ds);
  const warnings = [];
  const links = (ds.state.newsLinks && Array.isArray(ds.state.newsLinks.links)) ? ds.state.newsLinks.links : [];
  const org = id => idx.orgById.get(id) || null;
  const orgName = id => (org(id) || {}).name || id;
  const regCompanies = registry && Array.isArray(registry.companies) ? registry.companies : [];
  // Tracked organisations take hue and inline logo from the registry, others their own hue.
  const styles = new Map();
  const style = id => {
    if (!styles.has(id)) {
      const o = org(id), top = org(idx.topOrg(id));
      const own = o && (o.radarCompanyId || Number.isFinite(o.hue)) ? o : top || o;
      const co = own && own.radarCompanyId ? regCompanies.find(c => c && c.id === own.radarCompanyId) : null;
      const hue = co ? co.hue : own && Number.isFinite(own.hue) ? own.hue : null;
      styles.set(id, { hue: Number.isFinite(hue) ? hue : null, logo: co && typeof co.logo === "string" ? co.logo : null });
    }
    return styles.get(id);
  };

  const models = [], modelById = new Map(), routes = new Set();
  for (const m of [...ds.models].sort((a, b) => cmp(a.id, b.id))) {
    const r = idx.routeOrg(m);
    // Both route segments must be well-formed ids: they become directories in the output.
    if (!m.id || !r || !RE.org.test(r) || typeof m.slug !== "string" || !RE.slug.test(m.slug)) { warnings.push(`skipped ${m.id || m._file}: no valid route (primary developer or slug)`); continue; }
    const url = `/models/${r}/${m.slug}/`;
    if (routes.has(url) || modelById.has(m.id)) { warnings.push(`skipped ${m.id}: duplicate id or route ${url}`); continue; }
    routes.add(url);
    // Undisclosed capabilities without sources stay "not-applicable": no claim, no evidence gap (§9.4).
    const ev = modelEvidence(m, idx);
    const info = { m, id: m.id, org: r, slug: m.slug, url, td: timelineDate(m), key: modelSortKey(m), ev,
      claims: new Map(ev.claims.map(c => [c.path, c])), news: newsFor(m, links), g: graph.byModel[m.id],
      outRel: (m.relations || []).map((rel, k) => ({ r: rel, path: `relations[${k}]`, target: rel && rel.target })).filter(x => x.r && x.target),
      refIds: [...refIds(m)] };
    models.push(info); modelById.set(m.id, info);
  }
  const chrono = list => [...list].sort((a, b) => cmp(a.key, b.key) || cmp(a.m.name, b.m.name) || cmp(a.id, b.id));
  const sortIds = ids => chrono(ids.map(id => modelById.get(id)).filter(Boolean)).map(i => i.id).concat(ids.filter(id => !modelById.has(id)).sort());
  // Newest first by timeline date; unknown dates last (§6, O7).
  const explorer = [...models].sort((a, b) => ((a.key === UNKNOWN_KEY) - (b.key === UNKNOWN_KEY)) || cmp(b.key, a.key) || cmp(a.m.name, b.m.name) || cmp(a.id, b.id));

  // Incoming relations (stored once on the younger/derived model, §12.3).
  const inRel = new Map();
  for (const i of models) for (const x of i.outRel) {
    if (!inRel.has(x.target)) inRel.set(x.target, []);
    inRel.get(x.target).push({ from: i.id, r: x.r, path: x.path });
  }
  // Promoted variants leave an anchor on the old record's page (§13.1).
  const promotedTo = new Map();
  for (const i of models) {
    const [from, variantId] = typeof i.m.promotedFrom === "string" ? i.m.promotedFrom.split("#") : [];
    if (from && variantId && modelById.has(from) && RE.local.test(variantId)) {
      if (!promotedTo.has(from)) promotedTo.set(from, []);
      promotedTo.get(from).push({ variantId, info: i });
    }
  }

  // Company pages: every top-level organisation with ≥ 1 model, as primary route or as
  // co-developer/publisher, so no organisation link ends on a 404 (§5.1, §7).
  const pages = new Map();
  const pageOf = id => { if (!pages.has(id)) pages.set(id, { routed: [], coDev: [] }); return pages.get(id); };
  for (const i of models) pageOf(i.org).routed.push(i);
  for (const i of models) for (const x of i.m.organizations || []) {
    const top = x && idx.topOrg(x.id);
    if (top && top !== i.org && org(top) && !pageOf(top).coDev.includes(i)) pageOf(top).coDev.push(i);
  }
  for (const id of pages.keys()) if (!RE.org.test(id)) warnings.push(`no company page for organisation ${JSON.stringify(id)}: not a valid route id`);
  const orgs = [...pages.keys()].filter(id => org(id) && RE.org.test(id)).sort().map(id => {
    const o = org(id), p = pages.get(id);
    const claims = new Map(orgClaims(o).map(c => [c.path, { ...c, ...claimEvidence(c, idx) }]));
    const famIds = new Set(ds.families.filter(f => f && idx.topOrg(f.organizationId) === id).map(f => f.id));
    for (const i of p.routed) if (i.m.familyId && idx.famById.has(i.m.familyId)) famIds.add(i.m.familyId);
    const families = [...famIds].sort().map(fid => idx.famById.get(fid));
    // A family description is a Claim (§11.2) but not in the §19.1 list; it is shown with
    // its own evidence like the organisation facts. Path = its place in families.json.
    const famClaims = new Map(families.map(f => {
      const d = f.description, k = ds.families.indexOf(f);
      if (!d || typeof d !== "object" || typeof d.text !== "string") return [f.id, null];
      const c = { path: `families[${k}].description`, kind: "description", claim: d };
      return [f.id, { ...c, ...claimEvidence(c, idx) }];
    }));
    const news = displayNews(p.routed.flatMap(i => i.news));
    return { o, id, url: `/models/${id}/`, routed: chrono(p.routed), coDev: chrono(p.coDev), claims, families, famClaims, news,
      indexable: p.routed.some(i => i.m.coverage === "full") };
  });
  const orgById = new Map(orgs.map(o => [o.id, o]));

  // Old slugs and routes become redirect stubs, unless a real page lives there (§5.4).
  const redirects = [];
  const ROUTE = /^\/models\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
  for (const i of models) {
    const olds = (i.m.previousSlugs || []).filter(s => typeof s === "string" && RE.slug.test(s)).map(s => `/models/${i.org}/${s}/`);
    for (const p of i.m.previousRoutes || []) {
      // Only well-formed /models/<org>/<slug>/ paths, so a stub can never land outside models/.
      const r = typeof p === "string" && ROUTE.exec(p);
      if (r) olds.push(`/models/${r[1]}/${r[2]}/`); else warnings.push(`${i.id}: ignored previousRoutes entry ${JSON.stringify(p)}`);
    }
    for (const from of olds) {
      if (from === i.url || routes.has(from)) { warnings.push(`${i.id}: old route ${from} is in use; no redirect stub`); continue; }
      routes.add(from);
      redirects.push({ from, to: i });
    }
  }

  const source = id => {
    const s = idx.srcById.get(id);
    if (!s) return null;
    const v = sourceView(s, idx), st = idx.status[id];
    // Last check: the later of the curator's check and the machine's (unless checks are skipped).
    let last = s.lastCheckedAt || null;
    if (s.healthCheck !== "skip" && st && st.lastCheckedAt && (toInstant(st.lastCheckedAt) || 0) > (toInstant(last) || 0)) last = st.lastCheckedAt;
    return { s, avail: v.avail, prov: v.prov, archiveGone: v.archiveGone, lastChecked: last };
  };

  // "As of" day for the model timelines: the newest day the data itself mentions (checks,
  // reviews, news). Not the clock, so the same input always gives the same pages (AC-26);
  // assets/model-pages.js moves the marker to the real today in the browser.
  const days = [];
  const day = v => { if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && parseDate(v.slice(0, 10))) days.push(v.slice(0, 10)); };
  ds.sources.forEach(s => day(s && s.lastCheckedAt));
  Object.values(idx.status).forEach(st => st && day(st.lastCheckedAt));
  links.forEach(l => l && day(l.publishedAt));
  ds.models.forEach(m => m && day(m.lastReviewedAt));
  const asOf = days.length ? days.sort()[days.length - 1] : null;

  const site = { ds, idx, graph, registry, warnings, models, modelById, explorer, orgs, orgById, redirects, inRel, promotedTo,
    famById: idx.famById, org, orgName, topOrg: idx.topOrg, unitsOf: idx.unitsOf, style, source, chrono, sortIds, asOf };
  for (const o of orgs) o.graph = orgGraph(site, o);
  return site;
}

/* ---------- JSON (§23.1, §5.2) ---------- */
const GEN = "@@GENERATED@@";
const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);
const toJson = v => JSON.stringify(sortKeys(v)) + "\n";
const dateOut = td => (td ? { v: td.dv.value, k: td.kind, q: td.dv.qualifier || null } : null);
const uniq = list => [...new Set(list.filter(Boolean))];

// Search names of an organisation: current name, aliases, former names (and its units').
// Folded like the search term (NFKC, dashes, lowercase, no diacritics, §23.2).
function orgNames(site, o) {
  const all = [o, ...site.unitsOf(o.id).map(site.org).filter(Boolean)];
  return uniq(all.flatMap(x => [x.name, ...(x.aliases || []), ...(x.formerNames || []).map(f => f && f.name)]).filter(t => typeof t === "string").map(fold));
}
export function indexJson(site) {
  const fams = uniq(site.models.map(i => i.m.familyId)).sort().map(id => site.famById.get(id)).filter(Boolean);
  return {
    schemaVersion: 1, generated: GEN,
    organizations: site.orgs.filter(o => o.routed.length).map(o => ({ id: o.id, name: o.o.name, names: orgNames(site, o.o),
      radarCompanyId: o.o.radarCompanyId || null, models: o.routed.length })),
    // The organisation of a family or model follows from its id prefix; "org" is only
    // present where it does not (a unit's model, or a model that moved).
    families: fams.map(f => {
      const top = site.topOrg(f.organizationId);
      return { id: f.id, name: f.name, ...(top && top !== idPrefix(f.id) ? { org: top } : {}) };
    }),
    models: site.explorer.map(i => {
      const m = i.m, ow = m.capabilities && m.capabilities.openWeights;
      const alias = uniq([...(m.aliases || []).map(a => a && a.text), ...(m.variants || []).flatMap(v => [v && v.name, ...((v && v.aliases) || []).map(a => a && a.text)])]
        .map(t => (typeof t === "string" && t ? fold(t) : null))).filter(a => a !== fold(m.name));
      return { id: i.id, slug: i.slug, name: m.name, alias, family: m.familyId || null, gen: m.generation || null, cats: m.categories || [],
        prom: m.prominence || null, date: dateOut(i.td), life: (m.lifecycle && m.lifecycle.value) || "unknown", ev: i.ev.evidence, flags: i.ev.flags,
        open: ow && typeof ow.value === "boolean" ? ow.value : null, news: i.news.length,
        ...(idPrefix(i.id) !== i.org ? { org: i.org } : {}) };
    })
  };
}
const nodeOf = i => ({ name: i.m.name, org: i.org, slug: i.slug, date: dateOut(i.td), coverage: i.m.coverage || null });
const GRAPH_KEYS = ["predecessors", "successors", "parents", "children", "siblings", "ancestors", "descendants"];
function orgGraph(site, o) {
  const own = new Set(o.routed.map(i => i.id)), all = new Set([...own, ...o.coDev.map(i => i.id)]);
  const edges = site.graph.edges.filter(e => all.has(e.from) || all.has(e.to))
    .map(e => ({ from: e.from, type: e.type, to: e.to, method: e.rel.method || null, basis: e.rel.basis || null }))
    .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.type, b.type));
  // Every model a view of this organisation can reach without loading a second file (§12.5):
  // the derived sets of its own models, both ends of every listed edge, co-developed models.
  const ext = new Set(o.coDev.map(i => i.id));
  for (const id of own) for (const k of GRAPH_KEYS) for (const x of site.modelById.get(id).g[k]) if (!own.has(x)) ext.add(x);
  for (const e of edges) for (const x of [e.from, e.to]) if (!own.has(x)) ext.add(x);
  for (const ch of (o.o.narrative && o.o.narrative.chapters) || []) for (const x of ch.modelIds || []) if (!own.has(x)) ext.add(x);
  const externalNodes = Object.fromEntries([...ext].filter(id => site.modelById.has(id)).sort().map(id => [id, nodeOf(site.modelById.get(id))]));
  return { edges, externalNodes };
}
// The organisation graph (edges and externalNodes) is published in models/<org>/index.json;
// the company page no longer embeds a copy (no script read it, and §32 caps the page).
const strip = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
const newsOut = (n, withModels) => ({ postId: n.postId, variantId: n.variantId, link: n.link, title: n.title, publishedAt: n.publishedAt,
  dateOnly: n.dateOnly, company: n.company, source: n.source, ...(withModels ? { models: n.models } : {}) });
function claimOut(c) { return { ...strip(c.claim, []), evidence: c.evidence, originalUnavailable: !!c.originalUnavailable }; }
export function orgJson(site, o) {
  const oo = o.o, cl = o.claims;
  const srcIds = new Set(refIds(strip(oo, ["_file"])));
  for (const f of o.families) refIds(f.description, srcIds);
  const models = o.routed.map(i => {
    i.refIds.forEach(id => srcIds.add(id));
    const rec = strip(i.m, ["_file", "schemaVersion", "notes", "news"]);
    return { ...rec,
      relations: (i.m.relations || []).map(r => {
        const t = r && site.modelById.get(r.target);
        return { ...r, targetName: t ? t.m.name : null, targetOrg: t ? t.org : null, targetUrl: t ? t.url : null };
      }),
      org: i.org, url: i.url, timeline: dateOut(i.td), sortKey: i.key,
      evidence: { status: i.ev.evidence, flags: i.ev.flags, summary: i.ev.summary },
      claims: Object.fromEntries(i.ev.claims.map(c => [c.path, { evidence: c.evidence, originalUnavailable: !!c.originalUnavailable }])),
      graph: Object.fromEntries(GRAPH_KEYS.map(k => [k, i.g[k]])),
      news: i.news.map(n => newsOut(n, false)) };
  });
  const sources = {};
  for (const id of [...srcIds].sort()) {
    const v = site.source(id);
    if (v) sources[id] = { ...strip(v.s, ["_file", "notes"]), effective: { availability: v.avail, provenance: v.prov, archiveGone: v.archiveGone }, lastChecked: v.lastChecked };
  }
  const chapters = ((oo.narrative && oo.narrative.chapters) || []).map((ch, k) => {
    const c = cl.get(`narrative.chapters[${k}]`);
    return { ...(c ? claimOut(c) : ch), modelIds: (ch.modelIds || []).filter(id => site.modelById.has(id)) };
  });
  return {
    schemaVersion: 1, generated: GEN,
    organization: { id: oo.id, name: oo.name, type: oo.type || null, website: oo.website || null, radarCompanyId: oo.radarCompanyId || null,
      coverage: oo.coverage || null, hue: site.style(oo.id).hue, aliases: oo.aliases || [], url: o.url, indexable: o.indexable,
      formerNames: (oo.formerNames || []).map((f, k) => (cl.get(`formerNames[${k}]`) ? claimOut(cl.get(`formerNames[${k}]`)) : f)),
      units: site.unitsOf(oo.id).map(site.org).filter(Boolean).map(u => ({ id: u.id, name: u.name, type: u.type || null, aliases: u.aliases || [] })),
      description: cl.get("description") ? claimOut(cl.get("description")) : null,
      narrative: chapters.length ? { chapters } : null },
    families: o.families.map(f => {
      const c = o.famClaims.get(f.id);
      return { ...strip(f, ["_file"]), ...(c ? { description: claimOut(c) } : {}), models: o.routed.filter(i => i.m.familyId === f.id).map(i => i.id) };
    }),
    models,
    coDeveloped: o.coDev.map(i => i.id),
    edges: o.graph.edges,
    externalNodes: o.graph.externalNodes,
    sources,
    news: o.news.map(n => newsOut(n, true))
  };
}

/* ---------- Sitemap (§30): indexable pages only ---------- */
// The Explorer is indexable once one full record exists (decision 13 of the launch checklist,
// replacing "always" of §5.1: an empty or stub-only Explorer is never indexed), and is then
// listed here, like its robots meta.
export const hasFullRecord = site => site.models.some(i => i.m.coverage === "full");
export function sitemapXml(site) {
  const urls = hasFullRecord(site) ? [{ loc: SITE + "/models/" }] : [];
  for (const o of site.orgs) if (o.indexable) urls.push({ loc: SITE + o.url });
  for (const i of site.models) if (i.m.coverage === "full") {
    // lastmod only where it is verifiably right: the curator's review date (§30).
    const lm = typeof i.m.lastReviewedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(i.m.lastReviewedAt) && parseDate(i.m.lastReviewedAt) ? i.m.lastReviewedAt : null;
    urls.push({ loc: SITE + i.url, lastmod: lm });
    urls.push({ loc: SITE + i.url + "timeline/", lastmod: lm });   // same indexing rule as the model page
  }
  urls.sort((a, b) => cmp(a.loc, b.loc));
  const xmlEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>\n    <loc>${xmlEsc(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ""}\n  </url>`).join("\n")}
</urlset>
`;
}

/* ---------- Render (§27.1 steps 3–5) ---------- */
// Returns the output tree as { "<path inside out dir>": text } plus the sitemap. JSON
// files still carry the "generated" placeholder; finalize() resolves it.
export function renderSite(site) {
  const files = new Map(), warn = site.warnings;
  const put = (rel, text) => {
    if (!OUT_PATH.test(rel)) warn.push(`refused output path ${JSON.stringify(rel)}: not a /models/ route`);
    else if (files.has(rel)) warn.push(`duplicate output path ${rel}; kept the first`);
    else files.set(rel, text);
  };
  put("index.html", explorerPage(site));
  put("index.json", toJson(indexJson(site)));
  for (const o of site.orgs) {
    put(`${o.id}/index.html`, companyPage(site, o));
    put(`${o.id}/index.json`, toJson(orgJson(site, o)));
  }
  for (const i of site.models) {
    put(`${i.org}/${i.slug}/index.html`, modelPage(site, i));
    put(`${i.org}/${i.slug}/timeline/index.html`, timelinePage(site, i));
  }
  for (const r of site.redirects) {
    put(`${r.from.replace(/^\/models\//, "")}index.html`, redirectPage(site, r));
    // The old address of the timeline subpage moves along with the model page.
    put(`${r.from.replace(/^\/models\//, "")}timeline/index.html`, redirectPage(site, { from: r.from + "timeline/", to: { ...r.to, url: r.to.url + "timeline/" } }));
  }
  for (const [rel, text] of files) {
    const limit = rel === "index.json" ? BUDGET.index : /^[^/]+\/index\.html$/.test(rel) ? BUDGET.company : /^[^/]+\/[^/]+\/(?:timeline\/)?index\.html$/.test(rel) ? BUDGET.model : null;
    if (limit && Buffer.byteLength(text) > limit) warn.push(`${rel} is ${Math.round(Buffer.byteLength(text) / 1024)} KB, over the ${limit / 1024} KB budget (§32)`);
  }
  return { files: new Map([...files].sort((a, b) => cmp(a[0], b[0]))), sitemap: sitemapXml(site) };
}

// "generated" gets a new value only when the rest of the file changed (§27.1, AC-26):
// the new text with the previous value must equal the previous file byte for byte.
export function finalize(files, outDir, now) {
  const out = new Map();
  const slot = `"generated":${JSON.stringify(GEN)}`;
  const fill = (text, v) => text.replace(slot, () => `"generated":${JSON.stringify(v)}`);
  for (const [rel, text] of files) {
    if (!rel.endsWith(".json") || !text.includes(slot)) { out.set(rel, text); continue; }
    // CRLF-tolerant: a Windows checkout with autocrlf must not count as a content change.
    const prev = readOr(join(outDir, ...rel.split("/")));
    let stamp = now;
    if (prev) {
      try {
        const g = JSON.parse(prev).generated;
        if (typeof g === "string" && fill(text, g) === prev.replace(/\r\n/g, "\n")) stamp = g;
      } catch (e) { /* unreadable previous file: new stamp */ }
    }
    out.set(rel, fill(text, stamp));
  }
  return out;
}

/* ---------- Writing (§27.1 step 6) ---------- */
// lstat, never stat: a symlink or junction is one entry of its own (removed as a link),
// never a directory to descend into, so nothing outside outDir can be deleted through it.
const isRealDir = p => lstatSync(p).isDirectory();
function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (isRealDir(p)) out.push(...listFiles(p, base)); else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}
function removeEmptyDirs(dir, root = dir) {
  for (const name of readdirSync(dir)) { const p = join(dir, name); if (isRealDir(p)) removeEmptyDirs(p, root); }
  if (dir !== root && readdirSync(dir).length === 0) rmdirSync(dir);
}
export function diffOutput(outDir, files) {
  const existing = new Set(listFiles(outDir));
  const res = { added: [], changed: [], unchanged: [], orphans: [] };
  for (const [rel, text] of files) {
    if (!existing.has(rel)) res.added.push(rel);
    else ((readOr(join(outDir, rel)) || "").replace(/\r\n/g, "\n") === text ? res.unchanged : res.changed).push(rel);
  }
  res.orphans = [...existing].filter(rel => !files.has(rel)).sort();
  return res;
}
// Fallback when the directory cannot be swapped (Windows keeps open directories locked):
// update in place, still deleting only inside outDir.
export function syncInPlace(outDir, files) {
  mkdirSync(outDir, { recursive: true });
  for (const rel of listFiles(outDir)) if (!files.has(rel)) rmSync(join(outDir, rel));
  for (const [rel, text] of files) {
    const p = join(outDir, ...rel.split("/"));
    if (readOr(p) !== text) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
  }
  removeEmptyDirs(outDir);
}
// Build the complete tree next to outDir, then swap it in: a failed build never leaves
// half an output, and files that are no longer generated disappear with the old tree.
export function writeOutput(outDir, files) {
  const parent = dirname(outDir), base = basename(outDir);
  const tmp = join(parent, `.${base}.tmp-${process.pid}`), old = join(parent, `.${base}.old-${process.pid}`);
  mkdirSync(parent, { recursive: true });
  // Leftovers of an interrupted earlier run (only this script's own naming pattern).
  const own = new RegExp(`^\\.${reEscape(base)}\\.(?:tmp|old)-\\d+$`);
  for (const n of readdirSync(parent)) if (own.test(n)) rmSync(join(parent, n), { recursive: true, force: true });
  for (const [rel, text] of files) { const p = join(tmp, ...rel.split("/")); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
  let moved = false;
  try {
    if (existsSync(outDir)) { renameSync(outDir, old); moved = true; }
    renameSync(tmp, outDir);
  } catch (e) {
    // Put the old tree back if possible; if even that fails, syncInPlace rebuilds outDir from
    // scratch and the old tree is a leftover that the next run removes (pattern above).
    if (moved && !existsSync(outDir)) { try { renameSync(old, outDir); } catch (e2) { /* see above */ } }
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e2) { /* leftover, removed next run */ }
    syncInPlace(outDir, files);
    return "in place";
  }
  // The new tree is live: a locked file in the old one (Windows) must not fail the build
  // or skip the sitemap, so the cleanup is best effort and the next run finishes it.
  try { rmSync(old, { recursive: true, force: true }); } catch (e) { return `swapped; the previous tree ${old} could not be removed yet (the next run removes it)`; }
  return "swapped";
}
export function writeFileAtomic(file, text) {
  const dir = dirname(file);
  // Temp files of a crashed earlier run (this function's own naming pattern only).
  const own = new RegExp(`^${reEscape(basename(file))}\\.tmp-\\d+$`);
  if (existsSync(dir)) for (const n of readdirSync(dir)) if (own.test(n)) rmSync(join(dir, n), { force: true });
  if (readOr(file) === text) return false;
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try { writeFileSync(tmp, text); renameSync(tmp, file); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  return true;
}
// outDir is replaced as a whole, so it must be a dedicated directory: never the repo, the
// data, a drive root, or an unrelated non-empty folder.
const inside = (child, parent) => { const r = relative(parent, child); return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r)); };
function checkOutDir(outDir, repoRoot, dataDir) {
  if (parsePath(outDir).root === outDir) return "the output directory cannot be a drive root";
  if (inside(repoRoot, outDir) || inside(dataDir, outDir) || inside(outDir, dataDir)) return "the output directory must not contain the repository or the data, or be inside the data";
  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory()) return "the output path exists and is not a directory";
    if (readdirSync(outDir).length) {
      let ok = false;
      try { const j = JSON.parse(readFileSync(join(outDir, "index.json"), "utf8")); ok = j && j.schemaVersion === 1 && Array.isArray(j.models); } catch (e) { /* not ours */ }
      if (!ok) return "the output directory is not empty and holds no previous Model History build (models index.json); refusing to replace it";
    }
  }
  return null;
}
// The sitemap is one file next to the output, never inside it (the swap would delete it as an
// orphan on the next run), never in the data, and always an .xml file.
export function checkSitemap(sitemapFile, outDir, repoRoot, dataDir) {
  if (!/\.xml$/i.test(sitemapFile)) return "the sitemap file must end in .xml";
  if (inside(repoRoot, sitemapFile)) return "the sitemap path cannot be the repository itself or contain it";
  if (inside(sitemapFile, outDir)) return "the sitemap file must not be inside the output directory";
  if (inside(sitemapFile, dataDir) || inside(sitemapFile, join(repoRoot, "model-history"))) return "the sitemap file must not be inside the data directory";
  if (existsSync(sitemapFile)) {
    if (!statSync(sitemapFile).isFile()) return "the sitemap path exists and is not a file";
    if (!ownSitemap(readOr(sitemapFile) || "")) return "the sitemap path holds a file that is not a Model History sitemap (a <urlset> with only /models/ URLs); refusing to overwrite it";
  }
  return null;
}
// An existing file is only replaced when it is an earlier sitemap-models.xml: a <urlset> whose
// every <loc> is under /models/. That protects sitemap.xml, feed.xml and any other file.
function ownSitemap(text) {
  if (!/<urlset\b/.test(text) || /<sitemapindex\b/.test(text)) return false;
  return [...text.matchAll(/<loc>([^<]*)<\/loc>/g)].every(m => m[1].trim().startsWith(SITE + "/models/"));
}

/* ---------- Validation (§26): validate.mjs, when present ---------- */
async function runValidator(o, ds, ctx) {
  let fn = o.validate;
  if (!fn) {
    const p = join(HERE, "validate.mjs");
    if (!existsSync(p)) return { issues: [], note: "validate.mjs not found: validation skipped" };
    const mod = await import(pathToFileURL(p).href);
    fn = mod.validate || mod.default;
    if (typeof fn !== "function") return { issues: [], note: "validate.mjs exports no validate(): validation skipped" };
  }
  // validate(dataset, options); a throw propagates, so the build fails closed with the real
  // error. The result may be an issue list or an object with issues/errors/warnings.
  const res = await fn(ds, ctx);
  const issues = Array.isArray(res) ? res : res && Array.isArray(res.issues) ? res.issues : [...((res && res.errors) || []), ...((res && res.warnings) || [])];
  return { issues: issues.filter(Boolean) };
}
const isError = i => i.level === "error" || (!i.level && /^E\d/.test(i.code || ""));
const fmtIssue = i => `${i.code || "?"} ${i.file || ""}${i.path ? " " + i.path : ""}: ${i.message || ""}`.trim();

/* ---------- Run ---------- */
export function parseArgs(argv) {
  const o = {};
  for (let k = 0; k < argv.length; k++) {
    const [flag, inline] = argv[k].split(/=(.*)/s);
    const value = () => (inline !== undefined ? inline : argv[++k]);
    // Switches take no value: "--publish=false" must not silently switch publishing on.
    if ((flag === "--publish" || flag === "--help" || flag === "-h") && inline !== undefined) throw new Error(`${flag} takes no value`);
    if (flag === "--publish") o.publish = true;
    else if (flag === "--help" || flag === "-h") o.help = true;
    else if (["--data", "--out", "--sitemap", "--repo"].includes(flag)) {
      // "--out --publish" is a missing value, not an output directory called "--publish".
      const v = value();
      if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      o[flag.slice(2)] = v;
    }
    else throw new Error(`unknown option ${argv[k]}`);
  }
  return o;
}
// SOURCE_DATE_EPOCH (reproducible builds) is whole seconds; anything else is ignored with a note.
export function buildTime(env, note) {
  const e = env.SOURCE_DATE_EPOCH;
  let d = new Date();
  if (e !== undefined && e !== "") {
    if (/^\d+$/.test(e) && Number.isFinite(new Date(+e * 1000).getTime())) d = new Date(+e * 1000);
    else note(`SOURCE_DATE_EPOCH ${JSON.stringify(e)} is not a number of seconds; using the current time`);
  }
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
const USAGE = "Usage: node scripts/model-history/build.mjs [--data <dir>] [--out <dir>] [--sitemap <file>] [--repo <dir>] [--publish]";
const kb = n => `${(n / 1024).toFixed(1)} KB`;

export async function run(o = {}) {
  const log = o.log || (s => console.log(s)), err = o.error || (s => console.error(s));
  const repoRoot = resolve(o.repo || REPO);
  const dataDir = resolve(o.data || join(repoRoot, "model-history"));
  const outDir = resolve(o.out || join(repoRoot, "models"));
  const sitemapFile = resolve(o.sitemap || join(repoRoot, "sitemap-models.xml"));
  const publish = !!o.publish || (o.env || process.env).MODEL_HISTORY_PUBLISH === "on";
  if (!existsSync(dataDir)) { err(`Model History: data directory not found: ${dataDir}`); return 1; }

  const ds = loadDataset(dataDir);
  if (ds.parseErrors.length) { for (const e of ds.parseErrors) err(`E01 ${e.file}: ${e.message}`); err("Model History: unreadable data; nothing written."); return 1; }
  let registry = o.registry, registryFailed = false;
  if (registry === undefined) {
    try { registry = loadRegistry(repoRoot); } catch (e) { err(`Model History: assets/registry.js could not be run (${e.message}).`); registry = null; registryFailed = true; }
  }

  // A registry that failed to load is not passed on: validate() then loads it itself and
  // reports E25, as it does when run on its own. null would skip those checks silently.
  const v = await runValidator(o, ds, { root: dataDir, dataDir, repoRoot, ...(registryFailed ? {} : { registry }) });
  const errors = v.issues.filter(isError), warns = v.issues.filter(i => !isError(i));
  // Fail closed even when the validator is missing or did not report it.
  if (registryFailed && !errors.some(i => i.code === "E25")) errors.push({ code: "E25", level: "error", file: "assets/registry.js", message: "registry failed to load" });
  log(`Validation: ${v.note ? `${v.note}; ${errors.length} error(s)` : `${errors.length} error(s), ${warns.length} warning(s)`}`);
  for (const i of warns) log(`  warning ${fmtIssue(i)}`);
  if (errors.length) { for (const i of errors) err(`  error ${fmtIssue(i)}`); err("Model History: validation failed; nothing written."); return 1; }

  const problem = checkOutDir(outDir, repoRoot, dataDir);
  if (problem) { err(`Model History: ${problem}: ${outDir}`); return 1; }
  const smProblem = checkSitemap(sitemapFile, outDir, repoRoot, dataDir);
  if (smProblem) { err(`Model History: ${smProblem}: ${sitemapFile}`); return 1; }

  const site = compile(ds, { registry });
  const { files: raw, sitemap } = renderSite(site);
  for (const w of site.warnings) log(`  note ${w}`);
  const now = o.now || buildTime(o.env || process.env, s => log(`  note ${s}`));
  const files = finalize(raw, outDir, now);
  const d = diffOutput(outDir, files);
  const total = [...files.values()].reduce((s, t) => s + Buffer.byteLength(t), 0);
  const urls = (sitemap.match(/<loc>/g) || []).length;
  const summary = `${files.size} files (${kb(total)}) in ${outDir}: ${d.added.length} new, ${d.changed.length} changed, ${d.unchanged.length} unchanged, ${d.orphans.length} to remove; ${sitemapFile} with ${urls} URLs`;
  if (!publish) {
    log(`Publish gate closed: nothing written. Would write ${summary}.`);
    for (const rel of [...d.added, ...d.changed]) log(`  ${d.added.includes(rel) ? "new    " : "changed"} ${rel} (${kb(Buffer.byteLength(files.get(rel)))})`);
    for (const rel of d.orphans) log(`  remove  ${rel}`);
    log("To publish: pass --publish or set MODEL_HISTORY_PUBLISH=on.");
    return 0;
  }
  const how = d.added.length || d.changed.length || d.orphans.length || !existsSync(outDir) ? writeOutput(outDir, files) : "unchanged";
  const sm = writeFileAtomic(sitemapFile, sitemap);
  log(`Wrote ${summary} (output ${how}, sitemap ${sm ? "updated" : "unchanged"}).`);
  return 0;
}

// Case-insensitive: Windows paths may differ in drive-letter case between argv and the loader.
const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
  if (opts.help) { console.log(USAGE); process.exit(0); }
  run(opts).then(code => { process.exitCode = code; }, e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
}
