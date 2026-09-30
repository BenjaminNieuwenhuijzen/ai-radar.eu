/* Model History: HTML string templates for the generated pages (Explorer, Company Model
   History, Model Detail, redirect stubs). Pure functions: they receive the compiled site
   from build.mjs and return strings; nothing here reads files or the clock.

   The markup is a semantic contract, not a design: headings, lists, <time datetime>,
   text labels and data-mh-* attributes that assets/models.js and the later design build
   on (spec §34). Every text goes through escapeHtml. The only unescaped markup is the
   inline logo SVG from assets/registry.js, which is repo code, not data.

   Sections: labels · small helpers · page shell · Explorer · Company · Model Detail ·
   redirect stub. */
import { SITE, escapeHtml as esc, formatDate, datetimeAttr, parseDate, normalize } from "./lib.mjs";

/* ---------- Labels (English site text, spec §16.4, §21.4) ---------- */
export const EVIDENCE_LABEL = {
  "primary-source": "Primary source available",
  "archived-primary-source": "Archived primary source",
  "secondary-sources": "Verified through secondary sources",
  "insufficient-evidence": "Historical evidence incomplete"
};
export const FLAG_LABEL = {
  "original-unavailable": "Original source unavailable",
  "some-claims-incomplete": "Some details lack sources"
};
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
const REL_INCOMING = { "successor-of": "successor", "variant-of": "variant", "revision-of": "revision", "derived-from": "derived model" };
const AVAIL_LABEL = { active: "Online", archived: "Original gone, archived copy available", unavailable: "Original unavailable, no archived copy", unknown: "Not yet verified" };
const PROV_LABEL = { primary: "Primary source", "archived-primary": "Archived primary source", secondary: "Secondary source" };
const PROVIDER_LABEL = { "internet-archive": "Internet Archive capture", publisher: "Publisher archive", arxiv: "arXiv version", github: "GitHub permalink",
  huggingface: "Hugging Face revision", "software-heritage": "Software Heritage archive", "other-approved": "Archived copy" };
const CAP_LABEL = { inputModalities: "Input modalities", outputModalities: "Output modalities", features: "Features", openWeights: "Open weights",
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
export const timelineHtml = td => (!td ? "Date unknown"
  : td.kind === "released" ? `Released ${dateHtml(td.dv)}` : `Announced ${dateHtml(td.dv)}, release date unknown`);
// The four statuses and "not-applicable" have their own text; any other value is not a
// known state and fails closed to the gap label, never to a label that claims proof.
const evText = e => (Object.hasOwn(EVIDENCE_LABEL, e) ? EVIDENCE_LABEL[e] : e === "not-applicable" ? NOT_APPLICABLE_LABEL : EVIDENCE_LABEL["insufficient-evidence"]);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const jsonScript = v => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const safeHref = u => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);

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
function modelLink(site, id, fromOrg) {
  const t = site.modelById.get(id);
  if (!t) return `<span class="mh-missing">${esc(id)}</span>`;
  const other = fromOrg && t.org !== fromOrg ? ` <span class="mh-org-tag">(${esc(site.orgName(t.org))})</span>` : "";
  return `<a href="${esc(t.url)}">${esc(t.m.name)}</a>${other}`;
}
const orgLink = (site, id) => (site.orgById.has(id) ? `<a href="${esc(site.orgById.get(id).url)}">${esc(site.orgName(id))}</a>` : esc(site.orgName(id)));
// Siblings also include the inline variants of the record a model is a variant or revision
// of (spec §12.4, §13.3). The derived id sets (§12.5) only hold records, and an inline
// variant has no page, so these link to its anchor on that record's page.
function inlineSiblings(site, i) {
  const out = [], seen = new Set();
  for (const x of i.outRel) {
    const p = (x.r.type === "variant-of" || x.r.type === "revision-of") && site.modelById.get(x.target);
    if (!p) continue;
    for (const v of p.m.variants || []) {
      const key = v && typeof v.id === "string" && v.id ? `${p.id}#${v.id}` : null;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(`<li><a href="${esc(p.url)}#variant-${esc(v.id)}">${esc(v.name || v.id)}</a> <span class="mh-muted">(inline variant in the record of ${esc(p.m.name)})</span></li>`);
    }
  }
  return out;
}

// Source references of one claim, as links to the page's source list (with locator).
function refs(ctx, list) {
  const rs = (Array.isArray(list) ? list : []).filter(r => r && typeof r.id === "string");
  if (!rs.length) return `<span class="mh-refs mh-refs-none">No source recorded</span>`;
  const items = rs.map(r => `<a class="mh-ref" href="#source-${esc(r.id)}">[${cite(ctx, r.id)}]</a>${r.locator ? ` <span class="mh-locator">${esc(r.locator)}</span>` : ""}`);
  return `<span class="mh-refs">${rs.length > 1 ? "Sources" : "Source"}: ${items.join(", ")}</span>`;
}
function evHtml(ev) {
  const flag = ev.originalUnavailable ? ` <span class="mh-flag" data-mh-flag="original-unavailable">${esc(FLAG_LABEL["original-unavailable"])}</span>` : "";
  return `<span class="mh-ev" data-mh-evidence="${esc(ev.evidence)}">${esc(evText(ev.evidence))}</span>${flag}`;
}
// Differing values from other sources are shown, never silently dropped (spec §19.3).
function altHtml(ctx, claim) {
  const alts = Array.isArray(claim.alternatives) ? claim.alternatives.filter(a => a && a.value) : [];
  if (!alts.length) return "";
  return ` <span class="mh-alt">Other sources give: ${alts.map(a => `${dateHtml(a)} ${refs(ctx, a.sources)}${a.note ? ` <span class="mh-note">${esc(a.note)}</span>` : ""}`).join("; ")}</span>`;
}
// One claim element: its value, its own evidence label and its own sources (spec §8, AC-31).
function claimEl(ctx, tag, c, body, cls = "") {
  const dated = c.kind === "date" || c.kind === "variant-date" || c.kind === "milestone";
  const note = c.claim.note ? ` <span class="mh-note">${esc(c.claim.note)}</span>` : "";
  return `<${tag} class="mh-claim${cls ? " " + cls : ""}" data-mh-claim="${esc(c.path)}" data-mh-evidence="${esc(c.evidence)}">${body} ${evHtml(c)} ${refs(ctx, c.claim.sources)}${dated ? altHtml(ctx, c.claim) : ""}${note}</${tag}>`;
}
const section = (id, title, body) => `<section id="${id}" class="mh-section">\n<h2>${esc(title)}</h2>\n${body}\n</section>`;
const ul = (items, attrs = "") => `<ul${attrs}>\n${items.join("\n")}\n</ul>`;

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

// aria-current="page" only on /models/ itself; the detail pages are inside the section.
const header = current => `<header class="site-header">
  <div class="container">
    <a class="brand" href="/">
      <span class="radar" aria-hidden="true"><span class="radar-hand"></span><span class="radar-dot"></span></span>
      AI Radar
    </a>
    <nav class="site-nav" aria-label="Main">
      <a class="nav-link" href="/">Dashboard</a>
      <a class="nav-link" href="/about">About</a>
      <a class="nav-link" href="/models/" aria-current="${current}">Models</a>
      <a class="nav-link" href="/feed.xml">RSS</a>
      <button class="motion-btn" type="button" data-motion-toggle><span class="motion-is-on">Motion on</span><span class="motion-is-off">Motion off</span></button>
      <button class="theme-btn" type="button" data-theme-toggle><span class="theme-to-dark">Dark<span class="narrow-hide"> mode</span></span><span class="theme-to-light">Light<span class="narrow-hide"> mode</span></span></button>
      <a class="subscribe-btn" href="/#subscribe">Subscribe</a>
    </nav>
  </div>
</header>`;

// The header links are hidden on phones (pages.css), so Models is in the footer too.
const footer = current => `<footer class="site-footer">
  <div class="container">
    <span>AI Radar &middot; Made by Benjamin Nieuwenhuijzen</span>
    <nav class="footer-links" aria-label="Footer">
      <a href="/">Dashboard</a>
      <a href="/about">About</a>
      <a href="/models/" aria-current="${current}">Models</a>
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
function crumbsHtml(crumbs) {
  const items = crumbs.map((c, i) => (i === crumbs.length - 1 ? `<li aria-current="page">${esc(c.name)}</li>` : `<li><a href="${esc(c.url)}">${esc(c.name)}</a></li>`));
  return `<nav class="mh-crumbs" aria-label="Breadcrumb"><ol>${items.join("")}</ol></nav>`;
}
// Descriptions stay under ~155 characters and end on a whole word.
export function clip(s, n = 155) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1), sp = cut.lastIndexOf(" ");
  return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "") + "…";
}

/* ---------- Shared list item (Explorer and chronology) ---------- */
function itemBody(site, i, withOrg) {
  const m = i.m, fam = m.familyId && site.famById.get(m.familyId);
  const flags = i.ev.flags.map(f => `<span class="mh-item-flag" data-mh-flag="${esc(f)}">${esc(FLAG_LABEL[f] || f)}</span>`).join(" ");
  return [
    `<a class="mh-item-name" href="${esc(i.url)}">${esc(m.name)}</a>`,
    withOrg ? `<span class="mh-item-org">${esc(site.orgName(i.org))}</span>` : null,
    fam ? `<span class="mh-item-family">${esc(fam.name)}</span>` : null,
    `<span class="mh-item-date">${timelineHtml(i.td)}</span>`,
    `<span class="mh-item-life">${esc(LIFECYCLE_LABEL[m.lifecycle && m.lifecycle.value] || LIFECYCLE_LABEL.unknown)}</span>`,
    `<span class="mh-item-ev" data-mh-evidence="${esc(i.ev.evidence)}">${esc(evText(i.ev.evidence))}</span>`,
    flags || null,
    m.coverage === "stub" ? `<span class="mh-item-stub">Incomplete record</span>` : null
  ].filter(Boolean).join("\n");
}

/* ---------- Explorer (/models/) ---------- */
export function explorerPage(site) {
  const orgs = site.orgs.filter(o => o.routed.length);
  const items = site.explorer.map(i => `<li${coAttrs(site, i.org, "mh-item")} data-mh-model="${esc(i.id)}">\n${itemBody(site, i, true)}\n</li>`);
  const main = `<main id="main" class="container mh" data-mh-view="explorer">
<header class="mh-head">
<h1>Model History</h1>
<p class="mh-lead">${esc(`${plural(site.models.length, "model", "models")} from ${plural(orgs.length, "organisation", "organisations")}: when each was announced and released, how the models relate, and the sources behind every fact. Dates are only as precise as their sources.`)}</p>
</header>
<nav class="mh-orgs" aria-label="Organisations">
${ul(orgs.map(o => `<li><a href="${esc(o.url)}">${esc(o.o.name)}</a> <span class="mh-count">${esc(plural(o.routed.length, "model", "models"))}</span></li>`))}
</nav>
<div id="mh-controls" class="mh-controls" hidden>
<input type="search" id="mh-search" aria-label="Search models" autocomplete="off" spellcheck="false" placeholder="Search models">
<label for="mh-sort">Sort</label>
<select id="mh-sort">
<option value="date-desc" selected>Newest first</option>
<option value="date-asc">Oldest first</option>
<option value="name">Name</option>
<option value="org">Organisation</option>
</select>
<div id="mh-facets"></div>
<button type="button" id="mh-clear">Clear filters</button>
</div>
<p id="mh-count" aria-live="polite"></p>
<p id="mh-empty" hidden>No models match these filters.</p>
<p id="mh-error" hidden>Search and filters could not be loaded. The full list below still works. <button type="button" id="mh-retry">Retry</button></p>
<ol id="mh-list" class="mh-list">
${items.join("\n")}
</ol>
</main>`;
  // Always indexable (spec §5.1 "ja", §30); sitemapXml always lists /models/ to match.
  return page({ path: "/models/", title: "Model History · AI Radar", indexable: true, main, scripts: ["/assets/models.js"],
    description: "Every AI model in AI Radar Model History, with release dates at their real precision, lineage, and the sources behind each fact.",
    crumbs: [{ name: "Model History", url: "/models/" }] });
}

/* ---------- Company Model History (/models/<org>/) ---------- */
// Chronology groups: year -> month -> day entries; coarser dates form their own
// "exact date unknown" group at the start of their period (spec §21.3, AC-04).
export function groupChronology(items) {
  const years = [], unknown = [];
  for (const it of items) {
    const p = it.td && parseDate(it.td.dv.value);
    if (!p) { unknown.push(it); continue; }
    let y = years[years.length - 1];
    if (!y || y.year !== p.y) years.push(y = { year: p.y, yearOnly: [], months: [] });
    if (p.precision === "year") { y.yearOnly.push(it); continue; }
    let mo = y.months[y.months.length - 1];
    if (!mo || mo.month !== p.m) y.months.push(mo = { month: p.m, monthOnly: [], days: [] });
    (p.precision === "month" ? mo.monthOnly : mo.days).push(it);
  }
  return { years, unknown };
}
function chronoEntry(site, org, i) {
  const m = i.m;
  const codev = i.org !== org.id
    ? `\n<span class="mh-entry-note">Co-developed; listed under ${orgLink(site, i.org)}</span>` : "";
  // Only id and prominence as attributes: in-page filters reuse index.json, like the Explorer (§7).
  return `<li class="mh-entry" data-mh-model="${esc(i.id)}" data-mh-prominence="${esc(m.prominence || "")}">
${itemBody(site, i, false)}
<span class="mh-entry-prom">${esc(PROMINENCE_LABEL[m.prominence] || "")}</span>${codev}
</li>`;
}
function chronologyHtml(site, org, items) {
  const { years, unknown } = groupChronology(items);
  const entries = list => `<ol class="mh-entries">\n${list.map(i => chronoEntry(site, org, i)).join("\n")}\n</ol>`;
  const bucket = (value, list) => `<div class="mh-bucket" data-mh-bucket="${esc(value)}">\n<p class="mh-bucket-label">${esc(formatDate({ value }))}, exact date unknown</p>\n${entries(list)}\n</div>`;
  const lines = list => list.filter(Boolean).join("\n");
  const out = years.map(y => {
    const months = y.months.map(mo => {
      const v = `${y.year}-${String(mo.month).padStart(2, "0")}`;
      return lines([`<li class="mh-month" data-mh-period="${v}">`, `<h4>${esc(formatDate({ value: v }))}</h4>`,
        mo.monthOnly.length && bucket(v, mo.monthOnly), mo.days.length && entries(mo.days), `</li>`]);
    });
    return lines([`<li class="mh-year" data-mh-period="${y.year}">`, `<h3>${y.year}</h3>`,
      y.yearOnly.length && bucket(String(y.year), y.yearOnly), months.length && `<ol class="mh-months">\n${months.join("\n")}\n</ol>`, `</li>`]);
  });
  if (unknown.length) out.push(`<li class="mh-year mh-year-unknown" data-mh-period="unknown">\n<h3>Date unknown</h3>\n${entries(unknown)}\n</li>`);
  return out.length ? `<ol class="mh-chrono">\n${out.join("\n")}\n</ol>` : `<p class="mh-none">No models recorded yet.</p>`;
}
// Text-first lineage (spec §7, §31): per model, its relations by type as lists of links.
// A merge shows the model under each parent as a link, never as a duplicated subtree.
function lineageLists(site, i, fromOrg) {
  const out = i.outRel, inn = site.inRel.get(i.id) || [];
  const typed = (list, key, fn) => list.map(x => `<li>${modelLink(site, x[key], fromOrg)}${fn ? ` <span class="mh-rel-type">(${esc(fn(x.r))})</span>` : ""}</li>`);
  const outLabel = r => (r.type === "derived-from" && r.method ? `derived: ${lower(r.method)}` : lower(r.type.replace(/-of$/, "")));
  const inLabel = r => (r.type === "derived-from" && r.method ? `derived: ${lower(r.method)}` : REL_INCOMING[r.type] || r.type);
  const groups = [
    ["predecessors", "Predecessors", typed(out.filter(x => x.r.type === "successor-of"), "target", null)],
    ["successors", "Successors", typed(inn.filter(x => x.r.type === "successor-of"), "from", null)],
    ["parents", "Parents", typed(out.filter(x => x.r.type !== "successor-of"), "target", outLabel)],
    ["children", "Children", typed(inn.filter(x => x.r.type !== "successor-of"), "from", inLabel)],
    ["siblings", "Siblings", [...site.sortIds(i.g.siblings).map(id => `<li>${modelLink(site, id, fromOrg)}</li>`), ...inlineSiblings(site, i)]]
  ].filter(g => g[2].length);
  if (!groups.length) return `<p class="mh-none">No recorded relations.</p>`;
  return `<dl class="mh-lineage">\n${groups.map(([k, t, items]) => `<dt>${t}</dt>\n<dd>${ul(items, ` data-mh-lineage="${k}"`)}</dd>`).join("\n")}\n</dl>`;
}
export function companyPage(site, org) {
  const ctx = newCtx(), o = org.o;
  const all = site.chrono([...org.routed, ...org.coDev]);
  const oc = org.claims;
  // Organisation facts: description and former names are claims with their own sources.
  const facts = [];
  if (oc.get("description")) facts.push(claimEl(ctx, "p", oc.get("description"), esc(o.description.text), "mh-description"));
  const former = (o.formerNames || []).map((f, k) => {
    const c = oc.get(`formerNames[${k}]`);
    const span = [f.from ? `from ${dateHtml(f.from)}` : "", f.until ? `until ${dateHtml(f.until)}` : ""].filter(Boolean).join(" ");
    return c ? claimEl(ctx, "li", c, `${esc(f.name)}${span ? ` <span class="mh-period">(${span})</span>` : ""}`) : null;
  }).filter(Boolean);
  if (former.length) facts.push(`<h3>Former names</h3>\n${ul(former, ' class="mh-claims"')}`);
  const units = site.unitsOf(o.id).map(id => site.org(id)).filter(Boolean);
  if (units.length) facts.push(`<h3>Units</h3>\n${ul(units.map(u => `<li>${esc(u.name)} <span class="mh-muted">(${esc(label(u.type || "unit"))})</span></li>`))}`);
  const web = safeHref(o.website);
  facts.push(`<p class="mh-facts-line">${esc(label(o.type || "company"))}${web ? ` · <a href="${esc(web)}">${esc(o.website)}</a>` : ""} · ${esc(plural(org.routed.length, "model", "models"))} listed here</p>`);

  // Optional editorial story (spec §10.3): chapters are claims with sources.
  const chapters = ((o.narrative && o.narrative.chapters) || []).map((ch, k) => {
    const c = oc.get(`narrative.chapters[${k}]`);
    if (!c) return null;
    const per = ch.period ? [ch.period.from, ch.period.to].filter(Boolean).map(v => dateHtml({ value: v })).join("–") : "";
    const ms = (ch.modelIds || []).filter(id => site.modelById.has(id)).map(id => modelLink(site, id, o.id));
    return claimEl(ctx, "li", c, `<h3>${esc(ch.title || "")}</h3>${per ? `\n<p class="mh-period">${per}</p>` : ""}\n<p>${esc(ch.text || "")}</p>${ms.length ? `\n<p class="mh-chapter-models">Models: ${ms.join(", ")}</p>` : ""}\n`, "mh-chapter");
  }).filter(Boolean);

  // Families as a tree (parentId), each with its models in timeline order.
  const famIds = new Set(org.families.map(f => f.id));
  const placed = new Set();   // a parentId loop in bad data must not recurse forever
  const famItem = f => {
    placed.add(f.id);
    const kids = org.families.filter(x => x.parentId === f.id && !placed.has(x.id));
    kids.forEach(x => placed.add(x.id));
    const ms = site.chrono(org.routed.filter(i => i.m.familyId === f.id)).map(i => `<li><a href="${esc(i.url)}">${esc(i.m.name)}</a> <span class="mh-muted">${timelineHtml(i.td)}</span></li>`);
    return `<li id="family-${esc(f.id)}" class="mh-family">\n<h3>${esc(f.name)}</h3>\n${ms.length ? `<ol class="mh-family-models">\n${ms.join("\n")}\n</ol>` : `<p class="mh-none">No models listed yet.</p>`}${kids.length ? `\n${ul(kids.map(famItem), ' class="mh-families"')}` : ""}\n</li>`;
  };
  const roots = org.families.filter(f => !f.parentId || !famIds.has(f.parentId));
  const loose = site.chrono(org.routed.filter(i => !i.m.familyId || !famIds.has(i.m.familyId)));
  const famHtml = [roots.length ? ul(roots.map(famItem), ' class="mh-families"') : "",
    loose.length ? `<h3>Not in a family</h3>\n${ul(loose.map(i => `<li><a href="${esc(i.url)}">${esc(i.m.name)}</a></li>`))}` : ""].filter(Boolean).join("\n") || `<p class="mh-none">No families recorded.</p>`;

  const lineage = all.length ? `<ol class="mh-lineage-models">\n${all.map(i => `<li id="lineage-${esc(i.id)}">\n<a href="${esc(i.url)}">${esc(i.m.name)}</a>\n${lineageLists(site, i, o.id)}\n</li>`).join("\n")}\n</ol>` : `<p class="mh-none">No models recorded yet.</p>`;

  // Evidence overview: models per status, which ones have incomplete evidence, and which
  // rest on an archived copy. A lost original with a sound archive is not "incomplete" (§16.4).
  const counts = Object.keys(EVIDENCE_LABEL).map(e => [e, org.routed.filter(i => i.ev.evidence === e).length]).filter(x => x[1]);
  const weak = site.chrono(org.routed.filter(i => i.ev.evidence === "insufficient-evidence" || i.ev.flags.includes("some-claims-incomplete")));
  const lost = site.chrono(org.routed.filter(i => i.ev.flags.includes("original-unavailable")));
  const modelNote = (i, text) => `<li><a href="${esc(i.url)}">${esc(i.m.name)}</a> <span class="mh-muted">${esc(text)}</span></li>`;
  const evHtmlBlock = `<dl class="mh-ev-summary">\n${counts.map(([e, n]) => `<dt data-mh-evidence="${e}">${esc(EVIDENCE_LABEL[e])}</dt><dd>${esc(plural(n, "model", "models"))}</dd>`).join("\n")}\n</dl>` +
    (weak.length ? `\n<h3>Models with incomplete evidence</h3>\n${ul(weak.map(i => modelNote(i, [i.ev.evidence === "insufficient-evidence" ? EVIDENCE_LABEL[i.ev.evidence] : "",
      i.ev.flags.includes("some-claims-incomplete") ? FLAG_LABEL["some-claims-incomplete"] : ""].filter(Boolean).join("; "))), ' data-mh-list="incomplete"')}` : "") +
    (lost.length ? `\n<h3>Models whose original source is unavailable</h3>\n${ul(lost.map(i => modelNote(i, `${evText(i.ev.evidence)}; ${FLAG_LABEL["original-unavailable"]}`)), ' data-mh-list="original-unavailable"')}` : "");

  const news = org.news.slice(0, 10);
  const newsHtml = (news.length ? ul(news.map(n => newsItem(site, n, o.id)), ' class="mh-news"') : `<p class="mh-empty">${esc(EMPTY_COVERAGE)}</p>`) + dashboardLink(site, o.id);

  const sections = [
    section("organization", "About the organisation", facts.join("\n")),
    chapters.length ? section("story", "Story", `<ol class="mh-chapters">\n${chapters.join("\n")}\n</ol>`) : null,
    section("families", "Families", famHtml),
    section("chronology", "Chronology", chronologyHtml(site, org, all)),
    section("lineage", "Lineage", lineage),
    section("evidence", "Evidence overview", counts.length ? evHtmlBlock : `<p class="mh-none">No models listed under this organisation yet.</p>`),
    section("coverage", "Related AI Radar coverage", newsHtml),
    ctx.cites.size ? section("sources", "Sources", sourceList(site, ctx, [])) : null
  ].filter(Boolean);
  const notice = org.indexable ? "" : `\n<p class="mh-notice">Research on this organisation has not started yet: its model records are stubs or are listed under another organisation.</p>`;
  const main = `<main id="main"${coAttrs(site, o.id, "container mh")} data-mh-view="company" data-mh-org="${esc(o.id)}">
${crumbsHtml([{ name: "Model History", url: "/models/" }, { name: o.name, url: org.url }])}
<header class="mh-head">
${logoHtml(site, ctx, o.id)}<h1>${esc(o.name)}</h1>
<p class="mh-lead">${esc(`Model history of ${o.name}: ${plural(org.routed.length, "model", "models")}, in timeline order, with lineage and sources.`)}</p>${notice}
</header>
${sections.join("\n")}
<script type="application/json" id="mh-graph">${jsonScript(org.embed)}</script>
</main>`;
  const desc = o.description && o.description.text ? clip(o.description.text) : clip(`Models released by ${o.name}, with release dates, lineage and sources, in AI Radar Model History.`);
  return page({ path: org.url, title: `${o.name} models · Model History · AI Radar`, description: desc, indexable: org.indexable, main,
    crumbs: [{ name: "Model History", url: "/models/" }, { name: o.name, url: org.url }] });
}
function dashboardLink(site, orgId) {
  const rid = (site.org(orgId) || {}).radarCompanyId;
  if (!rid) return "";
  return `\n<p class="mh-dashboard-link"><a href="/?view=timeline&amp;cat=model-releases&amp;company=${esc(encodeURIComponent(rid))}">Model-release news from ${esc(site.orgName(orgId))} on the dashboard</a></p>`;
}
function newsItem(site, n, fromOrg) {
  const href = safeHref(n.link);
  const title = href ? `<a href="${esc(href)}">${esc(n.title)}</a>` : esc(n.title);
  const about = fromOrg && n.models ? n.models.map(x => {
    const t = site.modelById.get(x.id); if (!t) return null;
    const v = x.variantId && (t.m.variants || []).find(y => y && y.id === x.variantId);
    return `<a href="${esc(t.url)}${v ? "#variant-" + esc(v.id) : ""}">${esc(v ? v.name : t.m.name)}</a>`;
  }).filter(Boolean) : [];
  const variant = !fromOrg && n.variantId && n.variantName ? ` · about ${esc(n.variantName)}` : "";
  const via = [n.company, n.source].filter(Boolean).map(esc).join(" · ");
  return `<li class="mh-news-item">${title} <span class="mh-news-meta">${via}${via ? " · " : ""}${instantHtml(n.publishedAt, n.dateOnly)}${variant}${about.length ? ` · about ${about.join(", ")}` : ""}</span></li>`;
}

/* ---------- Model Detail (/models/<org>/<slug>/) ---------- */
function sourceList(site, ctx, extraIds) {
  // Cited sources in order of first citation, then any other source the record names.
  const ids = [...ctx.cites.keys()];
  for (const id of extraIds) if (!ctx.cites.has(id)) { cite(ctx, id); ids.push(id); }
  const items = ids.map(id => {
    const n = ctx.cites.get(id), v = site.source(id);
    if (!v) return `<li id="source-${esc(id)}" class="mh-source mh-source-missing"><span class="mh-source-n">[${n}]</span> Unknown source <code>${esc(id)}</code></li>`;
    const s = v.s, href = !s.suppressLink && safeHref(s.url), arch = !s.suppressLink && safeHref(s.archiveUrl);
    const meta = [label(s.type), s.publisher ? esc(s.publisher) : "", s.publishedAt && s.publishedAt.value ? `published ${dateHtml(s.publishedAt)}` : ""].filter(Boolean).join(" · ");
    const rows = [
      ["Availability", esc(AVAIL_LABEL[v.avail] || v.avail)],
      ["Provenance", esc(PROV_LABEL[v.prov] || v.prov)],
      s.archiveUrl ? ["Archived copy", `${arch ? `<a href="${esc(arch)}">${esc(PROVIDER_LABEL[s.archiveProvider] || "Archived copy")}</a>` : esc(PROVIDER_LABEL[s.archiveProvider] || "Archived copy")}${s.archivedAt ? `, captured ${instantHtml(s.archivedAt)}` : ""}${v.archiveGone ? " (the archived copy is also gone)" : ""}`] : null,
      ["Last checked", v.lastChecked ? instantHtml(v.lastChecked) || esc(v.lastChecked) : "Not yet checked"],
      ["Original URL", `<span class="mh-url">${esc(s.url || "")}</span>${s.suppressLink ? " (not linked at the request of the rights holder)" : ""}`]
    ].filter(Boolean);
    return `<li id="source-${esc(id)}" class="mh-source" data-mh-availability="${esc(v.avail)}" data-mh-provenance="${esc(v.prov)}">
<span class="mh-source-n">[${n}]</span> <cite>${href ? `<a href="${esc(href)}">${esc(s.title)}</a>` : esc(s.title)}</cite>
<span class="mh-source-meta">${meta}</span>
<dl class="mh-source-status">${rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join("")}</dl>
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
export function modelPage(site, i) {
  const ctx = newCtx(), m = i.m, cl = i.claims, org = site.orgById.get(i.org);
  const fam = m.familyId && site.famById.get(m.familyId);
  const d = m.dates || {};

  // Identity
  const orgs = (m.organizations || []).map(x => {
    const top = site.topOrg(x.id), unit = top && top !== x.id ? ` <span class="mh-muted">(unit of ${orgLink(site, top)})</span>` : "";
    const name = site.orgById.has(x.id) ? orgLink(site, x.id) : esc(site.orgName(x.id));
    return `<li>${logoHtml(site, ctx, x.id)}${name}${unit} <span class="mh-role">${esc(x.role || "")}</span></li>`;
  });
  const aliases = [...new Set((m.aliases || []).map(a => a && a.text).filter(t => t && normalize(t) !== normalize(m.name)))];
  const promoted = typeof m.promotedFrom === "string" && m.promotedFrom.split("#");
  const idRows = [
    ["Name", esc(m.name)],
    ["Organisations", ul(orgs, ' class="mh-orgs-list"')],
    fam ? ["Family", site.orgById.has(i.org) ? `<a href="${esc(org.url)}#family-${esc(fam.id)}">${esc(fam.name)}</a>` : esc(fam.name)] : null,
    m.generation ? ["Generation", esc(m.generation)] : null,
    ["Categories", esc((m.categories || []).map(label).join(", "))],
    m.prominence ? ["Prominence", `${esc(PROMINENCE_LABEL[m.prominence] || m.prominence)} <span class="mh-editorial">(editorial)</span>`] : null,
    aliases.length ? ["Also known as", esc(aliases.join(", "))] : null,
    promoted && site.modelById.has(promoted[0]) ? ["Previously", `a variant in the record of ${modelLink(site, promoted[0], i.org)}`] : null,
    ["Record", m.coverage === "stub" ? "Stub: only minimal details have been researched so far" : "Full record"]
  ].filter(Boolean);
  const identity = `<dl class="mh-facts">\n${idRows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("\n")}\n</dl>`;

  // Dates: every value with its precision and qualifier; no invented day (spec §21.4).
  const rows = [];
  for (const k of ["announced", "released", "deprecated", "retired"]) {
    const c = cl.get(`dates.${k}`);
    if (c) rows.push(claimEl(ctx, "li", c, `<span class="mh-label">${DATE_LABEL[k]}</span> ${dateHtml(c.claim)}`));
    if (k === "released" && !c && d.announced) rows.push(`<li class="mh-dates-gap">Release date unknown</li>`);
  }
  (m.milestones || []).forEach((x, k) => {
    const c = cl.get(`milestones[${k}].date`);
    if (c) rows.push(claimEl(ctx, "li", c, `<span class="mh-label">${esc(x.label || "Milestone")}</span> ${dateHtml(c.claim)}`));
  });
  const dates = (rows.length ? ul(rows, ' class="mh-claims"') : `<p class="mh-none">Date unknown.</p>`) + (d.note ? `\n<p class="mh-note">${esc(d.note)}</p>` : "");

  // Lifecycle status and the lifecycle successor (not lineage, spec §12.1).
  const lc = cl.get("lifecycle"), rb = cl.get("replacedBy");
  const lifecycle = [lc ? claimEl(ctx, "p", lc, `<span class="mh-value">${esc(LIFECYCLE_LABEL[lc.claim.value] || LIFECYCLE_LABEL.unknown)}</span>`) : `<p>${LIFECYCLE_LABEL.unknown}</p>`,
    rb ? claimEl(ctx, "p", rb, `Replaced by ${modelLink(site, rb.claim.modelId, i.org)}`) : null].filter(Boolean).join("\n");

  // Evidence: the model status is the evidence for its existence and release date.
  const scope = i.td ? `for the ${i.td.kind === "released" ? "release" : "announcement"} date` : "no release or announcement date is recorded";
  const sum = i.ev.summary;
  // Undisclosed capabilities are counted apart, so the rows add up to every claim shown.
  const na = i.ev.claims.filter(c => c.evidence === "not-applicable").length;
  const sumRows = [...Object.keys(EVIDENCE_LABEL).map(e => [EVIDENCE_LABEL[e], sum[e] || 0, e]), na ? [NOT_APPLICABLE_LABEL, na, "not-applicable"] : null,
    [FLAG_LABEL["original-unavailable"], sum.originalUnavailable || 0, "original-unavailable"]].filter(Boolean);
  const evidence = `<p class="mh-ev-model"><span class="mh-ev" data-mh-evidence="${esc(i.ev.evidence)}">${esc(evText(i.ev.evidence))}</span> <span class="mh-muted">${esc(scope)}</span></p>` +
    (i.ev.flags.length ? `\n${ul(i.ev.flags.map(f => `<li data-mh-flag="${esc(f)}">${esc(FLAG_LABEL[f] || f)}</li>`), ' class="mh-flags"')}` : "") +
    `\n<p class="mh-muted">Claims in this record by evidence:</p>\n<dl class="mh-ev-summary">\n${sumRows.map(([t, n, k]) => `<dt data-mh-summary="${k}">${esc(t)}</dt><dd>${esc(plural(n, "claim", "claims"))}</dd>`).join("\n")}\n</dl>`;

  // Lineage: own relations are claims with sources; incoming ones are claims of the other
  // record (data-mh-incoming), shown with their sources too; the chains are derived.
  const relOut = x => {
    const c = cl.get(x.path);
    const kind = `${REL_LABEL[x.r.type] || x.r.type}${x.r.type === "derived-from" && x.r.method ? ` (${lower(x.r.method)})` : ""}`;
    const ed = x.r.basis === "editorial" ? ` <span class="mh-editorial">Editorial grouping</span>` : "";
    return c ? claimEl(ctx, "li", c, `<span class="mh-rel-type">${esc(kind)}</span> ${modelLink(site, x.target, i.org)}${ed}`) : "";
  };
  const relIn = x => {
    const src = site.modelById.get(x.from), c = src && src.claims.get(x.path);
    if (!c) return "";
    const kind = `${REL_INCOMING[x.r.type] || x.r.type}${x.r.type === "derived-from" && x.r.method ? ` (${lower(x.r.method)})` : ""}`;
    const ed = x.r.basis === "editorial" ? ` <span class="mh-editorial">Editorial grouping</span>` : "";
    const note = x.r.note ? ` <span class="mh-note">${esc(x.r.note)}</span>` : "";
    return `<li class="mh-incoming" data-mh-incoming="${esc(x.from + "#" + x.path)}" data-mh-evidence="${esc(c.evidence)}">${modelLink(site, x.from, i.org)} <span class="mh-rel-type">(${esc(kind)})</span>${ed} ${evHtml(c)} ${refs(ctx, x.r.sources)}${note}</li>`;
  };
  const inn = site.inRel.get(i.id) || [];
  const links = ids => site.sortIds(ids).map(id => `<li>${modelLink(site, id, i.org)}</li>`);
  const preds = i.outRel.filter(x => x.r.type === "successor-of").map(relOut);
  const groups = [
    ["predecessors", "Predecessors", preds, "No known predecessor."],
    ["successors", "Successors", inn.filter(x => x.r.type === "successor-of").map(relIn)],
    ["parents", "Parents", i.outRel.filter(x => x.r.type !== "successor-of").map(relOut)],
    ["children", "Children", inn.filter(x => x.r.type !== "successor-of").map(relIn)],
    ["siblings", "Siblings", [...links(i.g.siblings), ...inlineSiblings(site, i)]],
    ["ancestors", "All ancestors", links(i.g.ancestors)],
    ["descendants", "All descendants", links(i.g.descendants)]
  ];
  const lineage = groups.filter(g => g[2].length || g[3]).map(([k, t, items, none]) =>
    `<h3>${t}</h3>\n${items.length ? ul(items, ` class="mh-rel" data-mh-lineage="${k}"`) : `<p class="mh-none" data-mh-lineage="${k}">${none}</p>`}`).join("\n");

  // Variants: an anchor per inline variant, plus placeholders for promoted ones (spec §13).
  const seen = new Set();
  const variants = (m.variants || []).map((v, k) => {
    if (!v || !v.id || seen.has(v.id)) return null;
    seen.add(v.id);
    const vc = cl.get(`variants[${k}]`);
    const vd = ["announced", "released", "deprecated", "retired"].map(dk => [dk, cl.get(`variants[${k}].dates.${dk}`)]).filter(x => x[1])
      .map(([dk, c]) => claimEl(ctx, "li", c, `<span class="mh-label">${DATE_LABEL[dk]}</span> ${dateHtml(c.claim)}`));
    const va = [...new Set((v.aliases || []).map(a => a && a.text).filter(t => t && normalize(t) !== normalize(v.name)))];
    // Not claims in the §19.1 list: shown with their own sources and an explicit "not assessed".
    const unassessed = `<span class="mh-ev mh-ev-unassessed">${esc(UNASSESSED_LABEL)}</span>`;
    const vcap = v.capabilities && typeof v.capabilities === "object" ? v.capabilities : {};
    const caps = Object.keys(CAP_LABEL).filter(key => key !== "features" && vcap[key] && typeof vcap[key] === "object")
      .map(key => `<li data-mh-variant-claim="capabilities.${key}">${CAP_LABEL[key]}: <span class="mh-value">${esc(capValue(key, vcap[key]))}</span> ${unassessed} ${refs(ctx, vcap[key].sources)}</li>`);
    const vl = v.lifecycle && typeof v.lifecycle === "object" && v.lifecycle.value
      ? `\n<p data-mh-variant-claim="lifecycle">Status: <span class="mh-value">${esc(LIFECYCLE_LABEL[v.lifecycle.value] || v.lifecycle.value)}</span> ${unassessed} ${refs(ctx, v.lifecycle.sources)}</p>` : "";
    return `<section id="variant-${esc(v.id)}" class="mh-variant">
<h3>${esc(v.name || v.id)}</h3>
${vc ? claimEl(ctx, "p", vc, "Inline variant in this record.") : `<p>Inline variant in this record.${v.note ? ` <span class="mh-note">${esc(v.note)}</span>` : ""}</p>`}
${vd.length ? ul(vd, ' class="mh-claims"') : `<p class="mh-muted">Same dates as ${esc(m.name)}.</p>`}${vl}${va.length ? `\n<p>Also known as: ${esc(va.join(", "))}</p>` : ""}${caps.length ? `\n<p>Differs in:</p>\n${ul(caps, ' class="mh-variant-caps"')}` : ""}
</section>`;
  }).filter(Boolean);
  for (const p of site.promotedTo.get(i.id) || []) {
    if (seen.has(p.variantId)) continue;
    seen.add(p.variantId);
    variants.push(`<section id="variant-${esc(p.variantId)}" class="mh-variant mh-promoted">\n<h3>${esc(p.info.m.name)}</h3>\n<p>This variant now has its own page: <a href="${esc(p.info.url)}">${esc(p.info.m.name)}</a>.</p>\n</section>`);
  }

  // Summary, changes, capabilities
  const sc = cl.get("summary");
  const summary = sc ? claimEl(ctx, "p", sc, esc(sc.claim.text || "")) : `<p class="mh-none">No summary yet.</p>`;
  const predIds = i.outRel.filter(x => x.r.type === "successor-of").map(x => x.target);
  const changes = (m.changes || []).map((x, k) => {
    const c = cl.get(`changes[${k}]`);
    if (!c) return null;
    const rel = x.relativeTo || (predIds.length === 1 ? predIds[0] : null);   // the default is the single predecessor
    const kind = `${label(x.aspect || "other")}${x.direction ? " " + x.direction : ""}`;
    return claimEl(ctx, "li", c, `<span class="mh-change-kind">${esc(kind)}</span>${rel ? ` <span class="mh-change-rel">compared with ${modelLink(site, rel, i.org)}</span>` : ""}: ${esc(x.text || "")}`);
  }).filter(Boolean);
  const capRows = [];
  const caps = m.capabilities || {};
  for (const key of Object.keys(CAP_LABEL)) {
    if (key === "features") {
      const fs = (caps.features || []).map((f, k) => cl.get(`capabilities.features[${k}]`) && claimEl(ctx, "li", cl.get(`capabilities.features[${k}]`), esc(label(f.key)))).filter(Boolean);
      if (fs.length) capRows.push(`<dt>Features</dt><dd>${ul(fs, ' class="mh-claims"')}</dd>`);
      continue;
    }
    const c = cl.get(`capabilities.${key}`);
    if (c) capRows.push(`<dt>${CAP_LABEL[key]}</dt>${claimEl(ctx, "dd", c, `<span class="mh-value">${esc(capValue(key, c.claim))}</span>`)}`);
  }

  const sections = [
    section("identity", "Identity", identity),
    section("dates", "Dates", dates),
    section("lifecycle", "Lifecycle status", lifecycle),
    section("evidence", "Evidence", evidence),
    section("lineage", "Lineage", lineage),
    section("variants", "Variants", variants.length ? variants.join("\n") : `<p class="mh-none">No variants recorded in this record.</p>`),
    section("summary", "Summary", summary),
    section("changes", "Key changes", changes.length ? ul(changes, ' class="mh-claims mh-changes"') : `<p class="mh-none">No changes recorded.</p>`),
    section("capabilities", "Capabilities", capRows.length ? `<dl class="mh-caps">\n${capRows.join("\n")}\n</dl>` : `<p class="mh-none">No capabilities recorded.</p>`)
  ];
  // The source list comes after every citing section, so the numbering is final.
  sections.push(section("sources", "Sources", sourceList(site, ctx, i.refIds)));
  const news = i.news.map(n => newsItem(site, { ...n, variantName: n.variantId && ((m.variants || []).find(v => v && v.id === n.variantId) || {}).name }, null));
  sections.push(section("coverage", "Related AI Radar coverage", (news.length ? ul(news, ' class="mh-news"') : `<p class="mh-empty">${esc(EMPTY_COVERAGE)}</p>`) + dashboardLink(site, i.org)));

  // Previous/next in the family and in the organisation's timeline.
  const nav = [];
  const around = (list, labelPrev, labelNext) => {
    const k = list.indexOf(i);
    if (k > 0) nav.push(`<li>${esc(labelPrev)}: ${modelLink(site, list[k - 1].id, i.org)}</li>`);
    if (k >= 0 && k < list.length - 1) nav.push(`<li>${esc(labelNext)}: ${modelLink(site, list[k + 1].id, i.org)}</li>`);
  };
  if (fam) around(site.chrono(site.models.filter(x => x.m.familyId === fam.id)), `Previous in ${fam.name}`, `Next in ${fam.name}`);
  if (org) around(site.chrono(org.routed), `Earlier at ${org.o.name}`, `Later at ${org.o.name}`);
  const reviewed = m.lastReviewedAt && parseDate(m.lastReviewedAt) ? `\n<p class="mh-reviewed">Last reviewed ${dateHtml({ value: m.lastReviewedAt })}</p>` : "";

  const orgName = site.orgName(i.org);
  const stub = m.coverage === "stub" ? `\n<p class="mh-notice">This is a stub record: only minimal details have been researched so far, and the evidence is incomplete.</p>` : "";
  const main = `<main id="main"${coAttrs(site, i.org, "container mh")} data-mh-view="model" data-mh-model="${esc(m.id)}">
${crumbsHtml([{ name: "Model History", url: "/models/" }, { name: orgName, url: `/models/${i.org}/` }, { name: m.name, url: i.url }])}
<article class="mh-record">
<header class="mh-head">
${logoHtml(site, ctx, i.org)}<h1>${esc(m.name)}</h1>
<p class="mh-lead">${[orgLink(site, i.org), fam ? esc(fam.name) : null, timelineHtml(i.td), `<span class="mh-ev" data-mh-evidence="${esc(i.ev.evidence)}">${esc(evText(i.ev.evidence))}</span>`].filter(Boolean).join(" · ")}</p>${stub}
</header>
${sections.join("\n")}
${nav.length ? `<nav class="mh-pager" aria-label="More models">\n${ul(nav)}\n</nav>` : ""}${reviewed}
</article>
</main>`;
  const when = i.td ? `${i.td.kind === "released" ? "released" : "announced"} ${formatDate(i.td.dv)}` : "release date unknown";
  const desc = sc && sc.claim.text ? clip(sc.claim.text) : clip(`${m.name} is a model by ${orgName}${fam ? ` in the ${fam.name} family` : ""}, ${when}.`);
  return page({ path: i.url, title: `${m.name} · ${orgName} · Model History · AI Radar`, description: desc, indexable: m.coverage === "full", main,
    crumbs: [{ name: "Model History", url: "/models/" }, { name: orgName, url: `/models/${i.org}/` }, { name: m.name, url: i.url }] });
}

/* ---------- Redirect stub (previousSlugs / previousRoutes, spec §5.4) ---------- */
export function redirectPage(site, r) {
  const main = `<main id="main" class="container mh" data-mh-view="redirect">
<h1>This page has moved</h1>
<p><a href="${esc(r.to.url)}">${esc(r.to.m.name)}</a> now has a new address.</p>
</main>`;
  return page({ path: r.from, redirectTo: r.to.url, title: `${r.to.m.name} · Model History · AI Radar`, indexable: false, main,
    description: `This page moved to ${SITE}${r.to.url}`, crumbs: [] });
}
