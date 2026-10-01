/* Model History: HTML string templates for the generated pages, in the chosen design:
   1c Release Explorer (/models/), 1a-style Company Model History (/models/<org>/),
   1e Model Detail (/models/<org>/<slug>/), 3a Model Timeline (/models/<org>/<slug>/timeline/)
   and redirect stubs. Pure functions: they receive the compiled site from build.mjs and
   return strings; nothing here reads files or the clock.

   The design lives in assets/models.css; this file keeps the semantic contract underneath
   it (spec §34): headings, lists, <time datetime>, text labels, and the data-mh-* attributes
   and ids that assets/models.js (Explorer), assets/model-pages.js (family chips, timeline
   tools) and the tests rely on. Every text goes through escapeHtml.
   The only unescaped markup is the inline logo SVG from assets/registry.js (repo code).

   Sections: labels · small helpers · page shell · Explorer · Company · Model Detail ·
   Model Timeline · redirect stub. */
import { SITE, escapeHtml as esc, formatDate, datetimeAttr, parseDate, normalize } from "./lib.mjs";
import { layoutTimeline, ZOOMS, LABEL_W, LABEL_H, PAD_X, UNKNOWN_DX } from "./timeline.mjs";

/* ---------- Labels (English site text, spec §16.4, §21.4; design 1c/1e) ---------- */
export const EVIDENCE_LABEL = {
  "primary-source": "Primary source available",
  "archived-primary-source": "Archived primary source",
  "secondary-sources": "Verified through secondary sources",
  "insufficient-evidence": "Historical evidence incomplete"
};
// The design uses these short forms in lists and per claim; the long form is in the
// model's evidence card and in the title attribute everywhere.
export const EVIDENCE_SHORT = {
  "primary-source": "Primary source",
  "archived-primary-source": "Archived primary",
  "secondary-sources": "Secondary sources",
  "insufficient-evidence": "Evidence incomplete"
};
// Shape glyphs as a second carrier next to the text, never alone (WCAG 1.4.1, design 1c).
export const EVIDENCE_GLYPH = { "primary-source": "●", "archived-primary-source": "◐", "secondary-sources": "○", "insufficient-evidence": "◌" };
export const FLAG_LABEL = {
  "original-unavailable": "Original source unavailable",
  "some-claims-incomplete": "Some details lack sources"
};
export const STUB_LABEL = "Incomplete record";
// A capability that is not disclosed and has no sources makes no claim (spec §9.4): it is
// not an evidence gap, so it never gets the "incomplete" label of a real gap.
export const NOT_APPLICABLE_LABEL = "No claim made";
// Variant capabilities and lifecycle are outside the normative claim list (§19.1), so no
// evidence is derived for them; the page says so instead of presenting them as assessed.
export const UNASSESSED_LABEL = "Evidence not assessed";
export const LIFECYCLE_LABEL = { announced: "Announced", preview: "Preview", available: "Available", deprecated: "Deprecated",
  retired: "Retired", "research-only": "Research only", unknown: "Status unknown" };
export const EMPTY_COVERAGE = "AI Radar coverage starts in June 2026; no coverage linked yet.";
const PROMINENCE_LABEL = { milestone: "Milestone", standard: "Standard release", minor: "Minor release" };
const DATE_LABEL = { announced: "Announced", released: "Released", deprecated: "Deprecated", retired: "Retired" };
const REL_LABEL = { "successor-of": "Successor of", "variant-of": "Variant of", "revision-of": "Revision of", "derived-from": "Derived from" };
const AVAIL_LABEL = { active: "Active", archived: "Archived copy", unavailable: "Unavailable", unknown: "Not yet verified" };
const PROV_LABEL = { primary: "Primary", "archived-primary": "Archived primary", secondary: "Secondary" };
const PROVIDER_LABEL = { "internet-archive": "Internet Archive capture", publisher: "Publisher archive", arxiv: "arXiv version", github: "GitHub permalink",
  huggingface: "Hugging Face revision", "software-heritage": "Software Heritage archive", "other-approved": "Archived copy" };
const CAP_LABEL = { inputModalities: "Input", outputModalities: "Output", features: "Features", openWeights: "Open weights",
  contextWindowTokens: "Context window", parameters: "Parameters", access: "Access" };
const SPECIAL = { api: "API", "3d": "3D", "api-reference": "API reference", "audio-speech": "Audio and speech",
  "retrieval-reranking": "Retrieval and reranking", "open-weights-download": "Open-weights download", "on-device": "On device" };
// "image-generation" -> "Image generation"; vocabulary values only, never free text.
export const label = v => SPECIAL[v] || (s => s.charAt(0).toUpperCase() + s.slice(1))(String(v ?? "").replace(/-/g, " "));
const lower = v => (SPECIAL[v] ? SPECIAL[v] : String(v ?? "").replace(/-/g, " "));

/* ---------- Small helpers ---------- */
// Calendar dates keep their precision: the datetime attribute is the stored value itself.
export function dateHtml(dv) {
  const text = formatDate(dv), dt = datetimeAttr(dv);
  return dt ? `<time datetime="${esc(dt)}">${esc(text)}</time>` : esc(text);
}
// News and check times are UTC instants; shown as their UTC calendar day, never invented.
export function instantHtml(v, dateOnly) {
  const day = typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  if (!day || !parseDate(day)) return "";
  return `<time datetime="${esc(dateOnly || v.length === 10 ? day : v)}">${esc(formatDate({ value: day }))}</time>`;
}
export const timelineHtml = td => (!td ? "Date unknown" : dateHtml(td.dv));
// What the shown date means (design 1c/1a): never a precision the source does not give.
export function precNote(td) {
  if (!td) return "No timeline date";
  const p = parseDate(td.dv.value).precision, q = td.dv.qualifier;
  if (td.kind === "announced") return "Announced, release date unknown";
  if (p === "month") return q === "approximate" ? "Approximate month" : q === "uncertain" ? "Uncertain month" : "Day not given";
  if (p === "year") return q === "approximate" ? "Approximate year" : q === "uncertain" ? "Uncertain year" : "Month not given";
  return q === "approximate" ? "Approximate date" : q === "uncertain" ? "Uncertain date" : "Released";
}
// The four statuses and "not-applicable" have their own text; any other value is not a
// known state and fails closed to the gap label, never to a label that claims proof.
const known = e => Object.hasOwn(EVIDENCE_LABEL, e);
const evLong = e => (known(e) ? EVIDENCE_LABEL[e] : e === "not-applicable" ? NOT_APPLICABLE_LABEL : EVIDENCE_LABEL["insufficient-evidence"]);
const evShortText = e => (known(e) ? EVIDENCE_SHORT[e] : e === "not-applicable" ? NOT_APPLICABLE_LABEL : EVIDENCE_SHORT["insufficient-evidence"]);
const glyph = e => (known(e) ? `<span class="mh-glyph" aria-hidden="true">${EVIDENCE_GLYPH[e]}</span> ` : "");
// Evidence label: glyph + text; data-mh-evidence always matches the visible text (AC-20).
export const evShort = e => `<span class="mh-ev" data-mh-evidence="${esc(e)}" title="${esc(evLong(e))}">${glyph(e)}${esc(evShortText(e))}</span>`;
const evLongHtml = e => `<span class="mh-ev mh-ev-long" data-mh-evidence="${esc(e)}">${glyph(e)}${esc(evLong(e))}</span>`;
const flagHtml = (f, tag = "span") => `<${tag} class="mh-flag" data-mh-flag="${esc(f)}">${esc(FLAG_LABEL[f] || f)}</${tag}>`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const jsonScript = v => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const safeHref = u => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
const lifeText = m => LIFECYCLE_LABEL[m.lifecycle && m.lifecycle.value] || LIFECYCLE_LABEL.unknown;
const catsText = m => (m.categories || []).map(label).join(", ");

// Per-page state: citation numbers in order of first use, and the logo id counter.
export const newCtx = () => ({ cites: new Map(), uid: 0 });
const cite = (ctx, id) => { if (!ctx.cites.has(id)) ctx.cites.set(id, ctx.cites.size + 1); return ctx.cites.get(id); };

// A logo from the registry; "__U__" becomes a suffix that is unique on this page (AC-27).
function logoHtml(site, ctx, orgId) {
  const logo = site.style(orgId).logo;
  if (!logo) return "";
  return `<span class="mh-logo" aria-hidden="true">${logo.includes("__U__") ? logo.split("__U__").join("mh" + ctx.uid++) : logo}</span>`;
}
// class plus the company hue for --co/--co-text (tokens.css), or the neutral grey.
function coAttrs(site, orgId, cls) {
  const h = site.style(orgId).hue;
  return Number.isFinite(h) ? ` class="${cls}" style="--h:${h}"` : ` class="${cls} co-neutral"`;
}
const coSpan = (site, orgId, inner) => `<span${coAttrs(site, orgId, "mh-co")}>${inner}</span>`;
function modelLink(site, id, fromOrg) {
  const t = site.modelById.get(id);
  if (!t) return `<span class="mh-missing">${esc(id)}</span>`;
  const other = fromOrg && t.org !== fromOrg ? ` <span class="mh-org-tag">(${esc(site.orgName(t.org))})</span>` : "";
  return `<a href="${esc(t.url)}">${esc(t.m.name)}</a>${other}`;
}
const orgLink = (site, id) => (site.orgById.has(id) ? `<a href="${esc(site.orgById.get(id).url)}">${esc(site.orgName(id))}</a>` : esc(site.orgName(id)));
// Siblings also include the inline variants of the record a model is a variant or revision
// of (spec §12.4, §13.3); an inline variant has no page, so these link to its anchor.
function inlineSiblings(site, i) {
  const out = [], seen = new Set();
  for (const x of i.outRel) {
    const p = (x.r.type === "variant-of" || x.r.type === "revision-of") && site.modelById.get(x.target);
    if (!p) continue;
    for (const v of p.m.variants || []) {
      const key = v && typeof v.id === "string" && v.id ? `${p.id}#${v.id}` : null;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(`<li><a href="${esc(p.url)}#variant-${esc(v.id)}">${esc(v.name || v.id)}</a> <span class="mh-muted">· inline variant of ${esc(p.m.name)}</span></li>`);
    }
  }
  return out;
}

// Source references of one claim, as [n] links to the page's source list (design 1e).
function refs(ctx, list) {
  const rs = (Array.isArray(list) ? list : []).filter(r => r && typeof r.id === "string");
  if (!rs.length) return `<span class="mh-refs mh-refs-none">No source</span>`;
  const items = rs.map(r => `<a class="mh-ref" href="#source-${esc(r.id)}" aria-label="Source ${cite(ctx, r.id)}${r.locator ? `, ${esc(r.locator)}` : ""}">[${cite(ctx, r.id)}]</a>${r.locator ? `<span class="mh-locator">${esc(r.locator)}</span>` : ""}`);
  return `<span class="mh-refs">${items.join(" ")}</span>`;
}
// Differing values from other sources are shown, never silently dropped (spec §19.3).
function altHtml(ctx, claim) {
  const alts = Array.isArray(claim.alternatives) ? claim.alternatives.filter(a => a && a.value) : [];
  if (!alts.length) return "";
  return `<span class="mh-alt">Other sources give: ${alts.map(a => `${dateHtml(a)} ${refs(ctx, a.sources)}${a.note ? ` <span class="mh-note">${esc(a.note)}</span>` : ""}`).join("; ")}</span>`;
}
// One row of "Claims and evidence" (design 1e): label, value, its own evidence and sources (AC-31).
function claimRow(ctx, c, labelText, valueHtml) {
  const dated = c.kind === "date" || c.kind === "variant-date" || c.kind === "milestone";
  const note = c.claim.note ? `<span class="mh-note">${esc(c.claim.note)}</span>` : "";
  const alt = dated ? altHtml(ctx, c.claim) : "";
  return `<li class="mh-claim" data-mh-claim="${esc(c.path)}" data-mh-evidence="${esc(c.evidence)}">
<span class="mh-claim-label">${esc(labelText)}</span>
<span class="mh-claim-value">${valueHtml}${note}${alt}</span>
<span class="mh-claim-ev">${evShort(c.evidence)}${c.originalUnavailable ? flagHtml("original-unavailable") : ""}${refs(ctx, c.claim.sources)}</span>
</li>`;
}
const ul = (items, attrs = "") => `<ul${attrs}>\n${items.join("\n")}\n</ul>`;
const h2 = (text, id) => `<h2 class="mh-h2"${id ? ` id="${id}"` : ""}>${esc(text)}</h2>`;

/* ---------- Page shell (same template as about.html) ---------- */
// Pre-paint: reads only the current keys; the legacy "mm-theme" key is not read here (spec §37.2).
const PREPAINT = `<script>
  /* Apply the saved theme and motion choice before first paint, so there is
     no flash. Same keys as the dashboard; without a saved choice the system
     settings decide. */
  (function () {
    var d = document.documentElement, t = null, m = null;
    try {
      t = localStorage.getItem('airadar-theme');
      m = localStorage.getItem('airadar-motion');
    } catch (e) {}
    try {
      if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      if (m !== 'on' && m !== 'off') m = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'on';
    } catch (e) {}
    d.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
    if (m === 'on' || m === 'off') d.setAttribute('data-motion', m);
  })();
</script>`;

// aria-current="page" only on /models/ itself; the other pages are inside the section.
const header = current => `<header class="site-header">
  <div class="container">
    <a class="brand" href="/">
      <span class="radar" aria-hidden="true"><span class="radar-hand"></span><span class="radar-dot"></span></span>
      AI Radar
    </a>
    <nav class="site-nav" aria-label="Main">
      <a class="nav-link" href="/">Dashboard</a>
      <a class="nav-link" href="/models/" aria-current="${current}">Model History</a>
      <a class="nav-link" href="/about">About</a>
      <a class="nav-link" href="/feed.xml">RSS</a>
      <button class="motion-btn" type="button" data-motion-toggle><span class="motion-is-on">Motion on</span><span class="motion-is-off">Motion off</span></button>
      <button class="theme-btn" type="button" data-theme-toggle><span class="theme-to-dark">Dark<span class="narrow-hide"> mode</span></span><span class="theme-to-light">Light<span class="narrow-hide"> mode</span></span></button>
      <a class="subscribe-btn" href="/#subscribe">Subscribe</a>
    </nav>
  </div>
</header>`;

// The header links are hidden on phones (pages.css), so Model History is in the footer too.
const footer = current => `<footer class="site-footer">
  <div class="container">
    <span>AI Radar &middot; Made by Benjamin Nieuwenhuijzen</span>
    <nav class="footer-links" aria-label="Footer">
      <a href="/">Dashboard</a>
      <a href="/models/" aria-current="${current}">Model History</a>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
      <a href="/privacy">Privacy</a>
      <a href="/disclaimer">Disclaimer</a>
      <a href="/feed.xml">RSS</a>
    </nav>
  </div>
</footer>`;

// JSON-LD: WebPage + BreadcrumbList; schema.org has no AI-model type, none is claimed (spec §30).
function jsonLd(p, canonical) {
  const crumbs = [{ name: "AI Radar", url: "/" }, ...p.crumbs];
  return { "@context": "https://schema.org", "@graph": [
    { "@type": "WebPage", "@id": canonical, url: canonical, name: p.title, description: p.description, inLanguage: "en",
      isPartOf: { "@type": "WebSite", name: "AI Radar", url: SITE + "/" }, breadcrumb: { "@id": canonical + "#breadcrumb" } },
    { "@type": "BreadcrumbList", "@id": canonical + "#breadcrumb",
      itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: SITE + c.url })) }
  ] };
}

/* p: { path, title, description, indexable, main, crumbs, scripts?, redirectTo? }.
   Head order follows about.html: charset, viewport, robots, title, description, canonical,
   theme-color, Open Graph/Twitter, favicon, pre-paint, styles, pages.js. */
export function page(p) {
  const canonical = SITE + (p.redirectTo || p.path);
  const robots = p.indexable ? "index, follow" : p.redirectTo ? "noindex" : "noindex, follow";
  const current = p.path === "/models/" ? "page" : "true";
  const head = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="robots" content="${robots}">`,
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.description)}">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    p.redirectTo ? `<meta http-equiv="refresh" content="0; url=${esc(p.redirectTo)}">` : null,
    `<meta name="theme-color" content="#f7f6f2" media="(prefers-color-scheme: light)">`,
    `<meta name="theme-color" content="#111215" media="(prefers-color-scheme: dark)">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="AI Radar">`,
    `<meta property="og:title" content="${esc(p.title)}">`,
    `<meta property="og:description" content="${esc(p.description)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${esc(p.title)}">`,
    `<meta name="twitter:description" content="${esc(p.description)}">`,
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`,
    PREPAINT,
    `<link rel="stylesheet" href="/assets/tokens.css">`,
    `<link rel="stylesheet" href="/assets/pages.css">`,
    `<link rel="stylesheet" href="/assets/models.css">`,
    `<script src="/assets/pages.js" defer></script>`,
    ...(p.scripts || []).map(s => `<script src="${esc(s)}" defer></script>`),
    // An old variant anchor (#variant-x) never reaches the server; carry it along.
    p.redirectTo ? `<script>try { location.replace(${jsonScript(p.redirectTo)} + location.hash); } catch (e) {}</script>` : null,
    p.redirectTo ? null : `<script type="application/ld+json">${jsonScript(jsonLd(p, canonical))}</script>`
  ].filter(Boolean);
  return `<!DOCTYPE html>
<html lang="en">
<head>
${head.join("\n")}
</head>
<body>

<a class="skip-link" href="#main">Skip to content</a>

${header(current)}

${p.main}

${footer(current)}

</body>
</html>
`;
}
// Design crumb: "Model History › Org › …" in mono; the organisation in its company colour.
function crumbsHtml(site, crumbs, orgId) {
  const items = crumbs.map((c, i) => {
    const text = orgId && c.org ? coSpan(site, orgId, esc(c.name)) : esc(c.name);
    return i === crumbs.length - 1 ? `<li aria-current="page">${text}</li>` : `<li><a href="${esc(c.url)}">${text}</a></li>`;
  });
  return `<nav class="mh-crumbs" aria-label="Breadcrumb"><ol>${items.join("")}</ol></nav>`;
}
// Descriptions stay under ~155 characters and end on a whole word.
export function clip(s, n = 155) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1), sp = cut.lastIndexOf(" ");
  return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "") + "…";
}
const flagsOf = i => [...i.ev.flags.map(f => flagHtml(f)), i.m.coverage === "stub" ? `<span class="mh-flag" data-mh-flag="stub">${STUB_LABEL}</span>` : ""].join("");

/* ---------- Explorer (/models/, design 1c) ---------- */
function explorerRow(site, i) {
  const m = i.m, fam = m.familyId && site.famById.get(m.familyId);
  const kicker = [coSpan(site, i.org, site.orgById.has(i.org) ? `<a href="${esc(site.orgById.get(i.org).url)}">${esc(site.orgName(i.org))}</a>` : esc(site.orgName(i.org))), fam ? esc(fam.name) : null].filter(Boolean).join(" · ");
  return `<li${coAttrs(site, i.org, "mh-row")} data-mh-model="${esc(i.id)}" data-mh-prominence="${esc(m.prominence || "")}">
<div class="mh-row-model">
<span class="mh-kicker">${kicker}</span>
<a class="mh-row-name" href="${esc(i.url)}">${esc(m.name)}</a>
<span class="mh-row-cats">${esc(catsText(m))}</span>
</div>
<div class="mh-row-date"><span class="mh-date">${timelineHtml(i.td)}</span><span class="mh-prec">${esc(precNote(i.td))}</span></div>
<span class="mh-row-life">${esc(lifeText(m))}</span>
<div class="mh-row-ev">${evShort(i.ev.evidence)}${flagsOf(i)}</div>
</li>`;
}
export function explorerPage(site) {
  const orgs = site.orgs.filter(o => o.routed.length);
  const n = site.models.length;
  // Not one full record yet: the page says so and is not indexed (see sitemapXml).
  const hasFull = site.models.some(i => i.m.coverage === "full");
  const notice = hasFull ? "" : `\n<p class="mh-notice">Model History is being prepared: ${n ? "the records below are not complete yet" : "no model records are published yet"}.</p>`;
  const main = `<main id="main" class="mh mh-explorer" data-mh-view="explorer">
<header class="mh-hero container">
<h1 class="mh-title">Model History</h1>
<p class="mh-lead">Which models each organisation released, when, and what changed. Every claim links to its sources.</p>${notice}
<div id="mh-controls" class="mh-controls" hidden>
<input type="search" id="mh-search" aria-label="Search models" autocomplete="off" spellcheck="false" placeholder="Search models, aliases, families or organisations">
<div id="mh-sort" class="mh-seg" role="group" aria-label="Sort">
<button type="button" data-sort="date-desc" aria-pressed="true">Newest first</button>
<button type="button" data-sort="date-asc" aria-pressed="false">Oldest first</button>
<button type="button" data-sort="name" aria-pressed="false">Name</button>
<button type="button" data-sort="org" aria-pressed="false">Organisation</button>
</div>
<button type="button" id="mh-filter-toggle" class="mh-filter-toggle" aria-expanded="false" aria-controls="mh-facets">Filters</button>
</div>
</header>
<div class="mh-explorer-body container">
<aside class="mh-facets-col" aria-label="Filters">
<div id="mh-facets" class="mh-facets"></div>
<nav class="mh-orglist" aria-label="Organisations">
<h2 class="mh-legend">Organisations</h2>
${ul(orgs.map(o => `<li><a href="${esc(o.url)}">${esc(o.o.name)}</a> <span class="mh-num">${o.routed.length}</span></li>`))}
</nav>
</aside>
<section class="mh-results" aria-labelledby="mh-results-title">
<h2 id="mh-results-title" class="mh-visually-hidden">Models</h2>
<div class="mh-results-head">
<p id="mh-count" aria-live="polite">${esc(plural(n, "model", "models"))} from ${esc(plural(orgs.length, "organisation", "organisations"))}</p>
<button type="button" id="mh-clear" class="mh-btn-small" hidden>Clear filters</button>
</div>
<div class="mh-cols" aria-hidden="true"><span>Model</span><span>Timeline date</span><span>Status</span><span>Evidence</span></div>
<div id="mh-empty" class="mh-empty" hidden><p>No models match these filters.</p><button type="button" id="mh-empty-clear" class="mh-btn-dark">Clear filters</button></div>
<p id="mh-error" class="mh-error" hidden>Search and filters could not be loaded. The full list below still works. <button type="button" id="mh-retry">Retry</button></p>
<ol id="mh-list" class="mh-list">
${site.explorer.map(i => explorerRow(site, i)).join("\n")}
</ol>
</section>
</div>
</main>`;
  // Indexable once a full record exists; sitemapXml lists /models/ under the same rule.
  return page({ path: "/models/", title: "Model History · AI Radar", indexable: hasFull, main, scripts: ["/assets/models.js"],
    description: "Every AI model in AI Radar Model History, with release dates at their real precision, lineage, and the sources behind each fact.",
    crumbs: [{ name: "Model History", url: "/models/" }] });
}

/* ---------- Company Model History (/models/<org>/, design 1a style) ---------- */
// Design 1a: years newest first; within a year day- and month-dated models newest first
// (the precision note says when the day is missing), then the year-only models under
// "<year> · exact date unknown"; models without any date come last (spec §21.3).
export function groupChronology(items) {
  const years = new Map(), unknown = [];
  for (const it of items) {
    const p = it.td && parseDate(it.td.dv.value);
    if (!p) { unknown.push(it); continue; }
    if (!years.has(p.y)) years.set(p.y, { year: p.y, known: [], yearOnly: [] });
    (p.precision === "year" ? years.get(p.y).yearOnly : years.get(p.y).known).push(it);
  }
  const desc = (a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : a.m.name.localeCompare(b.m.name));
  const list = [...years.values()].sort((a, b) => b.year - a.year);
  list.forEach(y => { y.known.sort(desc); y.yearOnly.sort(desc); });
  return { years: list, unknown };
}
function chronoItem(site, ctx, org, i) {
  const m = i.m, fam = m.familyId && site.famById.get(m.familyId);
  const meta = [fam ? esc(fam.name) : null, esc(catsText(m)), m.prominence === "milestone" ? "Milestone" : null].filter(Boolean).join(" · ");
  const sum = i.claims.get("summary");
  const changes = (m.changes || []).slice(0, 2).map(x => `<li>${esc(x.text || "")}</li>`);
  const codev = i.org !== org.id ? `<span class="mh-note">Co-developed; listed under ${orgLink(site, i.org)}</span>` : "";
  const newsN = i.news.length ? plural(i.news.length, "news item", "news items") : "no news linked";
  return `<li class="mh-chrono-item" data-mh-model="${esc(i.id)}" data-mh-family="${esc(m.familyId || "")}" data-mh-prominence="${esc(m.prominence || "")}">
<div class="mh-chrono-date"><span class="mh-date">${timelineHtml(i.td)}</span><span class="mh-prec">${esc(precNote(i.td))}</span></div>
<div class="mh-chrono-body">
<span class="mh-kicker">${meta}</span>
<a class="mh-chrono-name" href="${esc(i.url)}">${esc(m.name)}</a>
${sum ? `<p class="mh-chrono-sum">${esc(sum.claim.text || "")}</p>` : ""}${changes.length ? `\n<ul class="mh-changes-mini">${changes.join("")}</ul>` : ""}
</div>
<div class="mh-chrono-side">
<span class="mh-pill">${evShort(i.ev.evidence)}</span>
<span class="mh-kicker">${esc(lifeText(m))} · ${esc(newsN)}</span>
${flagsOf(i)}${codev}
</div>
</li>`;
}
function chronologyHtml(site, ctx, org, items) {
  const { years, unknown } = groupChronology(items);
  const block = (title, count, list, groupHead) => `<li class="mh-year">
<div class="mh-year-head"><h3>${esc(title)}</h3><span class="mh-year-count">${esc(plural(count, "model", "models"))}</span></div>
${list}
</li>`;
  const items_ = (list, head) => list.length ? `${head ? `<p class="mh-group-head">${esc(head)}</p>\n` : ""}<ol class="mh-chrono-items">\n${list.map(i => chronoItem(site, ctx, org, i)).join("\n")}\n</ol>` : "";
  const out = years.map(y => block(String(y.year), y.known.length + y.yearOnly.length,
    [items_(y.known), items_(y.yearOnly, `${y.year} · exact date unknown`)].filter(Boolean).join("\n")));
  if (unknown.length) out.push(block("Date unknown", unknown.length, items_(unknown)));
  return out.length ? `<ol class="mh-chrono">\n${out.join("\n")}\n</ol>` : `<p class="mh-none">No models recorded yet.</p>`;
}
// Text-first lineage (spec §7, §31): per model, its relations by type as lists of links.
// A merge shows the model under each parent as a link, never as a duplicated subtree.
function lineageLists(site, i, fromOrg) {
  const out = i.outRel, inn = site.inRel.get(i.id) || [];
  const REL_IN = { "successor-of": "successor", "variant-of": "variant", "revision-of": "revision", "derived-from": "derived" };
  const typed = (list, key, fn) => list.map(x => `<li>${modelLink(site, x[key], fromOrg)}${fn ? ` <span class="mh-muted">· ${esc(fn(x.r))}</span>` : ""}</li>`);
  const outLabel = r => (r.type === "derived-from" && r.method ? `derived: ${lower(r.method)}` : lower(r.type.replace(/-of$/, "")));
  const inLabel = r => (r.type === "derived-from" && r.method ? `derived: ${lower(r.method)}` : REL_IN[r.type] || r.type);
  const groups = [
    ["predecessors", "Predecessors", typed(out.filter(x => x.r.type === "successor-of"), "target", null)],
    ["successors", "Successors", typed(inn.filter(x => x.r.type === "successor-of"), "from", null)],
    ["parents", "Based on", typed(out.filter(x => x.r.type !== "successor-of"), "target", outLabel)],
    ["children", "Variants and derived", typed(inn.filter(x => x.r.type !== "successor-of"), "from", inLabel)],
    ["siblings", "Siblings", [...site.sortIds(i.g.siblings).map(id => `<li>${modelLink(site, id, fromOrg)}</li>`), ...inlineSiblings(site, i)]]
  ].filter(g => g[2].length);
  if (!groups.length) return `<p class="mh-none">No recorded relations.</p>`;
  return `<div class="mh-lineage-grid mh-lineage-compact">\n${groups.map(([k, t, items]) => `<div class="mh-lineage-group"><h4 class="mh-legend">${t}</h4>\n${ul(items, ` class="mh-rel" data-mh-lineage="${k}"`)}</div>`).join("\n")}\n</div>`;
}
function evidenceOverview(site, org) {
  const rows = Object.keys(EVIDENCE_LABEL).map(e => [e, org.routed.filter(i => i.ev.evidence === e).length]);
  const lost = org.routed.filter(i => i.ev.flags.includes("original-unavailable")).length;
  const weak = site.chrono(org.routed.filter(i => i.ev.evidence === "insufficient-evidence" || i.ev.flags.includes("some-claims-incomplete")));
  const lostList = site.chrono(org.routed.filter(i => i.ev.flags.includes("original-unavailable")));
  const note = (i, t) => `<li><a href="${esc(i.url)}">${esc(i.m.name)}</a> <span class="mh-muted">${esc(t)}</span></li>`;
  return `<dl class="mh-ev-overview">
${rows.map(([e, n]) => `<div data-mh-evidence="${e}"><dt>${glyph(e)}${esc(EVIDENCE_SHORT[e])}</dt><dd>${n}</dd></div>`).join("\n")}
<div data-mh-flag="original-unavailable"><dt>${esc(FLAG_LABEL["original-unavailable"])}</dt><dd>${lost}</dd></div>
</dl>${weak.length ? `\n<h3 class="mh-legend">Incomplete evidence</h3>\n${ul(weak.map(i => note(i, [i.ev.evidence === "insufficient-evidence" ? EVIDENCE_LABEL[i.ev.evidence] : "",
    i.ev.flags.includes("some-claims-incomplete") ? FLAG_LABEL["some-claims-incomplete"] : ""].filter(Boolean).join("; "))), ' class="mh-mini-list" data-mh-list="incomplete"')}` : ""}${lostList.length ? `\n<h3 class="mh-legend">Original source unavailable</h3>\n${ul(lostList.map(i => note(i, evLong(i.ev.evidence))), ' class="mh-mini-list" data-mh-list="original-unavailable"')}` : ""}`;
}
export function companyPage(site, org) {
  const ctx = newCtx(), o = org.o;
  const all = site.chrono([...org.routed, ...org.coDev]);
  const oc = org.claims;
  // Organisation facts (sourced claims): description, former names, units, website.
  const facts = [];
  const desc = oc.get("description");
  const former = (o.formerNames || []).map((f, k) => {
    const c = oc.get(`formerNames[${k}]`);
    const span = [f.from ? `from ${dateHtml(f.from)}` : "", f.until ? `until ${dateHtml(f.until)}` : ""].filter(Boolean).join(" ");
    return c ? claimRow(ctx, c, "Former name", `${esc(f.name)}${span ? ` <span class="mh-period">(${span})</span>` : ""}`) : null;
  }).filter(Boolean);
  if (desc) facts.push(claimRow(ctx, desc, "Description", esc(o.description.text)));
  facts.push(...former);
  const units = site.unitsOf(o.id).map(id => site.org(id)).filter(Boolean);
  const web = safeHref(o.website);
  const extra = [units.length ? `<p class="mh-facts-line">Units: ${units.map(u => esc(u.name)).join(", ")}</p>` : "",
    `<p class="mh-facts-line">${esc(label(o.type || "company"))}${web ? ` · <a href="${esc(web)}">${esc(o.website)}</a>` : ""} · ${esc(plural(org.routed.length, "model", "models"))} listed here</p>`].filter(Boolean).join("\n");

  // Lead text: the description, and a former name in plain words (the claims are below).
  const formerText = (o.formerNames || []).filter(f => f && f.name).map(f => `Known as ${f.name}${f.until && f.until.value ? ` until ${formatDate(f.until)}` : ""}.`).join(" ");
  const lead = [o.description && o.description.text ? o.description.text : `Models released by ${o.name}, in timeline order, with lineage and sources.`, formerText].filter(Boolean).join(" ");

  // Family chips (design 1a): filter the chronology in the browser; hidden without JS.
  const famChips = org.families.filter(f => all.some(i => i.m.familyId === f.id));
  const chips = famChips.length > 1 ? `<div id="mh-family-chips" class="mh-chips" role="group" aria-label="Family" hidden>
<button type="button" data-family="" aria-pressed="true">All families</button>
${famChips.map(f => `<button type="button" data-family="${esc(f.id)}" aria-pressed="false">${esc(f.name)}</button>`).join("\n")}
</div>` : "";

  // Optional editorial story (spec §10.3): chapters are claims with sources.
  const chapters = ((o.narrative && o.narrative.chapters) || []).map((ch, k) => {
    const c = oc.get(`narrative.chapters[${k}]`);
    if (!c) return null;
    const per = ch.period ? [ch.period.from, ch.period.to].filter(Boolean).map(v => dateHtml({ value: v })).join("–") : "";
    const ms = (ch.modelIds || []).filter(id => site.modelById.has(id)).map(id => modelLink(site, id, o.id));
    return `<li class="mh-chapter mh-claim" data-mh-claim="${esc(c.path)}" data-mh-evidence="${esc(c.evidence)}">
<span class="mh-kicker">Chapter ${k + 1}${per ? ` · ${per}` : ""} · <span class="mh-editorial">Editorial</span></span>
<h3>${esc(ch.title || "")}</h3>
<p>${esc(ch.text || "")}</p>${ms.length ? `\n<p class="mh-chapter-models">Models: ${ms.join(", ")}</p>` : ""}
<span class="mh-claim-ev">${evShort(c.evidence)}${refs(ctx, c.claim.sources)}</span>
</li>`;
  }).filter(Boolean);

  // Families as a tree (parentId), each with its models in timeline order.
  const famIds = new Set(org.families.map(f => f.id));
  const placed = new Set();   // a parentId loop in bad data must not recurse forever
  const famItem = f => {
    placed.add(f.id);
    const kids = org.families.filter(x => x.parentId === f.id && !placed.has(x.id));
    kids.forEach(x => placed.add(x.id));
    const ms = site.chrono(org.routed.filter(i => i.m.familyId === f.id)).map(i => `<li><a href="${esc(i.url)}">${esc(i.m.name)}</a> <span class="mh-muted">${timelineHtml(i.td)}</span></li>`);
    return `<li id="family-${esc(f.id)}" class="mh-family">\n<h3>${esc(f.name)}</h3>\n${ms.length ? `<ol class="mh-mini-list">\n${ms.join("\n")}\n</ol>` : `<p class="mh-none">No models listed yet.</p>`}${kids.length ? `\n${ul(kids.map(famItem), ' class="mh-families"')}` : ""}\n</li>`;
  };
  const roots = org.families.filter(f => !f.parentId || !famIds.has(f.parentId));
  const loose = site.chrono(org.routed.filter(i => !i.m.familyId || !famIds.has(i.m.familyId)));
  const famHtml = [roots.length ? ul(roots.map(famItem), ' class="mh-families"') : "",
    loose.length ? `<h3>Not in a family</h3>\n${ul(loose.map(i => `<li><a href="${esc(i.url)}">${esc(i.m.name)}</a></li>`), ' class="mh-mini-list"')}` : ""].filter(Boolean).join("\n") || `<p class="mh-none">No families recorded.</p>`;

  const lineage = all.length ? `<ol class="mh-lineage-models">\n${all.map(i => `<li id="lineage-${esc(i.id)}">\n<a class="mh-lineage-name" href="${esc(i.url)}">${esc(i.m.name)}</a>\n${lineageLists(site, i, o.id)}\n</li>`).join("\n")}\n</ol>` : `<p class="mh-none">No models recorded yet.</p>`;

  const news = org.news.slice(0, 10);
  const newsHtml = (news.length ? ul(news.map(n => newsRow(site, n, o.id, true)), ' class="mh-news-side"') : `<p class="mh-empty-text">${esc(EMPTY_COVERAGE)}</p>`) + dashboardLink(site, o.id);
  const notice = org.indexable ? "" : `\n<p class="mh-notice">Research on this organisation has not started yet: its model records are stubs or are listed under another organisation.</p>`;

  const main = `<main id="main"${coAttrs(site, o.id, "mh mh-company")} data-mh-view="company" data-mh-org="${esc(o.id)}">
<div class="mh-page-head container">
<div class="mh-head-main">
${crumbsHtml(site, [{ name: "Model History", url: "/models/" }, { name: o.name, url: org.url, org: true }], o.id)}
<h1 class="mh-title">${logoHtml(site, ctx, o.id)}${esc(o.name)} models</h1>
<p class="mh-lead">${esc(lead)}</p>${notice}
${chips}
</div>
<aside class="mh-head-side" id="evidence" aria-labelledby="mh-ev-title">
<h2 class="mh-legend" id="mh-ev-title">Evidence overview</h2>
${evidenceOverview(site, org)}
</aside>
</div>
<div class="mh-page-body container">
<div class="mh-body-main">
<section id="chronology" aria-labelledby="mh-chrono-title">
<h2 class="mh-visually-hidden" id="mh-chrono-title">Chronology</h2>
${chronologyHtml(site, ctx, org, all)}
</section>
${chapters.length ? `<section id="story">\n${h2("The story so far")}\n<ol class="mh-chapters">\n${chapters.join("\n")}\n</ol>\n</section>` : ""}
<section id="lineage">
${h2("Lineage")}
${lineage}
</section>
<section id="families">
${h2("Families")}
${famHtml}
</section>
<section id="organization">
${h2("About the organisation")}
${facts.length ? ul(facts, ' class="mh-claim-rows"') : ""}
${extra}
</section>
${ctx.cites.size ? `<section id="sources">\n${h2("Sources")}\n${sourceList(site, ctx, [])}\n</section>` : ""}
</div>
<aside class="mh-body-side" id="coverage" aria-labelledby="mh-cov-title">
<h2 class="mh-legend" id="mh-cov-title">Related AI Radar coverage</h2>
${newsHtml}
</aside>
</div>
<script type="application/json" id="mh-graph">${jsonScript(org.embed)}</script>
</main>`;
  const description = o.description && o.description.text ? clip(o.description.text) : clip(`Models released by ${o.name}, with release dates, lineage and sources, in AI Radar Model History.`);
  return page({ path: org.url, title: `${o.name} models · Model History · AI Radar`, description, indexable: org.indexable, main,
    scripts: chips ? ["/assets/model-pages.js"] : [],
    crumbs: [{ name: "Model History", url: "/models/" }, { name: o.name, url: org.url }] });
}
function dashboardLink(site, orgId) {
  const rid = (site.org(orgId) || {}).radarCompanyId;
  if (!rid) return "";
  return `\n<p class="mh-more"><a href="/?view=timeline&amp;cat=model-releases&amp;company=${esc(encodeURIComponent(rid))}">All model releases from ${esc(site.orgName(orgId))} on AI Radar →</a></p>`;
}
// One coverage row (design 1e/1a): the title links to the original article.
function newsRow(site, n, fromOrg, side) {
  const href = safeHref(n.link);
  const title = href ? `<a href="${esc(href)}">${esc(n.title)}</a>` : esc(n.title);
  const about = fromOrg && n.models ? n.models.map(x => {
    const t = site.modelById.get(x.id); if (!t) return null;
    const v = x.variantId && (t.m.variants || []).find(y => y && y.id === x.variantId);
    return `<a href="${esc(t.url)}${v ? "#variant-" + esc(v.id) : ""}">${esc(v ? v.name : t.m.name)}</a>`;
  }).filter(Boolean) : [];
  const variant = !fromOrg && n.variantId && n.variantName ? ` · about ${esc(n.variantName)}` : "";
  const via = [n.company, n.source].filter(Boolean).map(esc).join(" · ");
  const meta = `${via}${via ? " · " : ""}${instantHtml(n.publishedAt, n.dateOnly)}${variant}${about.length ? ` · about ${about.join(", ")}` : ""}`;
  return side
    ? `<li class="mh-news-item"><span class="mh-kicker">${meta}</span><span class="mh-news-title">${title}</span></li>`
    : `<li class="mh-news-item"><span class="mh-news-title">${title}</span><span class="mh-kicker">${meta}</span></li>`;
}

/* ---------- Model Detail (/models/<org>/<slug>/, design 1e) ---------- */
function sourceList(site, ctx, extraIds) {
  // Cited sources in order of first citation, then any other source the record names.
  const ids = [...ctx.cites.keys()];
  for (const id of extraIds) if (!ctx.cites.has(id)) { cite(ctx, id); ids.push(id); }
  const items = ids.map(id => {
    const n = ctx.cites.get(id), v = site.source(id);
    if (!v) return `<li id="source-${esc(id)}" class="mh-source mh-source-missing"><span class="mh-source-n">[${n}]</span> Unknown source <code>${esc(id)}</code></li>`;
    const s = v.s, href = !s.suppressLink && safeHref(s.url), arch = !s.suppressLink && safeHref(s.archiveUrl);
    const live = v.avail === "active" || v.avail === "unknown";
    const archive = s.archiveUrl ? `${arch ? `<a href="${esc(arch)}">${esc(PROVIDER_LABEL[s.archiveProvider] || "Archived copy")} ↗</a>` : esc(PROVIDER_LABEL[s.archiveProvider] || "Archived copy")}${s.archivedAt ? ` <span class="mh-muted">captured ${instantHtml(s.archivedAt)}</span>` : ""}${v.archiveGone ? ` <span class="mh-flag">The archived copy is also gone</span>` : ""}` : "";
    return `<li id="source-${esc(id)}" class="mh-source" data-mh-availability="${esc(v.avail)}" data-mh-provenance="${esc(v.prov)}">
<p class="mh-source-title"><span class="mh-source-n">[${n}]</span> <cite>${esc(s.title)}</cite></p>
<p class="mh-kicker">${[esc(label(s.type)), s.publisher ? esc(s.publisher) : "", s.publishedAt && s.publishedAt.value ? `published ${dateHtml(s.publishedAt)}` : ""].filter(Boolean).join(" · ")}</p>
<dl class="mh-source-status">
<dt>Provenance</dt><dd>${esc(PROV_LABEL[v.prov] || v.prov)}</dd>
<dt>Availability</dt><dd class="mh-avail" data-mh-availability="${esc(v.avail)}">${esc(AVAIL_LABEL[v.avail] || v.avail)}</dd>
<dt>Last checked</dt><dd>${v.lastChecked ? instantHtml(v.lastChecked) || esc(v.lastChecked) : "Not yet checked"}</dd>
</dl>
<div class="mh-source-links">
${s.suppressLink ? `<span class="mh-muted">Not linked at the request of the rights holder</span>` : live && href ? `<a href="${esc(href)}">Original ↗</a>` : `<span class="mh-muted">Original no longer available</span>`}
<span class="mh-url">${esc(s.url || "")}</span>${archive ? `\n${archive}` : ""}${s.notes ? `\n<span class="mh-note">${esc(s.notes)}</span>` : ""}
</div>
</li>`;
  });
  return items.length ? `<ol class="mh-sources">\n${items.join("\n")}\n</ol>` : `<p class="mh-none">No sources recorded.</p>`;
}
function capValue(key, c) {
  const v = c.value;
  if (key === "openWeights") return v === true ? "Yes" : v === false ? "No" : "Not recorded";
  if (key === "contextWindowTokens" || key === "parameters") {
    if (c.disclosure && c.disclosure !== "official") return c.disclosure === "not-disclosed" ? "Not disclosed" : "Unknown";
    const shown = c.asStated || (typeof v === "number" ? v.toLocaleString("en-US") : "");
    if (!shown) return "Unknown";
    return (c.qualifier === "approximate" ? "c. " : "") + shown + (key === "contextWindowTokens" ? " tokens" : "") + (c.qualifier === "uncertain" ? "?" : "");
  }
  if (Array.isArray(v)) return v.length ? v.map(lower).join(", ") : "None recorded";
  return v == null ? "Not recorded" : String(v);
}
const timelineUrl = i => `${i.url}timeline/`;
export function modelPage(site, i) {
  const ctx = newCtx(), m = i.m, cl = i.claims, org = site.orgById.get(i.org);
  const fam = m.familyId && site.famById.get(m.familyId);
  const d = m.dates || {};
  const orgName = site.orgName(i.org);

  // Head: summary (a claim, with its own sources and evidence), stub notice, timeline link.
  const sc = cl.get("summary");
  const summary = sc
    ? `<p id="summary" class="mh-summary mh-claim" data-mh-claim="summary" data-mh-evidence="${esc(sc.evidence)}">${esc(sc.claim.text || "")} ${refs(ctx, sc.claim.sources)} ${evShort(sc.evidence)}</p>`
    : `<p id="summary" class="mh-summary mh-none">No summary yet.</p>`;
  const sub = [lifeText(m), catsText(m), m.prominence === "milestone" ? "Milestone" : null].filter(Boolean).map(esc).join(" · ");
  const stub = m.coverage === "stub" ? `\n<p class="mh-stub">Incomplete record: this model is only partly described.</p>` : "";

  // Claims and evidence (design 1e): every claim with its own sources and status (AC-31).
  const dateRows = [];
  for (const k of ["announced", "released", "deprecated", "retired"]) {
    const c = cl.get(`dates.${k}`);
    if (c) dateRows.push(claimRow(ctx, c, DATE_LABEL[k], dateHtml(c.claim)));
    if (k === "released" && !c && d.announced) dateRows.push(`<li class="mh-claim-gap"><span class="mh-claim-label">Released</span><span class="mh-claim-value">Release date unknown</span><span class="mh-claim-ev"></span></li>`);
  }
  if (!i.td && !d.announced) dateRows.push(`<li class="mh-claim-gap"><span class="mh-claim-label">Released</span><span class="mh-claim-value">Date unknown${d.note ? `<span class="mh-note">${esc(d.note)}</span>` : ""}</span><span class="mh-claim-ev"><span class="mh-refs mh-refs-none">No source</span></span></li>`);
  (m.milestones || []).forEach((x, k) => {
    const c = cl.get(`milestones[${k}].date`);
    if (c) dateRows.push(claimRow(ctx, c, x.label || "Milestone", dateHtml(c.claim)));
  });
  const lc = cl.get("lifecycle"), rb = cl.get("replacedBy");
  const lifeRows = [lc ? claimRow(ctx, lc, "Status", esc(LIFECYCLE_LABEL[lc.claim.value] || LIFECYCLE_LABEL.unknown)) : null,
    rb ? claimRow(ctx, rb, "Replaced by", modelLink(site, rb.claim.modelId, i.org)) : null].filter(Boolean);
  const relRows = i.outRel.map(x => {
    const c = cl.get(x.path);
    if (!c) return null;
    const kind = `${REL_LABEL[x.r.type] || x.r.type}${x.r.type === "derived-from" && x.r.method ? ` (${lower(x.r.method)})` : ""}`;
    const ed = x.r.basis === "editorial" ? ` <span class="mh-editorial">Editorial</span>` : "";
    return claimRow(ctx, c, kind, `${modelLink(site, x.target, i.org)}${ed}`);
  }).filter(Boolean);
  const predIds = i.outRel.filter(x => x.r.type === "successor-of").map(x => x.target);
  const changeRows = (m.changes || []).map((x, k) => {
    const c = cl.get(`changes[${k}]`);
    if (!c) return null;
    const rel = x.relativeTo || (predIds.length === 1 ? predIds[0] : null);   // the default is the single predecessor
    return claimRow(ctx, c, `Change · ${label(x.aspect || "other")}`, `${esc(x.text || "")}${rel ? `<span class="mh-note">Compared with ${modelLink(site, rel, i.org)}</span>` : ""}`);
  }).filter(Boolean);
  const capRows = [];
  const caps = m.capabilities || {};
  for (const key of Object.keys(CAP_LABEL)) {
    if (key === "features") {
      (caps.features || []).forEach((f, k) => { const c = cl.get(`capabilities.features[${k}]`); if (c) capRows.push(claimRow(ctx, c, "Feature", esc(label(f.key)))); });
      continue;
    }
    const c = cl.get(`capabilities.${key}`);
    if (c) capRows.push(claimRow(ctx, c, CAP_LABEL[key], esc(capValue(key, c.claim))));
  }
  const group = (id, name, rows) => (rows.length ? `<ul id="${id}" class="mh-claim-rows" aria-label="${esc(name)}">\n${rows.join("\n")}\n</ul>` : `<ul id="${id}" class="mh-claim-rows" aria-label="${esc(name)}"></ul>`);

  // Lineage (design 1e): six groups of links, plus all descendants (spec §8).
  const inn = site.inRel.get(i.id) || [];
  const metaOf = (id, rel) => {
    const t = site.modelById.get(id); if (!t) return "";
    return [t.org !== i.org ? site.orgName(t.org) : null, t.td ? formatDate(t.td.dv) : "Date unknown", rel].filter(Boolean).join(" · ");
  };
  const item = (id, rel) => `<li>${modelLink(site, id, null)} <span class="mh-muted">· ${esc(metaOf(id, rel))}</span></li>`;
  const relName = r => (r.type === "variant-of" ? "variant" : r.type === "revision-of" ? "revision" : r.type === "derived-from" ? `derived (${lower(r.method || "other")})` : null);
  const groups = [
    ["predecessors", "Predecessors", i.outRel.filter(x => x.r.type === "successor-of").map(x => item(x.target)), "No known predecessor."],
    ["successors", "Successors", inn.filter(x => x.r.type === "successor-of").map(x => item(x.from)), "No known successor."],
    ["parents", "Based on", i.outRel.filter(x => x.r.type !== "successor-of").map(x => item(x.target, relName(x.r))), "Not derived from another model."],
    ["children", "Variants and derived", inn.filter(x => x.r.type !== "successor-of").map(x => item(x.from, relName(x.r))), "None recorded."],
    ["siblings", "Siblings", [...site.sortIds(i.g.siblings).map(id => item(id)), ...inlineSiblings(site, i)], "None recorded."],
    ["ancestors", "All ancestors", site.sortIds(i.g.ancestors).map(id => item(id)), "None."],
    ["descendants", "All descendants", site.sortIds(i.g.descendants).map(id => item(id)), "None."]
  ];
  const lineage = `<div class="mh-lineage-grid">\n${groups.map(([k, t, items, none]) => `<div class="mh-lineage-group"><h3 class="mh-legend">${t}</h3>\n${items.length ? ul(items, ` class="mh-rel" data-mh-lineage="${k}"`) : `<p class="mh-none" data-mh-lineage="${k}">${none}</p>`}</div>`).join("\n")}\n</div>`;

  // Variants: an anchor per inline variant, plus placeholders for promoted ones (spec §13).
  const seen = new Set();
  const variants = (m.variants || []).map((v, k) => {
    if (!v || !v.id || seen.has(v.id)) return null;
    seen.add(v.id);
    const vc = cl.get(`variants[${k}]`);
    const vd = ["announced", "released", "deprecated", "retired"].map(dk => [dk, cl.get(`variants[${k}].dates.${dk}`)]).filter(x => x[1]);
    const va = [...new Set((v.aliases || []).map(a => a && a.text).filter(t => t && normalize(t) !== normalize(v.name)))];
    // Not claims in the §19.1 list: shown with their own sources and an explicit "not assessed".
    const unassessed = `<span class="mh-ev mh-ev-unassessed">${esc(UNASSESSED_LABEL)}</span>`;
    const vcap = v.capabilities && typeof v.capabilities === "object" ? v.capabilities : {};
    const capsV = Object.keys(CAP_LABEL).filter(key => key !== "features" && vcap[key] && typeof vcap[key] === "object")
      .map(key => `<li data-mh-variant-claim="capabilities.${key}">${CAP_LABEL[key]}: <span class="mh-value">${esc(capValue(key, vcap[key]))}</span> ${unassessed} ${refs(ctx, vcap[key].sources)}</li>`);
    const vl = v.lifecycle && typeof v.lifecycle === "object" && v.lifecycle.value
      ? `\n<p data-mh-variant-claim="lifecycle">Status: <span class="mh-value">${esc(LIFECYCLE_LABEL[v.lifecycle.value] || v.lifecycle.value)}</span> ${unassessed} ${refs(ctx, v.lifecycle.sources)}</p>` : "";
    return `<section id="variant-${esc(v.id)}" class="mh-variant">
<h3 class="mh-variant-name">${esc(v.name || v.id)}</h3>
${vd.length ? ul(vd.map(([dk, c]) => claimRow(ctx, c, DATE_LABEL[dk], dateHtml(c.claim))), ' class="mh-claim-rows"') : `<p class="mh-muted">Same dates as ${esc(m.name)}.</p>`}
${vc ? ul([claimRow(ctx, vc, "Variant", "Inline variant in this record.")], ' class="mh-claim-rows"') : `<p class="mh-muted">Inline variant in this record.${v.note ? ` ${esc(v.note)}` : ""}</p>`}${vl}${va.length ? `\n<p class="mh-muted">Also known as: ${esc(va.join(", "))}</p>` : ""}${capsV.length ? `\n<p class="mh-muted">Differs in:</p>\n${ul(capsV, ' class="mh-variant-caps"')}` : ""}
</section>`;
  }).filter(Boolean);
  for (const p of site.promotedTo.get(i.id) || []) {
    if (seen.has(p.variantId)) continue;
    seen.add(p.variantId);
    variants.push(`<section id="variant-${esc(p.variantId)}" class="mh-variant mh-promoted">\n<h3 class="mh-variant-name">${esc(p.info.m.name)}</h3>\n<p>This variant now has its own page: <a href="${esc(p.info.url)}">${esc(p.info.m.name)}</a>.</p>\n</section>`);
  }

  // Evidence card (design 1e): the status for existence and release, flags, claim counts.
  const scope = i.td ? `Evidence for ${i.td.kind === "released" ? "existence and release" : "existence and announcement"}` : "Evidence for existence";
  const sum = i.ev.summary;
  const na = i.ev.claims.filter(c => c.evidence === "not-applicable").length;
  const total = i.ev.claims.length;
  const counts = [...Object.keys(EVIDENCE_SHORT).filter(e => sum[e]).map(e => `<span data-mh-summary="${e}">${esc(EVIDENCE_SHORT[e])}: ${sum[e]}</span>`),
    na ? `<span data-mh-summary="not-applicable">${esc(NOT_APPLICABLE_LABEL)}: ${na}</span>` : null].filter(Boolean);
  const evidence = `<aside id="evidence" class="mh-ev-card" aria-labelledby="mh-ev-title">
<h2 class="mh-legend" id="mh-ev-title">${esc(scope)}</h2>
<p class="mh-ev-status">${evLongHtml(i.ev.evidence)}</p>
${i.ev.flags.length || m.coverage === "stub" ? ul([...i.ev.flags.map(f => flagHtml(f, "li")), m.coverage === "stub" ? `<li class="mh-flag" data-mh-flag="stub">${STUB_LABEL}</li>` : ""].filter(Boolean), ' class="mh-flags"') : ""}
<p class="mh-ev-counts">${esc(plural(total, "claim", "claims"))}${counts.length ? " · " + counts.join(" · ") : ""}${sum.originalUnavailable ? ` · <span data-mh-summary="original-unavailable">Original unavailable: ${sum.originalUnavailable}</span>` : ""}</p>
</aside>`;

  // Facts (aside, design 1e) = the identity section.
  const orgs = (m.organizations || []).map(x => {
    const top = site.topOrg(x.id), unit = top && top !== x.id ? ` <span class="mh-muted">(unit of ${orgLink(site, top)})</span>` : "";
    const name = site.orgById.has(x.id) ? orgLink(site, x.id) : esc(site.orgName(x.id));
    return `${logoHtml(site, ctx, x.id)}${name}${unit}${x.role && x.role !== "developer" ? ` <span class="mh-muted">${esc(x.role)}</span>` : ""}`;
  });
  const aliases = [...new Set((m.aliases || []).map(a => a && a.text).filter(t => t && normalize(t) !== normalize(m.name)))];
  const promoted = typeof m.promotedFrom === "string" && m.promotedFrom.split("#");
  const facts = [
    ["Organisation", orgs.join("<br>")],
    fam ? ["Family", org ? `<a href="${esc(org.url)}#family-${esc(fam.id)}">${esc(fam.name)}</a>` : esc(fam.name)] : null,
    m.generation ? ["Generation", esc(m.generation)] : null,
    ["Timeline date", `${timelineHtml(i.td)}<br><span class="mh-muted">${esc(precNote(i.td))}</span>`],
    m.prominence ? ["Prominence", `${esc(PROMINENCE_LABEL[m.prominence] || m.prominence)} <span class="mh-editorial">Editorial</span>`] : null,
    aliases.length ? ["Also known as", esc(aliases.join(", "))] : null,
    promoted && site.modelById.has(promoted[0]) ? ["Previously", `a variant of ${modelLink(site, promoted[0], i.org)}`] : null,
    ["Record", m.coverage === "stub" ? "Stub" : "Full record"],
    m.lastReviewedAt && parseDate(m.lastReviewedAt) ? ["Last reviewed", dateHtml({ value: m.lastReviewedAt })] : null
  ].filter(Boolean);

  // Previous/next: in the family (design 1e), else in the organisation's timeline.
  const scopeList = fam ? site.chrono(site.models.filter(x => x.m.familyId === fam.id)) : org ? site.chrono(org.routed) : [];
  const where = fam ? fam.name : orgName;
  const k = scopeList.indexOf(i), prev = k > 0 ? scopeList[k - 1] : null, next = k >= 0 && k < scopeList.length - 1 ? scopeList[k + 1] : null;
  const pager = prev || next ? `<nav class="mh-pager" aria-label="More models">
${prev ? `<a class="mh-pager-prev" href="${esc(prev.url)}"><span class="mh-muted">← Earlier in ${esc(where)}</span><span>${esc(prev.m.name)}</span></a>` : "<span></span>"}
${next ? `<a class="mh-pager-next" href="${esc(next.url)}"><span class="mh-muted">Later in ${esc(where)} →</span><span>${esc(next.m.name)}</span></a>` : "<span></span>"}
</nav>` : "";

  const news = i.news.map(n => newsRow(site, { ...n, variantName: n.variantId && ((m.variants || []).find(v => v && v.id === n.variantId) || {}).name }, null, false));
  const coverage = `<section id="coverage">
${h2("Related AI Radar coverage")}
${news.length ? ul(news, ' class="mh-news"') : `<p class="mh-empty-text">${esc(EMPTY_COVERAGE)}</p>`}${dashboardLink(site, i.org)}
</section>`;

  // The source list is rendered last, so its numbering follows the first citations.
  const claimsHtml = [group("dates", "Dates", dateRows), group("lifecycle", "Lifecycle", lifeRows), group("relations", "Relations", relRows),
    group("changes", "Key changes", changeRows), group("capabilities", "Capabilities", capRows)].join("\n");
  const lineageHtml = `<section id="lineage">\n${h2("Lineage")}\n${lineage}\n</section>`;
  const variantsHtml = `<section id="variants">\n${variants.length ? `${h2("Variants")}\n${variants.join("\n")}` : `<h2 class="mh-visually-hidden">Variants</h2>\n<p class="mh-visually-hidden">No variants recorded in this record.</p>`}\n</section>`;
  const sources = sourceList(site, ctx, i.refIds);

  const main = `<main id="main"${coAttrs(site, i.org, "mh mh-model")} data-mh-view="model" data-mh-model="${esc(m.id)}">
<div class="mh-page-head mh-model-head container">
<div class="mh-head-main">
${crumbsHtml(site, [{ name: "Model History", url: "/models/" }, { name: orgName, url: `/models/${i.org}/`, org: true }, ...(fam && org ? [{ name: fam.name, url: `${org.url}#family-${fam.id}` }] : []), { name: m.name, url: i.url }], i.org)}
<h1 class="mh-title">${logoHtml(site, ctx, i.org)}${esc(m.name)}</h1>
<p class="mh-sub">${sub}</p>
${summary}${stub}
<p class="mh-actions"><a class="mh-btn-outline" href="${esc(timelineUrl(i))}">Timeline of ${esc(m.name)} →</a></p>
</div>
${evidence}
</div>
<div class="mh-page-body container">
<article class="mh-body-main">
<section id="claims" aria-labelledby="mh-claims-title">
${h2("Claims and evidence", "mh-claims-title")}
${claimsHtml}
</section>
${lineageHtml}
${variantsHtml}
${coverage}
${pager}
</article>
<aside class="mh-body-side">
<section id="identity" aria-label="Facts">
<dl class="mh-facts">
${facts.map(([k2, v]) => `<div><dt>${k2}</dt><dd>${v}</dd></div>`).join("\n")}
</dl>
</section>
<section id="sources" aria-labelledby="mh-src-title">
<h2 class="mh-legend" id="mh-src-title">Sources</h2>
${sources}
</section>
</aside>
</div>
</main>`;
  const when = i.td ? `${i.td.kind === "released" ? "released" : "announced"} ${formatDate(i.td.dv)}` : "release date unknown";
  const desc = sc && sc.claim.text ? clip(sc.claim.text) : clip(`${m.name} is a model by ${orgName}${fam ? ` in the ${fam.name} family` : ""}, ${when}.`);
  return page({ path: i.url, title: `${m.name} · ${orgName} · Model History · AI Radar`, description: desc, indexable: m.coverage === "full", main,
    crumbs: [{ name: "Model History", url: "/models/" }, { name: orgName, url: `/models/${i.org}/` }, { name: m.name, url: i.url }] });
}

/* ---------- Model Timeline (/models/<org>/<slug>/timeline/, design 3a) ---------- */
const num = v => (Math.round(v * 10000) / 10000).toString();
// Timeline context for timeline.mjs: accessors on the compiled site; "now" is the as-of day.
function timelineCtx(site) {
  return {
    byId: id => (site.modelById.get(id) || {}).m || null,
    href: o => (site.modelById.get(o.id) || {}).url || null,
    graph: Object.fromEntries(site.models.map(x => [x.id, x.g])),
    sources: m => { const x = site.modelById.get(m.id); return x ? x.refIds.map(id => site.idx.srcById.get(id)).filter(Boolean) : []; },
    status: id => site.idx.status[id] || null,
    news: m => { const x = site.modelById.get(m.id); return x ? x.news : []; },
    now: new Date((site.asOf || "2026-01-01") + "T12:00:00Z")
  };
}
const KIND_CLASS = { life: "k-life", mile: "k-mile", lin: "k-lin", src: "k-src", news: "k-news" };
export function timelinePage(site, i) {
  const m = i.m, orgName = site.orgName(i.org), fam = m.familyId && site.famById.get(m.familyId);
  const t = layoutTimeline(m, timelineCtx(site));
  // Not "--h…": tokens.css treats any inline style containing "--h" as a company hue.
  const zoomVars = Object.keys(ZOOMS).map(z => `--axis-${z[0]}:${t.geometry[z].axis}px;--tlh-${z[0]}:${t.geometry[z].height}px`).join(";");
  const nodes = t.nodes.map(n => {
    const lane = Object.keys(ZOOMS).map(z => `--s-${z[0]}:${n.lane[z].s};--o-${z[0]}:${n.lane[z].o}px`).join(";");
    const above = Object.keys(ZOOMS).filter(z => n.lane[z].s < 0).map(z => z[0]).join(" ");
    const pos = n.unknown ? `--t:${num(t.span)};--dx:${UNKNOWN_DX}px` : `--t:${num(n.rel.t)};--r0:${num(n.rel.r0)};--r1:${num(n.rel.r1)}`;
    return `<div class="mh-tl-node ${KIND_CLASS[n.kind]}${n.unknown ? " mh-tl-unknown" : ""}" style="${pos};${lane}" data-above="${above}"${n.focus ? " data-focus" : ""}>${n.ranged ? `<span class="mh-tl-range"></span>` : ""}<span class="mh-tl-stem"></span><span class="mh-tl-dot"></span><span class="mh-tl-label"><span class="mh-tl-name">${esc(n.label)}</span><span class="mh-tl-meta">${esc(n.meta)}</span></span></div>`;
  });
  const years = t.years.map(y => `<div class="mh-tl-year" style="--t:${num(y.t)}"><span>${y.year}</span></div>`);
  const asOfText = site.asOf ? `As of ${formatDate({ value: site.asOf })}` : "Today";
  const list = t.list.map(e => `<li>
<span class="mh-tl-list-date">${e.dt ? `<time datetime="${esc(e.dt)}">${esc(e.date)}</time>` : esc(e.date)}</span>
<span class="mh-tl-list-kind">${esc(e.kind)}</span>
<span class="mh-tl-list-label">${e.href ? `<a href="${esc(e.href)}">${esc(e.label)}</a>` : esc(e.label)}${e.note ? ` <span class="mh-muted">· ${esc(e.note)}</span>` : ""}</span>
</li>`);
  const picker = site.chrono(site.models).map(x => `<option value="${esc(timelineUrl(x))}"${x === i ? " selected" : ""}>${esc(x.m.name)} · ${esc(site.orgName(x.org))}</option>`);
  const sub = [lifeText(m), catsText(m), m.prominence === "milestone" ? "Milestone" : null].filter(Boolean).map(esc).join(" · ");
  const main = `<main id="main"${coAttrs(site, i.org, "mh mh-timeline")} data-mh-view="timeline" data-mh-model="${esc(m.id)}">
<div class="mh-page-head mh-tl-head container">
<div class="mh-head-main">
${crumbsHtml(site, [{ name: "Model History", url: "/models/" }, { name: orgName, url: `/models/${i.org}/`, org: true }, { name: m.name, url: i.url }, { name: "Timeline", url: timelineUrl(i) }], i.org)}
<h1 class="mh-title">${esc(m.name)}</h1>
<p class="mh-sub">${sub} · ${evLongHtml(i.ev.evidence)}</p>
</div>
<div class="mh-tl-tools">
<div id="mh-tl-picker" class="mh-tl-picker" hidden><label for="mh-tl-pick">Another model</label>
<div class="mh-tl-pick-row"><select id="mh-tl-pick">
${picker.join("\n")}
</select><button type="button" id="mh-tl-go" class="mh-btn-dark">Open</button></div></div>
<div id="mh-tl-zoom" class="mh-seg" role="group" aria-label="Zoom" hidden>
<button type="button" data-zoom="compact" aria-pressed="false">Compact</button>
<button type="button" data-zoom="normal" aria-pressed="true">Normal</button>
<button type="button" data-zoom="wide" aria-pressed="false">Wide</button>
</div>
</div>
</div>
<div class="container">
<ul class="mh-tl-legend" aria-label="Legend">
<li><span class="mh-tl-key k-life"></span>Lifecycle</li>
<li><span class="mh-tl-key k-mile"></span>Milestone or variant</li>
<li><span class="mh-tl-key k-lin"></span>Related model</li>
<li><span class="mh-tl-key k-src"></span>Source event</li>
<li><span class="mh-tl-key k-news"></span>AI Radar coverage</li>
<li><span class="mh-tl-key k-range"></span>Only month or year known</li>
<li class="mh-tl-count">${esc(plural(t.count, "event", "events"))}</li>
</ul>
<div class="mh-tl-scroll" role="img" tabindex="0" aria-label="${esc(`Timeline of ${m.name}; the same events are listed below`)}">
<div id="mh-tl" class="mh-tl" data-zoom="normal" data-t0="${num(t.T0)}" data-span="${num(t.span)}" style="--span:${num(t.span)};--today:${num(t.today)};${zoomVars};--lw:${LABEL_W}px;--lh:${LABEL_H}px;--pad:${PAD_X}px">
${years.join("\n")}
<div class="mh-tl-today"><span id="mh-tl-today-label">${esc(asOfText)}</span></div>${t.nodes.some(n => n.unknown) ? `\n<div class="mh-tl-unknown-zone"><span>Date unknown</span></div>` : ""}
<div class="mh-tl-axis"></div>
${nodes.join("\n")}
</div>
</div>
<section class="mh-tl-events" aria-labelledby="mh-tl-list-title">
<h2 class="mh-legend" id="mh-tl-list-title">All events, in order</h2>
<ol class="mh-tl-list">
${list.join("\n")}
</ol>
<p class="mh-more"><a href="${esc(i.url)}">← The full record of ${esc(m.name)}, with every claim and its sources</a></p>
</section>
</div>
</main>`;
  const desc = clip(`Timeline of ${m.name} by ${orgName}: announcement, release, milestones, related models, source events and AI Radar coverage, with dates at their real precision.`);
  return page({ path: timelineUrl(i), title: `${m.name} timeline · ${orgName} · Model History · AI Radar`, description: desc, indexable: m.coverage === "full", main,
    scripts: ["/assets/model-pages.js"],
    crumbs: [{ name: "Model History", url: "/models/" }, { name: orgName, url: `/models/${i.org}/` }, { name: m.name, url: i.url }, { name: "Timeline", url: timelineUrl(i) }] });
}

/* ---------- Redirect stub (previousSlugs / previousRoutes, spec §5.4) ---------- */
export function redirectPage(site, r) {
  const main = `<main id="main" class="container mh" data-mh-view="redirect">
<h1 class="mh-title">This page has moved</h1>
<p><a href="${esc(r.to.url)}">${esc(r.to.m.name)}</a> now has a new address.</p>
</main>`;
  return page({ path: r.from, redirectTo: r.to.url, title: `${r.to.m.name} · Model History · AI Radar`, indexable: false, main,
    description: `This page moved to ${SITE}${r.to.url}`, crumbs: [] });
}
