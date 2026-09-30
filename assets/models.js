/* AI Radar Model History: Explorer enhancement of the pre-rendered list on /models/.
   Loads /models/index.json (same-origin, its only request), then filters the existing
   <li data-mh-model> items by toggling `hidden` and reordering, never rebuilding them.
   Privacy: the search term stays in memory; only facets and sort go into the URL
   (history.replaceState). No cookies, no storage. */
(function () {
"use strict";

/* ---------- Config ---------- */
const INDEX_URL = "/models/index.json";
const DEFAULT_SORT = "date-desc";   // newest first (spec O7 proposal); the page's selected <option> wins
const ANNOUNCE_MS = 600;            // quiet time before a typed search updates the live count
const DEBOUNCE_ABOVE = 1000;        // spec §23.2: above 1000 models the search waits 100 ms
const DEBOUNCE_MS = 100;
const own = (o, k) => k != null && Object.prototype.hasOwnProperty.call(o, k);   // "?sort=constructor" is not a sort
// A model page link, /models/<org>/<slug>/ (segment pattern of lib.mjs SEG).
const MODEL_HREF = /^\/models\/([a-z0-9]+(?:-[a-z0-9]+)*)\/[a-z0-9]+(?:-[a-z0-9]+)*\/?(?:[?#]|$)/;

/* ---------- Vocabularies ----------
   Copies of lib.mjs VOCAB, derive.mjs EVIDENCE and the templates.mjs labels; the explorer
   test keeps them identical. */
const CATEGORIES = ["language", "multimodal", "code", "reasoning", "image-generation", "video-generation", "audio-speech",
  "music", "embedding", "retrieval-reranking", "agentic", "robotics", "scientific", "game-playing",
  "safety-classifier", "other"];
const LIFECYCLE = ["announced", "preview", "available", "deprecated", "retired", "research-only", "unknown"];
const EVIDENCE = ["primary-source", "archived-primary-source", "secondary-sources", "insufficient-evidence"];
const FLAGS = ["original-unavailable", "some-claims-incomplete"];
const OPEN = ["yes", "no", "unknown"];

// Text labels (§16.4, §31), by the templates.mjs label() rule. In the Status fieldset
// "Unknown" replaces the page's "Status unknown".
const SPECIAL = { "audio-speech": "Audio and speech", "retrieval-reranking": "Retrieval and reranking" };
const labelsOf = list => {
  const o = {};
  list.forEach(v => { const s = SPECIAL[v] || v.replace(/-/g, " "); o[v] = s.charAt(0).toUpperCase() + s.slice(1); });
  return o;
};
const LABELS = {
  category: labelsOf(CATEGORIES), status: labelsOf(LIFECYCLE), open: labelsOf(OPEN), year: labelsOf(["unknown"]),
  evidence: { "primary-source": "Primary source available", "archived-primary-source": "Archived primary source",
    "secondary-sources": "Verified through secondary sources", "insufficient-evidence": "Historical evidence incomplete",
    "original-unavailable": "Original source unavailable", "some-claims-incomplete": "Some details lack sources" }
};
// Spec §23.3 order. The URL uses the same keys (§5.3).
const FACETS = [
  { key: "org", label: "Organization" }, { key: "family", label: "Family" }, { key: "category", label: "Category" },
  { key: "year", label: "Year" }, { key: "status", label: "Status" }, { key: "evidence", label: "Evidence" },
  { key: "open", label: "Open weights" }
];
const FACET_KEYS = FACETS.map(f => f.key);
const SORTS = { "date-desc": 1, "date-asc": 1, name: 1, org: 1 };
const SORT_KEYS = Object.keys(SORTS);
const URL_KEYS = FACET_KEYS.concat("sort");

/* ---------- Text & dates ----------
   Same logic as lib.mjs normalize/fold/compact and parseDate/sortKey (the test compares
   them). NFKC and NFD leave ASCII unchanged, so ASCII skips them for speed. */
const ASCII = /^[\x00-\x7f]*$/;
const SEPARATORS = /[\s\-_.·/]+/g;
function normalize(s) {
  s = String(s || "");
  if (!ASCII.test(s)) s = s.normalize("NFKC").replace(/[‐-―−]/g, "-");
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
const fold = s => { const n = normalize(s); return ASCII.test(n) ? n : n.normalize("NFD").replace(/[̀-ͯ]/g, ""); };
const compact = s => fold(s).replace(SEPARATORS, "");

const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
function parseDate(v) {
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
const PREC_RANK = { day: 0, month: 1, year: 2 };
const pad = (n, w) => String(n).padStart(w, "0");
// "YYYY-MM-DD-p" with 00 for an unknown month or day; unknown dates sort last.
function sortKey(v) {
  const p = typeof v === "string" ? parseDate(v) : v;
  if (!p) return "9999-99-99-9";
  return `${pad(p.y, 4)}-${pad(p.m || 0, 2)}-${pad(p.d || 0, 2)}-${PREC_RANK[p.precision]}`;
}

// Numeric collation, so "Orbit 10" sorts after "Orbit 2".
const collator = typeof Intl !== "undefined" && Intl.Collator ? new Intl.Collator("en", { numeric: true, sensitivity: "base" }) : null;
const cmpText = (a, b) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0);
const cmpRaw = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ---------- Records ----------
   Adds what index.json leaves out (§23.1), once per load. Organisation: hrefOrg (the page
   link, authoritative), else the first known one of the model's optional "org" (a unit's
   model), the family's "org", the family prefix, the id prefix. */
// Same-origin links only: a link to another site never decides where a model belongs.
function orgFromHref(href, origin) {
  let h = typeof href === "string" ? href : "";
  if (origin && h.indexOf(origin + "/") === 0) h = h.slice(origin.length);
  const m = MODEL_HREF.exec(h);
  return m ? m[1] : null;
}
const SORTERS = {
  "date-desc": (a, b) => (a.unk - b.unk) || cmpRaw(b.sk, a.sk) || cmpText(a.name, b.name),
  "date-asc": (a, b) => cmpRaw(a.sk, b.sk) || cmpText(a.name, b.name),
  name: (a, b) => cmpText(a.name, b.name) || cmpRaw(a.sk, b.sk),
  org: (a, b) => (a.orgUnk - b.orgUnk) || cmpText(a.orgName, b.orgName) || cmpRaw(a.sk, b.sk) || cmpText(a.name, b.name)
};
function buildRecords(index, hrefOrg) {
  index = index || {};
  hrefOrg = hrefOrg || {};
  const orgs = Object.create(null), fams = Object.create(null);
  (Array.isArray(index.organizations) ? index.organizations : []).forEach(o => { if (o && typeof o.id === "string") orgs[o.id] = o; });
  (Array.isArray(index.families) ? index.families : []).forEach(f => { if (f && typeof f.id === "string") fams[f.id] = f; });
  const str = v => (typeof v === "string" ? v : "");
  const strs = v => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
  const prefix = id => { const s = str(id), i = s.indexOf("."); return i > 0 ? s.slice(0, i) : null; };
  const known = o => (typeof o === "string" && own(orgs, o) ? o : null);
  const orgName = id => (id && own(orgs, id) && str(orgs[id].name)) || id || "";
  const keysOf = list => {
    const seen = Object.create(null), out = [];
    // c = compact(s): fold plus removing the separators.
    list.forEach(s => { const f = fold(s); if (f && !seen[f]) { seen[f] = 1; out.push({ f, c: f.replace(SEPARATORS, "") }); } });
    return out;
  };
  const records = [], ids = Object.create(null);
  (Array.isArray(index.models) ? index.models : []).forEach(m => {
    if (!m || typeof m.id !== "string" || !m.id || ids[m.id]) return;
    ids[m.id] = 1;
    const fam = typeof m.family === "string" && own(fams, m.family) ? m.family : null;
    const org = (own(hrefOrg, m.id) && str(hrefOrg[m.id])) || known(m.org) || known(fam && fams[fam].org) ||
      known(prefix(m.family)) || known(prefix(m.id));
    const dv = m.date && typeof m.date.v === "string" ? m.date.v : null;
    const p = parseDate(dv), year = p ? String(p.y) : "unknown";
    const name = str(m.name) || m.id, famName = fam ? str(fams[fam].name) || fam : "";
    const cats = strs(m.cats).filter((c, i, a) => CATEGORIES.indexOf(c) >= 0 && a.indexOf(c) === i);
    const life = LIFECYCLE.indexOf(m.life) >= 0 ? m.life : "unknown";
    // A missing or unknown status reads "Historical evidence incomplete" on the page.
    const ev = EVIDENCE.indexOf(m.ev) >= 0 ? m.ev : "insufficient-evidence";
    const flags = FLAGS.filter(f => strs(m.flags).indexOf(f) >= 0);
    const names = keysOf([name, str(m.slug)].concat(strs(m.alias)));
    const others = keysOf([famName && str(fams[fam].name), org ? orgName(org) : ""]
      .concat(org && own(orgs, org) ? strs(orgs[org].names) : []));
    records.push({
      i: records.length, id: m.id, name, slug: str(m.slug),
      org, orgName: orgName(org), orgUnk: org ? 0 : 1, family: fam, familyName: famName,
      date: dv, sk: sortKey(dv), unk: p ? 0 : 1, year, life, ev, cats,
      fv: {
        org: org ? [org] : [], family: fam ? [fam] : [], category: cats, year: [year], status: [life],
        evidence: [ev].concat(flags), open: [m.open === true ? "yes" : m.open === false ? "no" : "unknown"]
      },
      names, keys: names.concat(others.filter(k => !names.some(n => n.f === k.f))), pos: {}
    });
  });
  // One sorted copy per mode; pos lets an update sort matches with integer compares only.
  const sorted = {};
  SORT_KEYS.forEach(mode => {
    sorted[mode] = records.slice().sort((a, b) => SORTERS[mode](a, b) || cmpRaw(a.id, b.id));
    sorted[mode].forEach((r, n) => { r.pos[mode] = n; });
  });
  // Facet values in display order. occurs = at least one model has the value.
  const seen = {};
  FACET_KEYS.forEach(f => { seen[f] = Object.create(null); });
  records.forEach(r => FACET_KEYS.forEach(f => r.fv[f].forEach(v => { seen[f][v] = (seen[f][v] || 0) + 1; })));
  const famOrgs = Object.create(null);
  records.forEach(r => {
    if (!r.family || !r.org) return;
    const l = famOrgs[r.family] || (famOrgs[r.family] = []);
    if (l.indexOf(r.org) < 0) l.push(r.org);
  });
  const vocab = (f, list) => list.map(v => ({ value: v, label: (LABELS[f] && LABELS[f][v]) || v, occurs: !!seen[f][v] }));
  const famNames = Object.create(null);
  Object.keys(seen.family).forEach(id => { const n = str(fams[id].name) || id; famNames[n] = (famNames[n] || 0) + 1; });
  const values = {
    org: Object.keys(seen.org).map(id => ({ value: id, label: orgName(id), occurs: true }))
      .sort((a, b) => cmpText(a.label, b.label) || cmpRaw(a.value, b.value)),
    // Two families with the same name get their organisation in the label.
    family: Object.keys(seen.family).map(id => {
      const n = str(fams[id].name) || id, o = (famOrgs[id] || []).slice().sort();
      return { value: id, label: famNames[n] > 1 && o.length ? `${n} (${o.map(orgName).join(", ")})` : n, occurs: true, orgs: o };
    }).sort((a, b) => cmpText(a.label, b.label) || cmpRaw(a.value, b.value)),
    category: vocab("category", CATEGORIES),
    year: Object.keys(seen.year).filter(y => y !== "unknown").sort((a, b) => b - a)
      .map(y => ({ value: y, label: y, occurs: true })).concat(vocab("year", ["unknown"])),
    status: vocab("status", LIFECYCLE),
    evidence: vocab("evidence", EVIDENCE.concat(FLAGS)),
    open: vocab("open", OPEN)
  };
  const domains = {};
  FACET_KEYS.forEach(f => { domains[f] = values[f].map(v => v.value); });
  return { records, sorted, values, domains };
}

/* ---------- Search ----------
   §23.2: normalised text plus a variant without separators ("gpt4" finds "GPT-4"). Rank:
   0 exact name or alias, 1 a field starts with the query, 2 a field contains it, -1 none;
   within a rank the chosen sort. A query of separators only names nothing: empty. */
function prepQuery(s) {
  const f = fold(s), c = f.replace(SEPARATORS, "");
  return c ? { f, c } : null;
}
function matchQuery(r, q) {
  if (typeof q === "string") q = prepQuery(q);
  if (!q) return 0;
  const f = q.f, c = q.c;
  if (r.names.some(k => k.f === f || k.c === c)) return 0;
  if (r.keys.some(k => k.f.startsWith(f) || k.c.startsWith(c))) return 1;
  if (r.keys.some(k => k.f.includes(f) || k.c.includes(c))) return 2;
  return -1;
}
function rankAll(records, query) {
  const q = prepQuery(query);
  return q ? records.map(r => matchQuery(r, q)) : records.map(() => 0);
}
const isActive = st => !!prepQuery(st.query) || FACET_KEYS.some(f => (st.sel[f] || []).length > 0);

/* ---------- Filters & counts ----------
   OR within a facet, AND across facets (§23.3). The search is one more AND, for the counts
   too: counts that ignore it would not add up to the list shown. */
const passes = (r, f, sel) => !sel || !sel.length || r.fv[f].some(v => sel.indexOf(v) >= 0);
// Matching records in display order: search rank first, then the chosen sort.
function applyFilters(records, st, ranks) {
  ranks = ranks || rankAll(records, st.query);
  const mode = own(SORTS, st.sort) ? st.sort : DEFAULT_SORT;
  const act = FACET_KEYS.filter(f => (st.sel[f] || []).length);
  return records.filter(r => ranks[r.i] >= 0 && act.every(f => passes(r, f, st.sel[f])))
    .sort((a, b) => ranks[a.i] - ranks[b.i] || a.pos[mode] - b.pos[mode]);
}
/* Count per value = models matching the search and every OTHER active facet. One pass: a
   model failing no facet counts everywhere, one failing a single facet counts only there. */
function facetCounts(records, st, ranks) {
  ranks = ranks || rankAll(records, st.query);
  const counts = {};
  FACET_KEYS.forEach(f => { counts[f] = Object.create(null); });
  const act = FACET_KEYS.filter(f => (st.sel[f] || []).length);
  records.forEach(r => {
    if (ranks[r.i] < 0) return;
    let miss = null, n = 0;
    for (let j = 0; j < act.length && n < 2; j++) if (!passes(r, act[j], st.sel[act[j]])) { miss = act[j]; n++; }
    if (n > 1) return;
    FACET_KEYS.forEach(f => {
      if (n && f !== miss) return;
      const c = counts[f];
      r.fv[f].forEach(v => { c[v] = (c[v] || 0) + 1; });
    });
  });
  return counts;
}
const countText = (n, total, active) => {
  const unit = total === 1 ? "model" : "models";
  return active ? `${n} of ${total} ${unit}` : `${total} ${unit}`;
};

/* ---------- URL state ----------
   Facets and sort only (§5.3), never the search term. Unknown keys and values outside the
   loaded index are ignored. Several values: ?org=a&org=b (a comma list is read too). Other
   parameters are kept byte for byte. */
const urlHasState = search => { const q = new URLSearchParams(search || ""); return URL_KEYS.some(k => q.has(k)); };
function parseUrlState(search, domains, defaultSort) {
  const q = new URLSearchParams(search || "");
  const st = { query: "", sort: own(SORTS, defaultSort) ? defaultSort : DEFAULT_SORT, sel: {} };
  FACET_KEYS.forEach(f => {
    const ok = (domains && Array.isArray(domains[f]) && domains[f]) || [], vals = [];
    q.getAll(f).forEach(raw => raw.split(",").forEach(v => { v = v.trim(); if (ok.indexOf(v) >= 0 && vals.indexOf(v) < 0) vals.push(v); }));
    st.sel[f] = vals.sort();
  });
  const s = q.get("sort");
  if (own(SORTS, s)) st.sort = s;
  return st;
}
function serializeUrlState(st, search, defaultSort) {
  // A segment's key is decoded as URLSearchParams does, so "%6Frg=x" is an org here too.
  const keep = String(search || "").replace(/^\?/, "").split("&").filter(seg => {
    if (!seg) return false;
    const p = new URLSearchParams(seg);
    return !URL_KEYS.some(k => p.has(k));
  });
  const q = new URLSearchParams();
  FACET_KEYS.forEach(f => (st.sel[f] || []).slice().sort().forEach(v => q.append(f, v)));
  if (own(SORTS, st.sort) && st.sort !== (own(SORTS, defaultSort) ? defaultSort : DEFAULT_SORT)) q.set("sort", st.sort);
  const s = keep.concat(q.toString() || []).join("&");
  return s ? "?" + s : "";
}

/* ---------- DOM ---------- */
const el = {};
const items = new Map();   // model id -> pre-rendered <li>
let ctx = null, state = null, defaultSort = DEFAULT_SORT, hrefOrg = {}, facetUi = {}, liveAttr = null;
let domPos = new Map(), loading = false, retryLabel = "", countTimer = 0, searchTimer = 0, quiet = 0;

const mk = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
const setHidden = (n, h) => { if (n.hidden !== h) n.hidden = h; };

/* One fieldset of plain checkboxes per facet (mh- classes, textContent only), built once per
   load. Updates change counts, checked states and `hidden` in place. The " models" suffix
   is for screen readers (mh-visually-hidden). */
function renderFacets() {
  while (el.facets.firstChild) el.facets.removeChild(el.facets.firstChild);
  facetUi = {};
  FACETS.forEach(f => {
    const fs = mk("fieldset", "mh-facet"), ul = mk("ul", "mh-facet-list"), ui = { fs, items: Object.create(null) };
    fs.setAttribute("data-mh-facet", f.key);
    fs.appendChild(mk("legend", "mh-facet-legend", f.label));
    ctx.values[f.key].forEach(v => {
      const li = mk("li", "mh-facet-item"), label = mk("label", "mh-facet-label"), input = mk("input", "mh-facet-input");
      const count = mk("span", "mh-facet-count"), num = mk("span", "mh-facet-num", "0"), unit = mk("span", "mh-visually-hidden", " models");
      input.type = "checkbox";
      input.value = v.value;
      input.setAttribute("data-mh-facet", f.key);
      li.setAttribute("data-mh-value", v.value);
      count.appendChild(num);
      count.appendChild(unit);
      label.appendChild(input);
      label.appendChild(mk("span", "mh-facet-name", v.label));
      label.appendChild(document.createTextNode(" "));
      label.appendChild(count);
      li.appendChild(label);
      ul.appendChild(li);
      ui.items[v.value] = { li, input, num, unit };
    });
    fs.appendChild(ul);
    el.facets.appendChild(fs);
    facetUi[f.key] = ui;
  });
}
/* Values nobody has stay hidden unless selected; families follow the organisation filter
   (§23.3). A checked value stays visible to be unchecked. The focused one stays until the
   next update: hiding it would drop focus to <body> (§31). */
function syncFacets(counts) {
  const orgSel = state.sel.org, focused = document.activeElement;
  FACET_KEYS.forEach(f => {
    const ui = facetUi[f];
    let any = false;
    ctx.values[f].forEach(v => {
      const it = ui.items[v.value], checked = state.sel[f].indexOf(v.value) >= 0, n = counts[f][v.value] || 0;
      const hide = !checked && it.input !== focused &&
        (!v.occurs || (f === "family" && orgSel.length > 0 && !v.orgs.some(o => orgSel.indexOf(o) >= 0)));
      if (it.input.checked !== checked) it.input.checked = checked;
      setText(it.num, String(n));
      setText(it.unit, n === 1 ? " model" : " models");
      if (it.li.getAttribute("data-mh-count") !== String(n)) it.li.setAttribute("data-mh-count", String(n));
      setHidden(it.li, hide);
      if (!hide) any = true;
    });
    setHidden(ui.fs, !any);
  });
}

/* The count is a polite live region (§31): typing waits for a pause. §6 announces every
   change, so `repeat` toggles a trailing no-break space when the text stays the same.
   quiet: ready() wrote the first count silently. The region goes live first and the text
   changes a task later; together, it would not be announced. */
const goLive = () => { clearTimeout(quiet); quiet = 0; el.count.setAttribute("aria-live", liveAttr); };
function setCount(text, now, repeat) {
  clearTimeout(countTimer);
  if (quiet) { goLive(); now = false; }
  const write = () => setText(el.count, repeat && el.count.textContent === text ? text + "\xa0" : text);
  if (now) write(); else countTimer = setTimeout(write, ANNOUNCE_MS);
}
const shownIn = (n, root) => { for (let x = n; x && x !== root; x = x.parentNode) if (x.hidden) return false; return true; };

/* Reorder only when the matches are out of relative order. 1000 items in Chrome: moving each
   child ~30-40 ms, emptying the detached list and appending the same nodes ~3 ms. Detaching
   blurs a focused link in the list; update() gives focus back. */
function inOrder(shown) {
  let prev = -1;
  for (let j = 0; j < shown.length; j++) { const p = domPos.get(shown[j].id); if (p < prev) return false; prev = p; }
  return true;
}
function reorder(shown, on) {
  // Matches (rank, then sort), the hidden rest in sort order, items the index does not
  // know, then anything else the list held.
  const order = shown.concat(ctx.sorted[state.sort].filter(r => !on[r.i])).map(r => items.get(r.id)).concat(ctx.orphans);
  const mine = new Set(order), rest = [];
  for (let n = el.list.firstChild; n; n = n.nextSibling) if (!mine.has(n) && (n.nodeType === 1 || /\S/.test(n.textContent))) rest.push(n);
  el.list.textContent = "";
  order.concat(rest).forEach(n => el.list.appendChild(n));
  domPos = new Map(order.map((li, n) => [li.getAttribute("data-mh-model"), n]));
}

// now: write the count at once (no typing pause). repeat: a user action, announced even
// when the count did not change.
function update(now, repeat) {
  const recs = ctx.records, ranks = rankAll(recs, state.query);
  const shown = applyFilters(recs, state, ranks), counts = facetCounts(recs, state, ranks);
  const on = new Uint8Array(recs.length), active = isActive(state);
  const focused = el.list.contains(document.activeElement) ? document.activeElement : null;
  shown.forEach(r => { on[r.i] = 1; });
  if (!inOrder(shown)) {
    const parent = el.list.parentNode, next = el.list.nextSibling;
    parent.removeChild(el.list);
    try { reorder(shown, on); } finally { parent.insertBefore(el.list, next); }   // the list always comes back
  }
  recs.forEach(r => setHidden(items.get(r.id), !on[r.i]));
  // List items the index does not know stay visible only while nothing filters.
  ctx.orphans.forEach(li => setHidden(li, active));
  if (focused && document.activeElement !== focused && shownIn(focused, el.list)) focused.focus({ preventScroll: true });
  syncFacets(counts);
  const n = shown.length + (active ? 0 : ctx.orphans.length);
  setHidden(el.empty, n > 0);
  setCount(countText(n, items.size, active), now, repeat);
}

function syncUrl() {
  const s = serializeUrlState(state, location.search, defaultSort);
  if (s !== location.search) history.replaceState(history.state, "", location.pathname + s + location.hash);
}

function ready(index) {
  const models = index.models.filter(m => m && items.has(m.id));
  ctx = buildRecords({ organizations: index.organizations, families: index.families, models }, hrefOrg);
  const known = new Set(ctx.records.map(r => r.id));
  ctx.orphans = [];
  items.forEach((li, id) => { if (!known.has(id)) ctx.orphans.push(li); });
  state = parseUrlState(location.search, ctx.domains, defaultSort);
  state.query = el.search.value;   // a value the browser restored on Back applies too
  renderFacets();
  el.sort.value = state.sort;
  const hadFocus = el.error.contains(document.activeElement);
  el.error.hidden = true;
  el.controls.hidden = false;
  if (hadFocus) el.search.focus();   // Retry disappears; keep focus on the next useful control
  // The first count is not news: announced, it would come unprompted after the page load.
  if (liveAttr) el.count.removeAttribute("aria-live");
  update(true);
  if (liveAttr) quiet = setTimeout(goLive, ANNOUNCE_MS);
}

// #mh-error is a status region (start()). A failed Retry leaves its message unchanged, so
// a note changes instead and is announced.
function noteFailure() {
  if (!el.note) el.note = el.error.appendChild(mk("span", "mh-error-note"));
  const t = " Still unavailable.";
  setText(el.note, el.note.textContent === t ? t + "\xa0" : t);
}

// One load at a time. On failure the pre-rendered list stays as it is, with Retry.
async function load() {
  if (loading || ctx) return;
  loading = true;
  const retrying = !el.error.hidden;
  if (retrying) el.retry.textContent = "Retrying…";
  try {
    const res = await fetch(INDEX_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const index = await res.json();
    if (!index || !Array.isArray(index.models)) throw new Error("index.json has no models");
    ready(index);
  } catch (e) {
    // Back to the plain list, also if the failure came halfway through ready().
    ctx = null;
    items.forEach(li => setHidden(li, false));
    el.controls.hidden = true;
    el.empty.hidden = true;
    el.error.hidden = false;
    if (liveAttr) goLive();
    if (retrying) noteFailure();
  } finally {
    loading = false;
    el.retry.textContent = retryLabel;
  }
}

function bindEvents() {
  el.search.addEventListener("input", () => {
    if (!ctx) return;
    state.query = el.search.value;
    clearTimeout(searchTimer);
    if (ctx.records.length > DEBOUNCE_ABOVE) searchTimer = setTimeout(() => update(false), DEBOUNCE_MS);
    else update(false);
  });
  el.sort.addEventListener("change", () => {
    if (!ctx || !own(SORTS, el.sort.value)) return;
    state.sort = el.sort.value;
    syncUrl();
    update(true, true);
  });
  // Delegated: the checkboxes are created after the index loads.
  el.facets.addEventListener("change", e => {
    const t = e.target, f = t && t.getAttribute ? t.getAttribute("data-mh-facet") : null;
    if (!ctx || FACET_KEYS.indexOf(f) < 0 || ctx.domains[f].indexOf(t.value) < 0) return;
    const sel = state.sel[f].filter(v => v !== t.value);
    if (t.checked) sel.push(t.value);
    state.sel[f] = sel.sort();
    syncUrl();
    update(true, true);
  });
  // Clears search and facets; the sort is a view choice, not a filter, so it stays.
  el.clear.addEventListener("click", () => {
    if (!ctx) return;
    el.search.value = "";
    state.query = "";
    FACET_KEYS.forEach(f => { state.sel[f] = []; });
    clearTimeout(searchTimer);
    syncUrl();
    update(true, true);
  });
  el.retry.addEventListener("click", () => load());
}

/* ---------- Init ---------- */
function start() {
  const main = document.getElementsByTagName("main")[0];
  if (!main || main.getAttribute("data-mh-view") !== "explorer") return;
  const ids = ["controls", "search", "sort", "facets", "clear", "count", "empty", "error", "retry", "list"];
  ids.forEach(k => { el[k] = document.getElementById("mh-" + k); });
  if (ids.some(k => !el[k])) return;   // not the expected markup: leave the static list alone
  const kids = el.list.children;
  for (let i = 0; i < kids.length; i++) {
    const li = kids[i], id = li.getAttribute("data-mh-model");
    if (!id || items.has(id)) continue;
    domPos.set(id, items.size);
    items.set(id, li);
    const links = li.getElementsByTagName("a");
    for (let j = 0; j < links.length; j++) {
      const o = orgFromHref(links[j].getAttribute("href"), location.origin);
      if (o) { hrefOrg[id] = o; break; }
    }
  }
  const opts = el.sort.getElementsByTagName("option");
  for (let i = 0; i < opts.length; i++) if (opts[i].hasAttribute("selected") && own(SORTS, opts[i].value)) defaultSort = opts[i].value;
  retryLabel = el.retry.textContent;
  liveAttr = el.count.getAttribute("aria-live");
  // A status region (WCAG 4.1.3), set long before any failure so its changes are announced.
  if (!el.error.hasAttribute("role")) el.error.setAttribute("role", "status");
  bindEvents();
  // The controls stay hidden until the index is there (page contract), so it loads unasked:
  // at once with URL state, else after `load`. §32 wants load-on-interaction (open decision).
  if (urlHasState(location.search) || document.readyState === "complete") load();
  else window.addEventListener("load", () => load(), { once: true });
}

const api = { normalize, fold, compact, parseDate, sortKey, orgFromHref, prepQuery, buildRecords, matchQuery, rankAll, isActive,
  applyFilters, facetCounts, countText, urlHasState, parseUrlState, serializeUrlState,
  CATEGORIES, LIFECYCLE, EVIDENCE, FLAGS, FACET_KEYS, SORT_KEYS, DEFAULT_SORT, LABELS };
// Tests set __MH_TEST__ = true in node:vm. Strict, so an element named __MH_TEST__ cannot.
if (typeof globalThis !== "undefined" && globalThis.__MH_TEST__ === true) globalThis.__MH__ = api;
else if (typeof document !== "undefined") start();
})();
